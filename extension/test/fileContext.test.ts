import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { prepareContextForModel } from '../src/context/assembler';
import { fileContextReader } from '../src/context/fileContext';
import type { IndexApi } from '../src/context/indexer';
import type { ContextPacket, SymbolEntry } from '../src/types';

let root: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const oldSource = 'def parse(value):\n    return value\n' + '# stable detail\n'.repeat(20);
const headSource = oldSource.replace('return value', 'return value.strip()');
const liveSource = headSource.replace('value.strip()', 'value.strip().lower()');

const symbol: SymbolEntry = {
  id: 'parse', path: 'parse.py', name: 'parse', qualifiedName: 'parse', kind: 'function',
  startLine: 1, endLine: 2, decorators: [], calls: [], imports: [], text: headSource,
};
const index: IndexApi = {
  ready: Promise.resolve(), symbols: () => [symbol], byName: () => [symbol],
  inFile: file => file === 'parse.py' ? [symbol] : [], enclosing: () => undefined,
  reindexFile: async () => {}, reindexAll: async () => {},
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'contexo-history-'));
  git('init', '-q');
  git('config', 'user.name', 'Contexo test');
  git('config', 'user.email', 'contexo@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'original.py'), oldSource);
  git('add', '.');
  git('commit', '-qm', 'Introduce parser');
  git('mv', 'src/original.py', 'src/parse.py');
  await writeFile(path.join(root, 'src', 'parse.py'), headSource);
  git('commit', '-qam', 'Trim input before parsing');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test('traces a renamed file from the editor buffer to HEAD and to its previous path', async () => {
  const reader = fileContextReader(path.join(root, 'src'), index, () => liveSource);
  const record = await reader.inspect({ path: 'parse.py' });
  expect(record).toMatchObject({
    source: 'editor buffer', symbolCount: 1, symbols: [{ name: 'parse', start: 1, end: 2 }],
    lastCommit: { subject: 'Trim input before parsing', previousPath: 'original.py' },
    changes: { status: 'modified', added: 1, removed: 1, hunks: [{ lines: [
      '-    return value.strip()', '+    return value.strip().lower()',
    ] }] },
    previousChanges: { status: 'modified', added: 1, removed: 1, hunks: [{ lines: [
      '-    return value', '+    return value.strip()',
    ] }] },
  });
  await expect(reader.inspect({ path: 'parse.py', version: 'previous', startLine: 2, endLine: 2 }))
    .resolves.toMatchObject({ historicalPath: 'original.py', text: '    return value\n', startLine: 2, endLine: 2 });
  await expect(reader.inspect({ path: 'parse.py', version: 'head', startLine: 100 })).resolves
    .toMatchObject({ status: 'empty_range', totalLines: 22 });
  await expect(reader.inspect({ path: 'parse.py', version: 'head', startLine: 2, endLine: 1 })).rejects.toThrow('endLine');
  await expect(reader.inspect({ path: '../.git/config', version: 'head' })).rejects.toThrow('PATH_INVALID');
});

test('reports untracked files and records a ranked, bounded file map in the model response', async () => {
  const folder = path.join(root, 'src');
  const reader = fileContextReader(folder, index, file => file === path.join(folder, 'parse.py') ? liveSource : undefined);
  const names = Array.from({ length: 28 }, (_, number) => `helper${number}.py`);
  await Promise.all(names.map(file => writeFile(path.join(folder, file), 'value = 1\n')));
  expect(await reader.inspect({ path: names[0] })).toMatchObject({
    changes: { status: 'added', added: 1, removed: 0 },
  });
  const packet: ContextPacket = {
    id: 'packet', runId: 'run', query: 'Review normalization', budget: 8000, used: 140, omitted: [], graph: { nodes: [], edges: [] },
    excerpts: ['parse.py', ...names].map((file, i) => ({
      id: file, path: file, category: 'impl', score: 100 - i, startLine: 1, endLine: 1,
      tokens: 5, text: i === 0 ? liveSource.split('\n')[0] : 'value = 1',
      reasons: i === 0 ? [{ kind: 'selection' }] : [{ kind: 'calls', from: 'parse' }],
    })),
  };
  await reader.addToPacket(packet);
  expect(packet.files?.map(file => file.path)).toEqual(['parse.py', ...names.slice(0, 7)]);
  const { text, delivery } = prepareContextForModel(packet);
  expect(text).toContain('parse.py · needed for: selection');
  expect(text).toContain('Trim input before parsing');
  expect(text).toContain('Current change sample');
  expect(text).toContain('Last commit delta');
  expect(text).toContain('Previous path: "original.py"');
  expect(text).toContain('value.strip().lower()');
  expect(delivery.filePaths).toContain('parse.py');
  expect(delivery.serializedCharacters).toBeLessThanOrEqual(22_000);
});

test('reuses pinned history independently of dirty text and a new HEAD', async () => {
  const folder = path.join(root, 'src');
  const inspect = () => fileContextReader(folder, index).inspect({ path: 'parse.py' });
  expect(await inspect()).toMatchObject({ lastCommit: { subject: 'Trim input before parsing' } });
  await writeFile(path.join(folder, 'parse.py'), liveSource);
  expect(await inspect()).toMatchObject({
    lastCommit: { subject: 'Trim input before parsing' },
    changes: { status: 'modified', added: 1, removed: 1 },
  });
  git('commit', '-qam', 'Normalize input before parsing');
  expect(await inspect()).toMatchObject({
    lastCommit: { subject: 'Normalize input before parsing' },
    changes: { status: 'unchanged' },
    previousChanges: { status: 'modified', added: 1, removed: 1 },
  });
});
