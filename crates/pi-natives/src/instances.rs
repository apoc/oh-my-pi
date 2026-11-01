//! N-API `InstanceHost` (`pi_instances`): a same-machine instance, i.e. one
//! long-lived endpoint and one entry in the owner-only instance registry,
//! shared by every namespace served on it.
//!
//! The registry directory is always passed in: no native default.

use std::{path::Path, sync::Arc};

use napi::{Env, Error, Result, Status, bindgen_prelude::*};
use napi_derive::napi;
use parking_lot::Mutex;

use crate::task;

/// The process-wide host behind `InstanceHost.shared`.
static SHARED: Mutex<Option<Arc<pi_instances::InstanceHost>>> = Mutex::new(None);

#[napi(object)]
pub struct InstanceHostOptions {
	/// Registry directory (created owner-only on the first registration).
	pub dir:         String,
	/// 16 lowercase ASCII letters or digits; random when omitted.
	pub instance_id: Option<String>,
}

fn invalid_arg(err: impl std::fmt::Display) -> Error {
	Error::new(Status::InvalidArg, err.to_string())
}

/// A same-machine instance.
///
/// Nothing is bound or written until a namespace registers (e.g. a
/// `MeshNode` with a local side); the entry then lives until `close()` /
/// `withdrawSync()`. A closed host is terminal: later registrations fail.
#[napi]
pub struct InstanceHost {
	inner: Arc<pi_instances::InstanceHost>,
}

impl InstanceHost {
	pub(crate) const fn inner(&self) -> &Arc<pi_instances::InstanceHost> {
		&self.inner
	}
}

#[napi]
impl InstanceHost {
	/// A host publishing into `opts.dir`.
	#[napi(constructor)]
	pub fn new(opts: InstanceHostOptions) -> Result<Self> {
		let inner =
			pi_instances::InstanceHost::new(opts.dir, opts.instance_id).map_err(invalid_arg)?;
		Ok(Self { inner: Arc::new(inner) })
	}

	/// This process's host in `dir`, created with a random id on the first
	/// call. Throws when a later call names a different directory.
	#[napi(factory)]
	pub fn shared(dir: String) -> Result<Self> {
		let mut shared = SHARED.lock();
		if let Some(host) = &*shared {
			if host.dir() != Path::new(&dir) {
				return Err(invalid_arg(format!(
					"the shared instance host already uses {}",
					host.dir().display()
				)));
			}
			return Ok(Self { inner: Arc::clone(host) });
		}
		let host = Arc::new(pi_instances::InstanceHost::new(dir, None).map_err(invalid_arg)?);
		*shared = Some(Arc::clone(&host));
		Ok(Self { inner: host })
	}

	#[napi(getter)]
	pub fn instance_id(&self) -> String {
		self.inner.instance_id().to_owned()
	}

	/// Registry directory.
	#[napi(getter)]
	pub fn dir(&self) -> String {
		self.inner.dir().to_string_lossy().into_owned()
	}

	/// Withdraw the entry, stop the listener and remove the endpoint.
	/// Idempotent.
	#[napi(ts_return_type = "Promise<void>")]
	pub fn close<'env>(&self, env: &'env Env) -> Result<PromiseRaw<'env, ()>> {
		let inner = Arc::clone(&self.inner);
		task::future(env, "instance_host_close", async move {
			inner.close().await;
			Ok(())
		})
	}

	/// `close()` for exit handlers: removes the entry, the socket and its
	/// bind lock synchronously and leaves the host closed.
	#[napi]
	pub fn withdraw_sync(&self) {
		self.inner.withdraw_sync();
	}
}
