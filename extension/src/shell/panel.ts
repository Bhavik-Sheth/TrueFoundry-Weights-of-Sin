/**
 * shell/panel.ts - C1 host side of the Contexo webview panel.
 *
 * Exports:
 *  - class ContexoPanelProvider implements WebviewViewProvider (from webview-view-sample): serves
 *    the Vite bundle in dist/webview with a CSP + nonce; CSP allows connect-src to the TrueForge URL.
 *  - post(msg: ToWebview): used by C2/C3/C4 to push session, runState, packet and changes.
 *  - handleMessage(msg: ToHost): routes ready, stop, openSource, undo, redo to runManager,
 *    review/applyUndo or the editor.
 *
 * Rules: no agent logic. Re-sends the latest state on 'ready' (panel reload).
 * Depends on: types, config, run/runManager, review/applyUndo.
 * Depended on by: extension, run/runManager, mcp/tools (packet push), review/applyUndo (changes).
 */
export {};
