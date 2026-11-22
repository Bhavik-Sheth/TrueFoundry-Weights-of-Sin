/**
 * types.ts - shared data models (PRD_Lite section 8). Types only, no runtime code.
 *
 * Exports (types): Sha, Selection, Run, SymbolEntry, Reason, Excerpt, ContextPacket, FileEdit,
 * Hunk, Proposal, AppliedHunk, ProposeArgs, TfEvent, UiStreamEvent, RunStateMsg, and the bridge
 * message unions ToHost / ToWebview (section 9.5).
 *
 * Notes: Selection lines are 0-based inclusive and paths are workspace-relative POSIX.
 * FileEdit with oldText '' and baseHash 'new' means file creation. Proposal.key links the
 * TrueForge approval to the later MCP propose_write call.
 * Must not import 'vscode'.
 * Depends on: nothing.
 * Depended on by: virtually every file (the webview imports types via a relative path).
 */

export type Sha = string; // sha256 hex

export interface Selection {
  path: string;
  startLine: number;
  endLine: number;
  docVersion: number;
  hash: Sha;
  text: string;
}

export interface Run {
  id: string;
  mode: 'inline' | 'agent';
  origin?: 'external';
  workspaceUri?: string;
  request: string;
  selection?: Selection;
  sessionId: string;
  agent: 'contexo' | 'contexo-fallback';
  state: 'streaming' | 'awaiting-review' | 'done' | 'cancelled' | 'failed';
  sealedSessions: string[];
}

export interface SymbolEntry {
  id: string;
  path: string;
  name: string;
  qualifiedName: string;
  kind: 'class' | 'function' | 'method' | 'test' | 'doc';
  startLine: number;
  endLine: number;
  decorators: string[];
  calls: string[];
  boundCalls?: Array<{ spelling: string; module: string; name: string }>;
  imports: string[];
  text: string;
}

export type Reason =
  | { kind: 'mention'; token: string }
  | { kind: 'selection' }
  | { kind: 'semantic'; rank: number }
  | { kind: 'lexical' | 'source-preview' | 'feature-path'; term: string; rank: number }
  | { kind: 'symbol-name'; term: string; rank: number }
  | { kind: 'calls' | 'called-by' | 'registers' | 'tests' | 'documents'; from: string };

export interface Excerpt {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  category: 'impl' | 'test' | 'docs';
  tokens: number;
  score: number;
  reasons: Reason[];
  priority?: boolean;
  readRange?: { startLine: number; endLine: number };
  text: string;
}

export interface FileChange {
  status: 'unchanged' | 'added' | 'deleted' | 'modified' | 'missing' | 'unavailable';
  detail?: string;
  added?: number;
  removed?: number;
  hunkCount?: number;
  hunks?: Array<{ oldStart: number; oldLines: number; newStart: number; newLines: number;
    symbols: string[]; lines?: string[]; truncated?: boolean }>;
}

export interface FileContext {
  path: string;
  reasons: Reason[];
  symbols: Array<{ name: string; kind: SymbolEntry['kind']; start: number; end: number }>;
  symbolCount: number;
  openingLines?: Array<{ line: number; text: string }>;
  source: 'working tree' | 'editor buffer';
  workingStatus: 'text' | 'missing' | 'binary' | 'too_large' | 'unavailable';
  head?: string;
  lastCommit?: { commit: string; parent?: string; previousPath?: string; date: string; subject: string; message?: string };
  changes?: FileChange;
  previousChanges?: FileChange;
}

export interface ContextDelivery {
  excerptIds: string[];
  excerptTokens: number;
  shortenedExcerptIds?: string[];
  packetTokens?: number;
  serializedCharacters: number;
  characterLimit: number;
  omittedExcerpts: number;
  omittedReasons: number;
  filePaths?: string[];
  omittedFiles?: number;
}

export interface ContextPacket {
  id: string;
  runId: string;
  query: string;
  budget: number;
  used: number;
  delivery?: ContextDelivery;
  files?: FileContext[];
  excerpts: Excerpt[];
  omitted: Array<{
    path: string;
    startLine: number;
    endLine: number;
    reason: 'duplicate' | 'lower-rank' | 'over-budget';
    tokens: number;
  }>;
  graph: {
    nodes: Array<{ id: string; label: string; type: 'request' | 'term' | 'file' | 'symbol' }>;
    edges: Array<{ from: string; to: string; label: string; inferred: boolean }>;
  };
}

export interface FileEdit {
  path: string;
  baseHash: Sha;
  oldText?: string;
  startLine?: number;
  endLine?: number;
  newText: string;
}

export interface Hunk {
  id: string;
  path: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
  outsideSelection: boolean;
  decision: 'pending' | 'accepted' | 'rejected';
  historyConcern?: { sha: string; subject: string; concern: string; issues: string[]; acknowledgement?: string; read?: boolean };
}

export interface Proposal {
  summary?: string;
  key: Sha;
  runId: string;
  toolCallId: string;
  threadId: string;
  files: Array<{ path: string; base: string; proposed: string; baseHash: Sha }>;
  hunks: Hunk[];
  status: 'reviewing' | 'applied' | 'rejected' | 'stale' | 'discarded' | 'interrupted';
  result?: { applied: string[]; rejected: string[] };
}

export interface AppliedHunk {
  workspaceUri?: string;
  hunkId: string;
  path: string;
  runId: string;
  patch: string;
  appliedAt: number;
  undone: boolean;
}

export interface ProposeArgs {
  summary: string;
  edits: FileEdit[];
  acknowledgedHistory?: Array<{ commit: string; reason: string }>;
}

export interface TfEvent {
  type: string;
  id?: string;
  [k: string]: unknown;
}

export type UiStreamEvent =
  | { kind: 'text-delta'; text: string; threadId?: string }
  | { kind: 'tool-call'; toolCallId: string; name: string; args?: unknown; deferred?: boolean; threadId?: string }
  | { kind: 'tool-result'; toolCallId: string; name?: string; summary: string }
  | { kind: 'approval'; toolCallId: string; name: string; status: 'pending' | 'allowed' | 'denied'; reason?: string }
  | { kind: 'turn-done'; status: string; error?: string }
  | { kind: 'info'; text: string }
  | { kind: 'action'; action: 'regenerate'; path: string; label: string };

export interface RunStateMsg {
  state: Run['state'] | 'idle';
  agent?: string;
  hunks?: number;
  banner?: string;
}

export type ToHost =
  | { type: 'ready' }
  | { type: 'reviewAction'; action: 'workbench' | 'check' | 'restore' | 'sync' | 'replay' | 'import' }
  | { type: 'stop' }
  | { type: 'send'; text: string }
  | { type: 'regenerate'; path: string }
  | { type: 'openSource'; path: string; line: number }
  | { type: 'undo'; hunkId: string }
  | { type: 'redo'; hunkId: string }
  | { type: 'setupRefresh' }
  | { type: 'startTrueForge' }
  | { type: 'stopTrueForge' }
  | { type: 'openTrueForge' }
  | { type: 'sessionLoad'; sessionIds?: string[] }
  | { type: 'simulateFailure'; on: boolean }
  | { type: 'saveProvider'; providerType: string; key: string; name?: string; baseUrl?: string; modelIds?: string[] }
  | { type: 'setModels'; primary: string; fallback: string }
  | { type: 'register' }
  | { type: 'updateSetting'; key: SettingKey; value: string | number | boolean | string[] };

export type ToWebview =
  | { type: 'session'; sessionId: string; agent: string; url: string }
  | ({ type: 'runState' } & RunStateMsg)
  | { type: 'stream'; events: UiStreamEvent[] }
  | { type: 'packet'; packet: ContextPacket }
  | { type: 'changes'; hunks: AppliedHunk[] }
  | { type: 'setup'; status: SetupStatus; catalog: CatalogProviderView[]; settings: SettingsView }
  | { type: 'setupResult'; op: string; ok: boolean; message: string; steps?: SetupStep[] }
  | { type: 'showSetup' }
  | { type: 'sessionView'; sessions: SessionView[]; recent: SessionSummary[]; selected: string[]; error?: string };

export type SettingKey = 'excerptBudget' | 'firstEventTimeoutMs' | 'commandAllowlist' | 'autoStartTrueForge' | 'devMode';

export interface SetupStatus {
  trueforge: 'starting' | 'running' | 'down' | 'node-missing';
  detail?: string;
  providersConfigured: string[];
  models: string[];
  primaryModel?: string;
  fallbackModel?: string;
  connectorOk: boolean;
  agentsOk: boolean;
  mcpOk: boolean;
  indexReady: boolean;
}

export interface CatalogProviderView {
  type: string;
  custom: boolean;
}

export interface SettingsView {
  excerptBudget: number;
  firstEventTimeoutMs: number;
  commandAllowlist: string[];
  autoStartTrueForge: boolean;
  devMode: boolean;
  trueforgeUrl: string;
  /** True while the primary agent is deliberately pointed at a broken model ("Test resilience"). */
  simulatedFailure: boolean;
}

export interface SetupStep {
  label: string;
  ok: boolean;
  detail?: string;
}

/** One row of the Session tab's picker (sessions.list). */
export interface SessionSummary {
  id: string;
  agent: string;
  title?: string;
  createdAt: string;
  status?: string;
}

/** Ordered, display-ready timeline entry of one TrueForge turn (built by run/timeline.ts). */
export type TimelineEntry =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'model'; id: string; threadId: string; text: string; model?: string; finishReason?: string; inputTokens?: number; outputTokens?: number }
  | { kind: 'tool'; toolCallId: string; threadId: string; name: string; server?: string; deferred: boolean; args?: unknown; result?: string }
  | { kind: 'approval'; toolCallId: string; threadId: string; name: string; status: 'requested' | 'allowed' | 'denied'; reason?: string }
  | { kind: 'thread'; threadId: string; parentThreadId?: string; parentToolCallId?: string; title: string; agent?: string; model?: string; status: 'running' | 'done' | 'error'; error?: string }
  | { kind: 'turn-done'; status: string; error?: string; reason?: string }
  | { kind: 'info'; text: string };

export interface TurnView {
  id: string;
  status: string;
  createdAt: string;
  completedAt?: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  error?: string;
  entries: TimelineEntry[];
}

export interface SessionView {
  id: string;
  agent: string;
  model?: string;
  title?: string;
  createdAt: string;
  /** 'primary' / 'fallback' when the agent name matches the configured agents. */
  role: 'primary' | 'fallback' | 'other';
  /** Set by the host: this session was sealed by Stop or by a fallback takeover. */
  sealed: boolean;
  turns: TurnView[];
}
