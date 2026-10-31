//! LAN listener: the [`super::sealed`] protocol keyed by the shared mesh key,
//! bound to all interfaces, at most [`MAX_CONNECTIONS_PER_IP`] connections
//! per source address.

use std::{io, net::SocketAddr, sync::Arc};

use parking_lot::Mutex;
use tokio::net::TcpListener;

use super::{
	InboundSink, Listener, MAX_CONNECTIONS_PER_IP, OriginKind,
	sealed::{self, Server, ServerKey},
};
use crate::keys::{MeshKeys, ReplayGuard};

/// A running LAN listener. Dropping it stops serving.
#[derive(Debug)]
pub struct LanListener {
	listener: Listener,
	addr:     SocketAddr,
}

impl LanListener {
	/// Bind `bind` (normally `0.0.0.0:<mesh.port>`; port 0 picks one) and serve
	/// envelopes addressed to `instance_id` into `sink`.
	///
	/// `guard` outlives the listener: keep one per mesh key so restarting the
	/// listener (e.g. on a port change) does not reopen the replay window.
	///
	/// # Errors
	/// When the socket cannot be bound.
	pub async fn start(
		bind: SocketAddr,
		instance_id: String,
		keys: Arc<MeshKeys>,
		guard: Arc<Mutex<ReplayGuard>>,
		sink: Arc<dyn InboundSink>,
	) -> io::Result<Self> {
		let tcp = TcpListener::bind(bind).await?;
		let addr = tcp.local_addr()?;
		let server = Arc::new(Server {
			instance_id,
			key: ServerKey::Mesh(keys),
			guard,
			sink,
			origin: OriginKind::Remote,
		});
		let listener = Listener::spawn(tcp, Some(MAX_CONNECTIONS_PER_IP), move |stream, peer| {
			sealed::serve(stream, peer, Arc::clone(&server))
		});
		Ok(Self { listener, addr })
	}

	pub const fn addr(&self) -> SocketAddr {
		self.addr
	}

	pub const fn port(&self) -> u16 {
		self.addr.port()
	}

	/// Stop accepting and abort in-flight connections.
	pub async fn close(mut self) {
		self.listener.close().await;
	}
}
