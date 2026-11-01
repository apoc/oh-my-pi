//! Correlation of answers with the requests that asked for them.
//!
//! A `message` (thread kinds, steers) is acknowledged at once and answered
//! later by a separate `reply` request; a `watch` fires one `watch_event`.
//! The frontend tags each tracked request with an opaque ticket; once the
//! peer's acknowledgement names the key (`msgId` / `watchId`), the entry
//! routes answers from that peer to a waiter ([`Replies::await_start`]), to a
//! held slot for a waiter about to start, or out as a [`Late`] event carrying
//! the ticket. Message entries keep routing until they expire; watch entries
//! end with their one event.
//!
//! An answer may overtake the acknowledgement of its own request. It is kept
//! briefly as an early answer, but only while a tracked request it can answer
//! is in flight ([`Replies::begin_inflight`]): a `reply` naming the msgId we
//! sent to that peer, or a `watch_event` from a peer we are asking to watch.

use std::{
	collections::{HashMap, HashSet},
	time::{Duration, Instant},
};

use serde_json::json;
use tokio::sync::oneshot;

use crate::protocol::{MeshEnvelope, MeshErrorCode, MeshRequest, MeshResponse};

/// How long a tracked message keeps routing its replies.
pub const PENDING_TTL: Duration = Duration::from_hours(2);
/// Tracked requests at once; the oldest is dropped beyond.
pub const MAX_PENDING_REPLIES: usize = 1024;
/// Answers that overtook their own acknowledgement wait this long to be
/// claimed.
pub const EARLY_TTL: Duration = Duration::from_secs(60);
/// Unclaimed early answers at once; more are answered `busy`.
pub const MAX_EARLY: usize = 64;
/// Unclaimed early `watch_event`s per peer (their ids are the peer's own).
pub const MAX_EARLY_WATCH_EVENTS_PER_PEER: usize = 4;

/// Which answer op a tracked request expects.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplyOp {
	Reply,
	WatchEvent,
}

/// An answer: the whole inbound envelope (sender included).
pub type Answer = Box<MeshEnvelope>;

/// An answer nobody waits for; the frontend delivers it by ticket.
#[derive(Debug)]
pub struct Late {
	pub ticket: String,
	pub answer: Answer,
}

/// What a [`Replies`] change asks the node to emit (late first, then drops).
#[derive(Debug, Default)]
pub struct Effects {
	pub late:    Option<Late>,
	/// Tickets of entries that ended: TTL, size cap, a watch's one event.
	pub dropped: Vec<String>,
}

/// Outcome of [`Replies::await_start`].
pub enum AwaitStart {
	/// No tracked request under this key.
	Missing,
	/// A held answer that arrived before the wait; with the ticket of the
	/// entry it ended (a watch), if any.
	Ready(Answer, Option<String>),
	/// Wait on the receiver; end it with [`Replies::end_wait`].
	Wait { id: u64, ticket: String, rx: oneshot::Receiver<Answer> },
}

/// A tracked request on its way to the peer, until its acknowledgement was
/// handled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Inflight {
	/// `(peer, msgId we sent)`.
	Message(String, String),
	/// Peer asked to watch.
	Watch(String),
}

/// Why [`Replies::register`] refused.
#[derive(Debug, PartialEq, Eq)]
pub struct KeyTaken;

struct Entry {
	op:         ReplyOp,
	/// Instance the request went to; answers from others are refused.
	peer:       String,
	ticket:     String,
	/// Insertion order, for oldest-first eviction.
	seq:        u64,
	expires_at: Instant,
	/// Keep the next answer for a waiter about to start.
	held:       bool,
	stored:     Option<Answer>,
	waiter:     Option<(u64, oneshot::Sender<Answer>)>,
	/// A watch whose event is stored: no further answers.
	done:       bool,
}

impl Entry {
	fn accepts(&self, op: ReplyOp, from: &str) -> bool {
		!self.done && self.op == op && self.peer == from
	}

	fn waiting(&self) -> bool {
		self.waiter.as_ref().is_some_and(|(_, tx)| !tx.is_closed())
	}
}

/// The key and op an answer envelope carries; `None` for other ops.
fn answer_key(body: &MeshRequest) -> Option<(&str, ReplyOp)> {
	match body {
		MeshRequest::Reply { reply_to, .. } => Some((reply_to, ReplyOp::Reply)),
		MeshRequest::WatchEvent { watch_id, .. } => Some((watch_id, ReplyOp::WatchEvent)),
		_ => None,
	}
}

fn no_pending(key: &str) -> MeshResponse {
	MeshResponse::error(
		MeshErrorCode::BadRequest,
		format!("No pending message {key} for this peer."),
	)
}

fn accepted() -> MeshResponse {
	MeshResponse::Ok(json!({ "accepted": true }))
}

/// Tracked requests and early answers, keyed by `msgId` / `watchId`.
#[derive(Default)]
pub struct Replies {
	pending:          HashMap<String, Entry>,
	early:            HashMap<String, (Answer, Instant)>,
	inflight_msgs:    HashSet<(String, String)>,
	/// Peer -> tracked watch requests in flight.
	inflight_watches: HashMap<String, usize>,
	/// Waits that received a watch's event; their end reports the watch dropped.
	consumed_watches: HashSet<u64>,
	next_seq:         u64,
}

impl Replies {
	/// Marks a tracked request in flight; early answers are accepted only for
	/// these. Pair with [`Self::end_inflight`].
	pub fn begin_inflight(&mut self, inflight: &Inflight) {
		match inflight {
			Inflight::Message(peer, msg_id) => {
				self.inflight_msgs.insert((peer.clone(), msg_id.clone()));
			},
			Inflight::Watch(peer) => *self.inflight_watches.entry(peer.clone()).or_default() += 1,
		}
	}

	/// Ends an in-flight mark. Early answers it admitted that its
	/// acknowledgement did not claim are dropped with it.
	pub fn end_inflight(&mut self, inflight: &Inflight) {
		match inflight {
			Inflight::Message(peer, msg_id) => {
				self.inflight_msgs.remove(&(peer.clone(), msg_id.clone()));
				if self
					.early
					.get(msg_id)
					.is_some_and(|(a, _)| a.from.instance_id == *peer)
				{
					self.early.remove(msg_id);
				}
			},
			Inflight::Watch(peer) => {
				let Some(count) = self.inflight_watches.get_mut(peer) else {
					return;
				};
				*count -= 1;
				if *count == 0 {
					self.inflight_watches.remove(peer);
					self.early.retain(|_, (a, _)| {
						a.from.instance_id != *peer || !matches!(a.body, MeshRequest::WatchEvent { .. })
					});
				}
			},
		}
	}

	/// Tracks the request acknowledged with `key`. Prunes expired entries and
	/// evicts the oldest at the cap first; an early answer waiting for `key`
	/// is claimed. Refuses (`Err`) a key another peer's entry holds; the
	/// effects of the prune are returned either way.
	#[allow(clippy::too_many_arguments, reason = "one entry's fields")]
	pub fn register(
		&mut self,
		key: String,
		op: ReplyOp,
		peer: String,
		ticket: String,
		hold: bool,
		ttl: Duration,
		now: Instant,
	) -> (Effects, Result<(), KeyTaken>) {
		let mut fx = Effects::default();
		self.prune(now, &mut fx.dropped);
		if self.pending.get(&key).is_some_and(|e| e.peer != peer) {
			return (fx, Err(KeyTaken));
		}
		while self.pending.len() >= MAX_PENDING_REPLIES && !self.pending.contains_key(&key) {
			let Some(oldest) = self
				.pending
				.iter()
				.min_by_key(|(_, e)| e.seq)
				.map(|(k, _)| k.clone())
			else {
				break;
			};
			// Dropping the entry drops its waiter's sender: the wait ends empty.
			if let Some(entry) = self.pending.remove(&oldest) {
				fx.dropped.push(entry.ticket);
			}
		}
		self.next_seq += 1;
		let entry = Entry {
			op,
			peer,
			ticket,
			seq: self.next_seq,
			expires_at: now + ttl,
			held: hold,
			stored: None,
			waiter: None,
			done: false,
		};
		let claim = self
			.early
			.remove(&key)
			.filter(|(answer, expires_at)| {
				*expires_at >= now && entry.accepts(op, &answer.from.instance_id)
			})
			.map(|(answer, _)| answer);
		if let Some(previous) = self.pending.insert(key.clone(), entry) {
			fx.dropped.push(previous.ticket);
		}
		if let Some(answer) = claim {
			self.dispatch(&key, answer, &mut fx);
		}
		(fx, Ok(()))
	}

	/// Routes an inbound `reply` / `watch_event`; returns the response for
	/// the sender.
	pub fn deliver(&mut self, env: MeshEnvelope, now: Instant) -> (MeshResponse, Effects) {
		let mut fx = Effects::default();
		let Some((key, op)) = answer_key(&env.body) else {
			return (MeshResponse::error(MeshErrorCode::BadRequest, "Not an answer."), fx);
		};
		let key = key.to_owned();
		let from = env.from.instance_id.as_str();
		if let Some(entry) = self.pending.get(&key) {
			if entry.expires_at < now && !entry.waiting() {
				if let Some(expired) = self.pending.remove(&key) {
					fx.dropped.push(expired.ticket);
				}
				return (no_pending(&key), fx);
			}
			if !entry.accepts(op, from) {
				return (no_pending(&key), fx);
			}
			self.dispatch(&key, Box::new(env), &mut fx);
			return (accepted(), fx);
		}
		// The answer may overtake the acknowledgement of its own request.
		self.early.retain(|_, (_, expires_at)| *expires_at >= now);
		let solicited = match op {
			ReplyOp::Reply => self.inflight_msgs.contains(&(from.to_owned(), key.clone())),
			ReplyOp::WatchEvent => {
				self.inflight_watches.contains_key(from)
					&& self
						.early
						.values()
						.filter(|(a, _)| {
							a.from.instance_id == from && matches!(a.body, MeshRequest::WatchEvent { .. })
						})
						.count()
						< MAX_EARLY_WATCH_EVENTS_PER_PEER
			},
		};
		let foreign_slot = self
			.early
			.get(&key)
			.is_some_and(|(a, _)| a.from.instance_id != from);
		if !solicited || foreign_slot {
			return (no_pending(&key), fx);
		}
		if self.early.len() >= MAX_EARLY && !self.early.contains_key(&key) {
			return (MeshResponse::error(MeshErrorCode::Busy, "Too many unclaimed replies."), fx);
		}
		self.early.insert(key, (Box::new(env), now + EARLY_TTL));
		(accepted(), fx)
	}

	/// Waiter, else held slot, else a late event. A watch ends with its event;
	/// when a waiter took it, the watch's drop is reported by that wait's
	/// [`Self::end_wait`], after anything the wait still emits.
	fn dispatch(&mut self, key: &str, answer: Answer, fx: &mut Effects) {
		let Some(entry) = self.pending.get_mut(key) else {
			return;
		};
		let watch = entry.op == ReplyOp::WatchEvent;
		let undelivered = match entry.waiter.take() {
			Some((wait, tx)) => {
				entry.held = false;
				match tx.send(answer) {
					Ok(()) => {
						if watch {
							self.pending.remove(key);
							self.consumed_watches.insert(wait);
						}
						return;
					},
					// The waiter gave up concurrently; deliver late.
					Err(answer) => answer,
				}
			},
			None => answer,
		};
		if entry.held && entry.stored.is_none() {
			entry.stored = Some(undelivered);
			// A stored watch event ends the watch once the wait takes it.
			entry.done = watch;
			return;
		}
		fx.late = Some(Late { ticket: entry.ticket.clone(), answer: undelivered });
		if watch && let Some(ended) = self.pending.remove(key) {
			fx.dropped.push(ended.ticket);
		}
	}

	/// Starts waiting for `key`'s next answer; a new wait replaces (ends
	/// empty) the previous one.
	pub fn await_start(&mut self, key: &str) -> AwaitStart {
		let Some(entry) = self.pending.get_mut(key) else {
			return AwaitStart::Missing;
		};
		if let Some(stored) = entry.stored.take() {
			entry.held = false;
			let ended = if entry.done {
				self.pending.remove(key).map(|e| e.ticket)
			} else {
				None
			};
			return AwaitStart::Ready(stored, ended);
		}
		self.next_seq += 1;
		let id = self.next_seq;
		let (tx, rx) = oneshot::channel();
		entry.waiter = Some((id, tx));
		AwaitStart::Wait { id, ticket: entry.ticket.clone(), rx }
	}

	/// Ends wait `id` (always, after it received or gave up). A wait that gave
	/// up before an answer reached it leaves later answers to go out late; an
	/// answer handed to it that it never received goes out late instead of
	/// being lost; and a watch it consumed is reported dropped last.
	pub fn end_wait(
		&mut self,
		key: &str,
		id: u64,
		ticket: &str,
		rx: &mut oneshot::Receiver<Answer>,
	) -> Effects {
		let mut fx = Effects::default();
		if let Some(entry) = self.pending.get_mut(key)
			&& entry.waiter.as_ref().is_some_and(|(w, _)| *w == id)
		{
			entry.waiter = None;
			entry.held = false;
			return fx;
		}
		rx.close();
		fx.late = rx
			.try_recv()
			.ok()
			.map(|answer| Late { ticket: ticket.to_owned(), answer });
		if self.consumed_watches.remove(&id) {
			fx.dropped.push(ticket.to_owned());
		}
		fx
	}

	/// Drops the entries of `tickets` (their waits end empty).
	pub fn forget(&mut self, tickets: &[String]) {
		let tickets: HashSet<&str> = tickets.iter().map(String::as_str).collect();
		self
			.pending
			.retain(|_, e| !tickets.contains(e.ticket.as_str()));
	}

	/// Drops everything; returns the tickets of the dropped entries.
	pub fn clear(&mut self) -> Vec<String> {
		self.early.clear();
		self.inflight_msgs.clear();
		self.inflight_watches.clear();
		self.consumed_watches.clear();
		self.pending.drain().map(|(_, e)| e.ticket).collect()
	}

	#[cfg(test)]
	pub fn len(&self) -> usize {
		self.pending.len()
	}

	#[cfg(test)]
	pub fn is_waiting(&self, key: &str) -> bool {
		self.pending.get(key).is_some_and(Entry::waiting)
	}

	/// Expired entries without an active waiter.
	fn prune(&mut self, now: Instant, dropped: &mut Vec<String>) {
		self.pending.retain(|_, e| {
			let keep = e.expires_at >= now || e.waiting();
			if !keep {
				dropped.push(std::mem::take(&mut e.ticket));
			}
			keep
		});
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::protocol::{MeshSender, MeshWatchEvent, PROTOCOL_VERSION};

	const PEER: &str = "1111111111111111";
	const OTHER: &str = "2222222222222222";

	fn reply(from: &str, reply_to: &str, text: &str) -> MeshEnvelope {
		MeshEnvelope {
			v:       PROTOCOL_VERSION,
			msg_id:  "r1".into(),
			sent_at: 0,
			hop:     0,
			from:    MeshSender {
				instance_id:  from.into(),
				agent_id:     "Main".into(),
				display_name: "peer".into(),
				host:         "box".into(),
				lan_port:     None,
			},
			to:      "0000000000000000".into(),
			body:    MeshRequest::Reply {
				reply_to: reply_to.into(),
				thread:   None,
				text:     text.into(),
				error:    None,
			},
		}
	}

	fn watch_event(from: &str, watch_id: &str) -> MeshEnvelope {
		let mut env = reply(from, "x", "");
		env.body = MeshRequest::WatchEvent {
			watch_id: watch_id.into(),
			event:    MeshWatchEvent::Idle,
			detail:   None,
		};
		env
	}

	fn track(r: &mut Replies, key: &str, ticket: &str, hold: bool, now: Instant) -> Effects {
		let (fx, registered) =
			r.register(key.into(), ReplyOp::Reply, PEER.into(), ticket.into(), hold, PENDING_TTL, now);
		registered.unwrap();
		fx
	}

	fn track_watch(r: &mut Replies, key: &str, ticket: &str, hold: bool, now: Instant) -> Effects {
		let (fx, registered) = r.register(
			key.into(),
			ReplyOp::WatchEvent,
			PEER.into(),
			ticket.into(),
			hold,
			Duration::from_secs(60),
			now,
		);
		registered.unwrap();
		fx
	}

	fn in_flight(r: &mut Replies, msg_id: &str) -> Inflight {
		let inflight = Inflight::Message(PEER.into(), msg_id.into());
		r.begin_inflight(&inflight);
		inflight
	}

	fn text(answer: &Answer) -> &str {
		match &answer.body {
			MeshRequest::Reply { text, .. } => text,
			_ => "",
		}
	}

	fn is_ok(r: &MeshResponse) -> bool {
		matches!(r, MeshResponse::Ok(v) if v == &json!({ "accepted": true }))
	}

	fn err(r: &MeshResponse) -> Option<(MeshErrorCode, &str)> {
		match r {
			MeshResponse::Err { code, message } => Some((*code, message)),
			_ => None,
		}
	}

	fn wait(r: &mut Replies, key: &str) -> (u64, String, oneshot::Receiver<Answer>) {
		match r.await_start(key) {
			AwaitStart::Wait { id, ticket, rx } => (id, ticket, rx),
			_ => panic!("expected a wait"),
		}
	}

	#[test]
	fn late_answer_carries_the_ticket_and_the_entry_survives_it() {
		let now = Instant::now();
		let mut r = Replies::default();
		assert!(track(&mut r, "m1", "t-1", false, now).late.is_none());
		for text_in in ["first", "second"] {
			let (resp, fx) = r.deliver(reply(PEER, "m1", text_in), now);
			assert!(is_ok(&resp));
			let late = fx.late.expect("late event");
			assert_eq!((late.ticket.as_str(), text(&late.answer)), ("t-1", text_in));
		}
		assert_eq!(r.len(), 1);
	}

	#[test]
	fn early_answer_is_claimed_by_the_ack_and_expires_unclaimed() {
		let now = Instant::now();
		let mut r = Replies::default();
		in_flight(&mut r, "m1");
		let (resp, fx) = r.deliver(reply(PEER, "m1", "early"), now);
		assert!(is_ok(&resp) && fx.late.is_none());
		let fx = track(&mut r, "m1", "t-1", false, now + Duration::from_secs(1));
		assert_eq!(text(&fx.late.expect("claimed").answer), "early");

		// Held: the claimed early answer is stored for the coming wait.
		in_flight(&mut r, "m2");
		r.deliver(reply(PEER, "m2", "held early"), now);
		assert!(track(&mut r, "m2", "t-2", true, now).late.is_none());
		let AwaitStart::Ready(answer, None) = r.await_start("m2") else {
			panic!("stored answer")
		};
		assert_eq!(text(&answer), "held early");

		// Expired early answers are not claimed.
		in_flight(&mut r, "m3");
		r.deliver(reply(PEER, "m3", "stale"), now);
		let fx = track(&mut r, "m3", "t-3", false, now + EARLY_TTL + Duration::from_secs(1));
		assert!(fx.late.is_none());
	}

	#[test]
	fn unsolicited_early_answers_are_refused() {
		let now = Instant::now();
		let mut r = Replies::default();
		let (resp, _) = r.deliver(reply(PEER, "m1", "x"), now);
		assert_eq!(
			err(&resp),
			Some((MeshErrorCode::BadRequest, "No pending message m1 for this peer."))
		);
		// In flight to PEER: another instance cannot answer for it.
		let inflight = in_flight(&mut r, "m1");
		assert!(err(&r.deliver(reply(OTHER, "m1", "x"), now).0).is_some());
		assert!(is_ok(&r.deliver(reply(PEER, "m1", "x"), now).0));
		// Once the request completed, nothing new is buffered for it.
		r.end_inflight(&inflight);
		assert!(err(&r.deliver(reply(PEER, "m2", "x"), now).0).is_some());

		// Watch events only from a peer we are asking to watch, a few at a time.
		assert!(err(&r.deliver(watch_event(PEER, "w0"), now).0).is_some());
		let watch = Inflight::Watch(PEER.into());
		r.begin_inflight(&watch);
		for i in 0..MAX_EARLY_WATCH_EVENTS_PER_PEER {
			assert!(is_ok(&r.deliver(watch_event(PEER, &format!("w{i}")), now).0));
		}
		assert!(err(&r.deliver(watch_event(PEER, "over"), now).0).is_some());
		assert!(err(&r.deliver(watch_event(OTHER, "o1"), now).0).is_some());
		r.end_inflight(&watch);
	}

	#[test]
	fn ended_inflight_requests_take_their_unclaimed_early_answers_along() {
		let now = Instant::now();
		let mut r = Replies::default();
		// A peer fills its early watch quota with spoofed events while one watch
		// is in flight.
		let watch = Inflight::Watch(PEER.into());
		r.begin_inflight(&watch);
		for i in 0..MAX_EARLY_WATCH_EVENTS_PER_PEER {
			assert!(is_ok(&r.deliver(watch_event(PEER, &format!("spoof{i}")), now).0));
		}
		r.end_inflight(&watch);
		assert!(r.early.is_empty(), "unclaimed early watch events dropped");
		// The next watch in flight to that peer gets its early event in.
		r.begin_inflight(&watch);
		assert!(is_ok(&r.deliver(watch_event(PEER, "real"), now).0));
		track_watch(&mut r, "real", "t-real", false, now);
		r.end_inflight(&watch);
		assert_eq!(r.len(), 0, "claimed and ended with its event");

		// A message's early slot goes when its request completes unclaimed.
		let msg = in_flight(&mut r, "m1");
		assert!(is_ok(&r.deliver(reply(PEER, "m1", "x"), now).0));
		r.end_inflight(&msg);
		assert!(r.early.is_empty());
	}

	#[test]
	fn early_buffer_is_bounded() {
		let now = Instant::now();
		let mut r = Replies::default();
		for i in 0..=MAX_EARLY {
			in_flight(&mut r, &format!("e{i}"));
		}
		for i in 0..MAX_EARLY {
			assert!(is_ok(&r.deliver(reply(PEER, &format!("e{i}"), ""), now).0));
		}
		let over = format!("e{MAX_EARLY}");
		let (resp, _) = r.deliver(reply(PEER, &over, ""), now);
		assert_eq!(err(&resp), Some((MeshErrorCode::Busy, "Too many unclaimed replies.")));
		// Expired early answers make room again.
		let later = now + EARLY_TTL + Duration::from_secs(1);
		assert!(is_ok(&r.deliver(reply(PEER, &over, ""), later).0));
	}

	#[test]
	fn foreign_peer_and_wrong_op_are_refused() {
		let now = Instant::now();
		let mut r = Replies::default();
		track(&mut r, "m1", "t-1", false, now);
		let (resp, fx) = r.deliver(reply(OTHER, "m1", "x"), now);
		assert_eq!(
			err(&resp),
			Some((MeshErrorCode::BadRequest, "No pending message m1 for this peer."))
		);
		assert!(fx.late.is_none());
		let (resp, _) = r.deliver(watch_event(PEER, "m1"), now);
		assert_eq!(err(&resp).map(|e| e.0), Some(MeshErrorCode::BadRequest));
	}

	#[test]
	fn ack_naming_another_peers_key_is_refused() {
		let now = Instant::now();
		let mut r = Replies::default();
		track(&mut r, "k", "t-1", false, now);
		let (_, taken) = r.register(
			"k".into(),
			ReplyOp::WatchEvent,
			OTHER.into(),
			"t-2".into(),
			false,
			PENDING_TTL,
			now,
		);
		assert_eq!(taken.err(), Some(KeyTaken));
		// The first entry keeps routing.
		assert_eq!(r.deliver(reply(PEER, "k", "x"), now).1.late.unwrap().ticket, "t-1");
	}

	#[test]
	fn held_answer_is_stored_once_then_waiter_and_late() {
		let now = Instant::now();
		let mut r = Replies::default();
		track(&mut r, "m1", "t-1", true, now);
		assert!(r.deliver(reply(PEER, "m1", "kept"), now).1.late.is_none());
		// Only one answer is held; the next goes out late.
		assert_eq!(
			text(
				&r.deliver(reply(PEER, "m1", "next"), now)
					.1
					.late
					.unwrap()
					.answer
			),
			"next"
		);
		let AwaitStart::Ready(answer, None) = r.await_start("m1") else {
			panic!("stored")
		};
		assert_eq!(text(&answer), "kept");
		// After the stored answer was taken, the entry is no longer held.
		assert!(r.deliver(reply(PEER, "m1", "after"), now).1.late.is_some());
	}

	#[test]
	fn waiter_gets_the_answer_and_a_new_wait_replaces_the_old() {
		let now = Instant::now();
		let mut r = Replies::default();
		track(&mut r, "m1", "t-1", false, now);
		let (_, _, mut old) = wait(&mut r, "m1");
		let (id, ticket, mut new) = wait(&mut r, "m1");
		assert_eq!(ticket, "t-1");
		assert!(old.try_recv().is_err(), "replaced wait ends empty");
		assert!(r.deliver(reply(PEER, "m1", "answer"), now).1.late.is_none());
		assert_eq!(text(&new.try_recv().unwrap()), "answer");
		let fx = r.end_wait("m1", id, &ticket, &mut new);
		assert!(fx.late.is_none() && fx.dropped.is_empty());
		assert!(r.deliver(reply(PEER, "m1", "later"), now).1.late.is_some());
		assert!(matches!(r.await_start("nope"), AwaitStart::Missing));
	}

	#[test]
	fn answer_handed_to_a_wait_that_gives_up_is_emitted_late() {
		let now = Instant::now();
		let mut r = Replies::default();
		track(&mut r, "m1", "t-1", false, now);
		let (id, ticket, mut rx) = wait(&mut r, "m1");
		// The answer reaches the waiter, then the wait times out before
		// receiving.
		assert!(r.deliver(reply(PEER, "m1", "raced"), now).1.late.is_none());
		let late = r
			.end_wait("m1", id, &ticket, &mut rx)
			.late
			.expect("not lost");
		assert_eq!((late.ticket.as_str(), text(&late.answer)), ("t-1", "raced"));

		// A wait that ends before any answer leaves later answers to go out late.
		let (id, ticket, mut rx) = wait(&mut r, "m1");
		assert!(r.end_wait("m1", id, &ticket, &mut rx).late.is_none());
		assert!(r.deliver(reply(PEER, "m1", "x"), now).1.late.is_some());

		// A waiter that dropped its receiver without ending: late, not lost.
		let (_, _, rx) = wait(&mut r, "m1");
		drop(rx);
		assert!(r.deliver(reply(PEER, "m1", "x"), now).1.late.is_some());
	}

	#[test]
	fn watch_entries_end_with_their_event() {
		let now = Instant::now();
		let mut r = Replies::default();
		track_watch(&mut r, "w1", "t-w1", false, now);
		let (resp, fx) = r.deliver(watch_event(PEER, "w1"), now);
		assert!(is_ok(&resp));
		assert_eq!(fx.late.unwrap().ticket, "t-w1");
		assert_eq!(fx.dropped, ["t-w1"]);
		assert!(err(&r.deliver(watch_event(PEER, "w1"), now).0).is_some(), "one-shot");

		// Held: stored, refused afterwards, ended when the wait takes it.
		track_watch(&mut r, "w2", "t-w2", true, now);
		assert!(r.deliver(watch_event(PEER, "w2"), now).1.late.is_none());
		assert!(err(&r.deliver(watch_event(PEER, "w2"), now).0).is_some());
		let AwaitStart::Ready(_, ended) = r.await_start("w2") else {
			panic!("stored")
		};
		assert_eq!(ended.as_deref(), Some("t-w2"));
		assert_eq!(r.len(), 0);

		// A waiter gets it; the watch is reported dropped when that wait ends.
		track_watch(&mut r, "w3", "t-w3", false, now);
		let (id, ticket, mut rx) = wait(&mut r, "w3");
		let fx = r.deliver(watch_event(PEER, "w3"), now).1;
		assert!(fx.late.is_none() && fx.dropped.is_empty());
		assert_eq!(r.len(), 0);
		assert!(rx.try_recv().is_ok());
		let fx = r.end_wait("w3", id, &ticket, &mut rx);
		assert!(fx.late.is_none());
		assert_eq!(fx.dropped, ["t-w3"]);
	}

	#[test]
	fn watch_event_handed_to_a_wait_that_times_out_goes_late_before_the_drop() {
		let now = Instant::now();
		let mut r = Replies::default();
		track_watch(&mut r, "w1", "t-w1", false, now);
		let (id, ticket, mut rx) = wait(&mut r, "w1");
		// The event reaches the waiter; the wait times out before receiving it.
		let fx = r.deliver(watch_event(PEER, "w1"), now).1;
		assert!(fx.late.is_none() && fx.dropped.is_empty(), "nothing emitted yet");
		let fx = r.end_wait("w1", id, &ticket, &mut rx);
		let late = fx.late.expect("event not lost");
		assert_eq!(late.ticket, "t-w1");
		assert!(matches!(late.answer.body, MeshRequest::WatchEvent { .. }));
		// Effects emit late first, then drops: the ticket is still known to the
		// frontend.
		assert_eq!(fx.dropped, ["t-w1"]);
		assert!(r.consumed_watches.is_empty());
	}

	#[test]
	fn ttl_prunes_idle_entries_but_not_waited_ones() {
		let now = Instant::now();
		let mut r = Replies::default();
		track(&mut r, "idle", "t-idle", false, now);
		track(&mut r, "waited", "t-waited", false, now);
		let (_, _, mut rx) = wait(&mut r, "waited");
		track_watch(&mut r, "w", "t-w", false, now);
		let later = now + PENDING_TTL + Duration::from_secs(1);
		let fx = track(&mut r, "fresh", "t-fresh", false, later);
		let mut dropped = fx.dropped;
		dropped.sort();
		assert_eq!(dropped, ["t-idle", "t-w"]);
		assert!(
			r.deliver(reply(PEER, "waited", "still"), later)
				.1
				.late
				.is_none()
		);
		assert_eq!(text(&rx.try_recv().unwrap()), "still");
	}

	#[test]
	fn answer_to_an_expired_entry_drops_it_and_is_not_buffered() {
		let now = Instant::now();
		let mut r = Replies::default();
		in_flight(&mut r, "m1");
		track(&mut r, "m1", "t-1", false, now);
		let later = now + PENDING_TTL + Duration::from_secs(1);
		let (resp, fx) = r.deliver(reply(PEER, "m1", "x"), later);
		assert_eq!(
			err(&resp),
			Some((MeshErrorCode::BadRequest, "No pending message m1 for this peer."))
		);
		assert_eq!(fx.dropped, ["t-1"]);
		assert!(fx.late.is_none());
		assert_eq!(r.len(), 0);
		assert!(r.early.is_empty(), "not buffered");
	}

	#[test]
	fn cap_evicts_the_oldest_and_ends_its_wait() {
		let now = Instant::now();
		let mut r = Replies::default();
		for i in 0..MAX_PENDING_REPLIES {
			assert!(
				track(&mut r, &format!("m{i}"), &format!("t{i}"), false, now)
					.dropped
					.is_empty()
			);
		}
		let (_, _, mut rx) = wait(&mut r, "m0");
		let fx = track(&mut r, "over", "t-over", false, now);
		assert_eq!(fx.dropped, ["t0"]);
		assert!(rx.try_recv().is_err(), "evicted wait ends empty");
		assert_eq!(r.len(), MAX_PENDING_REPLIES);
		assert!(matches!(r.await_start("m0"), AwaitStart::Missing));
	}

	#[test]
	fn forget_and_clear() {
		let now = Instant::now();
		let mut r = Replies::default();
		track(&mut r, "m1", "t-1", false, now);
		track(&mut r, "m2", "t-2", false, now);
		let (_, _, mut rx) = wait(&mut r, "m1");
		r.forget(&["t-1".into()]);
		assert!(rx.try_recv().is_err());
		assert!(matches!(r.await_start("m1"), AwaitStart::Missing));
		assert_eq!(r.clear(), ["t-2"]);
		assert_eq!(r.len(), 0);
	}
}
