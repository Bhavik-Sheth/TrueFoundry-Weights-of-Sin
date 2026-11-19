# Slice 0 contract (shared by the three parallel S0 agents)

All three agents work in the same worktree at the same time. **Edit only the files you own.** If you need a change in someone else's file, do not make it. List it under "Requests for other owners" in your final report.

Plan: [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) § Slice 0. Spec: [PRD_Lite.md](PRD_Lite.md). The existing header comments in each file describe intent; keep them and update them if behaviour changes.

## File ownership

| Owner | Files (paths relative to `extension/` unless noted) |
|---|---|
| **A (S0a shell/build)** | `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.webview.json`, `esbuild.mjs`, `vite.config.ts`, `vitest.config.ts`, `.vscode/*`, `.vscodeignore`, `.gitignore`, `LICENSE.upstream`, `src/extension.ts`, `src/config.ts`, `src/log.ts`, `src/shell/panel.ts`, `src/shell/statusBar.ts`, `webview/index.html`, `webview/src/main.tsx`, `webview/src/App.tsx`, `webview/src/bridge.ts`, root `UPSTREAMS.md`, root `scripts/check-no-provider.mjs` |
| **B (S0b TrueForge/MCP)** | `src/run/tfClient.ts`, `src/run/runManager.ts`, `src/mcp/server.ts`, `src/mcp/tools.ts`, `trueforge/*`, `test/mcpServer.test.ts`, root `docs/spike-notes.md` |
| **C (S0c stubs/fixtures)** | `src/types.ts`, `src/dev/fixtures.ts`, `src/dev/devCommands.ts`, `src/context/*`, `src/review/*`, `src/shell/inlineEdit.ts`, `src/run/fallback.ts`, `src/mcp/runCommand.ts`, `webview/src/ChatTab.tsx`, `webview/src/ContextTab.tsx`, `webview/src/ContextGraph.tsx`, `webview/src/ChangesTab.tsx`, `test/assembler.test.ts`, `test/proposal.test.ts`, `test/guards.test.ts`, root `scripts/setup-flask.ps1`, `scripts/setup-flask.sh`, `scripts/demo-app.py` |

**Only A runs `npm install`.** B and C must not run npm install or edit package.json. If they need a package that isn't in the list below, they request it in their report.

Packages A installs (exact versions, `--save-exact`):
- **deps:** `@truefoundry/trueforge-sdk`, `@truefoundry/trueforge-ui`, `@modelcontextprotocol/sdk`, `zod`, `diff`, `web-tree-sitter`, `tree-sitter-python` (0.25.0, ships the grammar wasm), `js-tiktoken`, `tree-kill`, `react`, `react-dom`, `@xyflow/react`.
- **dev:** `typescript`, `esbuild`, `vite`, `@vitejs/plugin-react`, `vitest`, `@types/vscode@1.90.0`, `@types/node`, `@types/react`, `@types/react-dom`, `@types/diff` (only if `diff` lacks types), `@vscode/vsce`.

## Shared exports (signatures are fixed; implement them exactly)

### A: `src/log.ts`, `src/config.ts`, `src/shell/*`
```ts
// log.ts
export function log(...args: unknown[]): void;          // writes to OutputChannel "Contexo" (created lazily)
export function getOutput(): import('vscode').OutputChannel;
// config.ts
export interface ContexoConfig { trueforgeUrl: string; primaryAgent: string; fallbackAgent: string; excerptBudget: number; firstEventTimeoutMs: number; commandAllowlist: string[]; mcpPort: number; devMode: boolean }
export function getConfig(): ContexoConfig;
// shell/panel.ts
export class ContexoPanelProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'contexo.panel';
  constructor(ctx: vscode.ExtensionContext);
  post(msg: ToWebview): void;                            // queued until the view resolves; stream messages batched ≤50ms
  onMessage(cb: (m: ToHost) => void): vscode.Disposable;
}
// shell/statusBar.ts
export class StatusBar implements vscode.Disposable { update(s: RunStateMsg): void; dispose(): void }
```

### B: `src/run/*` (except fallback), `src/mcp/server.ts`, `src/mcp/tools.ts`
```ts
// run/tfClient.ts
export interface TfClient {
  createSession(agent: string): Promise<string>;
  streamTurn(sessionId: string, content: string, signal?: AbortSignal): AsyncIterable<TfEvent>;
  approve(a: { sessionId: string; turnId: string; threadId: string; toolCallId: string; allow: boolean; reason?: string; afterEventId: string }): AsyncIterable<TfEvent>;
  cancel(sessionId: string): Promise<void>;
  sessionUrl(sessionId: string): string;
  ping(): Promise<boolean>;
}
export function createTfClient(cfg: ContexoConfig): TfClient;
// run/runManager.ts
export class RunManager extends EventEmitter {           // node:events; events: 'state'(RunStateMsg) 'stream'(UiStreamEvent[]) 'session'({sessionId, agent, url})
  constructor(deps: { tf: TfClient; review: ReviewEngine; cfg: ContexoConfig });
  active?: Run;
  start(mode: 'inline' | 'agent', text: string, selection?: Selection): Promise<void>;
  send(text: string): Promise<void>;
  stop(): Promise<void>;
  resolveApproval(allow: boolean, reason?: string): Promise<void>;
  isToolCallAllowed(): boolean;                          // false while the active run is cancelled
}
// mcp/server.ts
export interface McpHandle { port: number; url: string; stop(): Promise<void> }
export function startServer(o: { port: number; token: string; registerTools: (s: McpServer) => void }): Promise<McpHandle>;
export function getOrCreateToken(secrets: vscode.SecretStorage): Promise<string>;
export function resolveInWorkspace(p: string): string;
export function capOutput(s: string, max?: number): { text: string; truncated: boolean };
// mcp/tools.ts
export interface ToolDeps { index: IndexApi; review: ReviewEngine; runs: RunManager; post: (m: ToWebview) => void }
export function makeToolRegistrar(deps: ToolDeps): (s: McpServer) => void;   // registers the 6 tools on a server instance
```

### C: `src/types.ts`, `src/dev/*`, `src/context/*`, `src/review/*`, `src/shell/inlineEdit.ts`, `src/run/fallback.ts`, `src/mcp/runCommand.ts`
`types.ts` must export all PRD_Lite §8 models (`Sha, Selection, Run, SymbolEntry, Reason, Excerpt, ContextPacket, FileEdit, Hunk, Proposal, AppliedHunk`) plus:
```ts
export interface ProposeArgs { summary: string; edits: FileEdit[] }
export interface TfEvent { type: string; id?: string; [k: string]: unknown }
export type UiStreamEvent =
  | { kind: 'text-delta'; text: string; threadId?: string }
  | { kind: 'tool-call'; toolCallId: string; name: string; args?: unknown; deferred?: boolean; threadId?: string }
  | { kind: 'tool-result'; toolCallId: string; name?: string; summary: string }
  | { kind: 'approval'; toolCallId: string; name: string; status: 'pending' | 'allowed' | 'denied'; reason?: string }
  | { kind: 'turn-done'; status: string; error?: string }
  | { kind: 'info'; text: string };
export interface RunStateMsg { state: Run['state'] | 'idle'; agent?: string; hunks?: number; banner?: string }
export type ToHost =
  | { type: 'ready' } | { type: 'stop' } | { type: 'send'; text: string }
  | { type: 'openSource'; path: string; line: number }
  | { type: 'undo'; hunkId: string } | { type: 'redo'; hunkId: string };
export type ToWebview =
  | { type: 'session'; sessionId: string; agent: string; url: string }
  | ({ type: 'runState' } & RunStateMsg)
  | { type: 'stream'; events: UiStreamEvent[] }
  | { type: 'packet'; packet: ContextPacket }
  | { type: 'changes'; hunks: AppliedHunk[] };
```
Other C exports (stubs; signatures as in IMPLEMENTATION_PLAN S0c), with these additions:
```ts
// context/indexer.ts
export interface IndexApi { ready: Promise<void>; symbols(): SymbolEntry[]; byName(n: string): SymbolEntry[]; inFile(p: string): SymbolEntry[]; enclosing(p: string, line: number): SymbolEntry | undefined; reindexFile(p: string): Promise<void>; reindexAll(): Promise<void> }
export function startIndexing(): IndexApi;
// review/diffView.ts
export class ReviewEngine { /* plan S0c */ }
export function registerReview(ctx: vscode.ExtensionContext, post: (m: ToWebview) => void): ReviewEngine; // registers contexo-base/contexo-proposed providers, CodeLens stub, contexo.undoHunk/redoHunk commands
// shell/inlineEdit.ts
export function registerInlineEdit(ctx: vscode.ExtensionContext, runs: RunManager): void;   // registers contexo.inlineEdit
// dev/devCommands.ts
export function registerDevCommands(ctx: vscode.ExtensionContext, deps: { post: (m: ToWebview) => void; review: ReviewEngine; runs: RunManager; tf: TfClient }): void;
```
Rule: **pure modules** (`review/proposal.ts`, `context/search.ts`, `context/assembler.ts`, `context/tokens.ts`, `run/fallback.ts` classify) must not import `vscode`, so Vitest can run them. Use `import type` for types from vscode-dependent files.

## Command IDs (A declares them in package.json; the owner registers them)

| ID | Registered by |
|---|---|
| `contexo.inlineEdit` (ctrl+alt+e / cmd+alt+e, editorHasSelection) | C (`registerInlineEdit`) |
| `contexo.stop`, `contexo.copyMcpConnection`, `contexo.reindex` | A (`extension.ts`) |
| `contexo.undoHunk`, `contexo.redoHunk`, `contexo.hunk.decide`, `contexo.proposal.apply`, `contexo.proposal.rejectAll` | C (`registerReview`) |
| `contexo.dev.pingTrueForge`, `contexo.dev.sendTestTurn`, `contexo.dev.showSamplePacket`, `contexo.dev.openSampleProposal`, `contexo.dev.applySampleChange` (shown when `config.contexo.devMode`) | C (`registerDevCommands`) |

Settings: the six from PRD_Lite §9.6, plus `contexo.mcpPort` (number, 8791) and `contexo.devMode` (boolean, false).

## `extension.ts` wiring (A implements exactly this order)
```ts
const cfg = getConfig();
const panel = new ContexoPanelProvider(ctx);            // + registerWebviewViewProvider
const post = (m: ToWebview) => panel.post(m);
const status = new StatusBar();
const index = startIndexing();
const review = registerReview(ctx, post);
const tf = createTfClient(cfg);
const runs = new RunManager({ tf, review, cfg });
const token = await getOrCreateToken(ctx.secrets);
const mcp = await startServer({ port: cfg.mcpPort, token, registerTools: makeToolRegistrar({ index, review, runs, post }) });
registerInlineEdit(ctx, runs);
registerDevCommands(ctx, { post, review, runs, tf });
runs.on('state', s => { status.update(s); post({ type: 'runState', ...s }); });
runs.on('stream', events => post({ type: 'stream', events }));
runs.on('session', s => post({ type: 'session', ...s }));
panel.onMessage(m => { /* send → runs.active && runs.active.state !== 'done' ? runs.send : runs.start('agent', text); stop → runs.stop(); openSource → open + reveal; undo/redo → executeCommand('contexo.undoHunk'|'contexo.redoHunk', hunkId) */ });
// commands: contexo.stop, contexo.copyMcpConnection (clipboard: `${mcp.url}` + `X-Contexo-Token: ${token}`), contexo.reindex
```
