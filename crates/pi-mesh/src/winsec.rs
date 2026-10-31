//! Windows security helpers, shared with `pi-natives`' IPC pipes.
//!
//! The user of a process token, and security descriptors granting only the
//! current user: the registry directory (owner and protected inherited DACL)
//! and the local transport's named pipe.

use std::{
	io, iter,
	os::windows::{
		ffi::OsStrExt,
		io::{AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle},
	},
	path::Path,
	ptr, slice,
};

use windows_sys::{
	Win32::{
		Foundation::{ERROR_SUCCESS, HANDLE, LocalFree},
		Security::{
			ACL,
			Authorization::{
				ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
				SDDL_REVISION_1, SE_FILE_OBJECT, SetNamedSecurityInfoW,
			},
			DACL_SECURITY_INFORMATION, GetSecurityDescriptorDacl, GetSecurityDescriptorOwner,
			GetTokenInformation, OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
			PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser,
		},
		System::Threading::{GetCurrentProcess, OpenProcessToken},
	},
	core::PWSTR,
};

/// The `TOKEN_USER` of a process token, in pointer-aligned storage.
pub struct ProcessUser(Vec<u64>);

impl ProcessUser {
	/// The user's SID; points into `self`.
	pub const fn sid(&self) -> PSID {
		// SAFETY: the buffer was filled by `GetTokenInformation(TokenUser)`, is
		// 8-byte aligned, and outlives the returned pointer's uses.
		unsafe { (*self.0.as_ptr().cast::<TOKEN_USER>()).User.Sid }
	}

	/// The user's SID in string form (`S-1-5-21-…`).
	pub fn sid_string(&self) -> io::Result<String> {
		let mut text: PWSTR = ptr::null_mut();
		// SAFETY: `self.sid()` is valid while `self` lives; `text` is a valid out
		// pointer.
		if unsafe { ConvertSidToStringSidW(self.sid(), &raw mut text) } == 0 {
			return Err(io::Error::last_os_error());
		}
		// SAFETY: `text` is a NUL-terminated wide string from LocalAlloc, freed
		// once here.
		let sid = unsafe {
			let mut n = 0;
			while *text.add(n) != 0 {
				n += 1;
			}
			let sid = String::from_utf16_lossy(slice::from_raw_parts(text, n));
			LocalFree(text.cast());
			sid
		};
		Ok(sid)
	}
}

/// The user of the token of `process` (a real or pseudo process handle).
pub fn process_user(process: BorrowedHandle<'_>) -> io::Result<ProcessUser> {
	let mut raw_token: HANDLE = ptr::null_mut();
	// SAFETY: `process` is a live process handle for this borrow and
	// `raw_token` a valid out pointer.
	if unsafe { OpenProcessToken(process.as_raw_handle(), TOKEN_QUERY, &raw mut raw_token) } == 0 {
		return Err(io::Error::last_os_error());
	}
	// SAFETY: `OpenProcessToken` returned a fresh handle we now own.
	let token = unsafe { OwnedHandle::from_raw_handle(raw_token) };
	let mut len = 0u32;
	// SAFETY: a null buffer with zero length only queries the size.
	unsafe {
		GetTokenInformation(token.as_raw_handle(), TokenUser, ptr::null_mut(), 0, &raw mut len);
	}
	if len == 0 {
		return Err(io::Error::last_os_error());
	}
	let mut buf = vec![0u64; (len as usize).div_ceil(size_of::<u64>())];
	// SAFETY: `buf` provides at least `len` writable, aligned bytes.
	let ok = unsafe {
		GetTokenInformation(
			token.as_raw_handle(),
			TokenUser,
			buf.as_mut_ptr().cast(),
			len,
			&raw mut len,
		)
	};
	if ok == 0 {
		return Err(io::Error::last_os_error());
	}
	Ok(ProcessUser(buf))
}

/// The user this process runs as.
pub fn current_user() -> io::Result<ProcessUser> {
	// SAFETY: `GetCurrentProcess` returns a pseudo handle that is always valid
	// and needs no close.
	process_user(unsafe { BorrowedHandle::borrow_raw(GetCurrentProcess()) })
}

/// A self-relative security descriptor parsed from SDDL (`LocalAlloc`'d).
pub struct Descriptor(PSECURITY_DESCRIPTOR);

// SAFETY: the descriptor is immutable LocalAlloc memory owned by this value;
// Win32 only reads it.
unsafe impl Send for Descriptor {}
// SAFETY: see `Send`; shared access is read-only.
unsafe impl Sync for Descriptor {}

impl Descriptor {
	/// Parse `sddl` (e.g. `D:P(A;;GA;;;S-1-5-21-…)`).
	pub fn from_sddl(sddl: &str) -> io::Result<Self> {
		let wide: Vec<u16> = sddl.encode_utf16().chain(iter::once(0)).collect();
		let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
		// SAFETY: `wide` is NUL-terminated; `descriptor` is a valid out pointer.
		let ok = unsafe {
			ConvertStringSecurityDescriptorToSecurityDescriptorW(
				wide.as_ptr(),
				SDDL_REVISION_1,
				&raw mut descriptor,
				ptr::null_mut(),
			)
		};
		if ok == 0 {
			return Err(io::Error::last_os_error());
		}
		Ok(Self(descriptor))
	}

	/// Owner: the current user. DACL: protected, full control for the current
	/// user only; `inherit` adds object/container inheritance.
	fn current_user_only(inherit: bool) -> io::Result<Self> {
		let sid = current_user()?.sid_string()?;
		let flags = if inherit { "OICI" } else { "" };
		Self::from_sddl(&format!("O:{sid}D:P(A;{flags};FA;;;{sid})"))
	}

	/// `SECURITY_ATTRIBUTES` pointing at this descriptor; valid while `self`
	/// lives.
	pub const fn attributes(&self) -> SECURITY_ATTRIBUTES {
		SECURITY_ATTRIBUTES {
			nLength:              size_of::<SECURITY_ATTRIBUTES>() as u32,
			lpSecurityDescriptor: self.0,
			bInheritHandle:       0,
		}
	}
}

impl Drop for Descriptor {
	fn drop(&mut self) {
		// SAFETY: allocated by the SDDL conversion; freed exactly once.
		unsafe { LocalFree(self.0) };
	}
}

/// Descriptor for the local transport's pipe: current user only.
pub(crate) fn pipe_descriptor() -> io::Result<Descriptor> {
	Descriptor::current_user_only(false)
}

/// Make the current user `dir`'s owner and replace its DACL with a protected
/// one granting only the current user full control, inherited by files and
/// subdirectories. Fails when we may not (another owner who did not grant us
/// `WRITE_OWNER`/`WRITE_DAC`), which callers treat as an insecure directory.
pub(crate) fn restrict_dir_to_current_user(dir: &Path) -> io::Result<()> {
	let descriptor = Descriptor::current_user_only(true)?;
	let (mut present, mut defaulted) = (0, 0);
	let mut dacl: *mut ACL = ptr::null_mut();
	// SAFETY: `descriptor` is a valid self-relative descriptor; outputs are
	// valid pointers; `dacl` points into `descriptor`.
	if unsafe {
		GetSecurityDescriptorDacl(descriptor.0, &raw mut present, &raw mut dacl, &raw mut defaulted)
	} == 0
	{
		return Err(io::Error::last_os_error());
	}
	let mut owner: PSID = ptr::null_mut();
	// SAFETY: as above; `owner` points into `descriptor`.
	if unsafe { GetSecurityDescriptorOwner(descriptor.0, &raw mut owner, &raw mut defaulted) } == 0 {
		return Err(io::Error::last_os_error());
	}
	let path: Vec<u16> = dir.as_os_str().encode_wide().chain(iter::once(0)).collect();
	// SAFETY: `path` is NUL-terminated; `owner` and `dacl` are valid while
	// `descriptor` lives; group and SACL are not changed.
	let status = unsafe {
		SetNamedSecurityInfoW(
			path.as_ptr(),
			SE_FILE_OBJECT,
			OWNER_SECURITY_INFORMATION
				| DACL_SECURITY_INFORMATION
				| PROTECTED_DACL_SECURITY_INFORMATION,
			owner,
			ptr::null_mut(),
			dacl,
			ptr::null(),
		)
	};
	if status == ERROR_SUCCESS {
		Ok(())
	} else {
		Err(io::Error::from_raw_os_error(status as i32))
	}
}
