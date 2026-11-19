/**
 * runCommand.test.ts - allowlisted command runner core (uses node, added to the test allowlist).
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCommandIn } from '../src/mcp/runCommand';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-run-'));
const ALLOW = ['node', 'python', 'pytest'];

describe('runCommandIn', () => {
  it('rejects programs outside the allowlist', async () => {
    const r = await runCommandIn(root, ALLOW, ['rm', '-rf', 'x']);
    expect(r.exitCode).toBe(126);
    expect(r.stderr).toMatch(/COMMAND_NOT_ALLOWED/);
  });

  it('rejects path-qualified programs', async () => {
    const r = await runCommandIn(root, ALLOW, ['./node', '-v']);
    expect(r.exitCode).toBe(126);
  });

  it('does not interpret shell operators (shell:false)', async () => {
    const r = await runCommandIn(root, ALLOW, ['node', '-e', 'console.log("a && echo b")']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('a && echo b');
  });

  it('kills on timeout', async () => {
    const r = await runCommandIn(root, ALLOW, ['node', '-e', 'setInterval(()=>{},1000)'], 1);
    expect(r.exitCode).toBe(124);
    expect(r.stderr).toMatch(/TIMEOUT/);
    expect(r.durationMs).toBeLessThan(10_000);
  });

  it('caps output', async () => {
    const r = await runCommandIn(root, ALLOW, ['node', '-e', 'process.stdout.write("x".repeat(100000))']);
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThan(20000);
  });

  it('rejects arguments outside the workspace', async () => {
    for (const a of ['/etc/passwd', 'C:\Windows\win.ini', '../x', 'a/../../x', '--file=../x']) {
      const r = await runCommandIn(root, ALLOW, ['node', a]);
      expect(r.exitCode, a).toBe(126);
      expect(r.stderr).toMatch(/PATH_OUTSIDE_WORKSPACE/);
    }
  });

  it('runs in the workspace root', async () => {
    const r = await runCommandIn(root, ALLOW, ['node', '-e', 'console.log(process.cwd())']);
    expect(fs.realpathSync(r.stdout.trim())).toBe(fs.realpathSync(root));
  });
});
