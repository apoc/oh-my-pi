//! Contract tests over real endpoints in temp directories.

mod collab;
mod host;
mod list;

use std::{
	path::{Path, PathBuf},
	sync::{
		Arc,
		atomic::{AtomicUsize, Ordering},
	},
	time::Duration,
};

use serde_json::{Value, json, value::RawValue};

use crate::{
	BoxFuture, Handler, HandlerReply, InstanceEntry, RequestCtx,
	entry::{endpoint_for, random_hex},
	wire::{read_line, write_line},
};

pub(super) const A: &str = "aaaaaaaaaaaaaaaa";
pub(super) const B: &str = "bbbbbbbbbbbbbbbb";
pub(super) const C: &str = "cccccccccccccccc";
pub(super) const D: &str = "dddddddddddddddd";
pub(super) const E: &str = "eeeeeeeeeeeeeeee";
pub(super) const TIMEOUT: Duration = Duration::from_secs(5);
pub(super) const MAX_RESPONSE: usize = 64 * 1024;
/// A pid no live process has.
pub(super) const DEAD_PID: u32 = 0x7fff_fff0;

pub(super) fn raw(json: &Value) -> Box<RawValue> {
	serde_json::value::to_raw_value(json).unwrap()
}

/// Answers `{"op", "body", "to"}` and counts its calls.
pub(super) struct Echo {
	pub calls: AtomicUsize,
	max_body:  usize,
}

impl Echo {
	pub fn new() -> Arc<Self> {
		Self::with_max_body(64 * 1024)
	}

	pub fn with_max_body(max_body: usize) -> Arc<Self> {
		Arc::new(Self { calls: AtomicUsize::new(0), max_body })
	}

	pub fn calls(&self) -> usize {
		self.calls.load(Ordering::SeqCst)
	}
}

impl Handler for Echo {
	fn handle(&self, op: &str, body: &RawValue, ctx: RequestCtx) -> BoxFuture<HandlerReply> {
		self.calls.fetch_add(1, Ordering::SeqCst);
		let body: Value = serde_json::from_str(body.get()).unwrap();
		let reply = raw(&json!({ "op": op, "body": body, "to": &*ctx.instance_id }));
		Box::pin(async move { HandlerReply::Ok(reply) })
	}

	fn max_body_bytes(&self) -> usize {
		self.max_body
	}
}

pub(super) fn entry_file(dir: &Path, id: &str) -> PathBuf {
	dir.join(format!("{id}.json"))
}

pub(super) fn read_entry(dir: &Path, id: &str) -> InstanceEntry {
	serde_json::from_slice(&std::fs::read(entry_file(dir, id)).unwrap()).unwrap()
}

/// A well-formed v1 entry for `id` in `dir` whose endpoint nothing listens
/// on.
pub(super) fn dead_entry(dir: &Path, id: &str, capabilities: &[&str]) -> InstanceEntry {
	let nonce = random_hex(8);
	InstanceEntry {
		instance_id: id.to_owned(),
		pid: std::process::id(),
		endpoint: endpoint_for(dir.to_str().unwrap(), id, &nonce),
		nonce,
		token: random_hex(32),
		created_at: 1,
		capabilities: capabilities.iter().map(|ns| (*ns).to_owned()).collect(),
	}
}

pub(super) fn write_entry(dir: &Path, name: &str, value: &Value) -> PathBuf {
	let path = entry_file(dir, name);
	std::fs::write(&path, serde_json::to_vec(value).unwrap()).unwrap();
	path
}

pub(super) fn entry_json(entry: &InstanceEntry) -> Value {
	let mut value = serde_json::to_value(entry).unwrap();
	value["v"] = json!(1);
	value
}

/// Send `line` to `endpoint` and parse the one response line.
pub(super) async fn raw_exchange(endpoint: &str, line: &[u8]) -> Value {
	let mut stream = pi_ipc::connect(endpoint, TIMEOUT).await.unwrap();
	write_line(&mut stream, line).await.unwrap();
	let Ok(Some(response)) = read_line(&mut stream, MAX_RESPONSE).await else {
		panic!("no response line");
	};
	serde_json::from_slice(&response).unwrap()
}

/// `{"v":1,"ok":false,"error":code}`.
pub(super) fn wire_error(code: &str) -> Value {
	json!({ "v": 1, "ok": false, "error": code })
}

/// Regular files under `dir`, recursively.
pub(super) fn files_in(dir: &Path) -> Vec<PathBuf> {
	let mut out = Vec::new();
	for item in std::fs::read_dir(dir).unwrap().flatten() {
		let path = item.path();
		if path.is_dir() {
			out.extend(files_in(&path));
		} else if path.is_file() {
			out.push(path);
		}
	}
	out
}

/// Names of the entries directly in `dir`, sorted.
pub(super) fn names_in(dir: &Path) -> Vec<String> {
	let mut names: Vec<String> = std::fs::read_dir(dir)
		.unwrap()
		.flatten()
		.map(|item| item.file_name().into_string().unwrap())
		.collect();
	names.sort();
	names
}
