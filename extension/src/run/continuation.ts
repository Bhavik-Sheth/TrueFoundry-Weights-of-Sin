import { z } from 'zod';
import type { ContextPacket, Proposal, Run } from '../types';
import type { RunEvidence, RunRecord } from './journal';
import type { prepareContextForModel } from '../context/assembler';
import { sha256 } from '../review/proposal';

export const continuationInput = {
  offset: z.number().int().min(0).max(100_000).default(0),
  proposalKey: z.string().regex(/^[a-f0-9]{64}$/).optional()
    .describe('Pass the returned proposal key with the next offset to detect a changed proposal'),
};

export function contextReceipt(packet: ContextPacket, result: ReturnType<typeof prepareContextForModel>): RunEvidence {
  const { text, delivery } = result;
  const sent = new Set(delivery.excerptIds);
  return {
    kind: 'context', packetId: packet.id, budget: packet.budget, packed: packet.used, delivery, contentHash: sha256(text),
    files: packet.files?.filter(file => delivery.filePaths.includes(file.path)).map(file => ({
      ...file, openingLines: undefined,
      changes: file.changes && { ...file.changes, hunks: undefined },
      previousChanges: file.previousChanges && { ...file.previousChanges, hunks: undefined },
    })),
    excerpts: packet.excerpts.filter(e => sent.has(e.id))
      .map(({ path, startLine, endLine, category, reasons }) => ({ path, startLine, endLine, category, reasons })),
  };
}

function clip(value: string, length: number) {
  const text = value.replace(/[\x00-\x1f\x7f]/g, ' ');
  return text.length <= length ? text : text.slice(0, length - 1) + '…';
}

export function continuation(
  run: Pick<Run, 'id' | 'request' | 'state' | 'sessionId' | 'selection'>,
  records: RunRecord[],
  args: z.infer<z.ZodObject<typeof continuationInput>>,
  pending?: Proposal,
) {
  const own = records.filter(entry => entry.runId === run.id);
  const latest = own.find(record => record.evidence.kind === 'proposal');
  const context = own.find(record => record.evidence.kind === 'context');
  const proposal = pending?.runId === run.id ? pending : latest?.evidence.kind === 'proposal' ? latest.evidence.proposal : undefined;
  if (args.offset > 0 && (!proposal || proposal.key !== args.proposalKey)) {
    return { status: 'proposal_changed', message: 'Read the current checkpoint with offset 0 first.' };
  }

  const files = new Map<string, { path: string; accepted: number; rejected: number; pending: number }>();
  for (const hunk of proposal?.hunks ?? []) {
    const row = files.get(hunk.path) ?? { path: clip(hunk.path, 160), accepted: 0, rejected: 0, pending: 0 };
    row[hunk.decision]++;
    files.set(hunk.path, row);
  }
  const nextOffset = args.offset + 12;
  const selection = run.selection;
  const packet = context?.evidence.kind === 'context' ? context.evidence : undefined;
  return {
    status: 'checkpoint',
    runId: run.id, sessionId: run.sessionId, state: run.state,
    goal: clip(run.request, 1250),
    selection: selection && { path: clip(selection.path, 160), startLine: selection.startLine, endLine: selection.endLine, hash: selection.hash },
    lastContext: packet && {
      packetId: packet.packetId, journalSequence: context?.sequence, turnId: context?.turnId,
      sha256: packet.contentHash, estimatedTokens: packet.delivery.packetTokens,
      excerpts: packet.excerpts.slice(0, 8).map(({ path, startLine, endLine, category }) =>
        ({ path: clip(path, 160), startLine, endLine, category })),
      deliveredExcerptCount: packet.delivery.excerptIds.length,
    },
    proposal: proposal && {
      key: proposal.key, status: proposal.status, journalSequence: latest?.sequence,
      totalFiles: files.size, totalHunks: proposal.hunks.length,
      files: [...files.values()].slice(args.offset, nextOffset),
      nextOffset: nextOffset < files.size ? nextOffset : undefined,
    },
    recentChecks: own.flatMap(entry => {
      const value = entry.evidence;
      return value.kind === 'check' ? [{
        source: clip(value.source, 48), name: clip(value.name, 100), status: clip(value.status, 32),
        proposalKey: value.proposalKey, sequence: entry.sequence,
      }] : [];
    }).slice(0, 6),
    next: 'Reread exact current lines and verify their hashes before using any historical context to edit.',
  };
}
