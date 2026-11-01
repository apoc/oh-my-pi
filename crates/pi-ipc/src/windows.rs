//! Windows named-pipe transport.

use std::{
	ffi::c_void,
	io::{self, IoSlice},
	os::windows::io::{AsHandle, AsRawHandle, FromRawHandle, OwnedHandle},
	pin::Pin,
	task::{Context, Poll},
	time::Duration,
};

use tokio::{
	io::{AsyncRead, AsyncWrite, ReadBuf},
	net::windows::named_pipe::{
		ClientOptions, NamedPipeClient, NamedPipeServer, PipeMode, ServerOptions,
	},
	time::Instant,
};
use windows_sys::Win32::{
	Foundation::{
		ERROR_ACCESS_DENIED, ERROR_BAD_PATHNAME, ERROR_BROKEN_PIPE, ERROR_FILE_NOT_FOUND,
		ERROR_INVALID_NAME, ERROR_INVALID_PARAMETER, ERROR_NETNAME_DELETED, ERROR_NO_DATA,
		ERROR_NOT_ENOUGH_MEMORY, ERROR_OPERATION_ABORTED, ERROR_OUTOFMEMORY, ERROR_PATH_NOT_FOUND,
		ERROR_PIPE_BUSY, ERROR_PIPE_NOT_CONNECTED, ERROR_SEM_TIMEOUT, ERROR_TOO_MANY_OPEN_FILES,
		HANDLE,
	},
	Security::EqualSid,
	System::{
		Pipes::GetNamedPipeServerProcessId,
		Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
	},
};

use crate::{
	IpcError,
	winsec::{Descriptor, current_user, process_user},
};

/// Delay between `ERROR_PIPE_BUSY` retries while every instance is taken.
const BUSY_RETRY: Duration = Duration::from_millis(20);

/// Errno-style name for a raw Win32 error.
pub const fn os_error_code(code: i32) -> Option<&'static str> {
	Some(match code as u32 {
		ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => "ENOENT",
		ERROR_ACCESS_DENIED => "EACCES",
		ERROR_PIPE_BUSY => "EBUSY",
		ERROR_BROKEN_PIPE | ERROR_NO_DATA => "EPIPE",
		ERROR_PIPE_NOT_CONNECTED => "ENOTCONN",
		ERROR_SEM_TIMEOUT => "ETIMEDOUT",
		ERROR_INVALID_NAME | ERROR_BAD_PATHNAME | ERROR_INVALID_PARAMETER => "EINVAL",
		ERROR_NOT_ENOUGH_MEMORY | ERROR_OUTOFMEMORY => "ENOMEM",
		ERROR_TOO_MANY_OPEN_FILES => "EMFILE",
		ERROR_NETNAME_DELETED => "ECONNRESET",
		ERROR_OPERATION_ABORTED => "ECANCELED",
		_ => return None,
	})
}

/// A peer that closed its pipe handle surfaces as a broken/disconnected pipe,
/// which is the named-pipe spelling of EOF.
pub fn is_orderly_eof(error: &io::Error) -> bool {
	matches!(
		error.raw_os_error().map(|code| code as u32),
		Some(ERROR_BROKEN_PIPE | ERROR_PIPE_NOT_CONNECTED | ERROR_NO_DATA)
	)
}

/// Security descriptor granting the pipe to the current user only.
fn pipe_security() -> io::Result<Descriptor> {
	let sid = current_user()?.sid_string()?;
	Descriptor::from_sddl(&format!("D:P(A;;GA;;;{sid})"))
}

fn create_instance(security: &Descriptor, name: &str, first: bool) -> io::Result<NamedPipeServer> {
	let mut options = ServerOptions::new();
	options
		.first_pipe_instance(first)
		.reject_remote_clients(true)
		.pipe_mode(PipeMode::Byte);
	let attributes = security.attributes();
	// SAFETY: `attributes` points at `security`'s descriptor, alive for this
	// call; Win32 copies it during creation.
	unsafe {
		options.create_with_security_attributes_raw(
			name,
			(&raw const attributes).cast_mut().cast::<c_void>(),
		)
	}
}

/// Named pipes leave nothing on disk to clean up.
pub struct Bound(());

#[allow(clippy::needless_pass_by_value, reason = "consumes the bound endpoint like Unix")]
pub const fn release(_bound: Bound) {}

/// Pipe server keeping one pending instance for the next client.
pub struct Listener {
	name:     String,
	security: Descriptor,
	pending:  Option<NamedPipeServer>,
}

impl Listener {
	/// Next connected client; immediately re-arms a pending instance.
	pub async fn accept(&mut self) -> io::Result<Stream> {
		let pending = match self.pending.take() {
			Some(pending) => pending,
			None => create_instance(&self.security, &self.name, false)?,
		};
		let pending = self.pending.insert(pending);
		let connected = pending.connect().await;
		let instance = self.pending.take();
		self.pending = create_instance(&self.security, &self.name, false).ok();
		connected?;
		instance
			.map(|pipe| Stream(Inner::Server(pipe)))
			.ok_or_else(|| io::ErrorKind::NotConnected.into())
	}
}

/// Create the first instance of `endpoint` (existing instance: EADDRINUSE).
///
/// Remote clients are rejected and the DACL grants only the current user.
/// Requires a Tokio runtime (the pipe registers with its reactor).
#[allow(clippy::unused_async, reason = "async on Unix; one shared call shape")]
pub async fn listen(endpoint: &str) -> Result<(Listener, Bound), IpcError> {
	let security =
		pipe_security().map_err(|error| IpcError::io(&error, "build pipe security descriptor"))?;
	let first = create_instance(&security, endpoint, true).map_err(|error| {
		match error.raw_os_error().map(|code| code as u32) {
			Some(ERROR_ACCESS_DENIED | ERROR_PIPE_BUSY) => {
				IpcError::new("EADDRINUSE", format!("{endpoint} already has a listener"))
			},
			_ => IpcError::io(&error, &format!("create {endpoint}")),
		}
	})?;
	Ok((Listener { name: endpoint.to_owned(), security, pending: Some(first) }, Bound(())))
}

/// Dial `endpoint` and verify the server process runs as our user.
///
/// `ERROR_PIPE_BUSY` is retried until `timeout`; that is all `timeout`
/// bounds. Wrap the call in `tokio::time::timeout` for a full deadline.
pub async fn connect(endpoint: &str, timeout: Duration) -> Result<Stream, IpcError> {
	let deadline = Instant::now() + timeout;
	let client = loop {
		match ClientOptions::new().open(endpoint) {
			Ok(client) => break client,
			Err(error) if error.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) => {
				let now = Instant::now();
				if now >= deadline {
					return Err(IpcError::new(
						"ETIMEDOUT",
						format!("{endpoint} stayed busy for {} ms", timeout.as_millis()),
					));
				}
				tokio::time::sleep(BUSY_RETRY.min(deadline - now)).await;
			},
			Err(error) => return Err(IpcError::io(&error, &format!("connect {endpoint}"))),
		}
	};
	verify_server_user(client.as_raw_handle(), endpoint)?;
	Ok(Stream(Inner::Client(client)))
}

/// Process id of the server end of the client pipe `pipe`.
fn server_process_id(pipe: HANDLE) -> io::Result<u32> {
	let mut pid = 0u32;
	// SAFETY: `pipe` is a live client pipe handle; `pid` a valid out pointer.
	if unsafe { GetNamedPipeServerProcessId(pipe, &mut pid) } == 0 {
		return Err(io::Error::last_os_error());
	}
	Ok(pid)
}

fn verify_server_user(pipe: HANDLE, endpoint: &str) -> Result<(), IpcError> {
	let pid =
		server_process_id(pipe).map_err(|error| IpcError::io(&error, "query pipe server process"))?;
	// SAFETY: plain OpenProcess call; the result is checked before use.
	let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
	if raw.is_null() {
		return Err(IpcError::io(&io::Error::last_os_error(), "open pipe server process"));
	}
	// SAFETY: `OpenProcess` returned a fresh handle we now own.
	let process = unsafe { OwnedHandle::from_raw_handle(raw) };
	let server = process_user(process.as_handle())
		.map_err(|error| IpcError::io(&error, "read pipe server token"))?;
	let ours = current_user().map_err(|error| IpcError::io(&error, "read own token"))?;
	// SAFETY: both SIDs point into live token buffers.
	if unsafe { EqualSid(server.sid(), ours.sid()) } == 0 {
		return Err(IpcError::foreign_peer(format!(
			"{endpoint} is served by a process of another user"
		)));
	}
	Ok(())
}

/// How [`Stream::finish_write`] left the stream.
pub enum WriteFinish {
	/// Write side shut; reading continues until EOF.
	HalfClosed,
	/// The whole stream must be dropped now.
	Closed,
}

/// Connected pipe end whose peer runs as our user. Only [`Listener::accept`]
/// and [`connect`] create one.
pub struct Stream(Inner);

enum Inner {
	Server(NamedPipeServer),
	Client(NamedPipeClient),
}

impl Stream {
	/// Process id of the pipe server, for matching a dialed endpoint against
	/// the pid a registry entry recorded. Not an identity proof: pids are
	/// reused (the user check in [`connect`] is the security boundary). Only
	/// a dialed (client) end knows it; an accepted end reports
	/// `ErrorKind::Unsupported`.
	pub fn server_pid(&self) -> io::Result<u32> {
		match &self.0 {
			Inner::Client(pipe) => server_process_id(pipe.as_raw_handle()),
			Inner::Server(_) => Err(io::Error::new(
				io::ErrorKind::Unsupported,
				"server_pid is only known on a dialed pipe",
			)),
		}
	}

	pub async fn readable(&self) -> io::Result<()> {
		match &self.0 {
			Inner::Server(pipe) => pipe.readable().await,
			Inner::Client(pipe) => pipe.readable().await,
		}
	}

	/// Read into `buf`'s spare capacity without initializing it first.
	pub fn try_read_buf(&self, buf: &mut Vec<u8>) -> io::Result<usize> {
		match &self.0 {
			Inner::Server(pipe) => pipe.try_read_buf(buf),
			Inner::Client(pipe) => pipe.try_read_buf(buf),
		}
	}

	pub async fn writable(&self) -> io::Result<()> {
		match &self.0 {
			Inner::Server(pipe) => pipe.writable().await,
			Inner::Client(pipe) => pipe.writable().await,
		}
	}

	pub fn try_write_vectored(&self, bufs: &[IoSlice<'_>]) -> io::Result<usize> {
		match &self.0 {
			Inner::Server(pipe) => pipe.try_write_vectored(bufs),
			Inner::Client(pipe) => pipe.try_write_vectored(bufs),
		}
	}

	/// Pipes have no half-close: the caller drops the handle. Dropping keeps
	/// in-flight overlapped writes running (mio only cancels reads), and
	/// closing — unlike `DisconnectNamedPipe` — leaves unread data readable
	/// by the peer before it sees the broken pipe.
	#[allow(
		clippy::unnecessary_wraps,
		clippy::unused_self,
		reason = "fallible half-close on Unix; one shared call shape"
	)]
	pub const fn finish_write(&self) -> io::Result<WriteFinish> {
		Ok(WriteFinish::Closed)
	}
}

impl AsyncRead for Stream {
	fn poll_read(
		self: Pin<&mut Self>,
		cx: &mut Context<'_>,
		buf: &mut ReadBuf<'_>,
	) -> Poll<io::Result<()>> {
		match &mut self.get_mut().0 {
			Inner::Server(pipe) => Pin::new(pipe).poll_read(cx, buf),
			Inner::Client(pipe) => Pin::new(pipe).poll_read(cx, buf),
		}
	}
}

/// Pipes have no half-close: `shutdown` only flushes, and the peer reads EOF
/// once this stream is dropped (see [`WriteFinish::Closed`]).
impl AsyncWrite for Stream {
	fn poll_write(
		self: Pin<&mut Self>,
		cx: &mut Context<'_>,
		buf: &[u8],
	) -> Poll<io::Result<usize>> {
		match &mut self.get_mut().0 {
			Inner::Server(pipe) => Pin::new(pipe).poll_write(cx, buf),
			Inner::Client(pipe) => Pin::new(pipe).poll_write(cx, buf),
		}
	}

	fn poll_write_vectored(
		self: Pin<&mut Self>,
		cx: &mut Context<'_>,
		bufs: &[IoSlice<'_>],
	) -> Poll<io::Result<usize>> {
		match &mut self.get_mut().0 {
			Inner::Server(pipe) => Pin::new(pipe).poll_write_vectored(cx, bufs),
			Inner::Client(pipe) => Pin::new(pipe).poll_write_vectored(cx, bufs),
		}
	}

	fn is_write_vectored(&self) -> bool {
		match &self.0 {
			Inner::Server(pipe) => pipe.is_write_vectored(),
			Inner::Client(pipe) => pipe.is_write_vectored(),
		}
	}

	fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		match &mut self.get_mut().0 {
			Inner::Server(pipe) => Pin::new(pipe).poll_flush(cx),
			Inner::Client(pipe) => Pin::new(pipe).poll_flush(cx),
		}
	}

	fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		match &mut self.get_mut().0 {
			Inner::Server(pipe) => Pin::new(pipe).poll_shutdown(cx),
			Inner::Client(pipe) => Pin::new(pipe).poll_shutdown(cx),
		}
	}
}
