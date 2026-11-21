/**
 * review/diffView.ts - C4 review orchestration and VS Code UI.
 *
 * S3 status: REAL engine (beginProposal, per-hunk CodeLens, applyAccepted, rejectAll, finalize,
 * finalizeLatest, discardPending, pending). ReviewEngine.index (set by extension.ts) feeds
 * guards.symbolCheck; contexo.proposal.acceptAll(key) is registered and hidden from the palette (declared in the manifest).
 * S6: symbol-check denies list all violations; hunks outside an inline selection get a red decoration on the
 * proposed side (refreshDecorations) and a CodeLens label.
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
import { workspaceRoot, hasNativeFiles } from '../shell/workspaceRoot';
import * as vscode from 'vscode';
import { buildProposalFiles } from './editBatch';
import type { Hunk, Proposal, ProposeArgs, Run, Sha, ToWebview } from '../types';
import type { IndexApi } from '../context/indexer';
import { log } from '../log';
import { assertNativeWorkspacePath, resolveUnder } from '../mcp/server';
import { UndoStack, pickHunk } from './applyUndo';
import { addedLines, scopeGuard, symbolCheck } from './guards';
import {
  acceptedCount, buildHunks, computeResult, once, proposalKey, rebuildFile, setAllDecisions,
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

function resolveWorkspaceUri(rel: string, root = workspaceRoot()?.uri): vscode.Uri {
  if (!root) throw new Error('PATH_ERROR: no workspace folder open');
  resolveUnder(root.fsPath, rel);
  return vscode.Uri.joinPath(root, ...rel.split('/'));
}

/** Live text: open (possibly dirty) document if any, else disk. undefined = file does not exist. */
export async function readLive(rel: string, root = workspaceRoot()?.uri): Promise<string | undefined> {
  if (!root) throw new Error('Open a workspace folder.');
  resolveUnder(root.fsPath, rel);
  const uri = vscode.Uri.joinPath(root, ...rel.split('/'));
  if (root && hasNativeFiles(root)) await assertNativeWorkspacePath(root.fsPath, rel);
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  return open ? open.getText() : readDisk(uri);
}

async function readDisk(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(await vscode.workspace.fs.readFile(uri));
  } catch (error) {
    if ((error as { code?: string }).code === 'FileNotFound') return undefined;
    throw error;
  }
}

/** 1-based proposed-side line span of a hunk's changes (falls back to its start line for pure deletions). */
function hunkSpan(h: Hunk): [number, number] {
  const a = addedLines(h);
  return a.length ? [a[0], a[a.length - 1]] : [Math.max(1, h.newStart), Math.max(1, h.newStart)];
}

export class ReviewEngine {
  readonly docs = new Map<string, string>();
  readonly undo: UndoStack;
  readonly codeLensChanged = new vscode.EventEmitter<void>();
  onResolve?: (allow: boolean, reason?: string) => void;
  /** Set by extension.ts (integration) so symbolCheck can see the workspace index. */
  index?: IndexApi;

  persistDecision?: (proposal: Proposal, run: Run) => PromiseLike<void>;
  validateProposal?: (run: Run, args: ProposeArgs) => PromiseLike<void>;
  flushEvidence?: () => PromiseLike<void>;
  validateApply?: (proposal: Proposal) => PromiseLike<void>;
  onProposal?: (p: Proposal) => void;
  private proposals = new Map<Sha, Proposal>();
  private runs = new Map<Sha, Run>();
  private resolvers = new Map<Sha, (allow: boolean, reason?: string) => void>();
  private latest?: Result;
  private pendingKey?: Sha;
  private outsideDeco?: vscode.TextEditorDecorationType;
  private sourceDeco?: vscode.TextEditorDecorationType;
  private attaching = false;
  private decisionUpdates = Promise.resolve();
  private failedDecision?: Sha;

  constructor(post: (m: ToWebview) => void = () => {}, private readonly storage?: vscode.Memento) {
    this.undo = new UndoStack(post, storage);
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
    const key = run.origin === 'external' ? sha256(run.id + proposalKey(args)) : proposalKey(args);

    let files: Proposal['files'];
    try {
      await this.validateProposal?.(run, args);
      files = await buildProposalFiles(args.edits, readLive);
    } catch (err) {
      return { deny: errText(err) };
    }
    if (files.length === 0) return { deny: 'NO_CHANGE: the proposed edits do not change any file.' };

    const hunks: Hunk[] = files.flatMap((f) => buildHunks(f.path, f.base, f.proposed, f.baseHash));

    try {
      const violations = await symbolCheck(files, this.index ?? EMPTY_INDEX, { hunks });
      if (violations.length > 0) return { deny: `${violations.join('; ')} — define or import it, then propose again.` };
      if (run.mode === 'inline' && run.selection) scopeGuard(hunks, run.selection);
    } catch (err) {
      log('guards failed (ignored):', errText(err));
    }

    const proposal: Proposal = { summary: args.summary, key, runId: run.id, toolCallId, threadId, files, hunks, status: 'reviewing' };
    await this.attachProposal(run, proposal);
    return 'reviewing';
  }

  async attachProposal(run: Run, proposal: Proposal): Promise<void> {
    if (this.pending || this.attaching) throw new Error('Finish the active review before opening another.');
    this.attaching = true;
    try {
      await this.persistDecision?.(proposal, run);
      const { key, files } = proposal;
      this.proposals.set(key, proposal);
      this.runs.set(key, run);
      const resolve = run.origin === 'external' ? undefined : this.onResolve;
      this.resolvers.set(key, once(resolve));
      this.pendingKey = key;
      for (const f of files) {
        this.docs.set(docUri(BASE_SCHEME, key, f.path).toString(), f.base);
        this.docs.set(docUri(PROPOSED_SCHEME, key, f.path).toString(), f.proposed);
      }
      this.onProposal?.(proposal);
      this.codeLensChanged.fire();

      try {
        const first = files[0];
        if ((run.mode === 'inline' || run.origin === 'external') && first.baseHash !== 'new') {
          const doc = await vscode.workspace.openTextDocument(resolveWorkspaceUri(first.path));
          const hunk = proposal.hunks.find(h => h.path === first.path);
          const line = Math.max(0, (hunk?.oldStart ?? 1) - 1);
          await vscode.window.showTextDocument(doc, { preview: false, selection: new vscode.Range(line, 0, line, 0) });
        } else {
          for (const [i, f] of files.entries()) await this.openDiff(key, f.path, i > 0);
        }
      } catch (error) {
        log('Could not open review in editor', errText(error));
      }
      this.refreshDecorations();
    } finally {
      this.attaching = false;
    }
  }

  async openDiff(key: Sha, path: string, preserveFocus = false): Promise<void> {
    const proposal = this.pending;
    if (proposal?.key !== key || !proposal.files.some(f => f.path === path)) return;
    await vscode.commands.executeCommand(
      'vscode.diff',
      docUri(BASE_SCHEME, key, path),
      docUri(PROPOSED_SCHEME, key, path),
      `${path} · Contexo review`,
      { preview: false, preserveFocus },
    );
  }

  externalStatus(key: Sha) {
    const proposal = this.proposals.get(key);
    if (!proposal || this.runs.get(key)?.origin !== 'external') return undefined;
    return {
      reviewId: key,
      status: proposal.status,
      files: proposal.files.map(f => f.path),
      applied: proposal.result?.applied,
      rejected: proposal.result?.rejected,
    };
  }

  private proposalFile(doc: vscode.TextDocument) {
    const proposal = this.pending;
    const root = workspaceRoot()?.uri;
    if (!proposal || !root || doc.uri.scheme !== root.scheme) return undefined;
    return proposal.files.find(file => file.baseHash !== 'new' &&
      vscode.Uri.joinPath(root, ...file.path.split('/')).toString() === doc.uri.toString());
  }

  private sourceLine(doc: vscode.TextDocument, hunk: Hunk): number {
    const changed = hunk.lines.findIndex(line => /^[+-]/.test(line));
    return Math.max(0, Math.min(hunk.oldStart - 1 + Math.max(0, changed), doc.lineCount - 1));
  }

  private updateDecisions(proposal: Proposal, change: (hunks: Hunk[]) => boolean): Promise<void> {
    const operation = this.decisionUpdates.then(async () => {
      if (this.pending !== proposal || this.applying) return;
      const hunks = structuredClone(proposal.hunks);
      if (!change(hunks)) return;
      try {
        await this.persistDecision?.({ ...proposal, hunks }, this.runs.get(proposal.key)!);
        this.failedDecision = undefined;
      } catch (error) {
        this.failedDecision = proposal.key;
        throw error;
      }
      if (this.pending !== proposal) return;
      proposal.hunks = hunks;
      this.codeLensChanged.fire();
      this.refreshDecorations();
    });
    this.decisionUpdates = operation.catch(() => undefined);
    return operation;
  }

  async setDecision(hunkId: string, d: 'accepted' | 'rejected'): Promise<void> {
    const proposal = this.pending;
    if (proposal) await this.updateDecisions(proposal, hunks => setHunkDecision(hunks, hunkId, d));
  }

  async acceptAll(key: Sha): Promise<void> {
    const proposal = this.pending;
    if (proposal?.key !== key) return;
    await this.updateDecisions(proposal, hunks => {
      setAllDecisions(hunks, 'accepted');
      return true;
    });
  }

  private applying = false;
  get isApplying() { return this.applying; }

  async recoverApply(): Promise<void> {
    const saved = this.storage?.get<{ root?: string; proposal?: Proposal; runId: string; hunks: Proposal['hunks']; files: Array<{ path: string; base: string; target: string; diskBase?: string }> }>('review.apply.v1');
    if (!saved || this.applying) return;
    const root = workspaceRoot()?.uri;
    if (!root || (saved.root && saved.root !== root.toString())) {
      throw new Error('Open the original workspace to recover this apply.');
    }
    this.applying = true;
    try {
      const pending = new Map<string, string>();
      const expected = new Map<string, string>();
      for (const file of saved.files) {
        const text = await readLive(file.path, root);
        const disk = await readDisk(resolveWorkspaceUri(file.path, root));
        if (text === file.target && disk === file.target) continue;
        const liveHash = text === undefined ? 'new' : sha256(text);
        const diskHash = disk === undefined ? 'new' : sha256(disk);
        if ((text !== file.target && liveHash !== file.base) ||
            (disk !== file.target && diskHash !== (file.diskBase ?? file.base))) {
          throw new Error('Recovery paused because the file changed: ' + file.path);
        }
        pending.set(file.path, file.target);
        expected.set(file.path, liveHash);
      }
      if (workspaceRoot()?.uri.toString() !== root.toString()) throw new Error('The workspace changed during recovery.');
      if (pending.size) await this.undo.applyFiles(pending, expected);
      const known = new Set(this.undo.list().filter(h => h.runId === saved.runId).map(h => h.hunkId));
      await this.undo.recordApplied(saved.runId, saved.hunks.filter(h => !known.has(h.id)));
      if (saved.proposal) {
        const applied = this.proposals.get(saved.proposal.key) ?? saved.proposal;
        this.finish(applied, 'applied', computeResult(applied.hunks));
        await this.flushEvidence?.();
      }
      await this.storage?.update('review.apply.v1', undefined);
    } finally {
      this.applying = false;
    }
  }

  async applyAccepted(key: Sha): Promise<void> {
    await this.decisionUpdates;
    if (this.failedDecision === key) throw new Error('Save the review decisions before applying this proposal.');
    const p = this.proposals.get(key);
    if (!p || p.status !== 'reviewing') return;
    if (acceptedCount(p.hunks) === 0) {
      this.rejectAll(key);
      return;
    }
    if (this.applying) return;
    if (this.storage?.get('review.apply.v1')) throw new Error('Recover the interrupted apply before applying another proposal.');
    this.applying = true;
    const resolve = this.resolvers.get(key)!;
    const run = this.runs.get(key)!;
    const root = workspaceRoot()?.uri;
    try {
      await this.validateApply?.(p);
    } catch (error) {
      this.applying = false;
      throw error;
    }
    try {
      if (p.status !== 'reviewing' || this.pending !== p) return;
      for (const f of p.files) {
        const live = await readLive(f.path, root);
        const ok = f.baseHash === 'new' ? live === undefined : live !== undefined && sha256(live) === f.baseHash;
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
      const files = await Promise.all(p.files.filter(file => out.has(file.path)).map(async file => {
        const disk = await readDisk(resolveWorkspaceUri(file.path, root));
        return { path: file.path, base: file.baseHash, diskBase: disk === undefined ? 'new' : sha256(disk),
          target: out.get(file.path)! };
      }));
      if (!root || workspaceRoot()?.uri.toString() !== root.toString()) throw new Error('The workspace changed before apply.');
      await this.storage?.update('review.apply.v1', {
        root: root.toString(),
        proposal: structuredClone(p),
        runId: run.id, hunks: p.hunks.filter(h => h.decision === 'accepted'), files,
      });
      if (p.status !== 'reviewing' || this.pending !== p) {
        await this.storage?.update('review.apply.v1', undefined);
        return;
      }
      if (workspaceRoot()?.uri.toString() !== root.toString()) throw new Error('The workspace changed before apply.');
      await this.undo.applyFiles(out, new Map(p.files.map(file => [file.path, file.baseHash])));
      await this.undo.recordApplied(run.id, p.hunks.filter((h) => h.decision === 'accepted'));
      this.finish(p, 'applied', computeResult(p.hunks));
      await this.flushEvidence?.();
      await this.storage?.update('review.apply.v1', undefined);
    } catch (err) {
      log('applyAccepted failed', errText(err));
      if (this.storage?.get('review.apply.v1')) {
        this.finish(p, 'interrupted');
        void vscode.window.showErrorMessage('Contexo could not finish applying the reviewed files. Recover the interrupted apply from the command palette.');
      } else {
        this.finish(p, 'rejected', { applied: [], rejected: p.hunks.map((h) => h.id) });
        resolve(false, `APPLY_FAILED: ${errText(err)}`);
      }
      return;
    } finally {
      this.applying = false;
    }
    resolve(true);
    const applied = p.hunks.find(hunk => hunk.decision === 'accepted');
    if (applied) {
      try {
        const doc = await vscode.workspace.openTextDocument(resolveWorkspaceUri(applied.path));
        const line = Math.max(0, Math.min(applied.newStart - 1, doc.lineCount - 1));
        await vscode.window.showTextDocument(doc, { preview: false, selection: new vscode.Range(line, 0, line, 0) });
      } catch (error) {
        log('Could not focus applied file', errText(error));
      }
    }
  }

  rejectAll(key: Sha): void {
    const p = this.proposals.get(key);
    if (!p || p.status !== 'reviewing') return;
    setAllDecisions(p.hunks, 'rejected');
    this.finish(p, 'rejected', computeResult(p.hunks));
    this.resolvers.get(key)?.(false, 'user rejected all hunks');
  }

  finalize(key: Sha, runId?: string): Result | { error: string } {
    const proposal = this.proposals.get(key);
    const r = !runId || proposal?.runId === runId ? proposal?.result : undefined;
    return r ? { applied: [...r.applied], rejected: [...r.rejected] } : { error: 'UNKNOWN_PROPOSAL' };
  }

  finalizeLatest(): Result | { error: string } {
    return this.latest ? { applied: [...this.latest.applied], rejected: [...this.latest.rejected] } : { error: 'UNKNOWN_PROPOSAL' };
  }

  discardPending(): void {
    const p = this.pending;
    if (!p) return;
    p.status = 'discarded';
    this.onProposal?.(p);
    this.pendingKey = undefined;
    void this.closeDiffs(p.key);
    this.dropDocs(p);
    this.codeLensChanged.fire();
    this.refreshDecorations();
  }

  /** Common end-of-review bookkeeping (the resolver call is made by the caller). */
  private finish(p: Proposal, status: Proposal['status'], result?: Result): void {
    p.status = status;
    p.result = result;
    this.onProposal?.(p);
    if (result) this.latest = result;
    if (this.pendingKey === p.key) this.pendingKey = undefined;
    void this.closeDiffs(p.key);
    this.dropDocs(p);
    this.codeLensChanged.fire();
    this.refreshDecorations();
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

  /** Red background on the proposed-side lines of hunks outside the inline selection (visible diff editors only). */
  refreshDecorations(editors: readonly vscode.TextEditor[] = vscode.window.visibleTextEditors): void {
    try {
      this.outsideDeco ??= vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: new vscode.ThemeColor('diffEditor.removedLineBackground'),
        overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.errorForeground'),
        overviewRulerLane: vscode.OverviewRulerLane.Right,
      });
      this.sourceDeco ??= vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
      });
      for (const ed of editors) {
        if (ed.document.uri.scheme !== PROPOSED_SCHEME) {
          const file = this.proposalFile(ed.document);
          const hunks = file && sha256(ed.document.getText()) === file.baseHash
            ? this.pending!.hunks.filter(h => h.path === file.path && h.decision !== 'rejected') : [];
          ed.setDecorations(this.sourceDeco, hunks.map(hunk => {
            const line = this.sourceLine(ed.document, hunk);
            const preview = new vscode.MarkdownString();
            preview.appendCodeblock(hunk.lines.join('\n'), 'diff');
            return { range: new vscode.Range(line, 0, line, 0), hoverMessage: preview };
          }));
          continue;
        }
        const m = /^\/([0-9a-f]+)\/(.+)$/.exec(ed.document.uri.path);
        const p = m ? this.proposals.get(m[1]) : undefined;
        const ranges: vscode.Range[] = [];
        if (m && p && p.status === 'reviewing') {
          for (const h of p.hunks) {
            if (h.path !== m[2] || !h.outsideSelection) continue;
            const [a, b] = hunkSpan(h);
            ranges.push(new vscode.Range(a - 1, 0, b - 1, 0));
          }
        }
        ed.setDecorations(this.outsideDeco, ranges);
      }
    } catch (err) {
      log('refreshDecorations failed', errText(err));
    }
  }

  dispose(): void {
    this.outsideDeco?.dispose();
    this.sourceDeco?.dispose();
    this.outsideDeco = undefined;
    this.sourceDeco = undefined;
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const source = doc.uri.scheme !== PROPOSED_SCHEME;
    const m = source ? null : /^\/([0-9a-f]+)\/(.+)$/.exec(doc.uri.path);
    const file = source ? this.proposalFile(doc) : undefined;
    const p = source ? this.pending : m ? this.proposals.get(m[1]) : undefined;
    const path = source ? file?.path : m?.[2];
    if (!path || !p || p.status !== 'reviewing') return [];
    const top = new vscode.Range(0, 0, 0, 0);
    const diff = new vscode.CodeLens(top, { title: 'Contexo: Open full diff', command: 'contexo.proposal.openDiff', arguments: [p.key, path] });
    if (file && sha256(doc.getText()) !== file.baseHash) return [diff];
    const lenses: vscode.CodeLens[] = [
      new vscode.CodeLens(top, { title: `Apply accepted (${acceptedCount(p.hunks)})`, command: 'contexo.proposal.apply', arguments: [p.key] }),
      new vscode.CodeLens(top, { title: 'Accept all', command: 'contexo.proposal.acceptAll', arguments: [p.key] }),
      new vscode.CodeLens(top, { title: 'Reject all', command: 'contexo.proposal.rejectAll', arguments: [p.key] }),
    ];
    if (source) lenses.push(diff);
    for (const h of p.hunks.filter((x) => x.path === path)) {
      const line = source ? this.sourceLine(doc, h) : Math.max(0, Math.min(h.newStart - 1, Math.max(0, doc.lineCount - 1)));
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
      if (h.outsideSelection) {
        const [a, b] = hunkSpan(h);
        lenses.push(new vscode.CodeLens(r, { title: `⚠ outside selection (L${a}-${b})`, command: '' }));
      }
    }
    return lenses;
  }
}

export function registerReview(ctx: vscode.ExtensionContext, post: (m: ToWebview) => void): ReviewEngine {
  const review = new ReviewEngine(post, ctx.workspaceState);

  ctx.subscriptions.push(vscode.commands.registerCommand('contexo.recoverApply', () => review.recoverApply()));
  if (ctx.workspaceState.get('review.apply.v1')) {
    void vscode.window.showWarningMessage('Contexo found an interrupted apply.', 'Recover').then(choice => {
      if (choice) void vscode.commands.executeCommand('contexo.recoverApply');
    });
  }
  const provider: vscode.TextDocumentContentProvider = {
    provideTextDocumentContent: (uri) => review.docs.get(uri.toString()) ?? '',
  };
  const lens: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: review.codeLensChanged.event,
    provideCodeLenses: (doc) => review.provideCodeLenses(doc),
  };

  ctx.subscriptions.push(
    review.codeLensChanged,
    { dispose: () => review.dispose() },
    vscode.window.onDidChangeVisibleTextEditors((eds) => review.refreshDecorations(eds)),
    vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, provider),
    vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, provider),
    vscode.languages.registerCodeLensProvider({ scheme: PROPOSED_SCHEME }, lens),
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, lens),
    vscode.languages.registerCodeLensProvider({ scheme: 'vscode-remote' }, lens),
    vscode.workspace.onDidChangeTextDocument(({ document }) => {
      if (!review.pending) return;
      if (!vscode.window.visibleTextEditors.some(editor => editor.document === document)) return;
      review.codeLensChanged.fire();
      review.refreshDecorations();
    }),
    vscode.commands.registerCommand('contexo.proposal.openDiff', (key: string, path: string) => review.openDiff(key, path)),
    vscode.commands.registerCommand('contexo.undoHunk', async (hunkId?: string) => {
      const id = hunkId ?? (await pickHunk(review.undo, 'undo'));
      if (id) await review.undo.undoHunk(id);
    }),
    vscode.commands.registerCommand('contexo.redoHunk', async (hunkId?: string) => {
      const id = hunkId ?? (await pickHunk(review.undo, 'redo'));
      if (id) await review.undo.redoHunk(id);
    }),
    vscode.commands.registerCommand('contexo.hunk.decide', (key?: string, hunkId?: string, d?: 'accepted' | 'rejected') => {
      if (key && hunkId && d && review.pending?.key === key) return review.setDecision(hunkId, d);
    }),
    vscode.commands.registerCommand('contexo.proposal.apply', async (key?: string) => {
      if (key) await review.applyAccepted(key);
    }),
    vscode.commands.registerCommand('contexo.proposal.rejectAll', (key?: string) => {
      if (key) review.rejectAll(key);
    }),
    vscode.commands.registerCommand('contexo.proposal.acceptAll', (key?: string) => {
      if (key) return review.acceptAll(key);
    }),
  );
  return review;
}
