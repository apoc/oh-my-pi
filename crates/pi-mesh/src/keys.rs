//! Crypto for mesh traffic.
//!
//! ```text
//! passphrase -NFC, trim, PBKDF2-HMAC-SHA256 (600k, salt "omp-mesh/v1")-> 32-byte mesh key
//!            (stored as unpadded base64url in `mesh.key`)
//! mesh key   -HKDF-SHA256 (salt "omp-mesh/v1")-> info "mesh-group": 8-byte public group tag (hex)
//!                                             -> info "mesh-seal":  AES-256-GCM key (LAN)
//! ```
//!
//! Sealed layout: `[12-byte random nonce][ciphertext][16-byte GCM tag]`.
//!
//! Every constant here is a persisted/wire contract: changing one silently
//! splits meshes across omp versions (pinned by known-answer tests).

use std::{collections::HashMap, num::NonZeroU32, time::Duration};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::{
	aead::{AES_256_GCM, Aad, LessSafeKey, NONCE_LEN, Nonce, UnboundKey},
	digest::{Context, SHA256},
	hkdf::{self, HKDF_SHA256},
	pbkdf2,
	rand::{SecureRandom, SystemRandom},
};
use unicode_normalization::UnicodeNormalization;

use crate::error::KeyError;

const KDF_SALT: &[u8] = b"omp-mesh/v1";
const PBKDF2_ITERATIONS: NonZeroU32 = NonZeroU32::new(600_000).unwrap();
/// Raw mesh key length.
pub const MESH_KEY_BYTES: usize = 32;
/// Shortest accepted passphrase, in Unicode scalar values after NFC + trim.
///
/// The group tag is broadcast unauthenticated over mDNS and lets anyone test
/// guesses offline, so short phrases are refused outright.
pub const MIN_PASSPHRASE_CHARS: usize = 12;
/// Passphrases shorter than this (same count) are accepted but flagged weak.
pub const STRONG_PASSPHRASE_CHARS: usize = 16;
const GROUP_TAG_BYTES: usize = 8;
const GCM_TAG_BYTES: usize = 16;
const INFO_GROUP: &[u8] = b"mesh-group";
const INFO_SEAL: &[u8] = b"mesh-seal";
/// Bytes `seal` adds on top of the plaintext.
pub const SEAL_OVERHEAD: usize = NONCE_LEN + GCM_TAG_BYTES;

/// How a passphrase would fare in [`derive_mesh_key`] (for live feedback).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PassphraseCheck {
	/// Unicode scalar values after NFC + trim.
	pub chars: usize,
	/// At least [`MIN_PASSPHRASE_CHARS`]: [`derive_mesh_key`] accepts it.
	pub valid: bool,
	/// Below [`STRONG_PASSPHRASE_CHARS`].
	pub weak:  bool,
}

/// Counts `passphrase` the way [`derive_mesh_key`] does.
pub fn check_passphrase(passphrase: &str) -> PassphraseCheck {
	let normalized: String = passphrase.nfc().collect();
	let chars = normalized.trim().chars().count();
	PassphraseCheck {
		chars,
		valid: chars >= MIN_PASSPHRASE_CHARS,
		weak: chars < STRONG_PASSPHRASE_CHARS,
	}
}

/// Derive the stored mesh key from a passphrase: same phrase, same key on
/// every machine.
///
/// The phrase is NFC-normalized (so composed/decomposed input from different
/// keyboards and OSes agree) and stripped of surrounding whitespace (invisible
/// in masked input, easy to pick up when pasting) before derivation.
/// Deliberately slow (~600k HMAC rounds): call off the async executor.
///
/// # Errors
/// [`KeyError::BlankPassphrase`] when nothing but whitespace remains,
/// [`KeyError::WeakPassphrase`] below [`MIN_PASSPHRASE_CHARS`].
pub fn derive_mesh_key(passphrase: &str) -> Result<String, KeyError> {
	let normalized: String = passphrase.nfc().collect();
	let phrase = normalized.trim();
	if phrase.is_empty() {
		return Err(KeyError::BlankPassphrase);
	}
	if phrase.chars().count() < MIN_PASSPHRASE_CHARS {
		return Err(KeyError::WeakPassphrase);
	}
	let mut key = [0u8; MESH_KEY_BYTES];
	pbkdf2::derive(
		pbkdf2::PBKDF2_HMAC_SHA256,
		PBKDF2_ITERATIONS,
		KDF_SALT,
		phrase.as_bytes(),
		&mut key,
	);
	Ok(URL_SAFE_NO_PAD.encode(key))
}

/// HKDF output length selector for ring.
struct OkmLen(usize);

impl hkdf::KeyType for OkmLen {
	fn len(&self) -> usize {
		self.0
	}
}

/// One AES-256-GCM key with random nonces.
pub struct SealKey {
	key: LessSafeKey,
	rng: SystemRandom,
}

impl std::fmt::Debug for SealKey {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("SealKey").finish_non_exhaustive()
	}
}

impl SealKey {
	fn expand(prk: &hkdf::Prk, info: &[u8]) -> Self {
		let key = prk
			.expand(&[info], &AES_256_GCM)
			.map(UnboundKey::from)
			.expect("HKDF output length fits AES-256");
		Self { key: LessSafeKey::new(key), rng: SystemRandom::new() }
	}

	/// Append `[nonce][seal(plain)][tag]` to `out` (one copy of `plain`).
	///
	/// # Panics
	/// When the OS random source fails; sending with a non-random nonce would
	/// break GCM, so there is no safe fallback.
	pub fn seal_into(&self, out: &mut Vec<u8>, plain: &[u8], aad: &[u8]) {
		let mut nonce = [0u8; NONCE_LEN];
		self
			.rng
			.fill(&mut nonce)
			.expect("OS random source unavailable");
		out.reserve(SEAL_OVERHEAD + plain.len());
		out.extend_from_slice(&nonce);
		let start = out.len();
		out.extend_from_slice(plain);
		let tag = self
			.key
			.seal_in_place_separate_tag(
				Nonce::assume_unique_for_key(nonce),
				Aad::from(aad),
				&mut out[start..],
			)
			.expect("AES-GCM plaintext length within limits");
		out.extend_from_slice(tag.as_ref());
	}

	/// Encrypt and authenticate `plain`, binding `aad` (tests).
	#[cfg(test)]
	pub(crate) fn seal(&self, plain: &[u8], aad: &[u8]) -> Vec<u8> {
		let mut out = Vec::new();
		self.seal_into(&mut out, plain, aad);
		out
	}

	/// Authenticate and decrypt in place; returns the plaintext inside
	/// `sealed`. `None` for any framing or authentication failure (wrong key,
	/// tampered bytes or `aad`, truncation).
	pub fn open_in_place<'a>(&self, sealed: &'a mut [u8], aad: &[u8]) -> Option<&'a mut [u8]> {
		if sealed.len() < SEAL_OVERHEAD {
			return None;
		}
		let (nonce, body) = sealed.split_at_mut(NONCE_LEN);
		let nonce = Nonce::try_assume_unique_for_key(nonce).ok()?;
		self.key.open_in_place(nonce, Aad::from(aad), body).ok()
	}

	/// Copying variant of [`Self::open_in_place`] (tests).
	#[cfg(test)]
	pub(crate) fn open(&self, sealed: &[u8], aad: &[u8]) -> Option<Vec<u8>> {
		let mut buf = sealed.to_vec();
		let len = self.open_in_place(&mut buf, aad)?.len();
		buf.drain(..NONCE_LEN);
		buf.truncate(len);
		Some(buf)
	}
}

/// Subkeys expanded from a stored mesh key.
pub struct MeshKeys {
	group_tag: String,
	seal_key:  SealKey,
}

impl std::fmt::Debug for MeshKeys {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("MeshKeys")
			.field("group_tag", &self.group_tag)
			.finish_non_exhaustive()
	}
}

impl MeshKeys {
	/// Expand a stored mesh key (exactly 32 bytes, canonical unpadded
	/// base64url) into the group tag and sealing key.
	///
	/// # Errors
	/// [`KeyError::MalformedKey`] for any other input.
	pub fn load(derived: &str) -> Result<Self, KeyError> {
		let raw = URL_SAFE_NO_PAD
			.decode(derived)
			.map_err(|_| KeyError::MalformedKey)?;
		// The engine rejects non-zero trailing bits, so a successful decode of
		// the right length is canonical; the round trip keeps that explicit.
		if raw.len() != MESH_KEY_BYTES || URL_SAFE_NO_PAD.encode(&raw) != derived {
			return Err(KeyError::MalformedKey);
		}
		let prk = hkdf::Salt::new(HKDF_SHA256, KDF_SALT).extract(&raw);
		let mut tag = [0u8; GROUP_TAG_BYTES];
		prk.expand(&[INFO_GROUP], OkmLen(GROUP_TAG_BYTES))
			.and_then(|okm| okm.fill(&mut tag))
			.map_err(|_| KeyError::MalformedKey)?;
		Ok(Self { group_tag: hex(&tag), seal_key: SealKey::expand(&prk, INFO_SEAL) })
	}

	/// Public group tag (16 lowercase hex chars) advertised in mDNS TXT `g=`;
	/// peers with another tag belong to another mesh and are hidden.
	pub fn group_tag(&self) -> &str {
		&self.group_tag
	}

	/// The LAN sealing key.
	pub const fn seal_key(&self) -> &SealKey {
		&self.seal_key
	}

	#[cfg(test)]
	pub(crate) fn seal(&self, plain: &[u8], aad: &[u8]) -> Vec<u8> {
		self.seal_key.seal(plain, aad)
	}

	#[cfg(test)]
	pub(crate) fn open(&self, sealed: &[u8], aad: &[u8]) -> Option<Vec<u8>> {
		self.seal_key.open(sealed, aad)
	}
}

/// Lowercase hex of `bytes`.
pub(crate) fn hex(bytes: &[u8]) -> String {
	const DIGITS: &[u8; 16] = b"0123456789abcdef";
	let mut out = String::with_capacity(bytes.len() * 2);
	for &b in bytes {
		out.push(DIGITS[(b >> 4) as usize] as char);
		out.push(DIGITS[(b & 0x0f) as usize] as char);
	}
	out
}

/// Fill `buf` from the OS random source.
///
/// # Panics
/// When the OS random source fails.
pub(crate) fn random_bytes(buf: &mut [u8]) {
	SystemRandom::new()
		.fill(buf)
		.expect("OS random source unavailable");
}

type Digest = [u8; 32];

fn replay_key(sender: &str, msg_id: &str) -> Digest {
	let mut ctx = Context::new(&SHA256);
	ctx.update(sender.as_bytes());
	ctx.update(&[0]);
	ctx.update(msg_id.as_bytes());
	let mut out = [0u8; 32];
	out.copy_from_slice(ctx.finish().as_ref());
	out
}

/// Outcome of [`ReplayGuard::check`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplayVerdict {
	Ok,
	/// `sentAt` is further than the window from now (either direction).
	Stale,
	/// The same `(sender, msgId)` was accepted inside the window.
	Replay,
}

/// Rejects messages outside a ±window clock skew and `(sender, msgId)` pairs
/// already accepted inside it.
///
/// - `now` is clamped to the largest value seen, so a wall clock stepping
///   backwards cannot reopen the window for ids already evicted as expired.
/// - Memory is bounded by `capacity`: expired ids are dropped in insertion
///   order as they reach the front, and when full the oldest-inserted id is
///   evicted (an evicted id could be replayed only while still inside the
///   window, and only after `capacity` newer messages). Each check is O(1)
///   amortized.
#[derive(Debug)]
pub struct ReplayGuard {
	window_ms: u64,
	capacity:  usize,
	now_ms:    u64,
	/// SHA-256(`sender \0 msgId`) -> expiry (`sentAt + window`); fixed size
	/// per entry whatever the id lengths.
	seen:      HashMap<Digest, u64>,
	/// Insertion order of `seen`; may hold superseded entries, recognized by an
	/// expiry differing from the live one.
	order:     std::collections::VecDeque<(Digest, u64)>,
}

impl Default for ReplayGuard {
	fn default() -> Self {
		Self::new(Duration::from_secs(60), 10_000)
	}
}

impl ReplayGuard {
	/// `capacity` is clamped to at least 1.
	pub fn new(window: Duration, capacity: usize) -> Self {
		let capacity = capacity.max(1);
		Self {
			window_ms: u64::try_from(window.as_millis()).unwrap_or(u64::MAX),
			capacity,
			now_ms: 0,
			seen: HashMap::with_capacity(capacity.min(1024)),
			order: std::collections::VecDeque::with_capacity(capacity.min(1024)),
		}
	}

	/// Check one authenticated message; records it when [`ReplayVerdict::Ok`].
	pub fn check(
		&mut self,
		sender: &str,
		msg_id: &str,
		sent_at_ms: u64,
		now_ms: u64,
	) -> ReplayVerdict {
		self.now_ms = self.now_ms.max(now_ms);
		let now = self.now_ms;
		if now.abs_diff(sent_at_ms) > self.window_ms {
			return ReplayVerdict::Stale;
		}
		self.drop_expired(now);
		let key = replay_key(sender, msg_id);
		if self.seen.get(&key).is_some_and(|&expiry| expiry >= now) {
			return ReplayVerdict::Replay;
		}
		while self.order.len() >= self.capacity {
			self.pop_front();
		}
		let expiry = sent_at_ms.saturating_add(self.window_ms);
		self.order.push_back((key, expiry));
		self.seen.insert(key, expiry);
		ReplayVerdict::Ok
	}

	fn drop_expired(&mut self, now: u64) {
		while self.order.front().is_some_and(|(_, expiry)| *expiry < now) {
			self.pop_front();
		}
	}

	fn pop_front(&mut self) {
		if let Some((key, expiry)) = self.order.pop_front()
			&& self.seen.get(&key) == Some(&expiry)
		{
			self.seen.remove(&key);
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	// Independently computed (Python hashlib PBKDF2 + RFC 5869 HKDF +
	// `cryptography` AES-GCM); a mismatch means stored keys and group tags no
	// longer interoperate across omp versions.
	const PHRASE: &str = "correct horse battery staple";
	const PHRASE_KEY: &str = "WXg1aURU1bMA0PQ_bN_-Li8gC9YJ0kcxgsxt9DNycNY";
	const PHRASE_GROUP_TAG: &str = "67289944bb91382d";
	const FIXED_AAD: &[u8] = b"omp-mesh test aad";
	const FIXED_PLAIN: &[u8] = b"hello mesh";
	const FIXED_SEALED_HEX: &str =
		"000102030405060708090a0b0e250ce491467ba73c1b414cb5b2c0f7d4d6c651ac727ea5526b";

	fn unhex(s: &str) -> Vec<u8> {
		(0..s.len())
			.step_by(2)
			.map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
			.collect()
	}

	fn fixed_keys() -> MeshKeys {
		MeshKeys::load(PHRASE_KEY).unwrap()
	}

	#[test]
	fn derive_matches_known_answer() {
		assert_eq!(derive_mesh_key(PHRASE).unwrap(), PHRASE_KEY);
	}

	#[test]
	fn derive_normalizes_nfc_and_trims() {
		// "é" precomposed vs "e" + U+0301; surrounding whitespace ignored.
		let composed = derive_mesh_key("caf\u{e9} mesh network").unwrap();
		assert_eq!(derive_mesh_key("  cafe\u{301} mesh network\t\n").unwrap(), composed);
	}

	#[test]
	fn derive_rejects_short_phrases_after_trim() {
		// 11 scalar values after NFC (the decomposed form has 12 code points)
		// and trimming; 12 is enough.
		assert_eq!(derive_mesh_key("  caf\u{e9}-meshes  "), Err(KeyError::WeakPassphrase));
		assert_eq!(derive_mesh_key("cafe\u{301}-meshes"), Err(KeyError::WeakPassphrase));
		assert!(derive_mesh_key("caf\u{e9}-meshes!").is_ok());
	}

	#[test]
	fn check_counts_like_derive() {
		let check = |p: &str| {
			let c = check_passphrase(p);
			(c.chars, c.valid, c.weak)
		};
		assert_eq!(check("  cafe\u{301}-meshes  "), (11, false, true));
		assert_eq!(check("caf\u{e9}-meshes!"), (12, true, true));
		assert_eq!(check("x".repeat(16).as_str()), (16, true, false));
		assert_eq!(check(" \t"), (0, false, true));
		for phrase in ["cafe\u{301}-meshes", "caf\u{e9}-meshes!", "  y"] {
			assert_eq!(check_passphrase(phrase).valid, derive_mesh_key(phrase).is_ok(), "{phrase}");
		}
	}

	#[test]
	fn derive_rejects_blank() {
		for phrase in ["", "   ", "\t\n\u{3000}"] {
			assert_eq!(derive_mesh_key(phrase), Err(KeyError::BlankPassphrase));
		}
	}

	#[test]
	fn group_tag_matches_known_answer() {
		assert_eq!(fixed_keys().group_tag(), PHRASE_GROUP_TAG);
	}

	#[test]
	fn opens_known_sealed_blob() {
		let sealed = unhex(FIXED_SEALED_HEX);
		assert_eq!(fixed_keys().open(&sealed, FIXED_AAD).as_deref(), Some(FIXED_PLAIN));
	}

	#[test]
	fn load_rejects_malformed_keys() {
		let padded = base64::engine::general_purpose::URL_SAFE.encode([1u8; 32]);
		let standard = base64::engine::general_purpose::STANDARD_NO_PAD.encode([0xffu8; 32]);
		let short = URL_SAFE_NO_PAD.encode([1u8; 31]);
		// Same 32 bytes as PHRASE_KEY's last char but with non-zero trailing
		// bits.
		let mut non_canonical = PHRASE_KEY.to_owned();
		let last = non_canonical.pop().unwrap();
		let idx = URL_SAFE_ALPHABET.find(last).unwrap();
		non_canonical.push(URL_SAFE_ALPHABET.as_bytes()[idx ^ 1] as char);
		for key in [padded, standard, short, non_canonical, String::new()] {
			assert_eq!(MeshKeys::load(&key).unwrap_err(), KeyError::MalformedKey, "{key}");
		}
	}

	const URL_SAFE_ALPHABET: &str =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

	#[test]
	fn seal_open_round_trip_uses_fresh_nonces() {
		let keys = fixed_keys();
		let a = keys.seal(b"payload", b"aad");
		let b = keys.seal(b"payload", b"aad");
		assert_ne!(a[..NONCE_LEN], b[..NONCE_LEN]);
		assert_eq!(a.len(), b"payload".len() + SEAL_OVERHEAD);
		assert_eq!(keys.open(&a, b"aad").as_deref(), Some(&b"payload"[..]));
		assert_eq!(keys.open(&keys.seal(b"", b""), b"").as_deref(), Some(&b""[..]));
	}

	#[test]
	fn open_rejects_every_tampering() {
		let keys = fixed_keys();
		let other = MeshKeys::load(&URL_SAFE_NO_PAD.encode([7u8; 32])).unwrap();
		let sealed = keys.seal(b"payload", b"aad");
		let flip = |i: usize| {
			let mut s = sealed.clone();
			s[i] ^= 1;
			s
		};
		assert_eq!(other.open(&sealed, b"aad"), None, "wrong key");
		assert_eq!(keys.open(&sealed, b"aaD"), None, "tampered aad");
		assert_eq!(keys.open(&flip(0), b"aad"), None, "tampered nonce");
		assert_eq!(keys.open(&flip(NONCE_LEN), b"aad"), None, "tampered ciphertext");
		assert_eq!(keys.open(&flip(sealed.len() - 1), b"aad"), None, "tampered tag");
		assert_eq!(keys.open(&sealed[..sealed.len() - 1], b"aad"), None, "truncated");
		assert_eq!(keys.open(&sealed[..SEAL_OVERHEAD - 1], b"aad"), None, "short");
	}

	#[test]
	fn replay_guard_rejects_stale_both_directions() {
		let mut guard = ReplayGuard::new(Duration::from_secs(60), 16);
		let now = 1_000_000;
		assert_eq!(guard.check("a", "m1", now - 60_001, now), ReplayVerdict::Stale);
		assert_eq!(guard.check("a", "m2", now + 60_001, now), ReplayVerdict::Stale);
		assert_eq!(guard.check("a", "m3", now - 60_000, now), ReplayVerdict::Ok);
		assert_eq!(guard.check("a", "m4", now + 60_000, now), ReplayVerdict::Ok);
	}

	#[test]
	fn replay_guard_keys_by_sender_and_msg_id() {
		let mut guard = ReplayGuard::new(Duration::from_secs(60), 16);
		let now = 1_000_000;
		assert_eq!(guard.check("a", "m", now, now), ReplayVerdict::Ok);
		assert_eq!(guard.check("a", "m", now, now + 10), ReplayVerdict::Replay);
		assert_eq!(guard.check("b", "m", now, now), ReplayVerdict::Ok);
		// The separator keeps ("a", "\0m") distinct from ("a\0", "m").
		assert_eq!(guard.check("ab", "m", now, now), ReplayVerdict::Ok);
	}

	#[test]
	fn replay_guard_evicts_oldest_at_capacity() {
		let mut guard = ReplayGuard::new(Duration::from_secs(60), 2);
		let now = 1_000_000;
		assert_eq!(guard.check("a", "m1", now, now), ReplayVerdict::Ok);
		assert_eq!(guard.check("a", "m2", now, now), ReplayVerdict::Ok);
		assert_eq!(guard.check("a", "m3", now, now), ReplayVerdict::Ok);
		assert_eq!(guard.order.len(), 2);
		// m1 was evicted (documented trade-off); m2/m3 still remembered.
		assert_eq!(guard.check("a", "m3", now, now), ReplayVerdict::Replay);
		assert_eq!(guard.check("a", "m1", now, now), ReplayVerdict::Ok);
		assert_eq!(guard.check("a", "m2", now, now), ReplayVerdict::Ok);
	}

	#[test]
	fn replay_guard_drops_expired_entries() {
		let mut guard = ReplayGuard::new(Duration::from_secs(60), 100);
		for i in 0..50 {
			guard.check("a", &format!("m{i}"), 1_000_000, 1_000_000);
		}
		assert_eq!(guard.check("a", "late", 1_100_000, 1_100_000), ReplayVerdict::Ok);
		assert_eq!(guard.seen.len(), 1);
		assert_eq!(guard.order.len(), 1);
	}

	#[test]
	fn replay_guard_clamps_clock_stepping_back() {
		let mut guard = ReplayGuard::new(Duration::from_secs(60), 100);
		assert_eq!(guard.check("a", "m", 1_000_000, 1_000_000), ReplayVerdict::Ok);
		// Advance past the window: the entry expires and is dropped.
		assert_eq!(guard.check("a", "x", 1_100_000, 1_100_000), ReplayVerdict::Ok);
		// Clock steps back to where "m" would be fresh again: still stale.
		assert_eq!(guard.check("a", "m", 1_000_000, 1_000_010), ReplayVerdict::Stale);
	}

	#[test]
	fn replay_guard_superseded_queue_entries_do_not_evict_live_ids() {
		let mut guard = ReplayGuard::new(Duration::from_secs(60), 3);
		let t = 1_000_000;
		// "x" expires last and stays at the front, pinning "m"'s first entry.
		assert_eq!(guard.check("a", "x", t + 50_000, t), ReplayVerdict::Ok);
		assert_eq!(guard.check("a", "m", t, t), ReplayVerdict::Ok);
		// "m" expired; accepted again, leaving a superseded queue entry behind
		// "x".
		assert_eq!(guard.check("a", "m", t + 70_000, t + 70_000), ReplayVerdict::Ok);
		// Two inserts at capacity pop "x" and then the superseded "m" entry...
		assert_eq!(guard.check("a", "y", t + 70_000, t + 70_000), ReplayVerdict::Ok);
		assert_eq!(guard.check("a", "z", t + 70_000, t + 70_000), ReplayVerdict::Ok);
		// ...which must not forget the live "m".
		assert_eq!(guard.check("a", "m", t + 70_000, t + 70_000), ReplayVerdict::Replay);
	}
}
