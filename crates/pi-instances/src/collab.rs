//! The `collab` namespace: a Collab host's live state and room links.
//!
//! Ops (`collab.<op>`, body ≤ [`MAX_REQUEST_BODY_BYTES`]):
//! - `snapshot` → the host's [`CollabHostSnapshot`], free-form strings bounded
//!   to [`MAX_FIELD_UTF16`] UTF-16 code units;
//! - `link` with `{access, generation}` → `{url}`.
//!
//! The handler evaluates in today's order: snapshot (missing, failed or past
//! [`SNAPSHOT_TIMEOUT`] ⇒ `snapshot_unavailable`) → op (`invalid_operation`)
//! → access (`invalid_access`) → generation (`stale_generation`) → control
//! on a view-only host, or no URL (`access_unavailable`). The generation is
//! checked before the access level, so a room that rotated underneath a
//! listing reports `stale_generation` rather than a verdict about its
//! predecessor. URLs and room secrets never touch the disk.

use std::{fmt, sync::Arc, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::{Value, value::RawValue};

use crate::{
	BoxFuture,
	client::{InstanceError, request},
	dir::DirError,
	entry::InstanceEntry,
	host::{Handler, HandlerReply, RequestCtx, with_deadline},
	list::{Probe, ProbeRequest, list},
};

/// Namespace (capability) served by Collab hosts.
pub const NAMESPACE: &str = "collab";
/// Largest request body a host accepts.
pub const MAX_REQUEST_BODY_BYTES: usize = 4 * 1024;
/// Largest response line a lister accepts.
pub const MAX_RESPONSE_BYTES: usize = 64 * 1024;
/// Longest free-form snapshot string on the wire, in UTF-16 code units.
pub const MAX_FIELD_UTF16: usize = 1024;
/// How long the host waits for its source's answer.
pub const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(5);
/// Default per-entry deadline for listing and linking.
pub const DEFAULT_QUERY_TIMEOUT: Duration = Duration::from_millis(1500);

/// Access a link grants: `view` (bare room key) or `control` (room key +
/// write token).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CollabAccess {
	View,
	Control,
}

impl CollabAccess {
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::View => "view",
			Self::Control => "control",
		}
	}
}

impl fmt::Display for CollabAccess {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str(self.as_str())
	}
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CollabModel {
	pub provider: String,
	pub id:       String,
}

/// Non-capability host state, computed by the host at query time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabHostSnapshot {
	/// Listers replace it with the publishing host's instance id.
	pub instance_id:     String,
	/// Increments every time the host starts a new room (≥ 1).
	pub generation:      u64,
	/// Listers replace it with the publishing host's pid.
	pub pid:             u32,
	pub session_id:      String,
	pub session_name:    Option<String>,
	pub cwd:             String,
	pub model:           Option<CollabModel>,
	/// Epoch ms when the host first connected to the relay.
	pub started_at:      u64,
	/// Participants, including the host.
	pub participants:    u32,
	pub relay_connected: bool,
	/// A host-side question waits for an answer a writable guest could give.
	pub input_required:  bool,
	/// Whether the session is running a turn; `None` when the host does not
	/// report it (unknown is not idle).
	#[serde(default)]
	pub busy:            Option<bool>,
	/// Highest access the host hands out.
	pub access:          CollabAccess,
}

impl CollabHostSnapshot {
	/// Bound every free-form string to [`MAX_FIELD_UTF16`] UTF-16 code units.
	fn bound(&mut self) {
		bound_utf16(&mut self.session_id, MAX_FIELD_UTF16);
		if let Some(name) = &mut self.session_name {
			bound_utf16(name, MAX_FIELD_UTF16);
		}
		bound_utf16(&mut self.cwd, MAX_FIELD_UTF16);
		if let Some(model) = &mut self.model {
			bound_utf16(&mut model.provider, MAX_FIELD_UTF16);
			bound_utf16(&mut model.id, MAX_FIELD_UTF16);
		}
	}
}

/// Truncate `text` to at most `max` UTF-16 code units at a char boundary: a
/// surrogate pair straddling the cut is dropped whole.
pub(crate) fn bound_utf16(text: &mut String, max: usize) {
	let mut units = 0;
	for (at, ch) in text.char_indices() {
		units += ch.len_utf16();
		if units > max {
			text.truncate(at);
			return;
		}
	}
}

/// What a host is asked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CollabQuery {
	Snapshot,
	/// The snapshot plus the URL for this access.
	Link(CollabAccess),
}

/// A source's answer, produced at one point in time so a URL always belongs
/// to the snapshot it came with. `Debug` omits the URL (a room capability).
#[derive(Clone, PartialEq, Eq)]
pub struct CollabAnswer {
	/// `None` when the host can no longer vouch for its session.
	pub snapshot: Option<CollabHostSnapshot>,
	/// For [`CollabQuery::Link`]: the URL, `None` when that access is not
	/// published.
	pub url:      Option<String>,
}

impl fmt::Debug for CollabAnswer {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_struct("CollabAnswer")
			.field("snapshot", &self.snapshot)
			.field("url", &self.url.as_ref().map(|_| "<redacted>"))
			.finish()
	}
}

/// Live host state behind the `collab` handler. `Err(())`: the source failed
/// (answered `snapshot_unavailable`, with no detail on the wire).
pub trait CollabSource: Send + Sync + 'static {
	fn query(&self, query: CollabQuery) -> BoxFuture<Result<CollabAnswer, ()>>;
}

/// The `collab` namespace handler; register it on an
/// [`crate::InstanceHost`] under [`NAMESPACE`].
pub struct CollabHandler {
	source:  Arc<dyn CollabSource>,
	timeout: Duration,
}

impl CollabHandler {
	pub fn new(source: Arc<dyn CollabSource>) -> Self {
		Self { source, timeout: SNAPSHOT_TIMEOUT }
	}

	#[cfg(test)]
	pub(crate) fn with_timeout(source: Arc<dyn CollabSource>, timeout: Duration) -> Self {
		Self { source, timeout }
	}
}

fn reply_error(code: &'static str) -> HandlerReply {
	HandlerReply::Error(code.into())
}

fn reply_json<T: Serialize>(value: &T) -> HandlerReply {
	match serde_json::value::to_raw_value(value) {
		Ok(raw) => HandlerReply::Ok(raw),
		Err(_) => reply_error("snapshot_unavailable"),
	}
}

impl Handler for CollabHandler {
	fn handle(&self, op: &str, body: &RawValue, _ctx: RequestCtx) -> BoxFuture<HandlerReply> {
		let op = op.to_owned();
		let fields = serde_json::from_str::<Value>(body.get()).unwrap_or(Value::Null);
		let access = fields
			.get("access")
			.and_then(|access| CollabAccess::deserialize(access).ok());
		let generation = fields.get("generation").and_then(Value::as_f64);
		let query = match access {
			Some(access) if op == "link" => CollabQuery::Link(access),
			_ => CollabQuery::Snapshot,
		};
		let answer = self.source.query(query);
		Box::pin(with_deadline(
			self.timeout,
			async move {
				let Ok(CollabAnswer { snapshot: Some(mut snapshot), url }) = answer.await else {
					return reply_error("snapshot_unavailable");
				};
				match op.as_str() {
					"snapshot" => {
						snapshot.bound();
						return reply_json(&snapshot);
					},
					"link" => {},
					_ => return reply_error("invalid_operation"),
				}
				let Some(access) = access else {
					return reply_error("invalid_access");
				};
				// A capability is bound to the exact generation the caller
				// listed: a rotated room must not hand out its successor's.
				if generation != Some(snapshot.generation as f64) {
					return reply_error("stale_generation");
				}
				if access == CollabAccess::Control && snapshot.access != CollabAccess::Control {
					return reply_error("access_unavailable");
				}
				match url.filter(|url| !url.is_empty()) {
					Some(url) => reply_json(&serde_json::json!({ "url": url })),
					None => reply_error("access_unavailable"),
				}
			},
			reply_error("snapshot_unavailable"),
		))
	}

	fn max_body_bytes(&self) -> usize {
		MAX_REQUEST_BODY_BYTES
	}
}

/// One resolved capability. `Debug` omits the URL.
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabResolvedLink {
	pub instance_id: String,
	pub generation:  u64,
	pub access:      CollabAccess,
	pub url:         String,
}

impl fmt::Debug for CollabResolvedLink {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_struct("CollabResolvedLink")
			.field("instance_id", &self.instance_id)
			.field("generation", &self.generation)
			.field("access", &self.access)
			.finish_non_exhaustive()
	}
}

/// Stable failure codes of [`resolve_link`]; messages never carry URLs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CollabLinkErrorCode {
	NotFound,
	Ambiguous,
	StaleGeneration,
	AccessUnavailable,
	Unreachable,
}

impl CollabLinkErrorCode {
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::NotFound => "not_found",
			Self::Ambiguous => "ambiguous",
			Self::StaleGeneration => "stale_generation",
			Self::AccessUnavailable => "access_unavailable",
			Self::Unreachable => "unreachable",
		}
	}
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct CollabLinkError {
	pub code:    CollabLinkErrorCode,
	pub message: String,
}

impl CollabLinkError {
	const fn new(code: CollabLinkErrorCode, message: String) -> Self {
		Self { code, message }
	}
}

#[derive(Debug, thiserror::Error)]
pub enum ResolveError {
	#[error(transparent)]
	Dir(#[from] DirError),
	#[error(transparent)]
	Link(#[from] CollabLinkError),
}

/// Live Collab hosts in `dir`, sorted by `startedAt`, pid, then instance id.
///
/// The publishing host's own entry is included. Unreachable,
/// unauthenticated, malformed or version-mismatched entries are omitted;
/// dead and malformed ones are pruned. The result carries no URLs.
pub async fn list_hosts(
	dir: &std::path::Path,
	timeout: Duration,
) -> Result<Vec<CollabHostSnapshot>, DirError> {
	Ok(live_hosts(dir, timeout)
		.await?
		.into_iter()
		.map(|(_, snapshot)| snapshot)
		.collect())
}

async fn live_hosts(
	dir: &std::path::Path,
	timeout: Duration,
) -> Result<Vec<(InstanceEntry, CollabHostSnapshot)>, DirError> {
	let probe = |_: &InstanceEntry| ProbeRequest {
		op:           format!("{NAMESPACE}.snapshot"),
		body:         serde_json::value::to_raw_value(&serde_json::json!({}))
			.expect("empty object serializes"),
		max_response: MAX_RESPONSE_BYTES,
	};
	let mut live: Vec<_> = list(dir, NAMESPACE, None, probe, timeout)
		.await?
		.into_iter()
		.filter_map(|(entry, probe)| {
			let Probe::Body(body) = probe else {
				return None;
			};
			let mut snapshot = serde_json::from_str::<CollabHostSnapshot>(body.get()).ok()?;
			if snapshot.generation == 0 {
				return None;
			}
			snapshot.instance_id.clone_from(&entry.instance_id);
			snapshot.pid = entry.pid;
			Some((entry, snapshot))
		})
		.collect();
	live.sort_by(|(_, a), (_, b)| {
		a.started_at
			.cmp(&b.started_at)
			.then_with(|| a.pid.cmp(&b.pid))
			.then_with(|| a.instance_id.cmp(&b.instance_id))
	});
	Ok(live)
}

/// Resolve one URL for the host `selector` names.
///
/// `selector` is an exact instance id, or a pid when no instance id matches.
/// The link request carries the generation observed while listing, so a host
/// that rotated rooms in between answers `stale_generation` instead of
/// leaking its successor's capability.
pub async fn resolve_link(
	dir: &std::path::Path,
	selector: &str,
	access: CollabAccess,
	timeout: Duration,
) -> Result<CollabResolvedLink, ResolveError> {
	use CollabLinkErrorCode as Code;
	let wanted = selector.trim_matches(is_js_whitespace);
	let live = live_hosts(dir, timeout).await?;
	let mut matches: Vec<_> = live
		.iter()
		.filter(|(_, snapshot)| snapshot.instance_id == wanted)
		.collect();
	if matches.is_empty() && is_pid_selector(wanted) {
		let pid = wanted.parse::<u64>().ok();
		matches = live
			.iter()
			.filter(|(_, snapshot)| Some(u64::from(snapshot.pid)) == pid)
			.collect();
	}
	let (entry, snapshot) = match matches.as_slice() {
		[] => {
			return Err(
				CollabLinkError::new(Code::NotFound, format!("no active Collab host matches {wanted}"))
					.into(),
			);
		},
		[only] => *only,
		several => {
			let ids: Vec<&str> = several
				.iter()
				.map(|(_, snapshot)| snapshot.instance_id.as_str())
				.collect();
			return Err(
				CollabLinkError::new(
					Code::Ambiguous,
					format!(
						"{wanted} matches more than one Collab host; use an instance id: {}",
						ids.join(", ")
					),
				)
				.into(),
			);
		},
	};
	let id = &snapshot.instance_id;
	let body = serde_json::value::to_raw_value(&serde_json::json!({
		"access": access,
		"generation": snapshot.generation,
	}))
	.expect("link body serializes");
	let answer =
		request(entry, &format!("{NAMESPACE}.link"), &body, timeout, MAX_RESPONSE_BYTES).await;
	let error = match answer {
		Ok(body) => {
			let url = serde_json::from_str::<Value>(body.get())
				.ok()
				.and_then(|value| value.get("url").and_then(Value::as_str).map(str::to_owned))
				.filter(|url| !url.is_empty());
			return match url {
				Some(url) => Ok(CollabResolvedLink {
					instance_id: id.clone(),
					generation: snapshot.generation,
					access,
					url,
				}),
				None => Err(
					CollabLinkError::new(
						Code::Unreachable,
						format!("host {id} returned an invalid link response"),
					)
					.into(),
				),
			};
		},
		Err(InstanceError::Remote(code)) if code == "stale_generation" => CollabLinkError::new(
			Code::StaleGeneration,
			format!("host {id} started a new room since it was listed; list again and retry"),
		),
		Err(InstanceError::Remote(code)) if code == "access_unavailable" => CollabLinkError::new(
			Code::AccessUnavailable,
			format!("host {id} does not publish {access} access"),
		),
		Err(_) => CollabLinkError::new(
			Code::Unreachable,
			format!("host {id} did not answer the link request"),
		),
	};
	Err(error.into())
}

/// `^[1-9][0-9]*$`.
fn is_pid_selector(text: &str) -> bool {
	text
		.as_bytes()
		.first()
		.is_some_and(|b| (b'1'..=b'9').contains(b))
		&& text.bytes().all(|b| b.is_ascii_digit())
}

/// ECMAScript `WhiteSpace` + `LineTerminator` (what `String#trim` strips):
/// Unicode `White_Space` without U+0085, plus U+FEFF.
const fn is_js_whitespace(ch: char) -> bool {
	ch == '\u{feff}' || (ch.is_whitespace() && ch != '\u{85}')
}
