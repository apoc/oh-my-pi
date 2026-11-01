//! Entry file format, validation and atomic writes.

use std::{
	fmt, io,
	path::{Path, PathBuf},
	time::{SystemTime, UNIX_EPOCH},
};

use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};

use crate::VERSION;

/// Length of an instance id (`^[a-z0-9]{16}$`).
pub const INSTANCE_ID_LEN: usize = 16;
/// Raw bytes behind an entry's hex `nonce` (part of the endpoint name).
pub(crate) const NONCE_BYTES: usize = 8;
/// Raw bytes behind an entry's hex bearer `token`.
pub(crate) const TOKEN_BYTES: usize = 32;
/// Longest namespace name.
const MAX_NAMESPACE_LEN: usize = 32;

pub(crate) const ENTRY_SUFFIX: &str = ".json";
pub(crate) const TMP_SUFFIX: &str = ".tmp";

/// The single validity rule for instance ids: 16 lowercase ASCII letters or
/// digits, so ids fit DNS labels, TXT records and file names unchanged.
pub fn is_instance_id(s: &str) -> bool {
	s.len() == INSTANCE_ID_LEN
		&& s
			.bytes()
			.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// Namespace names (`capabilities`, the `<ns>` of `<ns>.<op>`): 1–32 chars of
/// `[a-z0-9_-]`.
pub fn is_namespace(s: &str) -> bool {
	(1..=MAX_NAMESPACE_LEN).contains(&s.len())
		&& s
			.bytes()
			.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

fn is_lower_hex(s: &str, bytes: usize) -> bool {
	s.len() == bytes * 2 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// A published instance: one `<instanceId>.json` (format v1) in the registry.
///
/// `Debug` omits the bearer `token`.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceEntry {
	pub instance_id:  String,
	/// Owner process id (compared with the pipe server pid on Windows only).
	pub pid:          u32,
	/// 16 lowercase hex digits; the endpoint is named `<instanceId>-<nonce>`.
	/// Random per listener so nobody can squat the name before it is bound;
	/// not a secret once bound (pipe and socket names are visible). The
	/// security boundary is the server identity check (user/uid, and the pid
	/// on Windows).
	pub nonce:        String,
	/// Unix socket path or Windows pipe name; always
	/// `pi_ipc::endpoint(dir, "<instanceId>-<nonce>")`.
	pub endpoint:     String,
	/// 64 lowercase hex digits.
	pub token:        String,
	/// ms since the Unix epoch; fixed for the listener's lifetime.
	pub created_at:   u64,
	/// Registered namespaces, sorted; `[]` while none is registered.
	pub capabilities: Vec<String>,
}

impl fmt::Debug for InstanceEntry {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_struct("InstanceEntry")
			.field("instance_id", &self.instance_id)
			.field("pid", &self.pid)
			.field("nonce", &self.nonce)
			.field("endpoint", &self.endpoint)
			.field("created_at", &self.created_at)
			.field("capabilities", &self.capabilities)
			.finish_non_exhaustive()
	}
}

#[derive(Serialize)]
struct EntryFile<'a> {
	v:     u32,
	#[serde(flatten)]
	entry: &'a InstanceEntry,
}

impl InstanceEntry {
	/// Entry file bytes.
	pub(crate) fn to_file_bytes(&self) -> Vec<u8> {
		serde_json::to_vec(&EntryFile { v: VERSION, entry: self })
			.expect("entry serialization is infallible")
	}

	/// Whether this v1 entry is well formed for file `<stem>.json` in `dir`.
	pub(crate) fn is_valid_for(&self, dir: &str, stem: &str) -> bool {
		self.instance_id == stem
			&& is_instance_id(&self.instance_id)
			&& is_lower_hex(&self.nonce, NONCE_BYTES)
			&& is_lower_hex(&self.token, TOKEN_BYTES)
			&& self.capabilities.iter().all(|ns| is_namespace(ns))
			&& self.endpoint == endpoint_for(dir, &self.instance_id, &self.nonce)
	}
}

/// The endpoint an instance with `instance_id` and `nonce` binds in `dir`.
pub(crate) fn endpoint_for(dir: &str, instance_id: &str, nonce: &str) -> String {
	pi_ipc::endpoint(dir, &format!("{instance_id}-{nonce}"))
}

pub(crate) fn entry_path(dir: &Path, instance_id: &str) -> PathBuf {
	dir.join(format!("{instance_id}{ENTRY_SUFFIX}"))
}

/// `dir` as UTF-8, the form endpoints are derived from.
pub(crate) fn dir_str(dir: &Path) -> Option<&str> {
	dir.to_str()
}

pub(crate) fn now_ms() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// `bytes` random bytes from the OS, lowercase hex.
pub(crate) fn random_hex(bytes: usize) -> String {
	const DIGITS: &[u8; 16] = b"0123456789abcdef";
	let mut raw = vec![0u8; bytes];
	SystemRandom::new()
		.fill(&mut raw)
		.expect("OS random source unavailable");
	let mut out = String::with_capacity(bytes * 2);
	for b in raw {
		out.push(DIGITS[usize::from(b >> 4)] as char);
		out.push(DIGITS[usize::from(b & 0xf)] as char);
	}
	out
}

/// Constant-time token comparison (length is not secret).
pub(crate) fn token_matches(expected: &str, presented: &str) -> bool {
	let (expected, presented) = (expected.as_bytes(), presented.as_bytes());
	expected.len() == presented.len()
		&& std::hint::black_box(
			expected
				.iter()
				.zip(presented)
				.fold(0u8, |acc, (a, b)| acc | (a ^ b)),
		) == 0
}

/// Write `bytes` to `path` through a 0600 temp file and a rename, so readers
/// never observe a partial entry. A failure leaves no temp file behind.
pub(crate) fn write_private_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
	use std::io::Write as _;
	let tmp = path.with_extension(format!("{}{TMP_SUFFIX}", random_hex(6)));
	let mut options = std::fs::OpenOptions::new();
	options.write(true).create_new(true);
	#[cfg(unix)]
	{
		use std::os::unix::fs::OpenOptionsExt;
		options.mode(0o600);
	}
	let result = (|| {
		let mut file = options.open(&tmp)?;
		file.write_all(bytes)?;
		file.sync_all()?;
		drop(file);
		std::fs::rename(&tmp, path)
	})();
	if result.is_err() {
		let _ = std::fs::remove_file(&tmp);
	}
	result
}

#[cfg(unix)]
pub(crate) fn pid_alive(pid: u32) -> bool {
	let Ok(pid) = libc::pid_t::try_from(pid) else {
		return false;
	};
	if pid <= 0 {
		return false;
	}
	// SAFETY: signal 0 only checks for existence/permission; no side effects.
	let rc = unsafe { libc::kill(pid, 0) };
	rc == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
pub(crate) fn pid_alive(pid: u32) -> bool {
	use windows_sys::Win32::{
		Foundation::{CloseHandle, ERROR_ACCESS_DENIED, GetLastError, STILL_ACTIVE},
		System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
	};
	// SAFETY: plain Win32 calls on a handle we own and close.
	unsafe {
		let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
		if handle.is_null() {
			// Elevated or protected processes refuse the query but exist.
			return GetLastError() == ERROR_ACCESS_DENIED;
		}
		let mut code = 0u32;
		let ok = GetExitCodeProcess(handle, &raw mut code) != 0;
		CloseHandle(handle);
		!ok || code == STILL_ACTIVE as u32
	}
}
