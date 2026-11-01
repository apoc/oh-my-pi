//! Same-machine instance registry: one owner-only directory, one long-lived
//! endpoint per [`InstanceHost`], multiplexed by namespace.
//!
//! - [`dir`]: the registry directory's owner-only checks. Callers always pass
//!   the directory (omp uses `<home>/<PI_CONFIG_DIR or .omp>/run/instances`);
//!   there is no built-in default.
//! - [`InstanceEntry`]: `<instanceId>.json`, format v1 `{v, instanceId, pid,
//!   nonce, endpoint, token, createdAt, capabilities}`, written atomically
//!   (0600 temp file + rename) and present for the whole lifetime of the host's
//!   listener.
//! - [`InstanceHost`]: binds its listener on the first
//!   [`InstanceHost::register`] and serves the registered namespaces
//!   ([`Handler`]) until [`InstanceHost::close`] /
//!   [`InstanceHost::withdraw_sync`].
//! - [`request`]: one request line, one response line, over a `pi-ipc` stream.
//! - [`list`] / [`list_alive`]: live entries by capability; dead, malformed and
//!   stale artifacts are pruned on the way.
//! - [`collab`]: the `collab` namespace (host handler, listing, link
//!   resolution).
//!
//! # Wire protocol
//!
//! Request line: `{"v":1,"token":"…","to":"<instanceId>","op":"<ns>.<op>",
//! "body":<JSON>}`. Response line: `{"v":1,"ok":true,"body":<JSON>}` or
//! `{"v":1,"ok":false,"error":"<code>"}`. The server checks, in order: line
//! size (`too_large`), JSON (`malformed_request`), `v`
//! (`unsupported_protocol`), token (`authentication_failed`), `to`
//! (`misdirected`), namespace (`unavailable`), the namespace's body cap
//! (`too_large`); then the handler answers (codes in [`RESERVED_CODES`]
//! become `internal`). Connections past [`MAX_CONNECTIONS`] are answered
//! `busy`.
//!
//! Only the same OS user can reach an endpoint (`pi-ipc` peer checks, 0700
//! directory, 0600 socket, current-user pipe DACL), so requests are not
//! sealed; the token proves the caller read the owner-only registry.

use std::{future::Future, pin::Pin, time::Duration};

mod client;
pub mod collab;
pub mod dir;
mod entry;
mod host;
mod list;
mod wire;

#[cfg(test)]
mod tests;

pub use self::{
	client::{InstanceError, request},
	dir::{DirError, assert_private_dir, ensure_private_dir},
	entry::{InstanceEntry, is_instance_id, is_namespace, now_ms, random_hex},
	host::{
		Handler, HandlerReply, HostError, InstanceHost, RESERVED_CODES, Registration, RequestCtx,
		with_deadline,
	},
	list::{ProbeRequest, list, list_alive, remove_entry_if},
};

/// Entry file and wire protocol version.
pub const VERSION: u32 = 1;
/// Longest request line a host reads (pre-authentication).
pub const MAX_REQUEST_LINE_BYTES: usize = 320 * 1024;
/// Concurrent connections per host, shared by every namespace; further
/// connections are answered `busy`.
pub const MAX_CONNECTIONS: usize = 64;
/// Deadline for a peer to deliver its request line.
pub const REQUEST_READ_TIMEOUT: Duration = Duration::from_secs(10);
/// Deadline for a peer to take the response line.
pub const RESPONSE_WRITE_TIMEOUT: Duration = Duration::from_secs(10);
/// Concurrent `*.json` probes while listing.
pub const LIST_CONCURRENCY: usize = 8;
/// Age after which an orphaned `*.tmp` entry write is swept.
pub const STALE_TMP_AGE: Duration = Duration::from_mins(1);

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;
