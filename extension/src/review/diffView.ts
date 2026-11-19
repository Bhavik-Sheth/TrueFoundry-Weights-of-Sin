/**
 * review/diffView.ts - C4 review orchestration and VS Code UI.
 *
 * S3 status: REAL engine (beginProposal, per-hunk CodeLens, applyAccepted, rejectAll, finalize,
 * finalizeLatest, discardPending, pending). ReviewEngine.index (set by extension.ts) feeds
 * guards.symbolCheck; contexo.proposal.acceptAll(key) is registered and hidden from the palette (declared in the manifest).
 * Slice 6 adds decorations.
 *
 * Exports:
 *  - class ReviewEngine:
 *    - setDoc(uri, text): register content for a contexo-base: / contexo-proposed: document.
 *    - beginProposal(run, toolCallId, threadId, args): one proposal at a time (ANOTHER_PROPOSAL_UNDER_REVIEW);
 *      per edit check live text hash vs baseHash (STALE_BASE), exact-match oldText, build hunks;
 *      symbolCheck (MISSING_SYMBOL), scopeGuard for inline runs; register virtual docs; open vscode.diff
 *      per file; CodeLens per hunk. Returns 'reviewing' or {deny}.
 *    - setDecision(hunkId, decision), acceptAll(key), applyAccepted(key), rejectAll(key).
 *    - finalize(key) / finalizeLatest(): stored {applied, rejected} or {error}; never writes.
 *    - discardPending(): close diffs, drop proposal (used by Stop); nothing written, onResolve not called.
 *    - get pending(): proposal under review.
 *    - onResolve?: callback set by RunManager; called at most once per proposal.
 *    - undo: the UndoStack.
 *  - registerReview(ctx, post): registers providers, CodeLens and commands contexo.undoHunk,
 *    contexo.redoHunk, contexo.hunk.decide(key, hunkId, decision), contexo.proposal.apply(key),
 *    contexo.proposal.rejectAll(key), contexo.proposal.acceptAll(key).
 *
 * Rules: nothing reaches disk until Apply accepted.
 * Depends on: review/proposal, review/guards, review/applyUndo, types, log. Depended on by: run/runManager, mcp/tools, extension.
 */
import * as vscode from 'vscode';
import type { Hunk, Proposal, ProposeArgs, Run, Sha, ToWebview } from '../types';
import type { IndexApi } from '../context/indexer';
import { log } from '../log';
import { UndoStack } from './applyUndo';
import { scopeGuard, symbolCheck } from './guards';
import {
  acceptedCount, applyEditExact, buildHunks, computeResult, once, proposalKey, rebuildFile, setAllDecisions,
  setHunkDecision, sha256,
} from './proposal';

export const BASE_SCHEME = 'contexo-base';
export const PROPOSED_SCHEME = 'contexo-proposed';

type Result = { applied: string[]; rejected: string[] };

const EMPTY_INDEX: IndexApi = {
  ready: Promise.resolve(),
  symbols: () => [],
  byName: () => [],
  inFile: () => [],
  enclosing: () => undefined,
  reindexFile: async () => {},
  reindexAll: async () => {},
};

function docUri(scheme: string, key: string, path: string): vscode.Uri {
  return vscode.Uri.from({ scheme, path: `/${key}/${path}` });
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function resolveWorkspaceUri(rel: string): vscode.Uri {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) throw new Error('PATH_ERROR: no workspace folder open');
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel) || rel.split('/').includes('..')) {
    throw new Error(`PATH_ERROR: ${rel} must be workspace-relative without ".."`);
  }
  return vscode.Uri.joinPath(root, ...rel.split('/'));
}

/** Live text: open (possibly dirty) document if any, else disk. undefined = file does not exist. */
async function readLive(rel: string): Promise<string | undefined> {
  const uri = resolveWorkspaceUri(rel);
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) return open.getText();
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  } catch {
    return undefined;
  }
}

export class ReviewEngine {
  readonly docs = new Map<string, string>();
  readonly undo: UndoStack;
  readonly codeLensChanged = new vscode.EventEmitter<void>();
  onResolve?: (allow: boolean, reason?: string) => void;
  /** Set by extension.ts (integration) so symbolCheck can see the workspace index. */
  index?: IndexApi;

  private proposals = new Map<Sha, Proposal>();
  private runs = new Map<Sha, Run>();
  private resolvers = new Map<Sha, (allow: boolean, reason?: string) => void>();
  private latest?: Result;
  private pendingKey?: Sha;

  constructor(post: (m: ToWebview) => void = () => {}) {
    this.undo = new UndoStack(post);
  }

  setDoc(uri: string, text: string): void {
    this.docs.set(vscode.Uri.parse(uri).toString(), text);
    this.codeLensChanged.fire();
  }

  get pending(): Proposal | undefined {
    return this.pendingKey ? this.proposals.get(this.pendingKey) : undefined;
  }

  async beginProposal(
    run: Run,
    toolCallId: string,
    threadId: string,
    args: ProposeArgs,
  ): Promise<'reviewing' | { deny: string }> {
    if (this.pending) return { deny: 'ANOTHER_PROPOSAL_UNDER_REVIEW: finish or reject the open proposal first, then retry.' };
    if (!args || !Array.isArray(args.edits) || args.edits.length === 0) return { deny: 'INVALID_ARGS: edits must be a non-empty array.' };
    const key = proposalKey(args);

    // Group edits by path, preserving order; chain several edits on the same file.
    const order: string[] = [];
    const byPath = new Map<string, { baseHash: Sha; base: string; text: string }>();
    try {
      for (const e of args.edits) {
        let st = byPath.get(e.path);
        if (!st) {
          const live = await readLive(e.path);
          if (e.baseHash === 'new') {
            if (live !== undefined && live !== '') {
              return { deny: `FILE_EXISTS ${e.path}: baseHash "new" but the file already exists. Use read_file and its hash.` };
            }
            st = { baseHash: 'new', base: '', text: '' };
          } else {
            if (live === undefined) {
              return { deny: `FILE_NOT_FOUND ${e.path}: file does not exist. For a new file use baseHash "new" and oldText "".` };
            }
            const h = sha256(live);
            if (h !== e.baseHash) return { deny: `STALE_BASE ${e.path}: file changed (current hash ${h}). Re-read and retry.` };
            st = { baseHash: e.baseHash, base: live, text: live };
          }
          byPath.set(e.path, st);
          order.push(e.path);
        } else if (e.baseHash !== st.baseHash) {
          return { deny: `STALE_BASE ${e.path}: edits for the same file must share one baseHash.` };
        }
        try {
          st.text = applyEditExact(st.text, e.oldText, e.newText);
        } catch (err) {
          return { deny: `${errText(err)} (${e.path})` };
        }
      }
    } catch (err) {
      return { deny: errText(err) };
    }

    const files: Proposal['files'] = order
      .map((p) => {
        const s = byPath.get(p)!;
        return { path: p, base: s.base, proposed: s.text, baseHash: s.baseHash };
      })
      .filter((f) => f.base !== f.proposed);
    if (files.length === 0) return { deny: 'NO_CHANGE: the proposed edits do not change any file.' };

    const hunks: Hunk[] = files.flatMap((f) => buildHunks(f.path, f.base, f.proposed, f.baseHash));

    try {
      const violations = await symbolCheck(files, this.index ?? EMPTY_INDEX);
      if (violations.length > 0) return { deny: violations.join('\n') };
      if (run.mode === 'inline' && run.selection) scopeGuard(hunks, run.selection);
    } catch (err) {
      log('guards failed (ignored):', errText(err));
    }

    const proposal: Proposal = { key, runId: run.id, toolCallId, threadId, files, hunks, status: 'reviewing' };
    this.proposals.set(key, proposal);
    this.runs.set(key, run);
    this.resolvers.set(key, once((allow, reason) => this.onResolve?.(allow, reason)));
    this.pendingKey = key;

    for (const f of files) {
      this.docs.set(docUri(BASE_SCHEME, key, f.path).toString(), f.base);
      this.docs.set(docUri(PROPOSED_SCHEME, key, f.path).toString(), f.proposed);
    }
    this.codeLensChanged.fire();

    let first = true;
    for (const f of files) {
      const n = hunks.filter((h) => h.path === f.path).length;
      const name = f.path.split('/').pop() ?? f.path;
      try {
        await vscode.commands.executeCommand(
          'vscode.diff',
          docUri(BASE_SCHEME, key, f.path),
          docUri(PROPOSED_SCHEME, key, f.path),
          `${name} · Contexo proposal (${n} hunks)`,
          { preview: false, preserveFocus: !first },
        );
      } catch (err) {
        log('vscode.diff failed', errText(err));
      }
      first = false;
    }
    return 'reviewing';
  }

  setDecision(hunkId: string, d: 'accepted' | 'rejected'): void {
    const p = this.pending;
    if (!p) return;
    if (setHunkDecision(p.hunks, hunkId, d)) this.codeLensChanged.fire();
  }

  acceptAll(key: Sha): void {
    const p = this.proposals.get(key);
    if (!p || p.status !== 'reviewing') return;
    setAllDecisions(p.hunks, 'accepted');
    this.codeLensChanged.fire();
  }

  async applyAccepted(key: Sha): Promise<void> {
    const p = this.proposals.get(key);
    if (!p || p.status !== 'reviewing') return;
    if (acceptedCount(p.hunks) === 0) {
      this.rejectAll(key);
      return;
    }
    const resolve = this.resolvers.get(key)!;
    const run = this.runs.get(key)!;
    try {
      for (const f of p.files) {
        const live = await readLive(f.path);
        const ok = f.baseHash === 'new' ? live === undefined || live === '' : live !== undefined && sha256(live) === f.baseHash;
        if (!ok) {
          this.finish(p, 'stale', { applied: [], rejected: p.hunks.map((h) => h.id) });
          resolve(false, `STALE_BASE during review: ${f.path} changed`);
          return;
        }
      }
      const out = new Map<string, string>();
      for (const f of p.files) {
        const text = rebuildFile(f.base, f.path, p.hunks);
        if (text !== f.base) out.set(f.path, text);
      }
      await this.undo.applyFiles(out);
      this.undo.recordApplied(run.id, p.hunks.filter((h) => h.decision === 'accepted'));
    } catch (err) {
      log('applyAccepted failed', errText(err));
      this.finish(p, 'rejected', { applied: [], rejected: p.hunks.map((h) => h.id) });
      resolve(false, `APPLY_FAILED: ${errText(err)}`);
      return;
    }
    this.finish(p, 'applied', computeResult(p.hunks));
    resolve(true);
  }

  rejectAll(key: Sha): void {
    const p = this.proposals.get(key);
    if (!p || p.status !== 'reviewing') return;
    setAllDecisions(p.hunks, 'rejected');
    this.finish(p, 'rejected', computeResult(p.hunks));
    this.resolvers.get(key)?.(false, 'user rejected all hunks');
  }

  finalize(key: Sha): Result | { error: string } {
    const r = this.proposals.get(key)?.result;
    return r ? { applied: [...r.applied], rejected: [...r.rejected] } : { error: 'UNKNOWN_PROPOSAL' };
  }

  finalizeLatest(): Result | { error: string } {
    return this.latest ? { applied: [...this.latest.applied], rejected: [...this.latest.rejected] } : { error: 'UNKNOWN_PROPOSAL' };
  }

  discardPending(): void {
    const p = this.pending;
    if (!p) return;
    p.status = 'discarded';
    this.pendingKey = undefined;
    void this.closeDiffs(p.key);
    this.dropDocs(p);
    this.codeLensChanged.fire();
  }

  /** Common end-of-review bookkeeping (the resolver call is made by the caller). */
  private finish(p: Proposal, status: Proposal['status'], result: Result): void {
    p.status = status;
    p.result = result;
    this.latest = result;
    if (this.pendingKey === p.key) this.pendingKey = undefined;
    void this.closeDiffs(p.key);
    this.dropDocs(p);
    this.codeLensChanged.fire();
  }

  private dropDocs(p: Proposal): void {
    for (const f of p.files) {
      this.docs.delete(docUri(BASE_SCHEME, p.key, f.path).toString());
      this.docs.delete(docUri(PROPOSED_SCHEME, p.key, f.path).toString());
    }
  }

  private async closeDiffs(key: Sha): Promise<void> {
    try {
      const tabs: vscode.Tab[] = [];
      for (const g of vscode.window.tabGroups.all) {
        for (const t of g.tabs) {
          const inp = t.input;
          if (
            inp instanceof vscode.TabInputTextDiff &&
            inp.modified.scheme === PROPOSED_SCHEME &&
            inp.modified.path.startsWith(`/${key}/`)
          ) {
            tabs.push(t);
          }
        }
      }
      if (tabs.length) await vscode.window.tabGroups.close(tabs);
    } catch (err) {
      log('closeDiffs failed', errText(err));
    }
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const m = /^\/([0-9a-f]+)\/(.+)$/.exec(doc.uri.path);
    if (!m) return [];
    const p = this.proposals.get(m[1]);
    if (!p || p.status !== 'reviewing') return [];
    const path = m[2];
    const top = new vscode.Range(0, 0, 0, 0);
    const lenses: vscode.CodeLens[] = [
      new vscode.CodeLens(top, { title: `Apply accepted (${acceptedCount(p.hunks)})`, command: 'contexo.proposal.apply', arguments: [p.key] }),
      new vscode.CodeLens(top, { title: 'Accept all', command: 'contexo.proposal.acceptAll', arguments: [p.key] }),
      new vscode.CodeLens(top, { title: 'Reject all', command: 'contexo.proposal.rejectAll', arguments: [p.key] }),
    ];
    for (const h of p.hunks.filter((x) => x.path === path)) {
      const line = Math.max(0, Math.min(h.newStart - 1, Math.max(0, doc.lineCount - 1)));
      const r = new vscode.Range(line, 0, line, 0);
      lenses.push(
        new vscode.CodeLens(r, {
          title: h.decision === 'accepted' ? '✓ Accepted' : '✓ Accept',
          command: 'contexo.hunk.decide',
          arguments: [p.key, h.id, 'accepted'],
        }),
        new vscode.CodeLens(r, {
          title: h.decision === 'rejected' ? '✗ Rejected' : '✗ Reject',
          command: 'contexo.hunk.decide',
          arguments: [p.key, h.id, 'rejected'],
        }),
      );
      if (h.outsideSelection) lenses.push(new vscode.CodeLens(r, { title: '⚠ outside selection', command: '' }));
    }
    return lenses;
  }
}

export function registerReview(ctx: vscode.ExtensionContext, post: (m: ToWebview) => void): ReviewEngine {
  const review = new ReviewEngine(post);

  const provider: vscode.TextDocumentContentProvider = {
    provideTextDocumentContent: (uri) => review.docs.get(uri.toString()) ?? '',
  };
  const lens: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: review.codeLensChanged.event,
    provideCodeLenses: (doc) => review.provideCodeLenses(doc),
  };

  ctx.subscriptions.push(
    review.codeLensChanged,
    vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, provider),
    vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, provider),
    vscode.languages.registerCodeLensProvider({ scheme: PROPOSED_SCHEME }, lens),
    vscode.commands.registerCommand('contexo.undoHunk', async (hunkId?: string) => {
      if (hunkId) await review.undo.undoHunk(hunkId);
    }),
    vscode.commands.registerCommand('contexo.redoHunk', async (hunkId?: string) => {
      if (hunkId) await review.undo.redoHunk(hunkId);
    }),
    vscode.commands.registerCommand('contexo.hunk.decide', (key?: string, hunkId?: string, d?: 'accepted' | 'rejected') => {
      if (key && hunkId && d && review.pending?.key === key) review.setDecision(hunkId, d);
    }),
    vscode.commands.registerCommand('contexo.proposal.apply', async (key?: string) => {
      if (key) await review.applyAccepted(key);
    }),
    vscode.commands.registerCommand('contexo.proposal.rejectAll', (key?: string) => {
      if (key) review.rejectAll(key);
    }),
    vscode.commands.registerCommand('contexo.proposal.acceptAll', (key?: string) => {
      if (key) review.acceptAll(key);
    }),
  );
  return review;
}
