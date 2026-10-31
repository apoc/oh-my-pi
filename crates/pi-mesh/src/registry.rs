//! Same-machine discovery through an owner-only directory.
//!
//! The directory (default `~/.omp/run/mesh`) holds one `<instanceId>.json`
//! entry per running instance with its local endpoint (Unix socket path inside
//! this directory, or Windows pipe name) and bearer token.
//!
//! Entry: `{v, instanceId, pid, endpoint, token, createdAt}`, written to a temp
//! file (0600) and renamed into place. On Unix the directory is created 0700,
//! must be a real directory owned by the current user, and is tightened to
//! 0700 when looser. On Windows it gets a protected DACL granting only the
//! current user (inherited by the entries); a directory whose DACL we may not
//! set is refused, as are links; the directory's owner is set to the current
//! user. The token never travels: peers derive the local transport key from
//! it. Entries whose endpoint is not the name their owner would use
//! ([`local::is_endpoint_for`]) are malformed.
//!
//! Listing prunes entries that cannot belong to a live instance:
//! - unreadable, or lacking a numeric `v` and `pid`: malformed;
//! - another format version: only when its process is gone (a newer omp owns
//!   the format);
//! - this version: malformed shape, or the endpoint is gone. A live-looking pid
//!   alone never keeps or kills an entry (pids are not comparable across PID
//!   namespaces and may be unreadable across elevation); the probe decides. A
//!   probe that times out skips the entry without pruning it. A dead entry (and
//!   its Unix socket file) is removed only if the file still holds the token
//!   and `createdAt` that were probed (its owner may have republished
//!   meanwhile); owners also re-check their own entry
//!   ([`LocalPublication::ensure_published`]).
//! - temp files (`*.tmp`) left by a crash between write and rename, once older
//!   than [`STALE_TMP_AGE`];
//! - Unix sockets without a `.json` entry that refuse connections.
//!
//! On Windows the probe also requires the pipe's server process to be the
//! entry's `pid`: pipe names are visible to every account, so another one
//! could re-create a crashed instance's pipe to keep it listed.

use std::{
	io,
	path::{Path, PathBuf},
	sync::Arc,
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::task::JoinSet;

use crate::{
	keys::{hex, random_bytes},
	protocol::is_instance_id,
	transport::{
		Endpoint, InboundSink,
		local::{self, LocalListener},
	},
};

/// Entry format version (2: Unix socket / named pipe endpoints; 1 was
/// loopback TCP).
pub const REGISTRY_VERSION: u32 = 2;
/// Liveness probe deadline per entry (probes run concurrently).
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
/// Age after which an orphaned `*.tmp` write is swept.
pub const STALE_TMP_AGE: Duration = Duration::from_mins(1);
const ENTRY_SUFFIX: &str = ".json";
const TMP_SUFFIX: &str = ".tmp";

#[derive(Debug, thiserror::Error)]
pub enum RegistryError {
	#[error("invalid mesh instance id")]
	InvalidInstanceId,
	#[error("insecure mesh registry directory {0}: {1}")]
	InsecureDir(PathBuf, &'static str),
	#[error(transparent)]
	Io(#[from] io::Error),
}

/// `<home>/<PI_CONFIG_DIR or .omp>/run/mesh`.
///
/// Mirrors the frontend's `path.join(os.homedir(), getConfigDirName())`: the
/// config dir is always appended under home, even when absolute. `None` without
/// a home directory.
pub fn default_registry_dir() -> Option<PathBuf> {
	let home = std::env::home_dir()?;
	let config = std::env::var_os("PI_CONFIG_DIR").filter(|v| !v.is_empty());
	Some(
		join_under(home, Path::new(config.as_deref().unwrap_or_else(|| ".omp".as_ref())))
			.join("run")
			.join("mesh"),
	)
}

/// Node `path.join(base, rel)`: `rel`'s root/prefix is dropped and `..`
/// pops, so the result never escapes above `base` via an absolute `rel`.
/// (Unlike Node on Windows, a drive prefix in `rel` is dropped, not kept as a
/// literal `D:` segment.)
fn join_under(mut base: PathBuf, rel: &Path) -> PathBuf {
	use std::path::Component;
	for component in rel.components() {
		match component {
			Component::Normal(part) => base.push(part),
			Component::ParentDir => {
				base.pop();
			},
			Component::CurDir | Component::RootDir | Component::Prefix(_) => {},
		}
	}
	base
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntryFile {
	v:           u32,
	instance_id: String,
	pid:         u32,
	/// Unix socket path or Windows pipe name.
	endpoint:    String,
	token:       String,
	created_at:  u64,
}

/// Another live instance on this machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalEntry {
	pub instance_id: String,
	pub pid:         u32,
	/// Always [`Endpoint::Local`].
	pub endpoint:    Endpoint,
	/// ms since the Unix epoch.
	pub created_at:  u64,
}

/// This instance's registry entry and loopback listener. Dropping it removes
/// the entry and stops the listener. Shareable (`&self` methods).
#[derive(Debug)]
pub struct LocalPublication {
	/// `None` once closed.
	listener: Mutex<Option<LocalListener>>,
	endpoint: Endpoint,
	dir:      PathBuf,
	path:     PathBuf,
	/// The entry as published, for [`Self::ensure_published`].
	entry:    Vec<u8>,
}

impl LocalPublication {
	pub fn endpoint(&self) -> Endpoint {
		self.endpoint.clone()
	}

	/// Rewrite this instance's entry if it is missing or differs (e.g. a lister
	/// pruned it on a stale probe). Blocking file I/O; call it from the
	/// periodic local poll via `spawn_blocking`. `Ok(true)` when rewritten;
	/// no-op after [`Self::close`].
	///
	/// # Errors
	/// Insecure directory or I/O failure.
	pub fn ensure_published(&self) -> Result<bool, RegistryError> {
		let listener = self.listener.lock();
		if listener.is_none() || std::fs::read(&self.path).is_ok_and(|bytes| bytes == self.entry) {
			return Ok(false);
		}
		ensure_private_dir(&self.dir)?;
		write_private_atomic(&self.path, &self.entry)?;
		Ok(true)
	}

	/// Withdraw: remove the entry, then stop the listener. Idempotent.
	pub async fn close(&self) {
		let listener = {
			let mut guard = self.listener.lock();
			let _ = std::fs::remove_file(&self.path);
			guard.take()
		};
		if let Some(listener) = listener {
			listener.close().await;
		}
	}
}

impl Drop for LocalPublication {
	fn drop(&mut self) {
		if self.listener.get_mut().is_some() {
			let _ = std::fs::remove_file(&self.path);
		}
	}
}

fn now_ms() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

fn entry_path(dir: &Path, instance_id: &str) -> PathBuf {
	dir.join(format!("{instance_id}{ENTRY_SUFFIX}"))
}

/// Start the loopback listener for `instance_id` and publish its entry in
/// `dir` (created owner-only when missing).
///
/// # Errors
/// Invalid instance id, insecure directory, or I/O failure (the listener is
/// stopped again).
pub async fn publish_local(
	dir: &Path,
	instance_id: &str,
	sink: Arc<dyn InboundSink>,
) -> Result<LocalPublication, RegistryError> {
	if !is_instance_id(instance_id) {
		return Err(RegistryError::InvalidInstanceId);
	}
	let dir = dir.to_owned();
	let path = entry_path(&dir, instance_id);
	// The directory must be private before the socket appears in it.
	let prepared = tokio::task::spawn_blocking({
		let dir = dir.clone();
		move || ensure_private_dir(&dir)
	})
	.await
	.unwrap_or_else(|join| Err(io::Error::other(join).into()));
	prepared?;
	let listener = LocalListener::start(&dir, instance_id.to_owned(), sink)?;
	let entry = EntryFile {
		v:           REGISTRY_VERSION,
		instance_id: instance_id.to_owned(),
		pid:         std::process::id(),
		endpoint:    listener.path().to_owned(),
		token:       listener.token().to_owned(),
		created_at:  now_ms(),
	};
	let bytes = serde_json::to_vec(&entry).map_err(io::Error::other)?;
	let written = tokio::task::spawn_blocking({
		let (path, bytes) = (path.clone(), bytes.clone());
		move || write_private_atomic(&path, &bytes)
	})
	.await
	.unwrap_or_else(|join| Err(io::Error::other(join).into()));
	if let Err(err) = written {
		listener.close().await;
		return Err(err);
	}
	Ok(LocalPublication {
		endpoint: listener.endpoint(),
		listener: Mutex::new(Some(listener)),
		dir,
		path,
		entry: bytes,
	})
}

/// Remove `instance_id`'s entry if it is still the given publication.
///
/// Matches on `token` and `created_at` (e.g. after its endpoint proved to serve
/// another instance); a republished entry is left alone. Blocking. `Ok(true)`
/// when removed.
///
/// # Errors
/// I/O failures other than not-found.
pub fn remove_entry_if(
	dir: &Path,
	instance_id: &str,
	token: &str,
	created_at: u64,
) -> io::Result<bool> {
	if !is_instance_id(instance_id) {
		return Ok(false);
	}
	prune_if_unchanged(&entry_path(dir, instance_id), token, created_at)
}

/// Live local instances other than `exclude`, oldest first; prunes dead and
/// malformed entries (see the module docs). A missing directory lists empty.
pub async fn list_local(dir: &Path, exclude: Option<&str>) -> Vec<LocalEntry> {
	let dir = dir.to_owned();
	let exclude = exclude.map(str::to_owned);
	let scanned = tokio::task::spawn_blocking({
		let dir = dir.clone();
		move || scan(&dir, exclude.as_deref())
	})
	.await
	.unwrap_or_default();
	let mut probes = JoinSet::new();
	for (path, entry) in scanned {
		probes.spawn(async move {
			match tokio::time::timeout(PROBE_TIMEOUT, local::probe(&entry.endpoint, entry.pid)).await {
				Ok(Ok(true)) => Some(entry),
				Ok(Ok(false)) => {
					let (token, created_at) = (entry.token, entry.created_at);
					let _ = tokio::task::spawn_blocking(move || {
						prune_if_unchanged(&path, &token, created_at)
					})
					.await;
					None
				},
				Ok(Err(_)) | Err(_) => None,
			}
		});
	}
	let mut live = Vec::new();
	while let Some(result) = probes.join_next().await {
		if let Ok(Some(entry)) = result {
			live.push(LocalEntry {
				endpoint:    Endpoint::Local {
					path:  entry.endpoint,
					token: entry.token,
					pid:   entry.pid,
				},
				instance_id: entry.instance_id,
				pid:         entry.pid,
				created_at:  entry.created_at,
			});
		}
	}
	live.sort_by(|a, b| {
		a.created_at
			.cmp(&b.created_at)
			.then_with(|| a.instance_id.cmp(&b.instance_id))
	});
	live
}

/// Remove the entry at `path` (and its leftover Unix socket) only if it still
/// holds the probed publication (same token and `createdAt`); a republished
/// entry is left alone.
fn prune_if_unchanged(path: &Path, token: &str, created_at: u64) -> io::Result<bool> {
	let entry = match std::fs::read(path) {
		Ok(bytes) => serde_json::from_slice::<EntryFile>(&bytes).ok(),
		Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(false),
		Err(err) => return Err(err),
	};
	let Some(entry) = entry.filter(|e| e.token == token && e.created_at == created_at) else {
		return Ok(false);
	};
	match std::fs::remove_file(path) {
		Err(err) if err.kind() != io::ErrorKind::NotFound => return Err(err),
		_ => {},
	}
	if let Some(dir) = path.parent()
		&& local::is_endpoint_for(dir, &entry.instance_id, &entry.endpoint)
	{
		local::unlink_endpoint(&entry.endpoint);
	}
	Ok(true)
}

/// Remove a `*.tmp` left behind by a crashed write once it is old enough not
/// to belong to a write in progress.
fn sweep_tmp(path: &Path) {
	let stale = std::fs::symlink_metadata(path)
		.and_then(|meta| meta.modified())
		.ok()
		.and_then(|modified| modified.elapsed().ok())
		.is_some_and(|age| age >= STALE_TMP_AGE);
	if stale {
		let _ = std::fs::remove_file(path);
	}
}

/// Read entries, pruning what is malformed or provably dead; return the
/// current-version entries still to probe.
fn scan(dir: &Path, exclude: Option<&str>) -> Vec<(PathBuf, EntryFile)> {
	let Ok(read) = std::fs::read_dir(dir) else {
		return Vec::new();
	};
	let mut out = Vec::new();
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
		if Path::new(name).extension().is_some_and(|ext| ext == "sock") {
			local::sweep_orphan_socket(dir, name);
			continue;
		}
		let Some(stem) = name.strip_suffix(ENTRY_SUFFIX) else {
			continue;
		};
		if Some(stem) == exclude {
			continue;
		}
		let path = item.path();
		match classify(dir, stem, std::fs::read(&path).ok().as_deref()) {
			Classified::Probe(entry) => out.push((path, *entry)),
			Classified::Prune => {
				let _ = std::fs::remove_file(&path);
			},
			Classified::Skip => {},
		}
	}
	out
}

enum Classified {
	Probe(Box<EntryFile>),
	Prune,
	Skip,
}

fn classify(dir: &Path, stem: &str, bytes: Option<&[u8]>) -> Classified {
	let Some(value) = bytes.and_then(|b| serde_json::from_slice::<Value>(b).ok()) else {
		return Classified::Prune;
	};
	let version = value.get("v").and_then(Value::as_u64);
	let pid = value
		.get("pid")
		.and_then(Value::as_u64)
		.and_then(|p| u32::try_from(p).ok());
	let (Some(version), Some(pid)) = (version, pid) else {
		return Classified::Prune;
	};
	if version != u64::from(REGISTRY_VERSION) {
		return if pid_alive(pid) {
			Classified::Skip
		} else {
			Classified::Prune
		};
	}
	match serde_json::from_value::<EntryFile>(value) {
		Ok(entry)
			if entry.instance_id == stem
				&& is_instance_id(&entry.instance_id)
				&& local::is_endpoint_for(dir, &entry.instance_id, &entry.endpoint) =>
		{
			Classified::Probe(Box::new(entry))
		},
		_ => Classified::Prune,
	}
}

#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
	let Ok(pid) = libc::pid_t::try_from(pid) else {
		return false;
	};
	if pid <= 0 {
		return false;
	}
	// SAFETY: signal 0 only checks for existence/permission; no side effects.
	let rc = unsafe { libc::kill(pid, 0) };
	rc == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
fn pid_alive(pid: u32) -> bool {
	use windows_sys::Win32::{
		Foundation::{CloseHandle, ERROR_ACCESS_DENIED, GetLastError, STILL_ACTIVE},
		System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
	};
	// SAFETY: plain Win32 calls on a handle we own and close.
	unsafe {
		let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
		if handle.is_null() {
			// Elevated or protected processes refuse the query but exist.
			return GetLastError() == ERROR_ACCESS_DENIED;
		}
		let mut code = 0u32;
		let ok = GetExitCodeProcess(handle, &raw mut code) != 0;
		CloseHandle(handle);
		!ok || code == STILL_ACTIVE as u32
	}
}

fn ensure_private_dir(dir: &Path) -> Result<(), RegistryError> {
	#[cfg(unix)]
	{
		use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
		std::fs::DirBuilder::new()
			.recursive(true)
			.mode(0o700)
			.create(dir)?;
		let meta = std::fs::symlink_metadata(dir)?;
		if !meta.file_type().is_dir() {
			return Err(RegistryError::InsecureDir(dir.to_owned(), "not a directory"));
		}
		// SAFETY: geteuid has no preconditions.
		if meta.uid() != unsafe { libc::geteuid() } {
			return Err(RegistryError::InsecureDir(dir.to_owned(), "owned by another user"));
		}
		if meta.mode() & 0o077 != 0 {
			std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
		}
	}
	#[cfg(windows)]
	{
		std::fs::create_dir_all(dir)?;
		let meta = std::fs::symlink_metadata(dir)?;
		if !meta.file_type().is_dir() {
			return Err(RegistryError::InsecureDir(dir.to_owned(), "not a directory"));
		}
		crate::winsec::restrict_dir_to_current_user(dir).map_err(|_| {
			RegistryError::InsecureDir(dir.to_owned(), "cannot restrict access to the current user")
		})?;
	}
	Ok(())
}

fn write_private_atomic(path: &Path, bytes: &[u8]) -> Result<(), RegistryError> {
	use std::io::Write as _;
	let mut suffix = [0u8; 6];
	random_bytes(&mut suffix);
	let tmp = path.with_extension(format!("{}.tmp", hex(&suffix)));
	let mut options = std::fs::OpenOptions::new();
	options.write(true).create_new(true);
	#[cfg(unix)]
	{
		use std::os::unix::fs::OpenOptionsExt;
		options.mode(0o600);
	}
	let result = (|| {
		let mut file = options.open(&tmp)?;
		file.write_all(bytes)?;
		file.sync_all()?;
		drop(file);
		std::fs::rename(&tmp, path)
	})();
	if result.is_err() {
		let _ = std::fs::remove_file(&tmp);
	}
	Ok(result?)
}

#[cfg(test)]
mod tests {
	use std::time::Duration;

	use serde_json::json;

	use super::*;
	use crate::{
		protocol::{MeshEnvelope, MeshRequest, MeshResponse, MeshSender},
		transport::{BoxFuture, MeshClient, Origin},
	};

	const ME: &str = "aaaaaaaaaaaaaaaa";
	const PEER: &str = "bbbbbbbbbbbbbbbb";
	const OTHER: &str = "cccccccccccccccc";

	struct Echo;

	impl InboundSink for Echo {
		fn handle(&self, envelope: MeshEnvelope, _origin: Origin) -> BoxFuture<MeshResponse> {
			Box::pin(async move { MeshResponse::Ok(json!(envelope.to)) })
		}
	}

	fn write_entry(dir: &Path, name: &str, value: &Value) -> PathBuf {
		let path = dir.join(format!("{name}{ENTRY_SUFFIX}"));
		std::fs::write(&path, serde_json::to_vec(value).unwrap()).unwrap();
		path
	}

	/// The endpoint name `id` would use in `dir`, with nothing listening.
	async fn dead_endpoint(dir: &Path, id: &str) -> String {
		let listener = LocalListener::start(dir, id.into(), Arc::new(Echo)).unwrap();
		let path = listener.path().to_owned();
		listener.close().await;
		path
	}

	fn entry(id: &str, pid: u32, endpoint: &str) -> Value {
		json!({
			"v": REGISTRY_VERSION, "instanceId": id, "pid": pid, "endpoint": endpoint,
			"token": "00".repeat(32), "createdAt": 1,
		})
	}

	#[tokio::test]
	async fn publish_list_request_and_close() {
		let tmp = tempfile::tempdir().unwrap();
		let dir = tmp.path().join("run").join("mesh");
		let publication = publish_local(&dir, PEER, Arc::new(Echo)).await.unwrap();
		assert!(list_local(&dir, Some(PEER)).await.is_empty());
		let listed = list_local(&dir, Some(ME)).await;
		assert_eq!(listed.len(), 1);
		assert_eq!(listed[0].instance_id, PEER);
		assert_eq!(listed[0].pid, std::process::id());
		assert_eq!(listed[0].endpoint, publication.endpoint());

		let envelope = MeshEnvelope {
			v:       1,
			msg_id:  "m1".into(),
			sent_at: now_ms(),
			hop:     0,
			from:    MeshSender {
				instance_id:  ME.into(),
				agent_id:     "Main".into(),
				display_name: "me".into(),
				host:         "box".into(),
				lan_port:     None,
			},
			to:      PEER.into(),
			body:    MeshRequest::Snapshot,
		};
		let got = MeshClient::new(None)
			.request(&listed[0].endpoint, &envelope, Duration::from_secs(5))
			.await
			.unwrap();
		assert_eq!(got, MeshResponse::Ok(json!(PEER)));

		publication.close().await;
		assert!(!entry_path(&dir, PEER).exists());
		assert!(list_local(&dir, Some(ME)).await.is_empty());
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn directory_and_entry_are_owner_only() {
		use std::os::unix::fs::PermissionsExt;
		let tmp = tempfile::tempdir().unwrap();
		let dir = tmp.path().join("mesh");
		std::fs::create_dir(&dir).unwrap();
		std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
		let publication = publish_local(&dir, PEER, Arc::new(Echo)).await.unwrap();
		let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
		assert_eq!(mode(&dir), 0o700);
		assert_eq!(mode(&entry_path(&dir, PEER)), 0o600);
		publication.close().await;
	}

	#[tokio::test]
	async fn prunes_dead_and_malformed_but_keeps_live_future_versions() {
		let tmp = tempfile::tempdir().unwrap();
		let dir = tmp.path();
		let me = std::process::id();
		// Current version, live pid, dead endpoint (pid reuse or another PID
		// namespace): the probe decides -> pruned.
		let dead = write_entry(dir, PEER, &entry(PEER, me, &dead_endpoint(dir, PEER).await));
		let garbage = dir.join(format!("{OTHER}{ENTRY_SUFFIX}"));
		std::fs::write(&garbage, b"{not json").unwrap();
		// Shape of the current version is wrong -> pruned: file name and id
		// disagree; endpoint not the owner's own name.
		let other_endpoint = dead_endpoint(dir, OTHER).await;
		let misnamed = write_entry(dir, "dddddddddddddddd", &entry(OTHER, me, &other_endpoint));
		let foreign =
			write_entry(dir, "9999999999999999", &entry("9999999999999999", me, &other_endpoint));
		// Another format (older or newer) with a live owner: kept and not
		// listed, whatever its shape.
		let future_live =
			write_entry(dir, "eeeeeeeeeeeeeeee", &json!({ "v": 3, "pid": me, "renamed": true }));
		let legacy_live =
			write_entry(dir, "1111111111111111", &json!({ "v": 1, "pid": me, "addr": "127.0.0.1:1" }));
		let future_dead =
			write_entry(dir, "ffffffffffffffff", &json!({ "v": 3, "pid": 0x7fff_fff0_u32 }));
		std::fs::write(dir.join("notes.txt"), b"ignored").unwrap();

		assert!(list_local(dir, None).await.is_empty());
		assert!(!dead.exists());
		assert!(!garbage.exists());
		assert!(!misnamed.exists());
		assert!(!foreign.exists());
		assert!(future_live.exists());
		assert!(legacy_live.exists());
		assert!(!future_dead.exists());
		assert!(dir.join("notes.txt").exists());
	}

	#[tokio::test]
	async fn owner_self_heals_and_pruning_spares_republished_entries() {
		let tmp = tempfile::tempdir().unwrap();
		let dir = tmp.path();
		let publication = publish_local(dir, PEER, Arc::new(Echo)).await.unwrap();
		let path = entry_path(dir, PEER);
		assert!(!publication.ensure_published().unwrap());
		std::fs::remove_file(&path).unwrap();
		assert!(publication.ensure_published().unwrap());
		assert_eq!(list_local(dir, Some(ME)).await.len(), 1);

		// A lister probed an older publication (other token/createdAt) that is
		// gone; the file now holds the live one and must survive.
		assert!(!remove_entry_if(dir, PEER, &"00".repeat(32), 1).unwrap());
		assert!(path.exists());
		let current: EntryFile = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
		assert!(remove_entry_if(dir, PEER, &current.token, current.created_at).unwrap());
		assert!(!path.exists());

		publication.close().await;
		assert!(!publication.ensure_published().unwrap(), "no rewrite after close");
		assert!(!path.exists());
	}

	#[tokio::test]
	async fn sweeps_only_stale_tmp_files() {
		let tmp = tempfile::tempdir().unwrap();
		let dir = tmp.path();
		let old = dir.join("aaaaaaaaaaaaaaaa.0123456789ab.tmp");
		let fresh = dir.join("bbbbbbbbbbbbbbbb.0123456789ab.tmp");
		std::fs::write(&old, b"{").unwrap();
		std::fs::write(&fresh, b"{").unwrap();
		let past = SystemTime::now() - STALE_TMP_AGE - Duration::from_secs(5);
		std::fs::File::options()
			.write(true)
			.open(&old)
			.unwrap()
			.set_modified(past)
			.unwrap();
		assert!(list_local(dir, None).await.is_empty());
		assert!(!old.exists());
		assert!(fresh.exists());
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn sweeps_only_dead_orphan_sockets() {
		let tmp = tempfile::tempdir().unwrap();
		let dir = tmp.path();
		let dead = dir.join("aaaaaaaaaaaaaaaa.sock");
		drop(std::os::unix::net::UnixListener::bind(&dead).unwrap());
		let live_path = dir.join("bbbbbbbbbbbbbbbb.sock");
		let _live = std::os::unix::net::UnixListener::bind(&live_path).unwrap();
		assert!(list_local(dir, None).await.is_empty());
		assert!(!dead.exists(), "orphan socket refusing connections is swept");
		assert!(live_path.exists(), "a listening socket (entry not yet written) is kept");
	}

	#[test]
	fn config_dir_is_always_joined_under_home() {
		let home = PathBuf::from("home").join("me");
		assert_eq!(join_under(home.clone(), Path::new(".omp")), home.join(".omp"));
		let absolute = if cfg!(windows) {
			r"D:\elsewhere\cfg"
		} else {
			"/elsewhere/cfg"
		};
		assert_eq!(join_under(home.clone(), Path::new(absolute)), home.join("elsewhere").join("cfg"));
		assert_eq!(join_under(home, Path::new("../x")), PathBuf::from("home").join("x"));
	}

	#[tokio::test]
	async fn rejects_invalid_instance_id() {
		let tmp = tempfile::tempdir().unwrap();
		let err = publish_local(tmp.path(), "../escape", Arc::new(Echo))
			.await
			.unwrap_err();
		assert!(matches!(err, RegistryError::InvalidInstanceId), "{err}");
	}
}
