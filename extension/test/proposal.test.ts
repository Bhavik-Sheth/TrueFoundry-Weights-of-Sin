/**
 * proposal.test.ts - tests for src/review/proposal.ts and review/diffView.ts logic (C4).
 *
 * Cases to write:
 *  - Exact match: oldText found once is replaced.
 *  - Ambiguous (more than one match) gives AMBIGUOUS; not found gives OLD_TEXT_NOT_FOUND.
 *  - Stale base: baseHash differs from live text gives STALE_BASE.
 *  - Create-file edit (empty oldText + baseHash new).
 *  - proposalKey is stable for equal args (canonical JSON) and changes with any edit.
 *  - Hunk ids are deterministic; hunks have 3 context lines.
 *  - rebuildFromAccepted with a subset (none, some, all) yields the expected text.
 *  - Undo/redo patch round-trip; undo refuses when text changed at the hunk.
 */
export {};
