//! Listing, liveness, pruning and sweeps.

use std::time::SystemTime;

use serde_json::json;

use super::*;
use crate::{
	InstanceError, InstanceHost, Probe, ProbeRequest, STALE_TMP_AGE,
	client::ConnectFailure,
	list,
	list::{Verdict, connect_verdict, exchange_verdict},
	list_alive,
};

/// Ids `list` returns for `capability`, probing with `<capability>.probe`.
async fn listed_ids(dir: &Path, capability: &str, exclude: Option<&str>) -> Vec<String> {
	let probe = |_: &InstanceEntry| ProbeRequest {
		op:           format!("{capability}.probe"),
		body:         raw(&json!({})),
		max_response: MAX_RESPONSE,
	};
	list(dir, capability, exclude, probe, Duration::from_millis(500))
		.await
		.unwrap()
		.into_iter()
		.map(|(entry, probe)| {
			assert!(matches!(probe, Probe::Body(_)), "{probe:?}");
			entry.instance_id
		})
		.collect()
}

/// Leave a dead socket file and its (stale) bind lock at `endpoint`.
#[cfg(unix)]
fn stale_socket(endpoint: &str) {
	drop(std::os::unix::net::UnixListener::bind(endpoint).unwrap());
	let lock = format!("{endpoint}.bind.lock");
	std::fs::write(&lock, b"").unwrap();
	age(Path::new(&lock));
}

/// Backdate `path` past [`STALE_TMP_AGE`].
fn age(path: &Path) {
	let past = SystemTime::now() - STALE_TMP_AGE - Duration::from_secs(5);
	std::fs::File::options()
		.write(true)
		.open(path)
		.unwrap()
		.set_modified(past)
		.unwrap();
}

#[tokio::test]
async fn prunes_dead_and_malformed_entries_and_keeps_live_foreign_or_unanswering_ones() {
	let tmp = tempfile::tempdir().unwrap();
	let dir = tmp.path();
	let me = std::process::id();
	let host = InstanceHost::new(dir, Some(A.into())).unwrap();
	let _reg = host.register("echo", Echo::new()).await.unwrap();

	// v1, endpoint gone (pid alive: the probe decides) -> pruned with its files.
	let dead = dead_entry(dir, B, &["echo"]);
	write_entry(dir, B, &entry_json(&dead));
	#[cfg(unix)]
	stale_socket(&dead.endpoint);
	// Unparsable, or without numeric `v`/`pid` -> pruned.
	std::fs::write(entry_file(dir, "garbage"), b"{not json").unwrap();
	write_entry(dir, "nopid", &json!({ "v": 1 }));
	// File name and id disagree -> pruned.
	write_entry(dir, D, &entry_json(&dead_entry(dir, C, &["echo"])));
	// Endpoint not derived from `<id>-<nonce>` -> pruned; the path is never
	// touched.
	let bystander = dir.join("bystander.sock");
	std::fs::write(&bystander, b"not ours").unwrap();
	let mut foreign = dead_entry(dir, E, &["echo"]);
	foreign.endpoint = bystander.to_str().unwrap().to_owned();
	write_entry(dir, E, &entry_json(&foreign));
	// Another format version: kept while its pid lives, whatever its shape.
	let future_live = write_entry(dir, "1111111111111111", &json!({ "v": 3, "pid": me, "x": true }));
	let future_dead = write_entry(dir, "2222222222222222", &json!({ "v": 3, "pid": DEAD_PID }));
	std::fs::write(dir.join("notes.txt"), b"ignored").unwrap();
	// Accepts but never answers -> skipped after the timeout, kept.
	let silent = dead_entry(dir, "3333333333333333", &["echo"]);
	let (mut silent_listener, silent_bound) = pi_ipc::listen(&silent.endpoint).await.unwrap();
	let hold = tokio::spawn(async move {
		#[allow(clippy::collection_is_never_read, reason = "keeps accepted connections open")]
		let mut held = Vec::new();
		while let Ok(stream) = silent_listener.accept().await {
			held.push(stream);
		}
	});
	write_entry(dir, &silent.instance_id, &entry_json(&silent));

	assert_eq!(listed_ids(dir, "echo", None).await, [A]);
	let mut expected = vec![
		"1111111111111111.json".to_owned(),
		"3333333333333333.json".to_owned(),
		format!("{A}.json"),
		"bystander.sock".to_owned(),
		"notes.txt".to_owned(),
	];
	#[cfg(unix)]
	{
		let socket = |entry: &InstanceEntry| {
			Path::new(&entry.endpoint)
				.file_name()
				.unwrap()
				.to_str()
				.unwrap()
				.to_owned()
		};
		let own = host.entry().unwrap();
		for entry in [&own, &silent] {
			expected.extend([socket(entry), format!("{}.bind.lock", socket(entry))]);
		}
	}
	expected.sort();
	assert_eq!(names_in(dir), expected);
	assert!(future_live.exists() && !future_dead.exists());
	assert_eq!(std::fs::read(&bystander).unwrap(), b"not ours");

	hold.abort();
	pi_ipc::release(silent_bound);
}

#[test]
fn only_a_refused_or_missing_endpoint_proves_death() {
	let io = |code| ConnectFailure::Io(pi_ipc::IpcError::new(code, "test"));
	assert!(matches!(connect_verdict(&io("ENOENT")), Verdict::Dead));
	assert!(matches!(connect_verdict(&io("EMFILE")), Verdict::Skip));
	assert!(matches!(connect_verdict(&ConnectFailure::Busy), Verdict::Busy));
	assert!(matches!(connect_verdict(&ConnectFailure::WrongServer), Verdict::Misdirected));

	assert!(matches!(exchange_verdict(Err(InstanceError::Remote("busy".into()))), Verdict::Busy));
	assert!(matches!(exchange_verdict(Err(InstanceError::Misdirected)), Verdict::Misdirected));
	assert!(matches!(exchange_verdict(Err(InstanceError::Timeout)), Verdict::Skip));
	// A connection that broke after connecting proves nothing.
	let mid_exchange = InstanceError::Unreachable { code: "ENOENT", message: String::new() };
	assert!(matches!(exchange_verdict(Err(mid_exchange)), Verdict::Skip));
}

#[cfg(unix)]
#[tokio::test]
async fn an_inaccessible_endpoint_is_skipped_not_pruned() {
	use std::os::unix::fs::PermissionsExt;
	// SAFETY: geteuid has no preconditions.
	if unsafe { libc::geteuid() } == 0 {
		return; // root ignores socket permissions
	}
	let tmp = tempfile::tempdir().unwrap();
	let dir = tmp.path();
	let host = InstanceHost::new(dir, Some(A.into())).unwrap();
	let _reg = host.register("echo", Echo::new()).await.unwrap();
	let socket = host.entry().unwrap().endpoint;
	std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o000)).unwrap();
	assert!(listed_ids(dir, "echo", None).await.is_empty());
	assert!(entry_file(dir, A).exists(), "EACCES says nothing about liveness");
	std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600)).unwrap();
	assert_eq!(listed_ids(dir, "echo", None).await, [A]);
}

#[cfg(unix)]
#[tokio::test]
async fn an_unreadable_directory_is_a_listing_error_not_empty() {
	use std::os::unix::fs::PermissionsExt;
	// SAFETY: geteuid has no preconditions.
	if unsafe { libc::geteuid() } == 0 {
		return; // root reads any directory
	}
	let tmp = tempfile::tempdir().unwrap();
	let dir = tmp.path().join("instances");
	std::fs::create_dir(&dir).unwrap();
	std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o300)).unwrap();
	let result = list_alive(&dir, "echo", None, TIMEOUT).await;
	std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
	assert!(matches!(result, Err(crate::DirError::Io(..))), "{result:?}");
}

#[tokio::test]
async fn capability_filter_probes_only_matching_hosts_and_any_lister_prunes_the_dead() {
	let tmp = tempfile::tempdir().unwrap();
	let dir = tmp.path();
	let (alpha, beta) = (Echo::new(), Echo::new());
	let a = InstanceHost::new(dir, Some(A.into())).unwrap();
	let _ra = a.register("alpha", alpha.clone()).await.unwrap();
	let b = InstanceHost::new(dir, Some(B.into())).unwrap();
	let _rb = b.register("beta", beta.clone()).await.unwrap();
	let idle = InstanceHost::new(dir, Some(C.into())).unwrap();
	idle
		.register("gone", Echo::new())
		.await
		.unwrap()
		.unregister()
		.await;
	assert!(read_entry(dir, C).capabilities.is_empty());
	write_entry(dir, D, &entry_json(&dead_entry(dir, D, &[])));
	write_entry(dir, E, &entry_json(&dead_entry(dir, E, &["beta"])));

	assert_eq!(listed_ids(dir, "alpha", None).await, [A]);
	assert_eq!(beta.calls(), 0, "hosts outside the capability get no token");
	assert!(entry_file(dir, B).exists() && entry_file(dir, C).exists(), "live hosts stay");
	assert!(!entry_file(dir, D).exists() && !entry_file(dir, E).exists(), "dead hosts go");
	assert!(listed_ids(dir, "alpha", Some(A)).await.is_empty(), "exclude");

	let alive = list_alive(dir, "beta", None, TIMEOUT).await.unwrap();
	assert_eq!(
		alive
			.iter()
			.map(|e| e.instance_id.as_str())
			.collect::<Vec<_>>(),
		[B]
	);
	assert_eq!((alpha.calls(), beta.calls()), (1, 0), "liveness never runs a handler");
	b.withdraw_sync();
	write_entry(dir, B, &entry_json(&dead_entry(dir, B, &["beta"])));
	assert!(
		list_alive(dir, "beta", None, TIMEOUT)
			.await
			.unwrap()
			.is_empty()
	);
	assert!(!entry_file(dir, B).exists());
}

#[tokio::test]
async fn listers_never_see_a_partial_entry_while_capabilities_change() {
	let tmp = tempfile::tempdir().unwrap();
	let dir = tmp.path().to_owned();
	let host = Arc::new(InstanceHost::new(&dir, Some(A.into())).unwrap());
	let _keep = host.register("echo", Echo::new()).await.unwrap();
	let flipper = tokio::spawn({
		let host = Arc::clone(&host);
		async move {
			for _ in 0..100 {
				host
					.register("flip", Echo::new())
					.await
					.unwrap()
					.unregister()
					.await;
			}
		}
	});
	while !flipper.is_finished() {
		assert_eq!(listed_ids(&dir, "echo", None).await, [A]);
	}
	flipper.await.unwrap();
	assert_eq!(read_entry(&dir, A).capabilities, ["echo"]);
}

#[tokio::test]
async fn listing_repairs_a_loose_directory_and_only_reads_a_private_one() {
	let tmp = tempfile::tempdir().unwrap();
	let dir = tmp.path();
	let private = || {
		#[cfg(unix)]
		{
			use std::os::unix::fs::PermissionsExt;
			std::fs::metadata(dir).unwrap().permissions().mode() & 0o777 == 0o700
		}
		#[cfg(windows)]
		{
			pi_ipc::winsec::verify_dir_restricted(dir).unwrap()
		}
	};
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o755)).unwrap();
	}
	assert!(!private(), "a fresh directory inherits looser access");
	assert!(listed_ids(dir, "echo", None).await.is_empty());
	assert!(private(), "listing repaired it");
	assert!(listed_ids(dir, "echo", None).await.is_empty());
	assert!(private());
}

#[tokio::test]
async fn sweeps_only_stale_temp_files() {
	let tmp = tempfile::tempdir().unwrap();
	let dir = tmp.path();
	let old = dir.join(format!("{A}.0123456789ab.tmp"));
	let fresh = dir.join(format!("{B}.0123456789ab.tmp"));
	std::fs::write(&old, b"{").unwrap();
	std::fs::write(&fresh, b"{").unwrap();
	age(&old);
	assert!(listed_ids(dir, "echo", None).await.is_empty());
	assert!(!old.exists());
	assert!(fresh.exists());
}

#[tokio::test]
async fn pruning_a_stale_probe_spares_the_republished_successor() {
	let tmp = tempfile::tempdir().unwrap();
	let dir = tmp.path();
	let stale = dead_entry(dir, A, &["echo"]);
	let host = InstanceHost::new(dir, Some(A.into())).unwrap();
	let _reg = host.register("echo", Echo::new()).await.unwrap();
	// A lister found `stale` dead, then the successor republished `A`.
	assert!(!crate::list::prune_if_unchanged(dir, A, &stale.token, stale.created_at, true).unwrap());
	assert_eq!(listed_ids(dir, "echo", None).await, [A]);
}

#[cfg(unix)]
#[tokio::test]
async fn sweeps_orphan_sockets_and_locks_only_when_provably_dead() {
	use std::os::unix::net::UnixListener;
	let tmp = tempfile::tempdir().unwrap();
	let dir = tmp.path();
	let sock = |id: &str| dir.join(format!("{id}-0123456789abcdef.sock"));
	let lock = |id: &str| dir.join(format!("{id}-0123456789abcdef.sock.bind.lock"));
	// Dead, no lock: swept, and the lock the sweep created is removed again.
	drop(UnixListener::bind(sock(A)).unwrap());
	// Dead with an old lock: both swept.
	drop(UnixListener::bind(sock(B)).unwrap());
	std::fs::write(lock(B), b"").unwrap();
	age(&lock(B));
	// Listening without an entry yet (between bind and the entry write): kept.
	let _live = UnixListener::bind(sock(C)).unwrap();
	// Dead, but a binder holds the lock (between bind and listen): kept.
	drop(UnixListener::bind(sock(D)).unwrap());
	let held = std::fs::File::create(lock(D)).unwrap();
	held.lock().unwrap();
	// An old lock whose socket is gone: removed.
	std::fs::write(lock(E), b"").unwrap();
	age(&lock(E));
	// A fresh lock without a socket: a binder may not have locked it yet.
	let fresh = dir.join("ffffffffffffffff-0123456789abcdef.sock.bind.lock");
	std::fs::write(&fresh, b"").unwrap();
	// Not an endpoint name: never touched.
	let other = dir.join("other.sock");
	drop(UnixListener::bind(&other).unwrap());

	assert!(listed_ids(dir, "echo", None).await.is_empty());
	let name = |path: PathBuf| path.file_name().unwrap().to_str().unwrap().to_owned();
	let mut expected =
		vec![name(sock(C)), name(sock(D)), name(lock(D)), name(fresh), "other.sock".to_owned()];
	expected.sort();
	assert_eq!(names_in(dir), expected);
	drop(held);
}

#[cfg(unix)]
#[test]
fn sockets_are_never_swept_through_a_directory_others_can_write() {
	use std::os::unix::fs::PermissionsExt;
	let tmp = tempfile::tempdir().unwrap();
	let dir = tmp.path().join("loose");
	std::fs::create_dir(&dir).unwrap();
	std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
	let socket = dir.join(format!("{A}-0123456789abcdef.sock"));
	drop(std::os::unix::net::UnixListener::bind(&socket).unwrap());
	crate::list::sweep_endpoint(&socket);
	assert_eq!(names_in(&dir), [format!("{A}-0123456789abcdef.sock")], "nothing created or removed");
}

#[cfg(unix)]
#[tokio::test]
async fn relocated_endpoints_are_listed_and_cleaned_at_their_derived_path() {
	let tmp = tempfile::tempdir().unwrap();
	let dir = tmp
		.path()
		.join("n".repeat(60))
		.join("m".repeat(60))
		.join("instances");
	let host = InstanceHost::new(&dir, Some(A.into())).unwrap();
	let _reg = host.register("echo", Echo::new()).await.unwrap();
	let entry = host.entry().unwrap();
	assert!(!Path::new(&entry.endpoint).starts_with(&dir), "relocated under /tmp/omp-<euid>");
	assert_eq!(listed_ids(&dir, "echo", None).await, [A]);

	// A crashed predecessor at a relocated path: entry, socket and lock go.
	let dead = dead_entry(&dir, B, &["echo"]);
	write_entry(&dir, B, &entry_json(&dead));
	stale_socket(&dead.endpoint);
	assert_eq!(listed_ids(&dir, "echo", None).await, [A]);
	assert!(!entry_file(&dir, B).exists());
	assert!(!Path::new(&dead.endpoint).exists());
	assert!(!Path::new(&format!("{}.bind.lock", dead.endpoint)).exists());

	host.withdraw_sync();
	assert!(!Path::new(&entry.endpoint).exists());
	assert!(!Path::new(&format!("{}.bind.lock", entry.endpoint)).exists());
}
