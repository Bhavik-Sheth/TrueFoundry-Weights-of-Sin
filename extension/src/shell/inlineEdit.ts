/**
 * shell/inlineEdit.ts - C1 command contexo.inlineEdit (Ctrl+Alt+E / Cmd+Alt+E).
 *
 * Exports:
 *  - registerInlineEdit(ctx, runManager): registers the command.
 *  - captureSelection(editor): Selection - path (workspace-relative), 0-based inclusive line range,
 *    document version, SHA-256 of the full buffer, selected text.
 *  - inlineEditCommand(): guards against an active run, captures the selection, shows an input
 *    box for the instruction, calls runManager.start('inline', text, selection).
 *
 * Rules: does nothing if a run is active or the selection is empty; no direct writes.
 * Depends on: types, run/runManager.
 * Depended on by: extension.
 */
export {};
