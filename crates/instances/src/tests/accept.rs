//! [`serve_capped`] branches the listener suites cannot reach: the refusal
//! cap and the transport guard.

use std::io;

use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

use super::TIMEOUT;
use crate::accept::serve_capped;

/// Connection id the test `admit` refuses its guard to.
const DENIED: usize = 7;

#[derive(Debug, PartialEq, Eq)]
enum Event {
	Served(usize),
	Refused(usize),
	Dropped(usize),
	Released(usize),
}

/// The transport guard `admit` grants; reports when it is released.
struct Guard {
	id:  usize,
	log: UnboundedSender<Event>,
}

impl Drop for Guard {
	fn drop(&mut self) {
		let _ = self.log.send(Event::Released(self.id));
	}
}

/// A fake connection that reports when it is dropped.
struct Conn {
	id:  usize,
	log: UnboundedSender<Event>,
}

impl Drop for Conn {
	fn drop(&mut self) {
		let _ = self.log.send(Event::Dropped(self.id));
	}
}

/// Run [`serve_capped`] over a channel of accept results; serving and
/// refusing log the connection and then hold it until the loop is aborted.
fn start(
	max_serving: usize,
	max_refusing: usize,
) -> (UnboundedSender<io::Result<usize>>, UnboundedReceiver<Event>, tokio::task::JoinHandle<()>) {
	let (accepts, events, _released, task) = start_with_guards(max_serving, max_refusing);
	(accepts, events, task)
}

/// [`start`] that also reports guard releases, on their own channel so the
/// connection events keep a fixed order.
fn start_with_guards(
	max_serving: usize,
	max_refusing: usize,
) -> (
	UnboundedSender<io::Result<usize>>,
	UnboundedReceiver<Event>,
	UnboundedReceiver<Event>,
	tokio::task::JoinHandle<()>,
) {
	let (accepts, mut incoming) = unbounded_channel::<io::Result<usize>>();
	let (log, events) = unbounded_channel();
	let (released_log, released) = unbounded_channel();
	let task = tokio::spawn(serve_capped(
		max_serving,
		max_refusing,
		async move || match incoming.recv().await {
			Some(result) => result.map(|id| Conn { id, log: log.clone() }),
			None => std::future::pending().await,
		},
		move |conn: &Conn| {
			(conn.id != DENIED).then(|| Guard { id: conn.id, log: released_log.clone() })
		},
		|conn: Conn| {
			let _ = conn.log.send(Event::Served(conn.id));
			async move { hold(conn).await }
		},
		|conn: Conn| {
			let _ = conn.log.send(Event::Refused(conn.id));
			async move { hold(conn).await }
		},
	));
	(accepts, events, released, task)
}

async fn hold(conn: Conn) {
	std::future::pending::<()>().await;
	drop(conn);
}

async fn next(events: &mut UnboundedReceiver<Event>) -> Event {
	tokio::time::timeout(TIMEOUT, events.recv())
		.await
		.expect("event in time")
		.expect("log open")
}

#[tokio::test]
async fn refusals_past_the_cap_are_dropped_unanswered_and_abort_drops_all() {
	let (accepts, mut events, task) = start(1, 1);
	accepts.send(Err(io::Error::other("transient"))).unwrap();
	for id in 1..=3 {
		accepts.send(Ok(id)).unwrap();
	}
	assert_eq!(next(&mut events).await, Event::Served(1), "a failed accept keeps serving");
	assert_eq!(next(&mut events).await, Event::Refused(2));
	assert_eq!(next(&mut events).await, Event::Dropped(3), "no refusal task left");

	task.abort();
	let _ = task.await;
	let mut dropped = [next(&mut events).await, next(&mut events).await];
	dropped.sort_by_key(|event| format!("{event:?}"));
	assert_eq!(dropped, [Event::Dropped(1), Event::Dropped(2)]);
}

#[tokio::test]
async fn a_withheld_guard_refuses_while_permits_are_free() {
	let (accepts, mut events, task) = start(1, 1);
	accepts.send(Ok(DENIED)).unwrap();
	accepts.send(Ok(8)).unwrap();
	assert_eq!(next(&mut events).await, Event::Refused(DENIED));
	assert_eq!(next(&mut events).await, Event::Served(8));
	task.abort();
}

#[tokio::test]
async fn an_admitted_guard_is_released_at_once_when_no_serving_permit_is_free() {
	let (accepts, mut events, mut released, task) = start_with_guards(1, 1);
	accepts.send(Ok(1)).unwrap();
	accepts.send(Ok(2)).unwrap();
	assert_eq!(next(&mut events).await, Event::Served(1));
	assert_eq!(next(&mut events).await, Event::Refused(2));
	assert_eq!(
		next(&mut released).await,
		Event::Released(2),
		"the refused connection's guard must not be held while it is refused"
	);
	assert!(released.try_recv().is_err(), "the served connection's guard is held");

	task.abort();
	let _ = task.await;
	assert_eq!(next(&mut released).await, Event::Released(1), "abort releases the held guard");
}
