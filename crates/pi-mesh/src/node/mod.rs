//! The mesh node orchestrator.
//!
//! Reconciles the configured sides (the `mesh` namespace of the instance
//! host, LAN listener + mDNS + static peers), keeps the peer table fresh,
//! admits inbound envelopes and routes outbound requests.
//!
//! The frontend drives it through [`MeshNode`] and receives [`NodeEvent`]s:
//! coalesced `Peers` changes, `Status` changes, and `Inbound` requests it must
//! answer with [`MeshNode::respond`].

mod inbound;
mod peers;
#[cfg(test)]
mod tests;

use std::{
	collections::{HashMap, HashSet},
	net::{IpAddr, Ipv4Addr, SocketAddr},
	sync::{Arc, Weak},
	time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use parking_lot::Mutex;
use pi_instances::{InstanceHost, Registration};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::{
	sync::{Notify, mpsc},
	task::{JoinHandle, JoinSet},
};

pub use self::peers::{EndpointKind, PeerInfo, PeerSource, PeerState};
use self::{
	inbound::{Admission, Limits, Pending, admit},
	peers::{MdnsEndpoint, PeerTable},
};
use crate::{
	discovery::{DiscoveryEvent, MdnsConfig, MdnsDiscovery},
	error::ProtocolError,
	keys::{MeshKeys, ReplayGuard, hex, random_bytes},
	net::{self, ReverseDns},
	protocol::{
		ANY_INSTANCE, MAX_ENVELOPE_BYTES, MeshEnvelope, MeshErrorCode, MeshRequest, MeshResponse,
		MeshSender, PROTOCOL_VERSION, parse_snapshot,
	},
	transport::{
		BoxFuture, Endpoint, InboundSink, MeshClient, Origin, OriginKind, TransportError,
		instance::{self, MeshNamespace},
		lan::LanListener,
	},
};

/// Peers-changed notifications are coalesced over this window.
const PEERS_DEBOUNCE: Duration = Duration::from_millis(50);
/// Agent id the engine uses for its own requests (snapshot fetch/probe).
const ENGINE_AGENT_ID: &str = "Main";
/// Liveness check deadline per registry entry on the local poll (checks run
/// concurrently).
const LOCAL_PROBE_TIMEOUT: Duration = Duration::from_secs(3);
/// Room left in an envelope-sized response for the `{ok, data}` wrapper.
const SNAPSHOT_RESPONSE_OVERHEAD: usize = 64;

/// Which sides of the mesh run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MeshMode {
	Off,
	Local,
	Remote,
	Both,
}

impl MeshMode {
	const fn local(self) -> bool {
		matches!(self, Self::Local | Self::Both)
	}

	const fn remote(self) -> bool {
		matches!(self, Self::Remote | Self::Both)
	}
}

#[derive(Debug, Clone)]
pub struct NodeOptions {
	/// Same-machine instance: its id is the node's instance id; the local side
	/// registers the `mesh` namespace on it and lists peers in its registry
	/// directory. Shared with other namespaces; the node never closes it.
	pub host:         Arc<InstanceHost>,
	pub display_name: String,
	/// Machine host name sent in envelopes.
	pub host_name:    String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeConfig {
	pub mode:         MeshMode,
	/// Stored mesh key (unpadded base64url); remote side is `no-key` without.
	pub key:          Option<String>,
	/// LAN listener port (0 = any).
	pub lan_port:     u16,
	/// `host:port` of peers to probe directly (never same-machine filtered).
	pub static_peers: Vec<String>,
	pub display_name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LocalState {
	On,
	Off,
	Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RemoteState {
	On,
	Off,
	NoKey,
	Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeStatus {
	pub mode:     MeshMode,
	pub local:    LocalState,
	pub remote:   RemoteState,
	/// Bound LAN port while the remote side is on.
	pub lan_port: Option<u16>,
	/// Why a side is in `error`, or why mDNS is not running while the
	/// remote side is on (retried every refresh).
	pub error:    Option<String>,
}

impl NodeStatus {
	const OFF: Self = Self {
		mode:     MeshMode::Off,
		local:    LocalState::Off,
		remote:   RemoteState::Off,
		lan_port: None,
		error:    None,
	};
}

#[derive(Debug, Clone)]
pub enum NodeEvent {
	/// The peer list changed; read [`MeshNode::peers`].
	Peers,
	Status(NodeStatus),
	/// An admitted request; answer with [`MeshNode::respond`] within the
	/// respond timeout (30 s), else the sender gets `internal`.
	Inbound {
		request_id: String,
		envelope:   Box<MeshEnvelope>,
		origin:     Origin,
	},
}

/// mDNS discovery as the node uses it (seam for tests).
pub(crate) trait MdnsStarter: Send + Sync + 'static {
	fn start(
		&self,
		cfg: MdnsConfig,
		events: mpsc::Sender<DiscoveryEvent>,
	) -> Result<Arc<dyn MdnsHandle>, String>;
}

pub(crate) trait MdnsHandle: Send + Sync + 'static {
	fn refresh(&self);
	/// Host interfaces changed so that discovery must be restarted.
	fn needs_restart(&self) -> bool;
	/// Goodbye + daemon shutdown; idempotent.
	fn stop(&self) -> BoxFuture<()>;
}

struct RealMdns;

impl MdnsStarter for RealMdns {
	fn start(
		&self,
		cfg: MdnsConfig,
		events: mpsc::Sender<DiscoveryEvent>,
	) -> Result<Arc<dyn MdnsHandle>, String> {
		let discovery = MdnsDiscovery::start(cfg, events).map_err(|e| e.to_string())?;
		Ok(Arc::new(Mutex::new(Some(discovery))))
	}
}

impl MdnsHandle for Mutex<Option<MdnsDiscovery>> {
	fn refresh(&self) {
		if let Some(discovery) = self.lock().as_ref() {
			let _ = discovery.refresh();
		}
	}

	fn needs_restart(&self) -> bool {
		self
			.lock()
			.as_ref()
			.is_some_and(MdnsDiscovery::needs_restart)
	}

	fn stop(&self) -> BoxFuture<()> {
		let discovery = self.lock().take();
		Box::pin(async move {
			if let Some(discovery) = discovery {
				discovery.stop().await;
			}
		})
	}
}

/// Injection points and intervals (tests shorten/replace them).
pub(crate) struct Seams {
	pub mdns:             Arc<dyn MdnsStarter>,
	pub is_same_machine:  fn(IpAddr) -> bool,
	pub rdns:             ReverseDns,
	/// LAN listener bind address (`0.0.0.0` in production).
	pub lan_bind:         IpAddr,
	pub local_poll:       Duration,
	pub snapshot_refresh: Duration,
	pub respond_timeout:  Duration,
	/// Engine-originated snapshot fetches and static probes.
	pub probe_timeout:    Duration,
}

impl Default for Seams {
	fn default() -> Self {
		Self {
			mdns:             Arc::new(RealMdns),
			is_same_machine:  net::is_same_machine,
			rdns:             ReverseDns::default(),
			lan_bind:         IpAddr::V4(Ipv4Addr::UNSPECIFIED),
			local_poll:       Duration::from_secs(5),
			snapshot_refresh: Duration::from_secs(30),
			respond_timeout:  inbound::RESPOND_TIMEOUT,
			probe_timeout:    Duration::from_secs(5),
		}
	}
}

struct State {
	display_name:   String,
	/// Validated own snapshot, serialized once, served for `snapshot`.
	snapshot:       Option<Arc<str>>,
	status:         NodeStatus,
	/// Local/remote side failures from the last `configure`.
	config_error:   Option<String>,
	/// Why mDNS is not running while the remote side is on.
	mdns_error:     Option<String>,
	table:          PeerTable,
	limits:         Limits,
	pending:        Pending,
	client:         MeshClient,
	local_on:       bool,
	remote_on:      bool,
	lan_port:       Option<u16>,
	mdns:           Option<Arc<dyn MdnsHandle>>,
	static_specs:   Vec<String>,
	/// Static spec -> (address that answered, instance id it reported).
	static_learned: HashMap<String, (SocketAddr, String)>,
	closed:         bool,
}

impl State {
	fn compose_error(&self) -> Option<String> {
		match (&self.config_error, &self.mdns_error) {
			(Some(a), Some(b)) => Some(format!("{a}; mdns: {b}")),
			(Some(a), None) => Some(a.clone()),
			(None, Some(b)) => Some(format!("mdns: {b}")),
			(None, None) => None,
		}
	}

	fn static_keep(&self) -> Vec<(SocketAddr, String)> {
		self.static_learned.values().cloned().collect()
	}
}

/// Wake-ups shared with the background loops (which must not keep the node
/// alive while idle).
#[derive(Default)]
struct Signals {
	peers_dirty:  Notify,
	wake_local:   Notify,
	wake_refresh: Notify,
}

/// mDNS identity: restart discovery when any of it changes.
type MdnsKey = (String, u16, String);

struct MdnsPart {
	key:    MdnsKey,
	handle: Arc<dyn MdnsHandle>,
	task:   JoinHandle<()>,
}

struct RemotePart {
	key:      String,
	cfg_port: u16,
	keys:     Arc<MeshKeys>,
	lan:      LanListener,
	mdns:     Option<MdnsPart>,
}

#[derive(Default)]
struct Parts {
	/// The `mesh` namespace on the instance host while the local side is on.
	local:  Option<Registration>,
	remote: Option<RemotePart>,
	/// Replay guard per mesh key; survives listener restarts so a port change
	/// does not reopen the replay window.
	replay: Option<(String, Arc<Mutex<ReplayGuard>>)>,
}

/// One mesh participant. Create inside a tokio runtime.
pub struct MeshNode {
	me:          Weak<Self>,
	instance_id: String,
	host_name:   String,
	instances:   Arc<InstanceHost>,
	seams:       Seams,
	events:      mpsc::UnboundedSender<NodeEvent>,
	state:       Mutex<State>,
	parts:       tokio::sync::Mutex<Parts>,
	signals:     Arc<Signals>,
	background:  Mutex<Vec<JoinHandle<()>>>,
}

/// Result of one engine snapshot exchange.
enum Fetched {
	/// Validated snapshot naming the expected instance.
	Snapshot {
		id:   String,
		json: Arc<str>,
	},
	/// The peer answered (sealed) with a non-auth error, e.g. no snapshot yet.
	Alive,
	/// Wrong key/token, wrong instance or malformed snapshot.
	Rejected,
	Failed(TransportError),
}

fn now_ms() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

fn new_msg_id() -> String {
	let mut raw = [0u8; 12];
	random_bytes(&mut raw);
	hex(&raw)
}

/// Classifies a snapshot response; `expected` is the id the route should
/// serve (`None` for a `*` probe: any id but ours).
fn classify_snapshot(
	result: Result<MeshResponse, TransportError>,
	expected: Option<&str>,
	own_id: &str,
) -> Fetched {
	let value = match result {
		Ok(MeshResponse::Ok(value)) => value,
		Ok(MeshResponse::OkRaw(json)) => match serde_json::from_str(&json) {
			Ok(value) => value,
			Err(_) => return Fetched::Rejected,
		},
		Ok(MeshResponse::Err { code: MeshErrorCode::Unauthorized, .. }) => return Fetched::Rejected,
		Ok(MeshResponse::Err { .. }) => return Fetched::Alive,
		Err(err) => return Fetched::Failed(err),
	};
	match parse_snapshot(&value) {
		Ok(snapshot)
			if expected.map_or(snapshot.instance_id != own_id, |id| snapshot.instance_id == id) =>
		{
			match serde_json::to_string(&snapshot) {
				Ok(json) => Fetched::Snapshot { id: snapshot.instance_id, json: Arc::from(json) },
				Err(_) => Fetched::Rejected,
			}
		},
		_ => Fetched::Rejected,
	}
}

impl MeshNode {
	/// Creates the node (all sides off until [`Self::configure`]); its
	/// instance id is `opts.host`'s.
	///
	/// # Panics
	/// Outside a tokio runtime.
	pub fn new(opts: NodeOptions, events: mpsc::UnboundedSender<NodeEvent>) -> Arc<Self> {
		Self::with_seams(opts, events, Seams::default())
	}

	pub(crate) fn with_seams(
		opts: NodeOptions,
		events: mpsc::UnboundedSender<NodeEvent>,
		seams: Seams,
	) -> Arc<Self> {
		let instance_id = opts.host.instance_id().to_owned();
		let node = Arc::new_cyclic(|me| Self {
			me: me.clone(),
			host_name: opts.host_name,
			instances: opts.host,
			seams,
			events,
			state: Mutex::new(State {
				display_name:   opts.display_name,
				snapshot:       None,
				status:         NodeStatus::OFF,
				config_error:   None,
				mdns_error:     None,
				table:          PeerTable::new(&instance_id),
				limits:         Limits::default(),
				pending:        Pending::default(),
				client:         MeshClient::new(None),
				local_on:       false,
				remote_on:      false,
				lan_port:       None,
				mdns:           None,
				static_specs:   Vec::new(),
				static_learned: HashMap::new(),
				closed:         false,
			}),
			instance_id,
			parts: tokio::sync::Mutex::new(Parts::default()),
			signals: Arc::new(Signals::default()),
			background: Mutex::new(Vec::new()),
		});
		let signals = &node.signals;
		let tasks = vec![
			tokio::spawn(peers_debounce_loop(Arc::downgrade(&node), Arc::clone(signals))),
			tokio::spawn(local_poll_loop(Arc::downgrade(&node), Arc::clone(signals))),
			tokio::spawn(refresh_loop(Arc::downgrade(&node), Arc::clone(signals))),
		];
		*node.background.lock() = tasks;
		node
	}

	pub fn instance_id(&self) -> &str {
		&self.instance_id
	}

	fn arc(&self) -> Arc<Self> {
		self.me.upgrade().expect("MeshNode used after drop")
	}

	fn sink(&self) -> Arc<dyn InboundSink> {
		Arc::new(NodeSink(self.me.clone()))
	}

	fn mark_peers_dirty(&self) {
		self.signals.peers_dirty.notify_one();
	}

	pub fn status(&self) -> NodeStatus {
		self.state.lock().status.clone()
	}

	pub fn peers(&self) -> Vec<PeerInfo> {
		self.state.lock().table.infos()
	}

	/// Validates and stores the snapshot served for `snapshot` requests.
	/// Unknown fields are dropped.
	///
	/// # Errors
	/// Malformed snapshot, one naming another instance, or one too large to
	/// fit a response envelope.
	pub fn set_snapshot(&self, json: &str) -> Result<(), ProtocolError> {
		let value: Value = serde_json::from_str(json)
			.map_err(|e| ProtocolError::bad_request(format!("malformed mesh snapshot: {e}")))?;
		let snapshot = parse_snapshot(&value)?;
		if snapshot.instance_id != self.instance_id {
			return Err(ProtocolError::bad_request("snapshot instanceId is not this node's"));
		}
		let encoded = serde_json::to_string(&snapshot)
			.map_err(|e| ProtocolError::bad_request(format!("cannot encode mesh snapshot: {e}")))?;
		let max = MAX_ENVELOPE_BYTES - SNAPSHOT_RESPONSE_OVERHEAD;
		if encoded.len() > max {
			return Err(ProtocolError::too_large(format!(
				"mesh snapshot is {} bytes (max {max})",
				encoded.len()
			)));
		}
		self.state.lock().snapshot = Some(Arc::from(encoded));
		Ok(())
	}

	/// Re-query mDNS, re-list local peers, re-probe static peers and refetch
	/// snapshots now.
	pub fn refresh(&self) {
		let mdns = self.state.lock().mdns.clone();
		if let Some(mdns) = mdns {
			mdns.refresh();
		}
		self.signals.wake_local.notify_one();
		self.signals.wake_refresh.notify_one();
	}

	/// In-memory hide/block flags; blocked senders are denied.
	pub fn set_peer_flags(&self, instance_id: &str, hidden: bool, blocked: bool) {
		if self
			.state
			.lock()
			.table
			.set_flags(instance_id, hidden, blocked)
		{
			self.mark_peers_dirty();
		}
	}

	/// Answers an [`NodeEvent::Inbound`]; false when unknown or timed out.
	pub fn respond(&self, request_id: &str, response: MeshResponse) -> bool {
		self.state.lock().pending.complete(request_id, response)
	}

	fn envelope(&self, to: &str, agent_id: &str, body: MeshRequest) -> MeshEnvelope {
		let st = self.state.lock();
		let display_name = if st.display_name.trim().is_empty() {
			self.instance_id.clone()
		} else {
			st.display_name.clone()
		};
		MeshEnvelope {
			v: PROTOCOL_VERSION,
			msg_id: new_msg_id(),
			sent_at: now_ms(),
			hop: 0,
			from: MeshSender {
				instance_id: self.instance_id.clone(),
				agent_id: agent_id.to_owned(),
				display_name,
				host: if self.host_name.is_empty() {
					"unknown".to_owned()
				} else {
					self.host_name.clone()
				},
				lan_port: st.lan_port.filter(|_| st.remote_on),
			},
			to: to.to_owned(),
			body,
		}
	}

	/// Sends `body` to peer `to` (local endpoint preferred) and waits for its
	/// response. Drop the future to abort.
	///
	/// # Errors
	/// `unreachable` for unknown peers or failed delivery, `timeout`,
	/// `bad_response`.
	pub async fn request(
		&self,
		to: &str,
		from_agent_id: &str,
		body: MeshRequest,
		timeout: Duration,
	) -> Result<MeshResponse, TransportError> {
		let (endpoint, client) = {
			let st = self.state.lock();
			let endpoint = st
				.table
				.route(to, st.local_on, st.remote_on)
				.ok_or_else(|| TransportError::Unreachable(format!("no reachable mesh peer {to}")))?;
			(endpoint, st.client.clone())
		};
		let env = self.envelope(to, from_agent_id, body);
		let result = client.request(&endpoint, &env, timeout).await;
		let ok = match &result {
			Ok(MeshResponse::Err { code: MeshErrorCode::Unauthorized, .. }) => false,
			Ok(_) => true,
			Err(err) => {
				self.on_misdirected(to, &endpoint, err);
				false
			},
		};
		self.note_outcome(to, ok);
		result
	}

	fn note_outcome(&self, id: &str, ok: bool) {
		let changed = {
			let mut st = self.state.lock();
			if ok {
				st.table.contact_ok(id, now_ms())
			} else {
				st.table.contact_failed(id, Instant::now())
			}
		};
		if changed {
			self.mark_peers_dirty();
		}
	}

	/// A local endpoint that now serves another instance (or, on Windows, a
	/// pipe served by another process) is a stale registry entry: drop the
	/// route, and the entry only if it is still the publication we dialed (a
	/// republished entry stays).
	fn on_misdirected(&self, id: &str, endpoint: &Endpoint, err: &TransportError) {
		let (TransportError::Misdirected, Endpoint::Local(entry)) = (err, endpoint) else {
			return;
		};
		let dropped = self
			.state
			.lock()
			.table
			.drop_local_if(id, &entry.endpoint, &entry.token);
		let Some(stale) = dropped else {
			return;
		};
		self.mark_peers_dirty();
		let dir = self.instances.dir().to_owned();
		tokio::task::spawn_blocking(move || {
			let _ =
				pi_instances::remove_entry_if(&dir, &stale.instance_id, &stale.token, stale.created_at);
		});
	}

	/// Reconciles running parts with `cfg`; only changed parts restart.
	pub async fn configure(&self, cfg: NodeConfig) -> NodeStatus {
		let mut parts = self.parts.lock().await;
		if self.state.lock().closed {
			return self.status();
		}
		self.state.lock().display_name.clone_from(&cfg.display_name);
		let mut errors = Vec::new();
		let mut dirty = false;
		let local = self
			.reconcile_local(&mut parts, cfg.mode.local(), &mut errors, &mut dirty)
			.await;
		let (remote, lan_port) = self
			.reconcile_remote(&mut parts, &cfg, &mut errors, &mut dirty)
			.await;
		let changed = {
			let mut st = self.state.lock();
			st.config_error = (!errors.is_empty()).then(|| errors.join("; "));
			if remote != RemoteState::On {
				st.mdns_error = None;
			}
			let status =
				NodeStatus { mode: cfg.mode, local, remote, lan_port, error: st.compose_error() };
			let changed = st.status != status;
			st.status = status;
			changed
		};
		if changed {
			let _ = self.events.send(NodeEvent::Status(self.status()));
		}
		if dirty {
			self.mark_peers_dirty();
		}
		self.status()
	}

	async fn reconcile_local(
		&self,
		parts: &mut Parts,
		want: bool,
		errors: &mut Vec<String>,
		dirty: &mut bool,
	) -> LocalState {
		if !want {
			if let Some(registration) = parts.local.take() {
				registration.unregister().await;
			}
			let mut st = self.state.lock();
			st.local_on = false;
			*dirty |= st.table.clear_local();
			return LocalState::Off;
		}
		if parts.local.is_none() {
			let namespace = Arc::new(MeshNamespace::new(self.sink()));
			match self
				.instances
				.register(instance::NAMESPACE, namespace)
				.await
			{
				Ok(registration) => parts.local = Some(registration),
				Err(err) => {
					errors.push(format!("local: {err}"));
					return LocalState::Error;
				},
			}
		}
		self.state.lock().local_on = true;
		self.signals.wake_local.notify_one();
		LocalState::On
	}

	async fn stop_remote(&self, parts: &mut Parts) -> bool {
		if let Some(remote) = parts.remote.take() {
			if let Some(mdns) = remote.mdns {
				mdns.handle.stop().await;
				mdns.task.abort();
			}
			remote.lan.close().await;
		}
		let mut st = self.state.lock();
		st.remote_on = false;
		st.lan_port = None;
		st.mdns = None;
		st.client = MeshClient::new(None);
		st.static_specs.clear();
		st.static_learned.clear();
		st.table.clear_remote()
	}

	async fn reconcile_remote(
		&self,
		parts: &mut Parts,
		cfg: &NodeConfig,
		errors: &mut Vec<String>,
		dirty: &mut bool,
	) -> (RemoteState, Option<u16>) {
		if !cfg.mode.remote() {
			*dirty |= self.stop_remote(parts).await;
			return (RemoteState::Off, None);
		}
		let Some(key) = cfg.key.as_deref().map(str::trim).filter(|k| !k.is_empty()) else {
			*dirty |= self.stop_remote(parts).await;
			return (RemoteState::NoKey, None);
		};
		let keys = match MeshKeys::load(key) {
			Ok(keys) => Arc::new(keys),
			Err(err) => {
				*dirty |= self.stop_remote(parts).await;
				errors.push(format!("remote: {err}"));
				return (RemoteState::Error, None);
			},
		};
		let keep_lan = parts
			.remote
			.as_ref()
			.is_some_and(|r| r.key == key && r.cfg_port == cfg.lan_port);
		if !keep_lan {
			*dirty |= self.stop_remote(parts).await;
			let guard = match &parts.replay {
				Some((k, guard)) if k == key => Arc::clone(guard),
				_ => {
					let guard = Arc::new(Mutex::new(ReplayGuard::default()));
					parts.replay = Some((key.to_owned(), Arc::clone(&guard)));
					guard
				},
			};
			let bind = SocketAddr::new(self.seams.lan_bind, cfg.lan_port);
			match LanListener::start(
				bind,
				self.instance_id.clone(),
				Arc::clone(&keys),
				guard,
				self.sink(),
			)
			.await
			{
				Ok(lan) => {
					let mut st = self.state.lock();
					st.remote_on = true;
					st.lan_port = Some(lan.port());
					st.client = MeshClient::new(Some(Arc::clone(&keys)));
					parts.remote = Some(RemotePart {
						key: key.to_owned(),
						cfg_port: cfg.lan_port,
						keys,
						lan,
						mdns: None,
					});
				},
				Err(err) => {
					errors.push(format!("remote: cannot listen on {bind}: {err}"));
					return (RemoteState::Error, None);
				},
			}
		}
		*dirty |= self.ensure_mdns(parts, &cfg.display_name).await;
		*dirty |= self.reconcile_static(&cfg.static_peers);
		let lan_port = parts.remote.as_ref().map(|r| r.lan.port());
		(RemoteState::On, lan_port)
	}

	/// Starts mDNS when missing (retry after a failure), restarts it when its
	/// identity changed or the host's interfaces require it. True when the
	/// visible peer list changed.
	async fn ensure_mdns(&self, parts: &mut Parts, display_name: &str) -> bool {
		let Some(remote) = parts.remote.as_mut() else {
			return false;
		};
		let lan_port = remote.lan.port();
		let key: MdnsKey = (remote.keys.group_tag().to_owned(), lan_port, display_name.to_owned());
		if remote
			.mdns
			.as_ref()
			.is_some_and(|m| m.key == key && !m.handle.needs_restart())
		{
			return false;
		}
		let dirty = if let Some(old) = remote.mdns.take() {
			old.handle.stop().await;
			old.task.abort();
			let mut st = self.state.lock();
			st.mdns = None;
			st.table.clear_mdns()
		} else {
			false
		};
		let (tx, rx) = mpsc::channel(64);
		let mdns_cfg = MdnsConfig {
			instance_id:  self.instance_id.clone(),
			display_name: if display_name.trim().is_empty() {
				self.instance_id.clone()
			} else {
				display_name.to_owned()
			},
			port:         lan_port,
			group_tag:    key.0.clone(),
		};
		match self.seams.mdns.start(mdns_cfg, tx) {
			Ok(handle) => {
				let task = tokio::spawn(mdns_event_loop(self.me.clone(), rx));
				let mut st = self.state.lock();
				st.mdns = Some(Arc::clone(&handle));
				st.mdns_error = None;
				remote.mdns = Some(MdnsPart { key, handle, task });
			},
			Err(err) => self.state.lock().mdns_error = Some(err),
		}
		dirty
	}

	/// Refresh-loop hook: retry/restart mDNS and publish a changed status.
	async fn maintain_mdns(&self) {
		let mut parts = self.parts.lock().await;
		let display_name = {
			let st = self.state.lock();
			if st.closed || !st.remote_on {
				return;
			}
			st.display_name.clone()
		};
		let dirty = self.ensure_mdns(&mut parts, &display_name).await;
		drop(parts);
		if dirty {
			self.mark_peers_dirty();
		}
		let status = {
			let mut st = self.state.lock();
			let error = st.compose_error();
			if st.status.error == error {
				return;
			}
			st.status.error = error;
			st.status.clone()
		};
		let _ = self.events.send(NodeEvent::Status(status));
	}

	fn reconcile_static(&self, specs: &[String]) -> bool {
		let mut st = self.state.lock();
		if st.static_specs == specs {
			return false;
		}
		st.static_specs = specs.to_vec();
		st.static_learned.retain(|spec, _| specs.contains(spec));
		let keep = st.static_keep();
		let changed = st.table.retain_static(&keep);
		drop(st);
		self.signals.wake_refresh.notify_one();
		changed
	}

	/// Stops every part and fails pending inbound requests. The node stays
	/// usable for reads; `configure` becomes a no-op.
	pub async fn close(&self) {
		let mut parts = self.parts.lock().await;
		let mut dirty = false;
		self
			.reconcile_local(&mut parts, false, &mut Vec::new(), &mut dirty)
			.await;
		self.stop_remote(&mut parts).await;
		parts.replay = None;
		{
			let mut st = self.state.lock();
			st.closed = true;
			st.pending.clear();
			st.status = NodeStatus::OFF;
		}
		for task in self.background.lock().drain(..) {
			task.abort();
		}
	}

	/// A peer gained a route: fetch its snapshot and (remote) its PTR name.
	fn on_new_endpoint(&self, id: &str) {
		let node = self.arc();
		let id = id.to_owned();
		tokio::spawn(async move {
			node.fetch_snapshot(&id).await;
			node.resolve_dns_name(&id).await;
		});
	}

	async fn resolve_dns_name(&self, id: &str) {
		let Some(ip) = self.state.lock().table.remote_ip(id) else {
			return;
		};
		let Some(name) = self.seams.rdns.lookup(ip).await else {
			return;
		};
		if self.state.lock().table.set_dns_name(id, ip, name) {
			self.mark_peers_dirty();
		}
	}

	async fn exchange_snapshot(
		&self,
		endpoint: &Endpoint,
		to: &str,
		expected: Option<&str>,
	) -> Fetched {
		let client = self.state.lock().client.clone();
		let env = self.envelope(to, ENGINE_AGENT_ID, MeshRequest::Snapshot);
		let result = client
			.request(endpoint, &env, self.seams.probe_timeout)
			.await;
		classify_snapshot(result, expected, &self.instance_id)
	}

	/// Refetches `id`'s snapshot over its current route.
	async fn fetch_snapshot(&self, id: &str) {
		let endpoint = {
			let st = self.state.lock();
			let Some(endpoint) = st.table.route(id, st.local_on, st.remote_on) else {
				return;
			};
			endpoint
		};
		let fetched = self.exchange_snapshot(&endpoint, id, Some(id)).await;
		if let Fetched::Failed(err) = &fetched {
			self.on_misdirected(id, &endpoint, err);
		}
		let changed = {
			let mut st = self.state.lock();
			match fetched {
				Fetched::Snapshot { json, .. } => st.table.snapshot_ok(id, json, now_ms()),
				Fetched::Alive => st.table.fetch_answered(id, now_ms(), Instant::now()),
				Fetched::Rejected | Fetched::Failed(_) => st.table.contact_failed(id, Instant::now()),
			}
		};
		if changed {
			self.mark_peers_dirty();
		}
	}

	/// Promotes an mDNS candidate once a sealed snapshot over it names `id`.
	/// A failed attempt leaves the candidate for the next refresh.
	async fn verify_candidate(&self, id: &str, addr: SocketAddr) {
		let fetched = self
			.exchange_snapshot(&Endpoint::Remote { addr }, id, Some(id))
			.await;
		let Fetched::Snapshot { json, .. } = fetched else {
			return;
		};
		let change = self
			.state
			.lock()
			.table
			.promote_mdns(id, addr, json, now_ms());
		if change.changed {
			self.mark_peers_dirty();
		}
		if change.new_endpoint || change.changed {
			self.resolve_dns_name(id).await;
		}
	}

	/// Asks a static `host:port` who it is (`to: "*"` snapshot). Returns the
	/// id now answering there, or the previously learned id when the probe
	/// failed (both count as handled for this refresh round).
	async fn probe_static(&self, spec: &str) -> Option<String> {
		if !self.state.lock().remote_on {
			return None;
		}
		let fetched = match resolve_static(spec, self.seams.probe_timeout).await {
			Some(addr) => {
				let fetched = self
					.exchange_snapshot(&Endpoint::Remote { addr }, ANY_INSTANCE, None)
					.await;
				Some((addr, fetched))
			},
			None => None,
		};
		let (id, new_endpoint) = self.record_static_probe(spec, fetched)?;
		if new_endpoint {
			self.resolve_dns_name(&id).await;
		}
		Some(id)
	}

	/// Applies a static probe result; returns the id handled and whether it
	/// gained a new address.
	fn record_static_probe(
		&self,
		spec: &str,
		fetched: Option<(SocketAddr, Fetched)>,
	) -> Option<(String, bool)> {
		let mut st = self.state.lock();
		if !st.static_specs.iter().any(|s| s == spec) {
			return None;
		}
		let Some((addr, Fetched::Snapshot { id, json })) = fetched else {
			let known = st.static_learned.get(spec).map(|(_, id)| id.clone())?;
			if st.table.contact_failed(&known, Instant::now()) {
				self.mark_peers_dirty();
			}
			return Some((known, false));
		};
		let previous = st
			.static_learned
			.insert(spec.to_owned(), (addr, id.clone()));
		if previous.is_some_and(|prev| prev != (addr, id.clone())) {
			let keep = st.static_keep();
			st.table.retain_static(&keep);
		}
		let change = st.table.static_up(&id, addr, json, now_ms());
		if change.changed {
			self.mark_peers_dirty();
		}
		Some((id, change.new_endpoint))
	}

	async fn handle_inbound(&self, env: MeshEnvelope, origin: Origin) -> MeshResponse {
		let source_ip = match (origin.kind, origin.addr) {
			(OriginKind::Remote, Some(addr)) => Some(addr.ip().to_canonical()),
			_ => None,
		};
		let (request_id, rx) = {
			let mut st = self.state.lock();
			if st.closed {
				return MeshResponse::error(MeshErrorCode::Internal, "mesh node is closed");
			}
			let blocked = st.table.is_blocked(&env.from.instance_id);
			match admit(&env, source_ip, blocked, &mut st.limits, Instant::now()) {
				Admission::Reject(response) => return response,
				Admission::Snapshot => {
					let snapshot = st.snapshot.clone();
					drop(st);
					return snapshot.map_or_else(
						|| {
							MeshResponse::error(
								MeshErrorCode::Unsupported,
								"no mesh snapshot published yet",
							)
						},
						MeshResponse::OkRaw,
					);
				},
				Admission::Dispatch => {},
			}
			let Some(slot) = st.pending.insert() else {
				return MeshResponse::error(MeshErrorCode::Busy, "too many pending mesh requests");
			};
			self.learn_contact(&mut st, &env, origin);
			slot
		};
		let _guard = PendingGuard { node: self, id: &request_id };
		if self
			.events
			.send(NodeEvent::Inbound {
				request_id: request_id.clone(),
				envelope: Box::new(env),
				origin,
			})
			.is_err()
		{
			return MeshResponse::error(MeshErrorCode::Internal, "mesh frontend is gone");
		}
		match tokio::time::timeout(self.seams.respond_timeout, rx).await {
			Ok(Ok(response)) => response,
			Ok(Err(_)) => MeshResponse::error(MeshErrorCode::Internal, "mesh node closed"),
			Err(_) => {
				MeshResponse::error(MeshErrorCode::Internal, "no response from the recipient in time")
			},
		}
	}

	/// From a dispatched (rate-limited) request only. Remote: origin IP +
	/// advertised LAN port. Local: re-list the registry.
	fn learn_contact(&self, st: &mut State, env: &MeshEnvelope, origin: Origin) {
		let id = &env.from.instance_id;
		match origin.kind {
			OriginKind::Remote => {
				let (Some(port), Some(from)) =
					(env.from.lan_port.filter(|_| st.remote_on), origin.addr)
				else {
					return;
				};
				let addr = SocketAddr::new(from.ip().to_canonical(), port);
				let change = st.table.learn_contact(id, addr, now_ms());
				if change.changed {
					self.mark_peers_dirty();
				}
				if change.new_endpoint {
					self.on_new_endpoint(id);
				}
			},
			OriginKind::Local => {
				if st.local_on && !matches!(st.table.route(id, true, false), Some(Endpoint::Local(_))) {
					self.signals.wake_local.notify_one();
				}
			},
		}
	}

	/// Re-list live `mesh` instances (connect-only check; snapshots are
	/// fetched for new peers and on the refresh loop). An unusable registry
	/// directory lists empty.
	async fn poll_local(&self) {
		if !self.state.lock().local_on {
			return;
		}
		// Self-heal: a racing prune elsewhere may have removed our entry.
		let host = Arc::clone(&self.instances);
		let _ = tokio::task::spawn_blocking(move || host.ensure_published()).await;
		let listing = pi_instances::list_alive(
			self.instances.dir(),
			instance::NAMESPACE,
			Some(&self.instance_id),
			LOCAL_PROBE_TIMEOUT,
		)
		.await
		.unwrap_or_default();
		let (changed, fresh) = {
			let mut st = self.state.lock();
			if !st.local_on {
				return;
			}
			st.table.set_local_listing(&listing, now_ms())
		};
		if changed {
			self.mark_peers_dirty();
		}
		for id in fresh {
			self.on_new_endpoint(&id);
		}
	}

	async fn refresh_all(&self) {
		self.maintain_mdns().await;
		let specs = self.state.lock().static_specs.clone();
		let mut probed = HashSet::new();
		let mut probes = JoinSet::new();
		for spec in specs {
			let node = self.arc();
			probes.spawn(async move { node.probe_static(&spec).await });
		}
		while let Some(result) = probes.join_next().await {
			if let Ok(Some(id)) = result {
				probed.insert(id);
			}
		}
		let (ids, candidates) = {
			let st = self.state.lock();
			let ids: Vec<String> = st
				.table
				.refresh_ids()
				.into_iter()
				.filter(|id| !probed.contains(id))
				.collect();
			(ids, st.table.mdns_candidates())
		};
		let mut fetches = JoinSet::new();
		for id in ids {
			let node = self.arc();
			fetches.spawn(async move { node.fetch_snapshot(&id).await });
		}
		for (id, addr) in candidates {
			let node = self.arc();
			fetches.spawn(async move { node.verify_candidate(&id, addr).await });
		}
		while fetches.join_next().await.is_some() {}
		if self.state.lock().table.sweep(Instant::now()) {
			self.mark_peers_dirty();
		}
	}

	fn on_discovery(&self, event: DiscoveryEvent) {
		match event {
			DiscoveryEvent::PeerUp(peer) => {
				if (self.seams.is_same_machine)(peer.address) {
					// Same PC: reachable through the local side only.
					if self.state.lock().table.mdns_down(&peer.instance_id) {
						self.mark_peers_dirty();
					}
					return;
				}
				let ep = MdnsEndpoint {
					addr:     SocketAddr::new(peer.address, peer.port),
					hostname: peer.hostname,
				};
				let candidate = self
					.state
					.lock()
					.table
					.mdns_up(&peer.instance_id, ep, now_ms());
				if let Some(addr) = candidate {
					let node = self.arc();
					tokio::spawn(async move { node.verify_candidate(&peer.instance_id, addr).await });
				}
			},
			DiscoveryEvent::PeerDown { instance_id } => {
				if self.state.lock().table.mdns_down(&instance_id) {
					self.mark_peers_dirty();
				}
			},
		}
	}
}

/// Removes a pending entry when the inbound handler finishes or is dropped.
struct PendingGuard<'a> {
	node: &'a MeshNode,
	id:   &'a str,
}

impl Drop for PendingGuard<'_> {
	fn drop(&mut self) {
		self.node.state.lock().pending.remove(self.id);
	}
}

impl Drop for MeshNode {
	fn drop(&mut self) {
		for task in self.background.get_mut().drain(..) {
			task.abort();
		}
	}
}

struct NodeSink(Weak<MeshNode>);

impl InboundSink for NodeSink {
	fn handle(&self, envelope: MeshEnvelope, origin: Origin) -> BoxFuture<MeshResponse> {
		let node = self.0.upgrade();
		Box::pin(async move {
			match node {
				Some(node) => node.handle_inbound(envelope, origin).await,
				None => MeshResponse::error(MeshErrorCode::Internal, "mesh node is gone"),
			}
		})
	}
}

/// First address of `host:port`, IPv4 preferred.
async fn resolve_static(spec: &str, timeout: Duration) -> Option<SocketAddr> {
	let addrs: Vec<SocketAddr> = tokio::time::timeout(timeout, tokio::net::lookup_host(spec))
		.await
		.ok()?
		.ok()?
		.collect();
	addrs
		.iter()
		.find(|a| a.is_ipv4())
		.or_else(|| addrs.first())
		.copied()
}

async fn peers_debounce_loop(node: Weak<MeshNode>, signals: Arc<Signals>) {
	loop {
		signals.peers_dirty.notified().await;
		tokio::time::sleep(PEERS_DEBOUNCE).await;
		let Some(node) = node.upgrade() else {
			return;
		};
		if node.state.lock().closed || node.events.send(NodeEvent::Peers).is_err() {
			return;
		}
	}
}

async fn local_poll_loop(node: Weak<MeshNode>, signals: Arc<Signals>) {
	loop {
		let Some(interval) = node.upgrade().map(|n| n.seams.local_poll) else {
			return;
		};
		tokio::select! {
			() = signals.wake_local.notified() => {},
			() = tokio::time::sleep(interval) => {},
		}
		let Some(node) = node.upgrade() else {
			return;
		};
		node.poll_local().await;
	}
}

async fn refresh_loop(node: Weak<MeshNode>, signals: Arc<Signals>) {
	loop {
		let Some(interval) = node.upgrade().map(|n| n.seams.snapshot_refresh) else {
			return;
		};
		tokio::select! {
			() = signals.wake_refresh.notified() => {},
			() = tokio::time::sleep(interval) => {},
		}
		let Some(node) = node.upgrade() else {
			return;
		};
		node.refresh_all().await;
	}
}

async fn mdns_event_loop(node: Weak<MeshNode>, mut rx: mpsc::Receiver<DiscoveryEvent>) {
	while let Some(event) = rx.recv().await {
		let Some(node) = node.upgrade() else {
			return;
		};
		node.on_discovery(event);
	}
}
