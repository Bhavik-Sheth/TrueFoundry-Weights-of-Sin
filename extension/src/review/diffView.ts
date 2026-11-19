/**
 * review/diffView.ts - C4 review orchestration and VS Code UI.
 *
 * Exports:
 *  - beginProposal(run, toolCallId, threadId, args): key; per edit check live text hash vs baseHash
 *    (auto-deny STALE_BASE path (current hash ...)); exact-match oldText (OLD_TEXT_NOT_FOUND /
 *    AMBIGUOUS); build hunks; symbolCheck (auto-deny MISSING_SYMBOL name @ file:line); for inline
 *    runs scopeGuard; register virtual docs; open vscode.diff per file; refresh CodeLens; status
 *    "awaiting review".
 *  - setDecision(hunkId, decision): CodeLens accept/reject per hunk.
 *  - applyAccepted(key): re-verify base hash (stale -> deny), rebuildFromAccepted per file, apply
 *    via applyUndo.applyFiles, record undo, store result, runManager.resolveApproval(allow).
 *  - rejectAll(key): resolveApproval(deny, 'user rejected all hunks').
 *  - finalize(key): returns stored {applied, rejected}; unknown key -> error, writes nothing.
 *  - discardPending(): close diffs, drop proposal (used by Stop); nothing written.
 *  - TextDocumentContentProvider for contexo-base: and contexo-proposed:; CodeLens provider
 *    (per hunk Accept/Reject, outside-selection warning in red, top "Apply accepted (n)" / "Reject all");
 *    decorations for out-of-scope hunks.
 *
 * Rules: nothing reaches disk until Apply accepted.
 * Depends on: review/proposal, review/guards, review/applyUndo, run/runManager, types.
 * Depended on by: run/runManager, mcp/tools, extension.
 */
export {};
