import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { RunRecord } from '../run/journal';

const nativeRecord = z.object({
  version: z.literal(1), runId: z.string(), sequence: z.number().int().positive(),
  recordedAt: z.string(), evidence: z.object({ kind: z.string() }).passthrough(),
}).passthrough();

const acpRecord = z.object({
  method: z.literal('session/update'),
  params: z.object({
    sessionId: z.string(),
    update: z.object({ sessionUpdate: z.string(), eventId: z.string().optional() }).passthrough(),
  }),
});

const otlpRecord = z.object({
  resourceSpans: z.array(z.object({
    scopeSpans: z.array(z.object({
      spans: z.array(z.object({
        traceId: z.string(), spanId: z.string(), parentSpanId: z.string().optional(),
        name: z.string(), startTimeUnixNano: z.string().regex(/^\d+$/).optional(),
      }).passthrough()),
    })),
  })),
});

export function readReplay(text: string): { records: Array<z.infer<typeof nativeRecord>>; skipped: number } {
  const records = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(nativeRecord.parse(JSON.parse(line)));
    } catch {
      skipped++;
    }
  }
  return { records, skipped };
}

export function importReplay(text: string, format: 'native' | 'acp' | 'otlp'): { id: string; content: string; count: number } {
  const id = 'import-' + createHash('sha256').update(format + '\n').update(text).digest('hex');
  const importedAt = new Date().toISOString();
  const output: RunRecord[] = [];
  function add(evidence: RunRecord['evidence'], recordedAt = importedAt, sessionId?: string, turnId?: string) {
    output.push({ version: 1, runId: id, sequence: output.length + 1, recordedAt, sessionId, turnId, evidence });
  }
  const seen = new Map<string, string>();
  function register(key: string, value: unknown): boolean {
    const content = JSON.stringify(value);
    const old = seen.get(key);
    if (old === content) return false;
    if (old !== undefined) throw new Error('Conflicting replay records for source identity ' + key);
    seen.set(key, content);
    return true;
  }
  if (format === 'native') {
    const { records, skipped } = readReplay(text);
    for (const record of records.sort((a, b) => a.runId.localeCompare(b.runId) || a.sequence - b.sequence)) {
      if (!register(JSON.stringify([record.runId, record.sequence]), record)) continue;
      add({ kind: 'imported', format, name: record.evidence.kind, payload: record }, record.recordedAt);
    }
    if (skipped) add({ kind: 'reconciliation', status: skipped + ' unreadable record(s) in the original journal' });
  } else if (format === 'acp') {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const { params } = acpRecord.parse(JSON.parse(line));
      if (params.update.eventId && !register(JSON.stringify([params.sessionId, params.update.eventId]), params.update)) continue;
      add({ kind: 'imported', format, name: params.update.sessionUpdate, payload: params.update }, importedAt, params.sessionId);
    }
  } else {
    const spans = otlpRecord.parse(JSON.parse(text)).resourceSpans
      .flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans))
      .filter(span => register(span.traceId + ':' + span.spanId, span));
    const time = (span: typeof spans[number]) => BigInt(span.startTimeUnixNano ?? '0');
    spans.sort((a, b) => time(a) === time(b)
      ? (a.traceId + ':' + a.spanId).localeCompare(b.traceId + ':' + b.spanId)
      : time(a) < time(b) ? -1 : 1);
    for (const span of spans) {
      const date = new Date(Number(time(span) / 1_000_000n));
      const orphan = !!span.parentSpanId && !seen.has(span.traceId + ':' + span.parentSpanId);
      add({ kind: 'imported', format, name: span.name, payload: { ...span, orphan } },
        span.startTimeUnixNano && Number.isFinite(date.valueOf()) ? date.toISOString() : importedAt,
        span.traceId);
    }
  }
  if (!output.length) throw new Error('No replay events were found.');
  return { id, count: output.length, content: output.map(record => JSON.stringify(record)).join('\n') + '\n' };
}

type ReplayEvent = ReturnType<typeof readReplay>['records'][number]['evidence'];

export function projectReplay(records: ReturnType<typeof readReplay>['records'], index: number) {
  const proposals = new Map<string, unknown>();
  const approvals = new Map<string, unknown>();
  const tools = new Map<string, unknown>();
  const checks: ReplayEvent[] = [];
  for (const record of records.slice(0, index + 1)) {
    const event = record.evidence;
    const payload = event.payload as { evidence?: ReplayEvent; toolCallId?: string } | undefined;
    const evidence = event.kind === 'imported' && event.format === 'native' && payload?.evidence
      ? payload.evidence : event;
    if (evidence.kind === 'proposal') {
      const proposal = evidence.proposal as { key?: string } | undefined;
      if (proposal?.key) proposals.set(proposal.key, proposal);
    }
    if (evidence.kind === 'check') checks.push(evidence);
    if (evidence.kind === 'agent-event') {
      const item = evidence.event as { kind?: string; toolCallId?: string } | undefined;
      if (item?.toolCallId && item.kind === 'approval') approvals.set(item.toolCallId, item);
    }
    if (event.kind === 'imported' && event.format === 'acp' && payload?.toolCallId) {
      const previous = tools.get(payload.toolCallId);
      tools.set(payload.toolCallId, { ...(typeof previous === 'object' ? previous : {}), ...payload });
    }
  }
  return { proposals: [...proposals.values()], approvals: [...approvals.values()], toolCalls: [...tools.values()], checks };
}
