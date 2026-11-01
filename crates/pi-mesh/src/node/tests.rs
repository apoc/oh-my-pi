//! Node integration over real transports (instance hosts in temp registry
//! directories, loopback LAN); mDNS replaced by a fake, reverse DNS by a
//! resolver that never answers.

use std::{
	net::{IpAddr, Ipv4Addr, TcpListener},
	path::Path,
	sync::{
		Arc,
		atomic::{AtomicUsize, Ordering},
	},
	time::Duration,
};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use parking_lot::Mutex;
use serde_json::json;
use tokio::sync::mpsc;

use super::*;
use crate::{
	discovery::MdnsPeer,
	net::ReverseDnsConfig,
	protocol::{MeshErrorCode, MessageKind},
	transport::instance,
};

const A: &str = "aaaaaaaaaaaaaaa1";
const B: &str = "bbbbbbbbbbbbbbb2";
const C: &str = "ccccccccccccccc3";

#[derive(Default)]
struct FakeMdns {
	starts:    Mutex<Vec<MdnsConfig>>,
	stops:     Arc<AtomicUsize>,
	tx:        Mutex<Option<mpsc::Sender<DiscoveryEvent>>>,
	/// Peers a stopping discovery reports down, like the real one.
	announced: Arc<Mutex<Vec<String>>>,
}

struct FakeHandle {
	stops:     Arc<AtomicUsize>,
	events:    mpsc::Sender<DiscoveryEvent>,
	announced: Arc<Mutex<Vec<String>>>,
}

impl MdnsHandle for FakeHandle {
	fn refresh(&self) {}

	fn needs_restart(&self) -> bool {
		false
	}

	fn stop(&self) -> BoxFuture<()> {
		self.stops.fetch_add(1, Ordering::SeqCst);
		for id in self.announced.lock().iter() {
			let _ = self
				.events
				.try_send(DiscoveryEvent::PeerDown { instance_id: id.clone() });
		}
		// Let the still-running event loop handle them before it is aborted.
		Box::pin(async {
			for _ in 0..3 {
				tokio::task::yield_now().await;
			}
		})
	}
}

impl FakeMdns {
	fn start(&self, cfg: MdnsConfig, events: mpsc::Sender<DiscoveryEvent>) -> Arc<dyn MdnsHandle> {
		self.starts.lock().push(cfg);
		*self.tx.lock() = Some(events.clone());
		Arc::new(FakeHandle {
			stops: Arc::clone(&self.stops),
			events,
			announced: Arc::clone(&self.announced),
		})
	}

	async fn emit(&self, event: DiscoveryEvent) {
		let tx = self.tx.lock().clone().expect("mdns started");
		tx.send(event).await.unwrap();
	}
}

struct Opts {
	same_machine:    fn(IpAddr) -> bool,
	respond_timeout: Duration,
}

impl Default for Opts {
	fn default() -> Self {
		Self { same_machine: |ip| ip.is_loopback(), respond_timeout: Duration::from_secs(30) }
	}
}

fn node(
	id: &str,
	dir: &Path,
	mdns: &Arc<FakeMdns>,
	opts: Opts,
) -> (Arc<MeshNode>, mpsc::UnboundedReceiver<NodeEvent>) {
	let host = Arc::new(InstanceHost::new(dir, Some(id.into())).unwrap());
	node_on(host, mdns, opts)
}

fn node_on(
	host: Arc<InstanceHost>,
	mdns: &Arc<FakeMdns>,
	opts: Opts,
) -> (Arc<MeshNode>, mpsc::UnboundedReceiver<NodeEvent>) {
	let (tx, rx) = mpsc::unbounded_channel();
	let fake = Arc::clone(mdns);
	let seams = Seams {
		mdns:             Arc::new(move |cfg, events| Ok(fake.start(cfg, events))),
		is_same_machine:  opts.same_machine,
		rdns:             ReverseDns::with_resolver(ReverseDnsConfig::default(), Arc::new(|_| None)),
		lan_bind:         IpAddr::V4(Ipv4Addr::LOCALHOST),
		local_poll:       Duration::from_secs(60),
		snapshot_refresh: Duration::from_secs(60),
		respond_timeout:  opts.respond_timeout,
		probe_timeout:    Duration::from_secs(2),
	};
	let opts = NodeOptions { host, host_name: "testhost".into() };
	(MeshNode::with_seams(opts, tx, seams), rx)
}

/// Live `mesh` entries in `dir` (own included).
async fn listed(dir: &Path) -> usize {
	pi_instances::list_alive(dir, instance::NAMESPACE, None, Duration::from_secs(2))
		.await
		.unwrap()
		.len()
}

fn key() -> String {
	URL_SAFE_NO_PAD.encode([7u8; 32])
}

fn cfg(mode: MeshMode, key: Option<String>, static_peers: Vec<String>, name: &str) -> NodeConfig {
	NodeConfig { mode, key, lan_port: 0, static_peers, display_name: name.into() }
}

fn snapshot_json(id: &str) -> String {
	json!({
		"instanceId": id, "displayName": id, "host": "testhost", "pid": 1, "ompVersion": "0",
		"protocol": 1, "sessionId": null, "sessionName": null, "summary": null, "cwd": "/",
		"repo": null, "model": null, "busy": false, "agents": [], "startedAt": 0, "extra": 1
	})
	.to_string()
}

async fn eventually(what: &str, mut ok: impl FnMut() -> bool) {
	for _ in 0..250 {
		if ok() {
			return;
		}
		tokio::time::sleep(Duration::from_millis(20)).await;
	}
	panic!("timed out waiting for {what}");
}

fn peer(node: &MeshNode, id: &str) -> Option<PeerInfo> {
	node.peers().into_iter().find(|p| p.instance_id == id)
}

fn mdns_peer(id: &str, addr: &str, port: u16) -> DiscoveryEvent {
	DiscoveryEvent::PeerUp(MdnsPeer {
		instance_id: id.into(),
		display_name: id.into(),
		group_tag: "g".into(),
		port,
		hostname: "box.local".into(),
		addresses: vec![addr.parse().unwrap()],
		address: addr.parse().unwrap(),
	})
}

/// A loopback port nothing listens on.
fn closed_port() -> u16 {
	TcpListener::bind("127.0.0.1:0")
		.unwrap()
		.local_addr()
		.unwrap()
		.port()
}

#[tokio::test]
async fn reconcile_starts_and_stops_only_changed_parts() {
	let dir = tempfile::tempdir().unwrap();
	let mdns = Arc::new(FakeMdns::default());
	let (a, _rx) = node(A, dir.path(), &mdns, Opts::default());
	let dir = dir.path();

	let st = a
		.configure(cfg(MeshMode::Local, Some(key()), vec![], "a"))
		.await;
	assert_eq!((st.local, st.remote, st.lan_port), (LocalState::On, RemoteState::Off, None));
	assert_eq!(listed(dir).await, 1);
	assert!(mdns.starts.lock().is_empty());

	let st = a
		.configure(cfg(MeshMode::Both, Some(key()), vec![], "a"))
		.await;
	assert_eq!((st.local, st.remote), (LocalState::On, RemoteState::On));
	let port = st.lan_port.expect("lan port");
	{
		let starts = mdns.starts.lock();
		assert_eq!(starts.len(), 1);
		let tag = MeshKeys::load(&key()).unwrap().group_tag().to_owned();
		assert_eq!((starts[0].group_tag.as_str(), starts[0].port), (tag.as_str(), port));
	}

	let again = a
		.configure(cfg(MeshMode::Both, Some(key()), vec![], "a"))
		.await;
	assert_eq!(again, st, "idempotent");
	assert_eq!(mdns.starts.lock().len(), 1, "nothing restarted");

	let renamed = a
		.configure(cfg(MeshMode::Both, Some(key()), vec![], "a2"))
		.await;
	assert_eq!(renamed.lan_port, Some(port), "LAN listener kept");
	assert_eq!(mdns.starts.lock().len(), 2, "mdns re-announced with new name");
	assert_eq!(mdns.stops.load(Ordering::SeqCst), 1);

	let st = a.configure(cfg(MeshMode::Remote, None, vec![], "a2")).await;
	assert_eq!((st.local, st.remote, st.lan_port), (LocalState::Off, RemoteState::NoKey, None));
	assert_eq!(listed(dir).await, 0, "mesh capability withdrawn");
	assert!(a.instances.entry().is_some(), "the shared host stays published");
	assert_eq!(mdns.stops.load(Ordering::SeqCst), 2);

	let st = a
		.configure(cfg(MeshMode::Remote, Some("not-a-key".into()), vec![], "a2"))
		.await;
	assert_eq!(st.remote, RemoteState::Error);
	assert!(st.error.is_some());

	let st = a
		.configure(cfg(MeshMode::Off, Some(key()), vec![], "a2"))
		.await;
	assert_eq!((st.local, st.remote, st.error), (LocalState::Off, RemoteState::Off, None));
	a.close().await;
}

#[tokio::test]
async fn static_probe_learns_id_and_same_machine_mdns_is_dropped() {
	let dir_a = tempfile::tempdir().unwrap();
	let dir_b = tempfile::tempdir().unwrap();
	let mdns = Arc::new(FakeMdns::default());
	let (a, _rx_a) = node(A, dir_a.path(), &mdns, Opts::default());
	let (b, _rx_b) = node(B, dir_b.path(), &Arc::new(FakeMdns::default()), Opts::default());
	b.set_snapshot(&snapshot_json(B)).unwrap();
	assert!(b.set_snapshot(&snapshot_json(C)).is_err(), "snapshot must name the node");
	let pb = b
		.configure(cfg(MeshMode::Remote, Some(key()), vec![], "b"))
		.await
		.lan_port
		.unwrap();

	a.configure(cfg(MeshMode::Remote, Some(key()), vec![format!("127.0.0.1:{pb}")], "a"))
		.await;
	eventually("static peer learned", || peer(&a, B).is_some()).await;
	let info = peer(&a, B).unwrap();
	assert_eq!(
		(info.source, info.endpoint_kind, info.port),
		(PeerSource::Static, EndpointKind::Remote, Some(pb))
	);
	assert!(!info.snapshot_json.unwrap().contains("extra"), "unknown snapshot fields dropped");

	mdns.emit(mdns_peer(B, "127.0.0.1", pb)).await;
	mdns.emit(mdns_peer(C, "192.0.2.3", 4000)).await;
	tokio::time::sleep(Duration::from_millis(100)).await;
	assert_eq!(peer(&a, B).unwrap().source, PeerSource::Static, "same-machine mDNS record ignored");
	assert!(peer(&a, C).is_none(), "unverified mDNS candidate is not listed");

	let st = a
		.configure(cfg(MeshMode::Remote, Some(key()), vec![], "a"))
		.await;
	assert_eq!(st.remote, RemoteState::On);
	assert!(peer(&a, B).is_none(), "static peer dropped with its spec");
	a.close().await;
	b.close().await;
}

#[tokio::test]
async fn mdns_candidate_becomes_route_only_after_verified_snapshot() {
	let dir_a = tempfile::tempdir().unwrap();
	let dir_b = tempfile::tempdir().unwrap();
	let mdns = Arc::new(FakeMdns::default());
	let lan_only = Opts { same_machine: |_| false, ..Opts::default() };
	let (a, _rx_a) = node(A, dir_a.path(), &mdns, lan_only);
	let (b, _rx_b) = node(B, dir_b.path(), &Arc::new(FakeMdns::default()), Opts::default());
	b.set_snapshot(&snapshot_json(B)).unwrap();
	let pb = b
		.configure(cfg(MeshMode::Remote, Some(key()), vec![], "b"))
		.await
		.lan_port
		.unwrap();
	a.configure(cfg(MeshMode::Remote, Some(key()), vec![], "a"))
		.await;

	mdns.emit(mdns_peer(B, "127.0.0.1", pb)).await;
	eventually("verified mDNS peer", || peer(&a, B).is_some_and(|p| p.source == PeerSource::Mdns))
		.await;
	assert_eq!(peer(&a, B).unwrap().port, Some(pb));

	// Spoofed records: B's id at a dead address, C's id at B's address.
	mdns.emit(mdns_peer(B, "127.0.0.1", closed_port())).await;
	mdns.emit(mdns_peer(C, "127.0.0.1", pb)).await;
	a.refresh();
	tokio::time::sleep(Duration::from_millis(300)).await;
	assert_eq!(peer(&a, B).unwrap().port, Some(pb), "working route kept");
	assert!(peer(&a, C).is_none(), "C's record answered as B: never verified");
	a.close().await;
	b.close().await;
}

#[tokio::test]
async fn failed_mdns_candidate_is_retried_and_promoted_later() {
	let dir_a = tempfile::tempdir().unwrap();
	let dir_b = tempfile::tempdir().unwrap();
	let mdns = Arc::new(FakeMdns::default());
	let lan_only = Opts { same_machine: |_| false, ..Opts::default() };
	let (a, _rx_a) = node(A, dir_a.path(), &mdns, lan_only);
	let (b, _rx_b) = node(B, dir_b.path(), &Arc::new(FakeMdns::default()), Opts::default());
	let pb = b
		.configure(cfg(MeshMode::Remote, Some(key()), vec![], "b"))
		.await
		.lan_port
		.unwrap();
	a.configure(cfg(MeshMode::Remote, Some(key()), vec![], "a"))
		.await;

	// B has no snapshot yet: the first verification fails.
	mdns.emit(mdns_peer(B, "127.0.0.1", pb)).await;
	tokio::time::sleep(Duration::from_millis(200)).await;
	assert!(peer(&a, B).is_none());

	b.set_snapshot(&snapshot_json(B)).unwrap();
	a.refresh();
	eventually("candidate promoted on a later refresh", || {
		peer(&a, B).is_some_and(|p| p.source == PeerSource::Mdns)
	})
	.await;
	a.close().await;
	b.close().await;
}

/// Answers every inbound request on `rx` with `answer` (or never, when None);
/// returns the envelopes and request ids seen once `count` arrived.
fn responder(
	node: Arc<MeshNode>,
	mut rx: mpsc::UnboundedReceiver<NodeEvent>,
	answer: Option<MeshResponse>,
	count: usize,
) -> tokio::task::JoinHandle<Vec<(String, MeshEnvelope)>> {
	tokio::spawn(async move {
		let mut seen = Vec::new();
		while let Some(event) = rx.recv().await {
			if let NodeEvent::Inbound { request_id, envelope, .. } = event {
				if let Some(answer) = &answer {
					assert!(node.respond(&request_id, answer.clone()));
				}
				seen.push((request_id, *envelope));
				if seen.len() == count {
					break;
				}
			}
		}
		seen
	})
}

fn note() -> MeshRequest {
	MeshRequest::Message { kind: MessageKind::Note, text: "hi".into(), thread: None }
}

fn err_code(r: &MeshResponse) -> Option<MeshErrorCode> {
	match r {
		MeshResponse::Err { code, .. } => Some(*code),
		MeshResponse::Ok(_) | MeshResponse::OkRaw(_) => None,
	}
}

#[tokio::test]
async fn local_route_preferred_inbound_roundtrip_and_blocking() {
	let dir = tempfile::tempdir().unwrap();
	let (a, _rx_a) = node(A, dir.path(), &Arc::new(FakeMdns::default()), Opts::default());
	let (b, rx_b) = node(B, dir.path(), &Arc::new(FakeMdns::default()), Opts::default());
	b.set_snapshot(&snapshot_json(B)).unwrap();
	let pb = b
		.configure(cfg(MeshMode::Both, Some(key()), vec![], "b"))
		.await
		.lan_port
		.unwrap();
	let pa = a
		.configure(cfg(MeshMode::Both, Some(key()), vec![format!("127.0.0.1:{pb}")], "a"))
		.await
		.lan_port;
	a.refresh();
	eventually("B listed locally", || peer(&a, B).is_some_and(|p| p.source == PeerSource::Local))
		.await;
	assert_eq!(peer(&a, B).unwrap().endpoint_kind, EndpointKind::Local, "local beats static");

	let ok = MeshResponse::Ok(json!({"threads": []}));
	let answers = responder(Arc::clone(&b), rx_b, Some(ok.clone()), 2);
	let resp = a
		.request(B, "Main", MeshRequest::Threads, Duration::from_secs(5), None)
		.await
		.unwrap();
	assert_eq!(resp, ok);
	eventually("B learned A from the inbound contact", || peer(&b, A).is_some()).await;

	b.set_peer_flags(A, None, Some(true));
	let denied = a
		.request(B, "Main", MeshRequest::Threads, Duration::from_secs(5), None)
		.await
		.unwrap();
	assert_eq!(err_code(&denied), Some(MeshErrorCode::Denied));
	b.set_peer_flags(A, None, Some(false));
	a.request(B, "Main", MeshRequest::Threads, Duration::from_secs(5), None)
		.await
		.unwrap();

	let seen = answers.await.unwrap();
	assert_eq!(seen.len(), 2, "blocked request never reached the frontend");
	let first = &seen[0].1;
	assert_eq!((first.hop, first.from.instance_id.as_str(), first.from.lan_port), (0, A, pa));

	let unknown = a
		.request(C, "Main", note(), Duration::from_secs(1), None)
		.await;
	assert_eq!(unknown.unwrap_err().code(), "unreachable");
	a.close().await;
	b.close().await;
}

#[tokio::test]
async fn unanswered_inbound_times_out_as_internal_and_frees_its_slot() {
	let dir = tempfile::tempdir().unwrap();
	let (a, _rx_a) = node(A, dir.path(), &Arc::new(FakeMdns::default()), Opts::default());
	let quick = Opts { respond_timeout: Duration::from_millis(200), ..Opts::default() };
	let (b, rx_b) = node(B, dir.path(), &Arc::new(FakeMdns::default()), quick);
	b.configure(cfg(MeshMode::Local, None, vec![], "b")).await;
	a.configure(cfg(MeshMode::Local, None, vec![], "a")).await;
	a.refresh();
	eventually("B listed", || peer(&a, B).is_some()).await;
	let silent = responder(Arc::clone(&b), rx_b, None, 1);
	let resp = a
		.request(B, "Main", note(), Duration::from_secs(5), None)
		.await
		.unwrap();
	assert_eq!(err_code(&resp), Some(MeshErrorCode::Internal));
	let (request_id, _) = silent.await.unwrap().remove(0);
	assert_eq!(b.state.lock().pending.len(), 0, "timed-out slot freed");
	assert!(!b.respond(&request_id, MeshResponse::Ok(json!(null))), "late respond ignored");

	let snap = a
		.request(B, "Main", MeshRequest::Snapshot, Duration::from_secs(5), None)
		.await
		.unwrap();
	assert_eq!(err_code(&snap), Some(MeshErrorCode::Unsupported), "no snapshot pushed yet");
	a.close().await;
	b.close().await;
}

#[tokio::test]
async fn contact_without_snapshot_is_listed_after_a_later_message() {
	let dir_a = tempfile::tempdir().unwrap();
	let dir_b = tempfile::tempdir().unwrap();
	let (a, rx_a) = node(A, dir_a.path(), &Arc::new(FakeMdns::default()), Opts::default());
	let (b, _rx_b) = node(B, dir_b.path(), &Arc::new(FakeMdns::default()), Opts::default());
	a.set_snapshot(&snapshot_json(A)).unwrap();
	let pa = a
		.configure(cfg(MeshMode::Remote, Some(key()), vec![], "a"))
		.await
		.lan_port
		.unwrap();
	b.configure(cfg(MeshMode::Remote, Some(key()), vec![format!("127.0.0.1:{pa}")], "b"))
		.await;
	eventually("B knows A via static", || peer(&b, A).is_some()).await;
	let _answers = responder(Arc::clone(&a), rx_a, Some(MeshResponse::Ok(json!(null))), 2);

	// B has no snapshot yet: A's fetch gets `unsupported`, B stays unlisted.
	b.request(A, "Main", note(), Duration::from_secs(5), None)
		.await
		.unwrap();
	tokio::time::sleep(Duration::from_millis(200)).await;
	assert!(peer(&a, B).is_none());

	b.set_snapshot(&snapshot_json(B)).unwrap();
	b.request(A, "Main", note(), Duration::from_secs(5), None)
		.await
		.unwrap();
	eventually("A lists B after the next message", || {
		peer(&a, B).is_some_and(|p| p.source == PeerSource::Contact)
	})
	.await;
	a.close().await;
	b.close().await;
}

#[tokio::test]
async fn oversized_snapshot_is_rejected() {
	let dir = tempfile::tempdir().unwrap();
	let (a, _rx) = node(A, dir.path(), &Arc::new(FakeMdns::default()), Opts::default());
	let mut snap: Value = serde_json::from_str(&snapshot_json(A)).unwrap();
	snap["agents"] = (0..255)
		.map(
			|i| json!({"id": format!("{i}"), "kind": "k", "displayName": "x".repeat(1000), "status": "s"}),
		)
		.collect();
	let err = a.set_snapshot(&snap.to_string()).unwrap_err();
	assert_eq!(err.code, MeshErrorCode::TooLarge);
	a.close().await;
}

#[tokio::test]
async fn dead_local_entry_is_pruned_and_unlisted() {
	let dir = tempfile::tempdir().unwrap();
	let (a, _rx_a) = node(A, dir.path(), &Arc::new(FakeMdns::default()), Opts::default());
	let (b, _rx_b) = node(B, dir.path(), &Arc::new(FakeMdns::default()), Opts::default());
	b.set_snapshot(&snapshot_json(B)).unwrap();
	b.configure(cfg(MeshMode::Local, None, vec![], "b")).await;
	a.configure(cfg(MeshMode::Local, None, vec![], "a")).await;
	a.refresh();
	eventually("B listed", || peer(&a, B).is_some_and(|p| p.source == PeerSource::Local)).await;

	// B crashes: its entry stays behind, its endpoint is gone.
	let entry_path = dir.path().join(format!("{B}.json"));
	let bytes = std::fs::read(&entry_path).unwrap();
	b.instances.close().await;
	std::fs::write(&entry_path, &bytes).unwrap();
	a.refresh();
	eventually("B unlisted", || peer(&a, B).is_none()).await;
	assert!(!entry_path.exists(), "dead entry pruned");
	a.close().await;
	b.close().await;
}

#[tokio::test]
async fn local_side_reports_instance_host_errors() {
	let dir = tempfile::tempdir().unwrap();
	let host = Arc::new(InstanceHost::new(dir.path(), Some(A.into())).unwrap());
	let mdns = Arc::new(FakeMdns::default());
	let local = || cfg(MeshMode::Local, None, vec![], "a");
	let (a, _rx_a) = node_on(Arc::clone(&host), &mdns, Opts::default());
	let (dup, _rx_dup) = node_on(Arc::clone(&host), &mdns, Opts::default());
	assert_eq!(a.instance_id(), A, "the node takes the host's id");
	assert_eq!(a.configure(local()).await.local, LocalState::On);
	let st = dup.configure(local()).await;
	assert_eq!(st.local, LocalState::Error);
	assert!(st.error.unwrap().contains("already registered"));
	a.close().await;
	dup.close().await;

	host.close().await;
	let (late, _rx_late) = node_on(host, &mdns, Opts::default());
	let st = late.configure(local()).await;
	assert_eq!(st.local, LocalState::Error);
	assert!(st.error.unwrap().contains("closed"));
	late.close().await;
}

#[expect(clippy::unnecessary_wraps, reason = "shaped like `request`'s `track` argument")]
fn tracked(ticket: &str, hold: bool) -> Option<Track> {
	Some(Track { ticket: ticket.into(), hold })
}

fn ask(text: &str, thread: Option<&str>) -> MeshRequest {
	MeshRequest::Message {
		kind:   MessageKind::Ask,
		text:   text.into(),
		thread: thread.map(Into::into),
	}
}

fn answer(reply_to: &str, text: &str) -> MeshRequest {
	MeshRequest::Reply {
		reply_to: reply_to.into(),
		thread:   None,
		text:     text.into(),
		error:    None,
	}
}

fn answer_text(env: &MeshEnvelope) -> &str {
	match &env.body {
		MeshRequest::Reply { text, .. } => text,
		_ => "",
	}
}

fn msg_id_of(resp: &MeshResponse) -> String {
	match resp {
		MeshResponse::Ok(data) => data["msgId"].as_str().unwrap().to_owned(),
		other => panic!("not acknowledged: {other:?}"),
	}
}

/// Next `Reply` / `PendingDropped` event on `rx` (others skipped).
async fn next_tracking_event(rx: &mut mpsc::UnboundedReceiver<NodeEvent>) -> NodeEvent {
	tokio::time::timeout(Duration::from_secs(5), async {
		loop {
			if let event @ (NodeEvent::Reply { .. } | NodeEvent::PendingDropped { .. }) =
				rx.recv().await.expect("event channel open")
			{
				return event;
			}
		}
	})
	.await
	.expect("tracking event in time")
}

/// A and B on one registry, each listing the other.
async fn local_pair(
	dir: &Path,
) -> (
	(Arc<MeshNode>, mpsc::UnboundedReceiver<NodeEvent>),
	(Arc<MeshNode>, mpsc::UnboundedReceiver<NodeEvent>),
) {
	let (a, rx_a) = node(A, dir, &Arc::new(FakeMdns::default()), Opts::default());
	let (b, rx_b) = node(B, dir, &Arc::new(FakeMdns::default()), Opts::default());
	a.configure(cfg(MeshMode::Local, None, vec![], "a")).await;
	b.configure(cfg(MeshMode::Local, None, vec![], "b")).await;
	a.refresh();
	b.refresh();
	eventually("A and B list each other", || peer(&a, B).is_some() && peer(&b, A).is_some()).await;
	((a, rx_a), (b, rx_b))
}

/// B's frontend: acknowledges messages (`bad` with a malformed ack; `early`
/// after first sending the answer, so it overtakes the ack) and watches
/// (`ttlSec` 7 with a malformed id).
fn ack_responder(b: Arc<MeshNode>, mut rx: mpsc::UnboundedReceiver<NodeEvent>) {
	tokio::spawn(async move {
		while let Some(event) = rx.recv().await {
			let NodeEvent::Inbound { request_id, envelope, .. } = event else {
				continue;
			};
			let msg_id = envelope.msg_id.clone();
			let ack = match &envelope.body {
				MeshRequest::Message { text, .. } if text == "bad" => json!({ "accepted": true }),
				MeshRequest::Message { text, .. } => {
					if text == "early" {
						let sent = b
							.request(
								A,
								"Main",
								answer(&msg_id, "early answer"),
								Duration::from_secs(5),
								None,
							)
							.await
							.unwrap();
						assert_eq!(err_code(&sent), None, "early answer buffered");
					}
					json!({ "accepted": true, "msgId": msg_id, "thread": "t1" })
				},
				MeshRequest::Watch { ttl_sec: 7, .. } => json!({ "watchId": "bad id" }),
				MeshRequest::Watch { .. } => json!({ "watchId": "w1" }),
				_ => json!(null),
			};
			b.respond(&request_id, MeshResponse::Ok(ack));
		}
	});
}

#[tokio::test]
async fn tracked_requests_route_answers_to_waiters_held_slots_and_late_events() {
	let dir = tempfile::tempdir().unwrap();
	let ((a, mut rx_a), (b, rx_b)) = local_pair(dir.path()).await;
	ack_responder(Arc::clone(&b), rx_b);
	let timeout = Duration::from_secs(5);

	// The answer overtakes the ack: buffered, claimed by the ack, held for the
	// wait that follows.
	let early = a
		.request(B, "Main", ask("early", None), timeout, tracked("t-early", true))
		.await
		.unwrap();
	let id = msg_id_of(&early);
	let got = a
		.await_reply(&id, timeout)
		.await
		.expect("held early answer");
	assert_eq!((answer_text(&got), got.from.instance_id.as_str()), ("early answer", B));

	// A waiter gets the answer.
	let sent = a
		.request(B, "Main", ask("q", None), timeout, tracked("t-wait", false))
		.await
		.unwrap();
	let id = msg_id_of(&sent);
	let wait = {
		let a = Arc::clone(&a);
		let id = id.clone();
		tokio::spawn(async move { a.await_reply(&id, Duration::from_secs(5)).await })
	};
	eventually("waiter registered", || a.state.lock().replies.is_waiting(&id)).await;
	b.request(A, "Main", answer(&id, "waited"), timeout, None)
		.await
		.unwrap();
	assert_eq!(answer_text(&wait.await.unwrap().expect("answer")), "waited");

	// Nobody waits: a late event with the ticket, for every answer.
	for text in ["late 1", "late 2"] {
		b.request(A, "Main", answer(&id, text), timeout, None)
			.await
			.unwrap();
		let NodeEvent::Reply { ticket, envelope } = next_tracking_event(&mut rx_a).await else {
			panic!("expected a reply event");
		};
		assert_eq!((ticket.as_str(), answer_text(&envelope)), ("t-wait", text));
	}

	// Watches route their event the same way.
	let watch = MeshRequest::Watch { event: crate::protocol::MeshWatchEvent::Idle, ttl_sec: 60 };
	let resp = a
		.request(B, "Main", watch, timeout, tracked("t-watch", false))
		.await
		.unwrap();
	assert_eq!(resp, MeshResponse::Ok(json!({ "watchId": "w1" })));
	let event = MeshRequest::WatchEvent {
		watch_id: "w1".into(),
		event:    crate::protocol::MeshWatchEvent::Idle,
		detail:   None,
	};
	b.request(A, "Main", event, timeout, None).await.unwrap();
	let NodeEvent::Reply { ticket, .. } = next_tracking_event(&mut rx_a).await else {
		panic!("expected a watch event");
	};
	assert_eq!(ticket, "t-watch");
	// A watch ends with its event.
	let NodeEvent::PendingDropped { tickets } = next_tracking_event(&mut rx_a).await else {
		panic!("expected the watch to end");
	};
	assert_eq!(tickets, ["t-watch"]);

	// Closing drops what is still tracked.
	a.close().await;
	let NodeEvent::PendingDropped { mut tickets } = next_tracking_event(&mut rx_a).await else {
		panic!("expected pending_dropped");
	};
	tickets.sort();
	assert_eq!(tickets, ["t-early", "t-wait"]);
	b.close().await;
}

#[tokio::test]
async fn malformed_acks_unknown_threads_and_foreign_answers_are_refused() {
	let dir = tempfile::tempdir().unwrap();
	let ((a, mut rx_a), (b, rx_b)) = local_pair(dir.path()).await;
	ack_responder(Arc::clone(&b), rx_b);
	let timeout = Duration::from_secs(5);

	let bad = a
		.request(B, "Main", ask("bad", None), timeout, tracked("t-bad", false))
		.await
		.unwrap();
	assert_eq!(
		bad,
		MeshResponse::error(
			MeshErrorCode::Internal,
			"Peer acknowledged with a missing or malformed message id."
		)
	);
	let watch = MeshRequest::Watch { event: crate::protocol::MeshWatchEvent::Idle, ttl_sec: 7 };
	let bad = a
		.request(B, "Main", watch, timeout, tracked("t-bad-watch", false))
		.await
		.unwrap();
	assert_eq!(
		bad,
		MeshResponse::error(
			MeshErrorCode::Internal,
			"Peer accepted the watch with a missing or malformed watch id."
		)
	);
	assert_eq!(a.state.lock().replies.len(), 0, "nothing tracked");

	// Malformed thread ids never reach the frontend.
	let unknown = a
		.request(B, "Main", ask("q", Some("../x")), timeout, None)
		.await
		.unwrap();
	assert_eq!(unknown, MeshResponse::error(MeshErrorCode::UnknownThread, "Unknown thread ../x."));
	let thread = MeshRequest::Thread { thread: "-x".into() };
	let unknown = a.request(B, "Main", thread, timeout, None).await.unwrap();
	assert_eq!(unknown, MeshResponse::error(MeshErrorCode::UnknownThread, "Unknown thread -x."));
	// Steers and notes ignore `thread`: no check, as before.
	let steer = MeshRequest::Message {
		kind:   MessageKind::Steer,
		text:   "s".into(),
		thread: Some("../x".into()),
	};
	let steered = a.request(B, "Main", steer, timeout, None).await.unwrap();
	assert_eq!(err_code(&steered), None);

	// A notes is acknowledged but never tracked.
	let note_ack = a
		.request(B, "Main", note(), timeout, tracked("t-note", false))
		.await
		.unwrap();
	assert_eq!(err_code(&note_ack), None);
	assert_eq!(a.state.lock().replies.len(), 0, "notes are not tracked");

	// Answers from another instance than the one asked are refused.
	let sent = a
		.request(B, "Main", ask("q", None), timeout, tracked("t-q", false))
		.await
		.unwrap();
	let id = msg_id_of(&sent);
	let (c, _rx_c) = node(C, dir.path(), &Arc::new(FakeMdns::default()), Opts::default());
	c.configure(cfg(MeshMode::Local, None, vec![], "c")).await;
	c.refresh();
	eventually("C lists A", || peer(&c, A).is_some()).await;
	let foreign = c
		.request(A, "Main", answer(&id, "spoof"), timeout, None)
		.await
		.unwrap();
	assert_eq!(
		foreign,
		MeshResponse::error(
			MeshErrorCode::BadRequest,
			format!("No pending message {id} for this peer.")
		)
	);

	// The frontend forgets a ticket: nothing tracks it any more.
	a.forget_pending(&["t-q".into()]);
	assert!(a.await_reply(&id, timeout).await.is_none(), "untracked");
	assert_eq!(a.state.lock().replies.len(), 0);
	a.close().await;
	while let Ok(event) = rx_a.try_recv() {
		assert!(!matches!(event, NodeEvent::PendingDropped { .. }), "nothing left to drop");
	}
	b.close().await;
	c.close().await;
}

/// B's snapshot, naming it apart from every fallback (id, `unknown`, our own
/// host name).
fn bee_snapshot() -> String {
	let mut snap: Value = serde_json::from_str(&snapshot_json(B)).unwrap();
	snap["displayName"] = json!("bee");
	snap["host"] = json!("bee-host");
	snap.to_string()
}

/// An error answer the engine made up for `B`, which left before answering
/// `msg_id`.
fn assert_left_unanswered(env: &MeshEnvelope, msg_id: &str) {
	assert_eq!(
		(env.from.instance_id.as_str(), env.from.display_name.as_str(), env.from.host.as_str()),
		(B, "bee", "bee-host"),
		"sender as last known from B's snapshot"
	);
	match &env.body {
		MeshRequest::Reply { reply_to, thread, text, error } => {
			assert_eq!(
				(reply_to.as_str(), thread.as_deref(), text.as_str()),
				(msg_id, Some("t1"), "")
			);
			assert!(error.is_some(), "an error answer");
		},
		other => panic!("not a reply: {other:?}"),
	}
}

fn assert_no_tracking_event(rx: &mut mpsc::UnboundedReceiver<NodeEvent>, why: &str) {
	while let Ok(event) = rx.try_recv() {
		assert!(
			!matches!(event, NodeEvent::Reply { .. } | NodeEvent::PendingDropped { .. }),
			"{why}"
		);
	}
}

#[tokio::test]
async fn requests_to_a_peer_that_left_get_an_error_answer_but_a_flap_does_not() {
	let dir = tempfile::tempdir().unwrap();
	let ((a, mut rx_a), (b, rx_b)) = local_pair(dir.path()).await;
	b.set_snapshot(&bee_snapshot()).unwrap();
	ack_responder(Arc::clone(&b), rx_b);
	a.refresh();
	eventually("B's snapshot", || peer(&a, B).is_some_and(|p| p.snapshot_json.is_some())).await;
	let timeout = Duration::from_secs(5);

	// Answered for real before B leaves: never answered again.
	let done = a
		.request(B, "Main", ask("q0", None), timeout, tracked("t-done", false))
		.await
		.unwrap();
	b.request(A, "Main", answer(&msg_id_of(&done), "real"), timeout, None)
		.await
		.unwrap();
	let NodeEvent::Reply { ticket, .. } = next_tracking_event(&mut rx_a).await else {
		panic!("expected the real answer");
	};
	assert_eq!(ticket, "t-done");

	let waited = a
		.request(B, "Main", ask("q1", None), timeout, tracked("t-wait", false))
		.await
		.unwrap();
	let waited_id = msg_id_of(&waited);
	let wait = {
		let a = Arc::clone(&a);
		let id = waited_id.clone();
		tokio::spawn(async move { a.await_reply(&id, Duration::from_secs(60)).await })
	};
	eventually("waiter registered", || a.state.lock().replies.is_waiting(&waited_id)).await;
	let late = a
		.request(B, "Main", ask("q2", None), timeout, tracked("t-late", false))
		.await
		.unwrap();
	let late_id = msg_id_of(&late);

	// A listing that could not check B in time drops it, but B is still
	// registered: nothing is answered, and B is back on the next listing.
	{
		let mut st = a.state.lock();
		st.table.set_local_listing(&[], now_ms());
		a.settle_departed(&mut st);
	}
	for _ in 0..=SUSPECT_MISSES {
		a.confirm_suspects(vec![B.to_owned()]).await;
	}
	assert!(a.state.lock().replies.is_waiting(&waited_id), "still waiting");
	assert_no_tracking_event(&mut rx_a, "a flap answers and drops nothing");
	a.poll_local().await;
	eventually("B listed again with its snapshot", || {
		peer(&a, B).is_some_and(|p| p.snapshot_json.is_some())
	})
	.await;

	// B is hard-killed: its endpoint is gone, its entry left behind (and
	// pruned by the next listing).
	let entry_path = dir.path().join(format!("{B}.json"));
	let bytes = std::fs::read(&entry_path).unwrap();
	b.instances.close().await;
	std::fs::write(&entry_path, &bytes).unwrap();
	a.poll_local().await;
	assert!(peer(&a, B).is_none() && !entry_path.exists());
	assert!(a.state.lock().replies.is_waiting(&waited_id), "one missing check is not enough");
	assert_no_tracking_event(&mut rx_a, "not answered after one check");
	a.poll_local().await;
	assert!(a.state.lock().replies.is_waiting(&waited_id), "back-to-back polls are not enough");
	assert_no_tracking_event(&mut rx_a, "not answered before a poll interval passed");
	// Pretend the first miss was a poll interval plus a probe timeout ago.
	{
		let mut st = a.state.lock();
		let suspect = st.suspects.get_mut(B).expect("B is a suspect");
		let first = suspect.first_miss.expect("missed once");
		let earlier = first
			.checked_sub(a.seams.local_poll + LOCAL_PROBE_TIMEOUT)
			.expect("clock far enough from its origin");
		suspect.first_miss = Some(earlier);
	}
	a.poll_local().await;

	let got = tokio::time::timeout(Duration::from_secs(5), wait)
		.await
		.expect("answered long before the wait's timeout")
		.unwrap()
		.expect("an answer");
	assert_left_unanswered(&got, &waited_id);
	let mut dropped = Vec::new();
	let mut replies = Vec::new();
	while dropped.len() < 2 || replies.is_empty() {
		match next_tracking_event(&mut rx_a).await {
			NodeEvent::Reply { ticket, envelope } => replies.push((ticket, envelope)),
			NodeEvent::PendingDropped { tickets } => dropped.extend(tickets),
			other => panic!("unexpected {other:?}"),
		}
	}
	assert_eq!(replies.len(), 1, "only the unanswered, unawaited request goes out late");
	assert_eq!(replies[0].0, "t-late");
	assert_left_unanswered(&replies[0].1, &late_id);
	dropped.sort();
	assert_eq!(dropped, ["t-late", "t-wait"]);
	assert_eq!(a.state.lock().replies.len(), 1, "the answered request stays until its TTL");
	assert_no_tracking_event(&mut rx_a, "the answered request gets nothing more");
	a.close().await;
	b.close().await;
}

#[tokio::test]
async fn mdns_removals_never_answer_for_a_lan_peer() {
	let dir_a = tempfile::tempdir().unwrap();
	let dir_b = tempfile::tempdir().unwrap();
	let mdns = Arc::new(FakeMdns::default());
	let lan_only = Opts { same_machine: |_| false, ..Opts::default() };
	let (a, mut rx_a) = node(A, dir_a.path(), &mdns, lan_only);
	let (b, rx_b) = node(B, dir_b.path(), &Arc::new(FakeMdns::default()), Opts::default());
	b.set_snapshot(&bee_snapshot()).unwrap();
	let pb = b
		.configure(cfg(MeshMode::Remote, Some(key()), vec![], "b"))
		.await
		.lan_port
		.unwrap();
	a.configure(cfg(MeshMode::Remote, Some(key()), vec![], "a"))
		.await;
	mdns.announced.lock().push(B.into());
	mdns.emit(mdns_peer(B, "127.0.0.1", pb)).await;
	eventually("verified mDNS peer", || peer(&a, B).is_some_and(|p| p.source == PeerSource::Mdns))
		.await;
	ack_responder(Arc::clone(&b), rx_b);
	let timeout = Duration::from_secs(5);
	let sent = a
		.request(B, "Main", ask("q", None), timeout, tracked("t-q", false))
		.await
		.unwrap();
	let id = msg_id_of(&sent);
	let wait = {
		let a = Arc::clone(&a);
		let id = id.clone();
		tokio::spawn(async move { a.await_reply(&id, Duration::from_secs(60)).await })
	};
	eventually("waiter registered", || a.state.lock().replies.is_waiting(&id)).await;

	// The running discovery reports B down (a TTL expiry looks the same)
	// while B is in the table only through mDNS: it leaves the table.
	mdns
		.emit(DiscoveryEvent::PeerDown { instance_id: B.into() })
		.await;
	eventually("B gone from the table", || peer(&a, B).is_none()).await;
	assert_no_tracking_event(&mut rx_a, "an mDNS removal answers and drops nothing");

	// B is announced again, then our discovery restarts (new display name)
	// and the stopped one reports B down.
	mdns.emit(mdns_peer(B, "127.0.0.1", pb)).await;
	eventually("B verified again", || peer(&a, B).is_some_and(|p| p.source == PeerSource::Mdns))
		.await;
	a.configure(cfg(MeshMode::Remote, Some(key()), vec![], "a2"))
		.await;
	assert_eq!(mdns.stops.load(Ordering::SeqCst), 1);
	assert!(peer(&a, B).is_none());
	a.refresh();
	tokio::time::sleep(Duration::from_millis(300)).await;
	assert!(a.state.lock().replies.is_waiting(&id), "still waiting for B");
	assert!(!wait.is_finished());
	assert_no_tracking_event(&mut rx_a, "an mDNS removal answers and drops nothing");
	wait.abort();
	a.close().await;
	b.close().await;
}
