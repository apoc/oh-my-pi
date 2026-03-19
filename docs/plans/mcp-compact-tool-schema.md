# MCP Compact Tool Schema: Hybrid Activation Plan

## Problem

MCP tool schemas are sent to LLM providers as JSON Schema in the `tools` API parameter. Each tool definition costs ~100-150 tokens. A server with 50 tools burns ~6,000 tokens before the agent reasons about anything. Multiple servers compound: 150+ tools across GitHub, Graph, Jira, etc. can exceed 20,000 tokens of schema overhead.

OMP has a discovery mode (`search_tool_bm25`) that hides MCP tools and lets the agent search for them via BM25 keyword matching. This reduces the upfront cost, but has a fundamental flaw: **the agent must already know what to search for.** A tool called `find_similar_code` won't surface when the agent thinks in terms of "grep for patterns." A tool called `get_dependency_graph` won't surface when the agent thinks "check imports." BM25 keyword search cannot bridge conceptual gaps between how the agent frames a problem and how tool authors named their tools.

## Solution

Replace the opaque "nucleus (47 tools)" summary with **compact TypeScript-like signatures** visible in the system prompt. The agent sees all available tools at a glance, recognizes useful ones through comprehension rather than keyword search, and activates them on demand. Activated tools get full JSON Schema for provider-level validation.

### Compact signature format

Each MCP tool is rendered as a single-line function signature:

```
server/tool_name(required_param: type, optional?: type): ReturnShape
```

Concrete examples from a real nucleus MCP server:

```
## MCP Tools (compact — call activate_mcp_tools to use)

### nucleus (12 tools)
nucleus/search_code(query: string, intent?: "logic"|"exploration"|"usage"|"debug", directories?: string[], top_k?: int): SearchResult[]
nucleus/find_similar_code(code: string, directories?: string[], threshold?: float, limit?: int): SimilarMatch[]
nucleus/get_dependency_graph(file: string, direction?: "inbound"|"outbound"|"both", limit?: int): DependencyGraph
nucleus/get_symbol(symbol_id: string, body_mode?: "preview"|"full"): SymbolDefinition
nucleus/search_symbols(query: string[], kind?: "struct"|"fn"|"impl"|"const"|"type"|"trait"|"enum"|"mod", limit?: int): SymbolMatch[]
nucleus/file_overview(file: string, depth?: int): FileSymbols
nucleus/find_duplicate_code(directories?: string[], threshold?: float, cross_file_only?: bool): DuplicateCluster[]
nucleus/get_usages(symbol_id: string, limit?: int, offset?: int): UsageRef[]
nucleus/resolve_symbol_at(file: string, line: int, column?: int): ResolvedSymbol
nucleus/list_dir(path: string, recursive?: bool, glob?: string, limit?: int): DirEntry[]
nucleus/get_implementors(symbol_id: string, limit?: int): Implementor[]
nucleus/class_overview(symbol_id: string): ClassApi
```

This catalog is ~600 tokens for 12 tools. The same 12 tools as native JSON Schema tool definitions would be ~1,500+ tokens. More importantly, the agent **sees and comprehends** every tool — no search required.

### Activation flow

```
1. System prompt includes compact signatures (~35 tokens/tool)
2. Agent reads signatures, understands available capabilities
3. Agent decides to use a tool → calls activate_mcp_tools(["nucleus/find_similar_code", "nucleus/get_dependency_graph"])
4. OMP registers those tools as native provider tools (full JSON Schema, strict validation)
5. Agent calls the activated tools normally via structured tool calls
6. Activated tools persist for the session; subsequent activations add to the set
```

### Tiered strategy by tool count

| Tool count | Strategy | Rationale |
|---|---|---|
| 1-80 | Compact signatures in system prompt, no BM25 | Agent has full visibility. ~2,800 tokens max. No search needed. |
| 81-200 | Compact signatures for priority servers + BM25 for overflow | Prioritize servers listed in `mcp.discoveryDefaultServers`. Rest discoverable via search. |
| 200+ | BM25 only (current behavior) | Compact signatures would exceed useful prompt budget. |

The threshold settings are configurable via `mcp.compactSignatureMaxTools` (default: 80).

## Design: Compact Signature Generator

### Type mapping rules

JSON Schema types map to compact TypeScript-like tokens:

| JSON Schema | Compact | Notes |
|---|---|---|
| `{"type": "string"}` | `string` | |
| `{"type": "integer"}` | `int` | Not `number` — preserves the constraint |
| `{"type": "number"}` | `float` | |
| `{"type": "boolean"}` | `bool` | |
| `{"type": "array", "items": {...}}` | `T[]` | Recurse into items |
| `{"type": "object"}` (no properties) | `object` | Opaque object |
| `{"type": "object", "properties": {...}}` | `{key: type, ...}` | Inline if <= 3 properties, else `object` |
| `{"enum": ["a", "b", "c"]}` | `"a"\|"b"\|"c"` | Pipe-separated literal union |
| `{"anyOf": [...]}` | `T1\|T2` | Union |
| nullable type | `T?` appended to the param with `?` | |

### Optional parameters

Parameters NOT listed in `required` array get `?` suffix:

```
search_code(query: string, intent?: "logic"|"exploration"|"usage"|"debug")
                          ^^ optional
```

### Return type

MCP tools don't declare return types in their schema. The compact signature uses a generic placeholder:

```
nucleus/search_code(...): result
```

If the tool's `description` mentions a specific shape (e.g., "returns a list of matches"), the generator can attempt to extract a hint, but this is optional. `result` is the safe default.

### Handling complex schemas

Some MCP tools have deeply nested schemas. Rules for keeping signatures readable:

1. **Inline objects with <= 3 properties**: `{file: string, line: int, column?: int}`
2. **Collapse objects with > 3 properties**: `object` (the full schema is available after activation)
3. **Max signature length**: ~200 chars. If exceeded, truncate parameters with `...` and rely on the tool description.
4. **Description passthrough**: The tool's `description` field is rendered on a separate line below the signature if it adds context beyond what the signature conveys. Omit if redundant.

### Example generator output

Input (JSON Schema from MCP `tools/list`):
```json
{
  "name": "find_similar_code",
  "description": "Find semantically similar code. Scores: >=0.85 likely duplicate, 0.7-0.85 consider generalizing.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "code": {"type": "string", "description": "Code snippet to find similar blocks for"},
      "directories": {"type": "array", "items": {"type": "string"}, "description": "Directory prefixes to scope search"},
      "threshold": {"type": "number", "description": "Minimum similarity threshold 0.0-1.0 (default: 0.7)"},
      "limit": {"type": "integer", "description": "Maximum results to return (default: 5)"},
      "path_glob": {"type": "string", "description": "Glob post-filter"}
    },
    "required": ["code"]
  }
}
```

Output:
```
nucleus/find_similar_code(code: string, directories?: string[], threshold?: float, limit?: int, path_glob?: string): result
  Find semantically similar code. Scores: >=0.85 likely duplicate, 0.7-0.85 consider generalizing.
```

~45 tokens for the signature + description. The same tool as native JSON Schema: ~130 tokens.

## Design: activate_mcp_tools Tool

A new built-in tool that replaces `search_tool_bm25` for the compact signature flow:

```typescript
const activateMcpToolsSchema = Type.Object({
    tools: Type.Array(
        Type.String({ description: "Tool name as shown in compact catalog (e.g. 'nucleus/find_similar_code')" }),
        { description: "Tools to activate for this session", minItems: 1 }
    ),
});
```

Behavior:
1. Resolve each name against the hidden MCP tool registry
2. Register matched tools as native provider tools (full JSON Schema)
3. Return confirmation with activated tool names
4. Tools remain active for the rest of the session
5. If a tool is already active, skip silently
6. If a name doesn't match, return it in an `unresolved` list

The agent calls it like:
```json
{"name": "activate_mcp_tools", "arguments": {"tools": ["nucleus/find_similar_code", "nucleus/get_dependency_graph"]}}
```

Response:
```json
{"activated": ["nucleus/find_similar_code", "nucleus/get_dependency_graph"], "already_active": [], "unresolved": []}
```

### Why not reuse search_tool_bm25?

`search_tool_bm25` combines search + activation in one tool. The compact signature approach separates these concerns:

- **Discovery**: the agent reads compact signatures in the system prompt (no tool call needed)
- **Activation**: the agent explicitly names which tools it wants (no search ranking, no score thresholds, no keyword guessing)

`search_tool_bm25` remains available as a fallback for the 81+ tool tier where compact signatures overflow into BM25-only mode.

## Implementation

### Phase 1: Compact signature generator

New file: `packages/coding-agent/src/mcp/compact-signature.ts`

Functions:
- `compactType(schema: unknown): string` — JSON Schema -> compact type string
- `compactSignature(serverName: string, tool: MCPToolDefinition): string` — full signature line
- `compactToolCatalog(tools: DiscoverableMCPTool[], toolDefs: Map<string, MCPToolDefinition>): string` — grouped catalog text
- `shouldUseCompactSignatures(toolCount: number, maxTools: number): boolean` — threshold check

Unit tests: property-based tests covering all JSON Schema type variants, edge cases (empty schemas, deeply nested objects, circular `$ref` after deref).

### Phase 2: activate_mcp_tools tool

New file: `packages/coding-agent/src/tools/activate-mcp-tools.ts`

Implements `AgentTool` interface. Needs access to:
- Hidden MCP tool registry (via `ToolSession`)
- Tool activation mechanism (existing `activateDiscoveredMCPTools` on session)

Renderer: simple status line showing activated/unresolved counts.

### Phase 3: System prompt integration

Modify: `packages/coding-agent/src/sdk.ts` — `rebuildSystemPrompt()`
- When compact signature mode is active, generate the catalog and pass it to the prompt builder
- Register `activate_mcp_tools` instead of (or alongside) `search_tool_bm25`

Modify: `packages/coding-agent/src/prompts/system/system-prompt.md`
- New `{{#if compactMCPCatalog}}` section that renders the catalog
- Replace the current `mcpDiscoveryMode` block's opaque summary with the catalog

Modify: `packages/coding-agent/src/system-prompt.ts` — `BuildSystemPromptOptions`
- Add `compactMCPCatalog?: string` field
- Thread it through to the template data

### Phase 4: Settings and tiered logic

Modify: `packages/coding-agent/src/config/settings-schema.ts`
- Add `mcp.compactSignatureMaxTools` setting (default: 80)
- Existing `mcp.discoveryMode` continues to control whether MCP tools are hidden by default

Modify: `packages/coding-agent/src/sdk.ts`
- Tiered logic: if `discoveryMode` is enabled AND tool count <= threshold, use compact signatures; else fall back to BM25-only

### Phase 5: JSON Schema stripping (optional optimization)

Modify: `packages/ai/src/utils/schema/sanitize-google.ts` — `sanitizeSchemaForMCP()`
- Add option to strip `description` fields from properties when compact signatures are providing the documentation
- Only applied to MCP tools, not built-in tools (which need descriptions for provider understanding)

This is additive to the compact signature approach — it further reduces tokens for activated tools.

## Files changed

| File | Change |
|---|---|
| `packages/coding-agent/src/mcp/compact-signature.ts` | **New** — signature generator |
| `packages/coding-agent/src/tools/activate-mcp-tools.ts` | **New** — activation tool |
| `packages/coding-agent/src/sdk.ts` | Tiered logic, catalog generation, tool registration |
| `packages/coding-agent/src/system-prompt.ts` | New `compactMCPCatalog` option |
| `packages/coding-agent/src/prompts/system/system-prompt.md` | Compact catalog template block |
| `packages/coding-agent/src/config/settings-schema.ts` | New threshold setting |
| `packages/coding-agent/src/tools/search-tool-bm25.ts` | Remains, used as fallback for large tool sets |
| `packages/coding-agent/src/mcp/discoverable-tool-metadata.ts` | Extend `DiscoverableMCPTool` with `inputSchema` ref for signature generation |
| `packages/ai/src/utils/schema/sanitize-google.ts` | Optional: strip descriptions in compact mode |

## Token budget comparison

Scenario: 47 MCP tools from a single server (real-world nucleus setup).

| Approach | Schema tokens | Prompt tokens | Total |
|---|---|---|---|
| All native tools (no discovery) | ~6,100 | ~470 | ~6,570 |
| BM25 discovery (current) | 0 (hidden) | ~120 (summary) | ~120 + search cost |
| **Compact signatures (proposed)** | 0 (hidden until activated) | ~1,650 (catalog) | ~1,650 |
| Compact + 5 activated tools | ~650 | ~1,650 | ~2,300 |

The compact approach costs ~1,650 tokens for full visibility of 47 tools. The current BM25 approach costs ~120 tokens but provides zero visibility — the agent is blind to tools it doesn't guess to search for.

## Non-goals

- Changing provider APIs or JSON Schema format (not possible, provider-dictated)
- Replacing MCP protocol (this optimizes the client-side representation only)
- Python kernel MCP integration (separate feature, complementary)
- Changing how non-MCP built-in tools are registered (they stay as native tools always)
