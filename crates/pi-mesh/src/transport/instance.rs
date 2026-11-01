//! Same-machine transport: the `mesh` namespace of a
//! [`pi_instances::InstanceHost`].
//!
//! A local peer is an [`InstanceEntry`] in the owner-only instance registry.
//! One request per envelope: op `mesh.envelope`, body the envelope JSON; the
//! answer body is the [`MeshResponse`] JSON. `pi-instances` verifies the
//! server's identity before sending the entry's bearer token and checks the
//! token, the recipient and the body cap on the server side. Nothing is
//! sealed: only the same OS user can reach the endpoint.

use std::{borrow::Cow, sync::Arc, time::Duration};

use pi_instances::{Handler, HandlerReply, InstanceEntry, InstanceError, RequestCtx};
use serde_json::value::RawValue;

use super::{
	BUSY_TEXT, InboundSink, Origin, OriginKind, REJECTED_TEXT, TOO_LARGE_TEXT, TransportError,
	dispatch, encode_response,
};
use crate::protocol::{
	ANY_INSTANCE, MAX_ENVELOPE_BYTES, MeshErrorCode, MeshResponse, parse_envelope, parse_response,
};

/// Namespace the node registers on its instance host (its capability).
pub const NAMESPACE: &str = "mesh";
/// The namespace's one operation.
pub const ENVELOPE_OP: &str = "envelope";
const REQUEST_OP: &str = "mesh.envelope";
/// Response line cap: an envelope-sized body plus the response line wrapper.
pub const MAX_RESPONSE_LINE: usize = MAX_ENVELOPE_BYTES + 4 * 1024;

/// Serves `mesh.envelope`: envelope validation (caps, shape, recipient), then
/// the sink within [`super::HANDLER_TIMEOUT`] (in-band `internal` past it).
pub struct MeshNamespace {
	sink: Arc<dyn InboundSink>,
}

impl MeshNamespace {
	pub fn new(sink: Arc<dyn InboundSink>) -> Self {
		Self { sink }
	}
}

impl Handler for MeshNamespace {
	fn handle(
		&self,
		op: &str,
		body: &RawValue,
		ctx: RequestCtx,
	) -> pi_instances::BoxFuture<HandlerReply> {
		if op != ENVELOPE_OP {
			return Box::pin(std::future::ready(HandlerReply::Error(Cow::Borrowed(
				"invalid_operation",
			))));
		}
		let parsed = parse_envelope(body.get().as_bytes());
		let sink = Arc::clone(&self.sink);
		Box::pin(async move {
			let response = match parsed {
				Err(err) => MeshResponse::from(err),
				// `*` only reaches `snapshot` (envelope validation enforces it).
				Ok(env) if env.to != *ctx.instance_id && env.to != ANY_INSTANCE => MeshResponse::error(
					MeshErrorCode::BadRequest,
					"mesh envelope is addressed to another instance",
				),
				Ok(env) => dispatch(&*sink, env, Origin { kind: OriginKind::Local, addr: None }).await,
			};
			reply_body(&response)
		})
	}

	fn max_body_bytes(&self) -> usize {
		MAX_ENVELOPE_BYTES
	}
}

fn reply_body(response: &MeshResponse) -> HandlerReply {
	String::from_utf8(encode_response(response))
		.ok()
		.and_then(|json| RawValue::from_string(json).ok())
		.map_or(HandlerReply::Error(Cow::Borrowed("internal")), HandlerReply::Ok)
}

/// Deliver `envelope` (its serialized JSON) to the local peer `entry` and
/// wait for its response, all within `timeout`.
pub(super) async fn request(
	entry: &InstanceEntry,
	envelope: &RawValue,
	timeout: Duration,
) -> Result<MeshResponse, TransportError> {
	let result =
		pi_instances::request(entry, REQUEST_OP, envelope, timeout, MAX_RESPONSE_LINE).await;
	map_outcome(entry, result)
}

/// Mesh result of a `pi-instances` exchange: refusals that prove the peer is
/// there become in-band responses, the rest transport errors.
pub(super) fn map_outcome(
	entry: &InstanceEntry,
	result: Result<Box<RawValue>, InstanceError>,
) -> Result<MeshResponse, TransportError> {
	match result {
		Ok(body) => parse_response(body.get().as_bytes())
			.map_err(|e| TransportError::BadResponse(e.to_string())),
		Err(InstanceError::Remote(code)) => match code.as_str() {
			"authentication_failed" => {
				Ok(MeshResponse::error(MeshErrorCode::Unauthorized, REJECTED_TEXT))
			},
			"too_large" => Ok(MeshResponse::error(MeshErrorCode::TooLarge, TOO_LARGE_TEXT)),
			"busy" => Ok(MeshResponse::error(MeshErrorCode::Busy, BUSY_TEXT)),
			"unavailable" => {
				Err(TransportError::Unreachable(format!("{} does not serve the mesh", entry.endpoint)))
			},
			other => Err(TransportError::BadResponse(format!("mesh peer answered {other}"))),
		},
		Err(InstanceError::Misdirected) => Err(TransportError::Misdirected),
		Err(InstanceError::Unreachable { message, .. }) => {
			Err(TransportError::Unreachable(unreachable_text(entry, &message)))
		},
		Err(InstanceError::Timeout) => Err(TransportError::Timeout),
		Err(InstanceError::BadResponse(message)) => {
			Err(TransportError::BadResponse(format!("mesh peer {message}")))
		},
	}
}

/// The pre-`pi-instances` wording: `cannot connect to <endpoint>: <error>`
/// for a failed connect (`pi-ipc` says `connect <endpoint>: <error>`),
/// `mesh connection failed: <error>` for a connection lost mid-exchange.
fn unreachable_text(entry: &InstanceEntry, message: &str) -> String {
	if let Some(error) = message.strip_prefix("instance connection failed: ") {
		return format!("mesh connection failed: {error}");
	}
	let error = message
		.strip_prefix("connect ")
		.and_then(|rest| rest.strip_prefix(entry.endpoint.as_str()))
		.and_then(|rest| rest.strip_prefix(": "))
		.unwrap_or(message);
	format!("cannot connect to {}: {error}", entry.endpoint)
}
