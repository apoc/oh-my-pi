//! Node integration over real loopback transports; mDNS replaced by a fake,
//! reverse DNS by a resolver that never answers.

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
};

const A: &str = "aaaaaaaaaaaaaaa1";
const B: &str = "bbbbbbbbbbbbbbb2";
const C: &str = "ccccccccccccccc3";

#[derive(Default)]
struct FakeMdns {
	starts: Mutex<Vec<MdnsConfig>>,
	stops:  Arc<AtomicUsize>,
	tx:     Mutex<Option<mpsc::Sender<DiscoveryEvent>>>,
}

struct FakeHandle(Arc<AtomicUsize>);

impl MdnsHandle for FakeHandle {
	fn refresh(&self) {}

	fn needs_restart(&self) -> bool {
		false
	}

	fn stop(&self) -> BoxFuture<()> {
		self.0.fetch_add(1, Ordering::SeqCst);
		Box::pin(async {})
	}
}

impl MdnsStarter for FakeMdns {
	fn start(
		&self,
		cfg: MdnsConfig,
		events: mpsc::Sender<DiscoveryEvent>,
	) -> Result<Arc<dyn MdnsHandle>, String> {
		self.starts.lock().push(cfg);
		*self.tx.lock() = Some(events);
		Ok(Arc::new(FakeHandle(Arc::clone(&self.stops))))
	}
}

impl FakeMdns {
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
	let (tx, rx) = mpsc::unbounded_channel();
	let seams = Seams {
		mdns:             Arc::clone(mdns) as Arc<dyn MdnsStarter>,
		is_same_machine:  opts.same_machine,
		rdns:             ReverseDns::with_resolver(ReverseDnsConfig::default(), Arc::new(|_| None)),
		lan_bind:         IpAddr::V4(Ipv4Addr::LOCALHOST),
		local_poll:       Duration::from_secs(60),
		snapshot_refresh: Duration::from_secs(60),
		respond_timeout:  opts.respond_timeout,
		probe_timeout:    Duration::from_secs(2),
	};
	let opts = NodeOptions {
		instance_id:  Some(id.into()),
		display_name: format!("node {id}"),
		host:         "testhost".into(),
		registry_dir: Some(dir.to_owned()),
	};
	(MeshNode::with_seams(opts, tx, seams).unwrap(), rx)
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
	let listed = async || registry::list_local(dir.path(), None).await.len();

	let st = a
		.configure(cfg(MeshMode::Local, Some(key()), vec![], "a"))
		.await;
	assert_eq!((st.local, st.remote, st.lan_port), (LocalState::On, RemoteState::Off, None));
	assert_eq!(listed().await, 1);
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
	assert_eq!(listed().await, 0, "registry entry withdrawn");
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

	let ok = MeshResponse::Ok(json!({"thread": "t1", "accepted": true}));
	let answers = responder(Arc::clone(&b), rx_b, Some(ok.clone()), 2);
	let resp = a
		.request(B, "Main", note(), Duration::from_secs(5))
		.await
		.unwrap();
	assert_eq!(resp, ok);
	eventually("B learned A from the inbound contact", || peer(&b, A).is_some()).await;

	b.set_peer_flags(A, false, true);
	let denied = a
		.request(B, "Main", note(), Duration::from_secs(5))
		.await
		.unwrap();
	assert_eq!(err_code(&denied), Some(MeshErrorCode::Denied));
	b.set_peer_flags(A, false, false);
	a.request(B, "Main", note(), Duration::from_secs(5))
		.await
		.unwrap();

	let seen = answers.await.unwrap();
	assert_eq!(seen.len(), 2, "blocked request never reached the frontend");
	let first = &seen[0].1;
	assert_eq!((first.hop, first.from.instance_id.as_str(), first.from.lan_port), (0, A, pa));

	let unknown = a.request(C, "Main", note(), Duration::from_secs(1)).await;
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
		.request(B, "Main", note(), Duration::from_secs(5))
		.await
		.unwrap();
	assert_eq!(err_code(&resp), Some(MeshErrorCode::Internal));
	let (request_id, _) = silent.await.unwrap().remove(0);
	assert_eq!(b.state.lock().pending.len(), 0, "timed-out slot freed");
	assert!(!b.respond(&request_id, MeshResponse::Ok(json!(null))), "late respond ignored");

	let snap = a
		.request(B, "Main", MeshRequest::Snapshot, Duration::from_secs(5))
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
	b.request(A, "Main", note(), Duration::from_secs(5))
		.await
		.unwrap();
	tokio::time::sleep(Duration::from_millis(200)).await;
	assert!(peer(&a, B).is_none());

	b.set_snapshot(&snapshot_json(B)).unwrap();
	b.request(A, "Main", note(), Duration::from_secs(5))
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
