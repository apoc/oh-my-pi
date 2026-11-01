//! Wire contract of oh my pi mesh. These serde types are the source of truth;
//! the TypeScript frontend mirrors them type-only (`src/mesh/protocol.ts`).
//!
//! Every peer payload is untrusted until it went through [`parse_envelope`],
//! [`parse_response`], [`parse_snapshot`] or [`parse_message_result`]: size
//! caps, required fields, value ranges. Unknown fields are ignored and dropped
//! (never re-serialized). "Characters" in the caps are Unicode scalar values.

use std::sync::Arc;

/// The single validity rule for instance ids (envelopes, snapshots, registry
/// entries, mDNS TXT `id=`): 16 lowercase ASCII letters or digits, so ids fit
/// DNS labels, TXT records and file names unchanged.
pub use pi_instances::is_instance_id;
use serde::{Deserialize, Serialize, Serializer, ser::SerializeStruct};
use serde_json::{Value, value::RawValue};

use crate::error::ProtocolError;

pub const PROTOCOL_VERSION: u32 = 1;
/// Hard cap on one serialized envelope or response.
pub const MAX_ENVELOPE_BYTES: usize = 256 * 1024;
/// Cap on free-text payloads (`text`, `error`, `detail`, snapshot summary).
pub const MAX_TEXT_CHARS: usize = 64 * 1024;
/// Cap on every other string field (ids, names, hosts, paths).
pub const MAX_FIELD_CHARS: usize = 1024;
/// Cap on `agents` in a snapshot.
pub const MAX_AGENTS: usize = 256;
/// Upper bound for a watch registration lifetime.
pub const MAX_WATCH_TTL_SEC: u32 = 3600;
/// Largest `hop` an envelope may carry at all; above is `bad_request`.
pub const MAX_HOP: u32 = 16;
/// Largest `hop` a receiver accepts for dispatch; above is `denied`
/// ([`MeshEnvelope::check_inbound_hop`]).
pub const MAX_INBOUND_HOP: u32 = 0;
/// Recipient wildcard: "whoever listens at this address".
///
/// Valid only with [`MeshRequest::Snapshot`], so a static peer known only as
/// `host:port` can be asked for its snapshot, which carries its real instance
/// id; every later request is addressed to that id. The LAN transport binds
/// the `to` actually sent (`*` included) into the sealed response, not the
/// responder's own id.
pub const ANY_INSTANCE: &str = "*";
/// Longest message id; ids are `^[A-Za-z0-9_-]{1,64}$` (checked only by
/// [`is_msg_id`]). Bounded so replay-guard and pending-map keys stay small.
pub const MAX_MSG_ID_LEN: usize = 64;

/// The single validity rule for message ids (`msgId`, `replyTo`).
pub fn is_msg_id(s: &str) -> bool {
	(1..=MAX_MSG_ID_LEN).contains(&s.len())
		&& s
			.bytes()
			.all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Who sent an envelope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshSender {
	pub instance_id:  String,
	/// `"Main"`, a subagent id, or `"user"`.
	pub agent_id:     String,
	pub display_name: String,
	pub host:         String,
	/// Port of the sender's LAN listener, when its remote side is on. With the
	/// connection's source address it lets the recipient reach the sender for
	/// asynchronous replies (contact learning).
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub lan_port:     Option<u16>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageKind {
	Status,
	Ask,
	Task,
	Steer,
	Note,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeshWatchEvent {
	Idle,
	TurnEnd,
}

/// Request body, tagged by `op`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum MeshRequest {
	/// Answered by the engine from the snapshot the frontend pushed.
	Snapshot,
	/// Acknowledged at once with [`MeshMessageResult`]; `status`/`ask`/`task`
	/// answers arrive later as a separate [`MeshRequest::Reply`].
	Message {
		kind:   MessageKind,
		text:   String,
		#[serde(default, skip_serializing_if = "Option::is_none")]
		thread: Option<String>,
	},
	Reply {
		/// `msgId` of the message being answered.
		reply_to: String,
		#[serde(default, skip_serializing_if = "Option::is_none")]
		thread:   Option<String>,
		text:     String,
		#[serde(default, skip_serializing_if = "Option::is_none")]
		error:    Option<String>,
	},
	Watch {
		event:   MeshWatchEvent,
		ttl_sec: u32,
	},
	WatchEvent {
		watch_id: String,
		event:    MeshWatchEvent,
		#[serde(default, skip_serializing_if = "Option::is_none")]
		detail:   Option<String>,
	},
	Threads,
	Thread {
		thread: String,
	},
}

/// One request on the wire.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshEnvelope {
	/// Always [`PROTOCOL_VERSION`].
	pub v:       u32,
	pub msg_id:  String,
	/// Sender wall clock, ms since the Unix epoch (replay window input).
	pub sent_at: u64,
	/// Loop guard. Every send the engine originates — user/agent sends, replies
	/// to inbound messages, watch events — is hop 0. A send caused by handling
	/// an inbound envelope would carry that envelope's hop + 1; responders get
	/// no mesh tools, so none exist today. Receivers deny anything above
	/// [`MAX_INBOUND_HOP`] via [`Self::check_inbound_hop`].
	pub hop:     u32,
	pub from:    MeshSender,
	/// Recipient instance id, or [`ANY_INSTANCE`] for `snapshot`.
	pub to:      String,
	pub body:    MeshRequest,
}

impl MeshEnvelope {
	/// The dispatcher's hop rule: `denied` above [`MAX_INBOUND_HOP`].
	///
	/// # Errors
	/// [`MeshErrorCode::Denied`] when the envelope was relayed.
	pub fn check_inbound_hop(&self) -> Result<(), ProtocolError> {
		if self.hop > MAX_INBOUND_HOP {
			return Err(ProtocolError::new(
				MeshErrorCode::Denied,
				format!("mesh hop {} exceeds {MAX_INBOUND_HOP}", self.hop),
			));
		}
		Ok(())
	}

	fn validate(&self) -> Result<(), ProtocolError> {
		msg_id(&self.msg_id, "msgId")?;
		if self.hop > MAX_HOP {
			return Err(ProtocolError::bad_request(format!(
				"mesh hop {} exceeds {MAX_HOP}",
				self.hop
			)));
		}
		instance_id(&self.from.instance_id, "from.instanceId")?;
		field(&self.from.agent_id, "from.agentId")?;
		field(&self.from.display_name, "from.displayName")?;
		field(&self.from.host, "from.host")?;
		if self.from.lan_port == Some(0) {
			return Err(ProtocolError::bad_request("mesh from.lanPort must not be 0"));
		}
		if self.to == ANY_INSTANCE {
			if self.body != MeshRequest::Snapshot {
				return Err(ProtocolError::bad_request(
					"recipient \"*\" is only valid for op \"snapshot\"",
				));
			}
		} else {
			instance_id(&self.to, "to")?;
		}
		match &self.body {
			MeshRequest::Snapshot | MeshRequest::Threads => {},
			MeshRequest::Message { text, thread, .. } => {
				if text.is_empty() {
					return Err(ProtocolError::bad_request("mesh message text is empty"));
				}
				text_field(text, "text")?;
				opt_field(thread.as_deref(), "thread")?;
			},
			MeshRequest::Reply { reply_to, thread, text, error } => {
				msg_id(reply_to, "replyTo")?;
				opt_field(thread.as_deref(), "thread")?;
				text_field(text, "text")?;
				if let Some(error) = error {
					text_field(error, "error")?;
				}
			},
			MeshRequest::Watch { ttl_sec, .. } => {
				if !(1..=MAX_WATCH_TTL_SEC).contains(ttl_sec) {
					return Err(ProtocolError::bad_request(format!(
						"watch ttlSec must be 1..={MAX_WATCH_TTL_SEC}"
					)));
				}
			},
			MeshRequest::WatchEvent { watch_id, detail, .. } => {
				field(watch_id, "watchId")?;
				if let Some(detail) = detail {
					text_field(detail, "detail")?;
				}
			},
			MeshRequest::Thread { thread } => field(thread, "thread")?,
		}
		Ok(())
	}
}

/// Failure codes of [`MeshResponse::Err`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeshErrorCode {
	Denied,
	Busy,
	ThreadExpired,
	UnknownThread,
	BadRequest,
	Unauthorized,
	TooLarge,
	RateLimited,
	Unsupported,
	Internal,
}

impl MeshErrorCode {
	pub const ALL: [Self; 10] = [
		Self::Denied,
		Self::Busy,
		Self::ThreadExpired,
		Self::UnknownThread,
		Self::BadRequest,
		Self::Unauthorized,
		Self::TooLarge,
		Self::RateLimited,
		Self::Unsupported,
		Self::Internal,
	];

	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Denied => "denied",
			Self::Busy => "busy",
			Self::ThreadExpired => "thread_expired",
			Self::UnknownThread => "unknown_thread",
			Self::BadRequest => "bad_request",
			Self::Unauthorized => "unauthorized",
			Self::TooLarge => "too_large",
			Self::RateLimited => "rate_limited",
			Self::Unsupported => "unsupported",
			Self::Internal => "internal",
		}
	}

	pub fn parse(s: &str) -> Option<Self> {
		Self::ALL.into_iter().find(|code| code.as_str() == s)
	}
}

impl std::fmt::Display for MeshErrorCode {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.write_str(self.as_str())
	}
}

/// Answer to one envelope: `{ok: true, data}` or `{ok: false, code, message}`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MeshResponse {
	Ok(Value),
	/// `ok` with `data` given as pre-serialized JSON text (must be valid JSON),
	/// for payloads served repeatedly (the node's own snapshot) without
	/// re-serializing a [`Value`] per request.
	OkRaw(Arc<str>),
	Err {
		code:    MeshErrorCode,
		message: String,
	},
}

impl MeshResponse {
	pub fn error(code: MeshErrorCode, message: impl Into<String>) -> Self {
		Self::Err { code, message: message.into() }
	}
}

impl From<ProtocolError> for MeshResponse {
	fn from(err: ProtocolError) -> Self {
		Self::Err { code: err.code, message: err.message }
	}
}

impl Serialize for MeshResponse {
	fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
		match self {
			Self::Ok(data) => {
				let mut s = serializer.serialize_struct("MeshResponse", 2)?;
				s.serialize_field("ok", &true)?;
				s.serialize_field("data", data)?;
				s.end()
			},
			Self::OkRaw(json) => {
				let raw: &RawValue = serde_json::from_str(json).map_err(serde::ser::Error::custom)?;
				let mut s = serializer.serialize_struct("MeshResponse", 2)?;
				s.serialize_field("ok", &true)?;
				s.serialize_field("data", raw)?;
				s.end()
			},
			Self::Err { code, message } => {
				let mut s = serializer.serialize_struct("MeshResponse", 3)?;
				s.serialize_field("ok", &false)?;
				s.serialize_field("code", code)?;
				s.serialize_field("message", message)?;
				s.end()
			},
		}
	}
}

/// `ok` data of a `message` request: accepted for processing on `thread`
/// (minted by the recipient when the request named none).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MeshMessageResult {
	pub thread:   String,
	pub accepted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshSummary {
	pub text:       String,
	pub updated_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MeshRepo {
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub remote: Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub branch: Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub head:   Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshAgent {
	pub id:           String,
	pub kind:         String,
	pub display_name: String,
	pub status:       String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub task:         Option<String>,
}

/// What an instance publishes about itself (`ok` data of `snapshot`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshSnapshot {
	pub instance_id:  String,
	pub display_name: String,
	pub host:         String,
	pub pid:          u32,
	pub omp_version:  String,
	/// Always [`PROTOCOL_VERSION`].
	pub protocol:     u32,
	pub session_id:   Option<String>,
	pub session_name: Option<String>,
	pub summary:      Option<MeshSummary>,
	pub cwd:          String,
	pub repo:         Option<MeshRepo>,
	pub model:        Option<String>,
	pub busy:         bool,
	pub agents:       Vec<MeshAgent>,
	/// ms since the Unix epoch.
	pub started_at:   u64,
}

impl MeshSnapshot {
	fn validate(&self) -> Result<(), ProtocolError> {
		if self.protocol != PROTOCOL_VERSION {
			return Err(ProtocolError::new(
				MeshErrorCode::Unsupported,
				format!("unsupported mesh snapshot protocol {}", self.protocol),
			));
		}
		instance_id(&self.instance_id, "instanceId")?;
		capped(&self.display_name, "displayName")?;
		capped(&self.host, "host")?;
		capped(&self.omp_version, "ompVersion")?;
		opt_capped(self.session_id.as_deref(), "sessionId")?;
		opt_capped(self.session_name.as_deref(), "sessionName")?;
		if let Some(summary) = &self.summary {
			text_field(&summary.text, "summary.text")?;
		}
		capped(&self.cwd, "cwd")?;
		if let Some(repo) = &self.repo {
			opt_capped(repo.remote.as_deref(), "repo.remote")?;
			opt_capped(repo.branch.as_deref(), "repo.branch")?;
			opt_capped(repo.head.as_deref(), "repo.head")?;
		}
		opt_capped(self.model.as_deref(), "model")?;
		if self.agents.len() > MAX_AGENTS {
			return Err(ProtocolError::too_large(format!(
				"snapshot lists {} agents (max {MAX_AGENTS})",
				self.agents.len()
			)));
		}
		for agent in &self.agents {
			capped(&agent.id, "agents.id")?;
			capped(&agent.kind, "agents.kind")?;
			capped(&agent.display_name, "agents.displayName")?;
			capped(&agent.status, "agents.status")?;
			opt_capped(agent.task.as_deref(), "agents.task")?;
		}
		Ok(())
	}
}

/// Validate one inbound envelope.
///
/// # Errors
/// `too_large` for size caps, `unsupported` for a numeric `v` other than
/// [`PROTOCOL_VERSION`], `bad_request` for everything else (including a
/// missing `v`).
pub fn parse_envelope(bytes: &[u8]) -> Result<MeshEnvelope, ProtocolError> {
	let value = decode(bytes, "envelope")?;
	match value.get("v") {
		Some(Value::Number(v)) if v.as_u64() == Some(PROTOCOL_VERSION as u64) => {},
		Some(Value::Number(v)) => {
			return Err(ProtocolError::new(
				MeshErrorCode::Unsupported,
				format!("unsupported mesh protocol version {v}"),
			));
		},
		_ => return Err(ProtocolError::bad_request("mesh envelope lacks a numeric \"v\"")),
	}
	let envelope: MeshEnvelope = serde_json::from_value(value)
		.map_err(|e| ProtocolError::bad_request(format!("malformed mesh envelope: {e}")))?;
	envelope.validate()?;
	Ok(envelope)
}

/// Validate a peer response. Unknown error codes from newer peers degrade to
/// `internal`; `ok` data stays unvalidated [`Value`] for the per-op parser.
///
/// # Errors
/// `too_large` for size caps, `bad_request` for malformed responses.
pub fn parse_response(bytes: &[u8]) -> Result<MeshResponse, ProtocolError> {
	let value = decode(bytes, "response")?;
	let Value::Object(mut obj) = value else {
		return Err(ProtocolError::bad_request("mesh response must be an object"));
	};
	match obj.get("ok") {
		Some(Value::Bool(true)) => Ok(MeshResponse::Ok(obj.remove("data").unwrap_or(Value::Null))),
		Some(Value::Bool(false)) => {
			let Some(Value::String(code)) = obj.remove("code") else {
				return Err(ProtocolError::bad_request("mesh error response lacks \"code\""));
			};
			let Some(Value::String(message)) = obj.remove("message") else {
				return Err(ProtocolError::bad_request("mesh error response lacks \"message\""));
			};
			text_field(&message, "message")?;
			let code = MeshErrorCode::parse(&code).unwrap_or(MeshErrorCode::Internal);
			Ok(MeshResponse::Err { code, message })
		},
		_ => Err(ProtocolError::bad_request("mesh response lacks a boolean \"ok\"")),
	}
}

/// Validate a snapshot (`ok` data of `snapshot`, or one pushed by the
/// frontend) with field caps and at most [`MAX_AGENTS`] agents.
///
/// # Errors
/// `too_large` for caps, `unsupported` for another `protocol`, `bad_request`
/// otherwise.
pub fn parse_snapshot(value: &Value) -> Result<MeshSnapshot, ProtocolError> {
	let snapshot = MeshSnapshot::deserialize(value)
		.map_err(|e| ProtocolError::bad_request(format!("malformed mesh snapshot: {e}")))?;
	snapshot.validate()?;
	Ok(snapshot)
}

/// Validate the `ok` data of a `message` request.
///
/// # Errors
/// `bad_request` / `too_large` for a malformed result.
pub fn parse_message_result(value: &Value) -> Result<MeshMessageResult, ProtocolError> {
	let result = MeshMessageResult::deserialize(value)
		.map_err(|e| ProtocolError::bad_request(format!("malformed mesh message result: {e}")))?;
	field(&result.thread, "thread")?;
	Ok(result)
}

fn decode(bytes: &[u8], what: &str) -> Result<Value, ProtocolError> {
	if bytes.len() > MAX_ENVELOPE_BYTES {
		return Err(ProtocolError::too_large(format!(
			"mesh {what} of {} bytes exceeds {MAX_ENVELOPE_BYTES}",
			bytes.len()
		)));
	}
	let value: Value = serde_json::from_slice(bytes)
		.map_err(|e| ProtocolError::bad_request(format!("mesh {what} is not valid JSON: {e}")))?;
	if !value.is_object() {
		return Err(ProtocolError::bad_request(format!("mesh {what} must be an object")));
	}
	Ok(value)
}

/// `true` when `s` has at most `max` characters; counts only when the byte
/// length could exceed it.
fn within(s: &str, max: usize) -> bool {
	s.len() <= max || s.chars().count() <= max
}

/// Possibly empty string within [`MAX_FIELD_CHARS`].
fn capped(s: &str, name: &str) -> Result<(), ProtocolError> {
	if within(s, MAX_FIELD_CHARS) {
		Ok(())
	} else {
		Err(ProtocolError::too_large(format!("mesh {name} exceeds {MAX_FIELD_CHARS} characters")))
	}
}

fn opt_capped(s: Option<&str>, name: &str) -> Result<(), ProtocolError> {
	s.map_or(Ok(()), |s| capped(s, name))
}

/// Non-empty string within [`MAX_FIELD_CHARS`].
fn field(s: &str, name: &str) -> Result<(), ProtocolError> {
	if s.is_empty() {
		return Err(ProtocolError::bad_request(format!("mesh {name} is empty")));
	}
	capped(s, name)
}

fn opt_field(s: Option<&str>, name: &str) -> Result<(), ProtocolError> {
	s.map_or(Ok(()), |s| field(s, name))
}

fn text_field(s: &str, name: &str) -> Result<(), ProtocolError> {
	if within(s, MAX_TEXT_CHARS) {
		Ok(())
	} else {
		Err(ProtocolError::too_large(format!("mesh {name} exceeds {MAX_TEXT_CHARS} characters")))
	}
}

fn msg_id(s: &str, name: &str) -> Result<(), ProtocolError> {
	if is_msg_id(s) {
		Ok(())
	} else {
		Err(ProtocolError::bad_request(format!("mesh {name} must match [A-Za-z0-9_-]{{1,64}}")))
	}
}

fn instance_id(s: &str, name: &str) -> Result<(), ProtocolError> {
	if is_instance_id(s) {
		Ok(())
	} else {
		Err(ProtocolError::bad_request(format!("mesh {name} is not a valid instance id")))
	}
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::*;

	const A: &str = "aaaaaaaaaaaaaaaa";
	const B: &str = "0123456789abcdef";

	fn envelope(body: &Value) -> Value {
		json!({
			"v": 1,
			"msgId": "m1",
			"sentAt": 1_700_000_000_000_u64,
			"hop": 0,
			"from": { "instanceId": A, "agentId": "Main", "displayName": "alice", "host": "box" },
			"to": B,
			"body": body,
		})
	}

	fn parse(value: &Value) -> Result<MeshEnvelope, ProtocolError> {
		parse_envelope(&serde_json::to_vec(value).unwrap())
	}

	fn code(value: &Value) -> MeshErrorCode {
		parse(value).unwrap_err().code
	}

	/// `value` with the member at `path` set (array indices as decimal strings).
	fn with(mut value: Value, path: &[&str], v: Value) -> Value {
		let (last, parents) = path.split_last().unwrap();
		let mut cur = &mut value;
		for p in parents {
			cur = match cur {
				Value::Array(items) => &mut items[p.parse::<usize>().unwrap()],
				other => other.get_mut(*p).unwrap(),
			};
		}
		cur[*last] = v;
		value
	}

	#[test]
	fn accepts_every_op_and_round_trips() {
		for body in [
			json!({ "op": "snapshot" }),
			json!({ "op": "message", "kind": "ask", "text": "hi", "thread": "t1" }),
			json!({ "op": "reply", "replyTo": "m0", "text": "", "error": "boom" }),
			json!({ "op": "watch", "event": "turn_end", "ttlSec": MAX_WATCH_TTL_SEC }),
			json!({ "op": "watch_event", "watchId": "w", "event": "idle", "detail": "d" }),
			json!({ "op": "threads" }),
			json!({ "op": "thread", "thread": "t1" }),
		] {
			let value = envelope(&body);
			let env = parse(&value).unwrap_or_else(|e| panic!("{body}: {e}"));
			assert_eq!(serde_json::to_value(&env).unwrap(), value);
		}
	}

	#[test]
	fn drops_unknown_fields() {
		let value = with(envelope(&json!({ "op": "threads", "x": 1 })), &["extra"], json!(true));
		let value = with(value, &["from", "token"], json!("secret"));
		let env = parse(&value).unwrap();
		let back = serde_json::to_value(&env).unwrap();
		assert_eq!(back, envelope(&json!({ "op": "threads" })));
	}

	#[test]
	fn version_missing_vs_foreign() {
		let mut missing = envelope(&json!({ "op": "threads" }));
		missing.as_object_mut().unwrap().remove("v");
		assert_eq!(code(&missing), MeshErrorCode::BadRequest);
		let stringly = with(envelope(&json!({ "op": "threads" })), &["v"], json!("1"));
		assert_eq!(code(&stringly), MeshErrorCode::BadRequest);
		let foreign = with(envelope(&json!({ "op": "threads" })), &["v"], json!(2));
		assert_eq!(code(&foreign), MeshErrorCode::Unsupported);
	}

	#[test]
	fn byte_cap_is_independent_of_char_caps() {
		// 2-byte chars: under MAX_ENVELOPE_BYTES characters, over it in bytes.
		let pad = "\u{e9}".repeat(MAX_ENVELOPE_BYTES / 2 + 1);
		let value = with(envelope(&json!({ "op": "snapshot" })), &["pad"], json!(pad));
		assert_eq!(code(&value), MeshErrorCode::TooLarge);
	}

	#[test]
	fn rejects_garbage() {
		assert_eq!(parse_envelope(b"{").unwrap_err().code, MeshErrorCode::BadRequest);
		assert_eq!(parse_envelope(b"[1]").unwrap_err().code, MeshErrorCode::BadRequest);
		let unknown_op = envelope(&json!({ "op": "exec", "cmd": "rm" }));
		assert_eq!(code(&unknown_op), MeshErrorCode::BadRequest);
		let bad_kind = envelope(&json!({ "op": "message", "kind": "reply", "text": "x" }));
		assert_eq!(code(&bad_kind), MeshErrorCode::BadRequest);
		let negative = with(envelope(&json!({ "op": "threads" })), &["sentAt"], json!(-1));
		assert_eq!(code(&negative), MeshErrorCode::BadRequest);
	}

	#[test]
	fn wildcard_recipient_only_for_snapshot() {
		let snap = with(envelope(&json!({ "op": "snapshot" })), &["to"], json!(ANY_INSTANCE));
		assert_eq!(parse(&snap).unwrap().to, ANY_INSTANCE);
		let msg = with(
			envelope(&json!({ "op": "message", "kind": "note", "text": "x" })),
			&["to"],
			json!(ANY_INSTANCE),
		);
		assert_eq!(code(&msg), MeshErrorCode::BadRequest);
		let threads = with(envelope(&json!({ "op": "threads" })), &["to"], json!(ANY_INSTANCE));
		assert_eq!(code(&threads), MeshErrorCode::BadRequest);
	}

	#[test]
	fn instance_ids_follow_the_single_pattern() {
		assert!(is_instance_id("0123456789abcdef"));
		for bad in
			["", "aaaaaaaaaaaaaaa", "aaaaaaaaaaaaaaaaa", "AAAAAAAAAAAAAAAA", "aaaaaaaa-aaaaaaa"]
		{
			assert!(!is_instance_id(bad), "{bad}");
			let to = with(envelope(&json!({ "op": "threads" })), &["to"], json!(bad));
			assert_eq!(code(&to), MeshErrorCode::BadRequest, "to {bad}");
			let from =
				with(envelope(&json!({ "op": "threads" })), &["from", "instanceId"], json!(bad));
			assert_eq!(code(&from), MeshErrorCode::BadRequest, "from {bad}");
		}
	}

	#[test]
	fn hop_range_and_inbound_rule() {
		let at = |hop: u64| with(envelope(&json!({ "op": "threads" })), &["hop"], json!(hop));
		assert!(parse(&at(0)).unwrap().check_inbound_hop().is_ok());
		let relayed = parse(&at(1)).unwrap();
		assert_eq!(relayed.check_inbound_hop().unwrap_err().code, MeshErrorCode::Denied);
		assert!(parse(&at(u64::from(MAX_HOP))).is_ok());
		assert_eq!(code(&at(u64::from(MAX_HOP) + 1)), MeshErrorCode::BadRequest);
		assert_eq!(code(&at(u64::from(u32::MAX) + 1)), MeshErrorCode::BadRequest);
	}

	#[test]
	fn text_and_field_caps() {
		let msg = |text: String| envelope(&json!({ "op": "message", "kind": "ask", "text": text }));
		// Multi-byte at the cap: counted in characters, not bytes.
		assert!(parse(&msg("\u{e9}".repeat(MAX_TEXT_CHARS))).is_ok());
		assert_eq!(code(&msg("x".repeat(MAX_TEXT_CHARS + 1))), MeshErrorCode::TooLarge);
		assert_eq!(code(&msg(String::new())), MeshErrorCode::BadRequest);
		let detail = envelope(&json!({
			"op": "watch_event", "watchId": "w", "event": "idle", "detail": "x".repeat(MAX_TEXT_CHARS + 1),
		}));
		assert_eq!(code(&detail), MeshErrorCode::TooLarge);
		let name = |n: usize| {
			with(
				envelope(&json!({ "op": "threads" })),
				&["from", "displayName"],
				json!("\u{e9}".repeat(n)),
			)
		};
		assert!(parse(&name(MAX_FIELD_CHARS)).is_ok());
		assert_eq!(code(&name(MAX_FIELD_CHARS + 1)), MeshErrorCode::TooLarge);
		assert_eq!(code(&name(0)), MeshErrorCode::BadRequest);
	}

	#[test]
	fn msg_id_pattern() {
		let at = |id: &str| with(envelope(&json!({ "op": "threads" })), &["msgId"], json!(id));
		assert!(parse(&at(&"a".repeat(MAX_MSG_ID_LEN))).is_ok());
		assert!(parse(&at("A-z_09")).is_ok());
		for bad in [
			String::new(),
			"a".repeat(MAX_MSG_ID_LEN + 1),
			"a b".into(),
			"a/b".into(),
			"\u{e9}".into(),
		] {
			assert_eq!(code(&at(&bad)), MeshErrorCode::BadRequest, "{bad}");
		}
		let reply = envelope(&json!({ "op": "reply", "replyTo": "../x", "text": "t" }));
		assert_eq!(code(&reply), MeshErrorCode::BadRequest);
	}

	#[test]
	fn sender_lan_port() {
		let at =
			|port: Value| with(envelope(&json!({ "op": "threads" })), &["from", "lanPort"], port);
		let value = at(json!(4242));
		let env = parse(&value).unwrap();
		assert_eq!(env.from.lan_port, Some(4242));
		assert_eq!(serde_json::to_value(&env).unwrap(), value);
		assert_eq!(code(&at(json!(0))), MeshErrorCode::BadRequest);
		assert_eq!(code(&at(json!(65536))), MeshErrorCode::BadRequest);
	}

	#[test]
	fn watch_ttl_range() {
		let watch = |ttl: u32| envelope(&json!({ "op": "watch", "event": "idle", "ttlSec": ttl }));
		assert!(parse(&watch(1)).is_ok());
		assert_eq!(code(&watch(0)), MeshErrorCode::BadRequest);
		assert_eq!(code(&watch(MAX_WATCH_TTL_SEC + 1)), MeshErrorCode::BadRequest);
	}

	#[test]
	fn responses() {
		let ok = parse_response(br#"{"ok":true,"data":{"a":1}}"#).unwrap();
		assert_eq!(ok, MeshResponse::Ok(json!({ "a": 1 })));
		assert_eq!(serde_json::to_value(&ok).unwrap(), json!({ "ok": true, "data": { "a": 1 } }));
		assert_eq!(parse_response(br#"{"ok":true}"#).unwrap(), MeshResponse::Ok(Value::Null));
		let err = parse_response(br#"{"ok":false,"code":"busy","message":"later"}"#).unwrap();
		assert_eq!(err, MeshResponse::error(MeshErrorCode::Busy, "later"));
		assert_eq!(
			serde_json::to_value(&err).unwrap(),
			json!({ "ok": false, "code": "busy", "message": "later" })
		);
		let future = parse_response(br#"{"ok":false,"code":"quantum","message":"m"}"#).unwrap();
		assert_eq!(future, MeshResponse::error(MeshErrorCode::Internal, "m"));
		for bad in [
			&br#"{"ok":"yes"}"#[..],
			br#"{"ok":false,"message":"m"}"#,
			br#"{"ok":false,"code":"busy"}"#,
			b"null",
		] {
			assert_eq!(parse_response(bad).unwrap_err().code, MeshErrorCode::BadRequest);
		}
		let long = serde_json::to_vec(
			&json!({ "ok": false, "code": "busy", "message": "x".repeat(MAX_TEXT_CHARS + 1) }),
		)
		.unwrap();
		assert_eq!(parse_response(&long).unwrap_err().code, MeshErrorCode::TooLarge);
	}

	#[test]
	fn raw_ok_serializes_like_ok() {
		let raw = MeshResponse::OkRaw(r#"{"a":[1,"x"]}"#.into());
		let value = MeshResponse::Ok(json!({ "a": [1, "x"] }));
		assert_eq!(serde_json::to_value(&raw).unwrap(), serde_json::to_value(&value).unwrap());
		assert!(serde_json::to_vec(&MeshResponse::OkRaw("{".into())).is_err());
	}

	#[test]
	fn error_codes_round_trip_through_serde() {
		for code in MeshErrorCode::ALL {
			assert_eq!(serde_json::to_value(code).unwrap(), json!(code.as_str()));
			assert_eq!(MeshErrorCode::parse(code.as_str()), Some(code));
		}
	}

	fn snapshot() -> Value {
		json!({
			"instanceId": A, "displayName": "alice", "host": "box", "pid": 42,
			"ompVersion": "18.14.1", "protocol": 1, "sessionId": null, "sessionName": null,
			"summary": { "text": "working", "updatedAt": 1 }, "cwd": "/repo",
			"repo": { "branch": "main" }, "model": null, "busy": false,
			"agents": [{ "id": "Main", "kind": "main", "displayName": "Main", "status": "idle" }],
			"startedAt": 1,
		})
	}

	#[test]
	fn snapshot_round_trips() {
		let value = snapshot();
		let parsed = parse_snapshot(&value).unwrap();
		assert_eq!(serde_json::to_value(&parsed).unwrap(), value);
	}

	#[test]
	fn snapshot_caps() {
		let agent = json!({ "id": "a", "kind": "task", "displayName": "a", "status": "running" });
		let at =
			|path: &[&str], v: Value| parse_snapshot(&with(snapshot(), path, v)).map_err(|e| e.code);
		assert!(at(&["agents"], json!(vec![agent.clone(); MAX_AGENTS])).is_ok());
		assert_eq!(at(&["agents"], json!(vec![agent; MAX_AGENTS + 1])), Err(MeshErrorCode::TooLarge));
		assert_eq!(
			at(&["summary", "text"], json!("x".repeat(MAX_TEXT_CHARS + 1))),
			Err(MeshErrorCode::TooLarge)
		);
		assert_eq!(
			at(&["cwd"], json!("x".repeat(MAX_FIELD_CHARS + 1))),
			Err(MeshErrorCode::TooLarge)
		);
		assert_eq!(
			at(&["agents", "0", "task"], json!("x".repeat(MAX_FIELD_CHARS + 1))),
			Err(MeshErrorCode::TooLarge)
		);
		assert_eq!(at(&["protocol"], json!(2)), Err(MeshErrorCode::Unsupported));
		assert_eq!(at(&["instanceId"], json!("short")), Err(MeshErrorCode::BadRequest));
		assert_eq!(at(&["agents"], json!({})), Err(MeshErrorCode::BadRequest));
		assert_eq!(at(&["busy"], json!("no")), Err(MeshErrorCode::BadRequest));
	}

	#[test]
	fn message_result() {
		let ok = parse_message_result(&json!({ "thread": "t1", "accepted": true, "x": 1 })).unwrap();
		assert_eq!(ok, MeshMessageResult { thread: "t1".into(), accepted: true });
		let empty = parse_message_result(&json!({ "thread": "", "accepted": true }));
		assert_eq!(empty.unwrap_err().code, MeshErrorCode::BadRequest);
		let missing = parse_message_result(&json!({ "thread": "t1" }));
		assert_eq!(missing.unwrap_err().code, MeshErrorCode::BadRequest);
	}
}
