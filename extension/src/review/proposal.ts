/**
 * review/proposal.ts - C4 pure proposal logic (no vscode APIs, easily unit tested).
 *
 * Exports:
 *  - proposalKey(args): sha256 of canonical JSON of propose_write args (links approval and MCP call).
 *  - sha256(text): hash helper (baseHash).
 *  - applyEditExact(base, oldText, newText): replace oldText exactly once; errors
 *    OLD_TEXT_NOT_FOUND (0 matches) or AMBIGUOUS (>1); creation when oldText '' and baseHash 'new'.
 *  - buildHunks(path, base, proposed, baseHash): jsdiff structuredPatch (3 context lines) -> Hunk[]
 *    with id = first 12 of sha(path + baseHash + hunk lines).
 *  - rebuildFromAccepted(base, hunks): apply only accepted hunks to base.
 *
 * Rules: never touches disk or the editor.
 * Depends on: diff (jsdiff), types. Depended on by: review/diffView, review/applyUndo, test/proposal.test.ts.
 */
export {};
