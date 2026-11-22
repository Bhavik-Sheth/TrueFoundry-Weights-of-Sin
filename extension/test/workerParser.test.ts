/**
 * workerParser.test.ts - tests for src/context/workerParser.ts. Needs `npm run build` first (dist/indexWorker.js + wasm).
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { readFile } from 'node:fs/promises';
import { loadParser, parsePython } from '../src/context/indexer';
import { WorkerParser } from '../src/context/workerParser';

const dist = path.join(__dirname, '..', 'dist');

describe('WorkerParser', () => {
  it('matches in-process parsing and returns import bindings', async () => {
    const wp = await WorkerParser.start(path.join(dist, 'indexWorker.js'), dist);
    try {
      const text = await readFile(path.join(__dirname, 'fixtures', 'sample.py'), 'utf8');
      const parser = await loadParser(dist);
      let expected: unknown;
      const local = parsePython(parser, 'sample.py', text, b => { expected = [...b]; });
      expect(await wp.parse('sample.py', text)).toEqual(local);
      expect((await wp.parseFull('sample.py', text)).imports).toEqual(expected);
    } finally {
      await wp.dispose();
    }
  });

  it('rejects when the worker file is missing', async () => {
    await expect(WorkerParser.start(path.join(dist, 'nope.js'), dist)).rejects.toBeTruthy();
  });
});
