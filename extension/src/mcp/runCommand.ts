/**
 * mcp/runCommand.ts - C3 allowlisted command runner. STUB in S0 (Slice 7).
 *
 * Exports:
 *  - runCommand(argv, timeoutSec): will spawn(argv[0], argv.slice(1), {cwd: workspaceRoot, shell:false});
 *    returns {exitCode, stdout, stderr, truncated}. argv[0] must be in contexo.commandAllowlist
 *    (python, pytest, flask); timeout <= 180 s; output capped. S0: refuses (exitCode 126).
 *  - killAll(): kill every tracked process tree via tree-kill (called on Stop). S0: no-op.
 *
 * Rules: no shell; runs on the host in the real workspace (accepted limitation); needs TrueForge approval.
 * Depends on: tree-kill, config, log. Depended on by: mcp/tools, run/runManager.
 */
import { log } from '../log';

export async function runCommand(
  argv: string[],
  timeoutSec?: number,
): Promise<{ exitCode: number; stdout: string; stderr: string; truncated: boolean }> {
  log('[stub] runCommand', argv, timeoutSec);
  return { exitCode: 126, stdout: '', stderr: 'run_command is not implemented in base', truncated: false };
}

export function killAll(): void {
  log('[stub] killAll');
}
