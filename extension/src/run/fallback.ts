/**
 * run/fallback.ts - C2 failure classification and automatic fallback. STUBS in S0 (Slice 8).
 *
 * Exports:
 *  - classify(errOrTurnDone): 'model-failure' | 'cancelled' | 'other'. model-failure = HTTP
 *    401/403/404/5xx, ECONNREFUSED/ENOTFOUND/timeouts, provider error text in turn.done state,
 *    or no first event within firstEventTimeoutMs. S0: always 'other'.
 *  - FallbackDeps: what takeOver needs (TrueForge client, config, UI callbacks).
 *  - takeOver(run, deps): seal the primary session (events ignored), create a contexo-fallback session,
 *    replay the original first message plus note "Previous model failed; continue the same task.",
 *    post the amber banner. S0: throws 'not implemented'.
 *
 * Rules: classify is pure (no vscode import); at most once per run; if fallback also fails show an
 * error card; workspace untouched; target takeover < 5 s with no user action; cancelled is never failure.
 * Depends on: run/tfClient (type), config (type), types. Depended on by: run/runManager.
 */
import type { Run, ToWebview } from '../types';
import type { TfClient } from './tfClient';
import type { ContexoConfig } from '../config';

export interface FallbackDeps {
  tf: TfClient;
  cfg: ContexoConfig;
  post: (m: ToWebview) => void;
}

export function classify(x: unknown): 'model-failure' | 'cancelled' | 'other' {
  void x;
  return 'other';
}

export async function takeOver(run: Run, deps: FallbackDeps): Promise<void> {
  void run;
  void deps;
  throw new Error('not implemented');
}
