/**
 * wiring.test.ts - tests for src/review/wiring.ts. Needs `npm run build` first (parser wasm from dist/).
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { buildHunks } from '../src/review/proposal';
import { wiringFor } from '../src/review/wiring';
import type { Proposal } from '../src/types';

const wasmDir = path.join(__dirname, '..', 'dist');
const base = [
  'class FlaskGroup:',
  '    def __init__(self, cli):',
  '        self.cli = cli',
  '',
  '    def run(self):',
  '        return self.cli',
  '',
  '',
  'def config_command():',
  '    return 1',
  '',
].join('\n');
const proposed = base.replace('        self.cli = cli\n', '        self.cli = cli\n        cli.add_command(config_command)\n');
const proposalFor = (before: string, after: string): Proposal => ({
  key: 'k', runId: 'r', toolCallId: 't', threadId: 'th', status: 'reviewing',
  files: [{ path: 'cli.py', base: before, proposed: after, baseHash: 'h' }],
  hunks: buildHunks('cli.py', before, after, 'h'),
});

describe('wiringFor', () => {
  it('links an added call to the hunk that creates it', async () => {
    const proposal = proposalFor(base, proposed);
    const g = await wiringFor(proposal, [], wasmDir);
    expect(g.edges).toContainEqual(expect.objectContaining({ change: 'added', kind: 'call', hunkId: proposal.hunks[0].id }));
    expect(g.edges.every(e => g.nodes.some(n => n.id === e.from) && g.nodes.some(n => n.id === e.to))).toBe(true);
    expect(g.nodes.some(n => n.id === 'cli.py#FlaskGroup.__init__')).toBe(true);
  });

  it('links a removed call to the hunk that removes it', async () => {
    const proposal = proposalFor(proposed, base);
    const g = await wiringFor(proposal, [], wasmDir);
    expect(g.edges).toContainEqual(expect.objectContaining({ change: 'removed', kind: 'call', hunkId: proposal.hunks[0].id }));
  });
});
