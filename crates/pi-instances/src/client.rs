//! Client side: one request line, one response line.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

use crate::{
	entry::InstanceEntry,
	wire::{LineError, one_line, read_line, write_line},
};

/// Why a request produced no response body.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum InstanceError {
	/// Connecting failed, or the connection broke mid-exchange. `code` is the
	/// errno-style code (`ENOENT`, `ECONNREFUSED`, `EMFILE`, …); only
	/// `ENOENT` / `ECONNREFUSED` while connecting prove the endpoint dead.
	#[error("instance unreachable: {message}")]
	Unreachable { code: &'static str, message: String },
	/// The endpoint serves another instance: the host answered `misdirected`,
	/// the server runs as another user, or (Windows) the pipe's server
	/// process is not the entry's `pid`.
	#[error("instance endpoint serves another instance")]
	Misdirected,
	/// The host answered `{"ok":false,"error":<code>}` (other than
	/// `misdirected`).
	#[error("instance answered {0}")]
	Remote(String),
	/// The deadline covering connect and exchange passed.
	#[error("instance request timed out")]
	Timeout,
	/// Closed without an answer, an answer over the response cap, or not a
	/// valid response line.
	#[error("bad instance response: {0}")]
	BadResponse(String),
}

impl InstanceError {
	/// Errno-style code of an [`InstanceError::Unreachable`].
	pub const fn io_code(&self) -> Option<&'static str> {
		match self {
			Self::Unreachable { code, .. } => Some(code),
			_ => None,
		}
	}
}

/// Why connecting to an entry's endpoint failed.
pub(crate) enum ConnectFailure {
	/// Every pipe instance stayed busy (Windows): the endpoint is alive.
	Busy,
	/// The endpoint is served by another user, or (Windows) by a process
	/// other than the entry's `pid`: never this instance.
	WrongServer,
	Io(pi_ipc::IpcError),
}

impl From<ConnectFailure> for InstanceError {
	fn from(failure: ConnectFailure) -> Self {
		match failure {
			ConnectFailure::Busy => Self::Timeout,
			ConnectFailure::WrongServer => Self::Misdirected,
			ConnectFailure::Io(error) => {
				Self::Unreachable { code: error.code(), message: error.into_message() }
			},
		}
	}
}

/// Dial `entry`'s endpoint and verify its server before any token is sent.
///
/// The boundary is the server's identity: `pi-ipc` checks that it runs as
/// our user (uid on Unix, token user on Windows), and on Windows the pipe's
/// server process must also be `entry.pid` (pipe names are visible to every
/// process, so a crashed instance's name could be re-created). Unix relies
/// on the uid check plus the 0700 directory and 0600 socket (pids are not
/// comparable across PID namespaces). The random nonce in the endpoint name
/// only keeps others from squatting the name before it is bound; once bound,
/// the name is public. `busy_wait` bounds Windows `ERROR_PIPE_BUSY` retries.
pub(crate) async fn connect(
	entry: &InstanceEntry,
	busy_wait: Duration,
) -> Result<pi_ipc::Stream, ConnectFailure> {
	let stream = match pi_ipc::connect(&entry.endpoint, busy_wait).await {
		Ok(stream) => stream,
		Err(error) if error.is_foreign_peer() => return Err(ConnectFailure::WrongServer),
		Err(error) if cfg!(windows) && error.code() == "ETIMEDOUT" => {
			return Err(ConnectFailure::Busy);
		},
		Err(error) => return Err(ConnectFailure::Io(error)),
	};
	#[cfg(windows)]
	match stream.server_pid() {
		Ok(pid) if pid == entry.pid => {},
		Ok(_) => return Err(ConnectFailure::WrongServer),
		Err(error) => {
			return Err(ConnectFailure::Io(pi_ipc::IpcError::io(&error, "query pipe server process")));
		},
	}
	Ok(stream)
}

#[derive(Serialize)]
struct RequestHead<'a> {
	v:     u32,
	token: &'a str,
	to:    &'a str,
	op:    &'a str,
}

#[derive(Deserialize)]
struct ResponseLine<'a> {
	v:     u32,
	ok:    bool,
	/// Present (even `null`) or absent.
	#[serde(borrow, default, deserialize_with = "present")]
	body:  Option<&'a RawValue>,
	#[serde(default)]
	error: Option<String>,
}

fn present<'de, D: serde::Deserializer<'de>>(de: D) -> Result<Option<&'de RawValue>, D::Error> {
	<&RawValue>::deserialize(de).map(Some)
}

/// Send `op` (`<ns>.<op>`) with `body` to `entry` and return the response
/// body. `timeout` covers connecting and the whole exchange; a response line
/// over `max_response` bytes is a [`InstanceError::BadResponse`].
pub async fn request(
	entry: &InstanceEntry,
	op: &str,
	body: &RawValue,
	timeout: Duration,
	max_response: usize,
) -> Result<Box<RawValue>, InstanceError> {
	tokio::time::timeout(timeout, async {
		let mut stream = connect(entry, timeout).await?;
		exchange(&mut stream, entry, op, body, max_response).await
	})
	.await
	.unwrap_or(Err(InstanceError::Timeout))
}

pub(crate) async fn exchange(
	stream: &mut pi_ipc::Stream,
	entry: &InstanceEntry,
	op: &str,
	body: &RawValue,
	max_response: usize,
) -> Result<Box<RawValue>, InstanceError> {
	let mut line = serde_json::to_vec(&RequestHead {
		v: crate::VERSION,
		token: &entry.token,
		to: &entry.instance_id,
		op,
	})
	.expect("request head serialization is infallible");
	// `{…}` + `,"body":<body>}`.
	line.pop();
	line.extend_from_slice(br#","body":"#);
	line.extend_from_slice(one_line(body).as_bytes());
	line.push(b'}');
	let lost = |error: std::io::Error| InstanceError::Unreachable {
		code:    pi_ipc::io_error_code(&error),
		message: format!("instance connection failed: {error}"),
	};
	write_line(stream, &line).await.map_err(lost)?;
	let response = match read_line(stream, max_response).await {
		Ok(Some(line)) => line,
		Ok(None) => return Err(InstanceError::BadResponse("closed without answering".into())),
		Err(LineError::TooLarge) => {
			return Err(InstanceError::BadResponse(format!("response exceeds {max_response} bytes")));
		},
		Err(LineError::Io(error)) => return Err(lost(error)),
	};
	let parsed = serde_json::from_slice::<ResponseLine<'_>>(&response)
		.map_err(|error| InstanceError::BadResponse(error.to_string()))?;
	if parsed.v != crate::VERSION {
		return Err(InstanceError::BadResponse(format!("unsupported response version {}", parsed.v)));
	}
	match (parsed.ok, parsed.body, parsed.error) {
		(true, Some(body), _) => Ok(body.to_owned()),
		(false, _, Some(code)) if code == "misdirected" => Err(InstanceError::Misdirected),
		(false, _, Some(code)) => Err(InstanceError::Remote(code)),
		_ => Err(InstanceError::BadResponse("response lacks body or error".into())),
	}
}
