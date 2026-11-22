/**
 * summary.test.ts - tests for src/review/summary.ts (grounded review facts and check extraction).
 */
import { describe, expect, it } from 'vitest';
import { buildHunks } from '../src/review/proposal';
import { checksFromJournal, summarizeProposal } from '../src/review/summary';
import type { Proposal, SymbolEntry, WiringGraph } from '../src/types';

const before = 'class FlaskGroup:\n    def __init__(self):\n        pass\n';
const after = 'import json\n\n' + before.replace('        pass\n', '        add(config_command)\n') + '\n\ndef config_command():\n    return 1\n';
const sym = (qualifiedName: string, kind: SymbolEntry['kind'], startLine: number, endLine: number): SymbolEntry =>
  ({ id: qualifiedName, path: 'src/flask/cli.py', name: qualifiedName, qualifiedName, kind, startLine, endLine, decorators: [], calls: [], imports: [], text: '' });
const proposal = (): Proposal => ({
  key: 'k', runId: 'r', toolCallId: 't', threadId: 'th', status: 'reviewing',
  files: [{ path: 'src/flask/cli.py', base: before, proposed: after, baseHash: 'h' }],
  hunks: buildHunks('src/flask/cli.py', before, after, 'h'),
});
const graph: WiringGraph = {
  nodes: [
    { id: 'src/flask/cli.py#FlaskGroup.__init__', label: 'FlaskGroup.__init__', path: 'src/flask/cli.py' },
    { id: 'config_command', label: 'config_command', path: 'src/flask/cli.py' },
  ],
  edges: [{ id: 'e', from: 'src/flask/cli.py#FlaskGroup.__init__', to: 'config_command', change: 'added', kind: 'call' }],
};

describe('summarizeProposal', () => {
  it('derives ordered facts from the proposal, wiring and checks', () => {
    const p = proposal();
    const checks = [{ id: '7', argv: ['pytest', 'tests/test_cli.py', '-q'], exitCode: 0, passed: 60, failed: 0 }];
    const facts = summarizeProposal(p, graph, checks, [sym('FlaskGroup', 'class', 1, 3)], [sym('FlaskGroup', 'class', 3, 5), sym('config_command', 'function', 8, 9)]);
    expect(facts.map(f => f.text)).toEqual([
      'Changes 1 file: src/flask/cli.py',
      'Adds function config_command',
      'New import: json',
      'New call: FlaskGroup.__init__ → config_command',
      'Check pytest tests/test_cli.py -q: exit 0 (60 passed, 0 failed)',
    ]);
    expect(facts[0].hunkIds).toEqual(p.hunks.map(h => h.id));
    expect(facts[4].checkId).toBe('7');
  });

  it('reports removals, flagged hunks and caps at 8 facts', () => {
    const p = proposal();
    p.hunks[0].outsideSelection = true;
    p.hunks[0].historyConcern = { sha: 's', subject: 'x', concern: 'c', issues: [] };
    const removed = Array.from({ length: 9 }, (_, i) => sym('old' + i, 'function', 1, 2));
    const facts = summarizeProposal(p, graph, [], removed, []);
    expect(facts).toHaveLength(8);
    expect(facts[1].text).toBe('Removes function old0');
    const flagged = summarizeProposal(p, graph, [], [], []).map(f => f.text);
    expect(flagged[flagged.length - 1]).toBe('1 hunk flagged: outside selection, history concern');
  });
});

describe('checksFromJournal', () => {
  it('pairs run_command calls with their output and parses pytest counts', () => {
    const lines = [
      { sequence: 1, evidence: { kind: 'agent-event', event: { kind: 'tool-call', toolCallId: 'c1', name: 'run_command', args: { argv: ['pytest', '-q'] } } } },
      { sequence: 2, evidence: { kind: 'tool-output', toolCallId: 'c1', content: JSON.stringify({ exitCode: 1, stdout: '1 failed, 59 passed in 2s', stderr: '' }) } },
    ].map(r => JSON.stringify(r)).join('\n');
    expect(checksFromJournal(lines)).toEqual([{ id: 'c1', argv: ['pytest', '-q'], exitCode: 1, passed: 59, failed: 1 }]);
  });
});
