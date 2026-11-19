/**
 * bridge.ts - typed host/webview messaging (C1; counterpart of src/shell/panel.ts).
 *
 * Exports:
 *  - vscode: result of acquireVsCodeApi() (called once).
 *  - post(msg: ToHost): send ready / stop / send / openSource / undo / redo.
 *  - subscribe(cb): returns unsubscribe fn; messages: session, runState, stream, packet, changes.
 *  - getState() / setState(): wrappers for vscode.getState/setState (tab, graph positions).
 *
 * Depends on: message types from src/types.ts. Depended on by: App, ChatTab, ContextTab, ContextGraph, ChangesTab.
 */
import type { ToHost, ToWebview } from '../../src/types';

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(s: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

export const vscode: VsCodeApi = acquireVsCodeApi();

export function post(msg: ToHost): void {
  vscode.postMessage(msg);
}

export function subscribe(cb: (m: ToWebview) => void): () => void {
  const handler = (e: MessageEvent) => cb(e.data as ToWebview);
  window.addEventListener('message', handler);
  return () => window.removeEventListener('message', handler);
}

export function getState<T extends object = Record<string, unknown>>(): T {
  return (vscode.getState() ?? {}) as T;
}

export function setState(patch: Record<string, unknown>): void {
  vscode.setState({ ...getState(), ...patch });
}
