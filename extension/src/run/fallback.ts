/**
 * run/fallback.ts - C2 failure classification and automatic fallback.
 *
 * Exports:
 *  - classify(errOrTurnDone): 'model-failure' | 'cancelled' | 'other'. model-failure = HTTP
 *    401/403/404/5xx, ECONNREFUSED/ENOTFOUND/timeouts, provider error text in turn.done state,
 *    or no first event within firstEventTimeoutMs.
 *  - takeOver(run): seal the primary session (events ignored), create a contexo-fallback session,
 *    replay the original first message plus note "Previous model failed; continue the same task.",
 *    post the amber banner ("Primary model failed (...). Continued on fallback <model>.").
 *
 * Rules: at most once per run; if fallback also fails show an error card; workspace untouched;
 * target takeover < 5 s with no user action; cancelled is never treated as failure.
 * Depends on: run/tfClient, run/runManager, types. Depended on by: run/runManager.
 */
export {};
