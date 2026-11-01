//! N-API bindings for oh my pi mesh (`pi_mesh`).
//!
//! The engine (discovery, transports, peer table, inbound checks) lives in
//! `pi_mesh::node`; this module converts its types to JS objects, bridges its
//! event channel to a weak threadsafe callback, and maps request failures to
//! code-prefixed rejections (`unreachable:`, `timeout:`, `bad_response:`,
//! `aborted:`).

use std::{sync::Arc, time::Duration};

use napi::{
	Env, Error, Result, Status,
	bindgen_prelude::*,
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode, UnknownReturnValue},
};
use napi_derive::napi;
use parking_lot::Mutex;
use pi_mesh::{
	keys::{MIN_PASSPHRASE_CHARS, STRONG_PASSPHRASE_CHARS, check_passphrase, derive_mesh_key},
	node::{self, MeshMode, NodeConfig, NodeEvent, NodeOptions, NodeStatus, PeerInfo, Track},
	protocol::{MeshRequest, parse_response},
	transport::OriginKind,
};
use serde::Serialize;
use tokio::sync::{mpsc, oneshot};

use crate::{instances::InstanceHost, task};

/// Weak: an idle mesh never keeps the event loop alive (the callback itself
/// is still strongly referenced until `close`).
type EventCallback =
	ThreadsafeFunction<MeshEvent, UnknownReturnValue, MeshEvent, Status, false, true>;

/// Derive the stored mesh key (unpadded base64url, 32 bytes) from a
/// passphrase.
///
/// The phrase is NFC-normalized and trimmed, then stretched with
/// PBKDF2-SHA256 (600k rounds). Rejects a blank passphrase or one shorter
/// than 12 characters.
#[napi(js_name = "meshDeriveKey", ts_return_type = "Promise<string>")]
pub fn mesh_derive_key(passphrase: String) -> AsyncTask<task::Blocking<String>> {
	task::blocking("mesh_derive_key", (), move |_| {
		derive_mesh_key(&passphrase).map_err(|err| Error::from_reason(err.to_string()))
	})
}

/// Live feedback for a mesh key passphrase, counted exactly as
/// `meshDeriveKey` counts it (NFC, trimmed, Unicode scalar values).
#[napi(object)]
pub struct MeshPassphraseCheck {
	pub chars:        u32,
	/// `meshDeriveKey` accepts it (at least `minChars`).
	pub valid:        bool,
	/// Shorter than `strongChars`: guessable by anyone on the LAN.
	pub weak:         bool,
	/// Shortest accepted phrase.
	pub min_chars:    u32,
	/// Length from which a phrase is no longer flagged weak.
	pub strong_chars: u32,
}

#[napi(js_name = "meshPassphraseCheck")]
pub fn mesh_passphrase_check(phrase: String) -> MeshPassphraseCheck {
	let check = check_passphrase(&phrase);
	let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
	MeshPassphraseCheck {
		chars:        count(check.chars),
		valid:        check.valid,
		weak:         check.weak,
		min_chars:    count(MIN_PASSPHRASE_CHARS),
		strong_chars: count(STRONG_PASSPHRASE_CHARS),
	}
}

#[napi(object, object_to_js = false)]
pub struct MeshNodeOptions<'env> {
	/// Same-machine instance: supplies the node's instance id and registry
	/// directory; the local side serves the `mesh` namespace on it. Closing
	/// the node leaves the host open.
	pub host:         ClassInstance<'env, InstanceHost>,
	pub display_name: String,
	/// Machine host name sent in envelopes.
	pub host_name:    String,
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
pub struct MeshRequestOptions {
	pub timeout_ms: u32,
	/// Track the answers of a `message` (not a note) or `watch` under this
	/// frontend ticket once the peer acknowledged it: they resolve
	/// `awaitReply`, or arrive as `reply` events carrying the ticket.
	pub ticket:     Option<String>,
	/// Keep the first answer for an `awaitReply` about to start instead of
	/// emitting it (with `ticket`).
	pub hold:       Option<bool>,
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

/// Engine notification.
///
/// `peers`: re-read `peers()`. `status`: re-read `status()`. `inbound`:
/// answer `requestId` via `respond()` within 30 s. `reply`: an answer
/// (`envelopeJson`) to the tracked request of `ticket` nobody awaits.
/// `pending_dropped`: `tickets` are no longer tracked (TTL, size cap, close).
#[napi(object)]
pub struct MeshEvent {
	#[napi(ts_type = "'peers' | 'status' | 'inbound' | 'reply' | 'pending_dropped'")]
	pub kind:           String,
	pub request_id:     Option<String>,
	pub envelope_json:  Option<String>,
	#[napi(ts_type = "'local' | 'remote'")]
	pub origin_kind:    Option<String>,
	/// Source IP of a remote sender (absent for local senders).
	pub origin_address: Option<String>,
	pub ticket:         Option<String>,
	pub tickets:        Option<Vec<String>>,
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
		ticket:         None,
		tickets:        None,
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
			ticket:         None,
			tickets:        None,
		},
		NodeEvent::Reply { ticket, envelope } => MeshEvent {
			envelope_json: serde_json::to_string(&envelope).ok(),
			ticket: Some(ticket),
			..bare("reply")
		},
		NodeEvent::PendingDropped { tickets } => {
			MeshEvent { tickets: Some(tickets), ..bare("pending_dropped") }
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

/// Delivers engine events to JS; stopped after the node closed, once the
/// events it emitted while closing (`pending_dropped`) went out.
struct Pump {
	task: tokio::task::JoinHandle<()>,
	stop: oneshot::Sender<()>,
}

/// One mesh participant: local registry + LAN listener, discovery, peer
/// table, snapshot serving and request/response messaging.
#[napi]
pub struct MeshNode {
	node: Arc<node::MeshNode>,
	pump: Mutex<Option<Pump>>,
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
	pub fn create<'env>(
		opts: MeshNodeOptions<'env>,
		on_event: Function<'env, MeshEvent, UnknownReturnValue>,
	) -> Result<Self> {
		let callback: EventCallback = on_event
			.build_threadsafe_function()
			.callee_handled::<false>()
			.weak::<true>()
			.build()?;
		let (tx, mut rx) = mpsc::unbounded_channel();
		let options = NodeOptions {
			host:         Arc::clone(opts.host.inner()),
			display_name: opts.display_name,
			host_name:    opts.host_name,
		};
		let node = within_runtime_if_available(|| node::MeshNode::new(options, tx));
		let (stop, mut stopped) = oneshot::channel::<()>();
		let task = spawn(async move {
			loop {
				tokio::select! {
					biased;
					event = rx.recv() => match event {
						Some(event) => {
							callback.call(to_js_event(event), ThreadsafeFunctionCallMode::NonBlocking);
						},
						None => return,
					},
					_ = &mut stopped => return,
				}
			}
		});
		Ok(Self { node, pump: Mutex::new(Some(Pump { task, stop })) })
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
	/// resolves to the `MeshResponse` JSON. A `message` / `watch`
	/// acknowledgement without a valid `msgId` / `watchId` resolves to an
	/// `internal` error response. Rejects with a message prefixed
	/// `unreachable:`, `timeout:`, `bad_response:` or `aborted:`.
	#[napi(ts_return_type = "Promise<string>")]
	pub fn request<'env>(
		&self,
		env: &'env Env,
		to: String,
		from_agent_id: String,
		body_json: String,
		options: MeshRequestOptions,
		#[napi(ts_arg_type = "AbortSignal")] signal: Option<Unknown<'env>>,
	) -> Result<PromiseRaw<'env, String>> {
		let body: MeshRequest = serde_json::from_str(&body_json).map_err(invalid_arg)?;
		let cancel = task::cancellation_token(signal);
		let node = Arc::clone(&self.node);
		task::future(env, "mesh_request", async move {
			let track = options
				.ticket
				.map(|ticket| Track { ticket, hold: options.hold.unwrap_or(false) });
			let timeout = Duration::from_millis(u64::from(options.timeout_ms));
			let work = node.request(&to, &from_agent_id, body, timeout, track);
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

	/// Wait up to `timeoutMs` for the next answer to the tracked request `key`
	/// (`msgId` / `watchId`); resolves to the answer's envelope JSON, or
	/// `null` when untracked, out of time, aborted, replaced by a newer
	/// `awaitReply` for the same key, or dropped. A held answer that already
	/// arrived resolves at once. Answers after the wait arrive as `reply`
	/// events.
	#[napi(ts_return_type = "Promise<string | null>")]
	pub fn await_reply<'env>(
		&self,
		env: &'env Env,
		key: String,
		timeout_ms: u32,
		#[napi(ts_arg_type = "AbortSignal")] signal: Option<Unknown<'env>>,
	) -> Result<PromiseRaw<'env, Option<String>>> {
		let cancel = task::cancellation_token(signal);
		let node = Arc::clone(&self.node);
		task::future(env, "mesh_await_reply", async move {
			let work = node.await_reply(&key, Duration::from_millis(u64::from(timeout_ms)));
			let answer = match &cancel {
				Some(cancel) => tokio::select! {
					biased;
					() = cancel.cancelled() => None,
					answer = work => answer,
				},
				None => work.await,
			};
			Ok(answer.and_then(|envelope| serde_json::to_string(&envelope).ok()))
		})
	}

	/// Stop tracking the requests of `tickets` (their waits resolve `null`).
	#[napi]
	pub fn forget_pending(&self, tickets: Vec<String>) {
		self.node.forget_pending(&tickets);
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
			if let Some(Pump { task, stop }) = pump {
				// Biased toward events: everything `close` emitted is delivered
				// first.
				let _ = stop.send(());
				let _ = task.await;
			}
			Ok(())
		})
	}
}

impl Drop for MeshNode {
	fn drop(&mut self) {
		if let Some(pump) = self.pump.get_mut().take() {
			pump.task.abort();
		}
	}
}
