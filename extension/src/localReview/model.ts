import { z } from 'zod';
import { buildHunks, proposalKey, rebuildFile, sha256 } from '../review/proposal';
import { normalizeReviewPath, matchingHunks, reviewCoordinates } from '../review/matching';
import { compareProposalImpact } from '../review/impactGraph';
import type { Proposal } from '../types';

const inputSchema = z.object({
  files: z.array(z.object({ path: z.string(), base: z.string(), baseHash: z.string().optional(), proposed: z.string() })).min(1).max(50),
  rejected: z.array(z.string()).default([]),
  checks: z.array(z.object({
    name: z.string(), status: z.string(), source: z.string(), candidateDigest: z.string().optional(),
  })).default([]),
  findings: z.array(z.object({
    path: z.string(), name: z.string(), side: z.enum(['base', 'candidate']),
    sha256: z.string(), startLine: z.number().int().positive(), endLine: z.number().int().positive().optional(),
  })).default([]),
  requirements: z.array(z.object({ text: z.string(), hunkIds: z.array(z.string()) })).default([]),
});

export async function analyzeReview(value: unknown) {
  const input = inputSchema.parse(value);
  const paths = new Set<string>();
  const files = input.files.map(file => {
    const path = normalizeReviewPath(file.path);
    if (!path || paths.has(path)) throw new Error('Invalid or duplicate file path: ' + file.path);
    paths.add(path);
    return { ...file, path, baseHash: file.baseHash === 'new' && !file.base ? 'new' : sha256(file.base) };
  });
  const rejected = new Set(input.rejected);
  const hunks = files.flatMap(file => buildHunks(file.path, file.base, file.proposed, file.baseHash));
  for (const hunk of hunks) hunk.decision = rejected.has(hunk.id) ? 'rejected' : 'accepted';
  const proposal: Proposal = { key: proposalKey(files), runId: 'local-review', toolCallId: '', threadId: '', files, hunks, status: 'reviewing' };
  const candidates = new Map(files.map(file => [file.path, rebuildFile(file.base, file.path, hunks)]));
  const snapshots = files.map(file => ({ path: file.path, base: file.baseHash, candidate: sha256(candidates.get(file.path)!) }));
  const candidateDigest = proposalKey([...snapshots].sort((a, b) => a.path.localeCompare(b.path)).map(file => [file.path, file.candidate]));
  const findings = input.findings.map(finding => {
    const path = normalizeReviewPath(finding.path);
    const snapshot = snapshots.find(file => file.path === path);
    const endLine = finding.endLine ?? finding.startLine;
    if (endLine < finding.startLine) throw new Error('Finding end line precedes the start line: ' + finding.name);
    if (!path || !snapshot || snapshot[finding.side] !== finding.sha256) return { ...finding, match: 'unverified revision', hunkIds: [] };
    const coordinateHunks = reviewCoordinates(hunks, path, finding.side);
    const hunkIds = matchingHunks(coordinateHunks, { path, side: finding.side, startLine: finding.startLine, endLine });
    return { ...finding, match: hunkIds.length ? 'changed line' : 'outside changed lines', hunkIds };
  });
  return {
    proposalKey: proposal.key, candidateDigest, snapshots, hunks, findings,
    requirements: input.requirements.map(requirement => ({
      ...requirement, hunkIds: requirement.hunkIds.filter(id => hunks.some(hunk => hunk.id === id)),
    })),
    checks: input.checks.map(check => ({
      ...check, match: check.candidateDigest === candidateDigest ? 'candidate digest matched'
        : check.candidateDigest ? 'different candidate' : 'unverified revision',
    })),
    impact: await compareProposalImpact(proposal),
  };
}
