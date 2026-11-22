/**
 * mcp/tools.ts - C3 zod schemas and handlers for the 6 editor tools (PRD_Lite 9.3).
 *
 * Exports:
 *  - ToolDeps { index, review, runs, post }.
 *  - makeToolRegistrar(deps): (server: McpServer) => void; registers workspace tools on each new
 *    (stateless, per-request) McpServer instance: search_workspace {query,glob?,limit<=30};
 *    read_file {path,startLine?,endLine?}; assemble_context {request,mentions?,budget?} (also pushes
 *    the packet to the panel); list_symbols {path?,query?} (deferred in the agent def);
 *    propose_write {summary,edits[]} (approval-gated); run_command {argv,timeoutSec<=180}
 *    (deferred, approval); why_exists {path,startLine,endLine} (deferred; blame/commit rationale, <=4000 chars).; read_symbol {name} (deferred; one function/class by name, <=16000 chars).; get_instruction_pack {name} (deferred; versioned how-to guide from dist/instruction-packs).
 *
 * STATE (Slice 2): search_workspace, read_file, list_symbols, propose_write are real; assemble_context is
 * still fixture-based (Slice 5) but awaits index.ready; run_command is real (Slice 7).
 * propose_write returns review.finalize(proposalKey(args)), falling back to review.finalizeLatest(). Every handler first checks runs.isToolCallAllowed() -> error RUN_NOT_AUTHORIZED.
 * Tool results are MCP text content (JSON.stringify).
 *
 * Rules: tool descriptions tell the agent to call assemble_context before editing and to use
 * read_file hashes as baseHash. propose_write never writes by itself.
 * Depends on: zod, @modelcontextprotocol/sdk, context/indexer, review/diffView, run/runManager, dev/fixtures.
 * Depended on by: extension.
 */
import { workspaceRoot, hasNativeFiles } from '../shell/workspaceRoot';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IndexApi } from '../context/indexer';
import type { ReviewEngine } from '../review/diffView';
import type { RunManager } from '../run/runManager';
import type { ProposeArgs, Selection, ToWebview } from '../types';
import { previewSelection } from '../context/tokens';
import { sourceWindow } from '../context/sourceWindow';
import { resolveSymbol } from '../context/readSymbol';
import { cachedPacks } from '../context/instructionPacks';
import { fileContextInput, fileContextReader } from '../context/fileContext';
import { capWhyExists, explainRange } from '../history/historyGuard';
import { assembleContext, prepareContextForModel } from '../context/assembler';
import { contextReceipt, continuation, continuationInput } from '../run/continuation';
import { batchPlanInput, type BatchPlans } from '../run/batchPlan';
import type { RunJournal } from '../run/journal';
import type { RunRoute } from './runRoutes';
import { assertNativeWorkspacePath, resolveInWorkspace } from './server';
import { runCommand } from './runCommand';
import { proposalInput } from '../review/editBatch';
import { proposalKey } from '../review/proposal';
import { ripgrepSearch, symbolNameMatch, tokenize } from '../context/search';

export interface ToolDeps { index: IndexApi; review: ReviewEngine; runs: RunManager; journal?: RunJournal; batchesFor?: (workspace?: string) => BatchPlans | undefined; post: (m: ToWebview) => void }

export interface ExternalAgentTools {
  workspace(): string;
  selection(): Selection | undefined;
  stage(args: ProposeArgs, requestId?: string): Promise<unknown>;
  status(reviewId: string): unknown;
}

interface ToolResult { [k: string]: unknown; content: Array<{ type: 'text'; text: string }>; isError?: boolean }

const ok = (v: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });
interface Hit { path: string; line: number; preview: string; source: 'ripgrep' | 'symbol'; symbol?: string }

/** Open (possibly dirty) editor text for an absolute path, else undefined. */
function openDocText(abs: string): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const vs = require('vscode') as typeof import('vscode');
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const doc = vs.workspace.textDocuments.find((d) => hasNativeFiles(d.uri) && norm(d.uri.fsPath) === norm(abs));
  return doc?.getText();
}

const toRel = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');

const err = (code: string, message: string): ToolResult => ({
  isError: true,
  content: [{ type: 'text', text: JSON.stringify({ error: code, message }) }],
});

export function makeToolRegistrar(deps: ToolDeps, options: { requireRoute?: boolean; route?: RunRoute; external?: ExternalAgentTools } = {}): (s: McpServer) => void {
  const external = options.external;
  const fileContext = () => {
    const folder = workspaceRoot();
    const root = external?.workspace() ?? folder?.uri.fsPath;
    return root ? fileContextReader(root, deps.index, openDocText) : undefined;
  };
  const resolvePath = (relative: string) => {
    const root = workspaceRoot()?.uri;
    return external ? assertNativeWorkspacePath(external.workspace(), relative)
      : root && hasNativeFiles(root) ? assertNativeWorkspacePath(root.fsPath, relative)
        : Promise.resolve(resolveInWorkspace(relative));
  };
  /** Live text: the open editor buffer if any, else disk; undefined when unreadable. */
  const readLiveText = async (relPath: string): Promise<string | undefined> => {
    const abs = await resolvePath(relPath);
    const open = openDocText(abs);
    if (open !== undefined) return open;
    try { return await readFile(abs, 'utf8'); } catch { return undefined; }
  };
  /** Wraps a handler with the Stop/authorization check. */
  const guarded = <A>(fn: (args: A) => ToolResult | Promise<ToolResult>) => async (args: A): Promise<ToolResult> => {
    const run = deps.runs.active;
    const route = options.route;
    if (options.requireRoute && (!route || run !== route.run || !route.sessionId || run.sessionId !== route.sessionId ||
      run.sealedSessions.includes(route.sessionId) || !['streaming', 'awaiting-review'].includes(run.state))) {
      return err('RUN_NOT_AUTHORIZED', 'This connection does not own the active run.');
    }
    if (!external && !deps.runs.isToolCallAllowed()) return err('RUN_NOT_AUTHORIZED', 'The run was stopped by the user. Do not call more tools.');
    try {
      const root = workspaceRoot()?.uri;
      if (!external && (!root || !hasNativeFiles(root))) return err('NO_WORKSPACE', 'Open a native workspace folder.');
      if (route?.run.workspaceUri) {
        if (workspaceRoot()?.uri.toString() !== route.run.workspaceUri) {
          return err('WORKSPACE_CHANGED', 'This run is bound to its original workspace.');
        }
      }
      external?.workspace();
      const result = await fn(args);
      if (route && (deps.runs.active !== run || route.run.sessionId !== route.sessionId ||
          route.run.state === 'cancelled' || (route.run.workspaceUri && root?.toString() !== workspaceRoot()?.uri.toString()))) {
        return err('RUN_NOT_AUTHORIZED', 'This connection lost its workspace or run.');
      }
      return result;
    } catch (e) {
      return err('TOOL_ERROR', String((e as Error)?.message ?? e));
    }
  };

  return (server: McpServer) => {
    server.registerTool('search_workspace', {
      description:
        'Search the workspace for code and docs by keyword or regex (ripgrep) plus symbol names. ' +
        'Returns up to `limit` hits as [{path, line, preview, source}]. Use it to locate files, then read_file to see them. ' +
        'Paths are workspace-relative.',
      inputSchema: {
        query: z.string().min(1).describe('Text, identifier or regex to search for'),
        glob: z.string().optional().describe('Optional file glob, e.g. "src/**/*.py"'),
        limit: z.number().int().min(1).max(30).optional().describe('Max hits (default 20, max 30)'),
      },
    }, guarded(async (a: { query: string; glob?: string; limit?: number }) => {
      await deps.index.ready;
      const limit = a.limit ?? 20;
      const rg = await ripgrepSearch(a.query, { glob: a.glob, max: limit * 2 });
      const hits: Hit[] = rg.map((h) => ({
        path: h.path, line: h.line, preview: h.preview, source: 'ripgrep',
        symbol: deps.index.enclosing(h.path, h.line)?.qualifiedName,
      }));
      const terms = [...new Set([a.query.trim(), ...tokenize(a.query)])].filter(Boolean);
      const matches = a.glob ? [] : symbolNameMatch(terms, deps.index.symbols().filter((s) => s.kind !== 'doc')).slice(0, limit);
      const toHit = (m: (typeof matches)[number]): Hit => ({
        path: m.symbol.path, line: m.symbol.startLine, preview: `${m.symbol.kind} ${m.symbol.qualifiedName}`,
        source: 'symbol', symbol: m.symbol.qualifiedName,
      });
      const strong = matches.filter((m) => m.score >= 2).map(toHit);
      const weak = matches.filter((m) => m.score < 2).map(toHit);
      const seen = new Set<string>();
      const out: Hit[] = [];
      for (const h of [...strong, ...hits, ...weak]) {
        const k = `${h.path}:${h.line}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(h);
        if (out.length >= limit) break;
      }
      return ok(out);
    }));

    server.registerTool('read_file', {
      description:
        'Read a workspace file (or a line range, 1-based inclusive) and return current text, hash, line coordinates, truncation, and rangeWritable. ' +
        'The `hash` is the baseHash you MUST pass in propose_write edits for this file. Reads the unsaved editor buffer if the file is open. ' +
        'Specify up to 24 lines; rangeWritable indicates the exact returned coordinates can be used in a proposal.',
      inputSchema: {
        path: z.string().min(1).describe('Workspace-relative path, e.g. "src/flask/cli.py"'),
        startLine: z.number().int().min(1).optional().describe('First line, 1-based'),
        endLine: z.number().int().min(1).optional().describe('Last line, 1-based, inclusive'),
      },
    }, guarded(async (a: { path: string; startLine?: number; endLine?: number }) => {
      const full = await readLiveText(a.path);
      if (full === undefined) return err('FILE_NOT_FOUND', `Cannot read ${a.path}`);
      return ok(sourceWindow(toRel(a.path), full, a.startLine, a.endLine));
    }));

    server.registerTool('read_symbol', {
      description:
        'Read one Python function/class by name (e.g. "FlaskGroup.get_command"). Returns its exact lines and the file hash to use as baseHash. ' +
        'Ambiguous names return candidates.',
      inputSchema: { name: z.string().min(1).describe('Symbol name, qualified name, or module-qualified name') },
    }, guarded(async (a: { name: string }) => {
      await deps.index.ready;
      const found = resolveSymbol(deps.index, a.name);
      if (!('symbol' in found)) return ok(found);
      const { symbol } = found;
      const full = await readLiveText(symbol.path);
      if (full === undefined) return err('FILE_NOT_FOUND', `Cannot read ${symbol.path}`);
      return ok({ ...sourceWindow(symbol.path, full, symbol.startLine, symbol.endLine), symbol: symbol.qualifiedName });
    }));

    server.registerTool('get_instruction_pack', {
      description: 'Load a short procedural guide (python-editing, pytest-testing or rst-docs). Call before writing that kind of change.',
      inputSchema: { name: z.string().min(1).describe('Pack name: python-editing, pytest-testing or rst-docs') },
    }, guarded(async (a: { name: string }) => {
      const packs = await cachedPacks(path.join(__dirname, 'instruction-packs'));
      const pack = packs.find(p => p.name === a.name);
      if (!pack) return err('UNKNOWN_PACK', packs.map(p => p.name + ' — ' + p.when).join('\n'));
      deps.runs.recordContext(options.route?.run, { kind: 'instruction-pack', name: pack.name, version: pack.version });
      return ok({ name: pack.name, version: pack.version, body: pack.body });
    }));

    server.registerTool('assemble_context', {
      description:
        'CALL THIS FIRST before editing. Given the user request, returns a token-budgeted context packet: ranked code, test and doc ' +
        'excerpts with path:lines headers and the reason each was selected, plus what was omitted. Pass @mentions (paths or symbols) ' +
        'the user wrote in `mentions`. After it, use read_file for the exact text you will edit.',
      inputSchema: {
        request: z.string().min(1).describe("The user's request, verbatim or condensed"),
        mentions: z.array(z.string()).optional().describe('Explicit @mentions: file paths or symbol names'),
        useEditorSelection: z.boolean().optional().describe('Anchor the packet to the current VS Code selection'),
        budget: z.number().int().min(500).max(32000).optional().describe('Token budget for excerpts (default from settings)'),
      },
    }, guarded(async (a: { request: string; mentions?: string[]; budget?: number; useEditorSelection?: boolean }) => {
      await deps.index.ready;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const cfg = (require('../config') as typeof import('../config')).getConfig();
      const packet = await assembleContext({
        request: a.request,
        mentions: a.mentions,
        selection: external && a.useEditorSelection ? external.selection() : options.route?.run.selection,
        budget: a.budget ?? cfg.excerptBudget,
        runId: external ? 'editor-agent' : options.route?.run.id ?? deps.runs.active?.id ?? 'adhoc',
      }, deps.index);
      await fileContext()?.addToPacket(packet, a.mentions);
      const result = prepareContextForModel(packet);
      const { text, delivery } = result;
      packet.delivery = delivery;
      deps.runs.recordContext(options.route?.run, contextReceipt(packet, result));
      deps.post({ type: 'packet', packet });
      return { content: [{ type: 'text', text }] };
    }));

    const journal = deps.journal;
    if (!external && journal) {
      const run = options.route?.run;
      const batches = deps.batchesFor?.(run?.workspaceUri);
      if (run && batches) {
        server.registerTool('batch_plan', {
          description: 'Create, refresh or complete a dependency-ordered edit plan. Status checks live revisions and can restore a prior run in the same workspace.',
          inputSchema: batchPlanInput,
        }, guarded(async (args: Parameters<BatchPlans['act']>[1]) => {
          const session = run.sessionId;
          const active = () => deps.runs.active === run && run.sessionId === session && run.state === 'streaming';
          return ok(await batches.act(run, args, active));
        }));
      }
      server.registerTool('resume_context', {
        description: 'Recover the current goal, last delivered source ranges, proposal decisions and check statuses after context compaction. ' +
          'Paginate proposal files using the returned key and offset. Reread exact source before editing.',
        inputSchema: continuationInput,
      }, guarded(async (args: Parameters<typeof continuation>[2]) => {
        const run = options.route?.run;
        if (!run) return err('NO_ACTIVE_RUN', 'No routed run.');
        const session = run.sessionId;
        const records = await journal.continuationRecords(run.id);
        if (deps.runs.active !== run || run.sessionId !== session || run.state !== 'streaming') {
          return err('RUN_NOT_AUTHORIZED', 'The run no longer owns this session.');
        }
        return ok(continuation(run, records, args, deps.review.pending));
      }));
    }

    server.registerTool('file_context', {
      description: 'Inspect a workspace file’s indexed structure, working/editor changes against Git HEAD, ' +
        'latest file commit and bounded before/after hunks. With version=head or previous, read exact historical line ranges. ' +
        'The previous version is the first parent of the last commit that changed this file. Commit messages provide the author’s recorded rationale.',
      inputSchema: fileContextInput,
    }, guarded(async (args: Parameters<ReturnType<typeof fileContextReader>['inspect']>[0]) => {
      const reader = fileContext();
      return reader ? ok(await reader.inspect(args)) : err('NO_WORKSPACE', 'Open a workspace folder.');
    }));

    server.registerTool('why_exists', {
      description: 'Explain why existing lines exist: blame commits, messages, linked issues/PRs and related tests. ' +
        'Call before deleting or rewriting code you did not write.',
      inputSchema: {
        path: z.string().describe('Workspace-relative file path'),
        startLine: z.number().int().min(1),
        endLine: z.number().int().min(1),
      },
    }, guarded(async (a: { path: string; startLine: number; endLine: number }) => {
      await resolvePath(a.path);
      const root = external?.workspace() ?? workspaceRoot()!.uri.fsPath;
      return ok(capWhyExists(await explainRange(root, toRel(a.path), a.startLine, a.endLine, deps.index)));
    }));

    server.registerTool('list_symbols', {
      description:
        'Cheap structure lookup: list classes, functions, methods and tests as [{id, kind, path, lines}], optionally for one file `path` ' +
        'or filtered by a name substring `query`. Use it to verify that a function exists before calling or editing it.',
      inputSchema: {
        path: z.string().optional().describe('Workspace-relative file to list symbols for'),
        query: z.string().optional().describe('Case-insensitive name substring'),
      },
    }, guarded(async (a: { path?: string; query?: string }) => {
      const q = a.query?.toLowerCase();
      let syms = deps.index.symbols();
      if (a.path) {
        await resolvePath(a.path);
        syms = deps.index.inFile(toRel(a.path));
      }
      if (q) syms = syms.filter((s) => s.name.toLowerCase().includes(q) || s.qualifiedName.toLowerCase().includes(q));
      return ok(syms.slice(0, 200).map((s) => ({ id: s.id, kind: s.kind, path: s.path, lines: [s.startLine, s.endLine] })));
    }));

    if (external) {
      server.registerTool('editor_selection', {
        description: 'Read the current VS Code selection, including workspace-relative path, source text and file hash.',
        inputSchema: {},
      }, guarded(() => {
        const selection = external.selection();
        return ok(selection ? { ...selection, ...previewSelection(selection.text) } : { selection: null });
      }));

      server.registerTool('review_status', {
        description: 'Read the status of an editor proposal using the review ID returned by propose_write.',
        inputSchema: { reviewId: z.string().regex(/^[0-9a-f]{64}$/) },
      }, guarded((args: { reviewId: string }) => {
        const result = external.status(args.reviewId);
        return result ? ok(result) : err('UNKNOWN_REVIEW', 'No matching editor review is available.');
      }));
    }

    server.registerTool('propose_write', {
      description: 'Stage changes for native hunk review. Prefer edit ranges using {path, baseHash, startLine, endLine, newText}. ' +
        'Read the same range and hash first. Supply only the replacement. Existing exact oldText and file creation forms are supported.',
      inputSchema: {
        ...(external ? { requestId: z.string().min(1).max(120).optional()
          .describe('Client identifier for retrying the same proposal payload') } : {}),
        ...proposalInput.shape,
      },
    }, guarded(async (args: ProposeArgs & { requestId?: string }) => {
      const { requestId, ...proposal } = args;
      if (external) return ok(await external.stage(proposal, requestId));
      const key = proposalKey(args);
      const result = deps.review.finalize(key, options.route?.run.id);
      return ok({ ...result, proposalKey: key });
    }));

    if (external) return;

    server.registerTool('run_command', {
      description:
        'Run an allowlisted command (argv array, no shell; e.g. ["pytest","tests/test_cli.py"]) in the workspace root and return ' +
        '{exitCode, stdout, stderr, truncated, durationMs}. Requires user approval. Use it to run tests after your edits have been applied.',
      inputSchema: {
        argv: z.array(z.string()).min(1).describe('Command and arguments, e.g. ["pytest","-q"]'),
        timeoutSec: z.number().int().min(1).max(180).optional().describe('Timeout in seconds (default 120, max 180)'),
      },
    }, guarded(async (a: { argv: string[]; timeoutSec?: number }) => {
      const run = options.route?.run;
      const session = run?.sessionId;
      const batches = deps.batchesFor?.(run?.workspaceUri);
      const execute = () => runCommand(a.argv, a.timeoutSec, run?.id);
      const r = run && batches ? await batches.verify(run, a.argv, execute, () =>
        deps.runs.active === run && run.sessionId === session && run.state === 'streaming') : await execute();
      if (r.exitCode === 126) return err('COMMAND_REFUSED', r.stderr);
      return ok(r);
    }));
  };
}
