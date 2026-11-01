//! Engine for oh my pi mesh: instances of omp discovering and messaging each
//! other on one machine (instance registry, bearer token) or across a LAN
//! (shared key, AES-256-GCM sealed).
//!
//! - [`keys`]: passphrase -> mesh key derivation, group tag, sealing, replay
//!   guard.
//! - [`protocol`]: wire types (serde = source of truth for the TypeScript
//!   mirror), validation and size caps.
//! - [`frame`]: length-prefixed frame codec of the LAN transport.
//! - [`transport`]: the `mesh` namespace of a `pi_instances::InstanceHost`
//!   (same machine) and the sealed LAN listener, plus the client for both.
//! - [`net`]: interfaces, same-machine detection, reverse DNS cache.
//! - [`discovery`]: mDNS DNS-SD announce/browse of LAN peers.
//! - [`node`]: the orchestrator the N-API binding wraps (configure, peer table,
//!   inbound admission, request routing).
//!
//! Same-machine discovery, endpoints and their access checks live in
//! `pi_instances` (registry) and `pi_ipc` (transport).

pub mod discovery;
pub mod error;
pub mod frame;
pub mod keys;
pub mod net;
pub mod node;
pub mod protocol;
pub mod transport;

pub use error::{FrameError, KeyError, ProtocolError};
