/**
 * log.ts - the shared "Contexo" OutputChannel (C1).
 *
 * Exports:
 *  - log(...args): append a line to the channel (created lazily).
 *  - getOutput(): the OutputChannel itself.
 * Depends on: vscode API only. Depended on by: every host module that logs.
 */
import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function getOutput(): vscode.OutputChannel {
  channel ??= vscode.window.createOutputChannel('Contexo');
  return channel;
}

export function log(...args: unknown[]): void {
  const line = args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack ?? a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
  getOutput().appendLine(line);
}
