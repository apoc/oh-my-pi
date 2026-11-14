//! Host network facts for the LAN side: interface enumeration, mDNS interface
//! eligibility, same-machine detection and a bounded reverse-DNS cache.
//!
//! Reverse DNS uses `dns_lookup::lookup_addr` (`getnameinfo` with
//! `NI_NAMEREQD`) on tokio's blocking pool: the crate is already in the
//! workspace lock, and the system resolver is what the user's hosts file,
//! NetBIOS/LLMNR (Windows) and mDNS (nss-mdns, macOS) feed into, which a
//! pure-DNS client would miss.

use std::{
	collections::HashMap,
	io,
	net::{IpAddr, Ipv4Addr},
	sync::Arc,
	time::Duration,
};

use parking_lot::Mutex;
use tokio::{sync::OnceCell, time::Instant};

/// One address assigned to a local interface.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InterfaceAddr {
	/// OS interface name (Windows: friendly name, e.g. `vEthernet (WSL)`).
	pub name:     String,
	pub ip:       IpAddr,
	pub netmask:  IpAddr,
	pub loopback: bool,
	/// False when the OS reports the interface operationally down.
	pub up:       bool,
}

/// Every address of every local interface, loopback included. Read fresh on
/// each call; interfaces come and go (VPN, Wi-Fi roaming).
pub fn local_interface_addrs() -> io::Result<Vec<InterfaceAddr>> {
	let ifaces = if_addrs::get_if_addrs()?;
	Ok(ifaces
		.into_iter()
		.map(|iface| {
			let loopback = iface.is_loopback();
			let up = !matches!(
				iface.oper_status,
				if_addrs::IfOperStatus::Down
					| if_addrs::IfOperStatus::NotPresent
					| if_addrs::IfOperStatus::LowerLayerDown
			);
			let (ip, netmask) = match iface.addr {
				if_addrs::IfAddr::V4(v4) => (IpAddr::V4(v4.ip), IpAddr::V4(v4.netmask)),
				if_addrs::IfAddr::V6(v6) => (IpAddr::V6(v6.ip), IpAddr::V6(v6.netmask)),
			};
			InterfaceAddr { name: iface.name, ip, netmask, loopback, up }
		})
		.collect())
}

/// Name prefixes (lower-case) of virtual adapters: Hyper-V/WSL, Docker,
/// Linux bridges/veth pairs, libvirt, VirtualBox/VMware host-only, LXC/LXD,
/// Podman, CNI/flannel.
const VIRTUAL_PREFIXES: &[&str] = &[
	"vethernet",
	"docker",
	"br-",
	"veth",
	"virbr",
	"vboxnet",
	"vmnet",
	"lxc",
	"lxd",
	"podman",
	"cni",
	"flannel",
];
/// Substrings (lower-case) of virtual adapter names (Windows friendly names).
const VIRTUAL_SUBSTRINGS: &[&str] = &["virtualbox", "vmware", "hyper-v"];

/// True when `name` looks like a virtual adapter nobody on the LAN listens on.
pub fn is_virtual_adapter(name: &str) -> bool {
	let lower = name.to_ascii_lowercase();
	VIRTUAL_PREFIXES.iter().any(|p| lower.starts_with(p))
		|| VIRTUAL_SUBSTRINGS.iter().any(|s| lower.contains(s))
}

/// True for an address mDNS may run on at all: up, non-loopback IPv4 (the
/// LAN listener binds `0.0.0.0`).
const fn is_mdns_candidate(addr: &InterfaceAddr) -> bool {
	addr.ip.is_ipv4() && addr.up && !addr.loopback
}

/// True when no physical (non-virtual by name) candidate exists, so mDNS has
/// to fall back to virtual adapters (a host whose only uplink is a bridge).
pub fn mdns_needs_virtual_fallback(all: &[InterfaceAddr]) -> bool {
	!all
		.iter()
		.any(|a| is_mdns_candidate(a) && !is_virtual_adapter(&a.name))
}

/// Per-interface mDNS rule given the fallback decision: IPv4, not loopback,
/// and not a virtual adapter unless falling back.
pub fn mdns_interface_allowed(name: &str, ip: IpAddr, loopback: bool, fallback: bool) -> bool {
	ip.is_ipv4() && !loopback && (fallback || !is_virtual_adapter(name))
}

/// Picks the IPv4 addresses to run mDNS on: up candidates allowed by
/// [`mdns_interface_allowed`] under [`mdns_needs_virtual_fallback`].
/// Duplicate addresses are dropped.
pub fn select_mdns_interfaces(all: &[InterfaceAddr]) -> Vec<InterfaceAddr> {
	let fallback = mdns_needs_virtual_fallback(all);
	let mut out: Vec<InterfaceAddr> = Vec::new();
	for addr in all {
		if is_mdns_candidate(addr)
			&& mdns_interface_allowed(&addr.name, addr.ip, addr.loopback, fallback)
			&& !out.iter().any(|c| c.ip == addr.ip)
		{
			out.push(addr.clone());
		}
	}
	out
}

/// [`select_mdns_interfaces`] over the live interface list.
pub fn eligible_mdns_interfaces() -> io::Result<Vec<InterfaceAddr>> {
	Ok(select_mdns_interfaces(&local_interface_addrs()?))
}

/// True when `a` and `b` are IPv4 addresses on the network `netmask` defines.
pub fn same_ipv4_subnet(a: Ipv4Addr, b: Ipv4Addr, netmask: Ipv4Addr) -> bool {
	let mask = u32::from(netmask);
	u32::from(a) & mask == u32::from(b) & mask
}

/// True when `addr` reaches this machine: loopback, unspecified, or one of
/// `own` (compared after IPv4-mapped IPv6 normalization on both sides).
pub fn is_same_machine_in(addr: IpAddr, own: &[IpAddr]) -> bool {
	let addr = addr.to_canonical();
	addr.is_loopback() || addr.is_unspecified() || own.iter().any(|o| o.to_canonical() == addr)
}

/// How long the own-address list behind [`is_same_machine`] is reused.
const OWN_ADDRS_TTL: Duration = Duration::from_secs(5);

/// Own interface addresses, re-enumerated at most every [`OWN_ADDRS_TTL`].
fn own_addrs() -> Arc<[IpAddr]> {
	static CACHE: Mutex<Option<(std::time::Instant, Arc<[IpAddr]>)>> = Mutex::new(None);
	let mut cache = CACHE.lock();
	if let Some((at, addrs)) = cache.as_ref()
		&& at.elapsed() < OWN_ADDRS_TTL
	{
		return Arc::clone(addrs);
	}
	let addrs: Arc<[IpAddr]> =
		local_interface_addrs().map_or_default(|addrs| addrs.into_iter().map(|a| a.ip).collect());
	*cache = Some((std::time::Instant::now(), Arc::clone(&addrs)));
	addrs
}

/// [`is_same_machine_in`] against our interface addresses (cached for 5 s).
/// When interfaces can't be enumerated only loopback/unspecified count.
pub fn is_same_machine(addr: IpAddr) -> bool {
	is_same_machine_in(addr, &own_addrs())
}

/// Blocking resolver used by [`ReverseDns`]; `None` = no name.
pub type Resolver = Arc<dyn Fn(IpAddr) -> Option<String> + Send + Sync>;

/// Tunables for [`ReverseDns`].
#[derive(Debug, Clone, Copy)]
pub struct ReverseDnsConfig {
	/// Max cached addresses (hits and misses).
	pub capacity: usize,
	/// How long an answer (or a miss) is reused.
	pub ttl:      Duration,
	/// Bound on one lookup; the resolver thread itself can't be cancelled.
	pub timeout:  Duration,
}

impl Default for ReverseDnsConfig {
	fn default() -> Self {
		Self {
			capacity: 256,
			ttl:      Duration::from_mins(10),
			timeout:  Duration::from_millis(1500),
		}
	}
}

struct Entry {
	expires_at: Instant,
	name:       Arc<OnceCell<Option<String>>>,
}

/// PTR-name cache: bounded, TTL'd (misses included), concurrent lookups of
/// one address share a single resolver call. Cheap to clone.
#[derive(Clone)]
pub struct ReverseDns {
	cfg:      ReverseDnsConfig,
	resolver: Resolver,
	entries:  Arc<Mutex<HashMap<IpAddr, Entry>>>,
}

impl Default for ReverseDns {
	fn default() -> Self {
		Self::new(ReverseDnsConfig::default())
	}
}

impl ReverseDns {
	/// Cache backed by the system resolver (`getnameinfo`).
	pub fn new(cfg: ReverseDnsConfig) -> Self {
		Self::with_resolver(cfg, Arc::new(system_reverse_lookup))
	}

	/// Cache backed by a custom blocking resolver.
	pub fn with_resolver(cfg: ReverseDnsConfig, resolver: Resolver) -> Self {
		Self { cfg, resolver, entries: Arc::new(Mutex::new(HashMap::new())) }
	}

	/// PTR name for `addr`, or `None` on miss/failure/timeout.
	pub async fn lookup(&self, addr: IpAddr) -> Option<String> {
		let addr = addr.to_canonical();
		let cell = self.cell_for(addr);
		cell
			.get_or_init(|| {
				let resolver = Arc::clone(&self.resolver);
				let timeout = self.cfg.timeout;
				async move {
					let task = tokio::task::spawn_blocking(move || resolver(addr));
					match tokio::time::timeout(timeout, task).await {
						Ok(Ok(name)) => name.filter(|n| !n.is_empty()),
						_ => None,
					}
				}
			})
			.await
			.clone()
	}

	fn cell_for(&self, addr: IpAddr) -> Arc<OnceCell<Option<String>>> {
		let now = Instant::now();
		let mut entries = self.entries.lock();
		if let Some(entry) = entries.get(&addr)
			&& entry.expires_at > now
		{
			return Arc::clone(&entry.name);
		}
		if entries.len() >= self.cfg.capacity && !entries.contains_key(&addr) {
			entries.retain(|_, e| e.expires_at > now);
			while entries.len() >= self.cfg.capacity {
				let Some(oldest) = entries
					.iter()
					.min_by_key(|(_, e)| e.expires_at)
					.map(|(k, _)| *k)
				else {
					break;
				};
				entries.remove(&oldest);
			}
		}
		let name = Arc::new(OnceCell::new());
		entries.insert(addr, Entry { expires_at: now + self.cfg.ttl, name: Arc::clone(&name) });
		name
	}
}

fn system_reverse_lookup(addr: IpAddr) -> Option<String> {
	let name = dns_lookup::lookup_addr(&addr).ok()?;
	let name = name.trim_end_matches('.');
	// Some resolvers echo the numeric form back despite NI_NAMEREQD.
	(name.parse::<IpAddr>().is_err() && !name.is_empty()).then(|| name.to_owned())
}

#[cfg(test)]
mod tests {
	use std::sync::atomic::{AtomicUsize, Ordering};

	use super::*;

	fn iface(name: &str, ip: &str, loopback: bool) -> InterfaceAddr {
		let ip: IpAddr = ip.parse().unwrap();
		let netmask = if ip.is_ipv4() {
			IpAddr::V4(Ipv4Addr::new(255, 255, 255, 0))
		} else {
			"ffff:ffff:ffff:ffff::".parse().unwrap()
		};
		InterfaceAddr { name: name.into(), ip, netmask, loopback, up: true }
	}

	#[test]
	fn mdns_selection_drops_loopback_virtual_ipv6_and_down() {
		let mut down = iface("Wi-Fi", "10.0.0.5", false);
		down.up = false;
		let all = vec![
			iface("Loopback Pseudo-Interface 1", "127.0.0.1", true),
			iface("Ethernet", "192.168.0.121", false),
			iface("Ethernet", "fe80::1", false),
			iface("vEthernet (WSL (Hyper-V firewall))", "172.31.16.1", false),
			iface("docker0", "172.17.0.1", false),
			iface("br-1a2b", "172.18.0.1", false),
			iface("VirtualBox Host-Only Network", "192.168.56.1", false),
			iface("VMware Network Adapter VMnet8", "192.168.88.1", false),
			iface("lxdbr0", "10.10.0.1", false),
			down,
		];
		let picked: Vec<_> = select_mdns_interfaces(&all)
			.into_iter()
			.map(|a| a.ip)
			.collect();
		assert_eq!(picked, vec!["192.168.0.121".parse::<IpAddr>().unwrap()]);
	}

	#[test]
	fn mdns_selection_falls_back_to_virtual_when_nothing_else() {
		let all = vec![
			iface("lo", "127.0.0.1", true),
			iface("vEthernet (WSL)", "172.31.16.1", false),
			iface("docker0", "172.17.0.1", false),
			iface("docker0", "172.17.0.1", false),
		];
		let picked: Vec<_> = select_mdns_interfaces(&all)
			.into_iter()
			.map(|a| a.name)
			.collect();
		assert_eq!(picked, vec!["vEthernet (WSL)".to_owned(), "docker0".to_owned()]);
	}

	#[test]
	fn same_machine_normalizes_mapped_ipv6() {
		let own: Vec<IpAddr> = vec!["192.168.0.121".parse().unwrap(), "fe80::1".parse().unwrap()];
		for yes in [
			"127.0.0.1",
			"127.8.9.1",
			"::1",
			"0.0.0.0",
			"192.168.0.121",
			"::ffff:192.168.0.121",
			"::ffff:127.0.0.1",
			"fe80::1",
		] {
			assert!(is_same_machine_in(yes.parse().unwrap(), &own), "{yes}");
		}
		for no in ["192.168.0.122", "::ffff:192.168.0.122", "fe80::2", "10.0.0.1"] {
			assert!(!is_same_machine_in(no.parse().unwrap(), &own), "{no}");
		}
		let mapped_own = vec!["::ffff:10.0.0.7".parse().unwrap()];
		assert!(is_same_machine_in("10.0.0.7".parse().unwrap(), &mapped_own));
	}

	#[tokio::test]
	async fn reverse_dns_coalesces_and_caches_misses() {
		let calls = Arc::new(AtomicUsize::new(0));
		let counter = Arc::clone(&calls);
		let dns = ReverseDns::with_resolver(
			ReverseDnsConfig {
				capacity: 4,
				ttl:      Duration::from_secs(60),
				timeout:  Duration::from_secs(5),
			},
			Arc::new(move |addr| {
				counter.fetch_add(1, Ordering::SeqCst);
				std::thread::sleep(Duration::from_millis(50));
				(addr == IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))).then(|| "box.lan".to_owned())
			}),
		);
		let hit: IpAddr = "10.0.0.1".parse().unwrap();
		let (a, b, c) = tokio::join!(
			dns.lookup(hit),
			dns.lookup(hit),
			dns.lookup("::ffff:10.0.0.1".parse().unwrap())
		);
		assert_eq!(
			(a.as_deref(), b.as_deref(), c.as_deref()),
			(Some("box.lan"), Some("box.lan"), Some("box.lan"))
		);
		assert_eq!(calls.load(Ordering::SeqCst), 1);

		let miss: IpAddr = "10.0.0.2".parse().unwrap();
		assert_eq!(dns.lookup(miss).await, None);
		assert_eq!(dns.lookup(miss).await, None);
		assert_eq!(calls.load(Ordering::SeqCst), 2);
	}

	#[tokio::test]
	async fn reverse_dns_times_out_expires_and_stays_bounded() {
		let calls = Arc::new(AtomicUsize::new(0));
		let counter = Arc::clone(&calls);
		let dns = ReverseDns::with_resolver(
			ReverseDnsConfig {
				capacity: 2,
				ttl:      Duration::from_millis(300),
				timeout:  Duration::from_millis(30),
			},
			Arc::new(move |addr| {
				counter.fetch_add(1, Ordering::SeqCst);
				if addr == IpAddr::V4(Ipv4Addr::new(10, 0, 0, 9)) {
					std::thread::sleep(Duration::from_millis(200));
				}
				Some("name".to_owned())
			}),
		);
		assert_eq!(dns.lookup("10.0.0.9".parse().unwrap()).await, None, "slow resolver times out");

		for i in 1..=5u8 {
			assert_eq!(
				dns.lookup(IpAddr::V4(Ipv4Addr::new(10, 0, 1, i)))
					.await
					.as_deref(),
				Some("name")
			);
			assert!(dns.entries.lock().len() <= 2);
		}
		let before = calls.load(Ordering::SeqCst);
		let recent = IpAddr::V4(Ipv4Addr::new(10, 0, 1, 5));
		dns.lookup(recent).await;
		assert_eq!(calls.load(Ordering::SeqCst), before, "most recent entry survived eviction");
		tokio::time::sleep(Duration::from_millis(350)).await;
		dns.lookup(recent).await;
		assert_eq!(calls.load(Ordering::SeqCst), before + 1, "expired entry re-resolves");
	}
}
