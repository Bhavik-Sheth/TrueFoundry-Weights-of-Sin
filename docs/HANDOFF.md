# Handoff: PRD backlog, Tasks 13–15

You are picking up the PRD backlog plan at **Task 13**. Tasks 1–12 are built, reviewed and pushed.

- **Plan** (task text, exact values and tests): [superpowers/plans/2026-11-22-prd-backlog.md](superpowers/plans/2026-11-22-prd-backlog.md)
- **Spec behind it:** [FEATURE_PLAN.md](FEATURE_PLAN.md) §4
- **Branch:** `full_soln`. It is at `a1ed329` on origin and ends with Task 12. Work from there.

## What to do

1. **Task 13: index worker thread.** Plan §Task 13. Move Python parsing into a `worker_threads` worker (`src/context/indexWorker.ts` → `dist/indexWorker.js`, plus a `WorkerParser` client). Keep in-process parsing as a fallback.
   - If the indexer passes `parsePython`'s `onImports` callback, the worker must also return the import bindings.
   - If the worker fails to start, fall back to in-process parsing and write one log line. Never break indexing.
   - Dispose the worker on deactivate. Keep the `IndexApi` interface unchanged.
2. **Task 14: performance metrics.** Plan §Task 14. Record event-loop p50/p95, a `stopLatencyMs` journal metric and `lastIndexMs`, and show them in Settings → Diagnostics.
3. **Task 15: explorer subagent guidance.** Plan §Task 15. This is instructions only. The pinned `@truefoundry/trueforge-sdk` 0.185.0 supports only dynamic subagents (`config.dynamicSubAgents.enabled`), so named subagent definitions can't be registered.
4. **Phase 3 exit.** From `extension/`, run `npm run build && npm run typecheck && npx vitest run`. Then push `full_soln`.
5. **Whole-branch review.** Review `5802ecf..HEAD` as one diff. Use the deferred issues list below to decide what must be fixed before merging.
6. **Manual checks in VS Code.** Use the Extension Development Host on a Flask 3.1.3 checkout. Everything below has passed only typecheck and unit tests:
   - **History guard:** an agent edit that deletes a blamed fix range is denied once with `HISTORY_CONCERN`. The "⚠ Why does this exist?" lens appears, Accept asks for confirmation, and Accept all leaves that hunk pending.
   - **Regenerate:** edit a file while its diff is open, Apply, then click Regenerate.
   - **Task B in Changes:** the summary facts and wiring map show, clicking an edge or fact opens the file, and the map clears after apply or reject.
   - **Task tab:** it shows five requirements, and their state climbs through apply and test.
   - **Mentions:** typing `@get_deb` shows a popover and Enter inserts. The Context tab then shows a `mention` reason first.
   - **Undo:** apply Task A, edit a nearby line, then Undo hunk. You should see a merge diff, and Apply writes it. Undo Run should work on a whole run.
   - **Startup recovery:** kill VS Code mid-apply. On restart the Recover prompt appears, and the files end up as the reviewed text.

## Conventions that bind every task

- **Line endings:** keep each file's existing endings (`core.autocrlf` is false). These files are CRLF: `src/mcp/tools.ts`, `src/review/diffView.ts`, `src/extension.ts`, `src/context/indexer.ts`, `webview/src/ChangesTab.tsx`, `webview/src/App.tsx`. Check any other file with `file <path>` before editing. If `git diff --stat` shows a whole-file rewrite, the line endings changed.
- **Dependencies:** no new npm packages. Never add new MCP tools to `preloadTools` (they must stay deferred). No direct model-provider calls.
- **Tests:**
  - Tests must not import `vscode`, because there is no mock. Put logic in pure modules and test those. Wiring is covered by `npm run typecheck`.
  - Tests that parse Python need `npm run build` first, since the WASM comes from `dist/`. Follow the `loadParser(path.join(__dirname, '..', 'dist'))` pattern in `test/guards.test.ts`.
  - One test fails already on Windows: `test/interop.test.ts`, "keeps changed CI observations…", with EBUSY on a temp `journal.sqlite`. Everything else must pass, at 289 passed after Task 12.
- **Commits:** no Claude/Anthropic attribution or `Co-Authored-By` lines.

## What Tasks 1–12 added (for orientation)

- **`src/history/historyGuard.ts`:** history detection, `explainRange`, `historyGate`, `capWhyExists`, `blockedByHistory`, `partitionAcceptAll`.
- **`src/mcp/tools.ts`:** the new deferred tools `why_exists`, `read_symbol` and `get_instruction_pack`. Instruction packs are in `extension/instruction-packs/`, and esbuild copies them to `dist/`.
- **Review surfaces:**
  - `src/review/wiring.ts`: wiring map, `wiringWithSymbols`.
  - `summary.ts`: `summarizeProposal`, `checksFromRecords`.
  - `requirements.ts`: Task tab logic.
  - `src/context/mentions.ts`: `@` mention ranking.
  - Webview: `WiringMap.tsx`, `TaskTab.tsx`, `MentionPopover.tsx`.
- **Undo:** `src/review/threeWay.ts` (`git merge-file`) and `undoSnapshots.ts`. UndoStack keeps the last 20 apply snapshots.
- **Startup:** `src/run/startupPrompt.ts` for the Recover / Restore Review / Resume prompt, and `RunJournal.lastRuns`.
- **New `ReviewEngine` hooks:** `onStale`, `onFinish`. **New `RunJournal` hook:** `onRecord`.
- **New message types:** `review`, `reviewClosed`, `requirements`, `mentionResults`, `regenerate`, `undoRun`, `linkRequirement`, `mentionQuery`.

## Decisions to keep consistent

- `estimateTokens` in the plan does not exist. Use `count()` from `src/context/tokens.ts`.
- New `RunEvidence` kinds go in `src/run/journal.ts`. `instruction-pack` was added there; Task 14 adds `metric`.
- **Undo Run is all-or-nothing.** If any of the run's hunks has no snapshot, nothing is written.
- **The startup prompt checks only the newest run** for being unfinished.

## Deferred minor issues (triage in the final review)

- **History guard:**
  - The issue regex matches `#123abc` and `C#12`.
  - `TODO`/`NOTE` matching is case-insensitive, so it hits ordinary identifiers.
  - A bad blame range in a valid repo is reported as `no-git`.
  - Only the first concern commit per hunk is used.
  - `whyByHunk` is never cleared.
  - The `setAllDecisions` import in `diffView.ts` may now be unused.
- **`tools.ts` header comment:** it has a stray `.;` and still says "6 editor tools".
- **Instruction packs:** one malformed pack file makes every pack unavailable.
- **Regenerate:** in a multi-file proposal it fires only for the first stale file.
- **Wiring map:** the tests cover a single hunk only, and `wiringFor` loads the parser twice.
- **Summary:**
  - The 8-fact cap can drop the check and flag facts.
  - The symbol key has no path.
  - The tool-call name is not checked against `run_command`.
- **Task tab:**
  - It ignores `runId`, so a previous run's requirements can linger.
  - Its timers are not cleared on dispose.
  - It re-reads the whole journal on every relevant record.
- **Mentions:**
  - The caret is tracked only in `onChange`.
  - `String.replace` mangles a `$&` in a name.
  - The path cache can race with invalidation.
- **Undo:**
  - The snapshot store can grow to megabytes.
  - Untitled merge documents are never closed.
  - Undo Run on a new file empties it instead of deleting it.
- **Startup:** `lastRuns` reads every run file at startup.
