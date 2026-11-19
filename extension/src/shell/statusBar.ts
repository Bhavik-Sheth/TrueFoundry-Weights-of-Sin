/**
 * shell/statusBar.ts - C1 status bar item.
 *
 * Exports:
 *  - class StatusBar: createStatusBarItem; text per run state: "Contexo: idle", "streaming . <model>",
 *    "awaiting review (n hunks)", "fallback . <model>". Click runs contexo.stop.
 *  - update(state, model, hunkCount?): refresh from RunManager events.
 *
 * Depends on: types, run/runManager events. Depended on by: extension.
 */
export {};
