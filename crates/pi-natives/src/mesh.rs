//! N-API bindings for oh my pi mesh (`pi_mesh`).
//!
//! The engine (discovery, transports, peer table, inbound checks) lives in
//! `pi_mesh::node`; this module converts its types to JS objects, bridges its
//! event channel to a weak threadsafe callback, and maps request failures to
//! code-prefixed rejections (`unreachable:`, `timeout:`, `bad_response:`,
//! `aborted:`).

use std::{path::PathBuf, sync::Arc, time::Duration};

use napi::{
	Env, Error, Result, Status,
	bindgen_prelude::*,
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode, UnknownReturnValue},
};
use napi_derive::napi;
use parking_lot::Mutex;
use pi_mesh::{
	keys::derive_mesh_key,
	node::{self, MeshMode, NodeConfig, NodeEvent, NodeOptions, NodeStatus, PeerInfo},
	protocol::{MeshRequest, parse_response},
	transport::OriginKind,
};
use serde::Serialize;
use tokio::sync::mpsc;

use crate::task;

/// Weak: an idle mesh never keeps the event loop alive (the callback itself
/// is still strongly referenced until `close`).
type EventCallback =
	ThreadsafeFunction<MeshEvent, UnknownReturnValue, MeshEvent, Status, false, true>;

/// Derive the stored mesh key (unpadded base64url, 32 bytes) from a
/// passphrase: NFC-normalized, surrounding whitespace trimmed, PBKDF2-SHA256
/// 600k. Rejects a blank passphrase or one shorter than 12 characters.
#[napi(js_name = "meshDeriveKey", ts_return_type = "Promise<string>")]
pub fn mesh_derive_key(passphrase: String) -> AsyncTask<task::Blocking<String>> {
	task::blocking("mesh_derive_key", (), move |_| {
		derive_mesh_key(&passphrase).map_err(|err| Error::from_reason(err.to_string()))
	})
}

#[napi(object)]
pub struct MeshNodeOptions {
	/// Fresh random id when omitted.
	pub instance_id:  Option<String>,
	pub display_name: String,
	pub host:         String,
	/// Local registry directory (tests); `~/.omp/run/mesh` when omitted.
	pub registry_dir: Option<String>,
}

#[napi(object)]
pub struct MeshConfig {
	#[napi(ts_type = "'off' | 'local' | 'remote' | 'both'")]
	pub mode:         String,
	/// Stored mesh key; the remote side reports `no-key` without it.
	pub key:          Option<String>,
	/// LAN listener port (0 = any).
	pub lan_port:     u32,
	/// `host:port` peers probed directly.
	pub static_peers: Vec<String>,
	pub display_name: String,
}

#[napi(object)]
pub struct MeshStatus {
	pub mode:     String,
	#[napi(ts_type = "'on' | 'off' | 'error'")]
	pub local:    String,
	#[napi(ts_type = "'on' | 'off' | 'no-key' | 'error'")]
	pub remote:   String,
	pub lan_port: Option<u32>,
	pub error:    Option<String>,
}

/// JSON text shared with the engine's peer table, handed to JS without an
/// intermediate Rust copy.
pub struct SharedJson(Arc<str>);

impl ToNapiValue for SharedJson {
	unsafe fn to_napi_value(env: napi::sys::napi_env, val: Self) -> Result<napi::sys::napi_value> {
		// SAFETY: forwards the caller's live `env` to napi's own `&str`
		// conversion, which copies the bytes into a JS string.
		unsafe { <&str>::to_napi_value(env, &val.0) }
	}
}

#[napi(object, object_from_js = false)]
pub struct MeshPeerInfo {
	pub instance_id:   String,
	#[napi(ts_type = "'local' | 'remote'")]
	pub endpoint_kind: String,
	pub address:       Option<String>,
	pub port:          Option<u32>,
	pub hostname:      Option<String>,
	pub dns_name:      Option<String>,
	#[napi(ts_type = "'local' | 'mdns' | 'static' | 'contact'")]
	pub source:        String,
	#[napi(ts_type = "'online' | 'stale'")]
	pub state:         String,
	/// ms since the Unix epoch.
	pub last_seen:     f64,
	pub hidden:        bool,
	pub blocked:       bool,
	#[napi(ts_type = "string")]
	pub snapshot_json: Option<SharedJson>,
}

/// Engine notification. `peers`: re-read `peers()`. `status`: re-read
/// `status()`. `inbound`: answer `requestId` via `respond()` within 30 s.
#[napi(object)]
pub struct MeshEvent {
	#[napi(ts_type = "'peers' | 'status' | 'inbound'")]
	pub kind:           String,
	pub request_id:     Option<String>,
	pub envelope_json:  Option<String>,
	#[napi(ts_type = "'local' | 'remote'")]
	pub origin_kind:    Option<String>,
	/// Source IP of a remote sender (absent for local senders).
	pub origin_address: Option<String>,
}

/// Serde name of a unit enum variant (`lowercase` / `kebab-case` per type).
fn label<T: Serialize>(value: &T) -> String {
	match serde_json::to_value(value) {
		Ok(serde_json::Value::String(s)) => s,
		_ => String::new(),
	}
}

fn to_js_status(status: &NodeStatus) -> MeshStatus {
	MeshStatus {
		mode:     label(&status.mode),
		local:    label(&status.local),
		remote:   label(&status.remote),
		lan_port: status.lan_port.map(u32::from),
		error:    status.error.clone(),
	}
}

fn to_js_peer(peer: PeerInfo) -> MeshPeerInfo {
	MeshPeerInfo {
		endpoint_kind: label(&peer.endpoint_kind),
		source:        label(&peer.source),
		state:         label(&peer.state),
		instance_id:   peer.instance_id,
		address:       peer.address,
		port:          peer.port.map(u32::from),
		hostname:      peer.hostname,
		dns_name:      peer.dns_name,
		last_seen:     peer.last_seen as f64,
		hidden:        peer.hidden,
		blocked:       peer.blocked,
		snapshot_json: peer.snapshot_json.map(SharedJson),
	}
}

fn to_js_event(event: NodeEvent) -> MeshEvent {
	let bare = |kind: &str| MeshEvent {
		kind:           kind.to_owned(),
		request_id:     None,
		envelope_json:  None,
		origin_kind:    None,
		origin_address: None,
	};
	match event {
		NodeEvent::Peers => bare("peers"),
		NodeEvent::Status(_) => bare("status"),
		NodeEvent::Inbound { request_id, envelope, origin } => MeshEvent {
			kind:           "inbound".to_owned(),
			request_id:     Some(request_id),
			envelope_json:  serde_json::to_string(&envelope).ok(),
			origin_kind:    Some(
				match origin.kind {
					OriginKind::Local => "local",
					OriginKind::Remote => "remote",
				}
				.to_owned(),
			),
			origin_address: origin.addr.map(|addr| addr.ip().to_string()),
		},
	}
}

fn parse_mode(mode: &str) -> Result<MeshMode> {
	serde_json::from_value(serde_json::Value::String(mode.to_owned()))
		.map_err(|_| Error::new(Status::InvalidArg, format!("invalid mesh mode: {mode}")))
}

fn invalid_arg(err: impl std::fmt::Display) -> Error {
	Error::new(Status::InvalidArg, err.to_string())
}

/// One mesh participant: local registry + LAN listener, discovery, peer
/// table, snapshot serving and request/response messaging.
#[napi]
pub struct MeshNode {
	node: Arc<node::MeshNode>,
	pump: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

#[napi]
impl MeshNode {
	/// Create an idle node (mode `off` until `configure`).
	///
	/// `close()` is required: the node keeps listening, publishing and
	/// announcing until it is closed, and the callback holds a strong
	/// reference to `onEvent` (and whatever it captures), so an unclosed node
	/// is never garbage-collected. "Weak" applies only to the event loop: an
	/// idle node does not keep the process alive.
	#[napi(factory, ts_args_type = "opts: MeshNodeOptions, onEvent: (event: MeshEvent) => void")]
	pub fn create(
		opts: MeshNodeOptions,
		on_event: Function<'_, MeshEvent, UnknownReturnValue>,
	) -> Result<Self> {
		let callback: EventCallback = on_event
			.build_threadsafe_function()
			.callee_handled::<false>()
			.weak::<true>()
			.build()?;
		let (tx, mut rx) = mpsc::unbounded_channel();
		let options = NodeOptions {
			instance_id:  opts.instance_id,
			display_name: opts.display_name,
			host:         opts.host,
			registry_dir: opts.registry_dir.map(PathBuf::from),
		};
		let node =
			within_runtime_if_available(|| node::MeshNode::new(options, tx)).map_err(invalid_arg)?;
		let pump = spawn(async move {
			while let Some(event) = rx.recv().await {
				callback.call(to_js_event(event), ThreadsafeFunctionCallMode::NonBlocking);
			}
		});
		Ok(Self { node, pump: Mutex::new(Some(pump)) })
	}

	#[napi(getter)]
	pub fn instance_id(&self) -> String {
		self.node.instance_id().to_owned()
	}

	/// Reconcile local/LAN sides, discovery and static peers with `cfg`.
	/// Idempotent.
	#[napi(ts_return_type = "Promise<MeshStatus>")]
	pub fn configure<'env>(
		&self,
		env: &'env Env,
		cfg: MeshConfig,
	) -> Result<PromiseRaw<'env, MeshStatus>> {
		let config = NodeConfig {
			mode:         parse_mode(&cfg.mode)?,
			key:          cfg.key,
			lan_port:     u16::try_from(cfg.lan_port)
				.map_err(|_| invalid_arg("lanPort out of range"))?,
			static_peers: cfg.static_peers,
			display_name: cfg.display_name,
		};
		let node = Arc::clone(&self.node);
		task::future(
			env,
			"mesh_configure",
			async move { Ok(to_js_status(&node.configure(config).await)) },
		)
	}

	#[napi]
	pub fn status(&self) -> MeshStatus {
		to_js_status(&self.node.status())
	}

	/// Replace the snapshot served for `snapshot` requests (must carry this
	/// node's instanceId).
	#[napi]
	pub fn set_snapshot(&self, snapshot_json: String) -> Result<()> {
		self.node.set_snapshot(&snapshot_json).map_err(invalid_arg)
	}

	#[napi]
	pub fn peers(&self) -> Vec<MeshPeerInfo> {
		self.node.peers().into_iter().map(to_js_peer).collect()
	}

	/// Re-list local peers, query mDNS and refresh snapshots now.
	#[napi]
	pub fn refresh(&self) {
		within_runtime_if_available(|| self.node.refresh());
	}

	#[napi]
	pub fn set_peer_flags(&self, instance_id: String, hidden: bool, blocked: bool) {
		self.node.set_peer_flags(&instance_id, hidden, blocked);
	}

	/// Send `bodyJson` (a `MeshRequest`) to peer `to` as `fromAgentId`;
	/// resolves to the `MeshResponse` JSON. Rejects with a message prefixed
	/// `unreachable:`, `timeout:`, `bad_response:` or `aborted:`.
	#[napi(ts_return_type = "Promise<string>")]
	pub fn request<'env>(
		&self,
		env: &'env Env,
		to: String,
		from_agent_id: String,
		body_json: String,
		timeout_ms: u32,
		#[napi(ts_arg_type = "AbortSignal")] signal: Option<Unknown<'env>>,
	) -> Result<PromiseRaw<'env, String>> {
		let body: MeshRequest = serde_json::from_str(&body_json).map_err(invalid_arg)?;
		let cancel = task::cancellation_token(signal);
		let node = Arc::clone(&self.node);
		task::future(env, "mesh_request", async move {
			let work =
				node.request(&to, &from_agent_id, body, Duration::from_millis(u64::from(timeout_ms)));
			let outcome = match &cancel {
				Some(cancel) => tokio::select! {
					biased;
					() = cancel.cancelled() => return Err(Error::from_reason("aborted: mesh request aborted")),
					outcome = work => outcome,
				},
				None => work.await,
			};
			let response = outcome.map_err(|err| Error::from_reason(err.to_string()))?;
			serde_json::to_string(&response)
				.map_err(|err| Error::from_reason(format!("bad_response: {err}")))
		})
	}

	/// Answer an `inbound` event with `responseJson` (a `MeshResponse`). Late or
	/// unknown ids are ignored.
	#[napi]
	pub fn respond(&self, request_id: String, response_json: String) -> Result<()> {
		let response = parse_response(response_json.as_bytes()).map_err(invalid_arg)?;
		self.node.respond(&request_id, response);
		Ok(())
	}

	/// Withdraw from the mesh and stop all background work. Required before
	/// dropping the node (see `create`). Idempotent.
	#[napi(ts_return_type = "Promise<void>")]
	pub fn close<'env>(&self, env: &'env Env) -> Result<PromiseRaw<'env, ()>> {
		let node = Arc::clone(&self.node);
		let pump = self.pump.lock().take();
		task::future(env, "mesh_close", async move {
			node.close().await;
			if let Some(pump) = pump {
				pump.abort();
			}
			Ok(())
		})
	}
}

impl Drop for MeshNode {
	fn drop(&mut self) {
		if let Some(pump) = self.pump.get_mut().take() {
			pump.abort();
		}
	}
}
