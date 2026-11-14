//! Socket-free mDNS bookkeeping: TXT encoding/parsing, peer filtering,
//! address choice and change-only event emission.

use std::{collections::HashMap, net::IpAddr};

use crate::{net::InterfaceAddr, protocol::is_instance_id};

/// DNS-SD service type announced and browsed.
pub const SERVICE_TYPE: &str = "_omp-mesh._tcp.local.";
/// TXT `v` value this engine speaks.
pub const TXT_VERSION: &str = "1";
/// Max UTF-8 bytes of the TXT `n` (display name) value, sent and accepted.
pub const MAX_DISPLAY_NAME_BYTES: usize = 200;
/// Max bytes of a group tag carried in TXT `g` (fits one TXT string).
const MAX_GROUP_TAG_BYTES: usize = 64;

/// Peer seen on the LAN with our group tag.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MdnsPeer {
	pub instance_id:  String,
	pub display_name: String,
	pub group_tag:    String,
	/// LAN listener port from SRV.
	pub port:         u16,
	/// mDNS host name without the trailing dot, e.g. `box.local`.
	pub hostname:     String,
	/// Every advertised IPv4 address (the LAN listener binds `0.0.0.0`),
	/// sorted, deduplicated.
	pub addresses:    Vec<IpAddr>,
	/// The address to dial (see [`pick_address`]); one of `addresses`.
	pub address:      IpAddr,
}

/// Change in the set of discovered peers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiscoveryEvent {
	/// Peer appeared or one of its fields changed.
	PeerUp(MdnsPeer),
	/// Peer said goodbye, expired, left our group, or discovery stopped.
	PeerDown { instance_id: String },
}

/// Longest prefix of `s` that is at most `max` bytes and ends on a char
/// boundary.
pub fn truncate_utf8(s: &str, max: usize) -> &str {
	if s.len() <= max {
		return s;
	}
	let mut end = max;
	while !s.is_char_boundary(end) {
		end -= 1;
	}
	&s[..end]
}

/// TXT properties we announce: exactly `v`, `id`, `g`, `n`.
pub fn txt_properties(
	instance_id: &str,
	group_tag: &str,
	display_name: &str,
) -> [(&'static str, String); 4] {
	[
		("v", TXT_VERSION.to_owned()),
		("id", instance_id.to_owned()),
		("g", group_tag.to_owned()),
		("n", truncate_utf8(display_name, MAX_DISPLAY_NAME_BYTES).to_owned()),
	]
}

/// True when `tag` can be announced in TXT `g` and compared byte-for-byte.
pub fn is_group_tag(tag: &str) -> bool {
	!tag.is_empty() && tag.len() <= MAX_GROUP_TAG_BYTES && tag.bytes().all(|b| b.is_ascii_graphic())
}

/// A resolved service as delivered by the daemon, reduced to what we read.
#[derive(Clone, Copy)]
pub struct Resolved<'a> {
	/// `<instance>._omp-mesh._tcp.local.`
	pub fullname:  &'a str,
	/// SRV target, e.g. `box.local.`.
	pub host:      &'a str,
	pub port:      u16,
	/// TXT lookup: `None` = key absent; `Some(None)` = key without value.
	pub txt:       &'a dyn Fn(&str) -> Option<Option<&'a [u8]>>,
	pub addresses: &'a [IpAddr],
}

fn txt_str<'a>(r: &Resolved<'a>, key: &str) -> Option<&'a str> {
	std::str::from_utf8((r.txt)(key)??).ok()
}

/// Parses a resolved service of another instance and picks its address
/// (`previous` / `ifaces`: see [`pick_address`]); group/own-id filtering is
/// the tracker's job. Unknown TXT keys are ignored.
///
/// Rejects other protocol versions, malformed ids, ids that differ from the
/// DNS-SD instance label (no claiming another instance's id), port 0 and
/// services without a usable IPv4 address.
pub fn parse_resolved(
	r: &Resolved<'_>,
	previous: Option<IpAddr>,
	ifaces: &[InterfaceAddr],
) -> Option<MdnsPeer> {
	if txt_str(r, "v")? != TXT_VERSION {
		return None;
	}
	let instance_id = txt_str(r, "id")?;
	if !is_instance_id(instance_id) {
		return None;
	}
	let label = instance_label(r.fullname)?;
	if !label.eq_ignore_ascii_case(instance_id) {
		return None;
	}
	let group_tag = txt_str(r, "g")?;
	if !is_group_tag(group_tag) || r.port == 0 {
		return None;
	}
	let display_name = match txt_str(r, "n") {
		Some(n) if !n.trim().is_empty() => truncate_utf8(n, MAX_DISPLAY_NAME_BYTES).to_owned(),
		_ => instance_id.to_owned(),
	};
	let mut addresses: Vec<IpAddr> = r
		.addresses
		.iter()
		.map(|a| a.to_canonical())
		.filter(|a| a.is_ipv4() && !a.is_unspecified() && !a.is_multicast())
		.collect();
	addresses.sort_unstable();
	addresses.dedup();
	let address = pick_address(&addresses, previous, ifaces)?;
	Some(MdnsPeer {
		instance_id: instance_id.to_owned(),
		display_name,
		group_tag: group_tag.to_owned(),
		port: r.port,
		hostname: r.host.trim_end_matches('.').to_owned(),
		addresses,
		address,
	})
}

/// Instance label of `<label>._omp-mesh._tcp.local.` (case-insensitive type).
pub fn instance_label(fullname: &str) -> Option<&str> {
	let suffix_start = fullname.len().checked_sub(SERVICE_TYPE.len() + 1)?;
	let (label, rest) = fullname.split_at_checked(suffix_start)?;
	(rest.as_bytes()[0] == b'.' && rest[1..].eq_ignore_ascii_case(SERVICE_TYPE) && !label.is_empty())
		.then_some(label)
}

/// Chooses the address to dial, or `None` when the peer has no usable one.
///
/// mDNS is link-local, so while we know our interfaces only addresses on
/// one of their subnets are usable (an announcement pointing elsewhere is
/// bogus or unreachable). Without interface data any non-link-local address
/// is preferred. Keeps `previous` while still usable (no flapping between a
/// multi-homed peer's addresses).
pub fn pick_address(
	addresses: &[IpAddr],
	previous: Option<IpAddr>,
	ifaces: &[InterfaceAddr],
) -> Option<IpAddr> {
	let on_our_subnet = |addr: &IpAddr| on_our_subnet(*addr, ifaces);
	let usable = |addr: &IpAddr| ifaces.is_empty() || on_our_subnet(addr);
	if let Some(prev) = previous
		&& addresses.contains(&prev)
		&& usable(&prev)
	{
		return Some(prev);
	}
	if !ifaces.is_empty() {
		return addresses.iter().find(|a| on_our_subnet(a)).copied();
	}
	addresses
		.iter()
		.find(|a| !matches!(a, IpAddr::V4(v4) if v4.is_link_local()))
		.or_else(|| addresses.first())
		.copied()
}

/// True when `addr` is an IPv4 address on the subnet of one of `ifaces`.
pub fn on_our_subnet(addr: IpAddr, ifaces: &[InterfaceAddr]) -> bool {
	let IpAddr::V4(a) = addr else { return false };
	ifaces.iter().any(|iface| match (iface.ip, iface.netmask) {
		(IpAddr::V4(ip), IpAddr::V4(mask)) => crate::net::same_ipv4_subnet(a, ip, mask),
		_ => false,
	})
}

/// Peers currently up, keyed by lower-cased DNS-SD fullname.
#[derive(Debug)]
pub struct PeerTracker {
	own_id:    String,
	group_tag: String,
	peers:     HashMap<String, MdnsPeer>,
}

impl PeerTracker {
	pub fn new(own_id: &str, group_tag: &str) -> Self {
		Self {
			own_id:    own_id.to_owned(),
			group_tag: group_tag.to_owned(),
			peers:     HashMap::new(),
		}
	}

	/// Applies a resolve; returns the event to emit, if anything changed.
	/// A known peer that now announces another group tag (key changed) or
	/// becomes unparseable goes down.
	pub fn on_resolved(
		&mut self,
		r: &Resolved<'_>,
		ifaces: &[InterfaceAddr],
	) -> Option<DiscoveryEvent> {
		let key = r.fullname.to_ascii_lowercase();
		let previous = self.peers.get(&key);
		let parsed = parse_resolved(r, previous.map(|p| p.address), ifaces).filter(|peer| {
			peer.group_tag == self.group_tag && !peer.instance_id.eq_ignore_ascii_case(&self.own_id)
		});
		let Some(peer) = parsed else {
			return self
				.peers
				.remove(&key)
				.map(|gone| DiscoveryEvent::PeerDown { instance_id: gone.instance_id });
		};
		if previous == Some(&peer) {
			return None;
		}
		self.peers.insert(key, peer.clone());
		Some(DiscoveryEvent::PeerUp(peer))
	}

	/// Applies a removal (goodbye or TTL expiry).
	pub fn on_removed(&mut self, fullname: &str) -> Option<DiscoveryEvent> {
		self
			.peers
			.remove(&fullname.to_ascii_lowercase())
			.map(|gone| DiscoveryEvent::PeerDown { instance_id: gone.instance_id })
	}

	/// Forgets every peer, returning a `PeerDown` for each.
	pub fn clear(&mut self) -> Vec<DiscoveryEvent> {
		self
			.peers
			.drain()
			.map(|(_, gone)| DiscoveryEvent::PeerDown { instance_id: gone.instance_id })
			.collect()
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	const OWN: &str = "0123456789abcdef";
	const PEER: &str = "fedcba9876543210";
	const TAG: &str = "a1b2c3d4e5f60718";

	struct Svc {
		fullname:  String,
		host:      String,
		port:      u16,
		txt:       Vec<(String, Option<Vec<u8>>)>,
		addresses: Vec<IpAddr>,
	}

	impl Svc {
		fn new(id: &str, tag: &str) -> Self {
			Self {
				fullname:  format!("{id}.{SERVICE_TYPE}"),
				host:      "box.local.".into(),
				port:      4747,
				txt:       vec![
					("v".into(), Some(b"1".to_vec())),
					("id".into(), Some(id.as_bytes().to_vec())),
					("g".into(), Some(tag.as_bytes().to_vec())),
					("n".into(), Some(b"box".to_vec())),
				],
				addresses: vec!["192.168.0.50".parse().unwrap()],
			}
		}

		fn set(mut self, key: &str, val: Option<&[u8]>) -> Self {
			self.txt.retain(|(k, _)| k != key);
			self.txt.push((key.into(), val.map(<[u8]>::to_vec)));
			self
		}

		fn with<R>(&self, f: impl FnOnce(&Resolved<'_>) -> R) -> R {
			let lookup = |key: &str| {
				self
					.txt
					.iter()
					.find(|(k, _)| k == key)
					.map(|(_, v)| v.as_deref())
			};
			f(&Resolved {
				fullname:  &self.fullname,
				host:      &self.host,
				port:      self.port,
				txt:       &lookup,
				addresses: &self.addresses,
			})
		}
	}

	fn eth() -> Vec<InterfaceAddr> {
		vec![InterfaceAddr {
			name:     "Ethernet".into(),
			ip:       "192.168.0.121".parse().unwrap(),
			netmask:  "255.255.255.0".parse().unwrap(),
			loopback: false,
			up:       true,
		}]
	}

	#[test]
	fn txt_announces_exactly_four_keys_with_truncated_name() {
		let long = "é".repeat(150); // 300 bytes
		let props = txt_properties(OWN, TAG, &long);
		assert_eq!(props.each_ref().map(|(k, _)| *k), ["v", "id", "g", "n"]);
		assert_eq!(props[3].1.len(), MAX_DISPLAY_NAME_BYTES);
		assert!(props[3].1.chars().all(|c| c == 'é'));
		assert_eq!(truncate_utf8("aé", 2), "a");
	}

	#[test]
	fn parse_rejects_bad_records() {
		let cases: Vec<(&str, Svc)> = vec![
			("wrong version", Svc::new(PEER, TAG).set("v", Some(b"2"))),
			("missing version", Svc::new(PEER, TAG).set("v", None)),
			("bad id", Svc::new("bad/id!", TAG)),
			("id differs from instance label", {
				let mut s = Svc::new(PEER, TAG);
				s.fullname = format!("{OWN}.{SERVICE_TYPE}");
				s
			}),
			("other service type", {
				let mut s = Svc::new(PEER, TAG);
				s.fullname = format!("{PEER}._http._tcp.local.");
				s
			}),
			("empty group", Svc::new(PEER, "")),
			("non-utf8 id", Svc::new(PEER, TAG).set("id", Some(&[0xff, 0xfe]))),
			("port zero", {
				let mut s = Svc::new(PEER, TAG);
				s.port = 0;
				s
			}),
			("ipv6 only", {
				let mut s = Svc::new(PEER, TAG);
				s.addresses = vec!["fe80::1".parse().unwrap()];
				s
			}),
		];
		for (what, svc) in cases {
			assert_eq!(svc.with(|r| parse_resolved(r, None, &[])), None, "{what}");
		}
	}

	#[test]
	fn parse_normalizes_fields() {
		let mut svc = Svc::new(PEER, TAG)
			.set("n", Some("x".repeat(300).as_bytes()))
			.set("extra", Some(b"zzz"));
		svc.fullname = format!("{}.{}", PEER.to_uppercase(), SERVICE_TYPE.to_uppercase());
		svc.addresses = vec![
			"::ffff:192.168.0.60".parse().unwrap(),
			"fe80::1".parse().unwrap(),
			"192.168.0.50".parse().unwrap(),
			"192.168.0.60".parse().unwrap(),
		];
		let rec = svc.with(|r| parse_resolved(r, None, &[])).unwrap();
		assert_eq!(rec.display_name.len(), MAX_DISPLAY_NAME_BYTES);
		assert_eq!(rec.hostname, "box.local");
		assert_eq!(rec.addresses, vec![
			"192.168.0.50".parse::<IpAddr>().unwrap(),
			"192.168.0.60".parse().unwrap()
		]);
		let unnamed = Svc::new(PEER, TAG)
			.set("n", None)
			.with(|r| parse_resolved(r, None, &[]))
			.unwrap();
		assert_eq!(unnamed.display_name, PEER);
	}

	#[test]
	fn pick_keeps_previous_and_requires_our_subnet() {
		let ifaces = eth();
		let addrs: Vec<IpAddr> = vec![
			"169.254.3.4".parse().unwrap(),
			"172.31.16.9".parse().unwrap(),
			"192.168.0.50".parse().unwrap(),
			"192.168.0.51".parse().unwrap(),
		];
		assert_eq!(pick_address(&addrs, None, &ifaces), Some(addrs[2]));
		assert_eq!(pick_address(&addrs, Some(addrs[3]), &ifaces), Some(addrs[3]), "sticky");
		assert_eq!(
			pick_address(&addrs, Some(addrs[1]), &ifaces),
			Some(addrs[2]),
			"off-subnet previous dropped"
		);
		assert_eq!(pick_address(&addrs[..2], None, &ifaces), None, "nothing on our subnets");
		assert_eq!(
			pick_address(&addrs[..2], None, &[]),
			Some(addrs[1]),
			"no interface data: routable first"
		);
		assert_eq!(pick_address(&addrs[..1], None, &[]), Some(addrs[0]));
	}

	#[test]
	fn tracker_filters_dedupes_and_tracks_removal() {
		let ifaces = eth();
		let mut t = PeerTracker::new(OWN, TAG);
		assert_eq!(Svc::new(OWN, TAG).with(|r| t.on_resolved(r, &ifaces)), None, "own id");
		assert_eq!(
			Svc::new(PEER, "ffffffffffffffff").with(|r| t.on_resolved(r, &ifaces)),
			None,
			"foreign group"
		);

		let svc = Svc::new(PEER, TAG);
		let Some(DiscoveryEvent::PeerUp(up)) = svc.with(|r| t.on_resolved(r, &ifaces)) else {
			panic!("expected PeerUp");
		};
		assert_eq!((up.instance_id.as_str(), up.port, up.address), (PEER, 4747, svc.addresses[0]));
		assert_eq!(svc.with(|r| t.on_resolved(r, &ifaces)), None, "repeat resolve is silent");

		let renamed = Svc::new(PEER, TAG).set("n", Some(b"renamed"));
		assert!(
			matches!(renamed.with(|r| t.on_resolved(r, &ifaces)), Some(DiscoveryEvent::PeerUp(p)) if p.display_name == "renamed")
		);

		let rekeyed = Svc::new(PEER, "ffffffffffffffff");
		assert_eq!(
			rekeyed.with(|r| t.on_resolved(r, &ifaces)),
			Some(DiscoveryEvent::PeerDown { instance_id: PEER.into() })
		);
		assert_eq!(t.on_removed(&svc.fullname), None, "already down");

		svc.with(|r| t.on_resolved(r, &ifaces)).unwrap();
		assert_eq!(
			t.on_removed(&svc.fullname.to_uppercase()),
			Some(DiscoveryEvent::PeerDown { instance_id: PEER.into() })
		);
		svc.with(|r| t.on_resolved(r, &ifaces)).unwrap();
		assert_eq!(t.clear(), vec![DiscoveryEvent::PeerDown { instance_id: PEER.into() }]);
	}
}
