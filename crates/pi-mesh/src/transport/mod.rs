//! Request/response transports: one connection per request.
//!
//! - [`instance`]: same machine. The node serves the `mesh` namespace of its
//!   [`pi_instances::InstanceHost`] (one long-lived Unix socket inside the
//!   owner-only instance registry, or a current-user-only named pipe on
//!   Windows), so other accounts cannot even connect. A request is
//!   `mesh.envelope` with the envelope as body, authenticated by the bearer
//!   token from the registry; it is not sealed.
//! - [`lan`]: LAN listener over TCP, one length-prefixed frame each way
//!   ([`crate::frame`]), sealed with a key derived from the shared mesh key
//!   ([`sealed`]).
//!
//! LAN response frame payload: `[status byte][body]`. Only [`STATUS_OK`]
//! carries a body (a sealed [`MeshResponse`]). The other statuses answer
//! requests that never authenticated and reveal nothing secret:
//! [`STATUS_REJECTED`] (bad key, or a malformed pre-auth frame),
//! [`STATUS_MISDIRECTED`] (the endpoint now serves another instance),
//! [`STATUS_TOO_LARGE`] (request frame over the cap), [`STATUS_BUSY`]
//! (connection limits reached). They are not authenticated, so an on-path
//! attacker can forge them (denial of service only). The local side gets the
//! same outcomes from `pi-instances` error codes (`instance::map_outcome`).

pub mod instance;
pub mod lan;
mod sealed;
#[cfg(test)]
mod tests;

use std::{
	collections::HashMap,
	future::Future,
	net::{IpAddr, SocketAddr},
	pin::Pin,
	sync::Arc,
	time::Duration,
};

use parking_lot::Mutex;
use pi_instances::InstanceEntry;
use tokio::{
	io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
	net::{TcpListener, TcpStream},
	sync::Semaphore,
	task::{JoinHandle, JoinSet},
};

use crate::{
	error::FrameError,
	frame::{MAX_FRAME_BYTES, read_frame, write_frame},
	keys::MeshKeys,
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
/// global slot is taken, so one host cannot occupy every slot.
pub const MAX_CONNECTIONS_PER_IP: usize = 8;

/// `unauthorized` text when a peer rejects our key or token.
const REJECTED_TEXT: &str = "mesh peer rejected our credentials";
/// `too_large` text when a peer refuses an oversized request.
const TOO_LARGE_TEXT: &str = "mesh peer rejected an oversized request";
/// `busy` text when a peer is at its connection limit.
const BUSY_TEXT: &str = "mesh peer has too many open connections";

/// Where a peer listens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Endpoint {
	/// Same machine: the peer's entry in the instance registry (endpoint,
	/// bearer token, owner pid). On Windows a pipe served by another process
	/// is treated as misdirected.
	Local(InstanceEntry),
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
/// Transports already checked: key (LAN) or token (local), envelope shape and
/// caps, recipient, and (LAN) the replay window. Everything else — hop,
/// blocked senders, rate limits, dispatch — is the sink's job.
pub trait InboundSink: Send + Sync + 'static {
	fn handle(&self, envelope: MeshEnvelope, origin: Origin) -> BoxFuture<MeshResponse>;
}

/// Client-side delivery failure.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TransportError {
	#[error("{0}")]
	Unreachable(String),
	/// The endpoint answers for another instance (stale discovery entry or
	/// reused port).
	#[error("mesh endpoint now serves another instance")]
	Misdirected,
	#[error("mesh peer did not answer in time")]
	Timeout,
	#[error("{0}")]
	BadResponse(String),
}

impl TransportError {
	/// Stable code for the N-API rejection's `code`.
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
	/// contacting the peer; a peer rejecting our key or token resolves to
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
		let json = serde_json::value::to_raw_value(envelope)
			.map_err(|e| TransportError::BadResponse(format!("cannot encode envelope: {e}")))?;
		if json.get().len() > MAX_ENVELOPE_BYTES {
			return Ok(MeshResponse::error(
				MeshErrorCode::TooLarge,
				format!("mesh envelope exceeds {MAX_ENVELOPE_BYTES} bytes"),
			));
		}
		tokio::time::timeout(timeout, async {
			match endpoint {
				Endpoint::Local(entry) => instance::request(entry, &json, timeout).await,
				Endpoint::Remote { addr } => {
					let keys = self.keys.as_deref().ok_or_else(|| {
						TransportError::Unreachable("remote mesh side has no key".into())
					})?;
					let stream = connect(*addr).await?;
					sealed::request(stream, keys.seal_key(), envelope, json.get().as_bytes()).await
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
		Some(STATUS_REJECTED) => {
			Ok(Err(MeshResponse::error(MeshErrorCode::Unauthorized, REJECTED_TEXT)))
		},
		Some(STATUS_MISDIRECTED) => Err(TransportError::Misdirected),
		Some(STATUS_TOO_LARGE) => {
			Ok(Err(MeshResponse::error(MeshErrorCode::TooLarge, TOO_LARGE_TEXT)))
		},
		Some(STATUS_BUSY) => Ok(Err(MeshResponse::error(MeshErrorCode::Busy, BUSY_TEXT))),
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

/// A connection byte stream (TCP).
pub(crate) trait Conn: AsyncRead + AsyncWrite + Unpin + Send + 'static {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send + 'static> Conn for T {}

/// An accept loop serving each TCP connection on its own task: at most
/// `per_ip` per source address and [`MAX_CONNECTIONS`] in total. Refused
/// connections get [`STATUS_BUSY`] from at most [`MAX_BUSY_REPLIES`]
/// short-lived tasks and are dropped beyond that. Dropping or closing the
/// listener stops accepting and aborts in-flight connections, so the sink is
/// never called afterwards.
#[derive(Debug)]
struct Listener {
	task: JoinHandle<()>,
}

impl Listener {
	fn spawn<F, Fut>(listener: TcpListener, per_ip: usize, serve: F) -> Self
	where
		F: Fn(TcpStream, SocketAddr) -> Fut + Send + Sync + 'static,
		Fut: Future<Output = ()> + Send + 'static,
	{
		let permits = Arc::new(Semaphore::new(MAX_CONNECTIONS));
		let busy_permits = Arc::new(Semaphore::new(MAX_BUSY_REPLIES));
		let ip_slots = Arc::new(IpSlots::default());
		let task = tokio::spawn(async move {
			let mut connections = JoinSet::new();
			loop {
				while connections.try_join_next().is_some() {}
				let Ok((stream, peer)) = listener.accept().await else {
					// Transient (e.g. out of file descriptors): back off, keep
					// serving.
					tokio::time::sleep(Duration::from_millis(50)).await;
					continue;
				};
				// Best effort: one small frame each way.
				let _ = stream.set_nodelay(true);
				let ip_slot = ip_slots.acquire(peer.ip(), per_ip);
				let permit = Arc::clone(&permits).try_acquire_owned();
				let (Ok(permit), Some(ip_slot)) = (permit, ip_slot) else {
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
