//! The `collab` namespace: handler order, listing, link resolution.

use std::sync::atomic::AtomicBool;

use parking_lot::Mutex;
use serde_json::json;

use super::*;
use crate::{
	InstanceError, InstanceHost, Registration,
	collab::{
		CollabAccess, CollabAnswer, CollabHandler, CollabHostSnapshot, CollabLinkErrorCode,
		CollabModel, CollabQuery, CollabSource, NAMESPACE, ResolveError, bound_utf16, list_hosts,
		resolve_link,
	},
	request,
};

const ROOM_KEY: &str = "ROOMKEY-5ecret";
const WRITE_TOKEN: &str = "WRITETOKEN-5ecret";
const CONTROL_URL: &str = "https://collab.example/control/#room=ROOMKEY-5ecret&k=WRITETOKEN-5ecret";
const VIEW_URL: &str = "https://collab.example/view/#room=ROOMKEY-5ecret";

fn snapshot(session_id: &str) -> CollabHostSnapshot {
	CollabHostSnapshot {
		instance_id:     "reported-by-source".into(),
		generation:      1,
		pid:             1,
		session_id:      session_id.into(),
		session_name:    Some("Fixture Session".into()),
		cwd:             "/tmp/fixture-cwd".into(),
		model:           Some(CollabModel {
			provider: "test".into(),
			id:       "fixture-model".into(),
		}),
		started_at:      1_700_000_000_000,
		participants:    3,
		relay_connected: true,
		input_required:  false,
		busy:            Some(false),
		access:          CollabAccess::Control,
	}
}

/// A room whose state tests mutate between queries.
struct Room {
	snapshot: Mutex<CollabHostSnapshot>,
	fail:     AtomicBool,
	stall:    AtomicBool,
	/// `(queries left, access)`: when the count reaches zero the room rotates
	/// (next generation, that access) before answering.
	rotate:   Mutex<Option<(usize, CollabAccess)>>,
}

impl Room {
	fn new(snapshot: CollabHostSnapshot) -> Arc<Self> {
		Arc::new(Self {
			snapshot: Mutex::new(snapshot),
			fail:     AtomicBool::new(false),
			stall:    AtomicBool::new(false),
			rotate:   Mutex::new(None),
		})
	}
}

impl CollabSource for Room {
	fn query(&self, query: CollabQuery) -> BoxFuture<Result<CollabAnswer, ()>> {
		let mut snapshot = self.snapshot.lock();
		let mut rotate = self.rotate.lock();
		if let Some((left, access)) = rotate.as_mut() {
			if *left == 0 {
				snapshot.generation += 1;
				snapshot.access = *access;
				*rotate = None;
			} else {
				*left -= 1;
			}
		}
		let url = match query {
			CollabQuery::Snapshot => None,
			CollabQuery::Link(CollabAccess::View) => Some(VIEW_URL.to_owned()),
			CollabQuery::Link(CollabAccess::Control) => {
				(snapshot.access == CollabAccess::Control).then(|| CONTROL_URL.to_owned())
			},
		};
		let answer = CollabAnswer { snapshot: Some(snapshot.clone()), url };
		let (fail, stall) = (self.fail.load(Ordering::SeqCst), self.stall.load(Ordering::SeqCst));
		Box::pin(async move {
			if stall {
				std::future::pending::<()>().await;
			}
			if fail { Err(()) } else { Ok(answer) }
		})
	}
}

async fn publish(dir: &Path, id: &str, room: &Arc<Room>) -> (InstanceHost, Registration) {
	let host = InstanceHost::new(dir, Some(id.into())).unwrap();
	let source: Arc<dyn CollabSource> = room.clone();
	let reg = host
		.register(NAMESPACE, Arc::new(CollabHandler::new(source)))
		.await
		.unwrap();
	(host, reg)
}

async fn link_error(
	dir: &Path,
	selector: &str,
	access: CollabAccess,
) -> (CollabLinkErrorCode, String) {
	match resolve_link(dir, selector, access, TIMEOUT).await {
		Err(ResolveError::Link(error)) => (error.code, error.message),
		other => panic!("expected a link error, got {other:?}"),
	}
}

async fn wire(host: &InstanceHost, op: &str, body: &Value) -> Result<Value, InstanceError> {
	request(&host.entry().unwrap(), op, &raw(body), TIMEOUT, MAX_RESPONSE)
		.await
		.map(|body| serde_json::from_str(body.get()).unwrap())
}

#[tokio::test]
async fn lists_without_capabilities_and_links_only_the_requested_access() {
	let tmp = tempfile::tempdir().unwrap();
	let dir = tmp.path();
	let (_host, _reg) = publish(dir, A, &Room::new(snapshot("sess"))).await;

	let hosts = list_hosts(dir, TIMEOUT).await.unwrap();
	assert_eq!(hosts.len(), 1);
	assert_eq!(hosts[0].instance_id, A, "identity comes from the entry, not the source");
	assert_eq!(hosts[0].pid, std::process::id());
	let listed = serde_json::to_string(&hosts).unwrap();
	assert!(!listed.contains(ROOM_KEY) && !listed.contains(WRITE_TOKEN) && !listed.contains("url"));

	let control = resolve_link(dir, A, CollabAccess::Control, TIMEOUT)
		.await
		.unwrap();
	assert_eq!(
		serde_json::to_value(&control).unwrap(),
		json!({ "instanceId": A, "generation": 1, "access": "control", "url": CONTROL_URL })
	);
	let view = resolve_link(dir, A, CollabAccess::View, TIMEOUT)
		.await
		.unwrap();
	assert_eq!(view.url, VIEW_URL);
	assert!(!serde_json::to_string(&view).unwrap().contains(WRITE_TOKEN));
	assert!(!format!("{control:?}").contains(ROOM_KEY), "Debug never prints the URL");

	let files = files_in(dir);
	assert_eq!(
		files
			.iter()
			.filter(|f| f.extension().is_some_and(|e| e == "json"))
			.count(),
		1
	);
	for file in files {
		let content = String::from_utf8_lossy(&std::fs::read(&file).unwrap()).into_owned();
		assert!(!content.contains(ROOM_KEY) && !content.contains(WRITE_TOKEN), "{file:?}");
	}
}

#[tokio::test]
async fn view_only_host_refuses_control_on_the_wire_and_through_resolution() {
	let tmp = tempfile::tempdir().unwrap();
	let dir = tmp.path();
	let mut view_only = snapshot("view");
	view_only.access = CollabAccess::View;
	let (host, _reg) = publish(dir, A, &Room::new(view_only)).await;

	assert_eq!(
		wire(&host, "collab.link", &json!({ "access": "control", "generation": 1 })).await,
		Err(InstanceError::Remote("access_unavailable".into()))
	);
	assert_eq!(
		link_error(dir, A, CollabAccess::Control).await,
		(CollabLinkErrorCode::AccessUnavailable, format!("host {A} does not publish control access"))
	);
	assert_eq!(
		resolve_link(dir, A, CollabAccess::View, TIMEOUT)
			.await
			.unwrap()
			.url,
		VIEW_URL
	);
}

#[tokio::test]
async fn a_rotated_room_answers_stale_generation_on_the_same_endpoint() {
	let tmp = tempfile::tempdir().unwrap();
	let dir = tmp.path();
	let mut view_only = snapshot("rotating");
	view_only.access = CollabAccess::View;
	let room = Room::new(view_only);
	let (host, _reg) = publish(dir, A, &room).await;
	let endpoint = host.entry().unwrap().endpoint;
	let stale = format!("host {A} started a new room since it was listed; list again and retry");

	// Rotation between resolution's listing and its link request; the room
	// becomes control-capable, but the caller must re-list, not be told
	// control is unavailable.
	*room.rotate.lock() = Some((1, CollabAccess::Control));
	assert_eq!(
		link_error(dir, A, CollabAccess::Control).await,
		(CollabLinkErrorCode::StaleGeneration, stale)
	);
	assert_eq!(host.entry().unwrap().endpoint, endpoint, "rotation keeps the endpoint");
	let next = resolve_link(dir, A, CollabAccess::Control, TIMEOUT)
		.await
		.unwrap();
	assert_eq!((next.generation, next.url.as_str()), (2, CONTROL_URL));

	// A listed generation is never good for its successor.
	room.snapshot.lock().generation = 3;
	assert_eq!(
		wire(&host, "collab.link", &json!({ "access": "control", "generation": 2 })).await,
		Err(InstanceError::Remote("stale_generation".into()))
	);
}

#[tokio::test]
async fn handler_checks_snapshot_then_operation_then_access() {
	let tmp = tempfile::tempdir().unwrap();
	let dir = tmp.path();
	let room = Room::new(snapshot("order"));
	let (host, _reg) = publish(dir, A, &room).await;
	let remote = |code: &str| Err(InstanceError::Remote(code.into()));

	let bad_access = json!({ "access": "write", "generation": 1 });
	assert_eq!(wire(&host, "collab.link", &bad_access).await, remote("invalid_access"));
	assert_eq!(wire(&host, "collab", &json!({})).await, remote("invalid_operation"));
	assert_eq!(wire(&host, "collab.unknown", &json!({})).await, remote("invalid_operation"));
	let oversized = json!({ "pad": "x".repeat(crate::collab::MAX_REQUEST_BODY_BYTES) });
	assert_eq!(wire(&host, "collab.snapshot", &oversized).await, remote("too_large"));

	room.fail.store(true, Ordering::SeqCst);
	assert_eq!(wire(&host, "collab.unknown", &json!({})).await, remote("snapshot_unavailable"));
	let listed = list_hosts(dir, TIMEOUT).await.unwrap();
	assert!(listed.is_empty() && entry_file(dir, A).exists(), "skipped, not pruned");
}

#[tokio::test]
async fn a_stalled_source_answers_snapshot_unavailable_in_band() {
	let tmp = tempfile::tempdir().unwrap();
	let room = Room::new(snapshot("stalled"));
	room.stall.store(true, Ordering::SeqCst);
	let host = InstanceHost::new(tmp.path(), Some(A.into())).unwrap();
	let source: Arc<dyn CollabSource> = room.clone();
	let handler = CollabHandler::with_timeout(source, Duration::from_millis(200));
	let _reg = host.register(NAMESPACE, Arc::new(handler)).await.unwrap();
	assert_eq!(
		wire(&host, "collab.snapshot", &json!({})).await,
		Err(InstanceError::Remote("snapshot_unavailable".into()))
	);
}

#[tokio::test]
async fn oversized_free_form_fields_are_bounded_so_the_host_stays_listable() {
	let tmp = tempfile::tempdir().unwrap();
	let dir = tmp.path();
	let mut big = snapshot("big");
	big.session_name = Some("n".repeat(100_000));
	big.cwd = format!("/deep/{}", "d".repeat(100_000));
	big.model = Some(CollabModel { provider: "é".repeat(5_000), id: "😀".repeat(5_000) });
	let (_host, _reg) = publish(dir, A, &Room::new(big)).await;

	let hosts = list_hosts(dir, TIMEOUT).await.unwrap();
	assert_eq!(hosts[0].session_name.as_deref(), Some("n".repeat(1024).as_str()));
	assert_eq!(hosts[0].cwd, format!("/deep/{}", "d".repeat(1024 - "/deep/".len())));
	let model = hosts[0].model.as_ref().unwrap();
	assert_eq!(model.provider, "é".repeat(1024), "counted in UTF-16 units, not bytes");
	assert_eq!(model.id, "😀".repeat(512));
	assert_eq!(
		resolve_link(dir, A, CollabAccess::Control, TIMEOUT)
			.await
			.unwrap()
			.url,
		CONTROL_URL
	);
}

#[test]
fn a_surrogate_pair_straddling_the_bound_is_dropped_whole() {
	let mut text = format!("{}😀tail", "a".repeat(1023));
	bound_utf16(&mut text, 1024);
	assert_eq!(text, "a".repeat(1023));
}

#[tokio::test]
async fn selectors_match_an_exact_id_first_then_a_unique_pid() {
	let tmp = tempfile::tempdir().unwrap();
	let dir = tmp.path();
	let numeric = "1234567890123456";
	let (_first, _r1) = publish(dir, numeric, &Room::new(snapshot("first"))).await;
	let pid = std::process::id().to_string();
	assert_eq!(
		resolve_link(dir, &pid, CollabAccess::Control, TIMEOUT)
			.await
			.unwrap()
			.instance_id,
		numeric
	);

	let (_second, _r2) = publish(dir, A, &Room::new(snapshot("second"))).await;
	assert_eq!(
		link_error(dir, &pid, CollabAccess::Control).await,
		(
			CollabLinkErrorCode::Ambiguous,
			format!("{pid} matches more than one Collab host; use an instance id: {numeric}, {A}")
		)
	);
	// Trimmed like JavaScript's `String#trim`: U+FEFF and U+2028 go, U+0085
	// stays.
	let exact =
		resolve_link(dir, &format!("\u{feff} {numeric}\u{2028}"), CollabAccess::View, TIMEOUT)
			.await
			.unwrap();
	assert_eq!(exact.instance_id, numeric);
	assert_eq!(
		link_error(dir, "missing-host", CollabAccess::Control).await,
		(CollabLinkErrorCode::NotFound, "no active Collab host matches missing-host".to_owned())
	);
	assert_eq!(
		link_error(dir, &format!("\u{85}{numeric}"), CollabAccess::View).await,
		(CollabLinkErrorCode::NotFound, format!("no active Collab host matches \u{85}{numeric}"))
	);
}

#[tokio::test]
async fn listing_keeps_unknown_busy_and_skips_malformed_or_missing_snapshots() {
	struct Garbage;
	impl Handler for Garbage {
		fn handle(&self, _: &str, _: &RawValue, _: RequestCtx) -> BoxFuture<HandlerReply> {
			let mut value = serde_json::to_value(snapshot("garbage")).unwrap();
			value["busy"] = json!("yes");
			let reply = raw(&value);
			Box::pin(async move { HandlerReply::Ok(reply) })
		}

		fn max_body_bytes(&self) -> usize {
			4096
		}
	}
	struct Absent;
	impl CollabSource for Absent {
		fn query(&self, _: CollabQuery) -> BoxFuture<Result<CollabAnswer, ()>> {
			Box::pin(async { Ok(CollabAnswer { snapshot: None, url: None }) })
		}
	}

	let tmp = tempfile::tempdir().unwrap();
	let dir = tmp.path();
	let mut older = snapshot("older");
	older.busy = None;
	let (_older, _r1) = publish(dir, A, &Room::new(older)).await;
	let garbage = InstanceHost::new(dir, Some(B.into())).unwrap();
	let _r2 = garbage
		.register(NAMESPACE, Arc::new(Garbage))
		.await
		.unwrap();
	let absent = InstanceHost::new(dir, Some(C.into())).unwrap();
	let _r3 = absent
		.register(NAMESPACE, Arc::new(CollabHandler::new(Arc::new(Absent))))
		.await
		.unwrap();

	let hosts = list_hosts(dir, TIMEOUT).await.unwrap();
	let seen: Vec<_> = hosts
		.iter()
		.map(|h| (h.session_id.as_str(), h.busy))
		.collect();
	assert_eq!(seen, [("older", None)], "unknown is not idle; garbage is not busy");
	assert!(entry_file(dir, B).exists() && entry_file(dir, C).exists(), "skipped, not pruned");
}

#[tokio::test]
async fn hosts_sort_by_start_time_then_instance_id() {
	let tmp = tempfile::tempdir().unwrap();
	let dir = tmp.path();
	#[allow(clippy::collection_is_never_read, reason = "keeps the hosts published")]
	let mut hosts = Vec::new();
	for (id, started_at) in [(D, 1000), (C, 1000), (A, 1000), (B, 900)] {
		let mut s = snapshot(id);
		s.started_at = started_at;
		hosts.push(publish(dir, id, &Room::new(s)).await);
	}
	let ids: Vec<_> = list_hosts(dir, TIMEOUT)
		.await
		.unwrap()
		.into_iter()
		.map(|h| h.instance_id)
		.collect();
	assert_eq!(ids, [B, A, C, D]);
}
