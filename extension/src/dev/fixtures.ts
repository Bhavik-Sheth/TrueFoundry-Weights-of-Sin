/**
 * dev/fixtures.ts - canned data for dev commands, stubs and the webview demos (S0).
 *
 * Exports:
 *  - samplePacket: ContextPacket with real Flask paths, reasons, omissions and a graph.
 *  - sampleSearchHits: canned ripgrep-style hits.
 *  - sampleProposalArgs(path, text): ProposeArgs editing two distinct lines of the given text.
 *  - sampleApplied: AppliedHunk[] for the Changes tab.
 *
 * Rules: pure (no vscode import).
 * Depends on: types, review/proposal (sha256). Depended on by: dev/devCommands, context/assembler.
 */
import type { AppliedHunk, ContextPacket, ProposeArgs } from '../types';
import { sha256 } from '../review/proposal';

export const samplePacket: ContextPacket = {
  id: 'ctx_sample',
  runId: 'run_sample',
  query: 'Add a `flask config` command that prints the app config as JSON, masking secrets',
  budget: 8000,
  used: 6400,
  excerpts: [
    {
      id: 'x1', path: 'src/flask/cli.py', startLine: 960, endLine: 1010, category: 'impl', tokens: 2100, score: 0.082,
      reasons: [
        { kind: 'lexical', term: 'command', rank: 1 },
        { kind: 'symbol-name', term: 'cli', rank: 2 },
        { kind: 'registers', from: 'routes_command' },
      ],
      text: '@click.command("routes", short_help="Show the routes for the app.")\n...',
    },
    {
      id: 'x2', path: 'src/flask/cli.py', startLine: 640, endLine: 700, category: 'impl', tokens: 1500, score: 0.061,
      reasons: [{ kind: 'lexical', term: 'config', rank: 3 }, { kind: 'called-by', from: 'routes_command' }],
      text: 'class FlaskGroup(AppGroup):\n    ...',
    },
    {
      id: 'x3', path: 'tests/test_cli.py', startLine: 380, endLine: 430, category: 'test', tokens: 1300, score: 0.048,
      reasons: [{ kind: 'tests', from: 'routes_command' }, { kind: 'lexical', term: 'command', rank: 5 }],
      text: 'def test_help_echo_loading_error():\n    ...',
    },
    {
      id: 'x4', path: 'docs/cli.rst', startLine: 20, endLine: 62, category: 'docs', tokens: 900, score: 0.04,
      reasons: [{ kind: 'documents', from: 'routes_command' }, { kind: 'mention', token: '@docs/cli.rst' }],
      text: 'Built-in Commands\n-----------------\n...',
    },
    {
      id: 'x5', path: 'src/flask/config.py', startLine: 1, endLine: 40, category: 'impl', tokens: 600, score: 0.033,
      reasons: [{ kind: 'symbol-name', term: 'config', rank: 1 }, { kind: 'selection' }],
      text: 'class Config(dict):\n    ...',
    },
  ],
  omitted: [
    { path: 'src/flask/cli.py', startLine: 1, endLine: 120, reason: 'lower-rank', tokens: 1800 },
    { path: 'tests/test_config.py', startLine: 1, endLine: 400, reason: 'over-budget', tokens: 3200 },
    { path: 'src/flask/cli.py', startLine: 965, endLine: 990, reason: 'duplicate', tokens: 420 },
  ],
  graph: {
    nodes: [
      { id: 'req', label: 'flask config command', type: 'request' },
      { id: 't:command', label: 'command', type: 'term' },
      { id: 't:config', label: 'config', type: 'term' },
      { id: 'f:cli', label: 'src/flask/cli.py', type: 'file' },
      { id: 'f:test', label: 'tests/test_cli.py', type: 'file' },
      { id: 'f:docs', label: 'docs/cli.rst', type: 'file' },
      { id: 's:routes', label: 'routes_command', type: 'symbol' },
      { id: 's:grp', label: 'FlaskGroup', type: 'symbol' },
    ],
    edges: [
      { from: 'req', to: 't:command', label: 'term', inferred: false },
      { from: 'req', to: 't:config', label: 'term', inferred: false },
      { from: 't:command', to: 'f:cli', label: 'lexical:"command"', inferred: false },
      { from: 't:config', to: 'f:cli', label: 'name', inferred: false },
      { from: 'f:cli', to: 's:routes', label: 'registers', inferred: true },
      { from: 'f:cli', to: 's:grp', label: 'calls', inferred: false },
      { from: 'f:test', to: 's:routes', label: 'tests', inferred: true },
      { from: 'f:docs', to: 's:routes', label: 'documents', inferred: true },
    ],
  },
};

export const sampleSearchHits: Array<{ path: string; line: number; preview: string }> = [
  { path: 'src/flask/cli.py', line: 960, preview: '@click.command("routes", short_help="Show the routes for the app.")' },
  { path: 'tests/test_cli.py', line: 392, preview: 'def test_routes_command(runner):' },
  { path: 'docs/cli.rst', line: 31, preview: 'Built-in Commands' },
];

/** Edits two distinct, unique, non-empty lines of `text` (appends a comment). oldText is exact from the text. */
export function sampleProposalArgs(path: string, text: string): ProposeArgs {
  const lines = text.split(/\r?\n/);
  const count = new Map<string, number>();
  for (const l of lines) count.set(l, (count.get(l) ?? 0) + 1);
  const picks: string[] = [];
  const spread = Math.max(1, Math.floor(lines.length / 3));
  for (let i = 0; i < lines.length && picks.length < 2; i += spread) {
    for (let j = i; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() && count.get(l) === 1 && !picks.includes(l)) { picks.push(l); break; }
    }
  }
  const baseHash = sha256(text);
  return {
    summary: 'Sample proposal (dev): annotate two lines',
    edits: picks.map((l, n) => ({
      path,
      baseHash,
      oldText: l,
      newText: `${l}  # contexo sample edit ${n + 1}`,
    })),
  };
}

export const sampleApplied: AppliedHunk[] = [
  {
    hunkId: 'a1b2c3d4e5f6', path: 'src/flask/cli.py', runId: 'run_sample', appliedAt: Date.now() - 60000, undone: false,
    patch: '@@ -990,3 +990,12 @@\n+@click.command("config")\n+def config_command():\n+    ...\n',
  },
  {
    hunkId: '0f9e8d7c6b5a', path: 'tests/test_cli.py', runId: 'run_sample', appliedAt: Date.now() - 60000, undone: false,
    patch: '@@ -430,0 +431,6 @@\n+def test_config_command(runner):\n+    ...\n',
  },
  {
    hunkId: '112233445566', path: 'docs/cli.rst', runId: 'run_sample', appliedAt: Date.now() - 60000, undone: true,
    patch: '@@ -62,0 +63,4 @@\n+``flask config`` prints the config as JSON.\n',
  },
];
