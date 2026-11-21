import { readFile, lstat, realpath } from 'node:fs/promises';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { buildProposalFiles, proposalInput } from '../review/editBatch';
import { resolveUnder } from '../mcp/server';
import { buildHunks, proposalKey, rebuildFile, sha256 } from '../review/proposal';
import type { Proposal, Run, ProposeArgs } from '../types';

const exec = promisify(execFile);
export const edits = proposalInput.extend({ edits: proposalInput.shape.edits.max(100) });

export async function workspaceText(root: string, path: string): Promise<string | undefined> {
  if (/[\x00-\x1f\\]/.test(path) || path.split('/').some(p => !p || p === '.')) throw new Error('Invalid file path');
  const absolute = resolveUnder(root, path);
  let cursor = absolute;
  while (cursor !== root) {
    const stat = await lstat(cursor).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (stat) {
      if (await realpath(cursor) !== cursor || stat.isSymbolicLink()) throw new Error('Symlink path: ' + path);
      if (cursor !== absolute) return undefined;
      if (!stat.isFile() || stat.size > 2 ** 20) throw new Error('Expected a text file under 1 MiB');
      return new TextDecoder('utf-8', { fatal: true }).decode(await readFile(absolute));
    }
    cursor = dirname(cursor);
  }
  return undefined;
}

export async function search(root: string, terms: string[], limit: number) {
  const patterns = terms.filter(Boolean).slice(0, 12).flatMap(term => ['-e', term]);
  if (!patterns.length) return [];
  try {
    const result = await exec('git', ['grep', '--untracked', '-n', '-I', '-i', '-F', ...patterns, '--', '.'], { cwd: root, maxBuffer: 8 << 20, timeout: 5000 });
    return result.stdout.trimEnd().split('\n').slice(0, limit).map(line => line.slice(0, 500));
  } catch (error) {
    if ((error as {code?: number}).code === 1) return [];
    throw error;
  }
}

export async function stage(root: string, run: Run, toolCallId: string, threadId: string, args: ProposeArgs): Promise<Proposal> {
  edits.parse(args);
  const files = await buildProposalFiles(args.edits, path => workspaceText(root, path));
  const hunks = files.flatMap(f => buildHunks(f.path, f.base, f.proposed, f.baseHash));
  return { key: proposalKey(args), runId: run.id, threadId, toolCallId, files, hunks, status: 'reviewing' };
}

export async function applyReviewed(root: string, proposal: Proposal, active: () => boolean) {
  const patches: string[] = [];
  for (const f of proposal.files) {
    const next = rebuildFile(f.base, f.path, proposal.hunks);
    if (next === f.base) continue;
    const current = await workspaceText(root, f.path);
    if ((current === undefined ? 'new' : sha256(current)) !== f.baseHash) throw new Error('STALE_BASE: ' + f.path);
    patches.push(createTwoFilesPatch(current === undefined ? '/dev/null' : 'a/' + f.path, 'b/' + f.path, f.base, next));
  }
  if (!active()) throw new Error('Review is no longer active.');
  if (!patches.length) return;
  // git apply's default all-or-nothing mode also checks the patch against the working tree.
  const result = spawnSync('git', ['apply', '--whitespace=nowarn', '-'], { cwd: root, input: patches.join('\n'), encoding: 'utf8', timeout: 10000 });
  if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr);
}
