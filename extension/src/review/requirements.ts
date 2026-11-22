/**
 * requirements.ts - request-to-requirements splitting and evidence-derived requirement state (no model call).
 *
 * Exports:
 *  - splitRequirements(request): the request split into R1..Rn parts (sentences, then clause openers).
 *  - RequirementView: id, label (R1..), text, revision, state and linked hunks of one requirement.
 *  - requirementsFromRecords(records): latest text/revision per requirement id, in creation order.
 *  - resolveRequirementRefs(refs, requirements): ids for "R2" labels or case-insensitive texts.
 *  - reduceRequirements(records): RequirementView[] folded from a run's journal records.
 *
 * State climbs open -> proposed (linked) -> accepted -> applied -> checked (run_command exit 0 after the apply).
 * Must not import 'vscode'. Depended on by: review/evidence.ts, run/runManager.ts, extension.ts, webview TaskTab.
 */
import { checksFromRecords } from './summary';

/** Loose journal record shape (RunRecord satisfies it); avoids importing journal.ts, which the webview cannot type-check. */
export interface JournalRecord { sequence: number; evidence: { kind: string; [key: string]: any } } // eslint-disable-line @typescript-eslint/no-explicit-any

export interface RequirementView {
  id: string;
  label: string;
  text: string;
  revision: number;
  state: 'open' | 'proposed' | 'accepted' | 'applied' | 'checked';
  links: Array<{ hunkId: string; source: 'agent' | 'human' }>;
}

const CLAUSE = /,\s+(?:and\s+)?(?=(?:be|must|should|masking|ensure|update|add|keep|make)\b)/i;

export function splitRequirements(request: string): string[] {
  const parts = request.trim().split(/(?<=[.!?])\s+/).flatMap(sentence => sentence.split(CLAUSE))
    .map(part => part.trim().replace(/\.$/, '').trim()).filter(Boolean);
  return parts.length ? parts : [request.trim()];
}

export function requirementsFromRecords(records: Array<{ evidence: { kind: string; [key: string]: any } }>): Array<{ id: string; text: string; revision: number }> {
  const byId = new Map<string, { id: string; text: string; revision: number }>();
  for (const { evidence } of records) {
    if (evidence.kind !== 'requirement' && evidence.kind !== 'requirement-link') continue;
    const id = evidence.requirementId;
    const text = evidence.requirementText;
    if (typeof id !== 'string' || typeof text !== 'string') continue;
    const revision = typeof evidence.requirementRevision === 'number' ? evidence.requirementRevision : 1;
    if (revision >= (byId.get(id)?.revision ?? 0)) byId.set(id, { id, text, revision });
  }
  return [...byId.values()];
}

export function resolveRequirementRefs(refs: string[], requirements: Array<{ id: string; text: string }>): string[] {
  const ids = new Set<string>();
  for (const ref of refs) {
    const label = /^R(\d+)$/.exec(ref.trim());
    const match = label ? requirements[Number(label[1]) - 1] : requirements.find(r => r.text.toLowerCase() === ref.trim().toLowerCase());
    if (match) ids.add(match.id);
  }
  return [...ids];
}

export function reduceRequirements(records: JournalRecord[]): RequirementView[] {
  const requirements = requirementsFromRecords(records);
  const links = new Map<string, Map<string, { source: 'agent' | 'human'; linked: boolean }>>();
  const decision = new Map<string, string>();
  const applied = new Map<string, number>();
  for (const { evidence, sequence } of records) {
    if (evidence.kind === 'requirement-link') {
      const source = evidence.source === 'agent' ? 'agent' : 'human';
      const forRequirement = links.get(evidence.requirementId) ?? new Map();
      for (const hunkId of evidence.hunkIds as string[]) forRequirement.set(hunkId, { source, linked: evidence.linked !== false });
      links.set(evidence.requirementId, forRequirement);
    } else if (evidence.kind === 'proposal') {
      for (const hunk of evidence.proposal.hunks as Array<{ id: string; decision: string }>) decision.set(hunk.id, hunk.decision);
      if (evidence.proposal.status === 'applied') {
        for (const id of (evidence.proposal.result?.applied ?? []) as string[]) if (!applied.has(id)) applied.set(id, sequence);
      }
    }
  }
  const passes = checksFromRecords(records).filter(check => check.exitCode === 0).map(check => check.sequence);
  return requirements.map((requirement, index) => {
    const linked = [...(links.get(requirement.id) ?? [])].filter(([, link]) => link.linked);
    const appliedAt = linked.map(([hunkId]) => applied.get(hunkId)).filter((n): n is number => n !== undefined);
    let state: RequirementView['state'] = 'open';
    if (linked.length) state = 'proposed';
    if (linked.some(([hunkId]) => decision.get(hunkId) === 'accepted')) state = 'accepted';
    if (appliedAt.length) {
      state = 'applied';
      if (passes.some(sequence => sequence > Math.max(...appliedAt))) state = 'checked';
    }
    return {
      id: requirement.id, label: 'R' + (index + 1), text: requirement.text, revision: requirement.revision, state,
      links: linked.map(([hunkId, link]) => ({ hunkId, source: link.source })),
    };
  });
}
