use std::{
	net::{Ipv4Addr, SocketAddr},
	sync::Arc,
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use parking_lot::Mutex;
use serde_json::json;
use tokio::net::TcpStream;

use super::{
	BoxFuture, Endpoint, InboundSink, MAX_CONNECTIONS_PER_IP, MeshClient, Origin, OriginKind,
	STATUS_OK, STATUS_TOO_LARGE, TransportError, exchange,
	lan::LanListener,
	local::LocalListener,
	sealed::{MAX_RESPONSE_FRAME, decode_response, encode_request},
};
use crate::{
	frame::{MAX_FRAME_BYTES, read_frame, write_frame},
	keys::{MeshKeys, ReplayGuard},
	protocol::{
		ANY_INSTANCE, MAX_TEXT_CHARS, MeshEnvelope, MeshErrorCode, MeshRequest, MeshResponse,
		MeshSender, MessageKind,
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

#[tokio::test]
async fn local_round_trip_and_wildcard_snapshot() {
	let dir = tempfile::tempdir().unwrap();
	let listener = LocalListener::start(dir.path(), ME.into(), Arc::new(Echo)).unwrap();
	let client = MeshClient::new(None);
	let endpoint = listener.endpoint();
	let got = client
		.request(&endpoint, &note("m1", ME), TIMEOUT)
		.await
		.unwrap();
	assert_eq!(got, echoed("m1", "local"));
	let snap = envelope("m2", ANY_INSTANCE, MeshRequest::Snapshot);
	assert_eq!(client.request(&endpoint, &snap, TIMEOUT).await.unwrap(), echoed("m2", "local"));
}

#[tokio::test]
async fn local_rejects_wrong_token_misdirection_and_bad_envelopes() {
	let dir = tempfile::tempdir().unwrap();
	let listener = LocalListener::start(dir.path(), ME.into(), Arc::new(Echo)).unwrap();
	let client = MeshClient::new(None);
	let wrong = Endpoint::Local {
		path:  listener.path().into(),
		token: "00".repeat(32),
		pid:   std::process::id(),
	};
	let got = client
		.request(&wrong, &note("m1", ME), TIMEOUT)
		.await
		.unwrap();
	assert_eq!(error_code(&got), MeshErrorCode::Unauthorized);

	let endpoint = listener.endpoint();
	let err = client
		.request(&endpoint, &note("m2", PEER), TIMEOUT)
		.await
		.unwrap_err();
	assert_eq!(err, TransportError::Misdirected);

	// Authenticated but invalid: answered with the validation code.
	let star_note = note("m3", ANY_INSTANCE);
	let got = client
		.request(&endpoint, &star_note, TIMEOUT)
		.await
		.unwrap();
	assert_eq!(error_code(&got), MeshErrorCode::BadRequest);
}

#[tokio::test]
async fn oversize_envelope_is_refused_client_side() {
	let dir = tempfile::tempdir().unwrap();
	let listener = LocalListener::start(dir.path(), ME.into(), Arc::new(Echo)).unwrap();
	let mut big = note("m1", ME);
	// Under the text cap per field, over the envelope cap in total.
	big.body = MeshRequest::Reply {
		reply_to: "x".into(),
		thread:   None,
		text:     "\u{e9}".repeat(MAX_TEXT_CHARS),
		error:    Some("\u{e9}".repeat(MAX_TEXT_CHARS)),
	};
	let got = MeshClient::new(None)
		.request(&listener.endpoint(), &big, TIMEOUT)
		.await
		.unwrap();
	assert_eq!(error_code(&got), MeshErrorCode::TooLarge);
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

/// A fake local server: answers its first connection with `answer` and
/// yields the request frame it received.
#[cfg(unix)]
fn fake_local(
	dir: &std::path::Path,
	answer: Vec<u8>,
) -> (String, tokio::task::JoinHandle<Vec<u8>>) {
	let path = dir.join("fake.sock");
	let listener = tokio::net::UnixListener::bind(&path).unwrap();
	let seen = tokio::spawn(async move {
		let (mut stream, _) = listener.accept().await.unwrap();
		let request = read_frame(&mut stream, MAX_FRAME_BYTES)
			.await
			.unwrap()
			.unwrap();
		write_frame(&mut stream, &answer, usize::MAX).await.unwrap();
		request
	});
	(path.to_str().unwrap().to_owned(), seen)
}

#[cfg(windows)]
fn fake_local(
	_dir: &std::path::Path,
	answer: Vec<u8>,
) -> (String, tokio::task::JoinHandle<Vec<u8>>) {
	let mut suffix = [0u8; 8];
	crate::keys::random_bytes(&mut suffix);
	let name = format!(r"\\.\pipe\omp-mesh-test-{}", crate::keys::hex(&suffix));
	let mut server = tokio::net::windows::named_pipe::ServerOptions::new()
		.first_pipe_instance(true)
		.create(&name)
		.unwrap();
	let seen = tokio::spawn(async move {
		server.connect().await.unwrap();
		let request = read_frame(&mut server, MAX_FRAME_BYTES)
			.await
			.unwrap()
			.unwrap();
		write_frame(&mut server, &answer, usize::MAX).await.unwrap();
		request
	});
	(name, seen)
}

#[tokio::test]
async fn local_client_never_sends_token_and_rejects_forged_answers() {
	let dir = tempfile::tempdir().unwrap();
	let forged = [&[STATUS_OK][..], &br#"{"ok":true,"data":"forged"}"#[..]].concat();
	let (path, seen) = fake_local(dir.path(), forged);
	let token = "ab".repeat(32);
	let err = MeshClient::new(None)
		.request(
			&Endpoint::Local { path, token: token.clone(), pid: std::process::id() },
			&note("m1", ME),
			TIMEOUT,
		)
		.await
		.unwrap_err();
	assert!(matches!(err, TransportError::BadResponse(_)), "{err}");
	let request = seen.await.unwrap();
	let raw = [0xabu8; 32];
	assert!(!request.windows(raw.len()).any(|w| w == raw), "raw token on the wire");
	assert!(!request.windows(token.len()).any(|w| w == token.as_bytes()), "hex token on the wire");
}

#[tokio::test]
async fn closed_local_listener_is_dead_to_probes_and_clients() {
	let dir = tempfile::tempdir().unwrap();
	let listener = LocalListener::start(dir.path(), ME.into(), Arc::new(Echo)).unwrap();
	let endpoint = listener.endpoint();
	let path = listener.path().to_owned();
	let pid = std::process::id();
	assert!(crate::transport::local::probe(&path, pid).await.unwrap());
	listener.close().await;
	assert!(!crate::transport::local::probe(&path, pid).await.unwrap());
	let err = MeshClient::new(None)
		.request(&endpoint, &note("m1", ME), TIMEOUT)
		.await
		.unwrap_err();
	assert!(matches!(err, TransportError::Unreachable(_)), "{err}");
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

#[cfg(windows)]
#[tokio::test]
async fn pipe_served_by_another_process_counts_as_dead() {
	let dir = tempfile::tempdir().unwrap();
	let listener = LocalListener::start(dir.path(), ME.into(), Arc::new(Echo)).unwrap();
	let Endpoint::Local { path, token, pid } = listener.endpoint() else {
		unreachable!()
	};
	let other = pid.wrapping_add(1);
	assert!(!crate::transport::local::probe(&path, other).await.unwrap());
	let err = MeshClient::new(None)
		.request(&Endpoint::Local { path, token, pid: other }, &note("m1", ME), TIMEOUT)
		.await
		.unwrap_err();
	assert_eq!(err, TransportError::Misdirected);
}

#[cfg(unix)]
#[test]
fn overlong_socket_path_fails_with_a_clear_error() {
	let tmp = tempfile::tempdir().unwrap();
	let dir = tmp.path().join("d".repeat(120));
	std::fs::create_dir(&dir).unwrap();
	let rt = tokio::runtime::Builder::new_current_thread()
		.enable_all()
		.build()
		.unwrap();
	let err = rt
		.block_on(async { LocalListener::start(&dir, ME.into(), Arc::new(Echo)) })
		.unwrap_err();
	assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);
	assert!(err.to_string().contains("PI_CONFIG_DIR"), "{err}");
}
