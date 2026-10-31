# Mesh: Talking to Other omp Instances

oh my pi mesh lets running omp instances find each other — on the same PC, and on the LAN — and message each other's main agent (or its human). An agent can ask another instance what it is working on, ask it a question answered from that session's context, steer it, delegate a task to it, or wait until it goes idle. Nothing leaves the machine or the LAN: there is no relay and no internet transport.

The mesh is off by default. Only top-level hosts join it: the interactive TUI, RPC mode and ACP (the newest open session). Print mode, the SDK and subagents never do.

## Quick start

Same PC:

```yaml
# ~/.omp/agent/config.yml
mesh:
  enabled: true # mode defaults to local
```

or open `/mesh` and press `e`. Every omp process of the same user on this machine now appears in `/mesh` and in `xd://mesh_peers`.

Across the LAN, on every machine:

```
omp mesh set-key        # or /mesh → k; same phrase everywhere
omp config set mesh.mode both
```

## Modes

`mesh.mode` picks which sides run. Two instances can talk only over a side both have on.

| Mode     | Same PC (local side) | LAN (remote side)                      |
| -------- | -------------------- | -------------------------------------- |
| `local`  | yes                  | no network listener                    |
| `remote` | no                   | yes; needs a key, status `no-key` else |
| `both`   | yes                  | yes; needs a key, status `no-key` else |

Changing `mesh.enabled`, `mesh.mode`, `mesh.key`, `mesh.port`, `mesh.peers` or the display name reconfigures the running engine live; no restart.

## Key phrase

The LAN side is protected by a shared key derived from a key phrase. Set it with `/mesh` → `k` (typed twice, masked) or `omp mesh set-key` (prompts twice on a TTY; reads the first stdin line otherwise: `echo phrase | omp mesh set-key`).

- The phrase is NFC-normalized and trimmed, then stretched with PBKDF2-HMAC-SHA256 (600k iterations, fixed salt `omp-mesh/v1`) into a 32-byte key stored in the credential setting `mesh.key`. The phrase itself is never stored or printed.
- Phrases shorter than 12 characters are rejected; both entry points warn below 16. Anyone on the LAN can see the group tag derived from the key and test guesses offline, so use a long phrase.
- Every machine that should join uses the same phrase. Instances with another key are invisible to each other.

## Discovery

**Same PC.** Each instance publishes an entry in the owner-only registry `~/.omp/run/mesh/` (`PI_CONFIG_DIR` replaces `.omp`): instance id, PID, local endpoint and a random bearer token. The endpoint is a Unix socket inside that directory (directory `0700`) or, on Windows, a named pipe `\\.\pipe\omp-mesh-<id>-<random>` whose DACL grants only the current user and which refuses remote (SMB) clients. Other accounts cannot connect. Entries of dead processes are pruned when listing.

**LAN.** The remote side binds a TCP listener on all interfaces (`mesh.port`, `0` = free port) and announces it over mDNS DNS-SD as `_omp-mesh._tcp.local` with TXT `v` (protocol), `id` (instance id), `g` (public group tag derived from the key) and `n` (display name). Virtual adapters (Hyper-V/WSL, Docker, bridges, VirtualBox/VMware, …) are skipped unless nothing else is up. Browsing ignores other groups and our own id, and drops announcements from this machine: same-PC instances are reached through the local side only. An mDNS address is only a candidate until a sealed snapshot fetched over it names the expected instance.

**Static peers.** `mesh.peers` lists `host:port` endpoints dialed directly, for networks where mDNS does not pass (other subnets, VPNs). They are never same-machine filtered, so `127.0.0.1:<port>` reaches another instance's LAN listener on this PC.

**Contacts.** A remote instance that messages this one is learned as a peer (origin address + its advertised port) and listed once a snapshot verifies it.

Peers known through several sources are merged, local first. A peer that fails three contacts in a row is `stale` and disappears two minutes later. Peers that have not served a snapshot are unverified and never listed.

## Messages

Every request carries the sender's instance id, agent id (`Main`, a subagent id, or `user` for the TUI human), display name and host.

| Kind     | Reaches                                                                           | Answer                                             | Default policy |
| -------- | --------------------------------------------------------------------------------- | -------------------------------------------------- | -------------- |
| `status` | An ephemeral side turn over the main context, no tools                            | Thread reply                                       | `allow`        |
| `ask`    | A read-only fork of the main session (`read`/`grep`/`glob`/`find`)                | Thread reply                                       | `allow`        |
| `task`   | The bundled `task` agent, fresh context, in the recipient's cwd, with write tools | Thread reply                                       | `deny`         |
| `steer`  | The main agent's own conversation (wakes it if idle)                              | Optional `reply` sent by that agent with `replyTo` | `ask`          |
| `note`   | The human only, as a `MESH` transcript card; never the agent                      | None                                               | `allow`        |
| `watch`  | One-shot notification on `idle` or `turn_end`                                     | `watch_event` when it fires                        | always on      |
| `reply`  | Answers a `steer` (or delivers a thread answer)                                   | —                                                  | always on      |

**Threads and follow-ups.** `status`, `ask` and `task` are acknowledged at once with a message id and a thread id; the answer comes later as a separate `reply` request to the sender. `xd://mesh_send` waits for it (default 300 s, max 1800 s); on timeout it returns the thread id and the answer later arrives as a hidden `mesh:reply` message to the asking agent, waking it if idle. A late answer is dropped when the asking session has closed or its conversation was replaced (`/new`, context reset, resume, fork). Passing `thread` continues an existing thread; omitting it starts a new one. A thread runs one turn at a time; follow-ups queue. An `ask` follow-up continues the same fork while the peer's main session has not moved on; otherwise it re-forks the current head and replays the earlier question/answer pairs. `status` follow-ups replay the thread history.

Threads belong to the recipient's current session: they are persisted under the session's artifacts directory (so a resumed session keeps answering), expire on a session switch (`thread_expired`), and are forgotten after `mesh.threadTtlHours` idle. Only the instance that opened a thread can read or continue it; anyone else gets `unknown_thread`.

**Watches** fire once and live at most one hour; one peer may hold 16. An `idle` watch on an already-idle instance fires immediately.

**Transcript.** In the TUI, inbound traffic shows as `MESH ← <peer>` cards tagged with the kind and thread: `status`/`ask`/`task` questions (answered by a side turn or fork, so the main agent never sees them), notes, steers, and answers to messages sent from `/mesh`. Each reply this instance sends back shows as a `MESH → <peer>` card. Peer text is stripped of control and bidi characters before rendering.

## Inbound policy

`mesh.inbound.<kind>` (`status`, `ask`, `steer`, `task`, `note`) is `allow`, `ask` or `deny`. `ask` queues the request in `/mesh` with a toast (`mesh: approval needed`); unanswered approvals are denied after two minutes. Headless hosts (RPC, ACP) have no UI, so `ask` means deny there, and notes are always refused. A denial reaches the sender as the thread's (or steer's) error reply.

`mesh.maxConcurrentAsks` bounds `ask` and `task` responders running at once; more queue. Responders never get mesh tools, and the engine refuses relayed envelopes (`hop` > 0), so mesh-triggered work cannot fan out over the mesh.

## Agent tools

Both are discoverable tools, presented as xd devices (`xd://mesh_peers`, `xd://mesh_send`) and offered only in the main session of a host running the mesh while `mesh.enabled` is on.

- [`mesh_peers`](./tools/mesh_peers.md) `{query?, refresh?}` — visible peers with session, cwd, branch, model, agents and work summary; `query` ranks them by relevance with the judge model.
- [`mesh_send`](./tools/mesh_send.md) `{to, kind, message, thread?, replyTo?, timeoutSec?, event?}` — send any kind above. `to` is an instance id, a unique id prefix, or a unique display/session name.

## `mesh://`

Read-only, served in the same sessions as the tools:

| URL                          | Result                                         |
| ---------------------------- | ---------------------------------------------- |
| `mesh://`                    | Visible peers, as `mesh_peers` without a query |
| `mesh://<peer>`              | Peer facts and its last snapshot (JSON)        |
| `mesh://<peer>/threads`      | Threads this instance opened with that peer    |
| `mesh://<peer>/threads/<id>` | One thread's question/answer transcript        |

## `/mesh`

The manager overlay shows this instance (local/remote state, LAN port, engine error), verified peers and pending approvals. The status line reads `mesh: N local · M remote` (plus `K pending`).

| Key       | Action                                                           |
| --------- | ---------------------------------------------------------------- |
| `↑` `↓`   | Select                                                           |
| `Enter`   | Peer details: snapshot, summary, agents, threads it opened here  |
| `e`       | Enable / disable the mesh (`mesh.enabled`)                       |
| `m`       | Cycle `mesh.mode`                                                |
| `k`       | Set the key phrase                                               |
| `r`       | Re-discover now                                                  |
| `a` / `d` | Approve / deny the selected request                              |
| `c`       | Compose to the selected peer: `status`, `ask`, `steer` or `note` |
| `h` / `b` | Hide / block the selected peer                                   |
| `v`       | Show hidden peers                                                |
| `Esc`     | Back / close                                                     |

Answers to messages sent from `/mesh` appear as `MESH` transcript cards. Hidden peers are left out of tool listings; blocked peers' requests are dropped by the engine. Both flags last for the process only.

## `omp mesh list`

```
omp mesh list           # peers found with the current settings
omp mesh list --json    # {"status": {...}, "peers": [...]}
```

Starts a short-lived engine with the current `mesh.*` settings (any free LAN port), discovers for 2.5 s, prints each peer (instance id, name, session, cwd, smol summary as one line cut to the terminal width or to 200 characters when piped, endpoint, source, state, host, PID, busy, model) and exits. It lists even while `mesh.enabled` is off. The listing node is itself unverified to running instances, so it does not appear in their peer lists.

## Security model

- **Sealed transport.** Both sides use the same framed request/response protocol, one connection per request. The envelope is AES-256-GCM sealed; plaintext routing info (version, msgId, sentAt, sender, recipient) is bound as associated data and must match the sealed copy, and each response is bound to its request's msgId and recipient. LAN traffic is sealed with an HKDF subkey of the mesh key; same-PC traffic with a key derived from the registry token, which never travels.
- **Trust group.** Local: the same OS account on the same machine. Remote: everyone holding the key. A key holder can do anything your inbound policies allow — guard the phrase like a password and keep `task` at `deny` unless every key holder is trusted to run code in your project.
- **Replay and freshness.** Messages outside a ±60 s clock window or repeating a sender + msgId already seen are rejected.
- **Limits.** 60 non-snapshot requests per minute per sender id and 180 per source IP; 64 concurrent connections, 8 per LAN source IP; 256 KiB envelopes, 64 KiB text, 1024-character fields; 256 requests awaiting an answer.
- **Unauthenticated on the LAN.** mDNS announcements (instance id, group tag, display name, port) and the transport's pre-auth rejections. Forging them can hide or misdirect peers (denial of service), not read or send messages.
- **What peers see.** Any peer in the trust group can fetch this instance's snapshot: instance id, display name, host name, PID, omp version, session id and name, cwd, repo (origin remote with credentials redacted, branch, short head sha), model, busy flag, agent roster (id, kind, name, status, task), start time, and — unless `mesh.summary` is off — a smol-model summary of what the session is about (≤ 400 characters, regenerated at most every two minutes after a turn ends, stored beside the session). Session transcripts are never shared; `status`/`ask` answers are produced by your agent and may quote context.
- Peer-supplied text is untrusted: it is harness-tag escaped before reaching an agent and stripped of control sequences before rendering.

## Limitations

- LAN only: mDNS is link-local and IPv4-only; other subnets need `mesh.peers`. No NAT traversal or internet relay.
- LAN machines' clocks must agree within 60 s.
- Hide/block flags are not persisted.
- Headless hosts deny `ask`-policy kinds and notes.
- One mesh host per process; ACP serves its newest session.

## Settings

See [Settings → Mesh](./settings.md#mesh) for every `mesh.*` key.

## Implementation files

- [`crates/pi-mesh`](../crates/pi-mesh/src/) — engine: keys, wire protocol, transports, registry, mDNS, peer table, inbound admission
- [`crates/pi-natives/src/mesh.rs`](../crates/pi-natives/src/mesh.rs) — N-API binding (`MeshNode`, `meshDeriveKey`)
- [`src/mesh/host.ts`](../packages/coding-agent/src/mesh/host.ts), [`native-engine.ts`](../packages/coding-agent/src/mesh/native-engine.ts) — host wiring, settings → engine
- [`src/mesh/inbound.ts`](../packages/coding-agent/src/mesh/inbound.ts), [`responder.ts`](../packages/coding-agent/src/mesh/responder.ts), [`threads.ts`](../packages/coding-agent/src/mesh/threads.ts), [`approvals.ts`](../packages/coding-agent/src/mesh/approvals.ts) — inbound policy, answering, threads
- [`src/mesh/outbound.ts`](../packages/coding-agent/src/mesh/outbound.ts), [`bridge.ts`](../packages/coding-agent/src/mesh/bridge.ts) — reply routing and delivery into sessions
- [`src/mesh/snapshot.ts`](../packages/coding-agent/src/mesh/snapshot.ts), [`summary.ts`](../packages/coding-agent/src/mesh/summary.ts) — what peers see
- [`src/tools/mesh-peers.ts`](../packages/coding-agent/src/tools/mesh-peers.ts), [`mesh-send.ts`](../packages/coding-agent/src/tools/mesh-send.ts), [`src/internal-urls/mesh-protocol.ts`](../packages/coding-agent/src/internal-urls/mesh-protocol.ts) — agent surface
- [`src/cli/mesh-cli.ts`](../packages/coding-agent/src/cli/mesh-cli.ts) — `omp mesh`
- [`packages/tui/src/overlays/mesh-manager.ts`](../packages/tui/src/overlays/mesh-manager.ts) — `/mesh` overlay
