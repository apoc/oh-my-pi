//! Listing: read the registry, check every entry, prune what is provably dead
//! or malformed.
//!
//! Per `<id>.json`:
//! - unreadable: skipped (a concurrent removal, or not a file);
//! - not JSON, or lacking a numeric `v` and `pid`: pruned;
//! - another format version: pruned only once its `pid` is gone (a newer omp
//!   owns the format);
//! - v1 with a wrong shape (file name ≠ `instanceId`, bad nonce/token, an
//!   `endpoint` that is not the one derived from `<instanceId>-<nonce>`):
//!   pruned, the recorded endpoint path is never touched;
//! - v1 entries are then checked concurrently ([`LIST_CONCURRENCY`]), each
//!   within the caller's timeout: entries serving the requested capability with
//!   the caller's probe request, every other entry (including `[]`)
//!   connect-only, without sending the token.
//!
//! Outcomes: an answer or `busy` means alive. Connecting gives `ENOENT` /
//! `ECONNREFUSED`: dead, the entry is pruned if unchanged (same token and
//! `createdAt`; a republished entry survives) along with its socket and bind
//! lock. `misdirected`, a server running as another user, or (Windows) a pipe
//! served by another pid: the entry is pruned, the endpoint left alone.
//! Anything else (timeout, `EMFILE`, other `EACCES`, other answers): skipped,
//! never pruned.
//!
//! Sweeps (Unix sockets live in the directory unless relocated): `*.tmp`
//! older than [`STALE_TMP_AGE`]; a `<id>-<nonce>.sock` no entry references,
//! only inside a private directory, while holding its `.bind.lock` (a binder
//! holds it from bind to listen, and the lock must still be the file at its
//! path) and only if connecting is refused; a `.bind.lock` without its
//! socket, under the same lock, once older than [`STALE_TMP_AGE`]. A lock
//! file the sweep had to create is removed again.

#[cfg(unix)]
use std::path::PathBuf;
use std::{collections::HashSet, io, path::Path, sync::Arc, time::Duration};

use serde_json::{Value, value::RawValue};
use tokio::{sync::Semaphore, task::JoinSet};

#[cfg(unix)]
use crate::entry::endpoint_for;
use crate::{
	LIST_CONCURRENCY, STALE_TMP_AGE, VERSION,
	client::{self, ConnectFailure, InstanceError},
	dir::{DirError, assert_private_dir},
	entry::{
		ENTRY_SUFFIX, InstanceEntry, TMP_SUFFIX, dir_str, entry_path, is_instance_id, pid_alive,
	},
};

/// A live entry's answer to the caller's probe request.
#[derive(Debug)]
pub enum Probe {
	Body(Box<RawValue>),
	/// The host is at its connection limit (or, on Windows, every pipe
	/// instance stayed busy): alive, no answer.
	Busy,
}

/// The request [`list`] sends to an entry serving the capability.
#[derive(Debug)]
pub struct ProbeRequest {
	/// `<ns>.<op>`.
	pub op:           String,
	pub body:         Box<RawValue>,
	/// Response line cap.
	pub max_response: usize,
}

/// Live entries serving `capability` (other than `exclude`) with their
/// answer to `probe(entry)`.
///
/// Sorted oldest first (`createdAt`, then id). Prunes and sweeps as described
/// in the module docs. A missing directory lists empty; an insecure one is an
/// error.
pub async fn list<F>(
	dir: &Path,
	capability: &str,
	exclude: Option<&str>,
	probe: F,
	timeout: Duration,
) -> Result<Vec<(InstanceEntry, Probe)>, DirError>
where
	F: Fn(&InstanceEntry) -> ProbeRequest + Sync,
{
	let found = survey(dir, capability, exclude, Some(&probe), timeout).await?;
	Ok(found
		.into_iter()
		.filter_map(|(entry, verdict)| match verdict {
			Verdict::Body(body) => Some((entry, Probe::Body(body))),
			Verdict::Busy => Some((entry, Probe::Busy)),
			_ => None,
		})
		.collect())
}

/// Like [`list`] with a connect-only liveness check (no token sent, no
/// handler runs): entries serving `capability` whose endpoint accepts.
pub async fn list_alive(
	dir: &Path,
	capability: &str,
	exclude: Option<&str>,
	timeout: Duration,
) -> Result<Vec<InstanceEntry>, DirError> {
	let found = survey(dir, capability, exclude, None, timeout).await?;
	Ok(found
		.into_iter()
		.filter(|(_, verdict)| matches!(verdict, Verdict::Connected | Verdict::Busy))
		.map(|(entry, _)| entry)
		.collect())
}

/// Remove `instance_id`'s entry if it still holds the given publication.
///
/// The publication is identified by `token` and `created_at` (e.g. its
/// endpoint proved to serve another instance); a republished entry is left
/// alone, and the endpoint is never touched. Blocking. `Ok(true)` when
/// removed.
pub fn remove_entry_if(
	dir: &Path,
	instance_id: &str,
	token: &str,
	created_at: u64,
) -> io::Result<bool> {
	if !is_instance_id(instance_id) {
		return Ok(false);
	}
	prune_if_unchanged(dir, instance_id, token, created_at, false)
}

/// What checking one entry showed.
#[derive(Debug)]
pub(crate) enum Verdict {
	Body(Box<RawValue>),
	Busy,
	/// Connect-only check succeeded.
	Connected,
	/// Nothing listens: prune the entry and its endpoint files.
	Dead,
	/// Another instance (or process) serves the endpoint: prune the entry
	/// only.
	Misdirected,
	/// Unknown: keep the entry, do not list it.
	Skip,
}

/// Verdict for a failed connect.
pub(crate) fn connect_verdict(failure: &ConnectFailure) -> Verdict {
	match failure {
		ConnectFailure::Busy => Verdict::Busy,
		ConnectFailure::WrongServer => Verdict::Misdirected,
		ConnectFailure::Io(error) if matches!(error.code(), "ENOENT" | "ECONNREFUSED") => {
			Verdict::Dead
		},
		ConnectFailure::Io(_) => Verdict::Skip,
	}
}

/// Verdict for a probe exchange over an established connection.
pub(crate) fn exchange_verdict(result: Result<Box<RawValue>, InstanceError>) -> Verdict {
	match result {
		Ok(body) => Verdict::Body(body),
		Err(InstanceError::Remote(code)) if code == "busy" => Verdict::Busy,
		Err(InstanceError::Misdirected) => Verdict::Misdirected,
		Err(_) => Verdict::Skip,
	}
}

async fn survey(
	dir: &Path,
	capability: &str,
	exclude: Option<&str>,
	probe: Option<&(dyn Fn(&InstanceEntry) -> ProbeRequest + Sync)>,
	timeout: Duration,
) -> Result<Vec<(InstanceEntry, Verdict)>, DirError> {
	let Some(text) = dir_str(dir) else {
		return Ok(Vec::new());
	};
	let dir: Arc<Path> = dir.into();
	let dir_text: Arc<str> = text.into();
	let exclude = exclude.map(str::to_owned);
	let scanned = tokio::task::spawn_blocking({
		let (dir, dir_text) = (Arc::clone(&dir), Arc::clone(&dir_text));
		move || {
			if !assert_private_dir(&dir)? {
				return Ok(Vec::new());
			}
			scan(&dir, &dir_text, exclude.as_deref())
		}
	})
	.await
	.unwrap_or_else(|join| Err(DirError::Io(dir.to_path_buf(), io::Error::other(join))))?;

	let permits = Arc::new(Semaphore::new(LIST_CONCURRENCY));
	let mut checks = JoinSet::new();
	for entry in scanned {
		let listed = entry.capabilities.iter().any(|ns| ns == capability);
		let request = if listed {
			probe.map(|probe| probe(&entry))
		} else {
			None
		};
		let (dir, permits) = (Arc::clone(&dir), Arc::clone(&permits));
		checks.spawn(async move {
			let _permit = permits.acquire_owned().await;
			let verdict = check(&entry, request, timeout).await;
			let prune = match verdict {
				Verdict::Dead => Some(true),
				Verdict::Misdirected => Some(false),
				_ => None,
			};
			if let Some(endpoint_dead) = prune {
				let (id, token, created_at) =
					(entry.instance_id.clone(), entry.token.clone(), entry.created_at);
				let _ = tokio::task::spawn_blocking(move || {
					prune_if_unchanged(&dir, &id, &token, created_at, endpoint_dead)
				})
				.await;
			}
			listed.then_some((entry, verdict))
		});
	}
	let mut found = Vec::new();
	while let Some(result) = checks.join_next().await {
		if let Ok(Some(item)) = result {
			found.push(item);
		}
	}
	found.sort_by(|(a, _), (b, _)| {
		a.created_at
			.cmp(&b.created_at)
			.then_with(|| a.instance_id.cmp(&b.instance_id))
	});
	Ok(found)
}

/// Connect to `entry` (Windows busy retries get half the deadline, so a busy
/// pipe is reported before the whole check times out), then send `request`
/// or, without one, hang up.
async fn check(entry: &InstanceEntry, request: Option<ProbeRequest>, timeout: Duration) -> Verdict {
	tokio::time::timeout(timeout, async {
		let mut stream = match client::connect(entry, timeout / 2).await {
			Ok(stream) => stream,
			Err(failure) => return connect_verdict(&failure),
		};
		let Some(request) = request else {
			return Verdict::Connected;
		};
		exchange_verdict(
			client::exchange(&mut stream, entry, &request.op, &request.body, request.max_response)
				.await,
		)
	})
	.await
	.unwrap_or(Verdict::Skip)
}

/// Remove `instance_id`'s entry if it still holds token `token` and
/// `created_at`; with `endpoint_dead`, also its socket and bind lock when the
/// recorded endpoint is the derived one (including a relocated
/// `/tmp/omp-<euid>` path). Blocking.
pub(crate) fn prune_if_unchanged(
	dir: &Path,
	instance_id: &str,
	token: &str,
	created_at: u64,
	endpoint_dead: bool,
) -> io::Result<bool> {
	let path = entry_path(dir, instance_id);
	let entry = match std::fs::read(&path) {
		Ok(bytes) => serde_json::from_slice::<InstanceEntry>(&bytes).ok(),
		Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
		Err(error) => return Err(error),
	};
	let Some(entry) = entry.filter(|e| e.token == token && e.created_at == created_at) else {
		return Ok(false);
	};
	match std::fs::remove_file(&path) {
		Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
		_ => {},
	}
	#[cfg(unix)]
	if endpoint_dead
		&& let Some(dir) = dir_str(dir)
		&& entry.endpoint == endpoint_for(dir, instance_id, &entry.nonce)
	{
		sweep_endpoint(Path::new(&entry.endpoint));
	}
	#[cfg(not(unix))]
	let _ = (endpoint_dead, entry);
	Ok(true)
}

enum Classified {
	Valid(Box<InstanceEntry>),
	Prune,
	Keep,
}

/// Classify the bytes of `<stem>.json`, recording any `endpoint` it names.
fn classify(dir: &str, stem: &str, bytes: &[u8], referenced: &mut HashSet<String>) -> Classified {
	let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
		return Classified::Prune;
	};
	if let Some(endpoint) = value.get("endpoint").and_then(Value::as_str) {
		referenced.insert(endpoint.to_owned());
	}
	let version = value.get("v").and_then(Value::as_u64);
	let pid = value
		.get("pid")
		.and_then(Value::as_u64)
		.and_then(|p| u32::try_from(p).ok());
	let (Some(version), Some(pid)) = (version, pid) else {
		return Classified::Prune;
	};
	if version != u64::from(VERSION) {
		return if pid_alive(pid) {
			Classified::Keep
		} else {
			Classified::Prune
		};
	}
	match serde_json::from_value::<InstanceEntry>(value) {
		Ok(entry) if entry.is_valid_for(dir, stem) => Classified::Valid(Box::new(entry)),
		_ => Classified::Prune,
	}
}

/// Read the directory: sweep, prune what is malformed or provably dead from
/// its file alone, and return the v1 entries other than `exclude` to check.
/// A missing directory is empty; any other read failure is an error.
fn scan(dir: &Path, dir_text: &str, exclude: Option<&str>) -> Result<Vec<InstanceEntry>, DirError> {
	let read = match std::fs::read_dir(dir) {
		Ok(read) => read,
		Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
		Err(error) => return Err(DirError::Io(dir.to_owned(), error)),
	};
	let mut entries = Vec::new();
	let mut referenced = HashSet::new();
	// In-directory sockets (or their bind locks), with the endpoint an entry
	// would record for them.
	#[cfg(unix)]
	let mut endpoints: Vec<(PathBuf, String)> = Vec::new();
	for item in read.flatten() {
		let name = item.file_name();
		let Some(name) = name.to_str() else {
			continue;
		};
		if name.ends_with(TMP_SUFFIX) {
			sweep_tmp(&item.path());
			continue;
		}
		#[cfg(unix)]
		{
			let socket = name.strip_suffix(".bind.lock").unwrap_or(name);
			if let Some(stem) = socket.strip_suffix(".sock") {
				if is_endpoint_stem(stem) {
					endpoints.push((dir.join(socket), pi_ipc::endpoint(dir_text, stem)));
				}
				continue;
			}
		}
		let Some(stem) = name.strip_suffix(ENTRY_SUFFIX) else {
			continue;
		};
		let path = item.path();
		let Ok(bytes) = std::fs::read(&path) else {
			continue;
		};
		match classify(dir_text, stem, &bytes, &mut referenced) {
			Classified::Valid(entry) if Some(stem) != exclude => entries.push(*entry),
			Classified::Valid(_) | Classified::Keep => {},
			Classified::Prune => {
				let _ = std::fs::remove_file(&path);
			},
		}
	}
	#[cfg(unix)]
	{
		endpoints.sort();
		endpoints.dedup();
		for (socket, derived) in endpoints {
			if !referenced.contains(&derived) {
				sweep_endpoint(&socket);
			}
		}
	}
	Ok(entries)
}

/// Whether `stem` names an endpoint: `<instanceId>-<16 hex>`.
#[cfg(unix)]
fn is_endpoint_stem(stem: &str) -> bool {
	stem.split_once('-').is_some_and(|(id, nonce)| {
		is_instance_id(id)
			&& nonce.len() == 16
			&& nonce
				.bytes()
				.all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
	})
}

/// Remove a `*.tmp` left behind by a crashed write once it is old enough not
/// to belong to a write in progress.
fn sweep_tmp(path: &Path) {
	if std::fs::symlink_metadata(path).is_ok_and(|meta| is_stale(&meta)) {
		let _ = std::fs::remove_file(path);
	}
}

/// Last modified at least [`STALE_TMP_AGE`] ago.
fn is_stale(meta: &std::fs::Metadata) -> bool {
	meta
		.modified()
		.ok()
		.and_then(|modified| modified.elapsed().ok())
		.is_some_and(|age| age >= STALE_TMP_AGE)
}

/// Remove a dead Unix socket and its `.bind.lock` while holding that lock.
///
/// Only inside a private directory (a real directory owned by us without
/// group/other access: the registry, or the `/tmp/omp-<euid>` relocation
/// directory, which another user could have re-created after a reboot).
/// Under the lock no binder is between bind and listen, so a refused or
/// missing socket is dead for good. The lock must still be the file at its
/// path (a lock taken on a file unlinked meanwhile excludes nobody). A live
/// (or unknown) socket is kept. A lock file this sweep created is removed
/// again; a pre-existing one only once [`STALE_TMP_AGE`] old, since a binder
/// may have just created it and not locked it yet.
#[cfg(unix)]
pub(crate) fn sweep_endpoint(socket: &Path) {
	use std::{
		fs::{File, OpenOptions},
		os::unix::fs::{FileTypeExt, OpenOptionsExt},
	};

	if !socket.parent().is_some_and(pi_ipc::is_private_dir) {
		return;
	}
	let mut lock_path = socket.as_os_str().to_owned();
	lock_path.push(".bind.lock");
	let open = |create: bool| -> io::Result<File> {
		OpenOptions::new()
			.read(true)
			.write(true)
			.create_new(create)
			.mode(0o600)
			.custom_flags(libc::O_NOFOLLOW)
			.open(&lock_path)
	};
	let (lock, created) = match open(true) {
		Ok(lock) => (lock, true),
		Err(error) if error.kind() == io::ErrorKind::AlreadyExists => match open(false) {
			Ok(lock) => (lock, false),
			Err(_) => return,
		},
		Err(_) => return,
	};
	if lock.try_lock().is_err() || !pi_ipc::is_same_file(&lock, Path::new(&lock_path)) {
		// A binder holds it (or opened the file we just created), or it was
		// unlinked or replaced since we opened it: not ours to judge.
		return;
	}
	let dead = match std::fs::symlink_metadata(socket) {
		Err(error) => error.kind() == io::ErrorKind::NotFound,
		Ok(meta) if meta.file_type().is_socket() => {
			let refused = std::os::unix::net::UnixStream::connect(socket).is_err_and(|error| {
				matches!(error.kind(), io::ErrorKind::ConnectionRefused | io::ErrorKind::NotFound)
			});
			refused && std::fs::remove_file(socket).is_ok()
		},
		Ok(_) => false,
	};
	if created || (dead && lock.metadata().is_ok_and(|meta| is_stale(&meta))) {
		let _ = std::fs::remove_file(&lock_path);
	}
	drop(lock);
}
