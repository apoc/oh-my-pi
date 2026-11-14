//! Bounded accept loop shared by every listener: serving and refusing are
//! both capped, so a connection flood costs at most a fixed number of tasks.

use std::{io, sync::Arc, time::Duration};

use tokio::{sync::Semaphore, task::JoinSet};

/// Concurrent refusal answers per listener; refused connections past this
/// are dropped without an answer.
const MAX_REFUSALS: usize = 16;
/// Pause after a failed accept before the next one.
const ACCEPT_BACKOFF: Duration = Duration::from_millis(50);

/// Accept connections forever, each on its own task.
///
/// A connection is served when `admit` grants its transport-specific guard
/// (e.g. a per-address slot) and one of `max_serving` permits is free; both
/// are held until `serve(conn)` completes. Otherwise `refuse(conn)` answers
/// it, from at most [`MAX_REFUSALS`] tasks at once; beyond that the
/// connection is dropped unanswered. A failed accept (e.g. out of file
/// descriptors) backs off briefly and keeps serving. Run it on its own task:
/// aborting that task drops every connection task with it.
pub async fn serve_bounded<C, G, A, D, S, SF, R, RF>(
	max_serving: usize,
	accept: A,
	admit: D,
	serve: S,
	refuse: R,
) where
	A: AsyncFnMut() -> io::Result<C>,
	D: FnMut(&C) -> Option<G>,
	G: Send + 'static,
	S: FnMut(C) -> SF,
	SF: Future<Output = ()> + Send + 'static,
	R: FnMut(C) -> RF,
	RF: Future<Output = ()> + Send + 'static,
{
	serve_capped(max_serving, MAX_REFUSALS, accept, admit, serve, refuse).await;
}

/// [`serve_bounded`] with the refusal cap exposed so tests can reach it with
/// a handful of connections.
pub(crate) async fn serve_capped<C, G, A, D, S, SF, R, RF>(
	max_serving: usize,
	max_refusing: usize,
	mut accept: A,
	mut admit: D,
	mut serve: S,
	mut refuse: R,
) where
	A: AsyncFnMut() -> io::Result<C>,
	D: FnMut(&C) -> Option<G>,
	G: Send + 'static,
	S: FnMut(C) -> SF,
	SF: Future<Output = ()> + Send + 'static,
	R: FnMut(C) -> RF,
	RF: Future<Output = ()> + Send + 'static,
{
	let serving = Arc::new(Semaphore::new(max_serving));
	let refusing = Arc::new(Semaphore::new(max_refusing));
	let mut connections = JoinSet::new();
	loop {
		while connections.try_join_next().is_some() {}
		let Ok(conn) = accept().await else {
			tokio::time::sleep(ACCEPT_BACKOFF).await;
			continue;
		};
		let guard = admit(&conn);
		let permit = Arc::clone(&serving).try_acquire_owned();
		if let (Some(guard), Ok(permit)) = (guard, permit) {
			let fut = serve(conn);
			connections.spawn(async move {
				fut.await;
				drop(permit);
				drop(guard);
			});
		} else if let Ok(permit) = Arc::clone(&refusing).try_acquire_owned() {
			let fut = refuse(conn);
			connections.spawn(async move {
				fut.await;
				drop(permit);
			});
		}
	}
}
