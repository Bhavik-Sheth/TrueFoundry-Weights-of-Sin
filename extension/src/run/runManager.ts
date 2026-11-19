/**
 * run/runManager.ts - C2 owner of the single active Run.
 *
 * Exports:
 *  - class RunManager (typed EventEmitter for panel/status bar):
 *    - start(mode, text, selection?): create session on primary agent, build first message
 *      (instruction + selection path/range/hash/text + "keep edits inside the selection"), consume().
 *    - consume(): loop over turn stream, track turnId/lastEventId, merge deltas, ignore events of
 *      sealed sessions; on tool.approval_required for propose_write -> review.beginProposal(...);
 *      for run_command -> notification with argv and Allow/Deny.
 *    - resolveApproval(allow|deny, reason?): subscribeToTurn(afterEventId) + user.tool_approval, then
 *      continue consuming the resumed stream.
 *    - stop(): synchronous first (state='cancelled', mcp.revoke(run.id), review.discardPending(),
 *      runCommand.killAll()), then await tfClient.cancel(). Late approval events are ignored.
 *    - failure path: turn.done 'error', SDK/network error, or no event within firstEventTimeoutMs ->
 *      fallback.classify(); model-failure -> fallback.takeOver(run).
 *
 * Rules: one active run only; never writes to disk.
 * Depends on: types, config, run/tfClient, run/fallback, review/diffView, mcp/server, mcp/runCommand,
 * shell/panel. Depended on by: extension, shell/inlineEdit, shell/statusBar, review/diffView.
 */
export {};
