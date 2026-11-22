import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareContextForModel } from '../src/context/assembler';
import { samplePacket } from '../src/dev/fixtures';
import { assertNativeWorkspacePath } from '../src/mcp/server';
import { importReplay, projectReplay, readReplay } from '../src/replay/records';
import { RunJournal } from '../src/run/journal';
import { parseSarif } from '../src/review/sarif';

describe('external editor interoperability regressions', () => {
  let temp: string | undefined;
  afterEach(async () => {
    if (temp) await rm(temp, { recursive: true, force: true });
    temp = undefined;
  });

  it('accounts for escaped transport text and reports only delivered excerpts', () => {
    const packet = structuredClone(samplePacket);
    packet.excerpts[0].text = '\\'.repeat(14_000);
    const { text, delivery } = prepareContextForModel(packet);
    expect(delivery.excerptIds).toContain(packet.excerpts[0].id);
    expect(delivery.shortenedExcerptIds).toContain(packet.excerpts[0].id);
    expect(delivery.excerptIds).toContain(packet.excerpts[1].id);
    expect(text).not.toContain(packet.excerpts[0].text);
    expect(delivery.serializedCharacters).toBe(JSON.stringify(text).length);
    expect(delivery.serializedCharacters).toBeLessThanOrEqual(delivery.characterLimit);
  });

  it('allows a future file within the root and refuses a link outside it', async () => {
    temp = await mkdtemp(join(tmpdir(), 'contexo-path-test-'));
    const root = join(temp, 'root');
    const outside = join(temp, 'outside');
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(outside, 'file.txt'), 'sample');
    await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(assertNativeWorkspacePath(root, 'linked/file.txt')).rejects.toThrow(/PATH_INVALID/);
    await expect(assertNativeWorkspacePath(root, 'future/folder/file.txt')).resolves.toBe(join(root, 'future/folder/file.txt'));
  });

  it('merges recorded ACP tool updates and deduplicates named source events', () => {
    const event = (sessionUpdate: string, eventId: string, fields: object) => JSON.stringify({
      method: 'session/update',
      params: { sessionId: 'session', update: { sessionUpdate, eventId, toolCallId: 'call', ...fields } },
    });
    const initial = event('tool_call', '1', { title: 'Read code' });
    const updated = event('tool_call_update', '2', { status: 'completed' });
    const imported = importReplay([initial, initial, updated].join('\n'), 'acp');
    expect(imported.count).toBe(2);
    const { records } = readReplay(imported.content);
    expect(projectReplay(records, 0).toolCalls).toEqual([expect.objectContaining({ title: 'Read code' })]);
    expect(projectReplay(records, 1).toolCalls).toEqual([expect.objectContaining({ title: 'Read code', status: 'completed' })]);
  });

  it('keeps changed CI observations and skips identical refreshes across a restart', async () => {
    temp = await mkdtemp(join(tmpdir(), 'contexo-journal-test-'));
    const log = new RunJournal(temp, error => { throw error; });
    const check = { kind: 'check', externalId: 'build-1', source: 'Jenkins', name: 'Build 1', status: 'running' } as const;
    log.record('fixture', check);
    log.record('fixture', check);
    await log.flush();
    const restarted = new RunJournal(temp, error => { throw error; });
    restarted.record('fixture', check);
    restarted.record('fixture', { ...check, status: 'SUCCESS' });
    const { records } = readReplay(await restarted.read('fixture'));
    expect(records.map(record => [record.sequence, record.evidence.status])).toEqual([[1, 'running'], [2, 'SUCCESS']]);
    await log.close();
    await restarted.close();
  });

  it('migrates readable legacy rows and preserves the original bytes', async () => {
    temp = await mkdtemp(join(tmpdir(), 'contexo-migrate-test-'));
    const legacy = join(temp, 'fixture.jsonl');
    const original = JSON.stringify({
      version: 1, runId: 'fixture', sequence: 1, recordedAt: '2026-11-21T00:00:00.000Z',
      evidence: { kind: 'session', agent: 'fixture' },
    }) + '\n{';
    await writeFile(legacy, original);
    const diagnostics: unknown[] = [];
    const journal = new RunJournal(temp, error => diagnostics.push(error));
    journal.record('fixture', { kind: 'reconciliation', status: 'checked' });
    const { records } = readReplay(await journal.read('fixture'));
    expect(records.map(record => record.sequence)).toEqual([1, 2]);
    expect(await journal.list()).toEqual(['fixture']);
    expect(await import('node:fs/promises').then(fs => fs.readFile(legacy, 'utf8'))).toBe(original);
    expect(diagnostics).toHaveLength(1);
    await journal.close();
  });

  it('resolves indexed SARIF locations, fingerprints and exact ranges', () => {
    const findings = parseSarif({
      version: '2.1.0',
      runs: [{
        tool: { driver: { name: 'fixture' } },
        originalUriBaseIds: { SRC: { uri: 'file:///src/project/' } },
        artifacts: [{ location: { uri: 'src/a%20b.py', uriBaseId: 'SRC' } }],
        results: [{
          ruleId: 'R1', message: { text: 'Finding' }, partialFingerprints: { stable: 'fp' },
          properties: { contexoSide: 'base', contexoSha256: 'hash' },
          locations: [{ physicalLocation: { artifactLocation: { index: 0 }, region: { startLine: 4, startColumn: 2 } } }],
        }],
      }],
    }, 'file:///src/project');
    expect(findings).toEqual([expect.objectContaining({
      location: 'src/a b.py', startLine: 4, endLine: 4, startColumn: 2,
      side: 'base', revision: 'hash', ruleId: 'R1', fingerprints: { stable: 'fp' },
    })]);
  });
});
