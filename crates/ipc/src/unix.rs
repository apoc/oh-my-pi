//! Unix domain socket transport.

use std::{
	ffi::OsStr,
	fs::{self, DirBuilder, OpenOptions, Permissions},
	io::{self, IoSlice},
	mem,
	os::{
		fd::{AsRawFd, FromRawFd, OwnedFd},
		unix::{
			ffi::OsStrExt,
			fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
		},
	},
	path::{Path, PathBuf},
	pin::Pin,
	task::{Context, Poll},
	time::{Duration, Instant},
};

use tokio::{
	io::{AsyncRead, AsyncWrite, ReadBuf},
	net::{UnixListener, UnixStream},
};

use crate::{IpcError, endpoint};

/// `listen()` backlog.
const BACKLOG: libc::c_int = 512;

/// How long a binder waits for a held bind lock before deciding a live
/// listener owns it (sweeps and liveness probes hold it for microseconds).
const LOCK_HOLDER_WAIT: Duration = Duration::from_millis(250);

/// Pause between bind lock attempts within [`LOCK_HOLDER_WAIT`].
const LOCK_RETRY_INTERVAL: Duration = Duration::from_millis(5);

/// Effective uid of this process.
pub fn euid() -> u32 {
	// SAFETY: `geteuid` has no preconditions and cannot fail.
	unsafe { libc::geteuid() }
}

/// Errno-style name for a raw OS error.
pub const fn os_error_code(errno: i32) -> Option<&'static str> {
	Some(match errno {
		libc::ENOENT => "ENOENT",
		libc::EACCES => "EACCES",
		libc::EPERM => "EPERM",
		libc::ECONNREFUSED => "ECONNREFUSED",
		libc::ECONNRESET => "ECONNRESET",
		libc::ECONNABORTED => "ECONNABORTED",
		libc::ENOTCONN => "ENOTCONN",
		libc::EADDRINUSE => "EADDRINUSE",
		libc::EADDRNOTAVAIL => "EADDRNOTAVAIL",
		libc::EPIPE => "EPIPE",
		libc::ETIMEDOUT => "ETIMEDOUT",
		libc::EAGAIN => "EAGAIN",
		libc::EINTR => "EINTR",
		libc::EINVAL => "EINVAL",
		libc::EEXIST => "EEXIST",
		libc::ENOTDIR => "ENOTDIR",
		libc::EISDIR => "EISDIR",
		libc::ELOOP => "ELOOP",
		libc::ENAMETOOLONG => "ENAMETOOLONG",
		libc::EMFILE => "EMFILE",
		libc::ENFILE => "ENFILE",
		libc::ENOMEM => "ENOMEM",
		libc::ENOSPC => "ENOSPC",
		libc::EROFS => "EROFS",
		libc::ENOTSOCK => "ENOTSOCK",
		libc::EPROTOTYPE => "EPROTOTYPE",
		libc::EMSGSIZE => "EMSGSIZE",
		libc::ENOBUFS => "ENOBUFS",
		libc::EBADF => "EBADF",
		libc::EIO => "EIO",
		_ => return None,
	})
}

/// Unix reports a vanished peer as EOF or an explicit error; neither is an
/// orderly close beyond `read() == 0`.
pub const fn is_orderly_eof(_error: &io::Error) -> bool {
	false
}

/// Socket file this server bound, identified by inode so close never unlinks a
/// successor's socket.
pub struct Bound {
	path: PathBuf,
	dev:  u64,
	ino:  u64,
}

/// Unlink the socket file if it is still the one this server bound.
pub fn release(bound: Bound) {
	if let Ok(meta) = fs::symlink_metadata(&bound.path)
		&& meta.dev() == bound.dev
		&& meta.ino() == bound.ino
	{
		let _ = fs::remove_file(&bound.path);
	}
}

/// Suffix of the sidecar a server flocks from bind for its listener's whole
/// life: a lock anyone else can take proves no live listener.
pub const BIND_LOCK_SUFFIX: &str = ".bind.lock";

/// `<socket>.bind.lock`.
pub fn bind_lock_path(socket: &Path) -> PathBuf {
	let mut path = socket.as_os_str().to_owned();
	path.push(BIND_LOCK_SUFFIX);
	path.into()
}

/// Options opening a bind lock read/write, mode 0600 when created, never
/// through a symlink; the caller picks the create mode.
pub fn bind_lock_options() -> OpenOptions {
	let mut options = OpenOptions::new();
	options
		.read(true)
		.write(true)
		.mode(0o600)
		.custom_flags(libc::O_NOFOLLOW);
	options
}

/// Accepting side of a bound socket. Holds the exclusive flock on
/// `<socket>.bind.lock` until dropped, marking the socket live; the kernel
/// drops it with the process too.
pub struct Listener {
	listener: UnixListener,
	_lock:    fs::File,
}

impl Listener {
	/// Next connection whose peer runs as our effective uid.
	#[allow(
		clippy::needless_pass_by_ref_mut,
		reason = "shared shape: Windows swaps in its next pending pipe instance"
	)]
	pub async fn accept(&mut self) -> io::Result<Stream> {
		let euid = euid();
		loop {
			let (stream, _) = self.listener.accept().await?;
			// Foreign peers are dropped silently; the 0600 socket already keeps
			// them out on any filesystem honoring permissions.
			if stream.peer_cred().is_ok_and(|cred| cred.uid() == euid) {
				return Ok(Stream(stream));
			}
		}
	}
}

/// Bind `endpoint`.
///
/// Creates the parent dir (0700) if missing and takes the exclusive flock on
/// `<path>.bind.lock`: a lock still held after [`LOCK_HOLDER_WAIT`] means a
/// live listener, rejected EADDRINUSE. Under the lock a socket file left at
/// the path is replaced unless something not taking the lock answers a
/// non-blocking connect there (EADDRINUSE too). The socket is chmod 0600
/// before `listen()`. The returned [`Listener`] keeps the lock for its whole
/// life; the lock file is left in place.
/// Requires a Tokio runtime.
pub async fn listen(endpoint: &str) -> Result<(Listener, Bound), IpcError> {
	let path = PathBuf::from(endpoint);
	let (std_listener, lock, bound) = tokio::task::spawn_blocking(move || bind_locked(path))
		.await
		.map_err(|error| IpcError::new("EIO", format!("bind task failed: {error}")))??;
	let listener = UnixListener::from_std(std_listener)
		.map_err(|error| IpcError::io(&error, "register listener"))?;
	Ok((Listener { listener, _lock: lock }, bound))
}

fn bind_locked(
	path: PathBuf,
) -> Result<(std::os::unix::net::UnixListener, fs::File, Bound), IpcError> {
	let display = path.display().to_string();
	prepare_parent(&path)?;

	let lock_path = bind_lock_path(&path);
	let started = Instant::now();
	// A sweeper may unlink the lock file between our open and our flock;
	// holding a lock on an unlinked inode excludes nobody, so retry until the
	// locked file is the one at `lock_path`. A sweep or liveness probe holds
	// the lock for a few syscalls, a live listener for good: wait out the
	// former, reject the latter.
	let lock = loop {
		let lock = bind_lock_options()
			.create(true)
			.truncate(false)
			.open(&lock_path)
			.map_err(|error| IpcError::io(&error, &format!("open {}", lock_path.display())))?;
		match try_lock_at(&lock, &lock_path) {
			Ok(LockAttempt::Locked) => break lock,
			Ok(LockAttempt::Replaced) => {},
			Ok(LockAttempt::Held) => {
				if started.elapsed() >= LOCK_HOLDER_WAIT {
					return Err(IpcError::new(
						"EADDRINUSE",
						format!("{display} already has a live listener"),
					));
				}
				std::thread::sleep(LOCK_RETRY_INTERVAL);
			},
			Err(error) => return Err(IpcError::io(&error, "lock bind sidecar")),
		}
	};

	// The lock proves no omp listener owns a socket file at `path`, but a
	// program not taking our lock (or an older build) may still serve it: one
	// that answers keeps it. The connect never waits, so a full backlog of
	// such a peer cannot stall the bind (Linux reports it EAGAIN; macOS/BSD
	// refuse, indistinguishable from a dead socket).
	match fs::symlink_metadata(&path) {
		Ok(meta) if !meta.file_type().is_socket() => {
			return Err(IpcError::new("EADDRINUSE", format!("{display} exists and is not a socket")));
		},
		Ok(_) => match connect_nonblocking(&path) {
			Ok(_) => {
				return Err(IpcError::new(
					"EADDRINUSE",
					format!("{display} already has a live listener"),
				));
			},
			Err(error)
				if matches!(
					error.kind(),
					io::ErrorKind::ConnectionRefused | io::ErrorKind::NotFound
				) =>
			{
				match fs::remove_file(&path) {
					Ok(()) => {},
					Err(error) if error.kind() == io::ErrorKind::NotFound => {},
					Err(error) => {
						return Err(IpcError::io(&error, &format!("remove stale {display}")));
					},
				}
			},
			Err(error)
				if error.kind() == io::ErrorKind::WouldBlock
					|| error.raw_os_error() == Some(libc::EINPROGRESS) =>
			{
				return Err(IpcError::new(
					"EADDRINUSE",
					format!("{display} already has a live listener"),
				));
			},
			Err(error) => return Err(IpcError::io(&error, &format!("probe {display}"))),
		},
		Err(error) if error.kind() == io::ErrorKind::NotFound => {},
		Err(error) => return Err(IpcError::io(&error, &format!("stat {display}"))),
	}

	let socket =
		bind_private(&path).map_err(|error| IpcError::io(&error, &format!("bind {display}")))?;
	let meta = fs::symlink_metadata(&path)
		.map_err(|error| IpcError::io(&error, &format!("stat {display}")))?;
	let bound = Bound { path, dev: meta.dev(), ino: meta.ino() };
	// SAFETY: `socket` is a bound AF_UNIX stream socket owned by this frame.
	if unsafe { libc::listen(socket.as_raw_fd(), BACKLOG) } != 0 {
		let error = io::Error::last_os_error();
		release(bound);
		return Err(IpcError::io(&error, &format!("listen {display}")));
	}
	let listener = std::os::unix::net::UnixListener::from(socket);
	if let Err(error) = listener.set_nonblocking(true) {
		release(bound);
		return Err(IpcError::io(&error, "set listener nonblocking"));
	}
	Ok((listener, lock, bound))
}

/// Create an `AF_UNIX` stream socket bound at `path` with mode 0600.
///
/// The mode is applied between `bind()` and `listen()`: until `listen()` every
/// connect is refused, so there is no window in which a wider mode is usable.
fn bind_private(path: &Path) -> io::Result<OwnedFd> {
	let address = socket_address(path.as_os_str())?;
	let socket = unix_stream_socket()?;
	// SAFETY: `address.0` is a fully initialized sockaddr_un and `address.1`
	// is the exact length bind(2) must read from it.
	let status = unsafe {
		libc::bind(socket.as_raw_fd(), (&raw const address.0).cast::<libc::sockaddr>(), address.1)
	};
	if status != 0 {
		return Err(io::Error::last_os_error());
	}
	if let Err(error) = fs::set_permissions(path, Permissions::from_mode(0o600)) {
		let _ = fs::remove_file(path);
		return Err(error);
	}
	Ok(socket)
}

/// A fresh close-on-exec `AF_UNIX` stream socket.
fn unix_stream_socket() -> io::Result<OwnedFd> {
	// SAFETY: plain socket(2) call; the result is checked before use.
	let raw = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
	if raw < 0 {
		return Err(io::Error::last_os_error());
	}
	// SAFETY: `raw` is a fresh descriptor owned by nothing else.
	let socket = unsafe { OwnedFd::from_raw_fd(raw) };
	// SAFETY: `socket` is live; FD_CLOEXEC only affects exec inheritance.
	if unsafe { libc::fcntl(socket.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } != 0 {
		return Err(io::Error::last_os_error());
	}
	Ok(socket)
}

/// Connect to the socket at `path` without blocking. An `AF_UNIX` connect
/// completes or fails at once: a listener with a full accept backlog makes
/// it fail EAGAIN (Linux) or ECONNREFUSED (macOS/BSD) rather than wait.
fn connect_nonblocking(path: &Path) -> io::Result<OwnedFd> {
	let address = socket_address(path.as_os_str())?;
	let socket = unix_stream_socket()?;
	// SAFETY: `socket` is live; O_NONBLOCK only changes blocking mode.
	if unsafe { libc::fcntl(socket.as_raw_fd(), libc::F_SETFL, libc::O_NONBLOCK) } != 0 {
		return Err(io::Error::last_os_error());
	}
	// SAFETY: `address.0` is a fully initialized sockaddr_un and `address.1`
	// is the exact length connect(2) must read from it.
	let status = unsafe {
		libc::connect(socket.as_raw_fd(), (&raw const address.0).cast::<libc::sockaddr>(), address.1)
	};
	if status != 0 {
		return Err(io::Error::last_os_error());
	}
	Ok(socket)
}

fn socket_address(path: &OsStr) -> io::Result<(libc::sockaddr_un, libc::socklen_t)> {
	// SAFETY: sockaddr_un is plain old data; all-zero is a valid value.
	let mut address: libc::sockaddr_un = unsafe { mem::zeroed() };
	let bytes = path.as_bytes();
	if bytes.len() >= address.sun_path.len() || bytes.contains(&0) {
		return Err(io::Error::new(
			io::ErrorKind::InvalidInput,
			"socket path does not fit sockaddr_un (use ipcEndpoint)",
		));
	}
	address.sun_family = libc::AF_UNIX as libc::sa_family_t;
	for (slot, byte) in address.sun_path.iter_mut().zip(bytes) {
		*slot = *byte as libc::c_char;
	}
	let len = mem::offset_of!(libc::sockaddr_un, sun_path) + bytes.len() + 1;
	#[cfg(any(
		target_os = "macos",
		target_os = "ios",
		target_os = "freebsd",
		target_os = "openbsd",
		target_os = "netbsd",
		target_os = "dragonfly"
	))]
	{
		address.sun_len = len as u8;
	}
	Ok((address, len as libc::socklen_t))
}

/// Make sure the socket's parent directory exists (0700 when created). The
/// shared relocation directory must additionally be a real directory owned by
/// us with no group/other access.
fn prepare_parent(path: &Path) -> Result<(), IpcError> {
	let Some(parent) = path.parent().filter(|parent| !parent.is_empty()) else {
		return Ok(());
	};
	let euid = euid();
	if parent == Path::new(&endpoint::relocation_dir(euid)) {
		return ensure_private_dir(parent, euid);
	}
	DirBuilder::new()
		.recursive(true)
		.mode(0o700)
		.create(parent)
		.map_err(|error| IpcError::io(&error, &format!("create {}", parent.display())))
}

fn ensure_private_dir(dir: &Path, euid: u32) -> Result<(), IpcError> {
	match DirBuilder::new().mode(0o700).create(dir) {
		Ok(()) => {},
		Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {},
		Err(error) => return Err(IpcError::io(&error, &format!("create {}", dir.display()))),
	}
	let meta = fs::symlink_metadata(dir)
		.map_err(|error| IpcError::io(&error, &format!("stat {}", dir.display())))?;
	let owned = tighten_owned_dir(dir, &meta)
		.map_err(|error| IpcError::io(&error, &format!("chmod {}", dir.display())))?;
	if !owned {
		return Err(IpcError::new(
			"EACCES",
			format!("{} is not a directory owned by uid {euid}", dir.display()),
		));
	}
	Ok(())
}

/// Make `dir` owner-only (chmod 0700) when it is a directory we own.
///
/// `meta` is `dir`'s `symlink_metadata`, so a link is not a directory.
/// Returns `false`, changing nothing, when `dir` is not a directory owned by
/// our effective uid.
pub fn tighten_owned_dir(dir: &Path, meta: &fs::Metadata) -> io::Result<bool> {
	if !meta.file_type().is_dir() || meta.uid() != euid() {
		return Ok(false);
	}
	if meta.mode() & 0o077 != 0 {
		fs::set_permissions(dir, Permissions::from_mode(0o700))?;
	}
	Ok(true)
}

/// Remove a dead Unix socket and its `.bind.lock` while holding that lock.
///
/// Only inside a private directory (a real directory owned by us without
/// group/other access: e.g. an instance registry, or the `/tmp/omp-<euid>`
/// relocation directory, which another user could have re-created after a
/// reboot). A live listener holds the lock for its whole life ([`Listener`]),
/// so taking it proves the socket dead; a held lock means live (or a binder)
/// and the socket is kept. No connect is attempted: a live listener with a
/// full accept backlog refuses (macOS/BSD) or blocks (Linux) a connect. The
/// lock must still be the file at its path (a lock taken on a file unlinked
/// meanwhile excludes nobody). A lock file this sweep created is removed
/// again; a pre-existing one only once `lock_grace` old, since a binder may
/// have just created it and not locked it yet.
pub fn sweep_stale(socket: &Path, lock_grace: Duration) {
	if !socket.parent().is_some_and(is_private_dir) {
		return;
	}
	let lock_path = bind_lock_path(socket);
	let open = |create: bool| bind_lock_options().create_new(create).open(&lock_path);
	let (lock, created) = match open(true) {
		Ok(lock) => (lock, true),
		Err(error) if error.kind() == io::ErrorKind::AlreadyExists => match open(false) {
			Ok(lock) => (lock, false),
			Err(_) => return,
		},
		Err(_) => return,
	};
	if !matches!(try_lock_at(&lock, &lock_path), Ok(LockAttempt::Locked)) {
		// A binder holds it (or opened the file we just created), or it was
		// unlinked or replaced since we opened it: not ours to judge.
		return;
	}
	// Under the lock no listener owns the socket: any socket there is dead.
	let dead = match fs::symlink_metadata(socket) {
		Err(error) => error.kind() == io::ErrorKind::NotFound,
		Ok(meta) if meta.file_type().is_socket() => fs::remove_file(socket).is_ok(),
		Ok(_) => false,
	};
	let lock_aged = || {
		lock
			.metadata()
			.ok()
			.and_then(|meta| meta.modified().ok())
			.and_then(|modified| modified.elapsed().ok())
			.is_some_and(|age| age >= lock_grace)
	};
	if created || (dead && lock_aged()) {
		let _ = fs::remove_file(&lock_path);
	}
}

/// Whether a listener owns the Unix socket at `socket`, from its bind lock.
///
/// A live [`Listener`] holds `<socket>.bind.lock` for its whole life, and the
/// kernel drops the lock with the process. Never connects, never creates or
/// removes anything.
///
/// `Some(true)`: the lock is held (a live listener, or a binder about to be
/// one). `Some(false)`: the lock file is missing, or we took the lock on the
/// file at its path. `None`: unknown (the lock could not be opened or taken,
/// or was replaced while we checked).
pub fn endpoint_is_live(socket: &Path) -> Option<bool> {
	let lock_path = bind_lock_path(socket);
	let lock = match bind_lock_options().open(&lock_path) {
		Ok(lock) => lock,
		Err(error) if error.kind() == io::ErrorKind::NotFound => return Some(false),
		Err(_) => return None,
	};
	match try_lock_at(&lock, &lock_path) {
		Ok(LockAttempt::Locked) => Some(false),
		Ok(LockAttempt::Held) => Some(true),
		Ok(LockAttempt::Replaced) | Err(_) => None,
	}
}

/// What [`try_lock_at`] found.
enum LockAttempt {
	/// We hold the exclusive lock on the file at the lock path.
	Locked,
	/// Someone else holds it.
	Held,
	/// The open file is no longer the one at the lock path (unlinked or
	/// replaced meanwhile): a lock on it would exclude nobody.
	Replaced,
}

/// Try the exclusive flock on `lock`, opened from `lock_path`, without
/// waiting, and check it is still the file at that path.
fn try_lock_at(lock: &fs::File, lock_path: &Path) -> io::Result<LockAttempt> {
	let locked = loop {
		match lock.try_lock() {
			Ok(()) => break true,
			Err(fs::TryLockError::WouldBlock) => break false,
			Err(fs::TryLockError::Error(error)) if error.kind() == io::ErrorKind::Interrupted => {},
			Err(fs::TryLockError::Error(error)) => return Err(error),
		}
	};
	Ok(match (is_same_file(lock, lock_path), locked) {
		(false, _) => LockAttempt::Replaced,
		(true, true) => LockAttempt::Locked,
		(true, false) => LockAttempt::Held,
	})
}

/// Whether `dir` is a real directory (not a link) owned by our effective uid
/// with no group/other access. Check-only: nothing is created or changed.
pub fn is_private_dir(dir: &Path) -> bool {
	fs::symlink_metadata(dir).is_ok_and(|meta| {
		meta.file_type().is_dir() && meta.uid() == euid() && meta.mode() & 0o077 == 0
	})
}

/// Whether the open `file` is still the file at `path` (same device and
/// inode, `path` not a link): a lock held on a file unlinked or replaced
/// meanwhile guards nothing.
pub fn is_same_file(file: &fs::File, path: &Path) -> bool {
	match (file.metadata(), fs::symlink_metadata(path)) {
		(Ok(open), Ok(named)) => open.dev() == named.dev() && open.ino() == named.ino(),
		_ => false,
	}
}

/// Dial `endpoint` and verify the server runs as our effective uid.
pub async fn connect(endpoint: &str, _timeout: Duration) -> Result<Stream, IpcError> {
	let stream = UnixStream::connect(endpoint)
		.await
		.map_err(|error| IpcError::io(&error, &format!("connect {endpoint}")))?;
	let cred = stream
		.peer_cred()
		.map_err(|error| IpcError::io(&error, "read peer credentials"))?;
	let euid = euid();
	if cred.uid() != euid {
		return Err(IpcError::foreign_peer(format!(
			"{endpoint} is served by uid {}, expected {euid}",
			cred.uid()
		)));
	}
	Ok(Stream(stream))
}

/// How [`Stream::finish_write`] left the stream.
pub enum WriteFinish {
	/// Write side shut; reading continues until EOF.
	HalfClosed,
	/// The whole stream must be dropped now.
	Closed,
}

/// Connected socket whose peer runs as our effective uid. Only
/// [`Listener::accept`] and [`connect`] create one.
pub struct Stream(UnixStream);

impl Stream {
	pub async fn readable(&self) -> io::Result<()> {
		self.0.readable().await
	}

	/// Read into `buf`'s spare capacity without initializing it first.
	pub fn try_read_buf(&self, buf: &mut Vec<u8>) -> io::Result<usize> {
		self.0.try_read_buf(buf)
	}

	pub async fn writable(&self) -> io::Result<()> {
		self.0.writable().await
	}

	pub fn try_write_vectored(&self, bufs: &[IoSlice<'_>]) -> io::Result<usize> {
		self.0.try_write_vectored(bufs)
	}

	/// Shut the write half; the peer reads EOF after the queued bytes.
	pub fn finish_write(&self) -> io::Result<WriteFinish> {
		// SAFETY: the descriptor is owned by `self.0` and live for this call.
		if unsafe { libc::shutdown(self.0.as_raw_fd(), libc::SHUT_WR) } != 0 {
			return Err(io::Error::last_os_error());
		}
		Ok(WriteFinish::HalfClosed)
	}
}

impl AsyncRead for Stream {
	fn poll_read(
		self: Pin<&mut Self>,
		cx: &mut Context<'_>,
		buf: &mut ReadBuf<'_>,
	) -> Poll<io::Result<()>> {
		Pin::new(&mut self.get_mut().0).poll_read(cx, buf)
	}
}

/// `shutdown` shuts the write half (`SHUT_WR`); the peer reads EOF while this
/// side keeps reading.
impl AsyncWrite for Stream {
	fn poll_write(
		self: Pin<&mut Self>,
		cx: &mut Context<'_>,
		buf: &[u8],
	) -> Poll<io::Result<usize>> {
		Pin::new(&mut self.get_mut().0).poll_write(cx, buf)
	}

	fn poll_write_vectored(
		self: Pin<&mut Self>,
		cx: &mut Context<'_>,
		bufs: &[IoSlice<'_>],
	) -> Poll<io::Result<usize>> {
		Pin::new(&mut self.get_mut().0).poll_write_vectored(cx, bufs)
	}

	fn is_write_vectored(&self) -> bool {
		self.0.is_write_vectored()
	}

	fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		Pin::new(&mut self.get_mut().0).poll_flush(cx)
	}

	fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		Pin::new(&mut self.get_mut().0).poll_shutdown(cx)
	}
}

#[cfg(test)]
mod tests {
	use std::os::unix::net::UnixStream as StdUnixStream;

	use super::*;

	/// A socket path in a fresh private (0700) temp dir.
	fn private_socket(name: &str) -> (tempfile::TempDir, PathBuf) {
		let dir = tempfile::tempdir().unwrap();
		fs::set_permissions(dir.path(), Permissions::from_mode(0o700)).unwrap();
		let socket = dir.path().join(name);
		(dir, socket)
	}

	/// Shrink `listener`'s accept backlog to one, then queue non-blocking
	/// connects on `path` until the kernel refuses one (macOS/BSD:
	/// ECONNREFUSED) or reports a full queue (Linux: EAGAIN): the backlog is
	/// then full. The sockets keep it full; there are only a few of them.
	fn fill_backlog(listener: &Listener, path: &Path) -> Vec<OwnedFd> {
		// SAFETY: a listening socket's fd; re-listen only updates its backlog.
		assert_eq!(unsafe { libc::listen(listener.listener.as_raw_fd(), 1) }, 0);
		let mut queued = Vec::new();
		for _ in 0..16 {
			match connect_nonblocking(path) {
				Ok(socket) => queued.push(socket),
				Err(error) => {
					assert!(
						matches!(error.raw_os_error(), Some(libc::ECONNREFUSED | libc::EAGAIN)),
						"unexpected connect error: {error}"
					);
					return queued;
				},
			}
		}
		panic!("backlog never filled");
	}

	#[tokio::test]
	async fn a_live_listener_with_a_full_backlog_is_never_swept() {
		let (_dir, socket) = private_socket("full.sock");
		let (listener, bound) = listen(socket.to_str().unwrap()).await.unwrap();
		let _queued = fill_backlog(&listener, &socket);

		let started = Instant::now();
		sweep_stale(&socket, Duration::ZERO);
		assert!(started.elapsed() < Duration::from_secs(2), "sweep must not wait on the listener");
		assert!(socket.exists(), "a live listener's socket was swept");
		assert!(bind_lock_path(&socket).exists(), "a live listener's bind lock was swept");

		// Nor may a binder take the endpoint over.
		let error = listen(socket.to_str().unwrap())
			.await
			.err()
			.expect("bind over a live listener must fail");
		assert_eq!(error.code(), "EADDRINUSE", "{error}");
		assert!(socket.exists());
		release(bound);
	}

	#[tokio::test]
	async fn a_socket_whose_listener_is_gone_is_swept() {
		let (_dir, socket) = private_socket("gone.sock");
		let (listener, _bound) = listen(socket.to_str().unwrap()).await.unwrap();
		// Closed without unlinking, as after a crash.
		drop(listener);
		assert!(socket.exists());

		sweep_stale(&socket, Duration::ZERO);
		assert!(!socket.exists(), "a dead socket was kept");
		assert!(!bind_lock_path(&socket).exists(), "an aged lock of a dead socket was kept");
	}

	#[tokio::test]
	async fn a_dropped_listener_endpoint_can_be_bound_again_in_process() {
		let (_dir, socket) = private_socket("again.sock");
		let endpoint = socket.to_str().unwrap();
		// Released cleanly.
		let (listener, bound) = listen(endpoint).await.unwrap();
		drop(listener);
		release(bound);
		// Closed without unlinking: the stale socket is replaced.
		let (listener, _stale) = listen(endpoint).await.unwrap();
		drop(listener);
		let (_listener, bound) = listen(endpoint).await.unwrap();
		StdUnixStream::connect(&socket).expect("the new listener answers");
		release(bound);
		assert!(!socket.exists());
	}

	#[tokio::test]
	async fn endpoint_liveness_is_the_held_bind_lock() {
		let (_dir, socket) = private_socket("probe.sock");
		assert_eq!(endpoint_is_live(&socket), Some(false), "no lock file: nothing listens");
		let (listener, bound) = listen(socket.to_str().unwrap()).await.unwrap();
		let _queued = fill_backlog(&listener, &socket);
		assert_eq!(endpoint_is_live(&socket), Some(true), "a live listener refusing connects");
		drop(listener);
		assert_eq!(endpoint_is_live(&socket), Some(false), "closed listener, lock left behind");
		assert!(bind_lock_path(&socket).exists() && socket.exists(), "the probe removes nothing");
		release(bound);
	}

	#[tokio::test]
	async fn a_live_foreign_listener_without_the_bind_lock_keeps_its_socket() {
		let (_dir, socket) = private_socket("foreign.sock");
		// Another program (or an older build) serving the path, lock untaken.
		let foreign = std::os::unix::net::UnixListener::bind(&socket).unwrap();
		let error = listen(socket.to_str().unwrap())
			.await
			.err()
			.expect("bind over an answering listener must fail");
		assert_eq!(error.code(), "EADDRINUSE", "{error}");
		StdUnixStream::connect(&socket).expect("the foreign listener still answers");
		drop(foreign);
		// Once it stops answering the socket file is stale and replaced.
		let (_listener, bound) = listen(socket.to_str().unwrap()).await.unwrap();
		release(bound);
	}

	/// Linux reports a full backlog EAGAIN rather than refusing: a foreign
	/// listener in that state is still live and keeps its socket.
	#[cfg(target_os = "linux")]
	#[tokio::test]
	async fn a_foreign_listener_with_a_full_backlog_keeps_its_socket() {
		let (_dir, socket) = private_socket("foreign-full.sock");
		let foreign = std::os::unix::net::UnixListener::bind(&socket).unwrap();
		// SAFETY: a listening socket's fd; re-listen only updates its backlog.
		assert_eq!(unsafe { libc::listen(foreign.as_raw_fd(), 1) }, 0);
		let mut queued = Vec::new();
		let full = loop {
			match connect_nonblocking(&socket) {
				Ok(stream) if queued.len() < 16 => queued.push(stream),
				Ok(_) => panic!("backlog never filled"),
				Err(error) => break error,
			}
		};
		assert_eq!(full.raw_os_error(), Some(libc::EAGAIN), "{full}");
		let error = listen(socket.to_str().unwrap())
			.await
			.err()
			.expect("bind over a live listener must fail");
		assert_eq!(error.code(), "EADDRINUSE", "{error}");
		assert!(socket.exists());
	}

	#[tokio::test]
	async fn a_binder_waits_out_a_briefly_held_bind_lock() {
		let (_dir, socket) = private_socket("contended.sock");
		let lock = bind_lock_options()
			.create(true)
			.truncate(false)
			.open(bind_lock_path(&socket))
			.unwrap();
		lock.lock().unwrap();
		// A sweeper or liveness probe lets go after a moment.
		let sweeper = std::thread::spawn(move || {
			std::thread::sleep(Duration::from_millis(50));
			drop(lock);
		});
		let (_listener, bound) = listen(socket.to_str().unwrap()).await.unwrap();
		sweeper.join().unwrap();
		release(bound);
	}
}
