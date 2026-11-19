/**
 * bridge.ts - typed host/webview messaging (C1; counterpart of src/shell/panel.ts).
 *
 * Exports:
 *  - vscode: result of acquireVsCodeApi() (called once).
 *  - post(msg: ToHost): send ready / stop / openSource / undo / redo.
 *  - subscribe(cb): returns unsubscribe fn; messages: session, runState, packet, changes.
 *  - getState() / setState(): wrappers for vscode.getState/setState (tab, graph positions).
 *
 * Depends on: message types from src/types.ts. Depended on by: App, ChatTab, ContextTab, ContextGraph, ChangesTab.
 */
export {};
