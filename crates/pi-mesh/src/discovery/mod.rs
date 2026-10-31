//! LAN peer discovery over mDNS DNS-SD (`_omp-mesh._tcp.local.`).
//!
//! [`MdnsDiscovery`] owns the `mdns-sd` daemon (announce + browse);
//! [`records`] holds the socket-free filtering and dedupe logic.

mod mdns;
pub mod records;

pub use mdns::{DiscoveryError, MdnsConfig, MdnsDiscovery, mdns_host_name};
pub use records::{DiscoveryEvent, MdnsPeer, SERVICE_TYPE};
