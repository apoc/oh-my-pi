//! The sealed request/response protocol of the LAN transport.
//!
//! Request frame: `[u16 BE header length][header][seal(envelope JSON,
//! AAD_req)]` where `header` is the JSON array `[v, msgId, sentAt, from, to]`
//! (plaintext routing info) and `AAD_req = "omp-mesh/v1 request\n" ‖ header
//! bytes as sent`. After decryption the envelope must repeat the header's
//! values.
//!
//! Response frame: `[STATUS_OK][seal(MeshResponse JSON, AAD_resp)]` with
//! `AAD_resp = "omp-mesh/v1 response\n" ‖ JSON [v, msgId, to]` — bound to the
//! request's msgId and the recipient exactly as the sender addressed it (`*`
//! included), so a response cannot be replayed onto another request or be
//! swapped between peers.
//!
//! Server order: frame cap + read deadline, header shape, recipient
//! ([`STATUS_MISDIRECTED`]), decrypt ([`STATUS_REJECTED`] on failure, no
//! further detail). Only then are failures answered with sealed responses:
//! envelope validation, header mismatch, and the replay guard keyed by
//! sender + msgId (`unauthorized`).

use std::{net::SocketAddr, sync::Arc};

use parking_lot::Mutex;
use pi_instances::now_ms;

use super::{
	Conn, InboundSink, Origin, OriginKind, REQUEST_READ_TIMEOUT, STATUS_MISDIRECTED, STATUS_OK,
	STATUS_REJECTED, STATUS_TOO_LARGE, TransportError, dispatch, encode_response, exchange, reply,
};
use crate::{
	error::FrameError,
	frame::{MAX_FRAME_BYTES, read_frame_timeout},
	keys::{MeshKeys, ReplayGuard, ReplayVerdict, SEAL_OVERHEAD, SealKey},
	protocol::{
		ANY_INSTANCE, MAX_ENVELOPE_BYTES, MeshEnvelope, MeshErrorCode, MeshResponse,
		PROTOCOL_VERSION, parse_envelope, parse_response,
	},
};

const REQUEST_AAD_PREFIX: &[u8] = b"omp-mesh/v1 request\n";
const RESPONSE_AAD_PREFIX: &[u8] = b"omp-mesh/v1 response\n";
pub(super) const MAX_RESPONSE_FRAME: usize = 1 + MAX_ENVELOPE_BYTES + SEAL_OVERHEAD;

/// Plaintext routing header: `[v, msgId, sentAt, from, to]`.
type Header = (u32, String, u64, String, String);

/// Per-listener state.
pub(super) struct Server {
	pub instance_id: String,
	pub keys:        Arc<MeshKeys>,
	pub guard:       Arc<Mutex<ReplayGuard>>,
	pub sink:        Arc<dyn InboundSink>,
}

fn request_aad(header: &[u8]) -> Vec<u8> {
	[REQUEST_AAD_PREFIX, header].concat()
}

fn response_aad(msg_id: &str, to: &str) -> Vec<u8> {
	let tail = serde_json::to_vec(&(PROTOCOL_VERSION, msg_id, to)).unwrap_or_default();
	[RESPONSE_AAD_PREFIX, &tail].concat()
}

/// `to` names this instance, or is `*` (only valid for `snapshot`, which
/// envelope validation enforces after decryption).
fn addressed_to_us(to: &str, instance_id: &str) -> bool {
	to == instance_id || to == ANY_INSTANCE
}

pub(super) async fn serve<S: Conn>(mut stream: S, peer: SocketAddr, server: Arc<Server>) {
	let mut frame =
		match read_frame_timeout(&mut stream, MAX_FRAME_BYTES, REQUEST_READ_TIMEOUT).await {
			Ok(Some(frame)) => frame,
			Err(FrameError::TooLarge { .. }) => {
				return reply(&mut stream, &[STATUS_TOO_LARGE]).await;
			},
			Ok(None) | Err(_) => return,
		};
	let Some((len, rest)) = frame.split_first_chunk_mut::<2>() else {
		return reply(&mut stream, &[STATUS_REJECTED]).await;
	};
	let header_len = u16::from_be_bytes(*len) as usize;
	if rest.len() < header_len {
		return reply(&mut stream, &[STATUS_REJECTED]).await;
	}
	let (raw_header, sealed) = rest.split_at_mut(header_len);
	let Ok((v, msg_id, sent_at, from, to)) = serde_json::from_slice::<Header>(raw_header) else {
		return reply(&mut stream, &[STATUS_REJECTED]).await;
	};
	if v != PROTOCOL_VERSION {
		return reply(&mut stream, &[STATUS_REJECTED]).await;
	}
	if !addressed_to_us(&to, &server.instance_id) {
		return reply(&mut stream, &[STATUS_MISDIRECTED]).await;
	}
	let key = server.keys.seal_key();
	let Some(plain) = key.open_in_place(sealed, &request_aad(raw_header)) else {
		return reply(&mut stream, &[STATUS_REJECTED]).await;
	};
	let response = match parse_envelope(plain) {
		Err(err) => MeshResponse::from(err),
		Ok(env)
			if env.msg_id != msg_id
				|| env.sent_at != sent_at
				|| env.from.instance_id != from
				|| env.to != to =>
		{
			MeshResponse::error(MeshErrorCode::BadRequest, "mesh envelope does not match its header")
		},
		Ok(env) => {
			let verdict = server.guard.lock().check(&from, &msg_id, sent_at, now_ms());
			match verdict {
				ReplayVerdict::Stale => MeshResponse::error(
					MeshErrorCode::Unauthorized,
					"mesh message is outside the clock-skew window",
				),
				ReplayVerdict::Replay => {
					MeshResponse::error(MeshErrorCode::Unauthorized, "replayed mesh message")
				},
				ReplayVerdict::Ok => {
					let origin = Origin { kind: OriginKind::Remote, addr: Some(peer) };
					dispatch(&*server.sink, env, origin).await
				},
			}
		},
	};
	drop(frame);
	let json = encode_response(&response);
	let mut out = Vec::with_capacity(1 + SEAL_OVERHEAD + json.len());
	out.push(STATUS_OK);
	key.seal_into(&mut out, &json, &response_aad(&msg_id, &to));
	reply(&mut stream, &out).await;
}

/// Build the request frame payload for `envelope` (serialized as
/// `envelope_json`).
pub(super) fn encode_request(
	key: &SealKey,
	envelope: &MeshEnvelope,
	envelope_json: &[u8],
) -> Result<Vec<u8>, TransportError> {
	let header = serde_json::to_vec(&(
		PROTOCOL_VERSION,
		&envelope.msg_id,
		envelope.sent_at,
		&envelope.from.instance_id,
		&envelope.to,
	))
	.map_err(|e| TransportError::BadResponse(format!("cannot encode header: {e}")))?;
	let header_len = u16::try_from(header.len())
		.map_err(|_| TransportError::BadResponse("mesh header too long".into()))?;
	let mut frame = Vec::with_capacity(2 + header.len() + SEAL_OVERHEAD + envelope_json.len());
	frame.extend_from_slice(&header_len.to_be_bytes());
	frame.extend_from_slice(&header);
	key.seal_into(&mut frame, envelope_json, &request_aad(&header));
	Ok(frame)
}

/// Authenticate and decode a [`STATUS_OK`] response frame (status byte
/// first) for the request `envelope`; decrypts in place.
pub(super) fn decode_response(
	key: &SealKey,
	envelope: &MeshEnvelope,
	frame: &mut [u8],
) -> Result<MeshResponse, TransportError> {
	let body = frame.get_mut(1..).unwrap_or_default();
	let plain = key
		.open_in_place(body, &response_aad(&envelope.msg_id, &envelope.to))
		.ok_or_else(|| TransportError::BadResponse("mesh response failed authentication".into()))?;
	parse_response(plain).map_err(|e| TransportError::BadResponse(e.to_string()))
}

/// Send `envelope` over a freshly connected `stream` and authenticate the
/// answer.
pub(super) async fn request<S: Conn>(
	mut stream: S,
	key: &SealKey,
	envelope: &MeshEnvelope,
	envelope_json: &[u8],
) -> Result<MeshResponse, TransportError> {
	let frame = encode_request(key, envelope, envelope_json)?;
	match exchange(&mut stream, &frame, MAX_RESPONSE_FRAME).await? {
		Ok(mut response) => decode_response(key, envelope, &mut response),
		Err(response) => Ok(response),
	}
}
