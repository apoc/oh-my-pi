//! Same-machine listener: the [`super::sealed`] protocol over an endpoint
//! other accounts cannot connect to.
//!
//! - Unix: a socket `<registry dir>/<instanceId>.sock`; the directory is 0700,
//!   so only the owner can reach it.
//! - Windows: a named pipe `\\.\pipe\omp-mesh-<instanceId>-<random>` whose DACL
//!   grants only the current user; remote (SMB) clients are rejected and the
//!   first instance is created exclusively, so nobody can pre-create it.
//!
//! On top, requests are sealed with a key derived (HKDF) from a random bearer
//! token that only the owner-only registry reveals; the token never travels.

use std::{io, path::Path, sync::Arc};

use parking_lot::Mutex;

use super::{
	Acceptor, Endpoint, InboundSink, Listener, OriginKind, TransportError,
	sealed::{self, Server, ServerKey},
};
use crate::keys::{ReplayGuard, SealKey, hex, random_bytes};

/// Raw token length (hex-encoded in [`Endpoint::Local`] and the registry).
pub const TOKEN_BYTES: usize = 32;

/// A running local listener. Dropping it stops serving (and on Unix removes
/// the socket file).
#[derive(Debug)]
pub struct LocalListener {
	listener: Listener,
	path:     String,
	token:    String,
}

impl LocalListener {
	/// Listen for envelopes addressed to `instance_id` with a fresh random
	/// token; on Unix the socket lives in `dir` (which must already be
	/// owner-only).
	///
	/// # Errors
	/// When the endpoint cannot be created.
	pub fn start(dir: &Path, instance_id: String, sink: Arc<dyn InboundSink>) -> io::Result<Self> {
		let mut raw = [0u8; TOKEN_BYTES];
		random_bytes(&mut raw);
		let (acceptor, path) = platform::bind(dir, &instance_id)?;
		// A fresh token means a fresh key, so a per-listener guard suffices.
		let server = Arc::new(Server {
			instance_id,
			key: ServerKey::Local(Box::new(SealKey::for_local_token(&raw))),
			guard: Arc::new(Mutex::new(ReplayGuard::default())),
			sink,
			origin: OriginKind::Local,
		});
		let listener = Listener::spawn(acceptor, None, move |stream, peer| {
			sealed::serve(stream, peer, Arc::clone(&server))
		});
		Ok(Self { listener, path, token: hex(&raw) })
	}

	/// Socket path (Unix) or pipe name (Windows).
	pub fn path(&self) -> &str {
		&self.path
	}

	/// Hex bearer token peers derive the key from.
	pub fn token(&self) -> &str {
		&self.token
	}

	pub fn endpoint(&self) -> Endpoint {
		Endpoint::Local {
			path:  self.path.clone(),
			token: self.token.clone(),
			pid:   std::process::id(),
		}
	}

	/// Stop accepting and abort in-flight connections.
	pub async fn close(mut self) {
		platform::unlink(&self.path);
		self.listener.close().await;
	}
}

impl Drop for LocalListener {
	fn drop(&mut self) {
		platform::unlink(&self.path);
	}
}

/// Decode a 64-hex-char token.
pub(super) fn parse_token(token: &str) -> Option<[u8; TOKEN_BYTES]> {
	let bytes = token.as_bytes();
	if bytes.len() != TOKEN_BYTES * 2 {
		return None;
	}
	let mut out = [0u8; TOKEN_BYTES];
	for (byte, pair) in out.iter_mut().zip(bytes.as_chunks::<2>().0) {
		let hi = (pair[0] as char).to_digit(16)?;
		let lo = (pair[1] as char).to_digit(16)?;
		*byte = (hi << 4 | lo) as u8;
	}
	Some(out)
}

/// Whether `path` is the endpoint name [`LocalListener::start`] would use for
/// `instance_id` in `dir` (registry entries pointing elsewhere are refused).
pub fn is_endpoint_for(dir: &Path, instance_id: &str, path: &str) -> bool {
	platform::is_endpoint_for(dir, instance_id, path)
}

/// Remove a dead instance's leftover endpoint (its Unix socket file; no-op
/// for pipes). Callers pass only paths validated by [`is_endpoint_for`].
#[allow(clippy::missing_const_for_fn, reason = "the Unix variant removes a file")]
pub(crate) fn unlink_endpoint(path: &str) {
	platform::unlink(path);
}

/// Why connecting to a local endpoint failed.
enum ConnectError {
	Io(io::Error),
	/// Every server instance is busy (Windows pipes); the endpoint is alive.
	#[cfg_attr(unix, allow(dead_code, reason = "named pipes only"))]
	Busy,
	/// The endpoint is served by a process other than the registered owner
	/// (Windows: another account re-created a crashed instance's pipe name).
	#[cfg_attr(unix, allow(dead_code, reason = "named pipes only"))]
	WrongServer,
}

impl From<io::Error> for ConnectError {
	fn from(err: io::Error) -> Self {
		Self::Io(err)
	}
}

/// Connect to a local endpoint owned by process `pid`.
///
/// # Errors
/// [`TransportError::Unreachable`] when nothing listens there,
/// [`TransportError::Misdirected`] when another process serves it.
pub(super) async fn connect(path: &str, pid: u32) -> Result<platform::Stream, TransportError> {
	platform::connect(path, pid).await.map_err(|e| match e {
		ConnectError::Io(e) => TransportError::Unreachable(format!("cannot connect to {path}: {e}")),
		ConnectError::WrongServer => TransportError::Misdirected,
		ConnectError::Busy => TransportError::Unreachable(format!("{path} is busy")),
	})
}

/// Liveness probe for registry listing: `Ok(true)` when the owner (process
/// `pid`) accepts, `Ok(false)` when the endpoint provably does not exist,
/// refuses, or is served by another process.
///
/// # Errors
/// Other I/O failures (treated as "unknown" by the caller).
pub async fn probe(path: &str, pid: u32) -> io::Result<bool> {
	match platform::connect_once(path, pid).await {
		Ok(Some(_)) | Err(ConnectError::Busy) => Ok(true),
		Ok(None) | Err(ConnectError::WrongServer) => Ok(false),
		Err(ConnectError::Io(e)) => Err(e),
	}
}

/// Remove `<dir>/<name>` if it is a Unix socket without a matching
/// `<id>.json` entry that refuses connections (left by a crash between the
/// two removals on close, or by an entry pruned as malformed). Blocking.
#[cfg(unix)]
pub(crate) fn sweep_orphan_socket(dir: &Path, name: &str) {
	let Some(id) = name.strip_suffix(".sock") else {
		return;
	};
	if dir.join(format!("{id}.json")).exists() {
		return;
	}
	let path = dir.join(name);
	let refused = std::os::unix::net::UnixStream::connect(&path).is_err_and(|e| {
		matches!(e.kind(), io::ErrorKind::ConnectionRefused | io::ErrorKind::NotFound)
	});
	if refused {
		let _ = std::fs::remove_file(path);
	}
}

#[cfg(unix)]
mod platform {
	use std::{
		io,
		net::SocketAddr,
		path::{Path, PathBuf},
	};

	use tokio::net::{UnixListener, UnixStream};

	use super::{Acceptor, ConnectError};

	pub type Stream = UnixStream;

	/// `sun_path` capacity including the terminating NUL.
	#[cfg(any(
		target_os = "macos",
		target_os = "ios",
		target_os = "freebsd",
		target_os = "openbsd",
		target_os = "netbsd"
	))]
	const SUN_PATH_MAX: usize = 104;
	#[cfg(not(any(
		target_os = "macos",
		target_os = "ios",
		target_os = "freebsd",
		target_os = "openbsd",
		target_os = "netbsd"
	)))]
	const SUN_PATH_MAX: usize = 108;

	impl Acceptor for UnixListener {
		type Stream = UnixStream;

		async fn accept(&mut self) -> io::Result<(UnixStream, Option<SocketAddr>)> {
			Ok((Self::accept(self).await?.0, None))
		}
	}

	fn socket_path(dir: &Path, instance_id: &str) -> PathBuf {
		dir.join(format!("{instance_id}.sock"))
	}

	pub fn bind(dir: &Path, instance_id: &str) -> io::Result<(UnixListener, String)> {
		let path = socket_path(dir, instance_id);
		let len = path.as_os_str().len();
		if len >= SUN_PATH_MAX {
			return Err(io::Error::new(
				io::ErrorKind::InvalidInput,
				format!(
					"local mesh socket path is {len} bytes, over the {} byte limit: {}; set \
					 PI_CONFIG_DIR to a shorter directory",
					SUN_PATH_MAX - 1,
					path.display()
				),
			));
		}
		// A leftover from a crashed run of the same id (ids are random).
		let _ = std::fs::remove_file(&path);
		let listener = UnixListener::bind(&path)?;
		let name = path
			.into_os_string()
			.into_string()
			.map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "non-UTF-8 registry path"))?;
		Ok((listener, name))
	}

	pub fn unlink(path: &str) {
		let _ = std::fs::remove_file(path);
	}

	pub fn is_endpoint_for(dir: &Path, instance_id: &str, path: &str) -> bool {
		Path::new(path) == socket_path(dir, instance_id)
	}

	/// Only the owner can create sockets in the 0700 registry directory, so
	/// the server is not re-checked here.
	pub async fn connect(path: &str, _pid: u32) -> Result<UnixStream, ConnectError> {
		Ok(UnixStream::connect(path).await?)
	}

	/// One attempt: `Ok(None)` when the socket is missing or refuses.
	pub async fn connect_once(path: &str, _pid: u32) -> Result<Option<UnixStream>, ConnectError> {
		match UnixStream::connect(path).await {
			Ok(stream) => Ok(Some(stream)),
			Err(e)
				if matches!(e.kind(), io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused) =>
			{
				Ok(None)
			},
			Err(e) => Err(e.into()),
		}
	}
}

#[cfg(windows)]
mod platform {
	use std::{io, net::SocketAddr, os::windows::io::AsRawHandle, path::Path, time::Duration};

	use tokio::net::windows::named_pipe::{
		ClientOptions, NamedPipeClient, NamedPipeServer, PipeMode, ServerOptions,
	};
	use windows_sys::Win32::{
		Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PIPE_BUSY},
		System::Pipes::GetNamedPipeServerProcessId,
	};

	use super::{Acceptor, ConnectError};
	use crate::{
		keys::{hex, random_bytes},
		winsec::{Descriptor, pipe_descriptor},
	};

	pub type Stream = NamedPipeClient;

	const PREFIX: &str = r"\\.\pipe\omp-mesh-";
	/// Retry delay while every server instance is busy.
	const BUSY_RETRY: Duration = Duration::from_millis(20);

	/// Serves one pipe name: always keeps one listening instance ready.
	pub struct PipeAcceptor {
		name:     String,
		next:     NamedPipeServer,
		security: Descriptor,
	}

	fn create(name: &str, security: &Descriptor, first: bool) -> io::Result<NamedPipeServer> {
		let mut options = ServerOptions::new();
		options
			.first_pipe_instance(first)
			.reject_remote_clients(true)
			.pipe_mode(PipeMode::Byte);
		let mut attributes = security.attributes();
		// SAFETY: `attributes` points at `security`'s descriptor, alive for the
		// call; Win32 copies it while creating the instance.
		unsafe { options.create_with_security_attributes_raw(name, (&raw mut attributes).cast()) }
	}

	impl Acceptor for PipeAcceptor {
		type Stream = NamedPipeServer;

		async fn accept(&mut self) -> io::Result<(NamedPipeServer, Option<SocketAddr>)> {
			self.next.connect().await?;
			// Ready the next instance before handing this one off. On failure the
			// connected instance stays in `next`; `connect` on it succeeds at
			// once, so the next call serves it.
			let fresh = create(&self.name, &self.security, false)?;
			Ok((std::mem::replace(&mut self.next, fresh), None))
		}
	}

	pub fn bind(_dir: &Path, instance_id: &str) -> io::Result<(PipeAcceptor, String)> {
		let mut suffix = [0u8; 8];
		random_bytes(&mut suffix);
		let name = format!("{PREFIX}{instance_id}-{}", hex(&suffix));
		let security = pipe_descriptor()?;
		let next = create(&name, &security, true)?;
		Ok((PipeAcceptor { name: name.clone(), next, security }, name))
	}

	pub const fn unlink(_path: &str) {}

	pub fn is_endpoint_for(_dir: &Path, instance_id: &str, path: &str) -> bool {
		path
			.strip_prefix(PREFIX)
			.and_then(|rest| rest.strip_prefix(instance_id))
			.and_then(|rest| rest.strip_prefix('-'))
			.is_some_and(|rand| rand.len() == 16 && rand.bytes().all(|b| b.is_ascii_hexdigit()))
	}

	/// Pipe names are visible to every account: after the owner crashed,
	/// another one could create a pipe with the same name. Accept only a
	/// server running as the registered owner process.
	fn check_server(client: NamedPipeClient, pid: u32) -> Result<NamedPipeClient, ConnectError> {
		let mut server = 0u32;
		// SAFETY: `client` owns a live pipe handle; `server` is a valid out
		// pointer.
		if unsafe { GetNamedPipeServerProcessId(client.as_raw_handle(), &raw mut server) } == 0 {
			return Err(io::Error::last_os_error().into());
		}
		if server == pid {
			Ok(client)
		} else {
			Err(ConnectError::WrongServer)
		}
	}

	/// One open attempt: `Ok(None)` when no such pipe exists; busy instances
	/// are reported as [`ConnectError::Busy`].
	#[allow(clippy::unused_async, reason = "same signature as the Unix variant")]
	pub async fn connect_once(
		name: &str,
		pid: u32,
	) -> Result<Option<NamedPipeClient>, ConnectError> {
		match ClientOptions::new().open(name) {
			Ok(client) => check_server(client, pid).map(Some),
			Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) => Err(ConnectError::Busy),
			Err(e) if e.raw_os_error() == Some(ERROR_FILE_NOT_FOUND as i32) => Ok(None),
			Err(e) => Err(e.into()),
		}
	}

	/// Open, retrying while every instance is busy (bounded by the caller's
	/// request timeout).
	pub async fn connect(name: &str, pid: u32) -> Result<NamedPipeClient, ConnectError> {
		loop {
			match connect_once(name, pid).await {
				Ok(Some(client)) => return Ok(client),
				Ok(None) => {
					return Err(io::Error::from_raw_os_error(ERROR_FILE_NOT_FOUND as i32).into());
				},
				Err(ConnectError::Busy) => tokio::time::sleep(BUSY_RETRY).await,
				Err(e) => return Err(e),
			}
		}
	}
}
