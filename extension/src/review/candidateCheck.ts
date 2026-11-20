import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, copyFile, realpath, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { scopedEnv } from '../mcp/runCommand';
import { rebuildFile, sha256 } from './proposal';
import type { Proposal } from '../types';

const exec = promisify(execFile);

/** Capture the reviewed selection synchronously before opening the test workspace. */
export async function checkCandidate(root: string, proposal: Proposal) {
  const hunks = proposal.hunks.filter(h => h.decision === 'accepted').map(h => h.id);
  if (!hunks.length) throw new Error('Accept the hunks to test first.');
  const changes = proposal.files.filter(f => proposal.hunks.some(h => h.path === f.path && h.decision === 'accepted')).map(f => ({
    path: f.path, text: rebuildFile(f.base, f.path, proposal.hunks), base: f.baseHash,
  }));
  const dir = await mkdtemp(path.join(tmpdir(), 'contexo-check-'));
  try {
    const cwd = await realpath(root);
    const tracked = await exec('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd, maxBuffer: 32 << 20 });
    for (const file of tracked.stdout.split('\0').filter(Boolean)) {
      const source = path.resolve(cwd, file);
      if (!source.startsWith(cwd + path.sep)) throw new Error('Invalid workspace path');
      const stat = await lstat(source).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return undefined;
        throw e;
      });
      if (!stat?.isFile() || await realpath(source) !== source) continue;
      const dest = path.join(dir, file);
      await mkdir(path.dirname(dest), { recursive: true });
      await copyFile(source, dest);
    }
    for (const file of changes) {
      const dest = path.resolve(dir, file.path);
      if (!dest.startsWith(dir + path.sep)) throw new Error('Invalid proposal path');
      const { readFile } = await import('node:fs/promises');
      const prior = await readFile(dest, 'utf8').catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return undefined;
        throw e;
      });
      if ((prior === undefined ? 'new' : sha256(prior)) !== file.base) throw new Error('Stale candidate: ' + file.path);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, file.text);
    }
    const venvPython = path.join(cwd, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    const python = existsSync(venvPython) ? venvPython : process.platform === 'win32' ? 'python' : 'python3';
    const env = scopedEnv(cwd);
    delete env.PYTHONPATH;
    // Run the copied source ahead of editable installs pointing back to the checkout.
    env.PYTHONPATH = [path.join(dir, 'src'), dir].join(path.delimiter);
    await exec(python, ['-m', 'pytest', '-q'], { cwd: dir, env, timeout: 120000, maxBuffer: 4 << 20 });
    return { hunks, passed: true };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
