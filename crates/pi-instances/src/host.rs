//! [`InstanceHost`]: one listener and one registry entry per host, serving
//! every registered namespace.

use std::{
	borrow::Cow,
	collections::BTreeMap,
	fmt,
	future::Future,
	io,
	path::{Path, PathBuf},
	sync::{
		Arc, Weak,
		atomic::{AtomicU64, Ordering},
	},
	time::Duration,
};

use parking_lot::{Mutex, RwLock};
use serde::Deserialize;
use serde_json::value::RawValue;
use tokio::{
	io::AsyncWriteExt,
	sync::Semaphore,
	task::{JoinHandle, JoinSet},
};

use crate::{
	BoxFuture, MAX_CONNECTIONS, MAX_REQUEST_LINE_BYTES, REQUEST_READ_TIMEOUT,
	RESPONSE_WRITE_TIMEOUT,
	dir::{DirError, ensure_private_dir},
	entry::{
		InstanceEntry, NONCE_BYTES, TOKEN_BYTES, dir_str, endpoint_for, entry_path, is_instance_id,
		is_namespace, now_ms, random_hex, token_matches, write_private_atomic,
	},
	wire::{LineError, error_line, ok_line, read_line, refuse, write_line},
};

/// Concurrent `busy` answers per host; refused connections past this are
/// dropped without an answer.
const MAX_BUSY_REPLIES: usize = 16;
/// How long a `busy` / `too_large` answer may take, including draining the
/// peer's request.
const REFUSE_LINGER: Duration = Duration::from_secs(1);
/// Request bytes drained after a `busy` / `too_large` answer.
const MAX_DRAIN_BYTES: usize = 2 * MAX_REQUEST_LINE_BYTES;

/// A namespace handler's answer.
#[derive(Debug)]
pub enum HandlerReply {
	/// `{"v":1,"ok":true,"body":<body>}`.
	Ok(Box<RawValue>),
	/// `{"v":1,"ok":false,"error":<code>}`.
	Error(Cow<'static, str>),
}

/// Context of one authenticated request.
#[derive(Debug, Clone)]
pub struct RequestCtx {
	/// The serving host's instance id (the request's `to`).
	pub instance_id: Arc<str>,
}

/// Codes the instance layer itself answers with. A handler returning one is
/// answered `internal` instead: clients and listers act on these (`busy`
/// counts as alive, `misdirected` prunes the entry, …).
pub const RESERVED_CODES: [&str; 7] = [
	"authentication_failed",
	"busy",
	"malformed_request",
	"misdirected",
	"too_large",
	"unavailable",
	"unsupported_protocol",
];

/// Serves one namespace (`<ns>.<op>` requests) of an [`InstanceHost`].
///
/// Called only for requests that passed the version, token, recipient and
/// body-size checks. Handler deadlines are the namespace's job: a slow
/// handler should answer in-band (see [`with_deadline`]); the host itself
/// never times a handler out. Error codes in [`RESERVED_CODES`] are
/// reserved for the instance layer and reach the client as `internal`.
pub trait Handler: Send + Sync + 'static {
	/// Answer `op` (the part after `<ns>.`; empty when the request named only
	/// the namespace) with `body` (`null` when absent).
	fn handle(&self, op: &str, body: &RawValue, ctx: RequestCtx) -> BoxFuture<HandlerReply>;

	/// Largest raw `body` this namespace accepts; larger ones are answered
	/// `too_large` without calling [`Self::handle`].
	fn max_body_bytes(&self) -> usize;
}

/// `reply`, or `on_timeout` once `deadline` passes.
pub async fn with_deadline(
	deadline: Duration,
	reply: impl Future<Output = HandlerReply>,
	on_timeout: HandlerReply,
) -> HandlerReply {
	tokio::time::timeout(deadline, reply)
		.await
		.unwrap_or(on_timeout)
}

#[derive(Debug, thiserror::Error)]
pub enum HostError {
	#[error("invalid instance id")]
	InvalidInstanceId,
	#[error("instance registry directory is not valid UTF-8: {0}")]
	NonUtf8Dir(PathBuf),
	#[error("invalid namespace {0:?}")]
	InvalidNamespace(String),
	#[error("namespace {0} is already registered")]
	AlreadyRegistered(String),
	#[error("instance host is closed")]
	Closed,
	#[error(transparent)]
	Dir(#[from] DirError),
	#[error("bind instance endpoint: {0}")]
	Bind(#[source] pi_ipc::IpcError),
	#[error("write instance entry {0}: {1}")]
	Write(PathBuf, #[source] io::Error),
}

/// A same-machine instance: one listener and one registry entry, shared by
/// every registered namespace.
///
/// The listener is bound on the first [`Self::register`] and kept, with its
/// token, nonce and `createdAt`, until [`Self::close`] or
/// [`Self::withdraw_sync`] (or drop). The entry exists for that whole span;
/// registering or dropping a [`Registration`] only rewrites its
/// `capabilities`. A closed host is terminal.
///
/// Entry writes never run on the caller's async thread and never hold the
/// lock [`Self::entry`] takes.
pub struct InstanceHost {
	inner: Arc<Inner>,
}

struct Inner {
	dir:         PathBuf,
	dir_str:     String,
	instance_id: Arc<str>,
	/// Serializes binding, capability additions and [`InstanceHost::close`].
	gate:        tokio::sync::Mutex<()>,
	/// Serializes entry-file writes and the withdrawal's removal; always
	/// taken before `state`. Each write takes the latest bytes from `state`,
	/// so the file converges on the newest capabilities.
	writer:      Mutex<()>,
	/// Never held across disk I/O.
	state:       Mutex<State>,
	next_id:     AtomicU64,
}

enum State {
	Idle,
	Live(Box<Live>),
	Closed,
}

/// A bound listener. Dropping it stops serving and removes the endpoint's
/// files (not the entry).
struct Live {
	shared: Arc<Shared>,
	/// The entry as it should be on disk.
	entry:  InstanceEntry,
	bytes:  Vec<u8>,
	path:   PathBuf,
	task:   JoinHandle<()>,
	bound:  Option<pi_ipc::Bound>,
}

/// What connection tasks need.
struct Shared {
	instance_id: Arc<str>,
	token:       String,
	handlers:    RwLock<BTreeMap<String, Slot>>,
}

struct Slot {
	id:      u64,
	handler: Arc<dyn Handler>,
}

impl InstanceHost {
	/// A host publishing into `dir` as `instance_id` (random when `None`).
	/// Nothing is bound or written until the first [`Self::register`].
	pub fn new(dir: impl Into<PathBuf>, instance_id: Option<String>) -> Result<Self, HostError> {
		let dir = dir.into();
		let Some(text) = dir_str(&dir) else {
			return Err(HostError::NonUtf8Dir(dir));
		};
		let dir_str = text.to_owned();
		let instance_id = match instance_id {
			Some(id) if is_instance_id(&id) => id,
			Some(_) => return Err(HostError::InvalidInstanceId),
			None => random_hex(crate::entry::INSTANCE_ID_LEN / 2),
		};
		Ok(Self {
			inner: Arc::new(Inner {
				dir,
				dir_str,
				instance_id: instance_id.into(),
				gate: tokio::sync::Mutex::new(()),
				writer: Mutex::new(()),
				state: Mutex::new(State::Idle),
				next_id: AtomicU64::new(0),
			}),
		})
	}

	pub fn instance_id(&self) -> &str {
		&self.inner.instance_id
	}

	pub fn dir(&self) -> &Path {
		&self.inner.dir
	}

	/// The published entry; `None` before the first registration and after
	/// close.
	pub fn entry(&self) -> Option<InstanceEntry> {
		match &*self.inner.state.lock() {
			State::Live(live) => Some(live.entry.clone()),
			_ => None,
		}
	}

	/// Serve `namespace` with `handler` until the returned [`Registration`]
	/// is dropped or unregistered. The first registration creates the
	/// directory (owner-only), binds the listener and writes the entry; later
	/// ones rewrite the entry's `capabilities`. Requires a Tokio runtime.
	///
	/// Cancellation-safe: the work runs on its own task. If the caller stops
	/// waiting, a registration that still completes is dropped (so its
	/// namespace is removed again) and the host stays withdrawable.
	pub async fn register(
		&self,
		namespace: &str,
		handler: Arc<dyn Handler>,
	) -> Result<Registration, HostError> {
		if !is_namespace(namespace) {
			return Err(HostError::InvalidNamespace(namespace.to_owned()));
		}
		let inner = Arc::clone(&self.inner);
		let namespace = namespace.to_owned();
		let (deliver, delivered) = tokio::sync::oneshot::channel();
		tokio::spawn(async move {
			let _gate = inner.gate.lock().await;
			let result = Arc::clone(&inner).register(namespace, handler).await;
			// Undeliverable (the caller stopped waiting): drop it while still
			// holding the gate, so the namespace is free for the next caller.
			if let Err(unsent) = deliver.send(result) {
				drop(unsent);
			}
		});
		delivered.await.unwrap_or_else(|_| {
			Err(HostError::Write(self.inner.dir.clone(), io::Error::other("register task failed")))
		})
	}

	/// Rewrite the entry if it is missing or differs (e.g. a lister pruned it
	/// after a stale probe). Blocking file I/O. `Ok(true)` when rewritten;
	/// no-op before the first registration and after close.
	pub fn ensure_published(&self) -> Result<bool, HostError> {
		let _writer = self.inner.writer.lock();
		let Some((path, bytes)) = self.inner.published() else {
			return Ok(false);
		};
		if std::fs::read(&path).is_ok_and(|current| current == bytes) {
			return Ok(false);
		}
		ensure_private_dir(&self.inner.dir)?;
		write_private_atomic(&path, &bytes).map_err(|error| HostError::Write(path, error))?;
		Ok(true)
	}

	/// Withdraw: remove the entry, stop the listener (in-flight requests are
	/// dropped unanswered) and remove the endpoint's files. Registrations
	/// become inert; later [`Self::register`] calls fail with
	/// [`HostError::Closed`]. Idempotent, and runs to completion even if the
	/// caller stops waiting.
	pub async fn close(&self) {
		let inner = Arc::clone(&self.inner);
		let _ = tokio::spawn(async move { inner.close().await }).await;
	}

	/// [`Self::close`] for synchronous exit paths: removes the entry, the
	/// socket and its bind lock without awaiting the listener task. On
	/// Windows the pipe instances close only once the runtime drops the
	/// aborted task, so a request already being handled may still complete;
	/// new clients find no entry.
	pub fn withdraw_sync(&self) {
		drop(self.inner.withdraw_entry());
	}
}

impl fmt::Debug for InstanceHost {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_struct("InstanceHost")
			.field("instance_id", &self.inner.instance_id)
			.field("dir", &self.inner.dir)
			.finish_non_exhaustive()
	}
}

impl Inner {
	/// Path and desired bytes of the live entry.
	fn published(&self) -> Option<(PathBuf, Vec<u8>)> {
		match &*self.state.lock() {
			State::Live(live) => Some((live.path.clone(), live.bytes.clone())),
			_ => None,
		}
	}

	/// Write the latest entry bytes. Blocking.
	fn flush(&self) -> io::Result<()> {
		let _writer = self.writer.lock();
		match self.published() {
			Some((path, bytes)) => write_private_atomic(&path, &bytes),
			None => Ok(()),
		}
	}

	/// Mark closed and remove the entry file (under the writer lock, so no
	/// pending capability write can resurrect it); the live listener, if any.
	/// Blocking.
	fn withdraw_entry(&self) -> Option<Box<Live>> {
		let _writer = self.writer.lock();
		let previous = std::mem::replace(&mut *self.state.lock(), State::Closed);
		let State::Live(live) = previous else {
			return None;
		};
		let _ = std::fs::remove_file(&live.path);
		Some(live)
	}

	/// Register under the gate (held by the caller).
	async fn register(
		self: Arc<Self>,
		namespace: String,
		handler: Arc<dyn Handler>,
	) -> Result<Registration, HostError> {
		let id = self.next_id.fetch_add(1, Ordering::Relaxed);
		let idle = match &*self.state.lock() {
			State::Closed => return Err(HostError::Closed),
			State::Idle => true,
			State::Live(_) => false,
		};
		if idle {
			let live = self.bind(&namespace, id, handler).await?;
			let mut state = self.state.lock();
			if matches!(*state, State::Closed) {
				// `withdraw_sync` ran while binding.
				drop(state);
				let _ = std::fs::remove_file(&live.path);
				return Err(HostError::Closed);
			}
			*state = State::Live(Box::new(live));
		} else {
			let inner = Arc::clone(&self);
			let ns = namespace.clone();
			tokio::task::spawn_blocking(move || inner.add(ns, id, handler))
				.await
				.map_err(|join| HostError::Write(self.dir.clone(), io::Error::other(join)))??;
		}
		Ok(Registration { host: Some(Arc::downgrade(&self)), namespace, id })
	}

	async fn bind(
		&self,
		namespace: &str,
		id: u64,
		handler: Arc<dyn Handler>,
	) -> Result<Live, HostError> {
		let dir = self.dir.clone();
		// The directory must be private before the socket appears in it.
		tokio::task::spawn_blocking(move || ensure_private_dir(&dir))
			.await
			.map_err(|join| HostError::Write(self.dir.clone(), io::Error::other(join)))??;
		let nonce = random_hex(NONCE_BYTES);
		let endpoint = endpoint_for(&self.dir_str, &self.instance_id, &nonce);
		let (listener, bound) = pi_ipc::listen(&endpoint).await.map_err(HostError::Bind)?;
		let shared = Arc::new(Shared {
			instance_id: Arc::clone(&self.instance_id),
			token:       random_hex(TOKEN_BYTES),
			handlers:    RwLock::new(BTreeMap::from([(namespace.to_owned(), Slot { id, handler })])),
		});
		let task = tokio::spawn(accept_loop(listener, Arc::clone(&shared)));
		let entry = InstanceEntry {
			instance_id: self.instance_id.to_string(),
			pid: std::process::id(),
			nonce,
			endpoint,
			token: shared.token.clone(),
			created_at: now_ms(),
			capabilities: vec![namespace.to_owned()],
		};
		let live = Live {
			bytes: entry.to_file_bytes(),
			path: entry_path(&self.dir, &self.instance_id),
			entry,
			shared,
			task,
			bound: Some(bound),
		};
		let written = tokio::task::spawn_blocking({
			let (path, bytes) = (live.path.clone(), live.bytes.clone());
			move || write_private_atomic(&path, &bytes)
		})
		.await
		.unwrap_or_else(|join| Err(io::Error::other(join)));
		match written {
			Ok(()) => Ok(live),
			// Dropping `live` stops the listener and removes the endpoint files.
			Err(error) => Err(HostError::Write(live.path.clone(), error)),
		}
	}

	/// Add `namespace` to a live host and republish. Blocking.
	fn add(&self, namespace: String, id: u64, handler: Arc<dyn Handler>) -> Result<(), HostError> {
		{
			let mut state = self.state.lock();
			let State::Live(live) = &mut *state else {
				return Err(HostError::Closed);
			};
			if live.shared.handlers.read().contains_key(&namespace) {
				return Err(HostError::AlreadyRegistered(namespace));
			}
			live
				.shared
				.handlers
				.write()
				.insert(namespace.clone(), Slot { id, handler });
			live.sync_capabilities();
		}
		if let Err(error) = self.flush() {
			self.remove_handler(&namespace, id);
			return Err(HostError::Write(entry_path(&self.dir, &self.instance_id), error));
		}
		Ok(())
	}

	/// Stop routing registration `id` of `namespace` and recompute the entry
	/// bytes (no I/O). `true` when it was registered.
	fn remove_handler(&self, namespace: &str, id: u64) -> bool {
		let removed = {
			let mut state = self.state.lock();
			let State::Live(live) = &mut *state else {
				return false;
			};
			let removed = {
				let mut handlers = live.shared.handlers.write();
				if handlers.get(namespace).is_none_or(|slot| slot.id != id) {
					return false;
				}
				handlers.remove(namespace)
			};
			live.sync_capabilities();
			removed
		};
		// The handler (and whatever it owns) is dropped with no lock held.
		drop(removed);
		true
	}

	async fn close(self: Arc<Self>) {
		let _gate = self.gate.lock().await;
		let inner = Arc::clone(&self);
		let Ok(Some(mut live)) = tokio::task::spawn_blocking(move || inner.withdraw_entry()).await
		else {
			return;
		};
		live.task.abort();
		let _ = (&mut live.task).await;
		let _ = tokio::task::spawn_blocking(move || drop(live)).await;
	}
}

impl Drop for Inner {
	fn drop(&mut self) {
		if let State::Live(live) = std::mem::replace(self.state.get_mut(), State::Closed) {
			let _ = std::fs::remove_file(&live.path);
		}
	}
}

impl Live {
	/// Recompute `capabilities` (sorted: `BTreeMap` keys) and the file bytes.
	fn sync_capabilities(&mut self) {
		self.entry.capabilities = self.shared.handlers.read().keys().cloned().collect();
		self.bytes = self.entry.to_file_bytes();
	}
}

impl Drop for Live {
	/// Stop accepting (aborting the accept task drops every connection task
	/// once the runtime gets to it), unlink the socket and remove its bind
	/// lock. The endpoint name is unique to this listener, so no other binder
	/// contends for the lock.
	fn drop(&mut self) {
		self.task.abort();
		if let Some(bound) = self.bound.take() {
			pi_ipc::release(bound);
		}
		#[cfg(unix)]
		let _ = std::fs::remove_file(format!("{}.bind.lock", self.entry.endpoint));
	}
}

/// A namespace served by an [`InstanceHost`].
///
/// Dropping it stops routing the namespace at once and rewrites the entry's
/// `capabilities` on a blocking thread (inline only outside a Tokio
/// runtime); [`Self::unregister`] awaits that rewrite. Inert once the host is
/// closed.
pub struct Registration {
	/// `None` once unregistered.
	host:      Option<Weak<Inner>>,
	namespace: String,
	id:        u64,
}

impl Registration {
	pub fn namespace(&self) -> &str {
		&self.namespace
	}

	/// Stop serving the namespace and wait until the entry no longer lists
	/// it (the rewrite runs on a blocking thread).
	pub async fn unregister(mut self) {
		let Some(inner) = self.release() else {
			return;
		};
		let _ = tokio::task::spawn_blocking(move || inner.flush()).await;
	}

	/// Stop routing; the host to republish, if anything changed.
	fn release(&mut self) -> Option<Arc<Inner>> {
		let inner = self.host.take()?.upgrade()?;
		inner
			.remove_handler(&self.namespace, self.id)
			.then_some(inner)
	}
}

impl fmt::Debug for Registration {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_struct("Registration")
			.field("namespace", &self.namespace)
			.finish_non_exhaustive()
	}
}

impl Drop for Registration {
	fn drop(&mut self) {
		let Some(inner) = self.release() else {
			return;
		};
		match tokio::runtime::Handle::try_current() {
			Ok(runtime) => {
				runtime.spawn_blocking(move || inner.flush());
			},
			Err(_) => {
				let _ = inner.flush();
			},
		}
	}
}

/// Accept connections, serving at most [`MAX_CONNECTIONS`] at once; refused
/// ones get `busy` from at most [`MAX_BUSY_REPLIES`] tasks and are dropped
/// beyond that. Aborting the task drops every connection task with it.
async fn accept_loop(mut listener: pi_ipc::Listener, shared: Arc<Shared>) {
	let permits = Arc::new(Semaphore::new(MAX_CONNECTIONS));
	let busy_permits = Arc::new(Semaphore::new(MAX_BUSY_REPLIES));
	let mut connections = JoinSet::new();
	loop {
		while connections.try_join_next().is_some() {}
		let Ok(stream) = listener.accept().await else {
			// Transient (e.g. out of file descriptors): back off, keep serving.
			tokio::time::sleep(Duration::from_millis(50)).await;
			continue;
		};
		if let Ok(permit) = Arc::clone(&permits).try_acquire_owned() {
			let shared = Arc::clone(&shared);
			connections.spawn(async move {
				serve(stream, &shared).await;
				drop(permit);
			});
		} else if let Ok(busy) = Arc::clone(&busy_permits).try_acquire_owned() {
			connections.spawn(async move {
				refuse(stream, &error_line("busy"), REFUSE_LINGER, MAX_DRAIN_BYTES).await;
				drop(busy);
			});
		}
	}
}

/// One request line in, one response line out.
async fn serve(mut stream: pi_ipc::Stream, shared: &Shared) {
	let line = match tokio::time::timeout(
		REQUEST_READ_TIMEOUT,
		read_line(&mut stream, MAX_REQUEST_LINE_BYTES),
	)
	.await
	{
		Ok(Ok(Some(line))) => line,
		Ok(Err(LineError::TooLarge)) => {
			refuse(stream, &error_line("too_large"), REFUSE_LINGER, MAX_DRAIN_BYTES).await;
			return;
		},
		// Timed out, I/O error, or closed without a request (liveness probe).
		_ => return,
	};
	let response = dispatch(&line, shared).await;
	let _ = tokio::time::timeout(RESPONSE_WRITE_TIMEOUT, async {
		if write_line(&mut stream, &response).await.is_ok() {
			let _ = stream.shutdown().await;
		}
	})
	.await;
}

#[derive(Deserialize)]
struct Request<'a> {
	#[serde(borrow, default)]
	v:     Option<&'a RawValue>,
	#[serde(borrow, default)]
	token: Option<&'a RawValue>,
	#[serde(borrow, default)]
	to:    Option<&'a RawValue>,
	#[serde(borrow, default)]
	op:    Option<&'a RawValue>,
	#[serde(borrow, default)]
	body:  Option<&'a RawValue>,
}

fn string(raw: Option<&RawValue>) -> Option<String> {
	raw.and_then(|raw| serde_json::from_str::<String>(raw.get()).ok())
}

/// Check `line` in protocol order and run the handler; the response line.
async fn dispatch(line: &[u8], shared: &Shared) -> Vec<u8> {
	// Derived struct deserializers also accept arrays; requests are objects.
	let is_object = line.trim_ascii_start().first() == Some(&b'{');
	let Some(request) = serde_json::from_slice::<Request<'_>>(line)
		.ok()
		.filter(|_| is_object)
	else {
		return error_line("malformed_request");
	};
	if request.v.map(RawValue::get) != Some("1") {
		return error_line("unsupported_protocol");
	}
	if !string(request.token).is_some_and(|token| token_matches(&shared.token, &token)) {
		return error_line("authentication_failed");
	}
	if string(request.to).as_deref() != Some(&*shared.instance_id) {
		return error_line("misdirected");
	}
	let Some(op) = string(request.op) else {
		return error_line("invalid_operation");
	};
	let (namespace, op) = op.split_once('.').unwrap_or((&op, ""));
	let Some(handler) = shared
		.handlers
		.read()
		.get(namespace)
		.map(|slot| Arc::clone(&slot.handler))
	else {
		return error_line("unavailable");
	};
	let null: &RawValue = serde_json::from_str("null").expect("null is valid JSON");
	let body = request.body.unwrap_or(null);
	if body.get().len() > handler.max_body_bytes() {
		return error_line("too_large");
	}
	let ctx = RequestCtx { instance_id: Arc::clone(&shared.instance_id) };
	match handler.handle(op, body, ctx).await {
		HandlerReply::Ok(body) => ok_line(&body),
		HandlerReply::Error(code) if RESERVED_CODES.contains(&&*code) => error_line("internal"),
		HandlerReply::Error(code) => error_line(&code),
	}
}
