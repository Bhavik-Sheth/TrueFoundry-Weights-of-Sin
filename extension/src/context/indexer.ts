/**
 * context/indexer.ts - C3 Python symbol and doc index.
 *
 * Exports:
 *  - IndexApi: ready, symbols(), byName(name), inFile(path), enclosing(path, line), reindexFile(path), reindexAll().
 *  - startIndexing(): walks *.py, *.rst, *.md (VS Code's bundled ripgrep --files, honouring .gitignore), parses
 *    Python with web-tree-sitter into SymbolEntry, splits docs into heading sections, works in chunks of 20 files
 *    with setImmediate yields, re-indexes a file on save. Logs counts and duration when ready.
 *  - Pure (no vscode) helpers, unit-tested: loadParser(wasmDir), parsePython(parser, path, text),
 *    splitRst(path, text), splitMarkdown(path, text), indexText(parser, path, text), class SymbolIndex.
 *
 * Lines in SymbolEntry are 1-based inclusive; paths are workspace-relative POSIX.
 * Rules: search must work before the index is ready (ripgrep only). vscode and log are loaded lazily so the
 * pure helpers import under Vitest. When bundled into dist/extension.js the wasm files sit next to it (__dirname).
 * Depends on: web-tree-sitter, search (rg path), types. Depended on by: context/assembler, review/guards, mcp/tools.
 */
import { workspaceRoot, hasNativeFiles } from '../shell/workspaceRoot';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import type { Node, Parser } from 'web-tree-sitter';
import type { SymbolEntry } from '../types';
import { resolveRgPath } from './search';

export interface IndexApi {
  ready: Promise<void>;
  symbols(): SymbolEntry[];
  byName(n: string): SymbolEntry[];
  inFile(p: string): SymbolEntry[];
  enclosing(p: string, line: number): SymbolEntry | undefined;
  languageLinks?(sources: SymbolEntry[]): Promise<Array<{ source: SymbolEntry; target: SymbolEntry; kind: 'calls' | 'called-by' }>>;
  resolveReexport?(source: string, module: string, name: string): SymbolEntry | undefined;
  reindexFile(p: string): Promise<void>;
  reindexAll(): Promise<void>;
}

function log(...args: unknown[]): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('../log').log(...args);
  } catch {
    console.debug(...args);
  }
}

const MAX_TEXT = 6000;
const CHUNK = 20;

// ---------------------------------------------------------------- pure parsing

export async function loadParser(wasmDir: string = __dirname): Promise<Parser> {
  // require() (not import) so esbuild's cjs bundle picks the package's .cjs build; the ESM build needs import.meta.url.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Parser, Language } = require('web-tree-sitter') as typeof import('web-tree-sitter');
  await Parser.init({ locateFile: (name: string) => path.join(wasmDir, name) });
  const lang = await Language.load(path.join(wasmDir, 'tree-sitter-python.wasm'));
  const p = new Parser();
  p.setLanguage(lang);
  return p;
}

const isTestPath = (p: string) => /(^|\/)tests?\//.test(p) || /(^|\/)test_[^/]*\.py$/.test(p);

function lastIdent(fn: Node | null): string | undefined {
  if (!fn) return undefined;
  if (fn.type === 'identifier') return fn.text;
  if (fn.type === 'attribute') return fn.childForFieldName('attribute')?.text;
  return undefined;
}

type BoundCall = NonNullable<SymbolEntry['boundCalls']>[number];
type ImportBinding = { module: string; imported?: string };

function importBindings(root: Node): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();
  for (const node of root.namedChildren) {
    if (node.type !== 'import_statement' && node.type !== 'import_from_statement') continue;
    const from = node.childForFieldName('module_name')?.text;
    for (const entry of node.childrenForFieldName('name')) {
      const dotted = entry.childForFieldName('name')?.text ?? entry.text;
      if (!/^[A-Za-z_][\w.]*$/.test(dotted)) continue;
      const alias = entry.childForFieldName('alias')?.text;
      if (from) bindings.set(alias ?? dotted, { module: from, imported: dotted });
      else if (alias) bindings.set(alias, { module: dotted });
      else bindings.set(dotted.split('.')[0], { module: dotted.split('.')[0] });
    }
  }
  return bindings;
}

/** Call names inside a symbol, excluding nested definitions. Explicit imports carry a module hint. */
function collectCalls(node: Node, out: Set<string>, bindings: Map<string, ImportBinding>, bound: Map<string, BoundCall>): void {
  for (const child of node.namedChildren) {
    if (['function_definition', 'class_definition', 'decorated_definition'].includes(child.type)) continue;
    if (child.type === 'call') {
      const callee = child.childForFieldName('function');
      const spelling = lastIdent(callee);
      if (spelling && callee) {
        out.add(spelling);
        const names = callee.text.split('.');
        if (names.every(name => /^[A-Za-z_]\w*$/.test(name))) {
          const imported = bindings.get(names[0]);
          if (imported && (names.length > 1 || imported.imported)) {
            const path = (imported.imported ? [imported.imported, ...names.slice(1)] : names.slice(1)).join('.');
            const split = path.lastIndexOf('.');
            const suffix = split < 0 ? '' : path.slice(0, split);
            const joiner = imported.module.endsWith('.') ? '' : '.';
            const module = suffix ? imported.module + joiner + suffix : imported.module;
            const name = path.slice(split + 1);
            bound.set(JSON.stringify([spelling, module, name]), { spelling, module, name });
          }
        }
      }
    }
    collectCalls(child, out, bindings, bound);
  }
}

function importNames(n: Node): string[] {
  const out: string[] = [];
  if (n.type === 'import_statement') {
    for (const c of n.namedChildren) {
      if (c.type === 'dotted_name') out.push(c.text);
      else if (c.type === 'aliased_import') out.push(c.childForFieldName('name')?.text ?? c.text);
    }
  } else {
    const mod = n.childForFieldName('module_name')?.text;
    if (mod) out.push(mod);
    for (const c of n.namedChildren) {
      if (c === n.childForFieldName('module_name')) continue;
      if (c.type === 'dotted_name') out.push(c.text);
      else if (c.type === 'aliased_import') out.push(c.childForFieldName('name')?.text ?? c.text);
      else if (c.type === 'wildcard_import') out.push('*');
    }
  }
  return out;
}

/** Python symbols (functions, classes, methods qualified by class, tests) from source text. */
export function parsePython(parser: Parser, relPath: string, text: string, onImports?: (bindings: Map<string, ImportBinding>) => void): SymbolEntry[] {
  const tree = parser.parse(text);
  if (!tree) return [];
  const root = tree.rootNode;
  const imports = new Set<string>();
  for (const c of root.namedChildren) if (c.type === 'import_statement' || c.type === 'import_from_statement') importNames(c).forEach((i) => imports.add(i));
  const fileImports = [...imports];
  const bindings = importBindings(root);
  onImports?.(bindings);
  const lines = text.split('\n');
  const out: SymbolEntry[] = [];
  const seen = new Set<string>();
  const testFile = isTestPath(relPath);

  const visit = (node: Node, classStack: string[], inFunc: boolean): void => {
    for (const child of node.namedChildren) {
      let def = child;
      const decorators: string[] = [];
      if (child.type === 'decorated_definition') {
        for (const d of child.namedChildren) if (d.type === 'decorator') decorators.push(d.text.replace(/^@\s*/, ''));
        const inner = child.childForFieldName('definition');
        if (!inner) continue;
        def = inner;
      }
      if (def.type === 'function_definition' || def.type === 'class_definition') {
        const name = def.childForFieldName('name')?.text;
        const body = def.childForFieldName('body');
        if (name && body) {
          const isClass = def.type === 'class_definition';
          const qualified = [...classStack, name].join('.');
          const startLine = child.startPosition.row + 1;
          const endLine = child.endPosition.row + 1;
          const calls = new Set<string>();
          const bound = new Map<string, BoundCall>();
          collectCalls(body, calls, bindings, bound);
          let kind: SymbolEntry['kind'] = isClass ? 'class' : classStack.length && !inFunc ? 'method' : 'function';
          if (!isClass && name.startsWith('test_') && testFile) kind = 'test';
          let id = `${relPath}#${qualified}`;
          if (seen.has(id)) id += `@${startLine}`;
          seen.add(id);
          out.push({
            id, path: relPath, name, qualifiedName: qualified, kind, startLine, endLine, decorators,
            calls: [...calls], boundCalls: bound.size ? [...bound.values()] : undefined, imports: fileImports, text: lines.slice(startLine - 1, endLine).join('\n').slice(0, MAX_TEXT),
          });
          if (isClass) visit(body, [...classStack, name], false);
          else if (!inFunc) visit(body, classStack, true);
          continue;
        }
      }
      // descend into if/try/with blocks etc. at module/class level
      if (!inFunc) visit(child, classStack, inFunc);
    }
  };
  visit(root, [], false);
  tree.delete();
  return out;
}

function docEntries(
  relPath: string,
  lines: string[],
  heads: Array<{ title: string; line: number; bodyStart: number }>,
): SymbolEntry[] {
  return heads.map((h, i) => {
    const endLine = i + 1 < heads.length ? heads[i + 1].line - 1 : lines.length;
    return {
      id: `${relPath}#${h.title}${heads.slice(0, i).some((x) => x.title === h.title) ? `@${h.line}` : ''}`,
      path: relPath, name: h.title, qualifiedName: h.title, kind: 'doc' as const,
      startLine: h.line, endLine: Math.max(endLine, h.line), decorators: [], calls: [], imports: [],
      text: lines.slice(h.line - 1, Math.max(endLine, h.line)).join('\n').slice(0, MAX_TEXT),
    };
  });
}

const RST_ADORN = /^([=\-~^"'`#*+:._<>])\1{2,}\s*$/;

/** .rst sections: a title line followed by an underline (optionally also overlined) of repeated punctuation. */
export function splitRst(relPath: string, text: string): SymbolEntry[] {
  const lines = text.split(/\r?\n/);
  const heads: Array<{ title: string; line: number; bodyStart: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i];
    if (!cur.trim()) continue;
    // overline + title + underline
    if (RST_ADORN.test(cur) && i + 2 < lines.length && lines[i + 1].trim() && !RST_ADORN.test(lines[i + 1])
      && lines[i + 2].trim() === cur.trim()) {
      heads.push({ title: lines[i + 1].trim(), line: i + 1, bodyStart: i + 3 });
      i += 2;
      continue;
    }
    const next = lines[i + 1];
    if (next !== undefined && !RST_ADORN.test(cur) && !/^\s/.test(cur) && RST_ADORN.test(next)
      && next.trim().length >= cur.trim().length && !cur.startsWith('..')) {
      heads.push({ title: cur.trim(), line: i + 1, bodyStart: i + 2 });
      i += 1;
    }
  }
  if (lines[lines.length - 1] === '') lines.pop();
  return docEntries(relPath, lines, heads);
}

/** .md sections on # headings (fenced code ignored). */
export function splitMarkdown(relPath: string, text: string): SymbolEntry[] {
  const lines = text.split(/\r?\n/);
  const heads: Array<{ title: string; line: number; bodyStart: number }> = [];
  let fence = false;
  lines.forEach((l, i) => {
    if (/^\s{0,3}(```|~~~)/.test(l)) { fence = !fence; return; }
    if (fence) return;
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(l);
    if (m) heads.push({ title: m[1], line: i + 1, bodyStart: i + 1 });
  });
  if (lines[lines.length - 1] === '') lines.pop();
  return docEntries(relPath, lines, heads);
}

/** Dispatch by extension; unknown extensions yield nothing. */
export function indexText(parser: Parser | undefined, relPath: string, text: string): SymbolEntry[] {
  if (relPath.endsWith('.py')) return parser ? parsePython(parser, relPath, text) : [];
  if (relPath.endsWith('.rst')) return splitRst(relPath, text);
  if (relPath.endsWith('.md')) return splitMarkdown(relPath, text);
  return [];
}

/** Pure in-memory index with the IndexApi lookups. */
export class SymbolIndex {
  private files = new Map<string, SymbolEntry[]>();
  private names = new Map<string, SymbolEntry[]>();
  private flat: SymbolEntry[] | undefined;
  private exports = new Map<string, Map<string, ImportBinding>>();
  private modules?: Map<string, string[]>;

  setText(parser: Parser | undefined, file: string, text: string) {
    if (!file.endsWith('.py') || !parser) {
      this.setFile(file, indexText(parser, file, text));
      return;
    }
    let bindings: Map<string, ImportBinding> | undefined;
    const entries = parsePython(parser, file, text, imports => { bindings = imports; });
    this.setFile(file, entries);
    if (bindings?.size) this.exports.set(file, bindings);
  }

  resolveReexport(source: string, module: string, name: string): SymbolEntry | undefined {
    if (!this.modules) {
      this.modules = new Map();
      for (const file of this.files.keys()) {
        if (!file.endsWith('.py')) continue;
        const stem = file.replace(/(?:\/__init__)?\.py$/, '');
        const parts = stem.split('/');
        for (let i = 0; i < parts.length; i++) {
          const key = parts.slice(i).join('/');
          const files = this.modules.get(key) ?? [];
          files.push(file);
          this.modules.set(key, files);
        }
      }
    }
    let importing = source;
    let currentModule = module;
    let exported = name;
    const visited = new Set<string>();
    for (let depth = 0; depth < 8; depth++) {
      const relative = /^\.+/.exec(currentModule)?.[0].length ?? 0;
      const normalized = currentModule.slice(relative).replace(/\./g, '/');
      const key = relative ? path.posix.join(path.posix.dirname(importing),
        ...Array<string>(relative - 1).fill('..'), normalized) : normalized;
      const matches = this.modules.get(key) ?? [];
      const files = relative ? matches.filter(file => file.replace(/(?:\/__init__)?\.py$/, '') === key) : matches;
      if (files.length !== 1) return undefined;
      const [file] = files;
      const marker = JSON.stringify([file, exported]);
      if (visited.has(marker)) return undefined;
      visited.add(marker);
      const target = this.inFile(file).filter(entry => entry.qualifiedName === exported);
      if (depth > 0 && target.length === 1) return target[0];
      if (target.length) return undefined;
      const next = this.exports.get(file)?.get(exported);
      if (!next?.imported) return undefined;
      importing = file;
      currentModule = next.module;
      exported = next.imported;
    }
    return undefined;
  }

  setFile(p: string, entries: SymbolEntry[]): void {
    this.removeFile(p);
    this.files.set(p, entries);
    for (const e of entries) {
      const k = e.name.toLowerCase();
      const a = this.names.get(k);
      if (a) a.push(e); else this.names.set(k, [e]);
    }
    this.flat = undefined;
    this.modules = undefined;
  }
  removeFile(p: string): void {
    const old = this.files.get(p);
    if (!old) return;
    for (const e of old) {
      const k = e.name.toLowerCase();
      const a = (this.names.get(k) ?? []).filter((x) => x !== e);
      if (a.length) this.names.set(k, a); else this.names.delete(k);
    }
    this.files.delete(p);
    this.exports.delete(p);
    this.modules = undefined;
    this.flat = undefined;
  }
  clear(): void { this.files.clear(); this.names.clear(); this.exports.clear(); this.flat = undefined; this.modules = undefined; }
  symbols(): SymbolEntry[] { return (this.flat ??= [...this.files.values()].flat()); }
  byName(n: string): SymbolEntry[] { return this.names.get(n.toLowerCase()) ?? []; }
  inFile(p: string): SymbolEntry[] { return this.files.get(p) ?? []; }
  fileCount(): number { return this.files.size; }
  /** Smallest symbol (by line span) containing `line` (1-based). */
  enclosing(p: string, line: number): SymbolEntry | undefined {
    let best: SymbolEntry | undefined;
    for (const e of this.inFile(p)) {
      if (e.startLine <= line && line <= e.endLine
        && (!best || e.endLine - e.startLine < best.endLine - best.startLine)) best = e;
    }
    return best;
  }
}

// ---------------------------------------------------------------- vscode-bound driver

function listFiles(rgPath: string, cwd: string): Promise<string[]> {
  return new Promise((resolve) => {
    const args = ['--files', '-g', '*.py', '-g', '*.rst', '-g', '*.md', '-g', '*.{ts,tsx,js,jsx,go,rs,java}', '-g', '!node_modules', '-g', '!.venv', '-g', '!venv'];
    const child = spawn(rgPath, args, { cwd, windowsHide: true });
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    child.on('error', (e) => { log('[index] rg failed', String(e)); resolve([]); });
    child.on('close', () => resolve(out.split(/\r?\n/).filter(Boolean).map((p) => p.replace(/\\/g, '/'))));
  });
}

export function startIndexing(): IndexApi {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const vs = require('vscode') as typeof import('vscode');
  const idx = new SymbolIndex();
  let parser: Parser | undefined;
  const root = () => {
    const uri = workspaceRoot()?.uri;
    return uri && hasNativeFiles(uri) ? uri.fsPath : undefined;
  };

  const indexOne = async (rel: string): Promise<void> => {
    const r = root();
    if (!r) return;
    try {
      const text = await fs.promises.readFile(path.join(r, rel), 'utf8');
      if (/\.(ts|tsx|js|jsx|go|rs|java)$/.test(rel)) {
        const uri = vs.Uri.joinPath(workspaceRoot()!.uri, ...rel.split('/'));
        const symbols = await vs.commands.executeCommand<import('vscode').DocumentSymbol[]>(
          'vscode.executeDocumentSymbolProvider', uri);
        const entries: SymbolEntry[] = [];
        const lines = text.split(/\r?\n/);
        const visit = (symbol: import('vscode').DocumentSymbol, parent: string) => {
          const qualifiedName = parent ? parent + '.' + symbol.name : symbol.name;
          const kind = symbol.kind === vs.SymbolKind.Class ? 'class'
            : symbol.kind === vs.SymbolKind.Function ? 'function'
            : symbol.kind === vs.SymbolKind.Method ? 'method' : undefined;
          if (kind) {
            const startLine = symbol.range.start.line + 1;
            const endLine = symbol.range.end.line + 1;
            entries.push({ id: rel + ':' + startLine + ':' + qualifiedName, path: rel, name: symbol.name,
              qualifiedName, kind, startLine, endLine, calls: [], decorators: [], imports: [],
              text: lines.slice(startLine - 1, endLine).join('\n') });
          }
          for (const child of symbol.children ?? []) visit(child, qualifiedName);
        };
        for (const symbol of symbols ?? []) visit(symbol, '');
        if (root() === r) idx.setFile(rel, entries);
      } else {
        if (root() === r) idx.setText(parser, rel, text);
      }
    } catch {
      if (root() === r) idx.removeFile(rel); // deleted or unreadable
    }
  };

  const indexCurrent = async (): Promise<void> => {
    idx.clear();
    const r = root();
    if (!r) return;
    const t0 = Date.now();
    parser ??= await loadParser().catch((e) => { log('[index] tree-sitter failed to load; docs only', String(e)); return undefined; });
    const rg = resolveRgPath(vs.env.appRoot);
    const files = await listFiles(rg, r);
    if (root() !== r) return;
    for (let i = 0; i < files.length; i += CHUNK) {
      if (root() !== r) return;
      await Promise.all(files.slice(i, i + CHUNK).map(indexOne));
      vs.window.setStatusBarMessage(`Contexo: indexing ${Math.min(i + CHUNK, files.length)}/${files.length}`, 1500);
      await new Promise<void>((res) => setImmediate(res));
    }
    const all = idx.symbols();
    log(`[index] ready: ${idx.fileCount()} files, ${all.filter((s) => s.kind !== 'doc').length} symbols, ${all.filter((s) => s.kind === 'doc').length} doc sections in ${Date.now() - t0} ms`);
  };

  let ready = Promise.resolve();
  const reindexAll = () => {
    idx.clear();
    ready = ready.then(indexCurrent).catch(error => log('[index] failed', String(error)));
    return ready;
  };
  void reindexAll();

  vs.workspace.onDidSaveTextDocument((doc) => {
    const r = root();
    if (!r || !hasNativeFiles(doc.uri) || vs.workspace.getWorkspaceFolder(doc.uri)?.uri.toString() !== workspaceRoot()?.uri.toString()) return;
    const rel = path.relative(r, doc.uri.fsPath).replace(/\\/g, '/');
    if (rel.startsWith('..') || !/\.(py|rst|md|ts|tsx|js|jsx|go|rs|java)$/.test(rel)) return;
    void ready.then(() => root() === r ? indexOne(rel) : undefined);
  });

  const languageLinks: NonNullable<IndexApi['languageLinks']> = async sources => {
    const folder = workspaceRoot();
    if (!folder) return [];
    const abs = folder.uri.fsPath;
    const candidates = sources.filter(source => /\.(go|rs|java|[jt]sx?)$/.test(source.path)).slice(0, 3);
    if (!candidates.length) return [];
    const entryAt = (uri: import('vscode').Uri, line: number) => {
      if (uri.scheme !== folder.uri.scheme || uri.authority !== folder.uri.authority) return undefined;
      const rel = path.relative(abs, uri.fsPath).replace(/\\/g, '/');
      if (!rel || rel.startsWith('../') || path.isAbsolute(rel)) return undefined;
      return idx.enclosing(rel, line + 1);
    };
    const gather = async (): ReturnType<NonNullable<IndexApi['languageLinks']>> =>
      (await Promise.all(candidates.map(async source => {
        const uri = vs.Uri.joinPath(folder.uri, ...source.path.split('/'));
        const header = source.text.split('\n', 10);
        const row = header.findIndex(line => line.includes(source.name));
        const position = new vs.Position(source.startLine - 1 + Math.max(row, 0),
          row >= 0 ? header[row].indexOf(source.name) : 0);
        const items = await vs.commands.executeCommand<import('vscode').CallHierarchyItem[]>(
          'vscode.prepareCallHierarchy', uri, position);
        const item = items?.[0];
        if (!item) return [];
        const [incoming, outgoing] = await Promise.allSettled([
          vs.commands.executeCommand<import('vscode').CallHierarchyIncomingCall[]>('vscode.provideIncomingCalls', item),
          vs.commands.executeCommand<import('vscode').CallHierarchyOutgoingCall[]>('vscode.provideOutgoingCalls', item),
        ]);
        const targets = [
          ...(incoming.status === 'fulfilled' ? (incoming.value ?? []).slice(0, 5).map(call =>
            ({ endpoint: call.from, kind: 'called-by' as const })) : []),
          ...(outgoing.status === 'fulfilled' ? (outgoing.value ?? []).slice(0, 5).map(call =>
            ({ endpoint: call.to, kind: 'calls' as const })) : []),
        ];
        return targets.flatMap(({ endpoint, kind }) => {
          const target = entryAt(endpoint.uri, endpoint.selectionRange.start.line);
          return target && target.id !== source.id ? [{ source, target, kind }] : [];
        });
      }).map(task => task.catch(() => [])))).flat();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const links = await Promise.race([gather(), new Promise<[]>(resolve => { timer = setTimeout(() => resolve([]), 800); })]);
      return workspaceRoot()?.uri.toString() === folder.uri.toString() ? links : [];
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    get ready() { return ready; },
    languageLinks,
    symbols: () => idx.symbols(),
    byName: (n) => idx.byName(n),
    inFile: (p) => idx.inFile(p),
    enclosing: (p, line) => idx.enclosing(p, line),
    resolveReexport: (source, module, name) => idx.resolveReexport(source, module, name),
    reindexFile: (p) => indexOne(p.replace(/\\/g, '/')),
    reindexAll,
  };
}
