/**
 * review/applyUndo.ts - C4 writing and undo/redo of accepted hunks.
 *
 * Exports:
 *  - applyFiles(map): one WorkspaceEdit with a full-range replace per file, then document.save()
 *    (no formatting).
 *  - recordApplied(runId, hunks): push AppliedHunk records (forward unified patch of each hunk).
 *  - undoHunk(hunkId) / redoHunk(hunkId): apply reversed / forward patch with jsdiff applyPatch to
 *    current text; if it does not apply cleanly show "Cannot undo automatically: file changed at
 *    this hunk" and leave the file alone.
 *  - undoLastApply(): undo all hunks of the latest apply in reverse order.
 *  - list(): history; each change posts a changes message to the panel.
 *
 * Rules: in-memory history only (lost on reload, documented limitation).
 * Depends on: diff, types, shell/panel. Depended on by: review/diffView, shell/panel.
 */
export {};
