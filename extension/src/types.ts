/**
 * types.ts - shared data models (PRD_Lite section 8). Types only, no runtime code.
 *
 * Exports (types): Sha, Selection, Run, SymbolEntry, Reason, Excerpt, ContextPacket, FileEdit,
 * Hunk, Proposal, AppliedHunk, and the bridge message unions ToHost / ToWebview (section 9.5).
 *
 * Notes: Selection lines are 0-based inclusive and paths are workspace-relative POSIX.
 * FileEdit with oldText '' and baseHash 'new' means file creation. Proposal.key links the
 * TrueForge approval to the later MCP propose_write call.
 * Depends on: nothing.
 * Depended on by: virtually every file (the webview imports types via a relative path).
 */
export {};
