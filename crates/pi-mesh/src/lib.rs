//! Engine for oh my pi mesh: instances of omp discovering and messaging each
//! other on one machine (loopback, bearer token) or across a LAN (shared key,
//! AES-256-GCM sealed).
//!
//! - [`keys`]: passphrase -> mesh key derivation, group tag, sealing, replay
//!   guard.
//! - [`protocol`]: wire types (serde = source of truth for the TypeScript
//!   mirror), validation and size caps.
//! - [`frame`]: length-prefixed frame codec shared by both transports.
//! - [`transport`]: loopback (token) and LAN (sealed) request/response
//!   listeners and client.
//! - [`registry`]: owner-only same-machine registry of loopback listeners.
//! - [`net`]: interfaces, same-machine detection, reverse DNS cache.
//! - [`discovery`]: mDNS DNS-SD announce/browse of LAN peers.
//! - [`node`]: the orchestrator the N-API binding wraps (configure, peer table,
//!   inbound admission, request routing).

pub mod discovery;
pub mod error;
pub mod frame;
pub mod keys;
pub mod net;
pub mod node;
pub mod protocol;
pub mod registry;
pub mod transport;
#[cfg(windows)]
mod winsec;

pub use error::{FrameError, KeyError, ProtocolError};
