/**
 * mcp/tools.ts - C3 zod schemas and handlers for the 6 editor tools (PRD_Lite 9.3).
 *
 * Exports:
 *  - ToolDeps { index, review, runs, post }.
 *  - makeToolRegistrar(deps): (server: McpServer) => void; registers the 6 tools on each new
 *    (stateless, per-request) McpServer instance: search_workspace {query,glob?,limit<=30};
 *    read_file {path,startLine?,endLine?}; assemble_context {request,mentions?,budget?} (also pushes
 *    the packet to the panel); list_symbols {path?,query?} (deferred in the agent def);
 *    propose_write {summary,edits[]} (approval-gated); run_command {argv,timeoutSec<=180}
 *    (deferred, approval).
 *
 * STATE (Slice 2): search_workspace, read_file, list_symbols, propose_write are real; assemble_context is
 * still fixture-based (Slice 5) but awaits index.ready; run_command refuses ("not implemented in base").
 * propose_write returns review.finalize(proposalKey(args)), falling back to review.finalizeLatest(). Every handler first checks runs.isToolCallAllowed() -> error RUN_NOT_AUTHORIZED.
 * Tool results are MCP text content (JSON.stringify).
 *
 * Rules: tool descriptions tell the agent to call assemble_context before editing and to use
 * read_file hashes as baseHash. propose_write never writes by itself.
 * Depends on: zod, @modelcontextprotocol/sdk, context/indexer, review/diffView, run/runManager, dev/fixtures.
 * Depended on by: extension.
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IndexApi } from '../context/indexer';
import type { ReviewEngine } from '../review/diffView';
import type { RunManager } from '../run/runManager';
import type { ToWebview } from '../types';
import { samplePacket } from '../dev/fixtures';
import { capOutput, resolveInWorkspace } from './server';
import { sha256, proposalKey } from '../review/proposal';
import { ripgrepSearch, symbolNameMatch, tokenize } from '../context/search';

export interface ToolDeps { index: IndexApi; review: ReviewEngine; runs: RunManager; post: (m: ToWebview) => void }

interface ToolResult { [k: string]: unknown; content: Array<{ type: 'text'; text: string }>; isError?: boolean }

const ok = (v: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });
interface Hit { path: string; line: number; preview: string; source: 'ripgrep' | 'symbol'; symbol?: string }

/** Open (possibly dirty) editor text for an absolute path, else undefined. */
function openDocText(abs: string): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const vs = require('vscode') as typeof import('vscode');
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const doc = vs.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && norm(d.uri.fsPath) === norm(abs));
  return doc?.getText();
}

const toRel = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');

const err = (code: string, message: string): ToolResult => ({
  isError: true,
  content: [{ type: 'text', text: JSON.stringify({ error: code, message }) }],
});

export function makeToolRegistrar(deps: ToolDeps): (s: McpServer) => void {
  /** Wraps a handler with the Stop/authorization check. */
  const guarded = <A>(fn: (args: A) => ToolResult | Promise<ToolResult>) => async (args: A): Promise<ToolResult> => {
    if (!deps.runs.isToolCallAllowed()) return err('RUN_NOT_AUTHORIZED', 'The run was stopped by the user. Do not call more tools.');
    try {
      return await fn(args);
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
        'Read a workspace file (or a line range, 1-based inclusive) and return {path, text, hash, totalLines, truncated}. ' +
        'The `hash` is the baseHash you MUST pass in propose_write edits for this file. Reads the unsaved editor buffer if the file is open. ' +
        'Output is capped; request a smaller line range if truncated.',
      inputSchema: {
        path: z.string().min(1).describe('Workspace-relative path, e.g. "src/flask/cli.py"'),
        startLine: z.number().int().min(1).optional().describe('First line, 1-based'),
        endLine: z.number().int().min(1).optional().describe('Last line, 1-based, inclusive'),
      },
    }, guarded(async (a: { path: string; startLine?: number; endLine?: number }) => {
      const abs = resolveInWorkspace(a.path);
      let full = openDocText(abs);
      if (full === undefined) {
        try {
          full = await readFile(abs, 'utf8');
        } catch {
          return err('FILE_NOT_FOUND', `Cannot read ${a.path}`);
        }
      }
      const lines = full.split(/\r?\n/);
      if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
      const totalLines = lines.length;
      let text = full;
      if (a.startLine !== undefined || a.endLine !== undefined) {
        const s = Math.max(1, a.startLine ?? 1);
        const e = Math.min(totalLines, a.endLine ?? totalLines);
        text = s > e ? '' : lines.slice(s - 1, e).join('\n');
      }
      const capped = capOutput(text);
      return ok({ path: toRel(a.path), text: capped.text, hash: sha256(full), totalLines, truncated: capped.truncated });
    }));

    server.registerTool('assemble_context', {
      description:
        'CALL THIS FIRST before editing. Given the user request, returns a token-budgeted context packet: ranked code, test and doc ' +
        'excerpts with path:lines headers and the reason each was selected, plus what was omitted. Pass @mentions (paths or symbols) ' +
        'the user wrote in `mentions`. After it, use read_file for the exact text you will edit.',
      inputSchema: {
        request: z.string().min(1).describe("The user's request, verbatim or condensed"),
        mentions: z.array(z.string()).optional().describe('Explicit @mentions: file paths or symbol names'),
        budget: z.number().int().min(500).max(32000).optional().describe('Token budget for excerpts (default from settings)'),
      },
    }, guarded(async () => {
      await deps.index.ready;
      deps.post({ type: 'packet', packet: samplePacket });
      const { graph: _graph, ...forModel } = samplePacket;
      void _graph;
      return ok(forModel);
    }));

    server.registerTool('list_symbols', {
      description:
        'Cheap structure lookup: list classes, functions, methods and tests as [{id, kind, path, lines}], optionally for one file `path` ' +
        'or filtered by a name substring `query`. Use it to verify that a function exists before calling or editing it.',
      inputSchema: {
        path: z.string().optional().describe('Workspace-relative file to list symbols for'),
        query: z.string().optional().describe('Case-insensitive name substring'),
      },
    }, guarded((a: { path?: string; query?: string }) => {
      const q = a.query?.toLowerCase();
      let syms = deps.index.symbols();
      if (a.path) {
        resolveInWorkspace(a.path); // path guard
        syms = deps.index.inFile(toRel(a.path));
      }
      if (q) syms = syms.filter((s) => s.name.toLowerCase().includes(q) || s.qualifiedName.toLowerCase().includes(q));
      return ok(syms.slice(0, 200).map((s) => ({ id: s.id, kind: s.kind, path: s.path, lines: [s.startLine, s.endLine] })));
    }));

    server.registerTool('propose_write', {
      description:
        'Propose edits for the user to review (requires user approval; nothing is written until they accept hunks). ' +
        'Each edit is {path, baseHash, oldText, newText}: baseHash is the `hash` from read_file for that file; oldText must be copied ' +
        'EXACTLY from the file and match exactly once (include enough surrounding lines to be unique); use oldText "" with baseHash "new" ' +
        'to create a file. Batch related edits (code, tests, docs) in one call. Returns {applied, rejected, files}. ' +
        'On errors STALE_BASE / OLD_TEXT_NOT_FOUND / AMBIGUOUS_MATCH / MISSING_SYMBOL, re-read the file and retry with corrected edits.',
      inputSchema: {
        summary: z.string().min(1).describe('One-sentence description of the change'),
        edits: z.array(z.object({
          path: z.string().min(1).describe('Workspace-relative path'),
          baseHash: z.string().min(1).describe('hash from read_file for this path, or "new" for a new file'),
          oldText: z.string().describe('Exact existing text to replace (must match once); "" to create a file'),
          newText: z.string().describe('Replacement text'),
        })).min(1).describe('Edits to stage'),
      },
    }, guarded((args: unknown) => {
      const r = deps.review.finalize(proposalKey(args));
      const out = 'error' in r ? deps.review.finalizeLatest() : r;
      return ok(out);
    }));

    server.registerTool('run_command', {
      description:
        'Run an allowlisted command (argv array, no shell; e.g. ["pytest","tests/test_cli.py"]) in the workspace root and return ' +
        '{exitCode, stdout, stderr, truncated}. Requires user approval. Use it to run tests after your edits have been applied.',
      inputSchema: {
        argv: z.array(z.string()).min(1).describe('Command and arguments, e.g. ["pytest","-q"]'),
        timeoutSec: z.number().int().min(1).max(180).optional().describe('Timeout in seconds (default 60, max 180)'),
      },
    }, guarded(() => err('NOT_IMPLEMENTED', 'run_command is not implemented in base')));
  };
}
