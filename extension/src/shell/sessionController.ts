/**
 * shell/sessionController.ts - host side of the Session tab (read-only view of TrueForge sessions). No vscode import.
 *
 * Exports: class SessionController
 *  - show(ids?): loads the given session ids (default: the current run's sealed + current sessions, oldest first),
 *    plus the recent-sessions list for the picker, and posts one 'sessionView' message. Errors become `error`.
 *  - refreshCurrent(): reload the current selection (called on turn.done / Refresh).
 * Depends on: types, run/tfClient (type). Depended on by: extension.
 */
import type { SessionSummary, SessionView, ToWebview } from '../types';
import type { SessionInspector } from '../run/tfClient';

export interface SessionControllerDeps {
  inspector: SessionInspector;
  post: (m: ToWebview) => void;
  /** Sessions of the current run: sealed ones first, the live one last. */
  currentRun: () => { ids: string[]; sealed: string[] };
}

export class SessionController {
  private selection?: string[];   // explicit picker choice; undefined = follow the current run
  private seq = 0;

  constructor(private readonly deps: SessionControllerDeps) {}

  async show(ids?: string[]): Promise<void> {
    this.selection = ids && ids.length ? ids : undefined;
    await this.load();
  }

  async refreshCurrent(): Promise<void> {
    await this.load();
  }

  private async load(): Promise<void> {
    const mine = ++this.seq;
    const run = this.deps.currentRun();
    const ids = this.selection ?? run.ids;
    let recent: SessionSummary[] = [];
    let sessions: SessionView[] = [];
    let error: string | undefined;
    try {
      recent = await this.deps.inspector.recent(20);
      sessions = await Promise.all(ids.map((id) => this.deps.inspector.load(id, run.sealed.includes(id))));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    if (mine !== this.seq) return; // a newer load superseded this one
    this.deps.post({ type: 'sessionView', sessions, recent, selected: this.selection ?? [], error });
  }
}
