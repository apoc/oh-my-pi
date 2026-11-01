//! N-API adapter for the local Collab host registry: the `collab` namespace
//! of `pi_instances::collab`, served on an [`InstanceHost`].
//!
//! The handler, listing and link resolution live in `pi_instances::collab`;
//! this module only bridges a JS source (a threadsafe `onQuery` callback
//! answered through [`CollabRegistration::respond`]) and converts snapshots,
//! links and failures to JS values. Link failures reject with an `Error`
//! whose `code` is the `CollabLinkErrorCode`; registry directory failures use
//! [`REGISTRY_DIR_CODE`].

use std::{
	collections::HashMap,
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicU64, Ordering},
	},
	time::Duration,
};

use napi::{
	Env, Error, Result, Status,
	bindgen_prelude::*,
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode, UnknownReturnValue},
};
use napi_derive::napi;
use parking_lot::Mutex;
use pi_instances::{
	BoxFuture, Registration,
	collab::{self, CollabAccess, CollabHandler, CollabQuery, CollabSource, ResolveError},
};
use tokio::sync::oneshot;

use crate::{
	instances::InstanceHost,
	task::{self, coded, invalid_arg},
};

/// `code` of a rejection caused by the registry directory (insecure,
/// unreadable) rather than by a host.
const REGISTRY_DIR_CODE: &str = "registry_dir";

/// Weak: a published host never keeps the event loop alive by itself.
type QueryCallback =
	ThreadsafeFunction<CollabHostQuery, UnknownReturnValue, CollabHostQuery, Status, false, true>;

#[napi(object)]
pub struct CollabModel {
	pub provider: String,
	pub id:       String,
}

/// Non-capability host state, computed by the host at query time. Free-form
/// strings (session id and name, cwd, model) are bounded to 1024 UTF-16 code
/// units on the wire.
#[napi(object, use_nullable = true)]
pub struct CollabHostSnapshot {
	/// The publishing host's instance id (listers take it from the registry
	/// entry, whatever the source reported).
	pub instance_id:     String,
	/// Increments every time the process starts a new room (≥ 1).
	pub generation:      f64,
	/// Host process id (listers take it from the registry entry).
	pub pid:             u32,
	/// Session id of the hosted conversation.
	pub session_id:      String,
	/// Human-readable session name, when one is set.
	pub session_name:    Option<String>,
	/// Host working directory.
	pub cwd:             String,
	/// Model the host session is using, when one is selected.
	pub model:           Option<CollabModel>,
	/// Epoch milliseconds when the host first connected to the relay.
	pub started_at:      f64,
	/// Participant count, including the host.
	pub participants:    u32,
	/// Whether the host holds an open relay connection.
	pub relay_connected: bool,
	/// Whether a host-side question waits for an answer a writable guest
	/// could give.
	pub input_required:  bool,
	/// Whether the session is running a turn (streaming or executing tools).
	/// `null` when the host does not report it; unknown is not idle.
	pub busy:            Option<bool>,
	/// Highest access the host hands out.
	#[napi(ts_type = "'view' | 'control'")]
	pub access:          String,
}

/// One request a published host must answer via its registration's
/// `respond()`.
#[napi(object, object_from_js = false)]
pub struct CollabHostQuery {
	pub request_id: String,
	#[napi(ts_type = "'snapshot' | 'link'")]
	pub op:         String,
	/// For `link`: the access whose URL is wanted.
	#[napi(ts_type = "'view' | 'control'")]
	pub access:     Option<String>,
}

/// A source's answer, read in one tick: the snapshot (`null` when the host
/// cannot vouch for its session) and, for `link`, the URL for the requested
/// access (`null` when that access is not published).
#[napi(object, object_to_js = false, use_nullable = true)]
pub struct CollabHostAnswer {
	pub snapshot: Option<CollabHostSnapshot>,
	pub url:      Option<String>,
}

#[napi(object, object_to_js = false)]
pub struct CollabLookupOptions {
	/// Registry directory.
	pub dir:        String,
	/// Per-host deadline in milliseconds (default 1500).
	pub timeout_ms: Option<u32>,
}

/// One resolved capability.
#[napi(object, object_from_js = false)]
pub struct CollabResolvedLink {
	pub instance_id: String,
	pub generation:  f64,
	#[napi(ts_type = "'view' | 'control'")]
	pub access:      String,
	pub url:         String,
}

/// Largest integer a JS number carries exactly.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// A non-negative integral JS number.
fn whole(value: f64) -> Option<u64> {
	(value.is_finite() && value.fract() == 0.0 && (0.0..=MAX_SAFE_INTEGER).contains(&value))
		.then_some(value as u64)
}

impl CollabHostSnapshot {
	/// `None` when a field is out of range (the host answers
	/// `snapshot_unavailable`, as for any malformed snapshot).
	fn into_native(self) -> Option<collab::CollabHostSnapshot> {
		Some(collab::CollabHostSnapshot {
			instance_id:     self.instance_id,
			generation:      whole(self.generation)?,
			pid:             self.pid,
			session_id:      self.session_id,
			session_name:    self.session_name,
			cwd:             self.cwd,
			model:           self
				.model
				.map(|model| collab::CollabModel { provider: model.provider, id: model.id }),
			started_at:      whole(self.started_at)?,
			participants:    self.participants,
			relay_connected: self.relay_connected,
			input_required:  self.input_required,
			busy:            self.busy,
			access:          self.access.parse().ok()?,
		})
	}

	fn from_native(snapshot: collab::CollabHostSnapshot) -> Self {
		Self {
			instance_id:     snapshot.instance_id,
			generation:      snapshot.generation as f64,
			pid:             snapshot.pid,
			session_id:      snapshot.session_id,
			session_name:    snapshot.session_name,
			cwd:             snapshot.cwd,
			model:           snapshot
				.model
				.map(|model| CollabModel { provider: model.provider, id: model.id }),
			started_at:      snapshot.started_at as f64,
			participants:    snapshot.participants,
			relay_connected: snapshot.relay_connected,
			input_required:  snapshot.input_required,
			busy:            snapshot.busy,
			access:          snapshot.access.as_str().to_owned(),
		}
	}
}

type Answer = std::result::Result<collab::CollabAnswer, ()>;

/// Queries awaiting a JS answer, by request id.
#[derive(Default)]
struct Pending {
	next:    AtomicU64,
	/// Set by `close()`: no query reaches JS and no answer is accepted after.
	closed:  AtomicBool,
	waiting: Mutex<HashMap<u64, oneshot::Sender<Answer>>>,
}

impl Pending {
	/// Register a new query; `None` once closed.
	fn begin(&self) -> Option<(u64, oneshot::Receiver<Answer>)> {
		let mut waiting = self.waiting.lock();
		// Checked under the lock `close()` clears under, so no query slips in
		// after it.
		if self.closed.load(Ordering::Acquire) {
			return None;
		}
		let id = self.next.fetch_add(1, Ordering::Relaxed);
		let (tx, rx) = oneshot::channel();
		waiting.insert(id, tx);
		Some((id, rx))
	}

	fn settle(&self, id: u64, answer: Answer) {
		let waiter = self.waiting.lock().remove(&id);
		if let Some(waiter) = waiter {
			let _ = waiter.send(answer);
		}
	}

	/// Stop accepting queries; every pending one fails.
	fn close(&self) {
		let dropped = {
			let mut waiting = self.waiting.lock();
			self.closed.store(true, Ordering::Release);
			std::mem::take(&mut *waiting)
		};
		drop(dropped);
	}
}

/// Removes its query from [`Pending`] when the handler stops waiting
/// (answered, deadline, or connection dropped).
struct Forget {
	pending: Arc<Pending>,
	id:      u64,
}

impl Drop for Forget {
	fn drop(&mut self) {
		self.pending.waiting.lock().remove(&self.id);
	}
}

/// The JS side of a published host.
struct JsSource {
	callback: QueryCallback,
	pending:  Arc<Pending>,
}

impl CollabSource for JsSource {
	fn query(&self, query: CollabQuery) -> BoxFuture<Answer> {
		let Some((id, rx)) = self.pending.begin() else {
			return Box::pin(std::future::ready(Err(())));
		};
		let forget = Forget { pending: Arc::clone(&self.pending), id };
		let (op, access) = match query {
			CollabQuery::Snapshot => ("snapshot", None),
			CollabQuery::Link(access) => ("link", Some(access.as_str().to_owned())),
		};
		let event = CollabHostQuery { request_id: id.to_string(), op: op.to_owned(), access };
		let status = self
			.callback
			.call(event, ThreadsafeFunctionCallMode::NonBlocking);
		if status != Status::Ok {
			self.pending.settle(id, Err(()));
		}
		Box::pin(async move {
			let _forget = forget;
			rx.await.unwrap_or(Err(()))
		})
	}
}

/// A host published under the `collab` namespace. `close()` withdraws it.
#[napi]
pub struct CollabRegistration {
	pending:      Arc<Pending>,
	registration: Mutex<Option<Registration>>,
}

#[napi]
impl CollabRegistration {
	/// Answer query `requestId`: `answer` read in one tick from the host's
	/// state, or `null` when the host cannot vouch for its session. Unknown or
	/// late ids (past the 5 s deadline) are ignored.
	#[napi]
	pub fn respond(&self, request_id: String, answer: Option<CollabHostAnswer>) {
		let Ok(id) = request_id.parse::<u64>() else {
			return;
		};
		let answer = match answer {
			None => Err(()),
			Some(CollabHostAnswer { snapshot, url }) => {
				match snapshot.map(CollabHostSnapshot::into_native) {
					Some(None) => Err(()),
					snapshot => Ok(collab::CollabAnswer { snapshot: snapshot.flatten(), url }),
				}
			},
		};
		self.pending.settle(id, answer);
	}

	/// Stop serving `collab` on the host (the host itself stays open). From
	/// the call on, no query reaches `onQuery` and pending ones fail.
	/// Idempotent.
	#[napi(ts_return_type = "Promise<void>")]
	pub fn close<'env>(&self, env: &'env Env) -> Result<PromiseRaw<'env, ()>> {
		self.pending.close();
		let registration = self.registration.lock().take();
		task::future(env, "collab_unpublish", async move {
			if let Some(registration) = registration {
				registration.unregister().await;
			}
			Ok(())
		})
	}
}

/// Serve the `collab` namespace on `host`.
///
/// Every request calls `onQuery`, which must answer through the returned
/// registration's `respond()` within 5 s. The first registration on a host
/// binds its endpoint and writes its registry entry; rejects when `collab` is
/// already served on `host` or the host is closed.
#[napi(
	js_name = "publishCollab",
	ts_args_type = "host: InstanceHost, onQuery: (query: CollabHostQuery) => void",
	ts_return_type = "Promise<CollabRegistration>"
)]
pub fn publish_collab<'env>(
	env: &'env Env,
	host: &InstanceHost,
	on_query: Function<'env, CollabHostQuery, UnknownReturnValue>,
) -> Result<PromiseRaw<'env, CollabRegistration>> {
	let callback: QueryCallback = on_query
		.build_threadsafe_function()
		.callee_handled::<false>()
		.weak::<true>()
		.build()?;
	let pending = Arc::new(Pending::default());
	let source = Arc::new(JsSource { callback, pending: Arc::clone(&pending) });
	let host = Arc::clone(host.inner());
	task::future(env, "collab_publish", async move {
		let registration = host
			.register(collab::NAMESPACE, Arc::new(CollabHandler::new(source)))
			.await
			.map_err(|err| Error::from_reason(err.to_string()))?;
		Ok(CollabRegistration { pending, registration: Mutex::new(Some(registration)) })
	})
}

fn timeout(options: &CollabLookupOptions) -> Duration {
	options
		.timeout_ms
		.map_or(collab::DEFAULT_QUERY_TIMEOUT, |ms| Duration::from_millis(u64::from(ms)))
}

fn resolve_error(env: Env, error: ResolveError) -> Error {
	match error {
		ResolveError::Dir(error) => coded(env, REGISTRY_DIR_CODE, error.to_string()),
		ResolveError::Link(error) => coded(env, error.code.as_str(), error.message),
	}
}

/// Live Collab hosts in `options.dir`, sorted by `startedAt`, pid, then
/// instance id.
///
/// Dead and malformed entries are pruned on the way; the result carries no
/// URLs. Rejects (code `registry_dir`) when the directory is insecure or
/// unreadable; a missing directory lists nothing.
#[napi(js_name = "listCollabHosts", ts_return_type = "Promise<CollabHostSnapshot[]>")]
pub fn list_collab_hosts(
	env: &Env,
	options: CollabLookupOptions,
) -> Result<PromiseRaw<'_, Vec<CollabHostSnapshot>>> {
	let timeout = timeout(&options);
	env.spawn_future_with_callback(
		async move {
			Ok(collab::list_hosts(std::path::Path::new(&options.dir), timeout)
				.await
				.map(|hosts| {
					hosts
						.into_iter()
						.map(CollabHostSnapshot::from_native)
						.collect()
				}))
		},
		|env, outcome: std::result::Result<Vec<CollabHostSnapshot>, _>| {
			outcome.map_err(|error| coded(*env, REGISTRY_DIR_CODE, error.to_string()))
		},
	)
}

/// One URL for the host `selector` names (exact instance id, else pid).
/// Rejects with `code` `not_found`, `ambiguous`, `stale_generation`,
/// `access_unavailable`, `unreachable`, or `registry_dir`.
#[napi(
	js_name = "resolveCollabHostLink",
	ts_args_type = "selector: string, access: 'view' | 'control', options: CollabLookupOptions",
	ts_return_type = "Promise<CollabResolvedLink>"
)]
pub fn resolve_collab_host_link(
	env: &Env,
	selector: String,
	access: String,
	options: CollabLookupOptions,
) -> Result<PromiseRaw<'_, CollabResolvedLink>> {
	let access = access
		.parse::<CollabAccess>()
		.map_err(|()| invalid_arg(format!("invalid collab access: {access}")))?;
	let timeout = timeout(&options);
	env.spawn_future_with_callback(
		async move {
			Ok(collab::resolve_link(std::path::Path::new(&options.dir), &selector, access, timeout)
				.await
				.map(|link| CollabResolvedLink {
					instance_id: link.instance_id,
					generation:  link.generation as f64,
					access:      link.access.as_str().to_owned(),
					url:         link.url,
				}))
		},
		|env, outcome| outcome.map_err(|error| resolve_error(*env, error)),
	)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn snapshot() -> CollabHostSnapshot {
		CollabHostSnapshot {
			instance_id:     "abcdefgh12345678".into(),
			generation:      2.0,
			pid:             7,
			session_id:      "s".into(),
			session_name:    None,
			cwd:             "/w".into(),
			model:           Some(CollabModel { provider: "p".into(), id: "m".into() }),
			started_at:      1_700_000_000_000.0,
			participants:    1,
			relay_connected: true,
			input_required:  false,
			busy:            None,
			access:          "view".into(),
		}
	}

	#[test]
	fn js_snapshots_round_trip_and_out_of_range_fields_fail() {
		let native = snapshot().into_native().expect("valid snapshot");
		assert_eq!(native.generation, 2);
		assert_eq!(native.started_at, 1_700_000_000_000);
		assert_eq!(native.access, CollabAccess::View);
		let back = CollabHostSnapshot::from_native(native);
		assert_eq!((back.generation, back.access.as_str(), back.busy), (2.0, "view", None));

		for broken in [
			CollabHostSnapshot { generation: 1.5, ..snapshot() },
			CollabHostSnapshot { generation: -1.0, ..snapshot() },
			CollabHostSnapshot { started_at: f64::NAN, ..snapshot() },
			CollabHostSnapshot { started_at: 1e300, ..snapshot() },
			CollabHostSnapshot { access: "write".into(), ..snapshot() },
		] {
			assert!(broken.into_native().is_none());
		}
	}

	#[test]
	fn closing_fails_pending_queries_and_refuses_new_ones_and_late_answers() {
		let pending = Pending::default();
		let (id, mut rx) = pending.begin().expect("open");
		pending.close();
		assert!(rx.try_recv().is_err(), "the pending query failed");
		assert!(pending.begin().is_none(), "no query after close");
		pending.settle(id, Ok(collab::CollabAnswer { snapshot: None, url: None }));
		assert!(pending.waiting.lock().is_empty());

		let open = Pending::default();
		let (id, mut rx) = open.begin().expect("open");
		open.settle(id, Err(()));
		assert_eq!(rx.try_recv().ok(), Some(Err(())));
	}
}
