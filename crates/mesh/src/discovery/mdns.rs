//! `mdns-sd` glue: register our service on eligible interfaces, browse for
//! peers, feed resolves/removals through [`PeerTracker`].
//!
//! Interfaces are chosen by a predicate (re-evaluated by the daemon as
//! interfaces come and go) and our addresses follow the host (`addr_auto`),
//! so roaming, DHCP renewals and late-connecting adapters need no restart.
//! Only a flip of the virtual-adapter fallback decision does; see
//! [`MdnsDiscovery::needs_restart`].

use std::{
	collections::HashSet,
	io,
	net::IpAddr,
	time::{Duration, Instant},
};

use mdns_sd::{IfKind, IfPredicate, Metrics, Receiver, ServiceDaemon, ServiceEvent, ServiceInfo};
use tokio::{sync::mpsc, task::JoinHandle, time};

use super::records::{
	DiscoveryEvent, MAX_DISPLAY_NAME_BYTES, PeerTracker, Resolved, SERVICE_TYPE, is_group_tag,
	on_our_subnet, truncate_utf8, txt_properties,
};
use crate::{
	net::{self, InterfaceAddr},
	protocol::is_instance_id,
};

/// Bound on waiting for the daemon to confirm unregister/shutdown.
const DAEMON_ACK_TIMEOUT: Duration = Duration::from_secs(2);
/// Max length of one DNS label.
const MAX_LABEL_BYTES: usize = 63;
/// How long the interface list used for peer address choice is reused.
const IFACES_TTL: Duration = Duration::from_secs(30);
/// Minimum spacing of interface re-reads forced by off-subnet records.
const IFACES_FORCE_MIN: Duration = Duration::from_secs(1);
/// Wait before browsing again after the daemon dropped our subscription;
/// doubles per short-lived subscription up to [`REBROWSE_MAX`].
const REBROWSE_MIN: Duration = Duration::from_secs(1);
/// Longest wait between re-browses.
const REBROWSE_MAX: Duration = Duration::from_secs(60);

#[derive(Debug, thiserror::Error)]
pub enum DiscoveryError {
	#[error("invalid instance id")]
	InvalidInstanceId,
	#[error("invalid group tag")]
	InvalidGroupTag,
	#[error("port must be non-zero")]
	InvalidPort,
	#[error("enumerating interfaces: {0}")]
	Interfaces(#[from] io::Error),
	#[error("mDNS daemon: {0}")]
	Mdns(#[from] mdns_sd::Error),
	#[error("mDNS discovery must start inside a tokio runtime")]
	NoRuntime,
}

/// What we announce.
#[derive(Debug, Clone)]
pub struct MdnsConfig {
	pub instance_id:  String,
	/// Truncated to 200 UTF-8 bytes in TXT `n`.
	pub display_name: String,
	/// LAN listener port (SRV).
	pub port:         u16,
	/// Group tag derived from the mesh key (TXT `g`).
	pub group_tag:    String,
}

/// Running announce + browse. Dropping it shuts the daemon down (goodbye
/// sent by the daemon thread) without waiting; prefer [`Self::stop`].
pub struct MdnsDiscovery {
	daemon:   ServiceDaemon,
	fullname: String,
	/// Whether virtual adapters were allowed at start (no physical one).
	fallback: bool,
	/// New browse receivers for the event loop; dropping it ends the loop.
	rebrowse: Option<mpsc::UnboundedSender<Receiver<ServiceEvent>>>,
	task:     Option<JoinHandle<()>>,
}

impl MdnsDiscovery {
	/// Registers `cfg` on the eligible interfaces (see
	/// [`net::mdns_interface_allowed`]) and starts browsing. Peers with our
	/// group tag and another instance id are reported on `events`. Starts
	/// even with no eligible interface yet; the daemon picks them up later.
	pub fn start(
		cfg: MdnsConfig,
		events: mpsc::Sender<DiscoveryEvent>,
	) -> Result<Self, DiscoveryError> {
		if !is_instance_id(&cfg.instance_id) {
			return Err(DiscoveryError::InvalidInstanceId);
		}
		if !is_group_tag(&cfg.group_tag) {
			return Err(DiscoveryError::InvalidGroupTag);
		}
		if cfg.port == 0 {
			return Err(DiscoveryError::InvalidPort);
		}
		let runtime = tokio::runtime::Handle::try_current().map_err(|_| DiscoveryError::NoRuntime)?;
		let all = net::local_interface_addrs()?;
		let fallback = net::mdns_needs_virtual_fallback(&all);
		let ifaces = net::select_mdns_interfaces(&all);
		let allowed = IfKind::Predicate(IfPredicate::new(move |intf| {
			net::mdns_interface_allowed(&intf.name, intf.ip(), intf.is_loopback(), fallback)
		}));

		let daemon = ServiceDaemon::new()?;
		let started = (|| {
			daemon.disable_interface(IfKind::All)?;
			daemon.enable_interface(allowed.clone())?;
			let host =
				format!("{}.local.", mdns_host_name(&dns_lookup::get_hostname().unwrap_or_default()));
			let display_name = truncate_utf8(&cfg.display_name, MAX_DISPLAY_NAME_BYTES);
			let props = txt_properties(&cfg.instance_id, &cfg.group_tag, display_name);
			let mut info =
				ServiceInfo::new(SERVICE_TYPE, &cfg.instance_id, &host, (), cfg.port, &props[..])?
					.enable_addr_auto();
			info.set_interfaces(vec![allowed]);
			let fullname = info.get_fullname().to_owned();
			daemon.register(info)?;
			let browse = daemon.browse(SERVICE_TYPE)?;
			Ok::<_, mdns_sd::Error>((fullname, browse))
		})();
		let (fullname, browse) = match started {
			Ok(ok) => ok,
			Err(err) => {
				let _ = daemon.shutdown();
				return Err(err.into());
			},
		};

		let (rebrowse, rebrowse_rx) = mpsc::unbounded_channel();
		let tracker = PeerTracker::new(&cfg.instance_id, &cfg.group_tag);
		let browse_daemon = daemon.clone();
		let browse_again = move || browse_replayed(&browse_daemon);
		let task =
			runtime.spawn(event_loop(browse, rebrowse_rx, browse_again, tracker, ifaces, events));
		Ok(Self { daemon, fullname, fallback, rebrowse: Some(rebrowse), task: Some(task) })
	}

	/// True when the virtual-adapter fallback decision no longer matches the
	/// host (a physical adapter appeared or vanished); stop and start again.
	pub fn needs_restart(&self) -> bool {
		net::local_interface_addrs()
			.is_ok_and(|all| net::mdns_needs_virtual_fallback(&all) != self.fallback)
	}

	/// Restarts the browse: re-queries the network now (cached peers are
	/// replayed; unchanged ones produce no event).
	pub fn refresh(&self) -> Result<(), DiscoveryError> {
		let Some(rebrowse) = &self.rebrowse else {
			return Ok(());
		};
		let rx = self.daemon.browse(SERVICE_TYPE)?;
		// Loop gone means stop is in progress; nothing to refresh.
		let _ = rebrowse.send(rx);
		Ok(())
	}

	/// Sends goodbye, shuts the daemon down, and reports every known peer as
	/// down on the events channel before returning.
	pub async fn stop(mut self) {
		if let Ok(ack) = self.daemon.unregister(&self.fullname) {
			let _ = tokio::time::timeout(DAEMON_ACK_TIMEOUT, ack.recv_async()).await;
		}
		if let Ok(ack) = self.daemon.shutdown() {
			let _ = tokio::time::timeout(DAEMON_ACK_TIMEOUT, ack.recv_async()).await;
		}
		self.rebrowse = None;
		if let Some(task) = self.task.take() {
			let _ = task.await;
		}
	}
}

impl Drop for MdnsDiscovery {
	fn drop(&mut self) {
		if self.rebrowse.take().is_some() {
			let _ = self.daemon.shutdown();
		}
	}
}

/// Interfaces used to prefer same-subnet peer addresses, refreshed lazily.
struct Ifaces {
	list:      Vec<InterfaceAddr>,
	at:        Instant,
	/// Last re-read forced by an off-subnet record (bounded so spoofed
	/// records can't make every resolve enumerate interfaces).
	forced_at: Option<Instant>,
}

impl Ifaces {
	fn reload(&mut self) {
		if let Ok(list) = net::eligible_mdns_interfaces() {
			self.list = list;
		}
		self.at = Instant::now();
	}

	/// Interfaces for choosing among `addresses`. When none is on a cached
	/// subnet (we may have roamed), re-read once before the peer is rejected.
	fn for_addresses(&mut self, addresses: &[IpAddr]) -> &[InterfaceAddr] {
		if self.at.elapsed() >= IFACES_TTL {
			self.reload();
		} else if !addresses.iter().any(|a| on_our_subnet(*a, &self.list))
			&& self
				.forced_at
				.is_none_or(|at| at.elapsed() >= IFACES_FORCE_MIN)
		{
			self.forced_at = Some(Instant::now());
			self.reload();
		}
		&self.list
	}
}

fn apply(
	tracker: &mut PeerTracker,
	ifaces: &mut Ifaces,
	event: ServiceEvent,
) -> Option<DiscoveryEvent> {
	match event {
		ServiceEvent::ServiceResolved(svc) => {
			let addresses: Vec<IpAddr> = svc
				.addresses
				.iter()
				.map(mdns_sd::ScopedIp::to_ip_addr)
				.collect();
			let txt = |key: &str| svc.txt_properties.get_property_val(key);
			tracker.on_resolved(
				&Resolved {
					fullname:  &svc.fullname,
					host:      &svc.host,
					port:      svc.port,
					txt:       &txt,
					addresses: &addresses,
				},
				ifaces.for_addresses(&addresses),
			)
		},
		ServiceEvent::ServiceRemoved(_, fullname) => tracker.on_removed(&fullname),
		_ => None,
	}
}

/// A fresh browse subscription plus the daemon's answer to the command sent
/// right after it. The daemon runs commands in order and replays its cache
/// while handling the browse, so that answer marks the end of the replay.
struct Rebrowsed {
	events:   Receiver<ServiceEvent>,
	replayed: Receiver<Metrics>,
}

fn browse_replayed(daemon: &ServiceDaemon) -> Result<Rebrowsed, mdns_sd::Error> {
	let events = daemon.browse(SERVICE_TYPE)?;
	let replayed = daemon.get_metrics()?;
	Ok(Rebrowsed { events, replayed })
}

/// Applies a fresh browse's cache replay, then reports the known peers it
/// lacks as down: their removals may have been lost with the dropped
/// subscription. The replay is read while it arrives: a cache larger than
/// the daemon's event channel would otherwise overflow it and end the new
/// subscription too.
async fn reconcile(
	tracker: &mut PeerTracker,
	ifaces: &mut Ifaces,
	fresh: &Rebrowsed,
) -> Vec<DiscoveryEvent> {
	let mut out = Vec::new();
	let mut seen = HashSet::new();
	let mut take = |event: ServiceEvent| {
		// An instance whose host records expired is replayed as found only;
		// its PTR record still proves it did not leave.
		match &event {
			ServiceEvent::ServiceResolved(svc) => {
				seen.insert(svc.fullname.to_ascii_lowercase());
			},
			ServiceEvent::ServiceFound(_, fullname) => {
				seen.insert(fullname.to_ascii_lowercase());
			},
			_ => {},
		}
		out.extend(apply(tracker, ifaces, event));
	};
	let deadline = time::sleep(DAEMON_ACK_TIMEOUT);
	tokio::pin!(deadline);
	let answered = loop {
		tokio::select! {
			ev = fresh.events.recv_async() => match ev {
				Ok(event) => take(event),
				Err(_) => break false,
			},
			answer = fresh.replayed.recv_async() => break answer.is_ok(),
			() = &mut deadline => break false,
		}
	};
	while let Ok(event) = fresh.events.try_recv() {
		take(event);
	}
	// A replay that overflowed the channel ended the subscription part-way
	// and proves no absence; the loop re-browses that one later.
	if answered && !fresh.events.is_disconnected() {
		out.extend(tracker.retain_seen(&seen));
	}
	out
}

async fn event_loop(
	mut browse: Receiver<ServiceEvent>,
	mut rebrowse: mpsc::UnboundedReceiver<Receiver<ServiceEvent>>,
	// Opens a fresh browse subscription for [`SERVICE_TYPE`].
	mut browse_again: impl FnMut() -> Result<Rebrowsed, mdns_sd::Error>,
	mut tracker: PeerTracker,
	ifaces: Vec<InterfaceAddr>,
	events: mpsc::Sender<DiscoveryEvent>,
) {
	let mut ifaces = Ifaces { list: ifaces, at: Instant::now(), forced_at: None };
	// A receiver disconnects when `refresh` replaces it (the replacement
	// arrives on `rebrowse`) or when the daemon drops the subscription
	// because its event channel filled up (a flood of announcements, or a
	// cache replay too large for the channel). The latter is browsed again
	// after `backoff`, which doubles up to `REBROWSE_MAX` while receivers die
	// younger than it, so neither a flood nor a failing daemon makes us spin
	// or burst queries; the new replay then settles removals lost meanwhile
	// (see [`reconcile`]). While waiting (`retry_at` set) the loop still
	// serves `refresh` and stop.
	let mut born = time::Instant::now();
	let mut backoff = REBROWSE_MIN;
	let mut retry_at: Option<time::Instant> = None;
	loop {
		let mut out = Vec::new();
		tokio::select! {
			next = rebrowse.recv() => match next {
				Some(rx) => {
					// Unread events (removals included) must not be lost with
					// the old receiver; the cache replay won't repeat them.
					while let Ok(event) = browse.try_recv() {
						out.extend(apply(&mut tracker, &mut ifaces, event));
					}
					browse = rx;
					born = time::Instant::now();
					retry_at = None;
				},
				None => break,
			},
			ev = browse.recv_async(), if retry_at.is_none() => match ev {
				Ok(event) => out.extend(apply(&mut tracker, &mut ifaces, event)),
				// A refresh's replacement may be waiting already (it closed
				// this receiver); browsing again would replace that too.
				Err(_) => if let Ok(rx) = rebrowse.try_recv() {
					browse = rx;
					born = time::Instant::now();
				} else {
					if born.elapsed() >= backoff {
						backoff = REBROWSE_MIN;
					}
					retry_at = Some(time::Instant::now() + backoff);
				},
			},
			() = time::sleep_until(retry_at.unwrap_or_else(time::Instant::now)), if retry_at.is_some() => {
				backoff = (backoff * 2).min(REBROWSE_MAX);
				match browse_again() {
					Ok(fresh) => {
						out.extend(reconcile(&mut tracker, &mut ifaces, &fresh).await);
						browse = fresh.events;
						born = time::Instant::now();
						retry_at = None;
					},
					Err(_) => retry_at = Some(time::Instant::now() + backoff),
				}
			},
		}
		for event in out {
			if events.send(event).await.is_err() {
				return;
			}
		}
	}
	for down in tracker.clear() {
		if events.send(down).await.is_err() {
			return;
		}
	}
}

/// DNS label for our host: ASCII alphanumerics kept (lower-cased), runs of
/// anything else become one `-`, trimmed, at most 63 bytes; `omp` if empty.
pub fn mdns_host_name(raw: &str) -> String {
	let mut out = String::with_capacity(raw.len().min(MAX_LABEL_BYTES));
	for c in raw.chars() {
		if out.len() == MAX_LABEL_BYTES {
			break;
		}
		if c.is_ascii_alphanumeric() {
			out.push(c.to_ascii_lowercase());
		} else if !out.is_empty() && !out.ends_with('-') {
			out.push('-');
		}
	}
	let trimmed = out.trim_end_matches('-');
	if trimmed.is_empty() {
		"omp".to_owned()
	} else {
		trimmed.to_owned()
	}
}

#[cfg(test)]
mod tests {
	use std::sync::{Arc, Mutex};

	use super::*;

	#[test]
	fn host_name_is_a_dns_label() {
		assert_eq!(mdns_host_name("DESKTOP-AB12"), "desktop-ab12");
		assert_eq!(mdns_host_name("  my box.lan_"), "my-box-lan");
		assert_eq!(mdns_host_name("Ĥôšt"), "t");
		assert_eq!(mdns_host_name("ŽŽ"), "omp");
		assert_eq!(mdns_host_name(""), "omp");
		assert_eq!(mdns_host_name(&"a".repeat(100)).len(), MAX_LABEL_BYTES);
	}

	const TAG: &str = "a1b2c3d4e5f60718";
	const PEER_A: &str = "aaaaaaaaaaaaaaa1";
	const PEER_B: &str = "bbbbbbbbbbbbbbb2";
	const PEER_C: &str = "ccccccccccccccc3";

	fn tracker() -> PeerTracker {
		PeerTracker::new("0123456789abcdef", TAG)
	}

	/// Our interface; the peers below resolve on its subnet.
	fn lan() -> Vec<InterfaceAddr> {
		vec![InterfaceAddr {
			name:     "en0".into(),
			ip:       "192.168.0.2".parse().unwrap(),
			netmask:  "255.255.255.0".parse().unwrap(),
			loopback: false,
			up:       true,
		}]
	}

	fn info(id: &str) -> ServiceInfo {
		let props = txt_properties(id, TAG, "box");
		ServiceInfo::new(SERVICE_TYPE, id, "box.local.", "192.168.0.50", 4747, &props[..]).unwrap()
	}

	fn resolved(id: &str) -> ServiceEvent {
		ServiceEvent::ServiceResolved(Box::new(info(id).as_resolved_service()))
	}

	/// How the daemon replays an instance whose host records expired.
	fn found(id: &str) -> ServiceEvent {
		ServiceEvent::ServiceFound(SERVICE_TYPE.into(), info(id).get_fullname().to_owned())
	}

	fn started() -> ServiceEvent {
		ServiceEvent::SearchStarted(SERVICE_TYPE.into())
	}

	/// A browse receiver holding `events`. It disconnects once read, like a
	/// subscription the daemon dropped, unless the sender is kept.
	fn receiver(events: Vec<ServiceEvent>) -> (flume::Sender<ServiceEvent>, Receiver<ServiceEvent>) {
		let (tx, rx) = flume::unbounded();
		for event in events {
			tx.send(event).unwrap();
		}
		(tx, rx)
	}

	fn dropped(events: Vec<ServiceEvent>) -> Receiver<ServiceEvent> {
		receiver(events).1
	}

	/// A re-browse whose replay is already all in `events`.
	fn answered(events: Receiver<ServiceEvent>) -> Rebrowsed {
		let (tx, replayed) = flume::bounded(1);
		tx.send(Metrics::new()).unwrap();
		Rebrowsed { events, replayed }
	}

	type Live = Arc<Mutex<Option<flume::Sender<ServiceEvent>>>>;

	/// A re-browse replaying `events` like the daemon: into a channel of
	/// `cap` slots, ending the subscription (sender dropped) when an event
	/// finds it full for 100 ms, and answering the barrier afterwards. A
	/// complete replay leaves its sender in `live`.
	fn replaying(events: Vec<ServiceEvent>, cap: usize, live: Live) -> Rebrowsed {
		let (tx, rx) = flume::bounded(cap);
		let (done, replayed) = flume::bounded(1);
		tokio::spawn(async move {
			let mut tx = Some(tx);
			for event in events {
				let Some(sender) = &tx else { break };
				if time::timeout(Duration::from_millis(100), sender.send_async(event))
					.await
					.is_err()
				{
					tx = None;
				}
			}
			*live.lock().unwrap() = tx;
			let _ = done.send(Metrics::new());
		});
		Rebrowsed { events: rx, replayed }
	}

	fn drain(rx: &mut mpsc::Receiver<DiscoveryEvent>) -> Vec<String> {
		std::iter::from_fn(|| rx.try_recv().ok())
			.map(|event| match event {
				DiscoveryEvent::PeerUp(p) => format!("up {}", p.instance_id),
				DiscoveryEvent::PeerDown { instance_id } => format!("down {instance_id}"),
			})
			.collect()
	}

	type Rebrowse = mpsc::UnboundedSender<Receiver<ServiceEvent>>;

	fn spawn_loop(
		first: Receiver<ServiceEvent>,
		again: impl FnMut() -> Result<Rebrowsed, mdns_sd::Error> + Send + 'static,
	) -> (JoinHandle<()>, Rebrowse, mpsc::Receiver<DiscoveryEvent>) {
		let (events_tx, events_rx) = mpsc::channel(64);
		let (rebrowse_tx, rebrowse_rx) = mpsc::unbounded_channel();
		let task = tokio::spawn(event_loop(first, rebrowse_rx, again, tracker(), lan(), events_tx));
		(task, rebrowse_tx, events_rx)
	}

	/// Stop: dropping `rebrowse` ends the loop, which reports known peers
	/// down.
	async fn stop(task: JoinHandle<()>, rebrowse: Rebrowse) {
		drop(rebrowse);
		time::timeout(Duration::from_secs(5), task)
			.await
			.expect("loop ends when stop drops rebrowse")
			.unwrap();
	}

	type Calls = Arc<Mutex<Vec<time::Instant>>>;

	/// A browse that records the time of each call and returns `next()`.
	fn recording<R>(
		calls: &Calls,
		mut next: impl FnMut() -> R + Send + 'static,
	) -> impl FnMut() -> R + Send + 'static {
		let calls = Arc::clone(calls);
		move || {
			calls.lock().unwrap().push(time::Instant::now());
			next()
		}
	}

	/// Seconds from `start` to the first call and between later calls.
	fn gaps(start: time::Instant, calls: &Calls) -> Vec<u64> {
		let calls = calls.lock().unwrap();
		std::iter::once(&start)
			.chain(calls.iter())
			.zip(calls.iter())
			.map(|(a, b)| (*b - *a).as_secs())
			.collect()
	}

	/// The daemon replays its cache to every browse and drops a subscription
	/// whose replay overflows the channel, so every re-browse delivers events
	/// and dies again. The re-browses must back off, doubling up to the cap.
	#[tokio::test(start_paused = true)]
	async fn rebrowse_backs_off_while_subscriptions_keep_dying() {
		let calls = Calls::default();
		let again = recording(&calls, || Ok(answered(dropped(vec![started(), resolved(PEER_A)]))));
		let start = time::Instant::now();
		let (task, rebrowse, _events) = spawn_loop(dropped(Vec::new()), again);

		time::sleep(Duration::from_secs(300)).await;
		assert_eq!(gaps(start, &calls), [1, 2, 4, 8, 16, 32, 60, 60, 60]);
		stop(task, rebrowse).await;
	}

	/// A failing browse (daemon gone) keeps backing off instead of spinning.
	#[tokio::test(start_paused = true)]
	async fn failed_rebrowse_keeps_backing_off() {
		let calls = Calls::default();
		let again = recording(&calls, || Err(mdns_sd::Error::DaemonShutdown));
		let start = time::Instant::now();
		let (task, rebrowse, _events) = spawn_loop(dropped(Vec::new()), again);

		time::sleep(Duration::from_secs(100)).await;
		assert_eq!(gaps(start, &calls), [1, 2, 4, 8, 16, 32]);
		assert!(!task.is_finished(), "backing-off loop still serves refresh and stop");
		stop(task, rebrowse).await;
	}

	/// A subscription that lived longer than the current delay resets it;
	/// one that died sooner does not.
	#[tokio::test(start_paused = true)]
	async fn long_lived_subscription_resets_the_backoff() {
		let calls = Calls::default();
		let senders = Arc::new(Mutex::new(Vec::new()));
		let again = {
			let senders = Arc::clone(&senders);
			recording(&calls, move || {
				let (tx, rx) = receiver(vec![started()]);
				senders.lock().unwrap().push(tx);
				Ok(answered(rx))
			})
		};
		let (task, rebrowse, _events) = spawn_loop(dropped(Vec::new()), again);
		let kill_subscription = || {
			drop(senders.lock().unwrap().pop().expect("a live subscription"));
			time::Instant::now()
		};

		// First re-browse after 1 s; the delay is now 2 s.
		time::sleep(Duration::from_millis(1500)).await;
		assert_eq!(calls.lock().unwrap().len(), 1);
		// Lives 10 s (> 2 s), then dies: the next re-browse follows 1 s later.
		time::sleep(Duration::from_secs(10)).await;
		let died = kill_subscription();
		time::sleep(Duration::from_millis(1500)).await;
		assert_eq!(calls.lock().unwrap()[1] - died, Duration::from_secs(1));
		// Dies after 0.5 s (< 2 s): the delay keeps doubling.
		let died = kill_subscription();
		time::sleep(Duration::from_secs(3)).await;
		assert_eq!(calls.lock().unwrap()[2] - died, Duration::from_secs(2));
		stop(task, rebrowse).await;
	}

	/// A refresh arriving while a re-browse waits is adopted; no re-browse
	/// follows while it lives.
	#[tokio::test(start_paused = true)]
	async fn refresh_is_served_while_waiting_to_rebrowse() {
		let calls = Calls::default();
		let again = recording(&calls, || Ok(answered(dropped(vec![started()]))));
		let (task, rebrowse, mut events) = spawn_loop(dropped(Vec::new()), again);

		time::sleep(Duration::from_millis(500)).await;
		let (refreshed, rx) = receiver(vec![started()]);
		rebrowse.send(rx).unwrap();
		time::sleep(Duration::from_secs(100)).await;
		assert!(calls.lock().unwrap().is_empty());
		refreshed.send(resolved(PEER_A)).unwrap();
		time::sleep(Duration::from_millis(10)).await;
		assert_eq!(drain(&mut events), [format!("up {PEER_A}")]);
		stop(task, rebrowse).await;
	}

	/// Removals lost with a dropped subscription are recovered from the
	/// re-browse's replay: a known peer missing from it goes down; one in it
	/// stays up, also when replayed as found only (host records expired).
	#[tokio::test(start_paused = true)]
	async fn rebrowse_reports_peers_missing_from_the_replay_down() {
		let calls = Calls::default();
		let live = Arc::new(Mutex::new(None));
		let again = {
			let live = Arc::clone(&live);
			recording(&calls, move || {
				let (tx, rx) = receiver(vec![started(), resolved(PEER_A), found(PEER_C)]);
				*live.lock().unwrap() = Some(tx);
				Ok(answered(rx))
			})
		};
		let first = dropped(vec![resolved(PEER_A), resolved(PEER_B), resolved(PEER_C)]);
		let (task, rebrowse, mut events) = spawn_loop(first, again);

		time::sleep(Duration::from_secs(5)).await;
		assert_eq!(calls.lock().unwrap().len(), 1);
		assert_eq!(drain(&mut events), [
			format!("up {PEER_A}"),
			format!("up {PEER_B}"),
			format!("up {PEER_C}"),
			format!("down {PEER_B}")
		]);
		stop(task, rebrowse).await;
		let mut down = drain(&mut events);
		down.sort();
		assert_eq!(down, [format!("down {PEER_A}"), format!("down {PEER_C}")]);
	}

	/// A cache replay larger than the daemon's channel only fits when read
	/// while it arrives: the re-browsed subscription must survive it,
	/// reconcile, and stay live.
	#[tokio::test(start_paused = true)]
	async fn replay_larger_than_the_channel_keeps_the_subscription() {
		let calls = Calls::default();
		let live = Live::default();
		let ids: Vec<String> = (0..20).map(|i| format!("{:016x}", 0xa000 + i)).collect();
		let again = {
			let live = Arc::clone(&live);
			let ids = ids.clone();
			recording(&calls, move || {
				let mut replay = vec![started()];
				for id in &ids {
					replay.extend([found(id), resolved(id)]);
				}
				Ok(replaying(replay, 4, Arc::clone(&live)))
			})
		};
		let (task, rebrowse, mut events) = spawn_loop(dropped(vec![resolved(PEER_B)]), again);

		time::sleep(Duration::from_secs(5)).await;
		let mut want = vec![format!("up {PEER_B}")];
		want.extend(ids.iter().map(|id| format!("up {id}")));
		want.push(format!("down {PEER_B}"));
		assert_eq!(drain(&mut events), want);
		assert_eq!(calls.lock().unwrap().len(), 1, "the re-browsed subscription stays live");
		let tx = live.lock().unwrap().take().expect("the replay completed");
		tx.send(resolved(PEER_A)).unwrap();
		time::sleep(Duration::from_millis(10)).await;
		assert_eq!(drain(&mut events), [format!("up {PEER_A}")]);
		stop(task, rebrowse).await;
	}

	/// A replay cut short by the daemon dropping the subscription again
	/// proves no absence: nobody is reported down.
	#[tokio::test(start_paused = true)]
	async fn overflowed_replay_reports_nobody_down() {
		let calls = Calls::default();
		let again = recording(&calls, || Ok(answered(dropped(vec![started(), resolved(PEER_A)]))));
		let first = dropped(vec![resolved(PEER_A), resolved(PEER_B)]);
		let (task, rebrowse, mut events) = spawn_loop(first, again);

		time::sleep(Duration::from_secs(5)).await;
		assert!(!calls.lock().unwrap().is_empty());
		assert_eq!(drain(&mut events), [format!("up {PEER_A}"), format!("up {PEER_B}")]);
		stop(task, rebrowse).await;
		let mut down = drain(&mut events);
		down.sort();
		assert_eq!(down, [format!("down {PEER_A}"), format!("down {PEER_B}")]);
	}

	/// The real daemon has handled the browse (and replayed its cache) by
	/// the time it answers the barrier `browse_replayed` sends.
	#[tokio::test(flavor = "multi_thread")]
	async fn browse_replayed_barrier_follows_the_replay() {
		let daemon = ServiceDaemon::new().unwrap();
		daemon.disable_interface(IfKind::All).unwrap();
		let fresh = browse_replayed(&daemon).unwrap();
		time::timeout(DAEMON_ACK_TIMEOUT, fresh.replayed.recv_async())
			.await
			.unwrap()
			.unwrap();
		assert!(matches!(fresh.events.try_recv(), Ok(ServiceEvent::SearchStarted(_))));
		let _ = daemon.shutdown();
	}

	/// Two discoveries in one process find each other over the real network.
	/// Run manually: `cargo nextest run -p omp-mesh --run-ignored only
	/// mdns_smoke`.
	#[tokio::test(flavor = "multi_thread")]
	#[ignore = "touches the real network (multicast on port 5353)"]
	async fn mdns_smoke_two_instances_discover_each_other() {
		let tag = "0011223344556677".to_owned();
		let (tx_a, mut rx_a) = mpsc::channel(16);
		let (tx_b, mut rx_b) = mpsc::channel(16);
		let a = MdnsDiscovery::start(
			MdnsConfig {
				instance_id:  "aaaaaaaaaaaaaaa1".into(),
				display_name: "A".into(),
				port:         47001,
				group_tag:    tag.clone(),
			},
			tx_a,
		)
		.unwrap();
		let b = MdnsDiscovery::start(
			MdnsConfig {
				instance_id:  "bbbbbbbbbbbbbbb2".into(),
				display_name: "B".into(),
				port:         47002,
				group_tag:    tag,
			},
			tx_b,
		)
		.unwrap();
		let (tx_c, _rx_c) = mpsc::channel(16);
		let foreign = MdnsDiscovery::start(
			MdnsConfig {
				instance_id:  "ccccccccccccccc3".into(),
				display_name: "C".into(),
				port:         47003,
				group_tag:    "ffffffffffffffff".into(),
			},
			tx_c,
		)
		.unwrap();

		let wait_up = async |rx: &mut mpsc::Receiver<DiscoveryEvent>, want: &str| loop {
			match rx.recv().await.unwrap() {
				DiscoveryEvent::PeerUp(p) if p.instance_id == want => break p,
				DiscoveryEvent::PeerUp(p) => panic!("unexpected peer {p:?}"),
				DiscoveryEvent::PeerDown { .. } => {},
			}
		};
		let seen_by_a =
			tokio::time::timeout(Duration::from_secs(15), wait_up(&mut rx_a, "bbbbbbbbbbbbbbb2"))
				.await
				.expect("A sees B");
		let seen_by_b =
			tokio::time::timeout(Duration::from_secs(15), wait_up(&mut rx_b, "aaaaaaaaaaaaaaa1"))
				.await
				.expect("B sees A");
		eprintln!("A saw {seen_by_a:?}\nB saw {seen_by_b:?}");
		assert_eq!((seen_by_a.port, seen_by_a.display_name.as_str()), (47002, "B"));
		assert_eq!((seen_by_b.port, seen_by_b.display_name.as_str()), (47001, "A"));

		a.refresh().unwrap();
		b.stop().await;
		let down = tokio::time::timeout(Duration::from_secs(10), async {
			loop {
				match rx_a.recv().await.unwrap() {
					DiscoveryEvent::PeerDown { instance_id } => break instance_id,
					DiscoveryEvent::PeerUp(p) => assert_eq!(p.instance_id, "bbbbbbbbbbbbbbb2"),
				}
			}
		})
		.await
		.expect("A sees B's goodbye");
		assert_eq!(down, "bbbbbbbbbbbbbbb2");
		a.stop().await;
		foreign.stop().await;
	}
}
