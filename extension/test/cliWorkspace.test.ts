import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { stage, applyReviewed, workspaceText } from '../src/cli/workspace';
import { checkCandidate } from '../src/review/candidateCheck';
import { sha256 } from '../src/review/proposal';
import type { Run } from '../src/types';

describe('terminal review', () => {
  let root: string;
  const run: Run = { id: 'test', mode: 'agent', request: '', sessionId: 's', agent: 'contexo', state: 'streaming', sealedSessions: [] };
  const base = 'value = 1\n';
  const proposal = () => stage(root, run, 'call', 'thread', { summary: 'update', edits: [
    { path: 'module.py', baseHash: sha256(base), oldText: base, newText: 'value = 2\n' },
    { path: 'test_module.py', baseHash: 'new', oldText: '', newText: 'from module import value\n\ndef test_result(): assert value == 2\n' },
  ] });
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'contexo-cli-test-')));
    execFileSync('git', ['init', '-q'], { cwd: root });
    await writeFile(join(root, 'module.py'), base);
  });
  afterEach(() => rm(root, { recursive: true, force: true }));
  it('stages both files, applies only selected hunks, and preserves rejected new files', async () => {
    const p = await proposal();
    p.hunks[0].decision = 'accepted';
    await applyReviewed(root, p, () => true);
    expect(await workspaceText(root, 'module.py')).toBe('value = 2\n');
    expect(await workspaceText(root, 'test_module.py')).toBeUndefined();
  });
  it('stages disjoint line ranges against one revision and preserves CRLF', async () => {
    const source = 'same\r\nsame\r\nending\r\n';
    const baseHash = sha256(source);
    await writeFile(join(root, 'module.py'), source);
    const p = await stage(root, run, 'call', 'thread', { summary: 'update', edits: [
      { path: 'module.py', baseHash, startLine: 2, endLine: 2, newText: 'replacement\nextra' },
      { path: 'module.py', baseHash, startLine: 3, endLine: 3, newText: 'end' },
    ] });
    expect(p.files[0].proposed).toBe('same\r\nreplacement\r\nextra\r\nend\r\n');
    expect(await workspaceText(root, 'module.py')).toBe(source);
  });
  it('rejects ambiguous, stale, and ineffective ranges without touching the file', async () => {
    const edit = { path: 'module.py', baseHash: sha256(base), startLine: 1, endLine: 1, newText: 'value = 2' };
    const propose = (edits: Parameters<typeof stage>[4]['edits']) =>
      stage(root, run, 'call', 'thread', { summary: 'update', edits });
    await expect(propose([edit, edit])).rejects.toThrow('OVERLAPPING_RANGES');
    await expect(propose([{ ...edit, endLine: 2 }])).rejects.toThrow('INVALID_RANGE');
    await expect(propose([{ ...edit, oldText: base }])).rejects.toThrow('INVALID_RANGE');
    await expect(propose([{ ...edit, newText: 'value = 1' }])).rejects.toThrow('NO_CHANGE');
    await expect(propose([{ ...edit, baseHash: sha256('stale') }])).rejects.toThrow('STALE_BASE');
    expect(await workspaceText(root, 'module.py')).toBe(base);
  });
  it('rejects stale files and revoked reviews before writing', async () => {
    const p = await proposal();
    for (const h of p.hunks) h.decision = 'accepted';
    await expect(applyReviewed(root, p, () => false)).rejects.toThrow('active');
    await writeFile(join(root, 'module.py'), 'changed');
    await expect(applyReviewed(root, p, () => true)).rejects.toThrow('STALE_BASE');
    expect(await workspaceText(root, 'test_module.py')).toBeUndefined();
  });
  it('runs pytest against accepted edits including a new file in a separate directory', async () => {
    const p = await proposal();
    for (const h of p.hunks) h.decision = 'accepted';
    expect((await checkCandidate(root, p)).passed).toBe(true);
    expect(await readFile(join(root, 'module.py'), 'utf8')).toBe(base);
    expect(await workspaceText(root, 'test_module.py')).toBeUndefined();
    await applyReviewed(root, p, () => true);
    expect(await workspaceText(root, 'test_module.py')).toContain('def test_result');
  }, 60000); // spawns a real pytest process; exceeds the 5s default under full-suite load
  it('rejects retained and dangling symlinks', async () => {
    await symlink(tmpdir(), join(root, 'outside'));
    await expect(workspaceText(root, 'outside/new.py')).rejects.toThrow();
    await symlink('missing', join(root, 'dangling'));
    await expect(workspaceText(root, 'dangling')).rejects.toThrow();
  });
});
