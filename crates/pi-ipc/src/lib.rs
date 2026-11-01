//! Local IPC transport: Unix domain sockets and Windows named pipes behind one
//! N-API-free API.
//!
//! This crate owns endpoint naming, peer security (same user only),
//! single-instance bind, stale-endpoint takeover and line framing. Callers own
//! lifecycle policy; `pi-natives` wraps it as `IpcServer` / `IpcConnection`.
//!
//! - [`endpoint()`]: deterministic endpoint for a name in a directory.
//! - [`listen`] / [`Listener::accept`] / [`release`]: server side.
//! - [`connect`]: client side.
//! - [`Stream`]: a connection to a same-user peer, readiness-based (`readable`
//!   / `try_read_buf` / `writable` / `try_write_vectored`) or via `AsyncRead` /
//!   `AsyncWrite`. `AsyncWrite::shutdown` closes the write half on Unix only;
//!   on Windows it is a flush, and the peer sees EOF only once the stream is
//!   dropped (see [`WriteFinish::Closed`]).
//! - [`lines`]: incremental LF framing.
//! - `winsec` (Windows): process-token users and current-user-only security
//!   descriptors.

use std::{fmt, io};

mod endpoint;
pub mod lines;
#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub mod winsec;

#[cfg(unix)]
use unix as platform;
#[cfg(windows)]
use windows as platform;

#[cfg(unix)]
pub use self::unix::{
	BIND_LOCK_SUFFIX, bind_lock_options, bind_lock_path, is_private_dir, is_same_file,
	tighten_owned_dir,
};
pub use self::{
	endpoint::endpoint,
	platform::{
		Bound, Listener, Stream, WriteFinish, connect, is_orderly_eof, listen, os_error_code, release,
	},
};

#[cfg(not(any(unix, windows)))]
compile_error!("pi-ipc requires Unix or Windows");

/// Transport failure carrying an errno-style code (`ENOENT`, `EADDRINUSE`, …).
#[derive(Debug)]
pub struct IpcError {
	code:         &'static str,
	message:      String,
	foreign_peer: bool,
}

impl IpcError {
	pub fn new(code: &'static str, message: impl Into<String>) -> Self {
		Self { code, message: message.into(), foreign_peer: false }
	}

	/// The dialed endpoint is served by a process of another user. Its code
	/// stays `EACCES`; [`Self::is_foreign_peer`] tells it apart from other
	/// permission errors.
	pub fn foreign_peer(message: impl Into<String>) -> Self {
		Self { code: "EACCES", message: message.into(), foreign_peer: true }
	}

	/// `error` with its errno-style code, described as `"<context>: <error>"`.
	pub fn io(error: &io::Error, context: &str) -> Self {
		Self::new(io_error_code(error), format!("{context}: {error}"))
	}

	/// Whether the peer runs as another user ([`Self::foreign_peer`]): such
	/// an endpoint can never belong to one of our processes.
	pub const fn is_foreign_peer(&self) -> bool {
		self.foreign_peer
	}

	/// Errno-style code.
	pub const fn code(&self) -> &'static str {
		self.code
	}

	/// Description without the code, by value.
	pub fn into_message(self) -> String {
		self.message
	}

	/// `"<CODE>: <message>"`.
	pub fn reason(&self) -> String {
		format!("{}: {}", self.code, self.message)
	}
}

impl fmt::Display for IpcError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(f, "{}: {}", self.code, self.message)
	}
}

impl std::error::Error for IpcError {}

/// Errno-style name for `error`.
pub fn io_error_code(error: &io::Error) -> &'static str {
	if let Some(code) = error.raw_os_error().and_then(os_error_code) {
		return code;
	}
	match error.kind() {
		io::ErrorKind::NotFound => "ENOENT",
		io::ErrorKind::PermissionDenied => "EACCES",
		io::ErrorKind::ConnectionRefused => "ECONNREFUSED",
		io::ErrorKind::ConnectionReset => "ECONNRESET",
		io::ErrorKind::ConnectionAborted => "ECONNABORTED",
		io::ErrorKind::NotConnected => "ENOTCONN",
		io::ErrorKind::AddrInUse => "EADDRINUSE",
		io::ErrorKind::AddrNotAvailable => "EADDRNOTAVAIL",
		io::ErrorKind::BrokenPipe => "EPIPE",
		io::ErrorKind::AlreadyExists => "EEXIST",
		io::ErrorKind::WouldBlock => "EAGAIN",
		io::ErrorKind::InvalidInput => "EINVAL",
		io::ErrorKind::TimedOut => "ETIMEDOUT",
		io::ErrorKind::Interrupted => "EINTR",
		io::ErrorKind::Unsupported => "ENOTSUP",
		io::ErrorKind::OutOfMemory => "ENOMEM",
		_ => "EIO",
	}
}

#[cfg(test)]
mod tests {
	use std::time::Duration;

	use tokio::io::{AsyncReadExt, AsyncWriteExt};

	use super::*;

	const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

	fn temp_endpoint(dir: &tempfile::TempDir, name: &str) -> String {
		endpoint(dir.path().to_str().expect("utf-8 temp dir"), name)
	}

	#[tokio::test]
	async fn listen_connect_round_trip_over_async_io() {
		let dir = tempfile::tempdir().unwrap();
		let endpoint = temp_endpoint(&dir, "round trip");
		let (mut listener, bound) = listen(&endpoint).await.unwrap();

		let server = tokio::spawn(async move {
			let mut stream = listener.accept().await.unwrap();
			let mut request = [0u8; 5];
			stream.read_exact(&mut request).await.unwrap();
			stream.write_all(b"pong:").await.unwrap();
			stream.write_all(&request).await.unwrap();
			stream.flush().await.unwrap();
			// Hold the server end until the client has read the reply.
			let mut rest = Vec::new();
			stream.read_to_end(&mut rest).await.ok();
		});

		let mut client = connect(&endpoint, CONNECT_TIMEOUT).await.unwrap();
		#[cfg(windows)]
		assert_eq!(client.server_pid().unwrap(), std::process::id());
		client.write_all(b"ping\n").await.unwrap();
		client.flush().await.unwrap();
		let mut reply = [0u8; 10];
		client.read_exact(&mut reply).await.unwrap();
		assert_eq!(&reply, b"pong:ping\n");
		drop(client);

		server.await.unwrap();
		release(bound);
	}

	#[tokio::test]
	async fn second_listener_is_rejected_while_first_is_live() {
		let dir = tempfile::tempdir().unwrap();
		let endpoint = temp_endpoint(&dir, "single");
		let (_listener, bound) = listen(&endpoint).await.unwrap();
		let error = listen(&endpoint)
			.await
			.err()
			.expect("second listen must fail");
		assert_eq!(error.code(), "EADDRINUSE", "{error}");
		release(bound);
	}

	#[tokio::test]
	async fn connect_without_listener_is_enoent() {
		let dir = tempfile::tempdir().unwrap();
		let endpoint = temp_endpoint(&dir, "absent");
		let error = connect(&endpoint, CONNECT_TIMEOUT)
			.await
			.err()
			.expect("connect must fail");
		assert_eq!(error.code(), "ENOENT", "{error}");
	}

	#[tokio::test]
	async fn dropping_either_end_is_an_orderly_eof() {
		let dir = tempfile::tempdir().unwrap();
		let endpoint = temp_endpoint(&dir, "drop");
		let (mut listener, bound) = listen(&endpoint).await.unwrap();

		// Client drops after writing: the server reads the bytes, then EOF.
		let server = tokio::spawn(async move {
			let mut stream = listener.accept().await.unwrap();
			let mut received = Vec::new();
			stream.read_to_end(&mut received).await.unwrap();
			assert_eq!(received, b"bye");
			// Server drops after writing: the client reads the bytes, then EOF.
			let mut next = listener.accept().await.unwrap();
			next.write_all(b"later").await.unwrap();
			next.flush().await.unwrap();
		});
		let mut client = connect(&endpoint, CONNECT_TIMEOUT).await.unwrap();
		client.write_all(b"bye").await.unwrap();
		client.flush().await.unwrap();
		drop(client);

		let mut client = connect(&endpoint, CONNECT_TIMEOUT).await.unwrap();
		let mut received = Vec::new();
		client.read_to_end(&mut received).await.unwrap();
		assert_eq!(received, b"later");

		server.await.unwrap();
		release(bound);
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn shutdown_half_closes_on_unix() {
		let dir = tempfile::tempdir().unwrap();
		let endpoint = temp_endpoint(&dir, "half close");
		let (mut listener, bound) = listen(&endpoint).await.unwrap();

		let server = tokio::spawn(async move {
			let mut stream = listener.accept().await.unwrap();
			let mut request = Vec::new();
			stream.read_to_end(&mut request).await.unwrap();
			assert_eq!(request, b"request");
			stream.write_all(b"reply").await.unwrap();
			stream.shutdown().await.unwrap();
		});
		let mut client = connect(&endpoint, CONNECT_TIMEOUT).await.unwrap();
		client.write_all(b"request").await.unwrap();
		client.shutdown().await.unwrap();
		let mut reply = Vec::new();
		client.read_to_end(&mut reply).await.unwrap();
		assert_eq!(reply, b"reply");

		server.await.unwrap();
		release(bound);
	}

	#[cfg(unix)]
	#[test]
	fn private_dir_check_never_trusts_links_or_loose_modes() {
		use std::os::unix::fs::PermissionsExt;
		let tmp = tempfile::tempdir().unwrap();
		let dir = tmp.path().join("private");
		std::fs::create_dir(&dir).unwrap();
		std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
		assert!(!is_private_dir(&dir), "group/other access");
		std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
		assert!(is_private_dir(&dir));
		let link = tmp.path().join("link");
		std::os::unix::fs::symlink(&dir, &link).unwrap();
		assert!(!is_private_dir(&link), "a link to a private dir is not one");
		assert_eq!(
			std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
			0o700,
			"check-only"
		);
	}

	#[cfg(unix)]
	#[test]
	fn an_unlinked_or_replaced_file_is_not_the_same_file() {
		let tmp = tempfile::tempdir().unwrap();
		let path = tmp.path().join("x.bind.lock");
		let file = std::fs::File::create(&path).unwrap();
		assert!(is_same_file(&file, &path));
		std::fs::remove_file(&path).unwrap();
		assert!(!is_same_file(&file, &path));
		std::fs::write(&path, b"").unwrap();
		assert!(!is_same_file(&file, &path), "a new file at the path is another inode");
	}
}
