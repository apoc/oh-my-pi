//! `InstanceHost` lifecycle and the endpoint wire protocol.

use serde_json::{Value, json};

use super::*;
use crate::{
	HostError, InstanceError, InstanceHost, Probe, ProbeRequest, list, remove_entry_if, request,
};

fn ping() -> Box<RawValue> {
	raw(&json!({ "x": 1 }))
}

async fn ask(entry: &InstanceEntry, op: &str) -> Result<Value, InstanceError> {
	request(entry, op, &ping(), TIMEOUT, MAX_RESPONSE)
		.await
		.map(|body| serde_json::from_str(body.get()).unwrap())
}

#[tokio::test]
async fn first_registration_publishes_a_v1_entry_that_serves_requests() {
	let tmp = tempfile::tempdir().unwrap();
	let dir = tmp.path().join("run").join("instances");
	let host = InstanceHost::new(&dir, Some(A.into())).unwrap();
	assert!(!dir.exists(), "nothing is created before the first registration");

	let _reg = host.register("echo", Echo::new()).await.unwrap();
	let file: Value = serde_json::from_slice(&std::fs::read(entry_file(&dir, A)).unwrap()).unwrap();
	let nonce = file["nonce"].as_str().unwrap();
	assert_eq!(file["v"], 1);
	assert_eq!(file["instanceId"], A);
	assert_eq!(file["pid"], std::process::id());
	assert_eq!(file["capabilities"], json!(["echo"]));
	assert_eq!(file["endpoint"], pi_ipc::endpoint(dir.to_str().unwrap(), &format!("{A}-{nonce}")));
	assert!(nonce.len() == 16 && nonce.bytes().all(|b| b.is_ascii_hexdigit()));
	let token = file["token"].as_str().unwrap();
	assert!(token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit()));

	let entry = read_entry(&dir, A);
	assert!(!format!("{entry:?}").contains(&entry.token), "Debug must not reveal the token");
	assert_eq!(
		ask(&entry, "echo.ping").await.unwrap(),
		json!({ "op": "ping", "body": { "x": 1 }, "to": A })
	);

	#[cfg(unix)]
	{
		use std::{os::unix::fs::PermissionsExt, path::Path};
		let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
		assert_eq!(mode(&dir), 0o700);
		assert_eq!(mode(&entry_file(&dir, A)), 0o600);
		assert_eq!(mode(Path::new(&entry.endpoint)), 0o600);
	}
}

#[cfg(unix)]
#[tokio::test]
async fn loose_existing_directory_is_tightened_to_owner_only() {
	use std::os::unix::fs::PermissionsExt;
	let tmp = tempfile::tempdir().unwrap();
	let dir = tmp.path().join("instances");
	std::fs::create_dir(&dir).unwrap();
	std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
	let host = InstanceHost::new(&dir, None).unwrap();
	let _reg = host.register("echo", Echo::new()).await.unwrap();
	assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
}

#[tokio::test]
async fn linked_directory_is_refused_for_publishing_and_listing() {
	let target = tempfile::tempdir().unwrap();
	let bystander = target.path().join("important.json");
	std::fs::write(&bystander, b"{not registry metadata").unwrap();
	let parent = tempfile::tempdir().unwrap();
	let link = parent.path().join("instances");
	#[cfg(unix)]
	std::os::unix::fs::symlink(target.path(), &link).unwrap();
	#[cfg(windows)]
	assert!(
		std::process::Command::new("cmd")
			.args(["/C", "mklink", "/J"])
			.arg(&link)
			.arg(target.path())
			.output()
			.unwrap()
			.status
			.success()
	);

	let host = InstanceHost::new(&link, None).unwrap();
	let error = host.register("echo", Echo::new()).await.unwrap_err();
	assert!(matches!(error, HostError::Dir(crate::DirError::Insecure(..))), "{error}");
	let probe = |_: &InstanceEntry| ProbeRequest {
		op:           "echo.x".into(),
		body:         ping(),
		max_response: MAX_RESPONSE,
	};
	assert!(list(&link, "echo", None, probe, TIMEOUT).await.is_err());
	assert_eq!(names_in(target.path()), ["important.json"]);
	assert_eq!(std::fs::read(&bystander).unwrap(), b"{not registry metadata");
}

#[tokio::test]
async fn capabilities_follow_registrations_within_one_publication() {
	let tmp = tempfile::tempdir().unwrap();
	let dir = tmp.path();
	let host = InstanceHost::new(dir, Some(A.into())).unwrap();
	let beta = host.register("beta", Echo::new()).await.unwrap();
	let alpha = host.register("alpha", Echo::new()).await.unwrap();
	let first = read_entry(dir, A);
	assert_eq!(first.capabilities, ["alpha", "beta"], "sorted");

	alpha.unregister().await;
	let entry = read_entry(dir, A);
	assert_eq!(entry.capabilities, ["beta"]);
	assert_eq!(ask(&entry, "alpha.x").await, Err(InstanceError::Remote("unavailable".into())));

	// Dropping stops routing at once; the rewrite follows off-thread.
	drop(beta);
	assert_eq!(ask(&entry, "beta.x").await, Err(InstanceError::Remote("unavailable".into())));
	let deadline = tokio::time::Instant::now() + TIMEOUT;
	let empty = loop {
		let current = read_entry(dir, A);
		if current.capabilities.is_empty() {
			break current;
		}
		assert!(tokio::time::Instant::now() < deadline, "the dropped namespace is unpublished");
		tokio::time::sleep(Duration::from_millis(10)).await;
	};
	let _again = host.register("alpha", Echo::new()).await.unwrap();
	let last = read_entry(dir, A);
	assert_eq!(last.capabilities, ["alpha"]);
	for entry in [&entry, &empty, &last] {
		assert_eq!(
			(&entry.endpoint, &entry.token, &entry.nonce, entry.created_at),
			(&first.endpoint, &first.token, &first.nonce, first.created_at),
			"capability rewrites keep the publication"
		);
	}
	assert!(ask(&last, "alpha.x").await.is_ok());
}

#[tokio::test]
async fn a_namespace_has_one_registration_at_a_time() {
	let tmp = tempfile::tempdir().unwrap();
	let host = InstanceHost::new(tmp.path(), Some(A.into())).unwrap();
	let (first, second) = (Echo::new(), Echo::new());
	let reg = host.register("echo", first.clone()).await.unwrap();
	let error = host.register("echo", second.clone()).await.unwrap_err();
	assert!(matches!(&error, HostError::AlreadyRegistered(ns) if ns == "echo"), "{error}");
	let invalid = host.register("echo.sub", Echo::new()).await.unwrap_err();
	assert!(matches!(invalid, HostError::InvalidNamespace(_)), "{invalid}");

	let entry = read_entry(tmp.path(), A);
	ask(&entry, "echo.x").await.unwrap();
	assert_eq!((first.calls(), second.calls()), (1, 0), "the rejected handler never serves");

	drop(reg);
	let _reg = host.register("echo", second.clone()).await.unwrap();
	ask(&entry, "echo.x").await.unwrap();
	assert_eq!((first.calls(), second.calls()), (1, 1));
}

#[tokio::test]
async fn invalid_instance_ids_are_rejected() {
	let tmp = tempfile::tempdir().unwrap();
	for id in ["../escape", "AAAAAAAAAAAAAAAA", "short"] {
		let error = InstanceHost::new(tmp.path(), Some(id.into())).unwrap_err();
		assert!(matches!(error, HostError::InvalidInstanceId), "{id}: {error}");
	}
}

#[tokio::test]
async fn server_checks_requests_in_protocol_order() {
	let tmp = tempfile::tempdir().unwrap();
	let host = InstanceHost::new(tmp.path(), Some(A.into())).unwrap();
	let echo = Echo::with_max_body(16);
	let _reg = host.register("echo", echo.clone()).await.unwrap();
	let entry = read_entry(tmp.path(), A);
	let token = entry.token.as_str();
	let line = |value: Value| serde_json::to_vec(&value).unwrap();
	let cases = [
		(b"{not json".to_vec(), "malformed_request"),
		(line(json!([1])), "malformed_request"),
		(line(json!({ "v": 2, "token": "bad", "to": B, "op": "x.y" })), "unsupported_protocol"),
		(line(json!({ "token": token, "to": A, "op": "echo.x" })), "unsupported_protocol"),
		(line(json!({ "v": 1, "token": "bad", "to": B, "op": "x.y" })), "authentication_failed"),
		(line(json!({ "v": 1, "token": 7, "to": A, "op": "echo.x" })), "authentication_failed"),
		(line(json!({ "v": 1, "token": token, "to": B, "op": "x.y" })), "misdirected"),
		(line(json!({ "v": 1, "token": token, "to": A, "op": "nope.x" })), "unavailable"),
		(line(json!({ "v": 1, "token": token, "to": A })), "invalid_operation"),
		(
			line(
				json!({ "v": 1, "token": token, "to": A, "op": "echo.x", "body": "0123456789abcdef" }),
			),
			"too_large",
		),
	];
	for (request, code) in cases {
		let response = raw_exchange(&entry.endpoint, &request).await;
		assert_eq!(response, wire_error(code), "{}", String::from_utf8_lossy(&request));
	}
	assert_eq!(echo.calls(), 0, "no rejected request reaches the handler");

	let response = raw_exchange(
		&entry.endpoint,
		&line(json!({ "v": 1, "token": token, "to": A, "op": "echo.go" })),
	)
	.await;
	assert_eq!(
		response,
		json!({ "v": 1, "ok": true, "body": { "op": "go", "body": null, "to": A } })
	);
}

#[tokio::test]
async fn oversized_request_line_is_refused_before_authentication() {
	let tmp = tempfile::tempdir().unwrap();
	let host = InstanceHost::new(tmp.path(), Some(A.into())).unwrap();
	let echo = Echo::new();
	let _reg = host.register("echo", echo.clone()).await.unwrap();
	let entry = read_entry(tmp.path(), A);
	let padding = "x".repeat(crate::MAX_REQUEST_LINE_BYTES);
	let line = serde_json::to_vec(
		&json!({ "v": 1, "token": entry.token, "to": A, "op": "echo.x", "body": padding }),
	)
	.unwrap();
	assert_eq!(raw_exchange(&entry.endpoint, &line).await, wire_error("too_large"));
	assert_eq!(echo.calls(), 0);
	assert!(ask(&entry, "echo.x").await.is_ok(), "the host keeps serving");
}

#[tokio::test]
async fn client_maps_answers_and_caps() {
	let tmp = tempfile::tempdir().unwrap();
	let host = InstanceHost::new(tmp.path(), Some(A.into())).unwrap();
	let _reg = host.register("echo", Echo::new()).await.unwrap();
	let entry = read_entry(tmp.path(), A);

	let wrong_to = InstanceEntry { instance_id: B.into(), ..entry.clone() };
	assert_eq!(ask(&wrong_to, "echo.x").await, Err(InstanceError::Misdirected));
	let wrong_token = InstanceEntry { token: "00".repeat(32), ..entry.clone() };
	assert_eq!(
		ask(&wrong_token, "echo.x").await,
		Err(InstanceError::Remote("authentication_failed".into()))
	);
	let capped = request(&entry, "echo.x", &ping(), TIMEOUT, 16).await;
	assert!(matches!(capped, Err(InstanceError::BadResponse(_))), "{capped:?}");

	// A body with insignificant newlines still travels as one line.
	let multi_line = RawValue::from_string("{\n\"x\":\r\n1}".into()).unwrap();
	let body = request(&entry, "echo.x", &multi_line, TIMEOUT, MAX_RESPONSE)
		.await
		.unwrap();
	assert_eq!(serde_json::from_str::<Value>(body.get()).unwrap()["body"], json!({ "x": 1 }));
}

#[tokio::test]
async fn connection_limit_answers_busy_and_counts_as_alive() {
	let tmp = tempfile::tempdir().unwrap();
	let dir = tmp.path();
	let host = InstanceHost::new(dir, Some(A.into())).unwrap();
	let echo = Echo::new();
	let _reg = host.register("echo", echo.clone()).await.unwrap();
	let entry = read_entry(dir, A);

	// Idle connections hold every slot until the request read deadline.
	let mut idle = Vec::new();
	for _ in 0..crate::MAX_CONNECTIONS {
		idle.push(pi_ipc::connect(&entry.endpoint, TIMEOUT).await.unwrap());
	}
	assert_eq!(ask(&entry, "echo.x").await, Err(InstanceError::Remote("busy".into())));
	let probe = |_: &InstanceEntry| ProbeRequest {
		op:           "echo.x".into(),
		body:         ping(),
		max_response: MAX_RESPONSE,
	};
	let listed = list(dir, "echo", None, probe, TIMEOUT).await.unwrap();
	assert!(matches!(listed.as_slice(), [(e, Probe::Busy)] if e.instance_id == A), "{listed:?}");
	assert!(entry_file(dir, A).exists(), "a busy host is not pruned");
	assert_eq!(echo.calls(), 0);

	drop(idle);
	let deadline = tokio::time::Instant::now() + TIMEOUT;
	while ask(&entry, "echo.x").await.is_err() {
		assert!(tokio::time::Instant::now() < deadline, "slots are released");
		tokio::time::sleep(Duration::from_millis(20)).await;
	}
}

#[tokio::test]
async fn close_withdraws_everything_and_is_terminal() {
	let tmp = tempfile::tempdir().unwrap();
	let dir = tmp.path();
	let host = InstanceHost::new(dir, Some(A.into())).unwrap();
	let reg = host.register("echo", Echo::new()).await.unwrap();
	let entry = read_entry(dir, A);

	host.close().await;
	assert!(host.entry().is_none());
	let after = ask(&entry, "echo.x").await;
	assert!(matches!(after, Err(InstanceError::Unreachable { .. })), "{after:?}");
	let reopen = host.register("other", Echo::new()).await.unwrap_err();
	assert!(matches!(reopen, HostError::Closed), "{reopen}");
	assert!(!host.ensure_published().unwrap(), "no rewrite after close");
	drop(reg);
	host.close().await;
	assert_eq!(names_in(dir), Vec::<String>::new(), "entry, socket and bind lock are gone");
}

#[tokio::test]
async fn withdraw_sync_and_drop_remove_entry_socket_and_lock() {
	let tmp = tempfile::tempdir().unwrap();
	let dir = tmp.path();
	let host = InstanceHost::new(dir, Some(A.into())).unwrap();
	let _reg = host.register("echo", Echo::new()).await.unwrap();
	let entry = read_entry(dir, A);
	host.withdraw_sync();
	assert_eq!(names_in(dir), Vec::<String>::new());
	// Unix unlinks the socket synchronously; a pipe disappears once the
	// aborted accept task is dropped.
	let after = ask(&entry, "echo.x").await;
	assert!(matches!(after, Err(InstanceError::Unreachable { .. })), "{after:?}");
	#[cfg(unix)]
	assert_eq!(after.unwrap_err().io_code(), Some("ENOENT"));
	assert!(matches!(host.register("echo", Echo::new()).await, Err(HostError::Closed)));

	let dropped = InstanceHost::new(dir, Some(B.into())).unwrap();
	let reg = dropped.register("echo", Echo::new()).await.unwrap();
	drop(dropped);
	assert_eq!(names_in(dir), Vec::<String>::new(), "dropping the host withdraws it");
	drop(reg);
	assert_eq!(names_in(dir), Vec::<String>::new(), "a registration outliving its host is inert");
}

#[tokio::test]
async fn owner_self_heals_and_conditional_removal_spares_republished_entries() {
	let tmp = tempfile::tempdir().unwrap();
	let dir = tmp.path();
	let host = InstanceHost::new(dir, Some(A.into())).unwrap();
	assert!(!host.ensure_published().unwrap(), "nothing to publish before registering");
	let _reg = host.register("echo", Echo::new()).await.unwrap();
	assert!(!host.ensure_published().unwrap());
	std::fs::remove_file(entry_file(dir, A)).unwrap();
	assert!(host.ensure_published().unwrap());
	let current = read_entry(dir, A);
	assert_eq!(Some(&current), host.entry().as_ref());

	// A lister probed an older publication (other token/createdAt) that is
	// gone; the file now holds the live one and must survive.
	assert!(!remove_entry_if(dir, A, &"00".repeat(32), 1).unwrap());
	assert!(entry_file(dir, A).exists());
	assert!(remove_entry_if(dir, A, &current.token, current.created_at).unwrap());
	assert!(!entry_file(dir, A).exists());
	assert!(ask(&current, "echo.x").await.is_ok(), "the endpoint is never touched");
}

#[tokio::test]
async fn failed_entry_write_leaves_no_artifacts_and_can_be_retried() {
	let tmp = tempfile::tempdir().unwrap();
	let dir = tmp.path();
	// A directory where the entry goes makes the final rename fail.
	std::fs::create_dir(entry_file(dir, A)).unwrap();
	let host = InstanceHost::new(dir, Some(A.into())).unwrap();
	let error = host.register("echo", Echo::new()).await.unwrap_err();
	assert!(matches!(error, HostError::Write(..)), "{error}");
	assert_eq!(names_in(dir), [format!("{A}.json")], "no temp file, socket or bind lock");

	std::fs::remove_dir(entry_file(dir, A)).unwrap();
	let _reg = host.register("echo", Echo::new()).await.unwrap();
	assert!(ask(&read_entry(dir, A), "echo.x").await.is_ok());
}

#[cfg(windows)]
#[tokio::test]
async fn pipe_served_by_another_pid_is_misdirected_and_pruned() {
	let tmp = tempfile::tempdir().unwrap();
	let dir = tmp.path();
	let host = InstanceHost::new(dir, Some(A.into())).unwrap();
	let _reg = host.register("echo", Echo::new()).await.unwrap();
	let entry = read_entry(dir, A);
	let forged = InstanceEntry { pid: entry.pid ^ 4, ..entry.clone() };
	assert_eq!(ask(&forged, "echo.x").await, Err(InstanceError::Misdirected));

	write_entry(dir, A, &entry_json(&forged));
	let probe = |_: &InstanceEntry| ProbeRequest {
		op:           "echo.x".into(),
		body:         ping(),
		max_response: MAX_RESPONSE,
	};
	assert!(
		list(dir, "echo", None, probe, TIMEOUT)
			.await
			.unwrap()
			.is_empty()
	);
	assert!(!entry_file(dir, A).exists());
	assert!(host.ensure_published().unwrap(), "the owner republishes");
}

#[tokio::test]
async fn hosts_in_one_process_are_independent() {
	let tmp = tempfile::tempdir().unwrap();
	let dir = tmp.path();
	let (one, two) = (
		InstanceHost::new(dir, Some(A.into())).unwrap(),
		InstanceHost::new(dir, Some(B.into())).unwrap(),
	);
	let _r1 = one.register("echo", Echo::new()).await.unwrap();
	let _r2 = two.register("echo", Echo::new()).await.unwrap();
	let (a, b) = (read_entry(dir, A), read_entry(dir, B));
	assert_ne!(a.endpoint, b.endpoint);
	assert_eq!(ask(&a, "echo.x").await.unwrap()["to"], A);
	assert_eq!(ask(&b, "echo.x").await.unwrap()["to"], B);
	one.close().await;
	assert_eq!(ask(&b, "echo.x").await.unwrap()["to"], B, "closing one leaves the other");
}

#[tokio::test]
async fn a_cancelled_registration_never_strands_a_listener_or_a_namespace() {
	for step in 0..24u64 {
		let tmp = tempfile::tempdir().unwrap();
		let dir = tmp.path().join("instances");
		let host = InstanceHost::new(&dir, Some(A.into())).unwrap();
		if step % 2 == 1 {
			// Cancel the namespace addition on a live host instead of the bind.
			let _keep = host.register("keep", Echo::new()).await.unwrap();
			let cancelled = host.register("echo", Echo::new());
			let _ = tokio::time::timeout(Duration::from_micros(step * 150), cancelled).await;
			let again = host.register("echo", Echo::new()).await;
			assert!(again.is_ok(), "step {step}: {again:?}");
		} else {
			let cancelled = host.register("echo", Echo::new());
			let _ = tokio::time::timeout(Duration::from_micros(step * 150), cancelled).await;
			// Whatever was bound is the host's to withdraw; the namespace is free.
			let again = host.register("echo", Echo::new()).await;
			assert!(again.is_ok(), "step {step}: {again:?}");
		}
		host.close().await;
		let left = if dir.exists() {
			names_in(&dir)
		} else {
			Vec::new()
		};
		assert!(left.is_empty(), "step {step}: close leaves {left:?}");
	}
}

#[tokio::test]
async fn handler_codes_reserved_for_the_instance_layer_become_internal() {
	struct Says(&'static str);
	impl Handler for Says {
		fn handle(&self, _: &str, _: &RawValue, _: RequestCtx) -> BoxFuture<HandlerReply> {
			let code = self.0;
			Box::pin(async move { HandlerReply::Error(code.into()) })
		}

		fn max_body_bytes(&self) -> usize {
			64
		}
	}
	let tmp = tempfile::tempdir().unwrap();
	let host = InstanceHost::new(tmp.path(), Some(A.into())).unwrap();
	let _lying = host
		.register("lying", Arc::new(Says("misdirected")))
		.await
		.unwrap();
	let _own = host
		.register("own", Arc::new(Says("stale_generation")))
		.await
		.unwrap();
	let entry = read_entry(tmp.path(), A);
	assert_eq!(ask(&entry, "lying.x").await, Err(InstanceError::Remote("internal".into())));
	assert_eq!(ask(&entry, "own.x").await, Err(InstanceError::Remote("stale_generation".into())));
}
