# Contexo write-up

## 1. Team

- Members, college or employer, GitHub handles: `[TODO: team names, college/employer, GitHub handles]`
- Component ownership: C1 panel and webview, C2 run manager and TrueForge client, C3 MCP tools and context, C4 review and undo `[TODO: confirm who owned which component]`

## 2. Starting point

Forked from `microsoft/vscode-extension-samples`, path `webview-view-sample/`, commit `65c1c44800eeac6fb065a54823ee5ae62c79540a` (MIT, licence preserved in `extension/LICENSE.upstream`). We took only the `WebviewViewProvider` shape, the CSP meta tag and `getNonce()`; everything else (TrueForge client, MCP server, retrieval, review, undo, fallback, React UI) is our own work. The upstream sample has no agent loop, so no upstream loop was kept. Full provenance and dependency licences: `UPSTREAMS.md`.

## 3. Architecture on TrueForge

The extension is a client and an MCP server of a local TrueForge (`npx @truefoundry/trueforge@latest`).

- **Client.** `RunManager` uses `@truefoundry/trueforge-sdk` to create a session on the `contexo` agent, send turns, stream events to the panel (tokens appear as they arrive), and resume paused turns with approvals. Stop aborts the stream locally first, discards any pending proposal, kills any running command, then calls `sessions.cancel`.
- **MCP tools.** A local Streamable HTTP server (127.0.0.1, `X-Contexo-Token` header) is registered in TrueForge as the connector `contexo-editor`. It exposes six tools: `search_workspace`, `read_file`, `assemble_context`, `list_symbols`, `propose_write`, `run_command`. The agent, not the extension, decides what to read and change; the extension never calls a model provider (a grep check in `npm run check` enforces this).
- **Approval-gated review.** The agent definition sets `require_approval_for_tools: ["propose_write", "run_command"]`. When TrueForge pauses on `propose_write`, the extension looks up the call, runs guards (stale base hash, exact-match `oldText`, scope for inline edits, lexical symbol check) and opens a diff per file with per-hunk Accept/Reject CodeLens. Nothing touches disk until the user applies; the apply result (`applied` / `rejected` hunks) is returned to the agent as the tool result. Applied hunks are undoable per hunk or per apply from the Changes tab.
- **Deferred tool loading.** The agent preloads only `search_workspace`, `read_file`, `assemble_context` and `propose_write`; `run_command` and `list_symbols` stay deferred and are discovered on demand. This keeps the tool schemas out of the context until needed.
- **Fallback.** A second agent `contexo-fallback` (same tools and instructions, different model). If the primary fails (HTTP 401/403/404/408/429/5xx, network error, provider error text in `turn.done`, or no first event within `contexo.firstEventTimeoutMs`), `takeOver` seals the primary session and replays the original request on the fallback once, with a banner. It never runs after Stop or after an approved write.

Not used: subagents, compaction, Code Mode, skills, sandbox (see section 8). Video: Task A `[TODO mm:ss]`, Task B TrueForge session `[TODO mm:ss]`, Task C `[TODO mm:ss]`.

## 4. How context is selected

`assemble_context` is a budgeted hybrid retriever (budget `contexo.excerptBudget`, default 8000 tokens, counted with `js-tiktoken` cl100k_base and labelled approximate).

1. **Anchors**: `@path` / `@symbol` mentions and the editor selection are mandatory. Search terms come from the request (quoted strings, UPPERCASE constants, identifiers, CLI phrases, words minus stopwords, a small synonym table such as command -> click, add_command, cli). Terms that occur in more than 30% of symbols are dropped.
2. **Candidate lists**, each ranked separately: BM25 over Tree-sitter code symbols, BM25 over doc sections, symbol-name match (exact before prefix), and ripgrep hits mapped to their enclosing symbol.
3. **One-hop expansion** of the top 10 fused symbols: calls, called-by, registers (click decorators, `add_command` sites), tests, and docs that name the symbol.
4. **Reciprocal Rank Fusion** with k = 60 merges the lists and their reasons.
5. **Budgeted packing**: mandatory items first, then a coverage quota reserving the best test and best docs candidate, then greedy by score per token; overlapping ranges are dropped, repeated files are penalised, oversized symbols are trimmed to signature, docstring and matching lines.

Every excerpt carries its reasons, and every omission is listed with a reason (over-budget, duplicate, lower-rank) in the Context tab (graph plus ranked list). On Task B the packet used 7002 of 8000 tokens and included the `cli.py` command registration, `tests/test_cli.py` and `docs/cli.rst` without the user naming any file `[TODO: re-confirm on the final recording]`. If retrieval is weak the agent can call `assemble_context` again with new anchors, or use `search_workspace` and `list_symbols`.

## 5. Model setup

Models are configured only in TrueForge (Settings -> Models); the repo contains placeholders (`<PRIMARY_MODEL>`, `<FALLBACK_MODEL>`) and `extension/trueforge/models.example.md`, never keys.

- Primary model: `[TODO: model name]`, ran on `[TODO: provider / local]`, approximate cost `[TODO: cost]`.
- Fallback model: `[TODO: model name]`, ran on `[TODO: provider / local]`, approximate cost `[TODO: cost]`.
- Switching: open the Contexo Settings tab (gear) or run **Contexo: Open Setup**, pick another primary/fallback model and press Save models; Contexo updates the `contexo` / `contexo-fallback` agents in TrueForge. New providers are added in the same place (the key goes straight to TrueForge's API and is never stored by the extension). Advanced alternatives: edit the agent in TrueForge, re-run `trueforge/register.mjs`, or point `contexo.primaryAgent` / `contexo.fallbackAgent` at other agents. Failover is automatic (section 3).

## 6. Scorecard

| Criterion | Video timestamp | Claim |
|---|---|---|
| A1 Inline edit | `[TODO]` | Task A diff rendered in the editor with per-hunk accept/reject. |
| A2 Agent mode | `[TODO]` | Task B discovers and edits three or more files with no file named. |
| A3 Streaming and cancellation | `[TODO]` | Tokens stream; Stop is immediate and the workspace stays consistent. |
| B1 Context assembly | `[TODO]` | Budgeted retrieval (<= 8000 tokens) with chosen files, reasons and omissions in the Context tab. |
| B2 Diff safety | `[TODO]` | Per-hunk review, no write before apply, and a working undo shown on screen. |
| B3 Resilience | `[TODO]` | Task C: broken primary model, automatic fallback, `git status` clean. |
| B4 TrueForge integration | `[TODO]` | Editor tools as MCP tools, approval drives the diff review, deferred tool loading, session shown. |
| C1 Video | `[TODO]` | Tasks A, B, C in order, each verified on screen. |
| C2 Write-up | n/a | Architecture, context strategy, model setup, this scorecard and honest limitations. |

## 7. Tools used

Claude Code (Claude Opus and Sonnet models) was used to build this extension. Libraries: TrueForge SDK, `@modelcontextprotocol/sdk`, `zod`, `diff` (jsdiff), `web-tree-sitter` with `tree-sitter-python`, `js-tiktoken`, `tree-kill`, React and `@xyflow/react`, esbuild, Vite, Vitest, `@vscode/vsce`; VS Code's bundled ripgrep. Licences are listed in `UPSTREAMS.md`. Test target: pallets/flask 3.1.3. `[TODO: add any other tools the team used]`

## 8. Known limitations

- **Live verification.** The TrueForge integration was built against the SDK types and docs; several behaviours were still pending a live run at writing time (`docs/spike-notes.md`): exact deferred-tool call argument names, whether a parallel approval needs one batch, the failure shape for a bad key versus a hang, and the session deep link `${baseUrl}/sessions/<id>`. `register.mjs` had not been run against a live TrueForge. `[TODO: update after the final live run]`
- **Host-mode commands.** `run_command` runs on the host in the real workspace. It is approval-gated and limited to an argv allowlist (`python`, `pytest`, `flask`) with no shell, absolute or `..` path arguments rejected, a scoped environment and a timeout, but it is not sandboxed. Tests run after hunks are applied, not on a staged candidate.
- **One approval per `propose_write`.** Per-hunk decisions happen inside that approval, not as one TrueForge approval per hunk.
- **Undo is in memory only**; history is lost on window reload.
- **Symbol check is lexical** (Tree-sitter, workspace index, builtins); dynamic attributes are skipped, not verified.
- **Token counts are estimates** (cl100k_base), shown as approximate.
- **Noisy docs.** For common terms the packet can include loosely related doc sections.
- **Bundle size.** `dist/extension.js` is 7.7 MB (the VSIX is 3.1 MB); we did not tree-shake the SDKs.
- **Scope.** Python only, one workspace folder, one active run; no subagents, compaction, Code Mode or sandbox.

With another month: language-server symbol resolution, embeddings alongside BM25, a staged sandbox to run tests before apply, persistent undo and run journal, TrueForge compaction and subagents for long tasks, a smaller bundle, and a read-only embedded TrueForge session view.
