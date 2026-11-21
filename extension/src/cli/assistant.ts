import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stderr, stdout } from 'node:process';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { fileContextInput, fileContextReader } from '../context/fileContext';
import { assembleContext, prepareContextForModel } from '../context/assembler';
import { loadWorkspaceIndex } from './index';
import { RunRoutes } from '../mcp/runRoutes';
import { startServer } from '../mcp/server';
import { runCommandIn } from '../mcp/runCommand';
import { RunManager, type RunReview } from '../run/runManager';
import { createTfClient } from '../run/tfClient';
import { contextReceipt, continuation, continuationInput } from '../run/continuation';
import { RunJournal } from '../run/journal';
import { computeResult, proposalKey, sha256 } from '../review/proposal';
import type { ContexoConfig } from '../config';
import type { Proposal, Selection, UiStreamEvent } from '../types';
import { applyReviewed, edits, search, stage, workspaceText } from './workspace';

export async function assist(root: string, text: string, url: string, selection?: Selection, candidateCheck = false) {
  const cfg: ContexoConfig = { trueforgeUrl: url, primaryAgent: process.env.CONTEXO_AGENT || 'contexo',
    fallbackAgent: process.env.CONTEXO_FALLBACK_AGENT || 'contexo-fallback', excerptBudget: 8000,
    firstEventTimeoutMs: 120000, commandAllowlist: ['python', 'pytest', 'flask'], mcpPort: 0,
    devMode: false, autoStartTrueForge: false, autoRegisterTrueForge: false, stopTrueForgeOnExit: 'never', primaryModel: '', fallbackModel: '' };
  const routes = new RunRoutes();
  const index = await loadWorkspaceIndex(root);
  const journal = new RunJournal(resolve(process.env.CONTEXO_RUNS_DIR || join(homedir(), '.contexo', 'runs')), error => console.error('Run journal:', error));
  const terminal = createInterface({ input: stdin, output: stderr });
  const answer = async (question: string) => Boolean(stdin.isTTY && (await terminal.question(question + ' [y/N] ')).trim().toLowerCase() === 'y');
  let pending: Proposal | undefined;
  let command: string | undefined;
  let runs: RunManager;
  const review: RunReview = {
    get pending() { return pending; },
    async beginProposal(run, call, thread, args) {
      pending = await stage(root, run, call, thread, args);
      if (!pending.hunks.length) { pending = undefined; return { deny: 'NO_CHANGE: the edit leaves the file unchanged.' }; }
      journal.record(run.id, { kind: 'proposal', proposal: structuredClone(pending), bases: pending.files.map(f => ({ path: f.path, hash: f.baseHash })) });
      return 'reviewing';
    },
    async attachProposal(_run, proposal) { pending = proposal; },
    discardPending() { pending = undefined; command = undefined; },
  };
  const server = await startServer({ port: 0, token: randomBytes(32).toString('hex'), lookupRoute: id => routes.get(id),
    registerTools(mcp, route) {
      const active = () => !!route && routes.get(route.connector) === route && runs.active === route.run &&
        !!route.sessionId && route.run.sessionId === route.sessionId && route.run.state === 'streaming';
      function tool<S extends z.ZodRawShape>(name: string, description: string, inputSchema: S, fn: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>) {
        // A raw Zod object preserves MCP input validation as well as inferred argument types.
        mcp.registerTool(name, { description, inputSchema: z.object(inputSchema) }, async (args: unknown) => {
          if (!active()) throw new Error('Inactive run route');
          const value = await fn(z.object(inputSchema).parse(args));
          return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }] };
        });
      }
      tool('read_file', 'Read workspace text and its baseHash. Line numbers are one-based.', { path: z.string(), startLine: z.number().int().positive().optional(), endLine: z.number().int().positive().optional() }, async a => {
        const content = await workspaceText(root, a.path);
        if (content === undefined) throw new Error('File does not exist');
        const lines = content.split('\n');
        return { path: a.path, hash: sha256(content), totalLines: lines.length, text: lines.slice((a.startLine ?? 1) - 1, a.endLine).join('\n').slice(0, 16000) };
      });
      tool('search_workspace', 'Search source files for literal text.', { query: z.string().min(1), limit: z.number().int().min(1).max(30).default(20) }, a => search(root, [a.query], a.limit));
      tool('assemble_context', 'Rank context excerpts and explicit @file or @symbol mentions under a token budget.', {
        request: z.string(), mentions: z.array(z.string()).optional(), budget: z.number().int().min(500).max(32000).optional(),
      }, async a => {
        const packet = await assembleContext({ ...a, selection: route!.run.selection, runId: route!.run.id, rg: async term =>
        (await search(root, [term], 40)).flatMap(line => {
          const m = /^(.+?):(\d+):(.*)$/.exec(line);
          return m ? [{ path: m[1], line: Number(m[2]), preview: m[3] }] : [];
        }) }, index);
        await fileContextReader(root, index).addToPacket(packet, a.mentions);
        const result = prepareContextForModel(packet);
        runs.recordContext(route!.run, contextReceipt(packet, result));
        return result.text;
      });
      tool('resume_context', 'Recover saved goal, source pointers, review decisions and checks after a long turn. Use the returned proposal key to page through files.',
        continuationInput, async args => {
          const records = await journal.continuationRecords(route!.run.id);
          if (!active()) throw new Error('Inactive run route');
          return continuation(route!.run, records, args, pending);
        });
      tool('file_context', 'Inspect current and previous versions of a relevant workspace file. With version, read an exact historical range.',
        fileContextInput, async args => fileContextReader(root, index).inspect(args));
      tool('list_symbols', 'List indexed functions, classes, methods and documentation.', {
        path: z.string().optional(), query: z.string().optional(),
      }, async a => (a.path ? index.inFile(a.path) : index.symbols()).filter(s => !a.query ||
        s.qualifiedName.toLowerCase().includes(a.query.toLowerCase())).slice(0, 200)
        .map(s => ({ path: s.path, name: s.qualifiedName, startLine: s.startLine, endLine: s.endLine })));
      tool('propose_write', 'Stage exact edits for human hunk review. Supply the read_file hash as baseHash, or new for a new file.', edits.shape, async args => {
        const p = pending;
        if (!p || p.key !== proposalKey(args) || !p.hunks.some(h => h.decision === 'accepted')) throw new Error('No matching reviewed edits.');
        pending = undefined;
        if (candidateCheck) {
          const { checkCandidate } = await import('../review/candidateCheck');
          try {
            await checkCandidate(root, p);
            journal.record(p.runId, { kind: 'check', source: 'local pytest', name: 'Candidate tests', status: 'passed', proposalKey: p.key,
              hunkIds: p.hunks.filter(h => h.decision === 'accepted').map(h => h.id) });
          } catch (error) {
            journal.record(p.runId, { kind: 'check', source: 'local pytest', name: 'Candidate tests', status: 'failed', proposalKey: p.key });
            throw error;
          }
        }
        await applyReviewed(root, p, active);
        p.status = 'applied';
        p.result = computeResult(p.hunks);
        journal.record(p.runId, { kind: 'proposal', proposal: p, bases: p.files.map(f => ({ path: f.path, hash: f.baseHash })) });
        for (const file of p.files) await index.reindexFile(file.path);
        return p.result;
      });
      tool('run_command', 'Run an approved pytest, flask, or python command.', { argv: z.array(z.string()).min(1), timeoutSec: z.number().int().positive().max(180).optional() }, async a => {
        if (command !== JSON.stringify(a.argv)) throw new Error('No matching command approval.');
        command = undefined;
        return runCommandIn(root, cfg.commandAllowlist, a.argv, a.timeoutSec);
      });
    } });
  const tf = createTfClient(cfg, { routes, port: server.port });
  runs = new RunManager({ cfg, tf, review, record: journal.record, askCommandApproval: async argv => {
    const yes = await answer('Run ' + JSON.stringify(argv) + '?');
    command = yes ? JSON.stringify(argv) : undefined;
    return yes;
  } });
  const stop = () => { terminal.close(); void runs.stop(); };
  process.once('SIGINT', stop);
  terminal.on('SIGINT', stop);
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  runs.on('session', s => stderr.write('Session ' + s.url + '\n'));
  runs.on('stream', (events: UiStreamEvent[]) => {
    for (const event of events) {
      if (event.kind === 'text-delta') stdout.write(event.text);
      else stderr.write(JSON.stringify(event) + '\n');
    }
  });
  runs.on('state', s => {
    if (s.banner) stderr.write(s.banner + '\n');
    if (['cancelled', 'done', 'failed'].includes(s.state)) finish();
    if (s.state === 'awaiting-review' && pending) {
      const p = pending;
      void (async () => {
        for (const h of p.hunks) {
          stderr.write(JSON.stringify(h.path) + ' @ ' + h.oldStart + '\n' + h.lines.map(line => line.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '�')).join('\n') + '\n');
          h.decision = await answer('Accept this hunk?') ? 'accepted' : 'rejected';
        }
        if (pending !== p) return;
        const allow = p.hunks.some(h => h.decision === 'accepted');
        if (!allow) pending = undefined;
        await runs.resolveApproval(allow, allow ? undefined : 'No hunks accepted');
      })().catch(error => { console.error(error.message); stop(); });
    }
  });
  try {
    await runs.start(selection ? 'inline' : 'agent', text, selection);
    await finished;
    stdout.write('\n');
    if (runs.active?.state !== 'done') process.exitCode = runs.active?.state === 'cancelled' ? 130 : 1;
  } finally {
    process.removeListener('SIGINT', stop);
    terminal.close();
    await server.stop();
    await tf.releaseRoute?.();
    await journal.close();
  }
}
