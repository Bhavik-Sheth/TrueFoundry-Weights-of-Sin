import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { workspaceGitEnv } from '../shell/workspaceGitEnv';

const git = promisify(execFile);
const limit = 120;

export async function readGitHistory(cwd: string) {
  const { stdout } = await git('git', [
    'log', '--all', 'HEAD', '--topo-order', '--max-count=' + (limit + 1), '--no-show-signature',
    '-z', '--format=%H%x00%P%x00%h%x00%an%x00%aI%x00%D%x00%s%x00%b',
  ], { cwd, env: workspaceGitEnv(), timeout: 5000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });

  const fields = stdout.split('\0');
  fields.pop();
  if (fields.length % 8) throw new Error('Git returned an incomplete history record.');
  const commits = [];
  for (let i = 0; i < Math.min(fields.length, limit * 8); i += 8) {
    const [id, parentIds, shortId, author, date, refs, subject, body] = fields.slice(i, i + 8);
    commits.push({
      id, parents: parentIds ? parentIds.split(' ') : [], shortId, author, date,
      refs: refs ? refs.split(', ') : [], subject, body,
    });
  }
  return { commits, truncated: fields.length > limit * 8 };
}
