# mesh_send

> Send a mesh message to another omp instance's main agent (or its human) and, for questions, wait for the answer.

## Source

- Entry: `packages/coding-agent/src/tools/mesh-send.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/mesh-send.md`
- Sender side (reply routing, late delivery): `packages/coding-agent/src/mesh/outbound.ts`
- Peer resolution: `packages/coding-agent/src/mesh/peers.ts`

## Registration / Visibility

- Tool metadata: `strict = true`, `loadMode = "discoverable"` (presented as `xd://mesh_send` in `tools.xdev` sessions).
- Approval per `kind`: `status`, `ask`, `watch`, `note` → `write`; `steer`, `task`, `reply` → `exec`; anything else fails closed to `exec`.
- Registered only while `mesh.enabled` is on and only in the top-level session the running mesh runtime is bound to, like `mesh_peers`.

## Inputs

| Field        | Type                                                       |       Required | Description                                                                                                                       |
| ------------ | ---------------------------------------------------------- | -------------: | --------------------------------------------------------------------------------------------------------------------------------- |
| `to`         | `string`                                                   |            Yes | Exact instance id, unique (case-insensitive) id prefix, or unique display/session name.                                           |
| `kind`       | `status \| ask \| task \| steer \| note \| watch \| reply` |            Yes | Message kind.                                                                                                                     |
| `message`    | `string`                                                   | Except `watch` | Text, at most 64 KiB.                                                                                                             |
| `thread`     | `string`                                                   |             No | `status`/`ask`/`task` follow-up in an existing thread.                                                                            |
| `replyTo`    | `string`                                                   |        `reply` | msgId of the peer message being answered.                                                                                         |
| `event`      | `idle \| turn_end`                                         |        `watch` | Event to be notified about.                                                                                                       |
| `timeoutSec` | `number > 0`                                               |             No | `status`/`ask`/`task`: answer wait, default 300, max 1800. `watch`: lifetime in whole seconds (rounded up), 1–3600, default 3600. |

`to` resolution: this instance's own id fails. An exact instance id of a peer with a snapshot resolves to it (hidden peers included). Any other well-formed instance id (16 lowercase letters or digits) addresses that instance directly, listed or not, so a crashed or not yet discovered instance fails with the engine's transport error (`unreachable: no reachable mesh peer <id>`, or the connection failure) instead of a resolution error. Otherwise the visible peers whose display or session name equals `to` (case-insensitive) together with those whose instance id starts with it must be exactly one peer; a name and a different peer's id prefix are ambiguous, so a peer cannot capture name-addressed sends with a look-alike id. Ambiguity fails listing the candidates. Peers without a snapshot (unverified or transient) never resolve by name or prefix.

Sends to a blocked peer fail before anything is sent, except `note`: the engine refuses everything a blocked peer sends (`denied: sender is blocked`), so answers, steer replies and watch events could never arrive.

## Outputs

- `status`/`ask`/`task`: the message is acknowledged with a msgId and thread; the tool then waits on the msgId. An answer returns `Answer from <peer> (thread <id> …)` followed by the peer's text (harness-tag escaped); a peer error returns `could not answer`. Timeout returns the thread id and msgId without failing; the answer is later delivered to the asking agent as a hidden `mesh:reply` message, or dropped if that session has closed or its conversation was replaced (`/new`, context reset, resume, fork).
- Auto-background (`mesh.autoBackground.enabled`, default on): when `timeoutSec` exceeds `mesh.autoBackground.thresholdMs` (default 10 s), the wait runs as a `mesh` job in the session's async job manager. An answer within the threshold returns inline; otherwise (or as soon as user steering queues) the call returns the job id, thread and msgId, and the job keeps waiting up to `timeoutSec`. Its answer is delivered as an `async-result` follow-up that wakes an idle agent; `wait` blocks on it and `proc://<id>/kill` stops it (a later answer then arrives as `mesh:reply`). A job that runs out of time ends `cancelled` without a delivery, so only the eventual `mesh:reply` wakes the agent. Without a job manager, at the job cap, or with the setting off, the call waits inline as before.
- `steer`/`note`: acknowledgement with the msgId; replies to a steer arrive later as messages. When the recipient's policy for the kind is `ask`, the acknowledgement carries `pending: "approval"` and a steer returns `Steer to <peer> is waiting for its user's approval (msgId …)`: a denial (`denied: the user declined this steer.`) or a reply arrives later as a message.
- `watch`: the watch id; the event arrives later as a hidden `mesh:watch` message.
- `reply`: delivery ack.
- Peer refusals (`<peer> refused: <code>: <message>`, e.g. `denied`, `busy`) and transport failures (`<peer> <code>: <message>`, `code` one of `unreachable`, `timeout`, `bad_response`, `aborted`) are tool errors.

`details = { kind, to, msgId?, thread?, watchId?, answered?, jobId? }`. The sender agent id is the calling session's agent id (`Main` for the main session).
