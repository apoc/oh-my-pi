//! Inbound admission: hop/block checks, per-sender and per-source-IP rate
//! limits, and the bounded map of requests awaiting the frontend's
//! `respond`.

use std::{
	borrow::Borrow,
	collections::HashMap,
	hash::Hash,
	net::IpAddr,
	time::{Duration, Instant},
};

use tokio::sync::oneshot;

use crate::protocol::{MeshEnvelope, MeshErrorCode, MeshRequest, MeshResponse};

/// Non-snapshot requests one sender id may make per minute (burst = rate).
pub const RATE_PER_MINUTE: u32 = 60;
/// Non-snapshot requests one remote source IP may make per minute. Sender
/// ids are self-claimed, so a key holder rotating ids is bounded here; the
/// headroom covers a few instances behind one address.
pub const RATE_PER_IP_MINUTE: u32 = 180;
/// Requests awaiting `respond` at once; more are answered `busy`. Per source
/// IP the transport already bounds this: every pending request holds its
/// connection, and the LAN listener allows `MAX_CONNECTIONS_PER_IP`.
pub const MAX_PENDING: usize = 256;
/// How long the engine waits for the frontend's `respond`.
pub const RESPOND_TIMEOUT: Duration = Duration::from_secs(30);
/// Keys tracked per limiter before full buckets are forgotten.
const MAX_BUCKETS: usize = 1024;

/// What to do with an envelope that passed transport auth.
#[derive(Debug, PartialEq, Eq)]
pub enum Admission {
	/// Answer immediately with this.
	Reject(MeshResponse),
	/// Serve the engine-held snapshot.
	Snapshot,
	/// Hand to the frontend.
	Dispatch,
}

/// Rate limiters applied to dispatched (non-snapshot) requests.
#[derive(Debug)]
pub struct Limits {
	by_sender: RateLimiter<String>,
	by_ip:     RateLimiter<IpAddr>,
}

impl Default for Limits {
	fn default() -> Self {
		Self {
			by_sender: RateLimiter::new(RATE_PER_MINUTE),
			by_ip:     RateLimiter::new(RATE_PER_IP_MINUTE),
		}
	}
}

/// Hop and block checks, then the rate limits (snapshots exempt); remote
/// requests are limited by `source_ip` as well as by claimed sender id. The
/// transport already enforced auth, shape and recipient.
pub fn admit(
	env: &MeshEnvelope,
	source_ip: Option<IpAddr>,
	blocked: bool,
	limits: &mut Limits,
	now: Instant,
) -> Admission {
	if let Err(err) = env.check_inbound_hop() {
		return Admission::Reject(err.into());
	}
	if blocked {
		return Admission::Reject(MeshResponse::error(MeshErrorCode::Denied, "sender is blocked"));
	}
	if env.body == MeshRequest::Snapshot {
		return Admission::Snapshot;
	}
	// Sender first: a sender over its own limit must not drain the IP budget
	// shared with other instances behind the same address. Rotating ids are
	// still caught by the IP bucket.
	if !limits.by_sender.allow(env.from.instance_id.as_str(), now) {
		return Admission::Reject(MeshResponse::error(
			MeshErrorCode::RateLimited,
			format!("more than {RATE_PER_MINUTE} mesh requests per minute"),
		));
	}
	if let Some(ip) = source_ip
		&& !limits.by_ip.allow(&ip, now)
	{
		return Admission::Reject(MeshResponse::error(
			MeshErrorCode::RateLimited,
			format!("more than {RATE_PER_IP_MINUTE} mesh requests per minute from {ip}"),
		));
	}
	Admission::Dispatch
}

#[derive(Debug, Clone, Copy)]
struct Bucket {
	tokens: f64,
	at:     Instant,
}

/// Token bucket per key; burst = per-minute rate.
#[derive(Debug)]
pub struct RateLimiter<K> {
	capacity: f64,
	per_sec:  f64,
	buckets:  HashMap<K, Bucket>,
}

impl Bucket {
	/// Refill for the time since the last update (never for a clock going
	/// back) and return the token count.
	fn refill(&mut self, now: Instant, capacity: f64, per_sec: f64) -> f64 {
		let elapsed = now.saturating_duration_since(self.at).as_secs_f64();
		self.tokens = elapsed.mul_add(per_sec, self.tokens).min(capacity);
		self.at = self.at.max(now);
		self.tokens
	}
}

impl<K: Hash + Eq> RateLimiter<K> {
	pub fn new(per_minute: u32) -> Self {
		let capacity = f64::from(per_minute);
		Self { capacity, per_sec: capacity / 60.0, buckets: HashMap::new() }
	}

	pub fn allow<Q>(&mut self, key: &Q, now: Instant) -> bool
	where
		K: Borrow<Q>,
		Q: Hash + Eq + ToOwned<Owned = K> + ?Sized,
	{
		let (capacity, per_sec) = (self.capacity, self.per_sec);
		if !self.buckets.contains_key(key) {
			if self.buckets.len() >= MAX_BUCKETS {
				self
					.buckets
					.retain(|_, b| b.refill(now, capacity, per_sec) < capacity);
			}
			self
				.buckets
				.insert(key.to_owned(), Bucket { tokens: capacity, at: now });
		}
		let Some(bucket) = self.buckets.get_mut(key) else {
			return false;
		};
		if bucket.refill(now, capacity, per_sec) < 1.0 {
			return false;
		}
		bucket.tokens -= 1.0;
		true
	}
}

/// Requests handed to the frontend, awaiting `respond`.
#[derive(Debug, Default)]
pub struct Pending {
	next:    u64,
	waiting: HashMap<String, oneshot::Sender<MeshResponse>>,
}

impl Pending {
	/// Registers a request; `None` when [`MAX_PENDING`] are outstanding.
	pub fn insert(&mut self) -> Option<(String, oneshot::Receiver<MeshResponse>)> {
		if self.waiting.len() >= MAX_PENDING {
			return None;
		}
		self.next += 1;
		let id = format!("r{}", self.next);
		let (tx, rx) = oneshot::channel();
		self.waiting.insert(id.clone(), tx);
		Some((id, rx))
	}

	/// Delivers the frontend's answer; false when unknown or already timed out.
	pub fn complete(&mut self, id: &str, response: MeshResponse) -> bool {
		self
			.waiting
			.remove(id)
			.is_some_and(|tx| tx.send(response).is_ok())
	}

	pub fn remove(&mut self, id: &str) {
		self.waiting.remove(id);
	}

	#[cfg(test)]
	pub fn len(&self) -> usize {
		self.waiting.len()
	}

	/// Drops every waiter (their receivers see a closed channel).
	pub fn clear(&mut self) {
		self.waiting.clear();
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::protocol::{ANY_INSTANCE, MeshSender, MessageKind, PROTOCOL_VERSION};

	const OWN: &str = "0000000000000000";
	const PEER: &str = "1111111111111111";

	fn env(to: &str, hop: u32, body: MeshRequest) -> MeshEnvelope {
		MeshEnvelope {
			v: PROTOCOL_VERSION,
			msg_id: "m1".into(),
			sent_at: 0,
			hop,
			from: MeshSender {
				instance_id:  PEER.into(),
				agent_id:     "Main".into(),
				display_name: "peer".into(),
				host:         "box".into(),
				lan_port:     None,
			},
			to: to.into(),
			body,
		}
	}

	fn note() -> MeshRequest {
		MeshRequest::Message { kind: MessageKind::Note, text: "hi".into(), thread: None }
	}

	fn code(a: &Admission) -> Option<MeshErrorCode> {
		match a {
			Admission::Reject(MeshResponse::Err { code, .. }) => Some(*code),
			_ => None,
		}
	}

	#[test]
	fn admission_outcomes() {
		let now = Instant::now();
		let mut l = Limits::default();
		assert_eq!(admit(&env(OWN, 0, note()), None, false, &mut l, now), Admission::Dispatch);
		assert_eq!(
			admit(&env(OWN, 0, MeshRequest::Snapshot), None, false, &mut l, now),
			Admission::Snapshot
		);
		assert_eq!(
			admit(&env(ANY_INSTANCE, 0, MeshRequest::Snapshot), None, false, &mut l, now),
			Admission::Snapshot
		);
		for (what, e, blocked) in [
			("relayed", env(OWN, 1, note()), false),
			("blocked", env(OWN, 0, note()), true),
			("blocked snapshot", env(OWN, 0, MeshRequest::Snapshot), true),
		] {
			assert_eq!(
				code(&admit(&e, None, blocked, &mut l, now)),
				Some(MeshErrorCode::Denied),
				"{what}"
			);
		}
	}

	#[test]
	fn rate_limit_per_sender_refills_and_exempts_snapshots() {
		let start = Instant::now();
		let mut l = Limits::default();
		for _ in 0..RATE_PER_MINUTE {
			assert_eq!(admit(&env(OWN, 0, note()), None, false, &mut l, start), Admission::Dispatch);
		}
		assert_eq!(
			code(&admit(&env(OWN, 0, note()), None, false, &mut l, start)),
			Some(MeshErrorCode::RateLimited)
		);
		assert_eq!(
			admit(&env(OWN, 0, MeshRequest::Snapshot), None, false, &mut l, start),
			Admission::Snapshot
		);
		let rl = &mut l.by_sender;
		assert!(rl.allow("2222222222222222", start), "other senders unaffected");
		let later = start + Duration::from_secs(1);
		assert!(rl.allow(PEER, later), "one token per second");
		assert!(!rl.allow(PEER, later));
		assert!(!rl.allow(PEER, start), "clock going back grants nothing");
	}

	#[test]
	fn rotating_sender_ids_hit_the_source_ip_limit() {
		let now = Instant::now();
		let mut l = Limits::default();
		let ip: IpAddr = "10.0.0.9".parse().unwrap();
		for i in 0..RATE_PER_IP_MINUTE {
			let mut e = env(OWN, 0, note());
			e.from.instance_id = format!("{i:016x}");
			assert_eq!(admit(&e, Some(ip), false, &mut l, now), Admission::Dispatch);
		}
		let mut e = env(OWN, 0, note());
		e.from.instance_id = "ffffffffffffffff".into();
		assert_eq!(code(&admit(&e, Some(ip), false, &mut l, now)), Some(MeshErrorCode::RateLimited));
		assert_eq!(
			admit(&e, Some("10.0.0.8".parse().unwrap()), false, &mut l, now),
			Admission::Dispatch
		);
	}

	#[test]
	fn sender_over_its_limit_does_not_drain_the_shared_ip_budget() {
		let now = Instant::now();
		let mut l = Limits::default();
		let ip: IpAddr = "10.0.0.9".parse().unwrap();
		let noisy = env(OWN, 0, note());
		for _ in 0..RATE_PER_IP_MINUTE * 2 {
			admit(&noisy, Some(ip), false, &mut l, now);
		}
		let mut other = env(OWN, 0, note());
		other.from.instance_id = "2222222222222222".into();
		for _ in 0..RATE_PER_MINUTE {
			assert_eq!(admit(&other, Some(ip), false, &mut l, now), Admission::Dispatch);
		}
		assert!(l.by_ip.allow(&ip, now), "noisy sender only spent its own 60");
	}

	#[test]
	fn pending_is_bounded_and_single_use() {
		let mut p = Pending::default();
		let (id, mut rx) = p.insert().unwrap();
		for _ in 1..MAX_PENDING {
			assert!(p.insert().is_some());
		}
		assert!(p.insert().is_none(), "overflow -> busy");
		assert!(p.complete(&id, MeshResponse::Ok(serde_json::Value::Null)));
		assert_eq!(rx.try_recv().unwrap(), MeshResponse::Ok(serde_json::Value::Null));
		assert!(
			!p.complete(&id, MeshResponse::Ok(serde_json::Value::Null)),
			"second respond ignored"
		);
		assert!(p.insert().is_some(), "slot freed");
	}
}
