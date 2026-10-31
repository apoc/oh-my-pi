//! Error types of the key, protocol and frame layers.

use std::io;

use crate::protocol::MeshErrorCode;

/// A peer payload failed validation. `code` is what the receiver answers with
/// (or, client side, how a malformed response is classified).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{code}: {message}")]
pub struct ProtocolError {
	pub code:    MeshErrorCode,
	pub message: String,
}

impl ProtocolError {
	pub fn new(code: MeshErrorCode, message: impl Into<String>) -> Self {
		Self { code, message: message.into() }
	}

	pub fn bad_request(message: impl Into<String>) -> Self {
		Self::new(MeshErrorCode::BadRequest, message)
	}

	pub fn too_large(message: impl Into<String>) -> Self {
		Self::new(MeshErrorCode::TooLarge, message)
	}
}

/// Mesh passphrase or stored key rejected.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum KeyError {
	#[error("mesh passphrase must not be blank")]
	BlankPassphrase,
	#[error("mesh passphrase must be at least 12 characters")]
	WeakPassphrase,
	#[error("mesh key must be 32 bytes encoded as unpadded base64url")]
	MalformedKey,
}

/// Failure reading or writing one length-prefixed frame.
#[derive(Debug, thiserror::Error)]
pub enum FrameError {
	#[error("frame of {len} bytes exceeds the {max} byte limit")]
	TooLarge { len: usize, max: usize },
	#[error("connection closed mid-frame")]
	Truncated,
	#[error("timed out reading frame")]
	Timeout,
	#[error(transparent)]
	Io(#[from] io::Error),
}
