use std::{
	net::{Ipv4Addr, SocketAddr},
	path::Path,
	sync::Arc,
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use parking_lot::Mutex;
use pi_instances::{InstanceEntry, InstanceError, InstanceHost, Registration};
use serde_json::{json, value::RawValue};
use tokio::net::TcpStream;

use super::{
	BUSY_TEXT, BoxFuture, Endpoint, InboundSink, MAX_CONNECTIONS_PER_IP, MeshClient, Origin,
	OriginKind, REJECTED_TEXT, STATUS_TOO_LARGE, TOO_LARGE_TEXT, TransportError, exchange,
	instance::{self, MAX_RESPONSE_LINE, MeshNamespace},
	lan::LanListener,
	sealed::{MAX_RESPONSE_FRAME, decode_response, encode_request},
};
use crate::{
	frame::{MAX_FRAME_BYTES, read_frame},
	keys::{MeshKeys, ReplayGuard},
	protocol::{
		ANY_INSTANCE, MAX_ENVELOPE_BYTES, MAX_TEXT_CHARS, MeshEnvelope, MeshErrorCode, MeshRequest,
		MeshResponse, MeshSender, MessageKind,
	},
};

const ME: &str = "aaaaaaaaaaaaaaaa";
const PEER: &str = "bbbbbbbbbbbbbbbb";
const TIMEOUT: Duration = Duration::from_secs(5);

/// Answers `{msgId, origin}` so tests see what reached the sink.
struct Echo;

impl InboundSink for Echo {
	fn handle(&self, envelope: MeshEnvelope, origin: Origin) -> BoxFuture<MeshResponse> {
		let kind = match origin.kind {
			OriginKind::Local => "local",
			OriginKind::Remote => "remote",
		};
		Box::pin(async move { MeshResponse::Ok(json!({ "msgId": envelope.msg_id, "origin": kind })) })
	}
}

fn now_ms() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap()
		.as_millis() as u64
}

fn envelope(msg_id: &str, to: &str, body: MeshRequest) -> MeshEnvelope {
	MeshEnvelope {
		v: 1,
		msg_id: msg_id.into(),
		sent_at: now_ms(),
		hop: 0,
		from: MeshSender {
			instance_id:  PEER.into(),
			agent_id:     "Main".into(),
			display_name: "peer".into(),
			host:         "box".into(),
			lan_port:     Some(4242),
		},
		to: to.into(),
		body,
	}
}

fn note(msg_id: &str, to: &str) -> MeshEnvelope {
	envelope(msg_id, to, MeshRequest::Message {
		kind:   MessageKind::Note,
		text:   "hi".into(),
		thread: None,
	})
}

fn keys(byte: u8) -> Arc<MeshKeys> {
	Arc::new(MeshKeys::load(&URL_SAFE_NO_PAD.encode([byte; 32])).unwrap())
}

fn echoed(msg_id: &str, origin: &str) -> MeshResponse {
	MeshResponse::Ok(json!({ "msgId": msg_id, "origin": origin }))
}

fn error_code(response: &MeshResponse) -> MeshErrorCode {
	match response {
		MeshResponse::Err { code, .. } => *code,
		MeshResponse::Ok(data) => panic!("expected error, got {data}"),
		MeshResponse::OkRaw(data) => panic!("expected error, got {data}"),
	}
}

async fn lan() -> LanListener {
	lan_with_guard(Arc::default()).await
}

async fn lan_with_guard(guard: Arc<Mutex<ReplayGuard>>) -> LanListener {
	LanListener::start((Ipv4Addr::LOCALHOST, 0).into(), ME.into(), keys(1), guard, Arc::new(Echo))
		.await
		.unwrap()
}

fn remote(listener: &LanListener) -> Endpoint {
	Endpoint::Remote { addr: listener.addr() }
}

/// Never answers (the peer's handler is stuck).
struct Silent;

impl InboundSink for Silent {
	fn handle(&self, _envelope: MeshEnvelope, _origin: Origin) -> BoxFuture<MeshResponse> {
		Box::pin(std::future::pending())
	}
}

/// Host `ME` in `dir` serving `namespace` with `sink`; keep the host and the
/// registration alive while the endpoint is used.
async fn local_host(
	dir: &Path,
	namespace: &str,
	sink: Arc<dyn InboundSink>,
) -> (InstanceHost, Registration, InstanceEntry) {
	let host = InstanceHost::new(dir, Some(ME.into())).unwrap();
	let registration = host
		.register(namespace, Arc::new(MeshNamespace::new(sink)))
		.await
		.unwrap();
	let entry = host.entry().unwrap();
	(host, registration, entry)
}

async fn mesh_host(dir: &Path) -> (InstanceHost, Registration, InstanceEntry) {
	local_host(dir, instance::NAMESPACE, Arc::new(Echo)).await
}

fn raw(json: String) -> Box<RawValue> {
	RawValue::from_string(json).unwrap()
}

#[tokio::test]
async fn local_round_trip_and_wildcard_snapshot() {
	let dir = tempfile::tempdir().unwrap();
	let (_host, _reg, entry) = mesh_host(dir.path()).await;
	let client = MeshClient::new(None);
	let endpoint = Endpoint::Local(entry);
	let got = client
		.request(&endpoint, &note("m1", ME), TIMEOUT)
		.await
		.unwrap();
	assert_eq!(got, echoed("m1", "local"));
	let snap = envelope("m2", ANY_INSTANCE, MeshRequest::Snapshot);
	assert_eq!(client.request(&endpoint, &snap, TIMEOUT).await.unwrap(), echoed("m2", "local"));
}

#[tokio::test]
async fn local_validates_envelope_and_recipient_in_band() {
	let dir = tempfile::tempdir().unwrap();
	let (_host, _reg, entry) = mesh_host(dir.path()).await;
	let client = MeshClient::new(None);
	let endpoint = Endpoint::Local(entry);
	// Authenticated but addressed elsewhere, or `*` on a non-snapshot request.
	for env in [note("m1", PEER), note("m2", ANY_INSTANCE)] {
		let got = client.request(&endpoint, &env, TIMEOUT).await.unwrap();
		assert_eq!(error_code(&got), MeshErrorCode::BadRequest, "{}", env.to);
	}
}

/// Row `authentication_failed` -> `Ok(unauthorized)`.
#[tokio::test]
async fn local_wrong_token_is_unauthorized() {
	let dir = tempfile::tempdir().unwrap();
	let (_host, _reg, mut entry) = mesh_host(dir.path()).await;
	entry.token = "00".repeat(32);
	let got = MeshClient::new(None)
		.request(&Endpoint::Local(entry), &note("m1", ME), TIMEOUT)
		.await
		.unwrap();
	assert_eq!(got, MeshResponse::error(MeshErrorCode::Unauthorized, REJECTED_TEXT));
}

/// Row `misdirected` -> `Err(Misdirected)`: the endpoint serves another id.
#[tokio::test]
async fn local_endpoint_serving_another_instance_is_misdirected() {
	let dir = tempfile::tempdir().unwrap();
	let (_host, _reg, mut entry) = mesh_host(dir.path()).await;
	entry.instance_id = PEER.into();
	let err = MeshClient::new(None)
		.request(&Endpoint::Local(entry), &note("m1", PEER), TIMEOUT)
		.await
		.unwrap_err();
	assert_eq!(err, TransportError::Misdirected);
}

/// Row `misdirected` (Windows): a pipe served by another process.
#[cfg(windows)]
#[tokio::test]
async fn pipe_served_by_another_process_is_misdirected() {
	let dir = tempfile::tempdir().unwrap();
	let (_host, _reg, mut entry) = mesh_host(dir.path()).await;
	entry.pid = entry.pid.wrapping_add(1);
	let err = MeshClient::new(None)
		.request(&Endpoint::Local(entry), &note("m1", ME), TIMEOUT)
		.await
		.unwrap_err();
	assert_eq!(err, TransportError::Misdirected);
}

#[tokio::test]
async fn oversize_envelope_is_refused_client_side() {
	let dir = tempfile::tempdir().unwrap();
	let (_host, _reg, entry) = mesh_host(dir.path()).await;
	let mut big = note("m1", ME);
	// Under the text cap per field, over the envelope cap in total.
	big.body = MeshRequest::Reply {
		reply_to: "x".into(),
		thread:   None,
		text:     "\u{e9}".repeat(MAX_TEXT_CHARS),
		error:    Some("\u{e9}".repeat(MAX_TEXT_CHARS)),
	};
	let got = MeshClient::new(None)
		.request(&Endpoint::Local(entry), &big, TIMEOUT)
		.await
		.unwrap();
	assert_eq!(error_code(&got), MeshErrorCode::TooLarge);
}

/// Row `too_large` -> `Ok(too_large)`: the host enforces the namespace's body
/// cap before the handler runs.
#[tokio::test]
async fn local_oversize_body_is_too_large() {
	let dir = tempfile::tempdir().unwrap();
	let (_host, _reg, entry) = mesh_host(dir.path()).await;
	let big = raw(format!("\"{}\"", "x".repeat(MAX_ENVELOPE_BYTES)));
	let result =
		pi_instances::request(&entry, "mesh.envelope", &big, TIMEOUT, MAX_RESPONSE_LINE).await;
	assert_eq!(result.as_ref().unwrap_err(), &InstanceError::Remote("too_large".into()));
	assert_eq!(
		instance::map_outcome(&entry, result),
		Ok(MeshResponse::error(MeshErrorCode::TooLarge, TOO_LARGE_TEXT))
	);
}

/// Row `unavailable` -> `Err(Unreachable)`: the instance does not serve mesh.
#[tokio::test]
async fn local_instance_without_mesh_is_unreachable() {
	let dir = tempfile::tempdir().unwrap();
	let (_host, _reg, entry) = local_host(dir.path(), "other", Arc::new(Echo)).await;
	let err = MeshClient::new(None)
		.request(&Endpoint::Local(entry), &note("m1", ME), TIMEOUT)
		.await
		.unwrap_err();
	assert!(matches!(err, TransportError::Unreachable(_)), "{err}");
}

/// Row connect failure -> `Err(Unreachable)`.
#[tokio::test]
async fn closed_local_host_is_unreachable() {
	let dir = tempfile::tempdir().unwrap();
	let (host, _reg, entry) = mesh_host(dir.path()).await;
	host.close().await;
	let endpoint = entry.endpoint.clone();
	let err = MeshClient::new(None)
		.request(&Endpoint::Local(entry), &note("m1", ME), TIMEOUT)
		.await
		.unwrap_err();
	let TransportError::Unreachable(text) = &err else {
		panic!("{err}");
	};
	let prefix = format!("cannot connect to {endpoint}: ");
	assert!(text.starts_with(&prefix), "{text}");
	assert!(!text[prefix.len()..].contains(&endpoint), "endpoint named once: {text}");
}

/// Row client-side deadline -> `Err(Timeout)`.
#[tokio::test]
async fn local_peer_that_never_answers_times_out() {
	let dir = tempfile::tempdir().unwrap();
	let (_host, _reg, entry) = local_host(dir.path(), instance::NAMESPACE, Arc::new(Silent)).await;
	let err = MeshClient::new(None)
		.request(&Endpoint::Local(entry), &note("m1", ME), Duration::from_millis(300))
		.await
		.unwrap_err();
	assert_eq!(err, TransportError::Timeout);
}

/// Row "any other remote code" -> `Err(BadResponse)`, live: an unknown op.
#[tokio::test]
async fn local_unknown_op_is_bad_response() {
	let dir = tempfile::tempdir().unwrap();
	let (_host, _reg, entry) = mesh_host(dir.path()).await;
	let body = raw(serde_json::to_string(&note("m1", ME)).unwrap());
	let result =
		pi_instances::request(&entry, "mesh.bogus", &body, TIMEOUT, MAX_RESPONSE_LINE).await;
	assert_eq!(result.as_ref().unwrap_err(), &InstanceError::Remote("invalid_operation".into()));
	let err = instance::map_outcome(&entry, result).unwrap_err();
	assert!(matches!(err, TransportError::BadResponse(_)), "{err}");
}

/// Mapping rows the live tests above cannot reach, and the error texts.
#[test]
fn instance_outcomes_map_to_mesh_results() {
	let entry = InstanceEntry {
		instance_id:  ME.into(),
		pid:          1,
		nonce:        "0".repeat(16),
		endpoint:     "ep".into(),
		token:        "0".repeat(64),
		created_at:   1,
		capabilities: vec![instance::NAMESPACE.into()],
	};
	let map = |result| instance::map_outcome(&entry, result);
	let remote = |code: &str| Err(InstanceError::Remote(code.into()));
	assert_eq!(map(remote("busy")), Ok(MeshResponse::error(MeshErrorCode::Busy, BUSY_TEXT)));
	let unreachable = |message: &str| {
		map(Err(InstanceError::Unreachable { code: "ECONNREFUSED", message: message.into() }))
	};
	assert_eq!(
		unreachable("connect ep: refused"),
		Err(TransportError::Unreachable("cannot connect to ep: refused".into()))
	);
	assert_eq!(
		unreachable("instance connection failed: reset"),
		Err(TransportError::Unreachable("mesh connection failed: reset".into()))
	);
	assert_eq!(
		map(Err(InstanceError::BadResponse("closed without answering".into()))),
		Err(TransportError::BadResponse("mesh peer closed without answering".into()))
	);
	assert!(matches!(map(Ok(raw("[1]".into()))), Err(TransportError::BadResponse(_))));
	assert_eq!(map(Ok(raw(r#"{"ok":true,"data":1}"#.into()))), Ok(MeshResponse::Ok(json!(1))));
}

#[tokio::test]
async fn lan_round_trip_and_wildcard_snapshot() {
	let listener = lan().await;
	let client = MeshClient::new(Some(keys(1)));
	let got = client
		.request(&remote(&listener), &note("m1", ME), TIMEOUT)
		.await
		.unwrap();
	assert_eq!(got, echoed("m1", "remote"));
	let snap = envelope("m2", ANY_INSTANCE, MeshRequest::Snapshot);
	let got = client
		.request(&remote(&listener), &snap, TIMEOUT)
		.await
		.unwrap();
	assert_eq!(got, echoed("m2", "remote"));
	let star_note = note("m3", ANY_INSTANCE);
	let got = client
		.request(&remote(&listener), &star_note, TIMEOUT)
		.await
		.unwrap();
	assert_eq!(error_code(&got), MeshErrorCode::BadRequest);
}

#[tokio::test]
async fn lan_wrong_key_misdirection_and_missing_key() {
	let listener = lan().await;
	let got = MeshClient::new(Some(keys(2)))
		.request(&remote(&listener), &note("m1", ME), TIMEOUT)
		.await
		.unwrap();
	assert_eq!(error_code(&got), MeshErrorCode::Unauthorized);

	let err = MeshClient::new(Some(keys(1)))
		.request(&remote(&listener), &note("m2", PEER), TIMEOUT)
		.await
		.unwrap_err();
	assert_eq!(err, TransportError::Misdirected);

	let err = MeshClient::new(None)
		.request(&remote(&listener), &note("m3", ME), TIMEOUT)
		.await
		.unwrap_err();
	assert!(matches!(err, TransportError::Unreachable(_)), "{err}");
}

async fn send_raw(addr: SocketAddr, frame: &[u8]) -> Vec<u8> {
	let mut stream = TcpStream::connect(addr).await.unwrap();
	match exchange(&mut stream, frame, MAX_RESPONSE_FRAME)
		.await
		.unwrap()
	{
		Ok(body) => body,
		Err(response) => panic!("unexpected status response {response:?}"),
	}
}

#[tokio::test]
async fn lan_rejects_replayed_and_stale_requests() {
	let listener = lan().await;
	let keys = keys(1);
	let env = note("m1", ME);
	let frame = encode_request(keys.seal_key(), &env, &serde_json::to_vec(&env).unwrap()).unwrap();
	let mut first = send_raw(listener.addr(), &frame).await;
	assert_eq!(decode_response(keys.seal_key(), &env, &mut first).unwrap(), echoed("m1", "remote"));
	let mut again = send_raw(listener.addr(), &frame).await;
	let replay = decode_response(keys.seal_key(), &env, &mut again).unwrap();
	assert_eq!(error_code(&replay), MeshErrorCode::Unauthorized);

	let mut stale = note("m2", ME);
	stale.sent_at -= 120_000;
	let got = MeshClient::new(Some(keys))
		.request(&remote(&listener), &stale, TIMEOUT)
		.await
		.unwrap();
	assert_eq!(error_code(&got), MeshErrorCode::Unauthorized);
}

#[tokio::test]
async fn lan_response_is_bound_to_its_request() {
	let listener = lan().await;
	let keys = keys(1);
	let a = note("m1", ME);
	let body = send_raw(
		listener.addr(),
		&encode_request(keys.seal_key(), &a, &serde_json::to_vec(&a).unwrap()).unwrap(),
	)
	.await;
	// The same sealed answer presented as the response to another msgId or
	// recipient fails authentication.
	let other_msg = note("m2", ME);
	let other_to = envelope("m1", ANY_INSTANCE, MeshRequest::Snapshot);
	for wrong in [other_msg, other_to] {
		let err = decode_response(keys.seal_key(), &wrong, &mut body.clone()).unwrap_err();
		assert!(matches!(err, TransportError::BadResponse(_)), "{err}");
	}
}

#[tokio::test]
async fn oversize_frame_gets_status_without_reading_payload() {
	let listener = lan().await;
	let mut stream = TcpStream::connect(listener.addr()).await.unwrap();
	let declared = u32::try_from(MAX_FRAME_BYTES + 1).unwrap();
	tokio::io::AsyncWriteExt::write_all(&mut stream, &declared.to_be_bytes())
		.await
		.unwrap();
	let reply = read_frame(&mut stream, 16).await.unwrap();
	assert_eq!(reply.as_deref(), Some(&[STATUS_TOO_LARGE][..]));
}

#[tokio::test]
async fn per_ip_limit_answers_busy_and_frees_slots() {
	let listener = lan().await;
	// Idle connections hold their slots until the read deadline.
	let mut held = Vec::new();
	for _ in 0..MAX_CONNECTIONS_PER_IP {
		held.push(TcpStream::connect(listener.addr()).await.unwrap());
	}
	// Let the accept loop take all of them before the next one.
	tokio::time::sleep(Duration::from_millis(200)).await;
	let client = MeshClient::new(Some(keys(1)));
	let got = client
		.request(&remote(&listener), &note("m1", ME), TIMEOUT)
		.await
		.unwrap();
	assert_eq!(error_code(&got), MeshErrorCode::Busy);
	drop(held);
	tokio::time::sleep(Duration::from_millis(200)).await;
	let got = client
		.request(&remote(&listener), &note("m2", ME), TIMEOUT)
		.await
		.unwrap();
	assert_eq!(got, echoed("m2", "remote"));
}

#[tokio::test]
async fn replay_guard_survives_listener_restart() {
	let guard: Arc<Mutex<ReplayGuard>> = Arc::default();
	let keys = keys(1);
	let env = note("m1", ME);
	let frame = encode_request(keys.seal_key(), &env, &serde_json::to_vec(&env).unwrap()).unwrap();
	let first = lan_with_guard(Arc::clone(&guard)).await;
	let mut body = send_raw(first.addr(), &frame).await;
	assert_eq!(decode_response(keys.seal_key(), &env, &mut body).unwrap(), echoed("m1", "remote"));
	first.close().await;
	let second = lan_with_guard(guard).await;
	let mut body = send_raw(second.addr(), &frame).await;
	let replay = decode_response(keys.seal_key(), &env, &mut body).unwrap();
	assert_eq!(error_code(&replay), MeshErrorCode::Unauthorized);
}

#[tokio::test]
async fn closed_listener_is_unreachable() {
	let listener = lan().await;
	let endpoint = remote(&listener);
	listener.close().await;
	let err = MeshClient::new(Some(keys(1)))
		.request(&endpoint, &note("m1", ME), TIMEOUT)
		.await
		.unwrap_err();
	assert!(matches!(err, TransportError::Unreachable(_)), "{err}");
}

#[test]
fn raw_ok_fast_path_matches_serde_encoding() {
	let raw = MeshResponse::OkRaw(r#"{"a":[1,"x"]}"#.into());
	let decoded = crate::protocol::parse_response(&super::encode_response(&raw)).unwrap();
	assert_eq!(decoded, MeshResponse::Ok(json!({ "a": [1, "x"] })));
}
