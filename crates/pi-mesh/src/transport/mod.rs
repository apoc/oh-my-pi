//! Request/response transports: one connection per request, one frame each
//! way ([`crate::frame`]).
//!
//! Connections are Unix sockets or named pipes locally and TCP on the LAN.
//! Both transports speak the same sealed protocol ([`sealed`]) and differ only
//! in the key and the endpoint:
//!
//! - [`local`]: same-machine listener on a Unix socket inside the owner-only
//!   registry directory, or a current-user-only named pipe on Windows, so other
//!   accounts cannot even connect; key derived from the bearer token in the
//!   registry (the token never travels).
//! - [`lan`]: LAN listener; key derived from the shared mesh key.
//!
//! Response frame payload: `[status byte][body]`. Only [`STATUS_OK`] carries a
//! body (a sealed [`MeshResponse`]). The other statuses answer requests that
//! never authenticated and reveal nothing secret: [`STATUS_REJECTED`] (bad
//! key, or a malformed pre-auth frame), [`STATUS_MISDIRECTED`] (the endpoint
//! now serves another instance), [`STATUS_TOO_LARGE`] (request frame over the
//! cap), [`STATUS_BUSY`] (connection limits reached). They are not
//! authenticated, so an on-path attacker can forge them (denial of service
//! only).

pub mod lan;
pub mod local;
mod sealed;
#[cfg(test)]
mod tests;

use std::{
	collections::HashMap,
	future::Future,
	io,
	net::{IpAddr, SocketAddr},
	pin::Pin,
	sync::Arc,
	time::Duration,
};

use parking_lot::Mutex;
use tokio::{
	io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
	net::{TcpListener, TcpStream},
	sync::Semaphore,
	task::{JoinHandle, JoinSet},
};

use crate::{
	error::FrameError,
	frame::{MAX_FRAME_BYTES, read_frame, write_frame},
	keys::{MeshKeys, SealKey},
	protocol::{MAX_ENVELOPE_BYTES, MeshEnvelope, MeshErrorCode, MeshResponse},
};

pub const STATUS_OK: u8 = 0;
pub const STATUS_REJECTED: u8 = 1;
pub const STATUS_MISDIRECTED: u8 = 2;
pub const STATUS_TOO_LARGE: u8 = 3;
pub const STATUS_BUSY: u8 = 4;

/// Deadline for a peer to deliver its whole request frame.
pub const REQUEST_READ_TIMEOUT: Duration = Duration::from_secs(10);
/// Deadline for a peer to take our whole response frame.
pub const RESPONSE_WRITE_TIMEOUT: Duration = Duration::from_secs(10);
/// Upper bound on one [`InboundSink::handle`] call; past it the peer gets
/// `internal`.
pub const HANDLER_TIMEOUT: Duration = Duration::from_secs(60);
/// Concurrent connections per listener; further connections get
/// [`STATUS_BUSY`].
pub const MAX_CONNECTIONS: usize = 64;
/// Concurrent connections per source IP on the LAN listener, counted before a
/// global slot is taken, so one host cannot occupy every slot. Not applied
/// on loopback, where every peer shares 127.0.0.1.
pub const MAX_CONNECTIONS_PER_IP: usize = 8;

/// Where a peer listens.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Endpoint {
	/// Same machine: Unix socket path or Windows pipe name, bearer token (64
	/// hex chars) and owner pid, all from the registry. On Windows a pipe
	/// served by another process is treated as misdirected.
	Local { path: String, token: String, pid: u32 },
	/// LAN listener; needs the mesh key.
	Remote { addr: SocketAddr },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum OriginKind {
	Local,
	Remote,
}

/// Which listener accepted an inbound envelope, and the connection's source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Origin {
	pub kind: OriginKind,
	/// TCP source address; always `Some` for [`OriginKind::Remote`], `None`
	/// for local (Unix socket / named pipe) connections.
	pub addr: Option<SocketAddr>,
}

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

/// Receives every authenticated, validated envelope addressed to this
/// instance (or `*` + `snapshot`).
///
/// Transports already checked: key, envelope shape and caps, recipient, and
/// the replay window. Everything else — hop, blocked senders, rate limits,
/// dispatch — is the sink's job.
pub trait InboundSink: Send + Sync + 'static {
	fn handle(&self, envelope: MeshEnvelope, origin: Origin) -> BoxFuture<MeshResponse>;
}

/// Client-side delivery failure.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TransportError {
	#[error("unreachable: {0}")]
	Unreachable(String),
	/// The endpoint answers for another instance (stale discovery entry or
	/// reused port).
	#[error("unreachable: mesh endpoint now serves another instance")]
	Misdirected,
	#[error("timeout: mesh peer did not answer in time")]
	Timeout,
	#[error("bad_response: {0}")]
	BadResponse(String),
}

impl TransportError {
	/// Stable code for the N-API rejection prefix.
	pub const fn code(&self) -> &'static str {
		match self {
			Self::Unreachable(_) | Self::Misdirected => "unreachable",
			Self::Timeout => "timeout",
			Self::BadResponse(_) => "bad_response",
		}
	}
}

/// Sends envelopes to local and remote endpoints. Cheap to clone; rebuild
/// when the mesh key changes.
#[derive(Debug, Clone, Default)]
pub struct MeshClient {
	keys: Option<Arc<MeshKeys>>,
}

impl MeshClient {
	/// `keys` is required for [`Endpoint::Remote`].
	pub const fn new(keys: Option<Arc<MeshKeys>>) -> Self {
		Self { keys }
	}

	/// Deliver one envelope and wait for its response, all within `timeout`
	/// (connect, send, the peer's handler, response). Drop the future to
	/// abort.
	///
	/// Envelopes over [`MAX_ENVELOPE_BYTES`] resolve to `too_large` without
	/// contacting the peer; a peer rejecting our key resolves to
	/// `unauthorized`; a full peer to `busy`.
	///
	/// # Errors
	/// [`TransportError`] when no valid response arrived.
	pub async fn request(
		&self,
		endpoint: &Endpoint,
		envelope: &MeshEnvelope,
		timeout: Duration,
	) -> Result<MeshResponse, TransportError> {
		let json = serde_json::to_vec(envelope)
			.map_err(|e| TransportError::BadResponse(format!("cannot encode envelope: {e}")))?;
		if json.len() > MAX_ENVELOPE_BYTES {
			return Ok(MeshResponse::error(
				MeshErrorCode::TooLarge,
				format!("mesh envelope exceeds {MAX_ENVELOPE_BYTES} bytes"),
			));
		}
		tokio::time::timeout(timeout, async {
			match endpoint {
				Endpoint::Local { path, token, pid } => {
					let token = local::parse_token(token).ok_or_else(|| {
						TransportError::Unreachable("malformed local mesh token".into())
					})?;
					let key = SealKey::for_local_token(&token);
					let stream = local::connect(path, *pid).await?;
					sealed::request(stream, &key, envelope, &json).await
				},
				Endpoint::Remote { addr } => {
					let keys = self.keys.as_deref().ok_or_else(|| {
						TransportError::Unreachable("remote mesh side has no key".into())
					})?;
					sealed::request(connect(*addr).await?, keys.seal_key(), envelope, &json).await
				},
			}
		})
		.await
		.map_err(|_| TransportError::Timeout)?
	}
}

async fn connect(addr: SocketAddr) -> Result<TcpStream, TransportError> {
	let stream = TcpStream::connect(addr)
		.await
		.map_err(|e| TransportError::Unreachable(format!("cannot connect to {addr}: {e}")))?;
	// Best effort: one small frame each way.
	let _ = stream.set_nodelay(true);
	Ok(stream)
}

/// Send one request frame and read the status-tagged response frame.
/// Returns the whole frame (status byte first) for [`STATUS_OK`], and
/// `Ok(Err(response))` for statuses that map to a [`MeshResponse`].
async fn exchange<S: Conn>(
	stream: &mut S,
	request: &[u8],
	max_response: usize,
) -> Result<Result<Vec<u8>, MeshResponse>, TransportError> {
	let lost = |e: FrameError| TransportError::Unreachable(format!("mesh connection failed: {e}"));
	write_frame(stream, request, usize::MAX)
		.await
		.map_err(lost)?;
	let frame = match read_frame(stream, max_response).await {
		Ok(Some(frame)) => frame,
		Ok(None) => {
			return Err(TransportError::BadResponse("mesh peer closed without answering".into()));
		},
		Err(e @ FrameError::TooLarge { .. }) => {
			return Err(TransportError::BadResponse(e.to_string()));
		},
		Err(e) => return Err(lost(e)),
	};
	let _ = stream.shutdown().await;
	match frame.first().copied() {
		Some(STATUS_OK) => Ok(Ok(frame)),
		Some(STATUS_REJECTED) => Ok(Err(MeshResponse::error(
			MeshErrorCode::Unauthorized,
			"mesh peer rejected our credentials",
		))),
		Some(STATUS_MISDIRECTED) => Err(TransportError::Misdirected),
		Some(STATUS_TOO_LARGE) => Ok(Err(MeshResponse::error(
			MeshErrorCode::TooLarge,
			"mesh peer rejected an oversized request",
		))),
		Some(STATUS_BUSY) => Ok(Err(MeshResponse::error(
			MeshErrorCode::Busy,
			"mesh peer has too many open connections",
		))),
		Some(other) => {
			Err(TransportError::BadResponse(format!("unknown mesh response status {other}")))
		},
		None => Err(TransportError::BadResponse("empty mesh response frame".into())),
	}
}

/// Serialize a handler result for the wire; an oversized one degrades to
/// `too_large`.
fn encode_response(response: &MeshResponse) -> Vec<u8> {
	if let MeshResponse::OkRaw(json) = response
		&& json.len() + 20 <= MAX_ENVELOPE_BYTES
	{
		return [&br#"{"ok":true,"data":"#[..], json.as_bytes(), b"}"].concat();
	}
	match serde_json::to_vec(response) {
		Ok(bytes) if bytes.len() <= MAX_ENVELOPE_BYTES => bytes,
		Ok(_) => serde_json::to_vec(&MeshResponse::error(
			MeshErrorCode::TooLarge,
			format!("mesh response exceeds {MAX_ENVELOPE_BYTES} bytes"),
		))
		.unwrap_or_default(),
		Err(_) => serde_json::to_vec(&MeshResponse::error(MeshErrorCode::Internal, "internal error"))
			.unwrap_or_default(),
	}
}

/// Run the sink with [`HANDLER_TIMEOUT`].
async fn dispatch(sink: &dyn InboundSink, envelope: MeshEnvelope, origin: Origin) -> MeshResponse {
	tokio::time::timeout(HANDLER_TIMEOUT, sink.handle(envelope, origin))
		.await
		.unwrap_or_else(|_| MeshResponse::error(MeshErrorCode::Internal, "mesh handler timed out"))
}

/// Write one response frame within [`RESPONSE_WRITE_TIMEOUT`] (best effort)
/// and close.
async fn reply<S: Conn>(stream: &mut S, frame: &[u8]) {
	let _ = tokio::time::timeout(RESPONSE_WRITE_TIMEOUT, async {
		let _ = write_frame(stream, frame, usize::MAX).await;
		let _ = stream.shutdown().await;
	})
	.await;
}

/// Concurrent [`STATUS_BUSY`] answers per listener; refused connections past
/// this are dropped without an answer.
const MAX_BUSY_REPLIES: usize = 16;
/// How long a busy answer may take, including draining the peer's request.
const BUSY_LINGER: Duration = Duration::from_secs(1);

/// Answer [`STATUS_BUSY`], then drain (and discard) the peer's request until
/// it half-closes or [`BUSY_LINGER`] passes: closing a socket with unread
/// data sends a reset, which on some stacks (Windows) discards our answer
/// before the peer reads it.
async fn refuse_busy<S: Conn>(mut stream: S) {
	let _ = tokio::time::timeout(BUSY_LINGER, async {
		if write_frame(&mut stream, &[STATUS_BUSY], 1).await.is_err() {
			return;
		}
		let _ = stream.shutdown().await;
		let mut scratch = [0u8; 4096];
		let mut drained = 0;
		while drained < MAX_FRAME_BYTES {
			match stream.read(&mut scratch).await {
				Ok(0) | Err(_) => break,
				Ok(n) => drained += n,
			}
		}
	})
	.await;
}

/// Per-source-IP connection counts; a slot is released when its guard drops.
#[derive(Default)]
struct IpSlots {
	counts: Mutex<HashMap<IpAddr, usize>>,
}

struct IpSlot {
	slots: Arc<IpSlots>,
	ip:    IpAddr,
}

impl IpSlots {
	fn acquire(self: &Arc<Self>, ip: IpAddr, max: usize) -> Option<IpSlot> {
		let mut counts = self.counts.lock();
		let count = counts.entry(ip).or_default();
		if *count >= max {
			return None;
		}
		*count += 1;
		Some(IpSlot { slots: Arc::clone(self), ip })
	}
}

impl Drop for IpSlot {
	fn drop(&mut self) {
		let mut counts = self.slots.counts.lock();
		if let Some(count) = counts.get_mut(&self.ip) {
			*count -= 1;
			if *count == 0 {
				counts.remove(&self.ip);
			}
		}
	}
}

/// A connection byte stream (TCP, Unix socket, named pipe).
pub(crate) trait Conn: AsyncRead + AsyncWrite + Unpin + Send + 'static {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send + 'static> Conn for T {}

/// Source of accepted connections for [`Listener`].
trait Acceptor: Send + 'static {
	type Stream: Conn;
	/// The next connection and, for TCP, its source address.
	fn accept(
		&mut self,
	) -> impl Future<Output = io::Result<(Self::Stream, Option<SocketAddr>)>> + Send;
}

impl Acceptor for TcpListener {
	type Stream = TcpStream;

	async fn accept(&mut self) -> io::Result<(TcpStream, Option<SocketAddr>)> {
		let (stream, peer) = Self::accept(self).await?;
		// Best effort: one small frame each way.
		let _ = stream.set_nodelay(true);
		Ok((stream, Some(peer)))
	}
}

/// An accept loop serving each connection on its own task: at most
/// `per_ip` per TCP source address (when set) and [`MAX_CONNECTIONS`] in
/// total. Refused connections get [`STATUS_BUSY`] from at most
/// [`MAX_BUSY_REPLIES`] short-lived tasks and are dropped beyond that.
/// Dropping or closing the listener stops accepting and aborts in-flight
/// connections, so the sink is never called afterwards.
#[derive(Debug)]
struct Listener {
	task: JoinHandle<()>,
}

impl Listener {
	fn spawn<A, F, Fut>(mut acceptor: A, per_ip: Option<usize>, serve: F) -> Self
	where
		A: Acceptor,
		F: Fn(A::Stream, Option<SocketAddr>) -> Fut + Send + Sync + 'static,
		Fut: Future<Output = ()> + Send + 'static,
	{
		let permits = Arc::new(Semaphore::new(MAX_CONNECTIONS));
		let busy_permits = Arc::new(Semaphore::new(MAX_BUSY_REPLIES));
		let ip_slots = Arc::new(IpSlots::default());
		let task = tokio::spawn(async move {
			let mut connections = JoinSet::new();
			loop {
				while connections.try_join_next().is_some() {}
				let Ok((stream, peer)) = acceptor.accept().await else {
					// Transient (e.g. out of file descriptors): back off, keep
					// serving.
					tokio::time::sleep(Duration::from_millis(50)).await;
					continue;
				};
				let ip_slot = per_ip
					.zip(peer)
					.map(|(max, peer)| ip_slots.acquire(peer.ip(), max));
				let permit = Arc::clone(&permits).try_acquire_owned();
				let (Ok(permit), None | Some(Some(_))) = (permit, &ip_slot) else {
					// Refuse: bounded tasks answer `busy`; beyond that, just drop.
					if let Ok(busy) = Arc::clone(&busy_permits).try_acquire_owned() {
						connections.spawn(async move {
							refuse_busy(stream).await;
							drop(busy);
						});
					}
					continue;
				};
				let fut = serve(stream, peer);
				connections.spawn(async move {
					fut.await;
					drop(permit);
					drop(ip_slot);
				});
			}
		});
		Self { task }
	}

	async fn close(&mut self) {
		self.task.abort();
		let _ = (&mut self.task).await;
	}
}

impl Drop for Listener {
	fn drop(&mut self) {
		self.task.abort();
	}
}
