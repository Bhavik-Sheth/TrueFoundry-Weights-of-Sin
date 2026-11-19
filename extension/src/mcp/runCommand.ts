/**
 * mcp/runCommand.ts - C3 allowlisted command runner.
 *
 * Exports:
 *  - runCommand(argv, timeoutSec): spawn(argv[0], argv.slice(1), {cwd: workspaceRoot, shell:false});
 *    returns {exitCode, stdout, stderr, truncated}. argv[0] must be in contexo.commandAllowlist
 *    (python, pytest, flask); timeout <= 180 s; output capped.
 *  - killAll(): kill every tracked process tree via tree-kill (called on Stop).
 *
 * Rules: no shell; runs on the host in the real workspace (accepted limitation); needs TrueForge approval.
 * Depends on: tree-kill, config. Depended on by: mcp/tools, run/runManager.
 */
export {};
