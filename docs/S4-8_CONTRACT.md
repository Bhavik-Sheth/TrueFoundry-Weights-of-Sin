# Slices 4, 5, 6, 8 contract (four agents building in parallel in one worktree)

Plan: [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md), sections Slice 4, 5, 6 and 8. Earlier contracts still hold: [S0_CONTRACT.md](S0_CONTRACT.md), [S1-3_CONTRACT.md](S1-3_CONTRACT.md). Live findings are in [spike-notes.md](spike-notes.md).

**Edit only files you own.** Put anything you need from another owner's file under "Requests for other owners" in your final report. Do not run `npm install`, do not edit `package.json`, and do not run any git commit, branch or push commands.

## Ownership

| Slice | Owned files (relative to `extension/`) |
|---|---|
| **S4 · Undo/redo + Changes tab** | `src/review/applyUndo.ts`, `webview/src/ChangesTab.tsx`, `test/undo.test.ts` (new) |
| **S5 · Context assembly + view** | `src/context/assembler.ts`, `src/mcp/tools.ts` (**only** the `assemble_context` registration and handler block), `webview/src/ContextTab.tsx`, `webview/src/ContextGraph.tsx`, `trueforge/instructions.md`, `test/assembler.test.ts` |
| **S6 · Guards** | `src/review/guards.ts`, `src/review/diffView.ts` (decorations, the CodeLens outside-selection label, wiring of guard results; do **not** change the `contexo.undoHunk`/`redoHunk` command handlers), `test/guards.test.ts`, `src/dev/devCommands.ts` (only to add a missing-symbol sample command `contexo.dev.openSampleProposalMissingSymbol`) |
| **S8 · Fallback** | `src/run/fallback.ts`, `src/run/runManager.ts`, `webview/src/App.tsx` (banner and error card only), `src/shell/statusBar.ts` (a fallback text), `test/fallback.test.ts` (new), `test/runManager.test.ts`, `test/fakes/fakeTfClient.ts` |

Nobody edits these in this round: `src/extension.ts`, `src/types.ts`, `src/config.ts`, `src/log.ts`, `package.json`, `src/shell/panel.ts`, `webview/src/bridge.ts`, `src/review/proposal.ts`, `src/context/indexer.ts`, `src/context/search.ts`, `src/mcp/server.ts`, `src/mcp/runCommand.ts`, `webview/src/ChatTab.tsx`. The integration agent applies any request that touches them.

## Fixed interfaces

### S4
- `UndoStack` keeps its signatures. `undoHunk(id)` and `redoHunk(id)` return `Promise<boolean>`; `undoLastApply()` and `list()` are unchanged.
- **Undo run** in ChangesTab is done in the webview: it posts one `{type:'undo', hunkId}` per hunk of that run, in reverse order. No new message type is needed.
- **QuickPick when no id is given:** export `pickHunk(stack: UndoStack, mode: 'undo' | 'redo'): Promise<string | undefined>` from `applyUndo.ts`. The integration agent wires it into the command handlers in `diffView.ts`.

### S5
- `assembleContext(i: AssembleInput, index: IndexApi): Promise<ContextPacket>`. The `ContextPacket` shape comes from `types.ts` and is unchanged.
- The `assemble_context` handler calls `assembleContext` with `deps.index`, posts `{type:'packet', packet}`, and returns `formatForModel(packet)`.
- It uses the S2 helpers from `context/search.ts` (`tokenize`, `Bm25`, `symbolNameMatch`, `ripgrepSearch`, `vscodeRgContext`) and the `IndexApi` methods. It does not edit those files.

### S6
- `symbolCheck(files: Proposal['files'], index: IndexApi): Promise<string[]>` returns `MISSING_SYMBOL <name> @ <path>:<line>` strings.
- `scopeGuard(hunks: Hunk[], sel: Selection): void` sets `hunk.outsideSelection`.
- Both are already called from `beginProposal`. S6 only makes the deny message list all violations and adds the decorations.

### S8
- `classify(x: unknown): 'model-failure' | 'cancelled' | 'other'` is pure, with no vscode import.
- `takeOver(run: Run, deps: FallbackDeps): Promise<void>`. `FallbackDeps` is defined in `fallback.ts`; RunManager passes what is needed (the tf client, cfg, an emitter, consume and review callbacks).
- RunManager emits state with `banner` set (`RunStateMsg.banner` already exists). The run's `agent` switches to `cfg.fallbackAgent`, and a new `session` event is emitted. Fallback runs at most once per run.
- The first-event timeout comes from `cfg.firstEventTimeoutMs`.
