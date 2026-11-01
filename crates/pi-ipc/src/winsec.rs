//! Windows security helpers for named pipes and owner-only directories.
//!
//! The user of a process token, and security descriptors granting only the
//! current user: for this crate's IPC pipes and owner-only directories (owner
//! and protected inherited DACL).

use std::{
	fs, io, iter,
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
			ACCESS_ALLOWED_ACE, ACL,
			Authorization::{
				ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
				GetNamedSecurityInfoW, SDDL_REVISION_1, SE_FILE_OBJECT, SetNamedSecurityInfoW,
			},
			DACL_SECURITY_INFORMATION, EqualSid, GetAce, GetSecurityDescriptorControl,
			GetSecurityDescriptorDacl, GetSecurityDescriptorOwner, GetTokenInformation,
			OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
			PSID, SE_DACL_PROTECTED, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser,
		},
		System::Threading::{GetCurrentProcess, OpenProcessToken},
	},
	core::PWSTR,
};

/// `ACCESS_ALLOWED_ACE_TYPE` (in `System_SystemServices`, a feature this crate
/// does not otherwise need).
const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;

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
	/// user only, inherited by files and subdirectories.
	fn current_user_only() -> io::Result<Self> {
		let sid = current_user()?.sid_string()?;
		Self::from_sddl(&format!("O:{sid}D:P(A;OICI;FA;;;{sid})"))
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

/// Make the current user `dir`'s owner, with a protected owner-only DACL.
///
/// The DACL grants only the current user full control, inherited by files and
/// subdirectories. `dir` must be a real directory: a non-directory or a
/// name-surrogate reparse point (symlink, junction) is refused with
/// `InvalidInput` before anything changes; other reparse points such as
/// cloud-file placeholders are accepted. Also fails when we may not (another
/// owner who did not grant us `WRITE_OWNER`/`WRITE_DAC`); callers treat any
/// failure as an insecure directory.
pub fn restrict_dir_to_current_user(dir: &Path) -> io::Result<()> {
	// std reports exactly the name-surrogate reparse tags as symlinks
	// (`IsReparseTagNameSurrogate`), junctions included.
	let file_type = fs::symlink_metadata(dir)?.file_type();
	if file_type.is_symlink() || !file_type.is_dir() {
		return Err(io::Error::new(
			io::ErrorKind::InvalidInput,
			format!("{} is not a real directory", dir.display()),
		));
	}
	let descriptor = Descriptor::current_user_only()?;
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

/// Whether `dir` already looks the way [`restrict_dir_to_current_user`]
/// leaves it.
///
/// That is: owned by the current user, with a protected DACL holding one
/// allow ACE for the current user. Check-only (for listers that must not
/// rewrite security on every call); a link or non-directory is refused with
/// `InvalidInput`.
pub fn verify_dir_restricted(dir: &Path) -> io::Result<bool> {
	let file_type = fs::symlink_metadata(dir)?.file_type();
	if file_type.is_symlink() || !file_type.is_dir() {
		return Err(io::Error::new(
			io::ErrorKind::InvalidInput,
			format!("{} is not a real directory", dir.display()),
		));
	}
	let path: Vec<u16> = dir.as_os_str().encode_wide().chain(iter::once(0)).collect();
	let mut owner: PSID = ptr::null_mut();
	let mut dacl: *mut ACL = ptr::null_mut();
	let mut raw: PSECURITY_DESCRIPTOR = ptr::null_mut();
	// SAFETY: `path` is NUL-terminated; outputs are valid pointers; `owner`
	// and `dacl` point into `raw`, which `Descriptor` frees on drop.
	let status = unsafe {
		GetNamedSecurityInfoW(
			path.as_ptr(),
			SE_FILE_OBJECT,
			OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
			&raw mut owner,
			ptr::null_mut(),
			&raw mut dacl,
			ptr::null_mut(),
			&raw mut raw,
		)
	};
	if status != ERROR_SUCCESS {
		return Err(io::Error::from_raw_os_error(status as i32));
	}
	let descriptor = Descriptor(raw);
	let me = current_user()?;
	// SAFETY: both SIDs are live (`descriptor`, `me`).
	if owner.is_null() || unsafe { EqualSid(owner, me.sid()) } == 0 {
		return Ok(false);
	}
	let (mut control, mut revision) = (0u16, 0u32);
	// SAFETY: `descriptor.0` is a valid descriptor; outputs are valid.
	if unsafe { GetSecurityDescriptorControl(descriptor.0, &raw mut control, &raw mut revision) }
		== 0
	{
		return Err(io::Error::last_os_error());
	}
	// SAFETY: a non-null `dacl` points into `descriptor`.
	if control & SE_DACL_PROTECTED == 0 || dacl.is_null() || unsafe { (*dacl).AceCount } != 1 {
		return Ok(false);
	}
	let mut ace: *mut std::ffi::c_void = ptr::null_mut();
	// SAFETY: index 0 exists; `ace` is a valid out pointer.
	if unsafe { GetAce(dacl, 0, &raw mut ace) } == 0 {
		return Err(io::Error::last_os_error());
	}
	let ace = ace.cast::<ACCESS_ALLOWED_ACE>();
	// SAFETY: `ace` points at ACE 0 inside `descriptor`; its type is checked
	// before the allowed-ACE layout is relied on for the SID.
	let granted_to_me = unsafe {
		(*ace).Header.AceType == ACCESS_ALLOWED_ACE_TYPE
			&& EqualSid((&raw mut (*ace).SidStart).cast(), me.sid()) != 0
	};
	Ok(granted_to_me)
}

#[cfg(test)]
mod tests {
	use std::{ffi::c_void, fs, io, iter, os::windows::ffi::OsStrExt, process::Command, ptr};

	use windows_sys::Win32::{
		Foundation::ERROR_SUCCESS,
		Security::{
			ACCESS_ALLOWED_ACE, ACL,
			Authorization::{GetNamedSecurityInfoW, SE_FILE_OBJECT},
			DACL_SECURITY_INFORMATION, EqualSid, GetAce, GetSecurityDescriptorControl,
			OWNER_SECURITY_INFORMATION, PSID, SE_DACL_PROTECTED,
		},
	};

	use super::{
		ACCESS_ALLOWED_ACE_TYPE, Descriptor, current_user, restrict_dir_to_current_user,
		verify_dir_restricted,
	};

	/// `FILE_ALL_ACCESS`, the `FA` right the SDDL grants.
	const FILE_ALL_ACCESS: u32 = 0x001f_01ff;

	#[test]
	fn verify_accepts_only_a_restricted_directory() {
		let dir = tempfile::tempdir().unwrap();
		assert!(!verify_dir_restricted(dir.path()).unwrap(), "inherited ACL is not restricted");
		restrict_dir_to_current_user(dir.path()).unwrap();
		assert!(verify_dir_restricted(dir.path()).unwrap());
		let file = dir.path().join("file");
		fs::write(&file, b"").unwrap();
		assert_eq!(verify_dir_restricted(&file).unwrap_err().kind(), io::ErrorKind::InvalidInput);
	}

	#[test]
	fn restricts_a_plain_directory() {
		let dir = tempfile::tempdir().unwrap();
		restrict_dir_to_current_user(dir.path()).unwrap();

		let path: Vec<u16> = dir
			.path()
			.as_os_str()
			.encode_wide()
			.chain(iter::once(0))
			.collect();
		let mut owner: PSID = ptr::null_mut();
		let mut dacl: *mut ACL = ptr::null_mut();
		let mut raw = ptr::null_mut();
		// SAFETY: `path` is NUL-terminated; outputs are valid pointers and point
		// into `raw`, which `Descriptor` frees on drop.
		let status = unsafe {
			GetNamedSecurityInfoW(
				path.as_ptr(),
				SE_FILE_OBJECT,
				OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
				&raw mut owner,
				ptr::null_mut(),
				&raw mut dacl,
				ptr::null_mut(),
				&raw mut raw,
			)
		};
		assert_eq!(status, ERROR_SUCCESS);
		let descriptor = Descriptor(raw);
		let me = current_user().unwrap();

		// SAFETY: both SIDs are live (`descriptor`, `me`).
		assert_ne!(unsafe { EqualSid(owner, me.sid()) }, 0, "owner is not the current user");

		let (mut control, mut revision) = (0u16, 0u32);
		// SAFETY: `descriptor.0` is a valid descriptor; outputs are valid.
		let ok =
			unsafe { GetSecurityDescriptorControl(descriptor.0, &raw mut control, &raw mut revision) };
		assert_ne!(ok, 0);
		assert_ne!(control & SE_DACL_PROTECTED, 0, "DACL is not protected");

		assert!(!dacl.is_null(), "no DACL");
		// SAFETY: `dacl` points into `descriptor`.
		assert_eq!(unsafe { (*dacl).AceCount }, 1, "DACL must hold exactly one ACE");
		let mut ace: *mut c_void = ptr::null_mut();
		// SAFETY: index 0 exists; `ace` is a valid out pointer.
		assert_ne!(unsafe { GetAce(dacl, 0, &raw mut ace) }, 0);
		let ace = ace.cast::<ACCESS_ALLOWED_ACE>();
		// SAFETY: `ace` points at ACE 0 inside `descriptor`; its type is checked
		// before the allowed-ACE layout is relied on for the SID.
		unsafe {
			assert_eq!((*ace).Header.AceType, ACCESS_ALLOWED_ACE_TYPE);
			assert_eq!((*ace).Mask, FILE_ALL_ACCESS);
			let sid: PSID = (&raw mut (*ace).SidStart).cast();
			assert_ne!(EqualSid(sid, me.sid()), 0, "ACE does not grant the current user");
		}
	}

	#[test]
	fn refuses_a_file() {
		let dir = tempfile::tempdir().unwrap();
		let file = dir.path().join("file");
		fs::write(&file, b"").unwrap();
		let error = restrict_dir_to_current_user(&file).unwrap_err();
		assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
	}

	#[test]
	fn refuses_a_junction() {
		let dir = tempfile::tempdir().unwrap();
		let target = dir.path().join("target");
		let junction = dir.path().join("junction");
		fs::create_dir(&target).unwrap();
		// Junctions need no privilege, unlike directory symlinks.
		let status = Command::new("cmd")
			.arg("/C")
			.arg("mklink")
			.arg("/J")
			.arg(&junction)
			.arg(&target)
			.output()
			.unwrap()
			.status;
		assert!(status.success(), "mklink /J failed");
		let error = restrict_dir_to_current_user(&junction).unwrap_err();
		assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
	}
}
