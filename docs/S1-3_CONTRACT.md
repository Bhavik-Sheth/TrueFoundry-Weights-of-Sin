# Slices 1–3 contract (three agents building in parallel in one worktree)

Plan: [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md), sections Slice 1, Slice 2 and Slice 3. Base contract: [S0_CONTRACT.md](S0_CONTRACT.md); all existing signatures there still hold. Spike findings are in [spike-notes.md](spike-notes.md).

**Edit only files you own.** If you need something in another owner's file, list it under "Requests for other owners" in your report; do not edit the file. Nobody runs `npm install` or edits `package.json`. Nobody runs git commit/branch/push.

## Ownership

| Slice | Owner files (relative to `extension/`) |
|---|---|
| **S1 · Chat, streaming, Stop** | `src/run/runManager.ts`, `src/run/tfClient.ts`, `src/shell/panel.ts`, `src/shell/statusBar.ts`, `webview/src/ChatTab.tsx`, `webview/src/App.tsx`, `webview/src/bridge.ts`, `test/runManager.test.ts` (new), `test/fakes/fakeTfClient.ts` (new) |
| **S2 · MCP tools + index** | `src/context/indexer.ts`, `src/context/search.ts`, `src/context/tokens.ts`, `src/mcp/tools.ts`, `src/mcp/server.ts`, `test/search.test.ts` (new), `test/indexer.test.ts` (new), `test/fixtures/` (new, small Python/RST samples), `test/mcpServer.test.ts` |
| **S3 · Inline edit → staged diff → per-hunk apply** | `src/review/diffView.ts`, `src/review/applyUndo.ts`, `src/review/proposal.ts`, `src/shell/inlineEdit.ts`, `src/dev/devCommands.ts`, `src/dev/fixtures.ts`, `trueforge/instructions.md`, `test/proposal.test.ts`, `test/reviewEngine.test.ts` (new, pure parts only) |

Not owned by anyone in this round (do not edit): `src/extension.ts`, `src/types.ts`, `src/config.ts`, `src/log.ts`, `package.json`, `src/review/guards.ts`, `src/context/assembler.ts`, `src/run/fallback.ts`, `src/mcp/runCommand.ts`, `webview/src/Context*.tsx`, `webview/src/ChangesTab.tsx`. If you need a new shared type, define it locally in your own file and request that it move to `types.ts`.

## Interfaces between slices (fixed)

### S1 ↔ S3: the approval round trip
`ReviewEngine` (owned by S3, in `review/diffView.ts`) exposes exactly:
```ts
onResolve?: (allow: boolean, reason?: string) => void;     // set by RunManager before beginProposal
beginProposal(run: Run, toolCallId: string, threadId: string, args: ProposeArgs): Promise<'reviewing' | { deny: string }>;
get pending(): Proposal | undefined;                        // NEW: the proposal under review (S1 reads pending.hunks.length for status)
finalize(key: Sha): { applied: string[]; rejected: string[] } | { error: string };
finalizeLatest(): { applied: string[]; rejected: string[] } | { error: string };   // NEW: result of the most recently resolved proposal (fallback key)
discardPending(): void;
```
RunManager (S1) does the following on `tool.approval_required`:
1. Resolve the tool name and args via `sourceEventId`, which already works.
2. For `propose_write`, set `review.onResolve = (allow, reason) => this.resolveApproval(allow, reason)` and parse the args JSON into `ProposeArgs`.
3. Call `await review.beginProposal(run, toolCallId, threadId, args)`.
4. If the result is `{deny}`, call `resolveApproval(false, deny)` immediately. Otherwise emit state `awaiting-review` with `hunks = review.pending?.hunks.length`.
5. For `run_command` and any other tool, keep auto-denying with `"not implemented until slice 7"`.

Only one approval is pending at a time. If several tool calls need approval in one pause, handle them in order.

S3's engine calls `onResolve(true)` after a successful apply and `onResolve(false, reason)` on reject-all or stale. It must never call `onResolve` twice for one proposal.

### S2 ↔ S3: `propose_write` MCP handler (owned by S2, in `mcp/tools.ts`)
```ts
// handler body
const r = deps.review.finalize(proposalKey(args));
const out = 'error' in r ? deps.review.finalizeLatest() : r;   // fallback if TrueForge re-serialises args differently
return text(JSON.stringify(out));
```
`proposalKey` is imported from `review/proposal.ts` (S3; its signature is unchanged).

### S1 ↔ S2
`RunManager.isToolCallAllowed()` stays as is, and S2's handlers keep checking it.
