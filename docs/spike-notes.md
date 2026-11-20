# S0b spike notes (TrueForge)

Status legend: **VERIFIED-FROM-TYPES** (SDK `@truefoundry/trueforge-sdk` 0.185.0 `.d.ts`), **FROM-DOCS** (github.com/truefoundry/trueforge docs), **NEEDS-LIVE-RUN** (requires TrueForge + a configured model; not done in this pass: no model key available).

## Q1. `tool.approval_required` payload

- VERIFIED-FROM-TYPES `ToolApprovalRequiredEvent = { type: 'tool.approval_required', id, createdAt, threadId, toolCalls: { id, sourceEventId }[] }` (SDK is camelCase; the wire/docs use snake_case: `thread_id`, `tool_calls[].source_event_id`).
- **The event carries NO tool name and NO args.** It only references the call: `toolCalls[i].id` is the `toolCallId`, and `sourceEventId` is the `id` of the earlier `model.message` event whose `toolCalls[]` (`{ id, type:'function', function:{ name, arguments: string(JSON) }, toolInfo }`) holds the name and args. `threadId` is on the approval event itself (`"main"` for the root agent).
- Consequence (implemented in `runManager.ts`): index every `model.message` by `id` and look the call up by `sourceEventId` + `toolCalls[].id`. `tfClient.ts` merges `model.message.delta` events so that message is complete; if only deltas were seen, it yields the merged synthetic message just before the approval event.
- Deferred tools (FROM-DOCS): the model's call is `call_tool` with `arguments` containing `mcp_server`, `tool_name` (+ the real args). `runManager.describeCall` unwraps this. NEEDS-LIVE-RUN: exact key names for the inner args (assumed `tool_name`, `mcp_server`, and the tool's own args alongside or nested).
- Resume protocol (VERIFIED-FROM-TYPES): stream until `turn.update` with `state.status === 'paused'`; `subscribeToTurn(sessionId, turnId, { afterEventId })`; `createTurnEvents(sessionId, turnId, { events: [{ type:'user.tool_approval', threadId, toolCallId, approval:{status:'allow'} | {status:'deny', reason?} }] })`. `turnId` comes from the `turn.created` event (`turnId` field). Also available: `user.tool_approval_policy` (`allow_session`) to pre-approve a tool for a period.
- NEEDS-LIVE-RUN: whether the original `createTurnStream` response ends at the pause (our loop breaks on the paused `turn.update` either way), and whether parallel approvals need to be sent in one `createTurnEvents` batch (`TfClient.approve` sends one at a time).

## Q2. Does an allowed `propose_write` reach our MCP tool with byte-identical args?

- NEEDS-LIVE-RUN. What we know: args shown at approval time are `model.message.toolCalls[].function.arguments` (a JSON **string** as the model emitted it). TrueForge then calls our MCP server with parsed args; our server receives them as a JSON object after zod parsing, so byte identity of the *string* is not observable; only canonical-JSON equality is. `proposalKey = sha256(canonicalJson(args))` over sorted keys is the right design.
- Not guaranteed: zod 4 / MCP SDK strips unknown keys and may coerce, so key from the **parsed** args on both sides (approval side: `JSON.parse(arguments)` then canonicalize; same fields only). If it differs in the live run, use the plan's fallback (match the last allowed proposal for the run).
- Server side note: our handler never sees `toolCallId` (MCP `_meta` passthrough not verified).

## Q3. Agent definition format and field names for approval / deferred tools

- FROM-DOCS (`docs/create-agent/overview.mdx`, `key-features/deferred-tool-loading.mdx`): the format is a **JSON manifest** (not YAML), snake_case, `model` is the only required field. There is **no file-based agent loader**: agents are saved in TrueForge's registry through the UI (Build Agent -> Save Agent) or API (`POST /api/v1/agents`, SDK `agents.create({ name, description, manifest })`), or passed inline as `spec` on session create.
- Manifest fields: `model: { name: 'provider/model', params? }`, `instructions` (inline string, not a file reference), `mcp_servers: [{ name, enable_tools, disable_tools, preload, preload_tools, require_approval_for_tools }]`, `skills`, `config`, `response_format`, `messages`.
  - Approval: `require_approval_for_tools` (default `["@write","@destructive"]`; accepts `@all`, labels, or literal tool names). Our server has no write/destructive labels, so we list names: `["propose_write","run_command"]`.
  - Deferred: `preload` (default false: schemas discovered on demand) and `preload_tools` (eagerly loaded subset). So "deferred" = every tool not in `preload_tools` while `preload: false`: preload `search_workspace, read_file, assemble_context, propose_write`; `run_command`, `list_symbols` stay deferred.
- **MCP servers are NOT defined inside the agent.** `mcp_servers[].name` refers to a connector configured in Settings -> Connectors ("Add MCP Server", custom URL, header auth), or via SDK `settings.mcpServers.create({ manifest: { type:'remote', name, description, url, auth:{ type:'header', headers } } })` (VERIFIED-FROM-TYPES). So URL `http://127.0.0.1:8791/mcp` and `X-Contexo-Token` live in `extension/trueforge/contexo-editor.mcp.json`, not in the agent files.
- Files written: `extension/trueforge/contexo.agent.json`, `contexo-fallback.agent.json` (REST shape `{name, description, manifest}`, placeholders `<PRIMARY_MODEL>`/`<FALLBACK_MODEL>`), `contexo-editor.mcp.json`, and `register.mjs` (creates the connector and both agents via the SDK, inlining `instructions.md`). NEEDS-LIVE-RUN: run `register.mjs` once against a live TrueForge (unverified).

## Q4. Bad key / unreachable endpoint behaviour

- Partially VERIFIED-FROM-TYPES / FROM-DOCS: `turn.done` has `state.status` of `done | cancelled | error`; `error` carries `message`; cancel carries `reason` (`client-cancelled`, `server-execution-timeout`, `cancelled-for-next-turn`, `abandoned`). A subscription can end without `turn.done` (resubscribe from last event id). SDK default stream timeout is 60 s; we set 600 s. SDK retries 2x by default.
- **LIVE-VERIFIED (spare TrueForge (npx @latest) on port 8793, Windows; see "Live findings" below).** A model that cannot be reached is shape (a): the stream opens normally, then ends with `turn.done` and `state: { status: 'error', message: '[Model Error] Cannot connect to API: bad port', completedAt, metrics: { totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0 } }`, within ~30 ms of the request (no hang, no thrown HTTP error). `classifyDetailed` maps it to `{ kind: 'model-failure', reason: '[Model Error] Cannot connect to API: bad port', trueforgeDown: false }`. Unreachable TrueForge itself is still a thrown fetch error (ECONNREFUSED). The `firstEventTimeoutMs` guard stays for the hang case (not observed).

## Q5. Can `TrueForgeUI` render an existing session read-only while the host sends turns?

- Partially VERIFIED-FROM-TYPES (`@truefoundry/trueforge-ui` 0.185.1): `TrueForgeUI` accepts `initialSessionId` and a `server` config (`TrueForgeServerConfig`, with a `baseUrl`), so attaching to an existing session for display is plausible. But the UI is an interactive chat: it owns its composer, approval bar (`ToolApprovalContainer`) and cancel, and drives turns itself. There is no documented read-only mode, so it would compete with the host for approvals. Also needs CSP `connect-src http://localhost:8790` and TrueForge CORS for the `vscode-webview://` origin (NEEDS-LIVE-RUN).
- Recommendation: **host-relayed renderer** (ChatTab renders `UiStreamEvent`s from the host), because approvals, Stop and fallback must be host-owned. Re-evaluate only if a live run shows a clean read-only slot-override of the composer/approval components.

## Other findings

- `npx @truefoundry/trueforge@latest`: CLI (`dist/cli.js`) is `parseArgs` strict with only `--port <n>` and `-h/--help` (unknown flags throw, e.g. `--version` fails). Env: `PORT`, `SQLITE_PATH`, `PUBLIC_BASE_URL`, `STANDALONE` (default standalone SQLite, no Redis). Needs Node >= 22.14. `--help` is safe (prints usage and exits). Starting it is non-interactive (plain server, no prompts); not started in this pass. Local mode has no login by default.
- Registering agents: UI (Build Agent / Save Agent), API/SDK (`agents.create`, `settings.mcpServers.create`), or `trueforge/register.mjs`. No CLI or file loader.
- Models: Settings -> Models -> provider -> Configure -> key. Agent `model.name` is `provider/model`.
- `sessionUrl` is `${baseUrl}/sessions/${id}`. NOT VERIFIED. The UI docs mention a default session deep link `'/sessions/:sessionId'` (trueforge-ui route config), so this is likely right; confirm in the live run.
- SDK API actually used (all VERIFIED-FROM-TYPES): `new TrueForge({ baseUrl, timeoutInSeconds })`; `sessions.create({ agent:{name} })` -> `{ data: Session }`; `sessions.createTurnStream(id, { input:[{type:'user.message', content}] }, { abortSignal })` -> `Stream<TurnStreamingEvent>` (async iterable); `sessions.subscribeToTurn(id, turnId, { afterEventId })`; `sessions.createTurnEvents(id, turnId, { events })`; `sessions.cancel(id)`; `sessions.list({ limit })`; `isEventDelta`, `mergeEventDelta` (top-level exports).
- MCP SDK 1.32.2 + zod 4.6.7: `McpServer.registerTool(name, { description, inputSchema: <zod raw shape> }, cb)` and `StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })` work together; checked with a local JSON-RPC smoke test (401 on bad token, 405 on GET, initialize, tools/list returns the 6 tools, tools/call works, zod limit violation returns an `isError` result).

## Failure shapes (from SDK types, Slice 8)

Status: FROM-SDK-TYPES. Q4 still needs a live confirmation against a running TrueForge.

- `TrueForgeError` carries `statusCode`, `body`, `rawResponse`, `cause`.
- Subclasses carry the HTTP status.
- `TrueForgeTimeoutError` is identified by its `name`; it has no status.
- Network failure is a plain `TrueForgeError` with message 'fetch failed', no `statusCode`, and `cause` = a Node error with `code` (ECONNREFUSED etc.).
- User abort maps to reason 'aborted'.
- `turn.done` state on failure: `{status:'error', message, completedAt, metrics?}`.

## Provider/model API (onboarding)

Status: VERIFIED-FROM-TYPES (SDK 0.185.0 `.d.ts`) plus a LIVE check of the read calls against a locally auto-started TrueForge (health, catalog: 9 providers, configured providers, models). Writing a provider key was NOT exercised live (no real key used).

- **Keys CAN be set via the API.** `client.settings.modelProviders.createOrUpdate({ manifest })` (create-or-replace; `create` fails on name conflict). Manifest: `{ type, auth: { apiKey }, models: [{ modelId, name, properties }], baseUrl? }`; `custom` also needs `name` and `baseUrl` (auth optional); `truefoundry` needs `baseUrl`. `models` is REQUIRED, so the extension copies the catalog's models for the chosen provider. Well-known types use `type` as the provider name (one each). A redacted key keeps the stored one; a real value sets/rotates. Delete: `settings.modelProviders.delete(name)`.
- Catalog: `client.catalogs.modelProviders.list()` -> `data[]` of `{ type, logo?, models:[{modelId,name,properties}] }` (well-known: openai, anthropic, google-gemini, fireworks, zai, moonshot, alibaba, together) or `{ type:'custom', supportedReasoningEfforts }`. Live: 9 entries.
- Configured providers: `client.settings.modelProviders.list()` -> `data[]` `{ name, manifest }`.
- Configured models: `client.models.list()` -> `data[]` `{ modelId, name, provider:{name}, properties, warning? }`. The extension addresses a model as `${provider.name}/${name}` (the docs only say agents reference models by name; NEEDS-LIVE-RUN with a real model to confirm the `provider/model` form).
- Connectors: `client.settings.mcpServers.list() / get(name) / create / createOrUpdate({manifest}) / delete(name)`; manifest `{ type:'remote', name, description, url, auth:{ type:'header', headers } }`. The extension uses `createOrUpdate` (idempotent).
- Agents: `client.agents.list({ agentName, limit })` (paged; `.data`), `create({ name, description, manifest })`, `update(agentId, { description, manifest })` (by id, not name), `get(id)`, `delete(id)`. The extension lists by name, then updates or creates.
- Health: there is no health endpoint in the SDK or docs; `client.server.getCapabilities()` (`GET /api/v1/capabilities`, 200 without auth locally) is used as the health probe.
- SDK request types are camelCase (`mcpServers`, `requireApprovalForTools`, `preloadTools`, `iterationLimit`); the SDK serialises to snake_case. `src/run/manifests.ts` uses camelCase; `register.mjs` passes the snake_case JSON through (the SDK passes unknown keys through, so it likely works, but it is unverified; test/manifests.test.ts keeps the two in sync).
- Local TrueForge on Windows: `npx -y @truefoundry/trueforge@latest --port 8790` starts in about 30 s from a warm npx cache and logs "Agent server listening"; auth disabled; warns that the local sandbox is unsupported on win32 (irrelevant to Contexo). Stopping the npx process tree with tree-kill frees the port.

## Live findings (Session tab / Test resilience pass)

Run against a spare local TrueForge (own SQLite DB, `OUTBOUND_URL_ALLOWED_HOSTS=["127.0.0.1"]`, port 8793) with a scripted OpenAI-compatible fake model and a fake MCP server (so tool calls and approvals were real TrueForge behaviour, not mocks).

- **Failure shape (Q4).** Broken provider `contexo-broken` = custom provider, `baseUrl http://127.0.0.1:9/v1`, key dummy. Loopback is allowed when `OUTBOUND_URL_ALLOWED_HOSTS` includes 127.0.0.1 (Contexo sets it). Port 9 is on the fetch "bad port" blocklist, so the failure is instantaneous: `turn.done` `{ status: 'error', message: '[Model Error] Cannot connect to API: bad port' }`; before it, the stream carries an empty `model.message` (with `model.name`) and `mcp.initialize`. `classifyDetailed(turn.done)` -> `model-failure`, so primary -> fallback takeover works; with the fallback broken too, the run ends `Both models failed: [Model Error] Cannot connect to API: bad port; [Model Error] Cannot connect to API: bad port. No files were changed.` Creating a custom provider with an unreachable base URL succeeds (no validation at create time).
- **MCP connector unreachable** is a different `turn.done` error: `[MCP Error] Failed to connect to remote MCP server 'contexo-editor': failed to connect (tried streamable-http, sse): ... ECONNREFUSED 127.0.0.1:<port>`. `classify` currently also maps this to `model-failure` (the text contains ECONNREFUSED), so a dead Contexo MCP server would trigger a pointless fallback. Not changed in this pass.
- **Stream shape for tool calls (affects Q1).** TrueForge streams an EMPTY `model.message` placeholder first, then only `model.message.delta` events (tool-call `id`, `toolInfo`, argument fragments) for the same id; no complete `model.message` follows in the stream (the persisted event list does contain the complete one). The old `withMerge` treated the placeholder as the real message and never yielded the merged one, so `tool.approval_required` resolved to tool name `unknown` and `propose_write` would have been auto-denied. Fixed in `tfClient.withMerge`: merged messages are yielded before `tool.response` / `tool.approval_required` / `turn.done` / end of stream (unit-tested).
- **Approval payload (Q1) confirmed:** `tool.approval_required { threadId, toolCalls: [{ id, sourceEventId }] }`; resume via `subscribeToTurn(afterEventId)` + `createTurnEvents(user.tool_approval)` works and the SAME turn continues (`done` after the resume). Persisted events then include `user.tool_approval { approval: { status } }`.
- **Deferred tools (Q1/Q3) confirmed:** the model's call is `call_tool` with arguments `{ mcp_server, tool_name, arguments }`; `toolInfo` is `{ type: 'truefoundry-system', name: 'call_tool' }`. Direct MCP calls carry `toolInfo { type: 'mcp', name, serverId, serverName }`. Only `assemble_context, propose_write, read_file, search_workspace` are preloaded; `list_symbols` and `run_command` go through `call_tool`.
- **Session API limits:** `sessions.listTurns` accepts `limit <= 25` (400 otherwise). `sessions.list` rows have `agent: { type: 'reference', id, name }`, `title` (first user message), `lastTurnDetails.state.status`. Persisted turn events are complete messages (no deltas); the inspector still merges deltas for in-flight turns.
- **Server binding:** the spare instance listened on `[::1]` only; `http://localhost:<port>` works, `http://127.0.0.1:<port>` did not (use `localhost`, as the default `contexo.trueforgeUrl` does).
- **Session deep link (open question above):** no longer needed; the Session tab replaces it.
