//! `mdns-sd` glue: register our service on eligible interfaces, browse for
//! peers, feed resolves/removals through [`PeerTracker`].
//!
//! Interfaces are chosen by a predicate (re-evaluated by the daemon as
//! interfaces come and go) and our addresses follow the host (`addr_auto`),
//! so roaming, DHCP renewals and late-connecting adapters need no restart.
//! Only a flip of the virtual-adapter fallback decision does; see
//! [`MdnsDiscovery::needs_restart`].

use std::{
	io,
	net::IpAddr,
	time::{Duration, Instant},
};

use mdns_sd::{IfKind, IfPredicate, Receiver, ServiceDaemon, ServiceEvent, ServiceInfo};
use tokio::{sync::mpsc, task::JoinHandle};

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
		let task = runtime.spawn(event_loop(browse, rebrowse_rx, tracker, ifaces, events));
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

async fn event_loop(
	mut browse: Receiver<ServiceEvent>,
	mut rebrowse: mpsc::UnboundedReceiver<Receiver<ServiceEvent>>,
	mut tracker: PeerTracker,
	ifaces: Vec<InterfaceAddr>,
	events: mpsc::Sender<DiscoveryEvent>,
) {
	let mut ifaces = Ifaces { list: ifaces, at: Instant::now(), forced_at: None };
	// A replaced browse receiver disconnects; park on `rebrowse` until the
	// replacement (or stop) arrives instead of spinning on the dead one.
	let mut browse_live = true;
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
					browse_live = true;
				},
				None => break,
			},
			ev = browse.recv_async(), if browse_live => match ev {
				Ok(event) => out.extend(apply(&mut tracker, &mut ifaces, event)),
				Err(_) => browse_live = false,
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

	/// Two discoveries in one process find each other over the real network.
	/// Run manually: `cargo nextest run -p pi-mesh --run-ignored only
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
