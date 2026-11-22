# PRD Backlog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the PRD capabilities Contexo still lacks: Chesterton's Fence, `read_symbol`, instruction packs, Regenerate, the wiring map, the grounded summary, the Task tab, `@` mentions, three-way undo, startup recovery, the index worker with metrics, and subagent guidance.

**Architecture:** Each feature has a **pure module** (parsing, deciding, ranking, merging) unit-tested in Vitest, plus a **thin wiring step** into the existing seams:
- `ReviewEngine.beginProposal` ([diffView.ts](../../../extension/src/review/diffView.ts)) for staging guards
- `makeToolRegistrar` ([tools.ts](../../../extension/src/mcp/tools.ts)) for MCP tools
- `ToWebview`/`ToHost` ([types.ts](../../../extension/src/types.ts)) plus `panel.onMessage` in [extension.ts](../../../extension/src/extension.ts) for UI
- `UndoStack` ([applyUndo.ts](../../../extension/src/review/applyUndo.ts)) for undo

The tests never import `vscode`, so they cover only the pure modules. The wiring steps are checked with `npm run typecheck` plus a stated manual check in the Extension Development Host.

**Tech Stack:** TypeScript, VS Code API ≥ 1.90, web-tree-sitter 0.27.2, `diff` 9.0.0 (jsdiff), zod 4, `@modelcontextprotocol/sdk` 1.32.2, React 19 + `@xyflow/react` 13, Vitest, the git CLI (`blame`, `show`, `merge-file`), Node `worker_threads` and `perf_hooks`.

**Spec:** [docs/FEATURE_PLAN.md](../../FEATURE_PLAN.md) §4 (P1–P13), with [docs/PRD.md](../../PRD.md) §5, §9.2 and §11.5 as the source requirements.

## Global Constraints

- Node 22.14 or newer. VS Code `engines.vscode` is unchanged.
- **No new npm dependencies.** Three-way merge uses `git merge-file`, not `node-diff3` (the spec's library choice is replaced to keep zero new deps). The graph uses the existing `@xyflow/react`.
- No direct model-provider calls. `npm run package` must still pass `check-no-provider.mjs`.
- Every **new** MCP tool stays deferred: never add it to `preloadTools` in [manifests.ts](../../../extension/src/run/manifests.ts).
- Tool output caps: `read_symbol` ≤ 16,000 source characters (same as `read_file`), `why_exists` ≤ 4,000 characters, instruction pack ≤ 1,500 tokens each.
- History trigger threshold: ≥ 3 removed lines (setting `contexo.history.minLines`, default `3`).
- `HISTORY_CONCERN` is denied **at most once** per `(runId, path, commit sha)`.
- Structural features are Python-only (`.py`). Docs headings come from the existing docs indexer.
- Paths in tool inputs are workspace-relative and pass `resolvePath()` / `assertNativeWorkspacePath()`.
- Tests that parse Python need `npm run build` first, because the WASM comes from `dist/`. Follow the `loadParser(path.join(__dirname, '..', 'dist'))` pattern in [guards.test.ts](../../../extension/test/guards.test.ts).
- Commit messages carry no Claude/Anthropic attribution (user rule in `~/.claude/CLAUDE.md`).
- All commands below run from `extension/`.

## Review Focus

1. **No usable history** (a shallow clone, a file not yet committed, git missing): `why_exists` returns a `note` and `concern: null`, and staging proceeds. It never throws. Test in Task 2.
2. **The agent never acknowledges a concern:** the second identical proposal must be staged with the flag, not denied again. Test in Task 3.
3. **CRLF files in undo:** merged text keeps `\r\n`. Test in Task 11.
4. **An evicted, deleted or renamed apply snapshot:** undo reports "no snapshot" and writes nothing. Test in Task 11.
5. **Ambiguous names:** `read_symbol("get_command")` with two matches returns `candidates`, never an arbitrary pick. Test in Task 4.

---

## Phase 1 · Agent-facing tools and guards

Exit check for the phase: `npm test` is green, and in the Extension Development Host a scripted Flask proposal that deletes a fix-tagged branch gets `HISTORY_CONCERN` once.

### Task 1: History concern detection (pure)

**Files:**
- Create: `src/history/historyGuard.ts`
- Test: `test/historyGuard.test.ts`

**Interfaces:**
- Produces:
  - `needsHistoryCheck(hunk: Hunk, minLines?: number): boolean`. True when the hunk has ≥ `minLines` removed lines (`lines` entries starting with `-`), or any removed line matches `GUARD_LINE`.
  - `GUARD_LINE: RegExp`. Matches removed lines that start, after `-` and whitespace, with `if `, `elif `, `try:`, `except`, `raise `, `assert `, `with ` + `lock`. It also matches lines containing `TODO|NOTE|HACK|XXX|do not|don't remove|workaround` (case-insensitive).
  - `parseBlamePorcelain(out: string): Array<{ sha: string; lines: number[] }>`. Groups final line numbers by commit and skips the all-zero sha (uncommitted).
  - `detectConcern(subject: string, body: string): { concern: string | null; issues: string[]; prs: number[] }`. `concern` is the first matched keyword from `fix|bug|regression|race|deadlock|security|CVE-|vuln|workaround|compat|revert|hotfix|leak|crash|edge case`. `issues` collects `#123`, `GH-123` and `fixes|closes|resolves #123` (deduped, as `#123`). `prs` comes from a trailing `(#1234)` in the subject.

- [ ] **Step 1: Write the failing tests**

```ts
it('needsHistoryCheck: 3 removed lines or a guard line', () => {
  expect(needsHistoryCheck(hunk(['-a', '-b', '-c', '+d']))).toBe(true);
  expect(needsHistoryCheck(hunk(['-a', '+b']))).toBe(false);
  expect(needsHistoryCheck(hunk(['-    if not lock.acquire():', '+pass']))).toBe(true);
  expect(needsHistoryCheck(hunk(['-    # HACK: keep for py3.9', '+']))).toBe(true);
});
it('parseBlamePorcelain groups lines and skips uncommitted', () => { /* fixture with 2 shas + 0000000000000000000000000000000000000000 */
  expect(parseBlamePorcelain(FIXTURE)).toEqual([{ sha: 'a'.repeat(40), lines: [10, 11] }, { sha: 'b'.repeat(40), lines: [12] }]);
});
it('detectConcern finds keyword, issues and squash PR', () => {
  expect(detectConcern('Fix race in reloader (#5012)', 'Closes #412. See GH-77.'))
    .toEqual({ concern: 'race', issues: ['#412', '#77'], prs: [5012] });
  expect(detectConcern('Tidy imports', '')).toEqual({ concern: null, issues: [], prs: [] });
});
```

`hunk(lines)` is a local helper that builds a `Hunk` with those `lines`, `path: 'a.py'` and the other fields zeroed.

- [ ] **Step 2: Run `npx vitest run test/historyGuard.test.ts`.** Expect FAIL (module not found).
- [ ] **Step 3: Implement the four exports in `src/history/historyGuard.ts`.** Parse porcelain by reading header lines `^<40-hex> <orig> <final>( <count>)?$` and taking `final`.
- [ ] **Step 4: Run the same command.** Expect PASS.
- [ ] **Step 5: Commit** `feat(history): detect history concerns in removed code`.

### Task 2: `explainRange` git access and the `why_exists` tool

**Files:**
- Modify: `src/history/historyGuard.ts`
- Modify: `src/mcp/tools.ts` (register after `file_context`)
- Test: `test/historyGuard.test.ts` (new `describe('explainRange')`)

**Interfaces:**
- Consumes: `parseBlamePorcelain` and `detectConcern` (Task 1); `IndexApi.inFile` / `enclosing` for related tests.
- Produces:
  - `interface WhyExists { commits: Array<{ sha: string; author: string; date: string; subject: string; bodyExcerpt: string; lines: [number, number] }>; issues: string[]; prs: number[]; tests: string[]; concern: string | null; note?: 'shallow' | 'uncommitted' | 'no-git' }`
  - `explainRange(root: string, path: string, startLine: number, endLine: number, index?: IndexApi): Promise<WhyExists>`
    - Runs `git blame --porcelain -w -M -C -L <s>,<e> HEAD -- <path>` and `git show -s --format=%H%x00%an%x00%aI%x00%s%x00%b <sha>` through `node:child_process` `execFile`, with `cwd: root` and a 10 s timeout.
    - Caches by `path + ':' + headSha` (`git rev-parse HEAD`).
    - `bodyExcerpt` is the first 300 characters. The first concern found wins.
    - `tests` are `index.symbols()` entries of kind `test` whose `calls` include the enclosing symbol's `name`.
    - Sets `note` to `'shallow'` when `git rev-parse --is-shallow-repository` prints `true`, `'uncommitted'` when the path is not in HEAD, and `'no-git'` when git fails. In all three cases `commits` is `[]`.
  - MCP tool `why_exists` with input `{ path: string; startLine: number; endLine: number }`. It returns `ok(explainRange(...))`, and the JSON is truncated to 4,000 characters by dropping the oldest commits first. Description: "Explain why existing lines exist: blame commits, messages, linked issues/PRs and related tests. Call before deleting or rewriting code you did not write."

- [ ] **Step 1: Write the failing tests.** In a `mkdtemp` directory: `git init`, write `m.py` with 5 lines, commit as `"Fix race in loader (#9)"` with body `"Closes #412"`, then append an uncommitted file `n.py`.

```ts
it('explains committed lines', async () => {
  const w = await explainRange(dir, 'm.py', 2, 4);
  expect(w.commits[0].subject).toBe('Fix race in loader (#9)');
  expect(w.commits[0].lines).toEqual([2, 4]);
  expect(w).toMatchObject({ concern: 'race', issues: ['#412'], prs: [9] });
});
it('uncommitted file -> note, no throw', async () => {
  expect(await explainRange(dir, 'n.py', 1, 1)).toMatchObject({ commits: [], concern: null, note: 'uncommitted' });
});
it('not a git repo -> note no-git', async () => {
  expect((await explainRange(plainDir, 'x.py', 1, 1)).note).toBe('no-git');
});
```

- [ ] **Step 2: Run `npx vitest run test/historyGuard.test.ts`.** Expect FAIL.
- [ ] **Step 3: Implement `explainRange` and register `why_exists` in `tools.ts`.** Use `guarded(...)`, `resolvePath(a.path)`, and root `external?.workspace() ?? workspaceRoot()!.uri.fsPath`.
- [ ] **Step 4: Run the tests (expect PASS) and `npm run typecheck` (expect exit 0).**
- [ ] **Step 5: Commit** `feat(mcp): add deferred why_exists tool`.

### Task 3: `HISTORY_CONCERN` gate in staging and review

**Files:**
- Modify: `src/history/historyGuard.ts` (pure gate)
- Modify: `src/review/editBatch.ts:8-18` (schema)
- Modify: `src/types.ts` (`ProposeArgs`, `Hunk`)
- Modify: `src/review/diffView.ts` (`beginProposal` after `symbolCheck`; `provideCodeLenses`; `setDecision`)
- Modify: `extension/trueforge/instructions.md` (error list)
- Modify: `package.json` (`contexo.history.minLines`, default 3; command `contexo.whyExists`, hidden), `src/config.ts` (`getConfig().historyMinLines: number`)
- Test: `test/historyGuard.test.ts`

**Interfaces:**
- Consumes: `needsHistoryCheck`, `explainRange`, `WhyExists`.
- Produces:
  - `ProposeArgs.acknowledgedHistory?: Array<{ commit: string; reason: string }>`. The zod field description: "Commits from HISTORY_CONCERN you checked, with how your change preserves their intent".
  - `Hunk.historyConcern?: { sha: string; subject: string; concern: string; issues: string[]; acknowledgement?: string; read?: boolean }`
  - `historyGate(input: { runId: string; hunks: Hunk[]; explains: Map<string, WhyExists>; acknowledged: ProposeArgs['acknowledgedHistory']; denied: Set<string> }): { deny?: string; flags: Map<string, NonNullable<Hunk['historyConcern']>> }`
    - `explains` is keyed by hunk id.
    - For the first hunk whose explain has a concern commit that is not acknowledged and whose `${runId}:${path}:${sha}` is not in `denied`, it adds that key to `denied` and returns this `deny` (exact copy): `HISTORY_CONCERN ${path}:${start}-${end} commit ${sha7} "${subject}"${issues ? ' (' + issues.join(', ') + ')' : ''}. Explain how your change preserves this, then re-propose with acknowledgedHistory.`
    - Otherwise it returns `flags` for every concern hunk, with `acknowledgement` taken from the matching `acknowledgedHistory.reason`.

- [ ] **Step 1: Write the failing tests**

```ts
it('denies once, then flags', () => {
  const denied = new Set<string>();
  const first = historyGate({ runId: 'r', hunks: [h1], explains: ex, acknowledged: undefined, denied });
  expect(first.deny).toMatch(/^HISTORY_CONCERN a\.py:10-12 commit aaaaaaa "Fix race in loader \(#9\)" \(#412\)\./);
  const second = historyGate({ runId: 'r', hunks: [h1], explains: ex, acknowledged: undefined, denied });
  expect(second.deny).toBeUndefined();
  expect(second.flags.get(h1.id)).toMatchObject({ sha: 'a'.repeat(40), concern: 'race' });
});
it('acknowledged commit stages with acknowledgement text', () => {
  const r = historyGate({ runId: 'r', hunks: [h1], explains: ex, acknowledged: [{ commit: 'aaaaaaa', reason: 'lock kept in caller' }], denied: new Set() });
  expect(r.deny).toBeUndefined();
  expect(r.flags.get(h1.id)?.acknowledgement).toBe('lock kept in caller');
});
it('no concern -> no deny, no flags', () => { /* explain with concern: null */ });
```

Acknowledgement matching is a prefix match: `commit.length >= 7` and `sha.startsWith(commit)`.

- [ ] **Step 2: Run `npx vitest run test/historyGuard.test.ts`.** Expect FAIL.
- [ ] **Step 3: Implement `historyGate`, add the schema and type fields, and wire `beginProposal`:**
  - The engine gets `private historyDenied = new Set<string>()`.
  - For hunks with `needsHistoryCheck(h, cfg.historyMinLines)`, call `explainRange(root, h.path, h.oldStart, h.oldStart + h.oldLines - 1, this.index)`.
  - If `gate.deny` is set, `return { deny }`. Otherwise assign `h.historyConcern`.
  - Errors from `explainRange` are logged and ignored, in the same try block style as `symbolCheck`.
- [ ] **Step 4: Add the review UI in `diffView.ts`:**
  - In `provideCodeLenses`, a hunk with `historyConcern` gets the lens `⚠ Why does this exist? (${sha7} ${subject})`, which runs `contexo.whyExists` with `(key, hunkId)`.
  - The command opens a read-only markdown virtual document listing the commits, issues, tests and the agent's acknowledgement, and sets `historyConcern.read = true`.
  - In `setDecision(hunkId, 'accepted')`, if `historyConcern && !read`, show the modal `showWarningMessage('This hunk removes code with recorded history. Open "Why does this exist?" first?', { modal: true }, 'Open history', 'Accept anyway')`. Only `Accept anyway` (or reading the history first) records the acceptance.
- [ ] **Step 5: Add the error line to `instructions.md`** under "Errors and retries": `` - `HISTORY_CONCERN <path:lines> commit <sha>`: the lines you remove were added for a recorded reason. Call `why_exists` if you need detail, keep or replace the protection, and re-propose with `acknowledgedHistory: [{commit, reason}]`. ``
- [ ] **Step 6: Run `npx vitest run` (expect PASS) and `npm run typecheck` (expect 0).** Manual check in the Extension Development Host on Flask: an agent edit deleting a blamed fix range shows the denial in Session, then the lens, then the modal on Accept.
- [ ] **Step 7: Commit** `feat(review): gate history-bearing deletions with HISTORY_CONCERN`.

### Task 4: `read_symbol` tool

**Files:**
- Create: `src/context/readSymbol.ts`
- Modify: `src/mcp/tools.ts`
- Test: `test/readSymbol.test.ts`

**Interfaces:**
- Consumes: `IndexApi`; `sourceWindow(path, text, start, end)` from `src/context/sourceWindow.ts` (the same output as `read_file`, so `hash` is the full-file `baseHash`).
- Produces: `resolveSymbol(index: IndexApi, name: string): { symbol: SymbolEntry } | { candidates: Array<{ qualifiedName: string; path: string; line: number }> } | { error: 'NOT_FOUND' }`.
  - Matching order: exact `qualifiedName`, then module-qualified (`moduleOf(path) + '.' + qualifiedName`, same rule as `impactGraph.ts`), then a unique `byName`, then a unique suffix match on `'.' + name`.
  - Several matches at any step return `candidates`, capped at 10. Doc symbols are excluded.
- MCP tool `read_symbol {name}`: on `symbol`, read the live text (open buffer or disk, as `read_file` does) and return `{ ...sourceWindow(path, text, startLine, endLine), symbol: qualifiedName }`. Otherwise return `ok(result)`.

- [ ] **Step 1: Write the failing tests** with a fake index holding `FlaskGroup.get_command` in `src/flask/cli.py` and `AppGroup.get_command` in `src/flask/app.py`:

```ts
expect(resolveSymbol(idx, 'FlaskGroup.get_command')).toMatchObject({ symbol: { path: 'src/flask/cli.py' } });
expect(resolveSymbol(idx, 'flask.cli.FlaskGroup.get_command')).toMatchObject({ symbol: { path: 'src/flask/cli.py' } });
expect(resolveSymbol(idx, 'get_command')).toMatchObject({ candidates: [{ qualifiedName: 'FlaskGroup.get_command' }, { qualifiedName: 'AppGroup.get_command' }] });
expect(resolveSymbol(idx, 'nope')).toEqual({ error: 'NOT_FOUND' });
```

- [ ] **Step 2: Run `npx vitest run test/readSymbol.test.ts`.** Expect FAIL.
- [ ] **Step 3: Implement `resolveSymbol` and register `read_symbol`.** Description: "Read one Python function/class by name (e.g. "FlaskGroup.get_command"). Returns its exact lines and the file hash to use as baseHash. Ambiguous names return candidates."
- [ ] **Step 4: Run the tests (expect PASS) and `npm run typecheck`.**
- [ ] **Step 5: Commit** `feat(mcp): add deferred read_symbol tool`.

### Task 5: Instruction packs

**Files:**
- Create: `extension/instruction-packs/python-editing@1.md`, `pytest-testing@1.md`, `rst-docs@1.md`
- Create: `src/context/instructionPacks.ts`
- Modify: `src/mcp/tools.ts`, `esbuild.mjs` (copy `instruction-packs/` to `dist/instruction-packs/`), `.vscodeignore` (keep `dist/instruction-packs`), `extension/trueforge/instructions.md`
- Test: `test/instructionPacks.test.ts`

**Interfaces:**
- Produces:
  - `interface Pack { name: string; version: number; when: string; body: string }`
  - `parsePack(file: string, text: string): Pack`. Front matter is `---\nname: …\nversion: …\nwhen: …\n---`. `name` must equal the file stem before `@`, and `version` must equal the number after it, or it throws `PACK_INVALID <file>`.
  - `loadPacks(dir: string): Promise<Pack[]>`
  - MCP tool `get_instruction_pack {name}` returns `{name, version, body}`. On an unknown name it returns the error `UNKNOWN_PACK` with the message listing `name — when` for every pack. Each load is recorded through `deps.runs.recordContext(run, { kind: 'instruction-pack', name, version })`; extend `RunEvidence` if that kind is missing.
- Content rules for each pack: ≤ 1,500 tokens (check with `estimateTokens` from `src/context/tokens.ts`), imperative, repo-agnostic.
  - `pytest-testing` must cover Click's `CliRunner` / `app.test_cli_runner()` and `-q` runs.
  - `rst-docs` must cover how the existing `docs/cli.rst` lists built-in commands.

- [ ] **Step 1: Write the failing tests**

```ts
it('parses front matter', () => expect(parsePack('pytest-testing@1.md', TEXT)).toMatchObject({ name: 'pytest-testing', version: 1 }));
it('rejects name/version mismatch', () => expect(() => parsePack('pytest-testing@2.md', TEXT)).toThrow(/PACK_INVALID/));
it('shipped packs load and fit budget', async () => {
  const packs = await loadPacks(path.join(__dirname, '..', 'instruction-packs'));
  expect(packs.map(p => p.name).sort()).toEqual(['pytest-testing', 'python-editing', 'rst-docs']);
  for (const p of packs) expect(estimateTokens(p.body)).toBeLessThanOrEqual(1500);
});
```

- [ ] **Step 2: Run `npx vitest run test/instructionPacks.test.ts`.** Expect FAIL.
- [ ] **Step 3: Write the three packs, implement the module and tool, add the esbuild copy, and add an instructions line:** `Procedural guides: call get_instruction_pack with python-editing, pytest-testing or rst-docs before writing that kind of change.`
- [ ] **Step 4: Run the tests (expect PASS), `npm run build` (expect `dist/instruction-packs/*.md` present) and `npm run typecheck`.**
- [ ] **Step 5: Commit** `feat(mcp): add versioned instruction packs`.

### Task 6: Regenerate after a stale review

**Files:**
- Create: `src/review/regenerate.ts`
- Modify: `src/types.ts` (`UiStreamEvent` adds `{ kind: 'action'; action: 'regenerate'; path: string; label: string }`; `ToHost` adds `{ type: 'regenerate'; path: string }`)
- Modify: `src/review/diffView.ts:348` (emit after `STALE_BASE during review`)
- Modify: `src/extension.ts` (the `panel.onMessage` switch)
- Modify: `webview/src/ChatTab.tsx` (render the `action` event as a button)
- Test: `test/regenerate.test.ts`

**Interfaces:**
- Produces:
  - `regeneratePrompt(path: string, summary?: string): string`. Exact copy: `` The file `${path}` changed while your proposal${summary ? ` ("${summary}")` : ''} was under review, so nothing was written. Re-read `${path}` with read_file and propose the same change again against the current text. ``
  - `ReviewEngine.onStale?: (path: string, summary?: string) => void`, called right after `resolve(false, 'STALE_BASE during review…')`.
- Wiring:
  - `extension.ts` keeps `let lastStale: { path: string; summary?: string } | undefined` and sets `review.onStale = (path, summary) => { lastStale = { path, summary }; runs.emit('stream', [{ kind: 'action', action: 'regenerate', path, label: 'Regenerate' }]); }`.
  - On `{type:'regenerate', path}` it calls `runs.send(regeneratePrompt(path, lastStale?.path === path ? lastStale.summary : undefined))`. `send()` already starts a new turn or warns when a turn is running.

- [ ] **Step 1: Write the failing test.** Assert the exact string for `('src/flask/helpers.py', 'Treat off and n as false')`, and for the variant with no summary.
- [ ] **Step 2: Run `npx vitest run test/regenerate.test.ts`.** Expect FAIL.
- [ ] **Step 3: Implement it and wire it.** The button posts `{type:'regenerate', path}` and is disabled while `runState` is `streaming`.
- [ ] **Step 4: Run the tests (expect PASS) and `npm run typecheck`.** Manual check: in Task A, edit `helpers.py` while the diff is open, Apply, click Regenerate, and see a fresh proposal on the new text.
- [ ] **Step 5: Commit** `feat(review): regenerate a proposal after a stale review`.

---

## Phase 2 · Review surfaces

Exit check for the phase: on Flask Task B, the Changes tab shows the summary and wiring map, the Task tab shows five requirements with states, `@get_deb` completes, and undo of an edited hunk previews a merge.

### Task 7: Wiring map

**Files:**
- Create: `src/review/wiring.ts`
- Create: `webview/src/WiringMap.tsx`
- Modify: `src/types.ts` (`ToWebview` adds `{ type: 'review'; key: string; wiring: WiringGraph; summary: SummaryFact[] }`; Task 8 fills `summary`, and this task sends `[]`)
- Modify: `src/extension.ts` (`review.onProposal`), `webview/src/ChangesTab.tsx`
- Test: `test/wiring.test.ts`

**Interfaces:**
- Consumes: `compareProposalImpact(proposal, index.symbols())` returning `{added, removed}` edges `{path, symbol, kind, target, definition?}`; `parsePython(parser, path, text)`; `rebuildFile(base, path, hunks)`.
- Produces:
  - `interface WiringGraph { nodes: Array<{ id: string; label: string; path: string; line?: number }>; edges: Array<{ id: string; from: string; to: string; change: 'added' | 'removed'; kind: 'call' | 'import'; hunkId?: string }> }`
  - `buildWiring(impact: Awaited<ReturnType<typeof compareProposalImpact>>, proposal: Proposal, candidateSymbols: SymbolEntry[]): WiringGraph`
    - A node id is `path + '#' + symbol` for sources and `target` for targets.
    - An edge's `hunkId` is the first hunk of `edge.path` whose new-side range `[newStart, newStart + newLines - 1]` overlaps the candidate symbol named `edge.symbol`.
    - Removed edges use the old-side range against base symbols.
  - `WiringMap({ graph, onOpenHunk })` uses `@xyflow/react` with the column layout from `ContextGraph.layout` (sources left, targets right). Added edges are green (`var(--vscode-gitDecoration-addedResourceForeground)`) and removed edges red (`…deletedResourceForeground`). Clicking an edge posts `{type:'openSource', path, line}` at the hunk's `newStart`.

- [ ] **Step 1: Write the failing test.** Build a proposal whose hunk adds `cli.add_command(config_command)` inside `FlaskGroup.__init__` (use `test/fixtures/sample.py`-style text). Feed `compareProposalImpact` output in.

```ts
const g = buildWiring(impact, proposal, candSyms);
expect(g.edges).toContainEqual(expect.objectContaining({ change: 'added', kind: 'call', hunkId: proposal.hunks[0].id }));
expect(g.edges.every(e => g.nodes.some(n => n.id === e.from) && g.nodes.some(n => n.id === e.to))).toBe(true);
```

- [ ] **Step 2: Run `npx vitest run test/wiring.test.ts`.** Expect FAIL.
- [ ] **Step 3: Implement it.** In `review.onProposal`, compute it asynchronously and `post({type:'review', key, wiring, summary: []})`. Failures are logged and send no message. The Changes tab shows the map above the hunk list when the message `key` matches the pending proposal.
- [ ] **Step 4: Run the tests (expect PASS), `npm run typecheck`, then `npm run build`.** Manual check: on Task B the edge `FlaskGroup → config_command` appears, and clicking it opens `cli.py`.
- [ ] **Step 5: Commit** `feat(review): show before/after wiring map`.

### Task 8: Grounded review summary

**Files:**
- Create: `src/review/summary.ts`
- Modify: `src/extension.ts` (fill `summary` in the Task 7 message), `webview/src/ChangesTab.tsx`
- Test: `test/summary.test.ts`

**Interfaces:**
- Consumes: `Proposal`, `WiringGraph` (Task 7), and check results read from the run's journal `tool-output` records for `run_command`.
- Produces:
  - `interface SummaryFact { text: string; hunkIds: string[]; checkId?: string }`
  - `interface SummaryCheck { id: string; argv: string[]; exitCode: number; passed?: number; failed?: number }`. `passed`/`failed` are parsed from a pytest `N passed, M failed` line when present.
  - `summarizeProposal(p: Proposal, wiring: WiringGraph, checks: SummaryCheck[], symbolsBefore: SymbolEntry[], symbolsAfter: SymbolEntry[]): SummaryFact[]`, in this order and these exact forms:
    1. `Changes N file(s): <paths joined ", ">`, with all hunk ids.
    2. `Adds <kind> <qualifiedName>` for each symbol in after but not before.
    3. `Removes <kind> <qualifiedName>` for each symbol in before but not after.
    4. `New import: <module>` for each `+import`/`+from` line.
    5. `New call: <from> → <to>` for each added wiring edge.
    6. `Check <argv joined " ">: exit <code>` plus ` (<passed> passed, <failed> failed)` when known.
    7. `<k> hunk(s) flagged: <outside selection | history concern>` when present.
  - At most 8 facts. No model call.

- [ ] **Step 1: Write the failing test** with a proposal that adds `def config_command` and `import json`, one added edge, and one check with `exitCode: 0, passed: 60`:

```ts
expect(summarizeProposal(p, g, checks, before, after).map(f => f.text)).toEqual([
  'Changes 1 file: src/flask/cli.py',
  'Adds function config_command',
  'New import: json',
  'New call: FlaskGroup.__init__ → config_command',
  'Check pytest tests/test_cli.py -q: exit 0 (60 passed, 0 failed)',
]);
```

- [ ] **Step 2: Run `npx vitest run test/summary.test.ts`.** Expect FAIL.
- [ ] **Step 3: Implement it, and render the facts as a list at the top of the Changes tab.** Clicking a fact with hunk ids opens the first hunk; clicking one with `checkId` scrolls to that check in Session.
- [ ] **Step 4: Run the tests (expect PASS) and `npm run typecheck`.**
- [ ] **Step 5: Commit** `feat(review): add grounded review summary`.

### Task 9: Task tab (requirements and states)

**Files:**
- Create: `src/review/requirements.ts`
- Create: `webview/src/TaskTab.tsx`
- Modify: `src/review/editBatch.ts` (optional `requirements: z.array(z.string()).max(12).optional()`, described as "Requirement ids (R1…) or texts this change satisfies"), `src/types.ts` (`ProposeArgs.requirements?`; `ToWebview` adds `{ type: 'requirements'; runId: string; items: RequirementView[] }`; `ToHost` adds `{ type: 'linkRequirement'; requirementId: string; hunkId: string; linked: boolean }`)
- Modify: `src/run/runManager.ts` (`start()` for `mode === 'agent'`: record requirement evidence from the splitter), `src/extension.ts`, `webview/src/App.tsx` (`TABS` adds `['task', 'Task']` after Chat)
- Modify: `src/review/evidence.ts` (extract the `requirements` reducer at lines 17–25 into `requirements.ts` and import it back)
- Test: `test/requirements.test.ts`

**Interfaces:**
- Produces:
  - `splitRequirements(request: string): string[]`. Split sentences on `/(?<=[.!?])\s+/`. Inside each sentence, split on `/,\s+(?:and\s+)?(?=(?:be|must|should|masking|ensure|update|add|keep|make)\b)/i`. Trim, drop a trailing `.`, and drop empty parts. A request with no split points returns `[request.trim()]`.
  - `interface RequirementView { id: string; label: string; text: string; revision: number; state: 'open' | 'proposed' | 'accepted' | 'applied' | 'checked'; links: Array<{ hunkId: string; source: 'agent' | 'human' }> }`. `label` is `R1`…`Rn` in creation order.
  - `reduceRequirements(records: RunRecord[]): RequirementView[]`. It folds `requirement` (text and revision, latest revision wins), `requirement-link` (`{requirementId, hunkId, source, linked}`), proposal decision records, applied-hunk records and `run_command` results.
    - The state is the highest step reached: a link means `proposed`, a linked hunk accepted means `accepted`, a linked hunk applied means `applied`, and a `run_command` exit 0 recorded after that apply means `checked`.
  - Agent links: `propose_write.requirements` entries matching `/^R\d+$/` resolve by label, and other strings by case-insensitive text equality. Each matched requirement gets a link to **every** hunk of that proposal, with `source: 'agent'`.

- [ ] **Step 1: Write the failing tests**

```ts
const B = 'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';
expect(splitRequirements(B)).toEqual([
  "Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON",
  'masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***"',
  'It must appear in flask --help',
  'be covered by a test',
  'be documented alongside the other built-in commands',
]);
expect(splitRequirements('Rename foo to bar')).toEqual(['Rename foo to bar']);
it('state climbs to checked only after apply then exit 0', () => { /* records: requirement R1, link hunk h1 (agent), decision accepted, applied h1, run_command exit 0 */
  expect(reduceRequirements(records)[0]).toMatchObject({ label: 'R1', state: 'checked', links: [{ hunkId: 'h1', source: 'agent' }] });
});
it('a check before apply does not count', () => { /* exit 0 recorded before applied */ expect(state).toBe('applied'); });
```

- [ ] **Step 2: Run `npx vitest run test/requirements.test.ts`.** Expect FAIL.
- [ ] **Step 3: Implement it.**
  - `start('agent')` records one `requirement` evidence per split part.
  - The `propose_write` path records agent links.
  - The host posts `requirements` after every journal event of those kinds (debounced 200 ms).
  - `TaskTab` lists requirements with a state badge, linked hunks (click opens source) and a per-hunk link toggle for the pending proposal, which posts `linkRequirement` and is recorded with `source: 'human'`.
- [ ] **Step 4: Run the tests (expect PASS), `npm run typecheck` and `npm run build`.**
- [ ] **Step 5: Commit** `feat(task): add requirements tab with evidence states`.

### Task 10: `@` mention completion

**Files:**
- Create: `src/context/mentions.ts`
- Modify: `src/types.ts` (`ToHost` adds `{ type: 'mentionQuery'; q: string }`; `ToWebview` adds `{ type: 'mentionResults'; q: string; items: MentionItem[] }`)
- Modify: `src/extension.ts` (handler using `index.symbols()` plus a cached `workspace.findFiles('**/*', '**/{.git,node_modules,.venv}/**', 5000)` list refreshed on `index.reindexAll`)
- Modify: `webview/src/App.tsx` (the send box lives here)
- Test: `test/mentions.test.ts`

**Interfaces:**
- Produces:
  - `interface MentionItem { kind: 'file' | 'symbol'; insert: string; label: string; detail: string }`
    - For a symbol, `insert` is `@` + `qualifiedName`, `label` is the `qualifiedName`, and `detail` is `` `${kind} · ${path}:${startLine}` ``.
    - For a file, `insert` is `@` + path, `label` is the basename and `detail` is the path.
  - `rankMentions(q: string, symbols: SymbolEntry[], paths: string[], limit = 20): MentionItem[]`. Lowercased scoring: exact name equals `q` scores 100, name prefix 80, qualifiedName contains 50, path basename prefix 60, path contains 30, and subsequence-only matches 10. Ties break by shorter label. Doc symbols are excluded. An empty `q` returns `[]`.
- Webview behaviour:
  - Typing `@` followed by ≥ 2 non-space characters posts `mentionQuery`, debounced 120 ms.
  - The popover shows the items. ↑/↓/Enter/Tab inserts `insert` plus a space, and Esc closes it.
  - Results for a stale `q` are ignored. No other change: the assembler already parses `@` tokens.

- [ ] **Step 1: Write the failing tests**

```ts
expect(rankMentions('get_deb', syms, paths)[0]).toMatchObject({ kind: 'symbol', insert: '@get_debug_flag' });
expect(rankMentions('cli.py', syms, ['src/flask/cli.py', 'docs/cli.rst'])[0]).toMatchObject({ kind: 'file', insert: '@src/flask/cli.py' });
expect(rankMentions('', syms, paths)).toEqual([]);
expect(rankMentions('get', manySyms, paths)).toHaveLength(20);
```

Use `insert` equal to `qualifiedName`, which for module-level functions is the bare name (`get_debug_flag`). The test fixture uses that.

- [ ] **Step 2: Run `npx vitest run test/mentions.test.ts`.** Expect FAIL.
- [ ] **Step 3: Implement the ranker, host handler and popover.**
- [ ] **Step 4: Run the tests (expect PASS), `npm run typecheck` and `npm run build`.** Manual check: `@get_deb` and Enter, send, and the Context tab shows a `mention` reason first.
- [ ] **Step 5: Commit** `feat(chat): add @ mention completion`.

### Task 11: Three-way-merge undo and Undo Run

**Files:**
- Create: `src/review/threeWay.ts`
- Modify: `src/review/applyUndo.ts` (`applyFiles` stores snapshots; `change()` falls back to a merge; new `undoRun`)
- Modify: `src/types.ts` (`ToHost` adds `{ type: 'undoRun'; runId: string }`), `src/extension.ts`, `webview/src/ChangesTab.tsx:53-55` (post `undoRun` instead of looping `undo`)
- Test: `test/threeWay.test.ts`, `test/undo.test.ts` (extend)

**Interfaces:**
- Produces:
  - `threeWay(current: string, base: string, other: string): Promise<{ clean: boolean; text: string }>`
    - Writes three temp files in `mkdtemp(os.tmpdir() + '/contexo-merge-')` and runs `git merge-file -p --diff3 -L current -L applied -L undo <c> <b> <o>`.
    - Exit 0 means clean. Exit > 0 means the count of conflicts (`clean: false`, text with markers). Exit < 0 or a spawn error throws `MERGE_FAILED`.
    - Temp files are removed in `finally`. Line endings pass through byte-for-byte.
  - `ApplySnapshot { applyId: string; runId: string; path: string; before: string; after: string; hunkIds: string[]; at: number }`. `UndoStack` keeps the last **20** in the Memento key `undo.snapshots.v1` and evicts the oldest.
  - `undoHunkText(snapshot: ApplySnapshot, patch: string): string` (pure). `after` with only this hunk reversed (`undoPatchOn(after, patch)`) is the `other` side.
  - `UndoStack.undoHunk(id)`:
    - Keep the current direct path first.
    - If it fails and a snapshot exists, run `threeWay(current, snap.after, undoHunkText(snap, patch))`.
    - A clean result opens `vscode.diff(current ↔ merged)` titled `Undo hunk (merged with your edits)` plus a modal `Apply undo?` with `Apply` / `Cancel`. Apply calls `applyFiles(new Map([[path, merged]]), new Map([[path, sha256(current)]]))`.
    - A conflict opens the same diff with markers and the message `Undo conflicts with later edits in <path>; nothing was written.`
    - No snapshot means the message `Cannot undo automatically: no snapshot for this apply (older than the last 20 applies).`
  - `UndoStack.undoRun(runId)`: for each file, walk its snapshots newest to oldest, using `other = snap.before` and `base = snap.after`, folding into the running `current`. It shows one combined diff and confirm, then applies once. Any conflict aborts with nothing written.

- [ ] **Step 1: Write the failing tests**

```ts
it('clean merge keeps unrelated user edit', async () => {
  const base = 'a\nB\nc\nd\n', current = 'a\nB\nc\nD-user\n', other = 'a\nb\nc\nd\n';
  expect(await threeWay(current, base, other)).toEqual({ clean: true, text: 'a\nb\nc\nD-user\n' });
});
it('overlap yields conflict markers', async () => {
  const r = await threeWay('a\nX\n', 'a\nB\n', 'a\nb\n');
  expect(r.clean).toBe(false); expect(r.text).toContain('<<<<<<< current');
});
it('preserves CRLF', async () => {
  expect((await threeWay('a\r\nB\r\nz\r\n', 'a\r\nB\r\nc\r\n', 'a\r\nb\r\nc\r\n')).text).toBe('a\r\nb\r\nz\r\n');
});
it('undoHunkText reverses only that hunk', () => { /* two-hunk snapshot; reversing h2 leaves h1 applied */ });
```

- [ ] **Step 2: Run `npx vitest run test/threeWay.test.ts test/undo.test.ts`.** Expect FAIL.
- [ ] **Step 3: Implement `threeWay` and `undoHunkText`, add snapshot capture in `applyFiles` (read `before` prior to edit, `after` after save), the fallback path, `undoRun`, and wire the Changes tab button.**
- [ ] **Step 4: Run the tests (expect PASS) and `npm run typecheck`.** Manual check: apply Task A, edit the line after the function by hand, Undo hunk, see the merge diff, Apply, and confirm the hand edit is kept.
- [ ] **Step 5: Commit** `feat(undo): merge-aware undo and undo run`.

---

## Phase 3 · Runtime robustness

Exit check for the phase: kill VS Code mid-apply, restart, and Recover leaves the reviewed text. A Flask reindex reports p95 event-loop delay below 50 ms. Stop latency appears in the journal.

### Task 12: Startup Recover / Resume prompt

**Files:**
- Create: `src/run/startupPrompt.ts`
- Modify: `src/extension.ts:431-435` (replace the single-case prompt), `src/run/journal.ts` (add `lastRuns(n: number): Promise<RunRecord[][]>`, reading the newest `n` runs via `list()` and `continuationRecords()`)
- Test: `test/startupPrompt.test.ts`

**Interfaces:**
- Produces:
  - `unfinishedRun(records: RunRecord[]): { runId: string; request: string; mode: 'inline' | 'agent' } | undefined`. Returns the run when its last `state` record is `streaming` or `awaiting-review` and it has a `request` record.
  - `startupPrompt(s: { applyPending: boolean; reviewPending: boolean; unfinished?: { runId: string; request: string } }): { message: string; actions: Array<'Recover' | 'Restore Review' | 'Resume' | 'Dismiss'> } | undefined`, with priority apply > review > unfinished and this exact copy:
    - apply: `Contexo was interrupted while applying reviewed changes.` → `['Recover', 'Dismiss']`
    - review: `Contexo has an unfinished review.` → `['Restore Review', 'Dismiss']`
    - unfinished: `` A Contexo run did not finish: "${request.slice(0, 60)}". `` → `['Resume', 'Dismiss']`
    - none → `undefined`
- Wiring:
  - **Recover** runs `review.recoverApply()`, then posts `changes`.
  - **Restore Review** runs the existing command.
  - **Resume** calls ``runs.start('agent', `Continue the unfinished task from run ${runId}: "${request}". Call batch_plan with action "status" and fromRunId "${runId}" if a plan exists, otherwise call resume_context, then re-read files before editing.`)``
  - Also add an **Open in TrueForge** button to the Session tab header when the `session` message has a `url`. It posts the existing `openTrueForge`.

- [ ] **Step 1: Write the failing tests.** Cover each priority case with its exact message and actions, `undefined` when nothing is pending, and `unfinishedRun` on `[request, state streaming]` (returns the run) versus `[…, state done]` (`undefined`).
- [ ] **Step 2: Run `npx vitest run test/startupPrompt.test.ts`.** Expect FAIL.
- [ ] **Step 3: Implement it and wire it.**
- [ ] **Step 4: Run the tests (expect PASS) and `npm run typecheck`.** Manual check: start an apply on a multi-file proposal, kill the Extension Development Host process, relaunch, see the Recover prompt, and confirm the files equal the reviewed target.
- [ ] **Step 5: Commit** `feat(run): offer recover, restore or resume on startup`.

### Task 13: Index worker thread

**Files:**
- Create: `src/context/indexWorker.ts` (worker entry), `src/context/workerParser.ts` (host client)
- Modify: `esbuild.mjs` (add entry `src/context/indexWorker.ts` → `dist/indexWorker.js`), `src/context/indexer.ts` (use the `WorkerParser` for Python parsing when the worker starts, keeping the in-process `parsePython` fallback)
- Test: `test/workerParser.test.ts`

**Interfaces:**
- Consumes: `loadParser(wasmDir)` and `parsePython(parser, path, text): SymbolEntry[]` from `indexer.ts`.
- Produces:
  - Worker protocol: in `{ id: number; path: string; text: string }`; out `{ id: number; symbols: SymbolEntry[] } | { id: number; error: string }`. The worker loads the parser once from `workerData.wasmDir`.
  - `class WorkerParser { static start(workerFile: string, wasmDir: string): Promise<WorkerParser>; parse(path: string, text: string): Promise<SymbolEntry[]>; dispose(): Promise<void> }`
    - Requests are queued and keyed by id, with a 10 s timeout per request (rejecting `PARSE_TIMEOUT`).
    - A worker `error`/`exit` rejects all pending requests, and the indexer switches to the in-process fallback for the rest of the session with one `log()` line.

- [ ] **Step 1: Write the failing test** (needs `npm run build` so `dist/indexWorker.js` exists):

```ts
const wp = await WorkerParser.start(path.join(dist, 'indexWorker.js'), dist);
const text = await readFile('test/fixtures/sample.py', 'utf8');
expect(await wp.parse('sample.py', text)).toEqual(parsePython(await loadParser(dist), 'sample.py', text));
await wp.dispose();
```

- [ ] **Step 2: Run `npm run build && npx vitest run test/workerParser.test.ts`.** Expect FAIL (no entry or module).
- [ ] **Step 3: Implement the worker, client and esbuild entry, and switch the indexer's Python parse calls to `await parse(...)`.**
- [ ] **Step 4: Run `npm run build && npx vitest run` (all PASS, including `indexer.test.ts`) and `npm run typecheck`.**
- [ ] **Step 5: Commit** `perf(index): parse Python in a worker thread`.

### Task 14: PRD performance metrics

**Files:**
- Create: `src/metrics.ts`
- Modify: `src/run/runManager.ts` (`stop()` records latency), `src/extension.ts` (start the monitor; include the snapshot in the Settings diagnostics `setup` message), `src/types.ts` (`SettingsView.metrics?: { loopP50Ms: number; loopP95Ms: number; lastStopMs?: number; lastIndexMs?: number }`), `src/context/indexer.ts` (time `reindexAll`), `webview/src/SetupView.tsx` (show the four numbers in Settings → Diagnostics)
- Test: `test/metrics.test.ts`, `test/runManager.test.ts` (extend)

**Interfaces:**
- Produces:
  - `startLoopMonitor(resolutionMs = 20): { snapshot(): { p50Ms: number; p95Ms: number; maxMs: number }; dispose(): void }`, a wrapper over `perf_hooks.monitorEventLoopDelay`. Nanoseconds are converted to ms with one decimal.
  - `class Timer { static start(): Timer; elapsedMs(): number }`
  - `RunManager.stop()` records `{ kind: 'metric', name: 'stopLatencyMs', value }`. The value is measured from method entry until run authority is revoked **and** `killRunProcesses` resolves. Extend `RunEvidence` with `{ kind: 'metric'; name: string; value: number }`.
  - `Indexer.reindexAll()` sets `lastIndexMs`.

- [ ] **Step 1: Write the failing tests**

```ts
it('snapshot returns ms percentiles', async () => {
  const m = startLoopMonitor(10); await new Promise(r => setTimeout(r, 60));
  const s = m.snapshot(); m.dispose();
  expect(s.p95Ms).toBeGreaterThanOrEqual(s.p50Ms); expect(s.maxMs).toBeGreaterThanOrEqual(s.p95Ms);
});
it('stop records stopLatencyMs < 300 with the fake client', async () => { /* existing fakeTfClient setup; start a streaming turn; await runs.stop(); find recorded metric */
  expect(metric).toMatchObject({ kind: 'metric', name: 'stopLatencyMs' }); expect(metric.value).toBeLessThan(300);
});
```

- [ ] **Step 2: Run `npx vitest run test/metrics.test.ts test/runManager.test.ts`.** Expect FAIL.
- [ ] **Step 3: Implement it and wire it.**
- [ ] **Step 4: Run the tests (expect PASS) and `npm run typecheck`.** Manual check: reindex Flask and confirm Settings shows p95 < 50 ms with the Task 13 worker on.
- [ ] **Step 5: Commit** `feat(metrics): record event-loop delay, stop and index latency`.

### Task 15: Explorer subagent guidance (P9, instructions only)

The pinned `@truefoundry/trueforge-sdk` 0.185.0 exposes only `config.dynamicSubAgents.enabled` (`AgentInfo.type: "dynamic"` with `name`, `input`, `model?`). It has **no named subagent definitions**, so `explorer.json` and `editor-worker.json` cannot be registered. This task covers the supported half.

**Files:**
- Modify: `extension/trueforge/instructions.md` (new section "Exploration subagents")
- Modify: `src/run/manifests.ts` (no change to config. Add the comment `// Named subagents unsupported in trueforge-sdk 0.185.0 (dynamic only); see docs/FEATURE_PLAN.md P9.` above `dynamicSubAgents`)
- Test: `test/manifests.test.ts` (extend)

**Interfaces:**
- Produces this instructions section (exact copy):

  > ## Exploration subagents
  >
  > For a broad question that needs many searches (for example "how are built-in commands documented and tested?"), you may spawn one dynamic subagent named `explorer` whose input says: use only search_workspace, read_file, read_symbol, list_symbols and assemble_context; never call propose_write or run_command; return file paths, line ranges and a 5-line summary. Do the editing yourself. Skip subagents for inline edits and small tasks.

- [ ] **Step 1: Write the failing test:** `expect(buildAgentRequest(...).manifest.instructions).toContain('## Exploration subagents')`, and `expect(...config.dynamicSubAgents).toEqual({ enabled: true })`.
- [ ] **Step 2: Run `npx vitest run test/manifests.test.ts`.** Expect FAIL.
- [ ] **Step 3: Add the section and comment.** Re-register in the Extension Development Host (Settings → Register).
- [ ] **Step 4: Run the tests (expect PASS).** Manual check: on Task B with Mercury, the Session tab may show a nested `explorer` thread. If the model does not spawn one, record that in `docs/verification/` and do not force it.
- [ ] **Step 5: Commit** `docs(agent): guide dynamic explorer subagents`.

---

## Not in this plan

- **P13 `review_hunk`:** not building, per FEATURE_PLAN §4 P13.
- **Team, remote and developer features** (T1–T9, D1–D3): separate plans.
- **Named subagent definitions:** blocked until TrueForge supports them.
