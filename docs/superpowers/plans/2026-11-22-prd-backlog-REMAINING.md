# PRD backlog: remaining work

Handoff for [2026-11-22-prd-backlog.md](2026-11-22-prd-backlog.md), written when execution paused on 22 November 2026.

## Where things stand

- **Branch:** `full_soln`, started from `foldr` at `95bf1ec`. Local HEAD is `a1ed329`.
- **Pushed:** `origin/full_soln` is at `fc8e46f`, the end of Phase 2. The two Task 12 commits (`5649ba2`, `a1ed329`) and this doc are local only.
- **Working tree:** `extension/test/workerParser.test.ts` is untracked. It is the TDD starting test from the stopped Task 13 run, and no implementation exists for it yet.
- **Last full run** (Phase 2 end): build 0, typecheck 0, vitest 285 passed. One failure is pre-existing: `test/interop.test.ts`, "keeps changed CI observations…", fails with an EBUSY error deleting a temp `journal.sqlite` on Windows. It is not a regression.
- **Execution method:** subagent-driven, with Sonnet at medium effort for every subagent, one implementer plus one reviewer per task. The ledger, briefs, reports and review diffs are in `.superpowers/sdd/2026-11-22-prd-backlog/` (git-ignored). `progress.md` there is the full ledger.

| Task | Feature | Status | Commits |
|---|---|---|---|
| 1 | History concern detection | Done, reviewed | `15b4a0a` |
| 2 | `explainRange` + `why_exists` tool | Done (1 fix round) | `e33ea6b..4ece81a` |
| 3 | `HISTORY_CONCERN` gate + review UI | Done (1 fix round) | `23822ba..9312b72` |
| 4 | `read_symbol` tool | Done, reviewed | `0c5fc2c` |
| 5 | Instruction packs | Done, reviewed | `9fda8e9` |
| 6 | Regenerate after stale review | Done, reviewed | `e440b92` |
| 7 | Wiring map | Done (1 fix round) | `1d994d6..4333c7d` |
| 8 | Grounded review summary | Done, reviewed | `7eb19a4` |
| 9 | Task tab (requirements) | Done (pre-review fix) | `c65afea..50b7e6d` |
| 10 | `@` mention completion | Done, reviewed | `7f4f4a1` |
| 11 | Three-way undo + Undo Run | Done (1 fix round) | `883ca63..fc8e46f` |
| 12 | Startup Recover/Resume prompt | Done (1 fix round) | `5649ba2..a1ed329` |
| **13** | **Index worker thread** | **Paused** (only an untracked test file) | — |
| **14** | **PRD performance metrics** | **Not started** | — |
| **15** | **Explorer subagent guidance** | **Not started** | — |
| — | **Final whole-branch review** | **Not started** | — |

## What is left to do

1. **Task 13: index worker.** Re-dispatch from the brief `.superpowers/sdd/2026-11-22-prd-backlog/task-13-brief.md` or plan §Task 13. Decide whether to keep or rewrite the untracked `extension/test/workerParser.test.ts`. Notes from the dispatch:
   - If the indexer's call sites use `parsePython`'s `onImports` callback, the worker must return import bindings too.
   - If the worker fails to start, fall back to in-process parsing with one log line.
   - Dispose the worker on deactivate.
   - `src/context/indexer.ts` uses CRLF line endings.
2. **Task 14: metrics.** Implement per plan §Task 14: event-loop p50/p95, `stopLatencyMs` journal metric, `lastIndexMs`, and showing them in Settings diagnostics. It touches `runManager.ts`, `indexer.ts`, `SetupView.tsx`, `types.ts` and `journal.ts`.
3. **Task 15: subagent guidance.** Per plan §Task 15, this is instructions only. The pinned TrueForge SDK supports only dynamic subagents.
4. **Phase 3 exit:**
   - Run `npm run build && npm run typecheck && npx vitest run` from `extension/`.
   - Push `full_soln`. You asked for a push after each phase.
5. **Final whole-branch review:**
   - Range `5802ecf..HEAD`.
   - Give the reviewer the deferred minors below to triage what must be fixed before merge.
   - Then use superpowers:finishing-a-development-branch.
6. **Manual GUI checks.** No subagent could run VS Code, so each of these was verified only by typecheck. Run them in the Extension Development Host on Flask:
   - P1: an agent edit deleting a blamed fix range is denied once with `HISTORY_CONCERN`. Then the "⚠ Why does this exist?" lens appears, Accept opens a modal, and Accept all leaves that hunk pending.
   - P10: edit a file while its diff is open, Apply, then click the Regenerate button.
   - P4/P5: Task B shows the summary facts and the wiring map in Changes. Clicking an edge or a fact opens the file. The map clears after apply or reject.
   - P3: the Task tab shows five requirements and their states climb through apply and the test run.
   - P6: typing `@get_deb` shows a popover, Enter inserts, and the Context tab shows a `mention` reason first.
   - P2: apply Task A, edit a nearby line, Undo hunk, see the merge diff, Apply. Undo Run on a run should also work.
   - P11: kill VS Code mid-apply. On restart the Recover prompt appears and the files end up as the reviewed text.

## Rulings made during execution (check these)

- **`detectConcern`:** specific keywords (race, security…) win over generic fix/bug, as the plan's own example requires. Keyword matching uses word boundaries.
- **`why_exists` cache key** includes the line range, so it is `path:head:start-end`.
- **Accept all** leaves unread history-concern hunks pending and shows an info message. It does not open a second modal.
- **`estimateTokens`** in the plan does not exist. The existing `tokens.count()` is used instead.
- **Regenerate** goes through the same `ask()` path as typed chat messages.
- **Wiring map:**
  - `SummaryFact` lives in `summary.ts`.
  - Wiring is computed on a copy with all hunks accepted, and edges carry `hunkLine`.
  - A new `reviewClosed` message clears the map.
- **Summary:**
  - Check facts are not clickable.
  - Checks come from `run_command` tool-call and tool-output pairs.
  - `SummaryFact` gained optional `path` and `line`.
- **Task tab:**
  - `requirement-link.source` is `manual | agent | human`, with an optional `linked`.
  - Accepted and applied states come from `proposal` records.
  - Links carry optional `path` and `line`.
  - Agent `R#` labels resolve only for requirements recorded at run start.
- **Mentions:** when an item matches several scoring rules, it takes the highest score.
- **Undo:**
  - Snapshots are captured only through `applyFiles(..., meta)` from the review apply path, so recovery applies get no snapshot.
  - The three-way merge tests use non-adjacent fixtures, because `git merge-file` reports adjacent changes as conflicts.
  - Undo Run is all-or-nothing: it refuses if any of the run's hunks has lost its snapshot.
- **Startup prompt:** only the newest run is checked for being unfinished.

## Deferred minors, to triage in the final review

- **Task 1:** the issue regex matches `#123abc` and `C#12`. The `TODO`/`NOTE` match is case-insensitive, so it hits identifiers like `note = x`. The generic `fix` fallback, `CVE-` and CRLF blame are untested.
- **Task 2:** a bad blame range in a valid repo is reported as `no-git`. The cached `WhyExists` is returned by reference. The tests-linkage and shallow-clone paths are untested.
- **Task 3:** only the first concern commit per hunk is used. `whyByHunk` is never cleared. The `setAllDecisions` import in `diffView.ts` may now be unused. The deny-once test checks only the message prefix.
- **Task 4:** the `tools.ts` header comment has a stray `.;` and still says "6 editor tools". The unique-`byName` step has no isolated test.
- **Task 5:** one malformed pack file disables all packs. A missing `version` is rejected only because `NaN` fails the comparison.
- **Task 6:** in a multi-file proposal, `onStale` fires for the first stale file only.
- **Task 7:** the wiring tests cover one hunk only. `wiringFor` loads the parser twice.
- **Task 8:**
  - The 8-fact cap cuts from the end, so checks and flags can be dropped.
  - The symbol key has no path.
  - The tool-call name is not checked against `run_command`, and pytest counts are parsed from any command's output.
- **Task 9:**
  - The Task tab ignores `runId`, so a previous run's requirements can linger.
  - `requirementTimers` are not cleared on dispose.
  - The whole journal is re-read on every relevant record.
- **Task 10:**
  - The caret is tracked only in `onChange`.
  - `String.replace` with a string replacement mangles `$&` in names.
  - The path cache can race with invalidation.
  - `findFiles` spans all workspace roots.
- **Task 11:**
  - The snapshot store can grow to megabytes (the plan mandates full text for 20 files).
  - Untitled merge documents are never closed.
  - Undo Run on a new file empties it instead of deleting it.
  - Redo after a merge-undo uses the direct path only.
  - The `applyUndo.ts` header bullets are mis-nested.
- **Task 12:** `lastRuns` reads every run file at startup. Its JSONL parsing duplicates `continuationRecords`. The Open in TrueForge button is hidden until a session message arrives.

## How to resume

The ledger at `.superpowers/sdd/2026-11-22-prd-backlog/progress.md` lists every commit, ruling and deferred minor. Brief files for Tasks 1–13 are already extracted. Generate later briefs with the subagent-driven-development skill's `scripts/task-brief <plan> <N>`, and review diffs with `scripts/review-package <plan> <base> <head>`. Shared context for every implementer is in `.superpowers/sdd/2026-11-22-prd-backlog/common.md`: the global constraints, the list of CRLF files, the commit-attribution rule and the known failing test.
