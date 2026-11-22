/**
 * review/threeWay.ts - three-way text merge through `git merge-file` (no vscode import; pure Node).
 *
 * Exports:
 *  - threeWay(current, base, other): merges the change base->other into current. clean=false means the
 *    text holds conflict markers (<<<<<<< current / ||||||| applied / ======= / >>>>>>> undo).
 *    Throws MERGE_FAILED when git cannot run. Line endings pass through byte-for-byte.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { workspaceGitEnv } from '../shell/workspaceGitEnv';

export async function threeWay(current: string, base: string, other: string): Promise<{ clean: boolean; text: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'contexo-merge-'));
  try {
    const [c, b, o] = ['current', 'base', 'other'].map((n) => path.join(dir, n));
    await Promise.all([writeFile(c, current), writeFile(b, base), writeFile(o, other)]);
    const r = await new Promise<{ code: number; out: string; error?: string }>((resolve, reject) => {
      execFile('git', ['merge-file', '-p', '--diff3', '-L', 'current', '-L', 'applied', '-L', 'undo', c, b, o],
        { cwd: dir, env: workspaceGitEnv(), encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
          if (!err) return resolve({ code: 0, out: stdout.toString('utf8') });
          const code = (err as NodeJS.ErrnoException & { code?: unknown }).code;
          if (typeof code === 'number') return resolve({ code, out: stdout.toString('utf8'), error: stderr.toString('utf8').trim() });
          reject(err);
        });
    });
    if (r.code < 0 || r.code > 127) throw new Error(`MERGE_FAILED: git merge-file exited ${r.code}${r.error ? `: ${r.error}` : ''}`);
    return { clean: r.code === 0, text: r.out };
  } catch (e) {
    if (String(e).startsWith('Error: MERGE_FAILED')) throw e;
    throw new Error('MERGE_FAILED: ' + String(e));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
