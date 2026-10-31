//! Length-prefixed frames shared by the local and LAN transports:
//! `[u32 big-endian payload length][payload]`.
//!
//! The declared length is checked against the caller's cap before anything
//! is allocated, so a peer cannot make the reader buffer more than `max`.

use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::{error::FrameError, keys::SEAL_OVERHEAD, protocol::MAX_ENVELOPE_BYTES};

/// Default frame cap: one envelope plus room for transport headers and the
/// seal overhead.
pub const MAX_FRAME_BYTES: usize = MAX_ENVELOPE_BYTES + 16 * 1024 + SEAL_OVERHEAD;

const HEADER_BYTES: usize = 4;

/// Write one frame and flush.
///
/// # Errors
/// [`FrameError::TooLarge`] (nothing written) when `payload` exceeds `max`;
/// [`FrameError::Io`] on write failure.
pub async fn write_frame<W>(writer: &mut W, payload: &[u8], max: usize) -> Result<(), FrameError>
where
	W: AsyncWrite + Unpin + ?Sized,
{
	let len = u32::try_from(payload.len())
		.ok()
		.filter(|&len| len as usize <= max)
		.ok_or(FrameError::TooLarge { len: payload.len(), max })?;
	writer.write_all(&len.to_be_bytes()).await?;
	writer.write_all(payload).await?;
	writer.flush().await?;
	Ok(())
}

/// Read one frame. `Ok(None)` on a clean end of stream before the first header
/// byte.
///
/// # Errors
/// [`FrameError::TooLarge`] when the declared length exceeds `max` (the
/// payload is not read; drop the connection), [`FrameError::Truncated`] when
/// the stream ends mid-frame, [`FrameError::Io`] otherwise.
pub async fn read_frame<R>(reader: &mut R, max: usize) -> Result<Option<Vec<u8>>, FrameError>
where
	R: AsyncRead + Unpin + ?Sized,
{
	let mut header = [0u8; HEADER_BYTES];
	let mut filled = 0;
	while filled < HEADER_BYTES {
		match reader.read(&mut header[filled..]).await? {
			0 if filled == 0 => return Ok(None),
			0 => return Err(FrameError::Truncated),
			n => filled += n,
		}
	}
	let len = u32::from_be_bytes(header) as usize;
	if len > max {
		return Err(FrameError::TooLarge { len, max });
	}
	let mut payload = vec![0u8; len];
	reader.read_exact(&mut payload).await.map_err(|e| {
		if e.kind() == std::io::ErrorKind::UnexpectedEof {
			FrameError::Truncated
		} else {
			FrameError::Io(e)
		}
	})?;
	Ok(Some(payload))
}

/// [`read_frame`] bounded by one deadline for the whole frame (header and
/// payload), so a peer trickling bytes cannot hold the connection open.
///
/// # Errors
/// [`FrameError::Timeout`] when the deadline passes, else as [`read_frame`].
pub async fn read_frame_timeout<R>(
	reader: &mut R,
	max: usize,
	timeout: Duration,
) -> Result<Option<Vec<u8>>, FrameError>
where
	R: AsyncRead + Unpin + ?Sized,
{
	tokio::time::timeout(timeout, read_frame(reader, max))
		.await
		.map_err(|_| FrameError::Timeout)?
}

#[cfg(test)]
mod tests {
	use std::{
		pin::Pin,
		task::{Context, Poll},
	};

	use tokio::io::ReadBuf;

	use super::*;

	/// Yields at most one byte per read, then EOF.
	struct Trickle {
		data: Vec<u8>,
		pos:  usize,
	}

	impl AsyncRead for Trickle {
		fn poll_read(
			mut self: Pin<&mut Self>,
			_cx: &mut Context<'_>,
			buf: &mut ReadBuf<'_>,
		) -> Poll<std::io::Result<()>> {
			if self.pos < self.data.len() && buf.remaining() > 0 {
				buf.put_slice(&[self.data[self.pos]]);
				self.pos += 1;
			}
			Poll::Ready(Ok(()))
		}
	}

	fn trickle(data: Vec<u8>) -> Trickle {
		Trickle { data, pos: 0 }
	}

	async fn encode(payloads: &[&[u8]]) -> Vec<u8> {
		let mut out = Vec::new();
		for p in payloads {
			write_frame(&mut out, p, MAX_FRAME_BYTES).await.unwrap();
		}
		out
	}

	#[tokio::test]
	async fn reassembles_frames_from_one_byte_reads() {
		let mut r = trickle(encode(&[b"hello", b"", b"world"]).await);
		assert_eq!(read_frame(&mut r, 16).await.unwrap().as_deref(), Some(&b"hello"[..]));
		assert_eq!(read_frame(&mut r, 16).await.unwrap().as_deref(), Some(&b""[..]));
		assert_eq!(read_frame(&mut r, 16).await.unwrap().as_deref(), Some(&b"world"[..]));
		assert!(read_frame(&mut r, 16).await.unwrap().is_none());
	}

	#[tokio::test]
	async fn rejects_oversize_before_reading_payload() {
		let bytes = encode(&[b"12345"]).await;
		let mut r = trickle(bytes);
		let err = read_frame(&mut r, 4).await.unwrap_err();
		assert!(matches!(err, FrameError::TooLarge { len: 5, max: 4 }), "{err}");
		assert_eq!(r.pos, HEADER_BYTES);
		// A header claiming 4 GiB is refused without allocating it.
		let mut huge = trickle(u32::MAX.to_be_bytes().to_vec());
		let err = read_frame(&mut huge, MAX_FRAME_BYTES).await.unwrap_err();
		assert!(matches!(err, FrameError::TooLarge { .. }), "{err}");
	}

	#[tokio::test]
	async fn write_refuses_oversize_without_writing() {
		let mut out = Vec::new();
		let err = write_frame(&mut out, b"12345", 4).await.unwrap_err();
		assert!(matches!(err, FrameError::TooLarge { len: 5, max: 4 }), "{err}");
		assert!(out.is_empty());
	}

	#[tokio::test]
	async fn truncation_mid_header_and_mid_payload() {
		let full = encode(&[b"hello"]).await;
		for cut in [1, HEADER_BYTES + 2] {
			let mut r = trickle(full[..cut].to_vec());
			let err = read_frame(&mut r, 16).await.unwrap_err();
			assert!(matches!(err, FrameError::Truncated), "cut {cut}: {err}");
		}
	}

	#[tokio::test]
	async fn times_out_on_stalled_peer() {
		let (mut client, mut server) = tokio::io::duplex(64);
		// Header announces 5 bytes; only 2 ever arrive.
		client.write_all(&5u32.to_be_bytes()).await.unwrap();
		client.write_all(b"he").await.unwrap();
		let err = read_frame_timeout(&mut server, 16, Duration::from_millis(50))
			.await
			.unwrap_err();
		assert!(matches!(err, FrameError::Timeout), "{err}");
		drop(client);
	}
}
