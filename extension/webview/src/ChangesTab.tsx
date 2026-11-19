/**
 * ChangesTab.tsx - Changes tab (C1, serves criterion B2).
 *
 * Exports:
 *  - ChangesTab (React component): lists AppliedHunk records (from the changes message) grouped
 *    by run and file, with Undo / Redo buttons per hunk (post undo / redo with hunkId); shows
 *    undone state and a "Cannot undo automatically" message from the host when a patch no longer applies.
 *
 * Depends on: bridge.ts. Depended on by: App.tsx.
 */
export {};
