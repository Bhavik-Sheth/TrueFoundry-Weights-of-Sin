import type { Node, Parser } from 'web-tree-sitter';
import { loadParser, parsePython } from '../context/indexer';
import type { Proposal, SymbolEntry } from '../types';
import { rebuildFile } from './proposal';

export const moduleOf = (path: string) => path.replace(/^src\//, '').replace(/\.py$/, '').replace(/\/__init__$/, '').replaceAll('/', '.');

function importedNames(root: Node, path: string) {
  const aliases = new Map<string, string>();
  for (const statement of root.namedChildren) {
    if (!['import_statement', 'import_from_statement'].includes(statement.type)) continue;
    const module = statement.childForFieldName('module_name');
    let prefix = module?.text ?? '';
    if (prefix.startsWith('.')) {
      const dots = prefix.match(/^\.+/)![0].length;
      const parts = moduleOf(path).split('.');
      if (!path.endsWith('/__init__.py')) parts.pop();
      parts.splice(Math.max(0, parts.length - dots + 1));
      prefix = [...parts, prefix.slice(dots)].filter(Boolean).join('.');
    }
    for (const child of statement.childrenForFieldName('name')) {
      const name = child.childForFieldName('name')?.text ?? child.text;
      const alias = child.childForFieldName('alias')?.text;
      if (module) aliases.set(alias ?? name, prefix + '.' + name);
      else aliases.set(alias ?? name.split('.')[0], alias ? name : name.split('.')[0]);
    }
  }
  return aliases;
}

function calls(parser: Parser, path: string, text: string, definitions: Map<string, SymbolEntry[]>) {
  const tree = parser.parse(text);
  const result = new Map<string, { path: string; symbol: string; kind: 'call' | 'import'; target: string; definition?: { path: string; line: number } }>();
  if (!tree) return result;
  try {
    const aliases = importedNames(tree.rootNode, path);
    const scopes: string[] = [];
    function edge(kind: 'call' | 'import', target: string, qualified?: string) {
      const possible = qualified ? definitions.get(qualified) : undefined;
      const definition = possible?.length === 1 ? { path: possible[0].path, line: possible[0].startLine } : undefined;
      const value = { path, symbol: scopes.join('.') || '<module>', kind, target: qualified ?? target, definition };
      // Moving a definition by a line does not change the dependency.
      result.set(JSON.stringify([path, value.symbol, kind, value.target, definition?.path]), value);
    }
    for (const target of aliases.values()) edge('import', target, target);
    function visit(n: Node) {
      const scope = ['function_definition','class_definition'].includes(n.type) && n.childForFieldName('name')?.text;
      if (scope) scopes.push(scope);
      if (n.type === 'call') {
        const name = n.childForFieldName('function')?.text ?? '';
        if (/^[\w.]+$/.test(name)) {
          const [head, ...rest] = name.split('.');
          const imported = aliases.get(head);
          const local = moduleOf(path) + '.' + name;
          edge('call', name, imported ? [imported, ...rest].join('.') : definitions.has(local) ? local : undefined);
        }
      }
      for (const c of n.namedChildren) visit(c);
      if (scope) scopes.pop();
    }
    visit(tree.rootNode);
    return result;
  } finally { tree.delete(); }
}

export async function compareProposalImpact(proposal: Proposal, workspaceSymbols: SymbolEntry[] = []) {
  const parser = await loadParser();
  try {
    const files = proposal.files.filter(file => file.path.endsWith('.py'));
    const changed = new Set(files.map(f => f.path));
    function edges(side: 'base' | 'candidate') {
      const snapshots = files.map(f => ({ path: f.path, text: side === 'base' ? f.base : rebuildFile(f.base, f.path, proposal.hunks) }));
      const symbols = [...workspaceSymbols.filter(s => !changed.has(s.path)),
        ...snapshots.flatMap(f => parsePython(parser, f.path, f.text))];
      const definitions = new Map<string, SymbolEntry[]>();
      for (const s of symbols) {
        const key = moduleOf(s.path) + '.' + s.qualifiedName;
        const existing = definitions.get(key);
        if (existing) existing.push(s); else definitions.set(key, [s]);
      }
      return new Map(snapshots.flatMap(f => [...calls(parser, f.path, f.text, definitions)]));
    }
    const before = edges('base');
    const after = edges('candidate');
    return {
      analysis: 'Python static calls and imports; definition links inferred from module names',
      files: files.map(f => f.path),
      omitted: proposal.files.filter(f => !changed.has(f.path)).map(f => f.path),
      added: [...after].filter(([id]) => !before.has(id)).map(([, edge]) => edge),
      removed: [...before].filter(([id]) => !after.has(id)).map(([, edge]) => edge),
    };
  } finally { parser.delete(); }
}
