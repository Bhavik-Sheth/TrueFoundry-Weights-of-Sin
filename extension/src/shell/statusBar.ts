/**
 * shell/statusBar.ts - C1 status bar item.
 *
 * Exports:
 *  - class StatusBar: shows "Contexo: idle", "Contexo: streaming . <agent>",
 *    "Contexo: awaiting review (n hunks)", "Contexo: fallback . <agent>" etc. Click runs contexo.stop.
 *  - update(s: RunStateMsg): refresh from RunManager 'state' events.
 *
 * Depends on: types. Depended on by: extension.
 */
import * as vscode from 'vscode';
import type { RunStateMsg } from '../types';

export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'contexo.stop';
    this.item.tooltip = 'Contexo (click to stop the active run)';
    this.item.text = 'Contexo: idle';
    this.item.show();
  }

  update(s: RunStateMsg): void {
    const agent = s.agent ? ` · ${s.agent}` : '';
    const isFallback = !!s.agent && s.agent.includes('fallback');
    let text: string;
    switch (s.state) {
      case 'streaming':
        text = `${isFallback ? 'fallback' : 'streaming'}${agent}`;
        break;
      case 'awaiting-review':
        text = `awaiting review (${s.hunks ?? 0} hunks)`;
        break;
      default:
        text = s.state;
    }
    this.item.text = `Contexo: ${text}`;
  }

  dispose(): void {
    this.item.dispose();
  }
}
