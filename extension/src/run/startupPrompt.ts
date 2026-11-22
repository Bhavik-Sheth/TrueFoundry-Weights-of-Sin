// Pure startup logic: unfinishedRun finds an interrupted run in its journal records; startupPrompt picks the one recovery prompt (apply > review > run).
import type { RunRecord } from './journal';

export type StartupAction = 'Recover' | 'Restore Review' | 'Resume' | 'Dismiss';

export function unfinishedRun(records: RunRecord[]): { runId: string; request: string; mode: 'inline' | 'agent' } | undefined {
  const request = records.find(r => r.evidence.kind === 'request');
  if (!request || request.evidence.kind !== 'request') return;
  const states = records.filter(r => r.evidence.kind === 'state');
  const last = states.reduce<RunRecord | undefined>((a, b) => !a || b.sequence >= a.sequence ? b : a, undefined);
  if (last?.evidence.kind !== 'state' || (last.evidence.state !== 'streaming' && last.evidence.state !== 'awaiting-review')) return;
  return { runId: request.runId, request: request.evidence.text, mode: request.evidence.mode };
}

export function startupPrompt(s: { applyPending: boolean; reviewPending: boolean; unfinished?: { runId: string; request: string } }):
  { message: string; actions: StartupAction[] } | undefined {
  if (s.applyPending) return { message: 'Contexo was interrupted while applying reviewed changes.', actions: ['Recover', 'Dismiss'] };
  if (s.reviewPending) return { message: 'Contexo has an unfinished review.', actions: ['Restore Review', 'Dismiss'] };
  if (s.unfinished) return { message: `A Contexo run did not finish: "${s.unfinished.request.slice(0, 60)}".`, actions: ['Resume', 'Dismiss'] };
}
