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
    update: z.object({ sessionUpdate: z.string() }).passthrough(),
  }),
});

const otlpRecord = z.object({
  resourceSpans: z.array(z.object({
    scopeSpans: z.array(z.object({
      spans: z.array(z.object({
        traceId: z.string(), spanId: z.string(), parentSpanId: z.string().optional(),
        name: z.string(),
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
  if (format === 'native') {
    const { records, skipped } = readReplay(text);
    if (skipped) throw new Error('The native journal has ' + skipped + ' invalid records.');
    for (const record of records) {
      add({ kind: 'imported', format, name: record.evidence.kind, payload: record }, record.recordedAt);
    }
  } else if (format === 'acp') {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const { params } = acpRecord.parse(JSON.parse(line));
      add({ kind: 'imported', format, name: params.update.sessionUpdate, payload: params.update }, importedAt, params.sessionId);
    }
  } else {
    const seen = new Set<string>();
    for (const resource of otlpRecord.parse(JSON.parse(text)).resourceSpans) {
      for (const scope of resource.scopeSpans) {
        for (const span of scope.spans) {
          const sourceId = span.traceId + ':' + span.spanId;
          if (seen.has(sourceId)) throw new Error('The OTLP export repeats span ' + sourceId);
          seen.add(sourceId);
          add({ kind: 'imported', format, name: span.name, payload: span }, importedAt, span.traceId);
        }
      }
    }
  }
  if (!output.length) throw new Error('No replay events were found.');
  return { id, count: output.length, content: output.map(record => JSON.stringify(record)).join('\n') + '\n' };
}
