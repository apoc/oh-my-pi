# mesh_peers

> List the other omp instances on the mesh, optionally ranked by relevance to a need.

## Source

- Entry: `packages/coding-agent/src/tools/mesh-peers.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/mesh-peers.md`
- Peer formatting and `to` resolution: `packages/coding-agent/src/mesh/peers.ts`
- Relevance ranking: `packages/coding-agent/src/mesh/relevance.ts`, questions in `packages/coding-agent/src/prompts/judge/mesh.json`
- Read-only scheme: `packages/coding-agent/src/internal-urls/mesh-protocol.ts`

## Registration / Visibility

- Tool metadata: `approval = "read"`, `strict = true`, `loadMode = "discoverable"` (presented as `xd://mesh_peers` in `tools.xdev` sessions).
- Registered only while `mesh.enabled` is on and only in the top-level session the running mesh runtime is bound to (`MeshRuntime.session`, matched by session manager). Subagents, mesh responders, other ACP sessions and hosts that do not start the mesh (print mode, SDK) never get it, even when their tool list names it. Toggling `mesh.enabled` and installing or removing the runtime add or remove it live.
- Executing while the process has no mesh runtime fails with `Mesh is not running in this process`.

## Inputs

| Field     | Type      | Required | Description                                                                        |
| --------- | --------- | -------: | ---------------------------------------------------------------------------------- |
| `query`   | `string`  |       No | Rank peers by relevance to this need.                                              |
| `refresh` | `boolean` |       No | Ask the engine to re-discover, then wait up to 1.5 s for the peer table to change. |

## Outputs

Single text result. Hidden peers and peers without a snapshot (unverified or transient, e.g. the short-lived node of `omp mesh list`) are omitted. Each peer block lists: instance id, display name, state (`online`/`stale`, `busy`/`idle`, `blocked`), session name, endpoint (`local` or `remote <ip>:<port> · <dns name|hostname>`, IPv6 addresses bracketed), last seen, cwd, branch, model, agent count and work summary. Peer-supplied text, error and acknowledgement text included, has Unicode bidi controls (U+061C, U+200E/200F, U+202A–202E, U+2066–2069) removed and harness tags escaped (`src/mesh/text.ts`); `mesh://` completion labels get the same bidi stripping.

With `query`, the first 32 peers are judged through the `judge` role chain (`resolveJudge`, purpose `mesh_peers`): a yes/no relevance question per peer gives the score, a choice question names the connecting field (`summary`, `repo`, `cwd`, `session`, `agents`, `none`) quoted as the reason. Peers are returned best first. A judge failure returns the unranked list prefixed with `Relevance ranking unavailable (<reason>)`.

`details = { peers: number, ranked: boolean }`.

## mesh://

| URL                          | Result                                                         |
| ---------------------------- | -------------------------------------------------------------- |
| `mesh://`                    | Visible peers, as `mesh_peers` without a query.                |
| `mesh://<peer>`              | Peer facts and its last snapshot, pretty JSON.                 |
| `mesh://<peer>/threads`      | Threads this instance asked that peer (fetched from the peer). |
| `mesh://<peer>/threads/<id>` | One thread's question/answer transcript.                       |

`<peer>` resolves like `mesh_send`'s `to`; the authority is decoded once by the URL parser, and a malformed path escape is a tool error. The scheme is read-only, advertised in the system prompt only where the mesh tools exist, and serves only that session. `mesh://` completion labels are stripped of control sequences.
