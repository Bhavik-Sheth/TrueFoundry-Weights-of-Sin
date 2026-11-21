import { beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Parser } from 'web-tree-sitter';
import { expandOneHop } from '../src/context/assembler';
import { loadParser, parsePython, splitMarkdown, splitRst, SymbolIndex, type IndexApi } from '../src/context/indexer';

const fx = (n: string) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
let parser: Parser;

beforeAll(async () => {
  parser = await loadParser(path.join(__dirname, '..', 'dist')); // needs `npm run build` first
});

describe('parsePython', () => {
  const syms = () => parsePython(parser, 'src/app/sample.py', fx('sample.py'));
  const get = (q: string) => syms().find((s) => s.qualifiedName === q)!;

  it('finds functions, classes and methods qualified by class', () => {
    expect(syms().map((s) => `${s.kind}:${s.qualifiedName}`)).toEqual([
      'function:helper', 'class:Greeter', 'method:Greeter.make', 'method:Greeter.greet', 'function:index',
    ]);
    expect(get('Greeter.greet')).toMatchObject({ startLine: 14, endLine: 15, id: 'src/app/sample.py#Greeter.greet' });
  });
  it('captures decorators (class and function) and range including decorators', () => {
    expect(get('index').decorators).toEqual(['app.route("/x")', 'login_required']);
    expect(get('index').startLine).toBe(18);
    expect(get('Greeter.make').decorators).toEqual(['staticmethod']);
  });
  it('captures call names as the last identifier of attribute calls', () => {
    expect(get('Greeter.greet').calls.sort()).toEqual(['helper', 'upper']);
    expect(get('index').calls.sort()).toEqual(['info', 'render_template']);
  });
  it('captures imports', () => {
    expect(get('helper').imports).toEqual(['os', 'flask', 'Flask', 'cli']);
  });
  it('uses explicit import aliases for cross-package calls, callers and tests', () => {
    const idx = new SymbolIndex();
    const files = {
      'src/shop/runtime/service.py': 'def load():\n    return 1',
      'src/shop/legacy/service.py': 'def load():\n    return 2',
      'src/shop/handlers.py': 'from .runtime.service import load as fetch\nfrom .legacy import service as legacy\ndef handler():\n    return fetch() + legacy.load()',
      'tests/test_handlers.py': 'from shop.runtime.service import load as fetch\ndef test_current():\n    assert fetch() == 1',
    };
    for (const [file, text] of Object.entries(files)) idx.setFile(file, parsePython(parser, file, text));
    const index: IndexApi = {
      ready: Promise.resolve(), symbols: () => idx.symbols(), inFile: file => idx.inFile(file),
      byName: name => idx.byName(name), enclosing: (file, line) => idx.enclosing(file, line),
      reindexFile: async () => {}, reindexAll: async () => {},
    };
    const handler = index.inFile('src/shop/handlers.py')[0];
    expect(handler.boundCalls).toEqual([
      { spelling: 'fetch', module: '.runtime.service', name: 'load' },
      { spelling: 'load', module: '.legacy.service', name: 'load' },
    ]);
    const candidate = (path: keyof typeof files) => {
      const symbol = index.inFile(path)[0];
      return { ...symbol, category: 'impl' as const, reasons: [], score: 1 };
    };
    const edges = expandOneHop([candidate('src/shop/handlers.py')], index);
    expect(edges.find(edge => edge.name === 'calls')?.items.map(item => item.path)).toEqual([
      'src/shop/runtime/service.py', 'src/shop/legacy/service.py',
    ]);
    const reverse = expandOneHop([candidate('src/shop/runtime/service.py')], index);
    expect(reverse.find(edge => edge.name === 'called-by')?.items.map(item => item.path)).toEqual(['src/shop/handlers.py']);
    expect(reverse.find(edge => edge.name === 'tests')?.items.map(item => item.path)).toEqual(['tests/test_handlers.py']);
  });
  it('marks test_ functions in tests/ as kind test', () => {
    const t = parsePython(parser, 'tests/test_x.py', fx('sample_tests.py'));
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ kind: 'test', name: 'test_index', startLine: 1, endLine: 2 });
    expect(parsePython(parser, 'src/test_x.py', 'def test_a():\n    pass\n')[0].kind).toBe('test');
    expect(parsePython(parser, 'lib/x.py', 'def test_a():\n    pass\n')[0].kind).toBe('function');
  });
});

describe('doc sections', () => {
  it('splits rst on underlines and overline/underline titles', () => {
    const s = splitRst('docs/a.rst', fx('sample.rst'));
    expect(s.map((x) => [x.name, x.startLine, x.endLine, x.kind])).toEqual([
      ['Intro Title', 1, 5, 'doc'], ['Sub Section', 6, 10, 'doc'], ['Overlined', 11, 15, 'doc'],
    ]);
  });
  it('splits markdown on # headings, ignoring fenced code', () => {
    const s = splitMarkdown('README.md', fx('sample.md'));
    expect(s.map((x) => x.name)).toEqual(['Top', 'Second']);
  });
});

describe('SymbolIndex', () => {
  it('looks up by name, file and enclosing line, and replaces a file on reindex', () => {
    const idx = new SymbolIndex();
    idx.setFile('src/app/sample.py', parsePython(parser, 'src/app/sample.py', fx('sample.py')));
    expect(idx.byName('GREET')[0].qualifiedName).toBe('Greeter.greet');
    expect(idx.enclosing('src/app/sample.py', 15)?.qualifiedName).toBe('Greeter.greet');
    expect(idx.enclosing('src/app/sample.py', 1)).toBeUndefined();
    idx.setFile('src/app/sample.py', []);
    expect(idx.byName('greet')).toEqual([]);
    expect(idx.symbols()).toEqual([]);
  });
});

it('follows chained Python re-exports across packages and drops the edge after the export changes', () => {
  const index = new SymbolIndex();
  index.setText(parser, 'src/api/__init__.py', 'from .public import service as exported\n');
  index.setText(parser, 'src/api/public.py', 'from internal.worker import run as service\n');
  index.setText(parser, 'src/internal/worker.py', 'def run():\n    return 1\n');
  index.setText(parser, 'src/competing.py', 'def run():\n    return 2\n');
  expect(index.resolveReexport('tests/test_api.py', 'api', 'exported')?.path).toBe('src/internal/worker.py');
  index.setText(parser, 'src/api/public.py', 'from api import exported as service\n');
  expect(index.resolveReexport('tests/test_api.py', 'api', 'exported')).toBeUndefined();
});
