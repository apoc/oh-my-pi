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

`to` resolution: an exact instance id resolves directly (hidden peers included). Otherwise the visible peers whose display or session name equals `to` (case-insensitive) together with those whose instance id starts with it must be exactly one peer; a name and a different peer's id prefix are ambiguous, so a peer cannot capture name-addressed sends with a look-alike id. Ambiguity fails listing the candidates. Peers without a snapshot (unverified or transient) never resolve.

Sends to a blocked peer fail before anything is sent, except `note`: the engine drops everything a blocked peer sends, so answers, steer replies and watch events could never arrive.

## Outputs

- `status`/`ask`/`task`: the message is acknowledged with a msgId and thread; the tool then waits on the msgId. An answer returns `Answer from <peer> (thread <id> …)` followed by the peer's text (harness-tag escaped); a peer error returns `could not answer`. Timeout returns the thread id and msgId without failing; the answer is later delivered to the asking agent as a hidden `mesh:reply` message, or dropped if that session has closed or its conversation was replaced (`/new`, context reset, resume, fork).
- `steer`/`note`: delivery ack with the msgId; replies to a steer arrive later as messages.
- `watch`: the watch id; the event arrives later as a hidden `mesh:watch` message.
- `reply`: delivery ack.
- Peer refusals (`denied`, `busy`, …) and transport failures (`unreachable`, `timeout`, …) are tool errors.

`details = { kind, to, msgId?, thread?, watchId?, answered? }`. The sender agent id is the calling session's agent id (`Main` for the main session).
