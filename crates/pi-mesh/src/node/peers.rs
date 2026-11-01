//! Peer table: one entry per instance id, merged from every source that
//! knows a way to reach it (local registry, mDNS, static peers, inbound
//! contacts), with snapshot cache, failure tracking and stale expiry.
//!
//! Pure bookkeeping: callers pass `now`, perform the I/O and feed results
//! back. An entry lives while it has at least one endpoint and is not
//! expired. Remote entries are only *listed* once a sealed snapshot proved
//! who answers there; until then they are unverified and invisible.
//!
//! mDNS is unauthenticated, so a new or changed mDNS address is only a
//! candidate: it becomes the route after a sealed snapshot fetched over it
//! names the expected instance ([`PeerTable::promote_mdns`]). The previous
//! working route stays in use meanwhile.

use std::{
	collections::HashMap,
	net::{IpAddr, SocketAddr},
	sync::Arc,
	time::{Duration, Instant},
};

use pi_instances::InstanceEntry;
use serde::Serialize;

use crate::transport::Endpoint;

/// Consecutive failed contacts after which a verified peer is marked stale.
pub const STALE_AFTER_FAILURES: u32 = 3;
/// How long a stale peer lingers before removal.
pub const STALE_REMOVE_AFTER: Duration = Duration::from_mins(2);
/// Cap on peers without a local endpoint (bounds contact churn). Static
/// peers are exempt (explicit configuration).
pub const MAX_REMOTE_PEERS: usize = 512;
/// Cap on unverified mDNS candidate-only entries (anyone on the LAN can
/// announce ids); the oldest is evicted when a new one arrives.
pub const MAX_CANDIDATES: usize = 64;

/// Who is creating a table entry; decides how caps apply.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Admit {
	/// Local registry (owner-only, trusted): uncapped.
	Local,
	/// Configured static peer that answered a sealed probe: uncapped.
	Static,
	/// Sealed inbound contact: at the remote cap, evicts a candidate.
	Authenticated,
	/// Unauthenticated mDNS announcement: own small cap, oldest evicted.
	Candidate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EndpointKind {
	Local,
	Remote,
}

/// Where a peer's best endpoint came from (precedence: local > mdns >
/// static > contact).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PeerSource {
	Local,
	Mdns,
	Static,
	Contact,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PeerState {
	Online,
	Stale,
}

/// LAN endpoint learned from mDNS.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MdnsEndpoint {
	pub addr:     SocketAddr,
	pub hostname: String,
}

/// What the frontend sees (N-API `MeshPeerInfo`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerInfo {
	pub instance_id:   String,
	pub endpoint_kind: EndpointKind,
	pub address:       Option<String>,
	pub port:          Option<u16>,
	pub hostname:      Option<String>,
	pub dns_name:      Option<String>,
	pub source:        PeerSource,
	pub state:         PeerState,
	/// ms since the Unix epoch.
	pub last_seen:     u64,
	pub hidden:        bool,
	pub blocked:       bool,
	pub snapshot_json: Option<Arc<str>>,
}

#[derive(Debug, Default)]
struct Peer {
	/// Registry entry (Unix socket / named pipe) of a same-machine instance.
	local:          Option<InstanceEntry>,
	/// Verified mDNS route.
	mdns:           Option<MdnsEndpoint>,
	/// Announced but not yet verified mDNS address.
	mdns_candidate: Option<MdnsEndpoint>,
	static_addr:    Option<SocketAddr>,
	contact:        Option<SocketAddr>,
	/// Validated snapshot JSON (unknown fields already dropped).
	snapshot:       Option<Arc<str>>,
	dns_name:       Option<(IpAddr, String)>,
	failures:       u32,
	stale_since:    Option<Instant>,
	/// ms since the Unix epoch.
	last_seen:      u64,
	/// Creation order, for evicting the oldest candidate.
	seq:            u64,
}

impl Peer {
	const fn has_endpoint(&self) -> bool {
		self.local.is_some()
			|| self.mdns.is_some()
			|| self.mdns_candidate.is_some()
			|| self.static_addr.is_some()
			|| self.contact.is_some()
	}

	/// Listed and refreshed: locally registered, or proven by a snapshot.
	const fn verified(&self) -> bool {
		self.local.is_some() || self.snapshot.is_some()
	}

	/// Nothing but an unverified mDNS announcement.
	const fn candidate_only(&self) -> bool {
		self.mdns_candidate.is_some()
			&& self.local.is_none()
			&& self.mdns.is_none()
			&& self.static_addr.is_none()
			&& self.contact.is_none()
			&& self.snapshot.is_none()
	}

	fn remote_addr(&self) -> Option<SocketAddr> {
		self
			.mdns
			.as_ref()
			.map(|m| m.addr)
			.or(self.static_addr)
			.or(self.contact)
	}

	const fn source(&self) -> PeerSource {
		if self.local.is_some() {
			PeerSource::Local
		} else if self.mdns.is_some() {
			PeerSource::Mdns
		} else if self.static_addr.is_some() {
			PeerSource::Static
		} else {
			PeerSource::Contact
		}
	}

	fn seen(&mut self, now_ms: u64) {
		self.last_seen = self.last_seen.max(now_ms);
	}
}

#[derive(Debug, Clone, Copy, Default)]
struct Flags {
	hidden:  bool,
	blocked: bool,
}

/// Result of a mutation: whether the visible list changed, and whether the
/// peer gained a new route (fetch its snapshot now).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Change {
	pub changed:      bool,
	pub new_endpoint: bool,
}

impl Change {
	const NONE: Self = Self { changed: false, new_endpoint: false };
	const REACHABLE: Self = Self { changed: true, new_endpoint: true };
	const UPDATED: Self = Self { changed: true, new_endpoint: false };
}

#[derive(Debug)]
pub struct PeerTable {
	own_id:   String,
	peers:    HashMap<String, Peer>,
	/// Survive removal so a rediscovered peer stays hidden/blocked.
	flags:    HashMap<String, Flags>,
	next_seq: u64,
}

impl PeerTable {
	pub fn new(own_id: &str) -> Self {
		Self {
			own_id:   own_id.to_owned(),
			peers:    HashMap::new(),
			flags:    HashMap::new(),
			next_seq: 0,
		}
	}

	/// Removes the oldest candidate-only entry; false when there is none.
	fn evict_oldest_candidate(&mut self) -> bool {
		let oldest = self
			.peers
			.iter()
			.filter(|(_, p)| p.candidate_only())
			.min_by_key(|(_, p)| p.seq)
			.map(|(id, _)| id.clone());
		oldest.is_some_and(|id| self.peers.remove(&id).is_some())
	}

	/// Entry for `id`, created on demand subject to the caps for `admit`.
	fn entry(&mut self, id: &str, admit: Admit) -> Option<&mut Peer> {
		if id == self.own_id {
			return None;
		}
		if !self.peers.contains_key(id) {
			let full =
				|| self.peers.values().filter(|p| p.local.is_none()).count() >= MAX_REMOTE_PEERS;
			let room = match admit {
				Admit::Local | Admit::Static => true,
				Admit::Authenticated => !full() || self.evict_oldest_candidate(),
				Admit::Candidate => {
					let candidates = self.peers.values().filter(|p| p.candidate_only()).count();
					(candidates < MAX_CANDIDATES && !full()) || self.evict_oldest_candidate()
				},
			};
			if !room {
				return None;
			}
			self.next_seq += 1;
			self
				.peers
				.insert(id.to_owned(), Peer { seq: self.next_seq, ..Peer::default() });
		}
		self.peers.get_mut(id)
	}

	/// Drops `id` when its last endpoint went away.
	fn prune(&mut self, id: &str) {
		if self.peers.get(id).is_some_and(|p| !p.has_endpoint()) {
			self.peers.remove(id);
		}
	}

	fn listed(&self, id: &str) -> bool {
		self.peers.get(id).is_some_and(Peer::verified)
	}

	/// Replaces the local endpoints with a fresh registry listing. Returns the
	/// overall change and the ids that became locally reachable.
	///
	/// An entry is a new endpoint only when its `(endpoint, token)` changed
	/// (a new listener); a rewrite of the same publication (e.g. its
	/// `capabilities`) is kept without counting as a change.
	pub fn set_local_listing(
		&mut self,
		listing: &[InstanceEntry],
		now_ms: u64,
	) -> (bool, Vec<String>) {
		let mut changed = false;
		let mut fresh = Vec::new();
		let listed: HashMap<&str, &InstanceEntry> = listing
			.iter()
			.filter(|e| e.instance_id != self.own_id)
			.map(|e| (e.instance_id.as_str(), e))
			.collect();
		let gone: Vec<String> = self
			.peers
			.iter()
			.filter(|(id, p)| p.local.is_some() && !listed.contains_key(id.as_str()))
			.map(|(id, _)| id.clone())
			.collect();
		for id in gone {
			changed |= self.drop_local(&id).is_some();
		}
		for (id, ep) in listed {
			let Some(peer) = self.entry(id, Admit::Local) else {
				continue;
			};
			peer.seen(now_ms);
			let same = peer
				.local
				.as_ref()
				.is_some_and(|cur| cur.endpoint == ep.endpoint && cur.token == ep.token);
			if !same {
				fresh.push(id.to_owned());
				changed = true;
			}
			peer.local = Some(ep.clone());
		}
		(changed, fresh)
	}

	/// Forgets `id`'s local endpoint (unlisted) and returns it.
	pub fn drop_local(&mut self, id: &str) -> Option<InstanceEntry> {
		let local = self.peers.get_mut(id)?.local.take()?;
		self.prune(id);
		Some(local)
	}

	/// Forgets `id`'s local endpoint only if it is still the one at
	/// `endpoint` with `token` (a concurrent re-listing may have replaced it).
	pub fn drop_local_if(&mut self, id: &str, endpoint: &str, token: &str) -> Option<InstanceEntry> {
		let current = self.peers.get(id)?.local.as_ref()?;
		if current.endpoint != endpoint || current.token != token {
			return None;
		}
		self.drop_local(id)
	}

	pub fn clear_local(&mut self) -> bool {
		self.clear_with(|p| p.local.take().is_some())
	}

	/// mDNS announced `id` at `ep`. Returns the address to verify when it is
	/// a new candidate; the current route is untouched.
	pub fn mdns_up(&mut self, id: &str, ep: MdnsEndpoint, now_ms: u64) -> Option<SocketAddr> {
		let peer = self.entry(id, Admit::Candidate)?;
		if peer.mdns.as_ref() == Some(&ep) {
			peer.seen(now_ms);
			peer.mdns_candidate = None;
			return None;
		}
		if peer.mdns_candidate.as_ref() == Some(&ep) {
			return None;
		}
		let addr = ep.addr;
		peer.mdns_candidate = Some(ep);
		Some(addr)
	}

	/// The candidate at `addr` answered a sealed snapshot as `id`: make it the
	/// mDNS route and store the snapshot.
	pub fn promote_mdns(
		&mut self,
		id: &str,
		addr: SocketAddr,
		json: Arc<str>,
		now_ms: u64,
	) -> Change {
		let Some(peer) = self.peers.get_mut(id) else {
			return Change::NONE;
		};
		if peer.mdns_candidate.as_ref().is_none_or(|c| c.addr != addr) {
			return Change::NONE;
		}
		peer.mdns = peer.mdns_candidate.take();
		let was_listed = peer.verified();
		peer.snapshot = Some(json);
		peer.failures = 0;
		peer.stale_since = None;
		peer.seen(now_ms);
		if was_listed {
			Change::UPDATED
		} else {
			Change::REACHABLE
		}
	}

	/// mDNS candidates awaiting verification.
	pub fn mdns_candidates(&self) -> Vec<(String, SocketAddr)> {
		self
			.peers
			.iter()
			.filter_map(|(id, p)| p.mdns_candidate.as_ref().map(|c| (id.clone(), c.addr)))
			.collect()
	}

	pub fn mdns_down(&mut self, id: &str) -> bool {
		let Some(peer) = self.peers.get_mut(id) else {
			return false;
		};
		peer.mdns_candidate = None;
		let changed = peer.mdns.take().is_some();
		self.prune(id);
		changed
	}

	pub fn clear_mdns(&mut self) -> bool {
		self.clear_with(|p| {
			p.mdns_candidate = None;
			p.mdns.take().is_some()
		})
	}

	/// The static peer at `addr` answered a sealed `*` snapshot as `id`.
	pub fn static_up(&mut self, id: &str, addr: SocketAddr, json: Arc<str>, now_ms: u64) -> Change {
		let Some(peer) = self.entry(id, Admit::Static) else {
			return Change::NONE;
		};
		let new_endpoint = peer.static_addr != Some(addr);
		let changed =
			new_endpoint || peer.snapshot.as_deref() != Some(&*json) || peer.stale_since.is_some();
		peer.static_addr = Some(addr);
		peer.snapshot = Some(json);
		peer.failures = 0;
		peer.stale_since = None;
		peer.seen(now_ms);
		Change { changed, new_endpoint }
	}

	/// Drops static endpoints whose `(address, id)` pair is not in `keep`
	/// (a restarted static peer answers at the same address with a new id).
	pub fn retain_static(&mut self, keep: &[(SocketAddr, String)]) -> bool {
		let mut changed = false;
		for (id, peer) in &mut self.peers {
			if let Some(addr) = peer.static_addr
				&& !keep.iter().any(|(a, i)| *a == addr && i == id)
			{
				peer.static_addr = None;
				changed |= peer.verified();
			}
		}
		self.peers.retain(|_, p| p.has_endpoint());
		changed
	}

	/// Learns a remote endpoint from an authenticated inbound message. Only
	/// fills the gap when the peer has no other remote endpoint. A peer still
	/// unverified asks for another snapshot fetch on every (rate-limited)
	/// message, so a first fetch answered e.g. `unsupported` is retried.
	pub fn learn_contact(&mut self, id: &str, addr: SocketAddr, now_ms: u64) -> Change {
		let Some(peer) = self.entry(id, Admit::Authenticated) else {
			return Change::NONE;
		};
		peer.seen(now_ms);
		if peer.mdns.is_some() || peer.static_addr.is_some() {
			return Change::NONE;
		}
		if peer.contact == Some(addr) {
			return Change { changed: false, new_endpoint: !peer.verified() };
		}
		let first = peer.remote_addr().is_none() && peer.local.is_none();
		peer.contact = Some(addr);
		Change { changed: peer.verified(), new_endpoint: first || !peer.verified() }
	}

	pub fn clear_remote(&mut self) -> bool {
		self.clear_with(|p| {
			let had = p.verified() && p.remote_addr().is_some();
			p.mdns = None;
			p.mdns_candidate = None;
			p.static_addr = None;
			p.contact = None;
			had
		})
	}

	fn clear_with(&mut self, mut f: impl FnMut(&mut Peer) -> bool) -> bool {
		let mut changed = false;
		for peer in self.peers.values_mut() {
			changed |= f(peer);
		}
		self.peers.retain(|_, p| p.has_endpoint());
		changed
	}

	/// Stores a validated snapshot fetched over `id`'s current route.
	pub fn snapshot_ok(&mut self, id: &str, json: Arc<str>, now_ms: u64) -> bool {
		let Some(peer) = self.peers.get_mut(id) else {
			return false;
		};
		peer.seen(now_ms);
		peer.failures = 0;
		peer.stale_since = None;
		let changed = peer.snapshot.as_deref() != Some(&*json);
		peer.snapshot = Some(json);
		changed
	}

	/// Successful exchange other than a snapshot. Only verified peers count:
	/// an unverified one must still prove itself with a snapshot.
	pub fn contact_ok(&mut self, id: &str, now_ms: u64) -> bool {
		let Some(peer) = self.peers.get_mut(id) else {
			return false;
		};
		peer.seen(now_ms);
		if !peer.verified() {
			return false;
		}
		peer.failures = 0;
		peer.stale_since.take().is_some()
	}

	/// A peer answered a snapshot fetch without a snapshot (e.g.
	/// `unsupported`, `busy`). Alive for verified peers; a failure for
	/// unverified ones, which then age out unless they later prove
	/// themselves.
	pub fn fetch_answered(&mut self, id: &str, now_ms: u64, now: Instant) -> bool {
		if self.listed(id) {
			self.contact_ok(id, now_ms)
		} else {
			self.contact_failed(id, now)
		}
	}

	/// Failed exchange; true when this made a listed peer stale. Unverified
	/// peers go stale on their first failure.
	pub fn contact_failed(&mut self, id: &str, now: Instant) -> bool {
		let Some(peer) = self.peers.get_mut(id) else {
			return false;
		};
		peer.failures = peer.failures.saturating_add(1);
		let threshold = if peer.verified() {
			STALE_AFTER_FAILURES
		} else {
			1
		};
		if peer.failures >= threshold && peer.stale_since.is_none() {
			peer.stale_since = Some(now);
			return peer.verified();
		}
		false
	}

	/// Removes peers stale for longer than [`STALE_REMOVE_AFTER`], except
	/// ones the local registry or mDNS still announce: they stay (marked
	/// stale) until the registry drops them or mDNS reports them gone. An
	/// unverified mDNS candidate is retried every refresh until mDNS drops it
	/// or a newer one replaces it; [`MAX_CANDIDATES`] bounds that cost.
	pub fn sweep(&mut self, now: Instant) -> bool {
		let mut changed = false;
		self.peers.retain(|_, p| {
			let keep = p.local.is_some()
				|| p.mdns.is_some()
				|| p.mdns_candidate.is_some()
				|| p
					.stale_since
					.is_none_or(|since| now.duration_since(since) < STALE_REMOVE_AFTER);
			changed |= !keep && p.verified();
			keep
		});
		changed
	}

	pub fn set_dns_name(&mut self, id: &str, ip: IpAddr, name: String) -> bool {
		let Some(peer) = self.peers.get_mut(id) else {
			return false;
		};
		if peer.remote_addr().map(|a| a.ip()) != Some(ip)
			|| peer
				.dns_name
				.as_ref()
				.is_some_and(|(i, n)| *i == ip && *n == name)
		{
			return false;
		}
		peer.dns_name = Some((ip, name));
		peer.verified()
	}

	pub fn set_flags(&mut self, id: &str, hidden: bool, blocked: bool) -> bool {
		let flags = self.flags.entry(id.to_owned()).or_default();
		let changed = flags.hidden != hidden || flags.blocked != blocked;
		*flags = Flags { hidden, blocked };
		changed && self.listed(id)
	}

	pub fn is_blocked(&self, id: &str) -> bool {
		self.flags.get(id).is_some_and(|f| f.blocked)
	}

	#[cfg(test)]
	pub fn contains(&self, id: &str) -> bool {
		self.peers.contains_key(id)
	}

	/// Best route given which sides are running: local first.
	pub fn route(&self, id: &str, local_on: bool, remote_on: bool) -> Option<Endpoint> {
		let peer = self.peers.get(id)?;
		if local_on && let Some(local) = &peer.local {
			return Some(Endpoint::Local(local.clone()));
		}
		if remote_on {
			return peer.remote_addr().map(|addr| Endpoint::Remote { addr });
		}
		None
	}

	/// Remote address of `id` that has no reverse name yet.
	pub fn remote_ip(&self, id: &str) -> Option<IpAddr> {
		let peer = self.peers.get(id)?;
		let ip = peer.remote_addr()?.ip();
		(peer.dns_name.as_ref().map(|(i, _)| *i) != Some(ip)).then_some(ip)
	}

	/// Peers the periodic refresh fetches snapshots for (listed ones).
	pub fn refresh_ids(&self) -> Vec<String> {
		self
			.peers
			.iter()
			.filter(|(_, p)| p.verified())
			.map(|(id, _)| id.clone())
			.collect()
	}

	pub fn infos(&self) -> Vec<PeerInfo> {
		let mut out: Vec<PeerInfo> = self
			.peers
			.iter()
			.filter(|(_, p)| p.verified())
			.map(|(id, p)| {
				let flags = self.flags.get(id).copied().unwrap_or_default();
				let remote = p.remote_addr();
				let (endpoint_kind, address, port) = match (&p.local, remote) {
					(Some(_), _) => (EndpointKind::Local, None, None),
					(None, Some(addr)) => {
						(EndpointKind::Remote, Some(addr.ip().to_string()), Some(addr.port()))
					},
					(None, None) => (EndpointKind::Remote, None, None),
				};
				PeerInfo {
					instance_id: id.clone(),
					endpoint_kind,
					address,
					port,
					hostname: p.mdns.as_ref().map(|m| m.hostname.clone()),
					dns_name: p
						.dns_name
						.as_ref()
						.filter(|(ip, _)| {
							endpoint_kind == EndpointKind::Remote && Some(*ip) == remote.map(|a| a.ip())
						})
						.map(|(_, n)| n.clone()),
					source: p.source(),
					state: if p.stale_since.is_some() {
						PeerState::Stale
					} else {
						PeerState::Online
					},
					last_seen: p.last_seen,
					hidden: flags.hidden,
					blocked: flags.blocked,
					snapshot_json: p.snapshot.clone(),
				}
			})
			.collect();
		out.sort_by(|a, b| a.instance_id.cmp(&b.instance_id));
		out
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	const OWN: &str = "0000000000000000";
	const P: &str = "1111111111111111";

	fn local(id: &str, n: u16) -> InstanceEntry {
		InstanceEntry {
			instance_id:  id.into(),
			pid:          1,
			nonce:        "0".repeat(16),
			endpoint:     format!("sock{n}"),
			token:        "t".into(),
			created_at:   1,
			capabilities: vec!["mesh".into()],
		}
	}

	fn lo(n: u16) -> Endpoint {
		Endpoint::Local(local(P, n))
	}

	fn re(addr: &str) -> Endpoint {
		Endpoint::Remote { addr: addr.parse().unwrap() }
	}

	fn mdns(addr: &str) -> MdnsEndpoint {
		MdnsEndpoint { addr: addr.parse().unwrap(), hostname: "box.local".into() }
	}

	fn snap() -> Arc<str> {
		Arc::from("{}")
	}

	fn sa(addr: &str) -> SocketAddr {
		addr.parse().unwrap()
	}

	#[test]
	fn local_wins_over_remote_and_remote_order_is_mdns_static_contact() {
		let mut t = PeerTable::new(OWN);
		assert_eq!(t.learn_contact(P, sa("10.0.0.3:9"), 1), Change {
			changed:      false,
			new_endpoint: true,
		});
		assert!(t.infos().is_empty(), "unverified contact is not listed");
		assert!(t.snapshot_ok(P, snap(), 1));
		assert_eq!(t.infos()[0].source, PeerSource::Contact);
		assert!(t.static_up(P, sa("10.0.0.2:9"), snap(), 2).new_endpoint);
		assert_eq!(t.route(P, true, true), Some(re("10.0.0.2:9")));
		assert_eq!(t.mdns_up(P, mdns("10.0.0.1:9"), 3), Some(sa("10.0.0.1:9")));
		assert_eq!(t.route(P, true, true), Some(re("10.0.0.2:9")), "candidate not used yet");
		assert!(t.promote_mdns(P, sa("10.0.0.1:9"), snap(), 3).changed);
		assert_eq!(t.route(P, true, true), Some(re("10.0.0.1:9")));
		let (changed, fresh) = t.set_local_listing(&[local(P, 7000), local(OWN, 7001)], 4);
		assert!(changed);
		assert_eq!(fresh, vec![P.to_owned()]);
		assert_eq!(t.infos().len(), 1, "own id never listed");
		let info = &t.infos()[0];
		assert_eq!(
			(info.source, info.endpoint_kind, info.port, info.last_seen),
			(PeerSource::Local, EndpointKind::Local, None, 4)
		);
		assert_eq!(t.route(P, true, true), Some(lo(7000)));
		assert_eq!(t.route(P, false, true), Some(re("10.0.0.1:9")), "local side off");
		assert_eq!(
			t.learn_contact(P, sa("10.0.0.4:9"), 5),
			Change::NONE,
			"contact never overrides discovery"
		);

		assert!(t.clear_remote());
		assert_eq!(t.route(P, true, true), Some(lo(7000)));
		assert!(t.drop_local(P).is_some());
		assert!(!t.contains(P), "no endpoints left");
	}

	#[test]
	fn spoofed_mdns_candidate_never_replaces_working_route() {
		let mut t = PeerTable::new(OWN);
		t.static_up(P, sa("10.0.0.2:9"), snap(), 1);
		assert_eq!(t.mdns_up(P, mdns("10.6.6.6:9"), 2), Some(sa("10.6.6.6:9")));
		assert_eq!(t.mdns_up(P, mdns("10.6.6.6:9"), 2), None, "repeat is silent");
		assert_eq!(
			t.promote_mdns(P, sa("10.7.7.7:9"), snap(), 3),
			Change::NONE,
			"only the pending candidate"
		);
		assert_eq!(t.route(P, true, true), Some(re("10.0.0.2:9")));
		assert_eq!(t.mdns_candidates(), vec![(P.to_owned(), sa("10.6.6.6:9"))]);
		assert!(!t.mdns_down(P), "candidate drop is invisible");
		assert!(t.mdns_candidates().is_empty());
	}

	#[test]
	fn misdirected_drop_only_hits_the_dialed_local_endpoint() {
		let mut t = PeerTable::new(OWN);
		t.set_local_listing(&[local(P, 2)], 1);
		assert!(t.drop_local_if(P, "sock1", "t").is_none(), "relisted at a new path meanwhile");
		assert!(t.drop_local_if(P, "sock2", "other").is_none(), "different token");
		assert!(t.drop_local_if(P, "sock2", "t").is_some());
		assert!(!t.contains(P));
	}

	#[test]
	fn local_listing_compares_endpoint_and_token_only() {
		let mut t = PeerTable::new(OWN);
		assert_eq!(t.set_local_listing(&[local(P, 1)], 1), (true, vec![P.to_owned()]));
		let mut rewritten = local(P, 1);
		rewritten.capabilities.push("collab".into());
		rewritten.created_at = 2;
		assert_eq!(t.set_local_listing(&[rewritten], 2), (false, vec![]), "same publication");
		let mut rotated = local(P, 1);
		rotated.token = "u".into();
		assert_eq!(t.set_local_listing(&[rotated], 3), (true, vec![P.to_owned()]), "new token");
		assert_eq!(
			t.set_local_listing(&[local(P, 2)], 4),
			(true, vec![P.to_owned()]),
			"new endpoint"
		);
	}

	#[test]
	fn restarted_static_peer_drops_old_id() {
		let mut t = PeerTable::new(OWN);
		let q = "2222222222222222";
		t.static_up(P, sa("10.0.0.2:9"), snap(), 1);
		t.static_up(q, sa("10.0.0.2:9"), snap(), 2);
		assert!(t.retain_static(&[(sa("10.0.0.2:9"), q.to_owned())]));
		assert!(!t.contains(P));
		assert!(t.contains(q));
	}

	#[test]
	fn failures_mark_stale_then_sweep_keeps_announced_peers() {
		let start = Instant::now();
		let mut t = PeerTable::new(OWN);
		let (m, s, l) = ("2222222222222222", "3333333333333333", "4444444444444444");
		t.mdns_up(m, mdns("10.0.0.1:9"), 1);
		t.promote_mdns(m, sa("10.0.0.1:9"), snap(), 1);
		t.static_up(s, sa("10.0.0.2:9"), snap(), 1);
		t.set_local_listing(&[local(l, 1)], 1);
		for id in [m, s, l] {
			assert!(!t.contact_failed(id, start));
			assert!(!t.contact_failed(id, start));
			assert!(t.contact_failed(id, start), "third failure marks stale");
			assert!(!t.contact_failed(id, start), "already stale");
		}
		assert!(t.infos().iter().all(|i| i.state == PeerState::Stale));
		assert!(!t.sweep(start + Duration::from_secs(119)));
		assert!(t.sweep(start + STALE_REMOVE_AFTER));
		assert!(!t.contains(s), "static-only peer expires (re-added by the next probe)");
		assert!(t.contains(m), "still announced by mDNS");
		assert!(t.contains(l), "still listed locally");

		assert!(t.contact_ok(l, 9));
		assert_eq!(t.infos().iter().find(|i| i.instance_id == l).unwrap().state, PeerState::Online);
	}

	#[test]
	fn unverified_contacts_retry_then_expire() {
		let start = Instant::now();
		let mut t = PeerTable::new(OWN);
		assert!(t.learn_contact(P, sa("10.0.0.3:9"), 1).new_endpoint);
		assert!(!t.fetch_answered(P, 1, start), "e.g. `unsupported`: invisible failure");
		assert!(
			t.learn_contact(P, sa("10.0.0.3:9"), 2).new_endpoint,
			"next inbound message asks for another fetch"
		);
		assert!(t.refresh_ids().is_empty(), "unverified peers are not refreshed");
		t.sweep(start + STALE_REMOVE_AFTER);
		assert!(!t.contains(P), "aged out");
	}

	fn id(i: usize) -> String {
		format!("{i:016x}")
	}

	#[test]
	fn fake_mdns_ids_cannot_lock_out_real_peers() {
		let start = Instant::now();
		let mut t = PeerTable::new(OWN);
		for i in 1..=MAX_REMOTE_PEERS {
			t.mdns_up(&id(i), mdns("10.0.0.1:9"), 1);
		}
		assert_eq!(t.mdns_candidates().len(), MAX_CANDIDATES, "oldest candidates evicted");
		assert!(!t.contains(&id(1)));
		assert!(t.contains(&id(MAX_REMOTE_PEERS)));

		let real = "ffffffffffffffff";
		assert!(t.static_up(real, sa("10.0.0.2:9"), snap(), 1).changed, "static is never capped");
		assert!(
			!t.static_up(real, sa("10.0.0.2:9"), snap(), 2).changed,
			"unchanged re-probe is silent"
		);

		// Fill the remote cap with contacts; a new contact evicts a candidate.
		for i in 1000..1000 + MAX_REMOTE_PEERS - MAX_CANDIDATES - 1 {
			t.learn_contact(&id(i), sa("10.0.0.3:9"), 1);
		}
		let contact = "eeeeeeeeeeeeeeee";
		assert!(t.learn_contact(contact, sa("10.0.0.3:9"), 1).new_endpoint);
		assert_eq!(t.mdns_candidates().len(), MAX_CANDIDATES - 1);

		// A candidate whose verification failed stays (retried each refresh);
		// only mDNS removal or the cap ends it.
		let (cid, _) = t.mdns_candidates()[0].clone();
		t.sweep(start + STALE_REMOVE_AFTER * 10);
		assert!(t.contains(&cid));
		assert!(!t.mdns_down(&cid), "invisible removal");
		assert!(!t.contains(&cid));
		assert!(
			t.set_local_listing(&[local("dddddddddddddddd", 1)], 1).0,
			"local registry is trusted"
		);
	}

	#[test]
	fn flags_survive_rediscovery_and_dns_name_tracks_remote_ip() {
		let mut t = PeerTable::new(OWN);
		assert!(!t.set_flags(P, true, true), "unknown peer: nothing visible changed");
		t.static_up(P, sa("10.0.0.1:9"), snap(), 1);
		assert!(t.is_blocked(P));
		assert!(t.infos()[0].hidden);

		assert_eq!(t.remote_ip(P), Some("10.0.0.1".parse().unwrap()));
		assert!(!t.set_dns_name(P, "10.9.9.9".parse().unwrap(), "x".into()), "stale lookup ignored");
		assert!(t.set_dns_name(P, "10.0.0.1".parse().unwrap(), "box.lan".into()));
		assert_eq!(t.remote_ip(P), None);
		assert_eq!(t.infos()[0].dns_name.as_deref(), Some("box.lan"));
		t.static_up(P, sa("10.0.0.7:9"), snap(), 2);
		assert_eq!(t.infos()[0].dns_name, None, "name belonged to the old address");
		assert_eq!(t.remote_ip(P), Some("10.0.0.7".parse().unwrap()));
	}
}
