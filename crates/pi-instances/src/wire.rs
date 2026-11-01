//! Line framing shared by host and client: one `\n`-terminated JSON line each
//! way. Neither side relies on a half-close (named pipes have none): the
//! client reads exactly one response line after writing its request line.

use std::{io, time::Duration};

use serde::Serialize;
use serde_json::value::RawValue;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::VERSION;

const READ_CHUNK: usize = 16 * 1024;

pub(crate) enum LineError {
	/// No `\n` within the cap.
	TooLarge,
	Io(io::Error),
}

/// Read one line (without its `\n`) of at most `max` bytes. `Ok(None)` at
/// EOF before any byte; an unterminated tail at EOF is returned as the line.
/// Bytes after the `\n` are discarded.
pub(crate) async fn read_line<S: AsyncRead + Unpin>(
	stream: &mut S,
	max: usize,
) -> Result<Option<Vec<u8>>, LineError> {
	let mut buf = Vec::new();
	loop {
		let scanned = buf.len();
		buf.reserve(READ_CHUNK);
		let read = match stream.read_buf(&mut buf).await {
			Ok(read) => read,
			Err(error) if pi_ipc::is_orderly_eof(&error) => 0,
			Err(error) => return Err(LineError::Io(error)),
		};
		if let Some(at) = buf[scanned..].iter().position(|&b| b == b'\n') {
			let end = scanned + at;
			if end > max {
				return Err(LineError::TooLarge);
			}
			buf.truncate(end);
			return Ok(Some(buf));
		}
		if buf.len() > max {
			return Err(LineError::TooLarge);
		}
		if read == 0 {
			return Ok((!buf.is_empty()).then_some(buf));
		}
	}
}

/// Write `line` plus `\n` and flush.
pub(crate) async fn write_line<S: AsyncWrite + Unpin>(
	stream: &mut S,
	line: &[u8],
) -> io::Result<()> {
	stream.write_all(line).await?;
	stream.write_all(b"\n").await?;
	stream.flush().await
}

/// Answer an unserved connection with `line`, then read and discard the
/// peer's request up to its `\n` (bounded by `linger` and `max` bytes) before
/// closing: closing a socket with unread data can reset the connection before
/// the peer reads the answer.
pub(crate) async fn refuse<S: AsyncRead + AsyncWrite + Unpin>(
	mut stream: S,
	line: &[u8],
	linger: Duration,
	max: usize,
) {
	let _ = tokio::time::timeout(linger, async {
		if write_line(&mut stream, line).await.is_err() {
			return;
		}
		let mut scratch = [0u8; 4096];
		let mut drained = 0;
		while drained < max {
			match stream.read(&mut scratch).await {
				Ok(0) | Err(_) => break,
				Ok(n) if scratch[..n].contains(&b'\n') => break,
				Ok(n) => drained += n,
			}
		}
	})
	.await;
}

/// Raw JSON with every `\n` / `\r` replaced by a space. Valid JSON holds
/// those bytes only as insignificant whitespace (strings must escape them),
/// so the value is unchanged and fits on one line.
pub(crate) fn one_line(raw: &RawValue) -> std::borrow::Cow<'_, str> {
	let text = raw.get();
	if text.bytes().any(|b| b == b'\n' || b == b'\r') {
		text.replace(['\n', '\r'], " ").into()
	} else {
		text.into()
	}
}

/// `{"v":1,"ok":true,"body":<body>}`.
pub(crate) fn ok_line(body: &RawValue) -> Vec<u8> {
	let body = one_line(body);
	let mut out = Vec::with_capacity(body.len() + 32);
	out.extend_from_slice(br#"{"v":1,"ok":true,"body":"#);
	out.extend_from_slice(body.as_bytes());
	out.push(b'}');
	out
}

/// `{"v":1,"ok":false,"error":"<code>"}`.
pub(crate) fn error_line(code: &str) -> Vec<u8> {
	#[derive(Serialize)]
	struct ErrorLine<'a> {
		v:     u32,
		ok:    bool,
		error: &'a str,
	}
	serde_json::to_vec(&ErrorLine { v: VERSION, ok: false, error: code })
		.expect("error line serialization is infallible")
}
