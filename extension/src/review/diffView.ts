/**
 * review/diffView.ts - C4 review orchestration and VS Code UI.
 *
 * S0 status: STUB engine. beginProposal denies ('not implemented in base'); finalize returns empty result;
 * discardPending is a no-op. REAL in S0: the contexo-base / contexo-proposed content providers
 * (in-memory docs via ReviewEngine.setDoc), command registration and the engine/UndoStack wiring.
 * Slice 3 fills beginProposal/applyAccepted/CodeLens; Slice 6 adds decorations.
 *
 * Exports:
 *  - class ReviewEngine:
 *    - setDoc(uri, text): register content for a contexo-base: / contexo-proposed: document.
 *    - beginProposal(run, toolCallId, threadId, args): key; per edit check live text hash vs baseHash
 *      (auto-deny STALE_BASE path (current hash ...)); exact-match oldText (OLD_TEXT_NOT_FOUND /
 *      AMBIGUOUS_MATCH); build hunks; symbolCheck (auto-deny MISSING_SYMBOL name @ file:line); for inline
 *      runs scopeGuard; register virtual docs; open vscode.diff per file; refresh CodeLens; status
 *      "awaiting review".
 *    - setDecision(hunkId, decision): CodeLens accept/reject per hunk.
 *    - applyAccepted(key): re-verify base hash (stale -> deny), rebuildFromAccepted per file, apply
 *      via UndoStack.applyFiles, record undo, store result, onResolve(true).
 *    - rejectAll(key): onResolve(false, 'user rejected all hunks').
 *    - finalize(key): returns stored {applied, rejected}; unknown key -> error, writes nothing.
 *    - discardPending(): close diffs, drop proposal (used by Stop); nothing written.
 *    - onResolve?: callback set by RunManager.
 *    - undo: the UndoStack.
 *  - registerReview(ctx, post): registers providers, CodeLens stub and commands contexo.undoHunk,
 *    contexo.redoHunk, contexo.hunk.decide, contexo.proposal.apply, contexo.proposal.rejectAll.
 *
 * Rules: nothing reaches disk until Apply accepted.
 * Depends on: review/proposal, review/guards, review/applyUndo, types, log. Depended on by: run/runManager, mcp/tools, extension.
 */
import * as vscode from 'vscode';
import type { ProposeArgs, Run, Sha, ToWebview } from '../types';
import { log } from '../log';
import { UndoStack } from './applyUndo';

export const BASE_SCHEME = 'contexo-base';
export const PROPOSED_SCHEME = 'contexo-proposed';

export class ReviewEngine {
  readonly docs = new Map<string, string>();
  readonly undo: UndoStack;
  readonly codeLensChanged = new vscode.EventEmitter<void>();
  onResolve?: (allow: boolean, reason?: string) => void;

  constructor(post: (m: ToWebview) => void = () => {}) {
    this.undo = new UndoStack(post);
  }

  setDoc(uri: string, text: string): void {
    this.docs.set(vscode.Uri.parse(uri).toString(), text);
    this.codeLensChanged.fire();
  }

  async beginProposal(
    run: Run,
    toolCallId: string,
    threadId: string,
    args: ProposeArgs,
  ): Promise<'reviewing' | { deny: string }> {
    log('[stub] beginProposal', run.id, toolCallId, threadId, args.edits.length);
    return { deny: 'not implemented in base' };
  }

  setDecision(hunkId: string, d: 'accepted' | 'rejected'): void {
    log('[stub] setDecision', hunkId, d);
  }

  async applyAccepted(key: Sha): Promise<void> {
    log('[stub] applyAccepted', key);
  }

  rejectAll(key: Sha): void {
    log('[stub] rejectAll', key);
  }

  finalize(key: Sha): { applied: string[]; rejected: string[] } | { error: string } {
    log('[stub] finalize', key);
    return { applied: [], rejected: [] };
  }

  discardPending(): void {
    /* no-op in base */
  }
}

export function registerReview(ctx: vscode.ExtensionContext, post: (m: ToWebview) => void): ReviewEngine {
  const review = new ReviewEngine(post);

  const provider: vscode.TextDocumentContentProvider = {
    provideTextDocumentContent: (uri) => review.docs.get(uri.toString()) ?? '',
  };
  const lens: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: review.codeLensChanged.event,
    provideCodeLenses: () => [],
  };

  ctx.subscriptions.push(
    review.codeLensChanged,
    vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, provider),
    vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, provider),
    vscode.languages.registerCodeLensProvider({ scheme: PROPOSED_SCHEME }, lens),
    vscode.commands.registerCommand('contexo.undoHunk', async (hunkId?: string) => {
      log('[stub] contexo.undoHunk', hunkId);
      if (hunkId) await review.undo.undoHunk(hunkId);
    }),
    vscode.commands.registerCommand('contexo.redoHunk', async (hunkId?: string) => {
      log('[stub] contexo.redoHunk', hunkId);
      if (hunkId) await review.undo.redoHunk(hunkId);
    }),
    vscode.commands.registerCommand('contexo.hunk.decide', (hunkId?: string, d?: 'accepted' | 'rejected') => {
      log('[stub] contexo.hunk.decide', hunkId, d);
      if (hunkId && d) review.setDecision(hunkId, d);
    }),
    vscode.commands.registerCommand('contexo.proposal.apply', async (key?: string) => {
      log('[stub] contexo.proposal.apply', key);
      if (key) await review.applyAccepted(key);
    }),
    vscode.commands.registerCommand('contexo.proposal.rejectAll', (key?: string) => {
      log('[stub] contexo.proposal.rejectAll', key);
      if (key) review.rejectAll(key);
    }),
  );
  return review;
}
