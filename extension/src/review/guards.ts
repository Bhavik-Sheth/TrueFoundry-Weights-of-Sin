/**
 * review/guards.ts - C4 symbol check and scope guard.
 *
 * S6 status: REAL symbolCheck, scopeGuard and addedLines; PYTHON_BUILTINS REAL.
 *
 * Exports:
 *  - symbolCheck(files, index, opts?): Promise<string[]> of "MISSING_SYMBOL name @ path:line".
 *    Parses proposed .py files with Tree-sitter; collects bare-name calls and decorator names on '+' lines.
 *    A name passes if defined/imported in the proposed file (incl. defs added in the proposal), a
 *    Python builtin, or bound in an enclosing scope (parameter, local, loop/with/except/comprehension
 *    variable, lambda parameter, class-level name). A name known to the index but not bound in the file
 *    is a violation ("defined in X but not imported"). Files with `from x import *` or syntax errors are
 *    skipped. Attribute calls (x.foo) are ignored. opts.hunks / opts.parser may be injected (tests).
 *  - scopeGuard(hunks, selection): sets outsideSelection from each hunk's base-side changed lines versus the
 *    selection range. Accept stays available.
 *  - addedLines(hunk): 1-based proposed-side line numbers of '+' lines (decorations, CodeLens label).
 *  - PYTHON_BUILTINS: builtin name set.
 *
 * Rules: pure (no vscode import); lexical/structural only; avoid false denials.
 * Depends on: context/indexer (loadParser), review/proposal (buildHunks), web-tree-sitter, types.
 * Depended on by: review/diffView.
 */
import type { Node, Parser } from 'web-tree-sitter';
import type { Hunk, Proposal, Selection } from '../types';
import type { IndexApi } from '../context/indexer';
import { loadParser } from '../context/indexer';
import { buildHunks } from './proposal';

export const PYTHON_BUILTINS: ReadonlySet<string> = new Set([
  'abs', 'aiter', 'all', 'anext', 'any', 'ascii', 'bin', 'bool', 'breakpoint', 'bytearray', 'bytes', 'callable',
  'chr', 'classmethod', 'compile', 'complex', 'delattr', 'dict', 'dir', 'divmod', 'enumerate', 'eval', 'exec',
  'filter', 'float', 'format', 'frozenset', 'getattr', 'globals', 'hasattr', 'hash', 'help', 'hex', 'id', 'input',
  'int', 'isinstance', 'issubclass', 'iter', 'len', 'list', 'locals', 'map', 'max', 'memoryview', 'min', 'next',
  'object', 'oct', 'open', 'ord', 'pow', 'print', 'property', 'range', 'repr', 'reversed', 'round', 'set',
  'setattr', 'slice', 'sorted', 'staticmethod', 'str', 'sum', 'super', 'tuple', 'type', 'vars', 'zip', '__import__',
  // exceptions
  'BaseException', 'BaseExceptionGroup', 'Exception', 'ExceptionGroup', 'ArithmeticError', 'AssertionError',
  'AttributeError', 'BlockingIOError', 'BrokenPipeError', 'BufferError', 'BytesWarning', 'ChildProcessError',
  'ConnectionAbortedError', 'ConnectionError', 'ConnectionRefusedError', 'ConnectionResetError',
  'DeprecationWarning', 'EOFError', 'EncodingWarning', 'EnvironmentError', 'FileExistsError', 'FileNotFoundError',
  'FloatingPointError', 'FutureWarning', 'GeneratorExit', 'IOError', 'ImportError', 'ImportWarning',
  'IndentationError', 'IndexError', 'InterruptedError', 'IsADirectoryError', 'KeyError', 'KeyboardInterrupt',
  'LookupError', 'MemoryError', 'ModuleNotFoundError', 'NameError', 'NotADirectoryError', 'NotImplementedError',
  'OSError', 'OverflowError', 'PendingDeprecationWarning', 'PermissionError', 'ProcessLookupError',
  'RecursionError', 'ReferenceError', 'ResourceWarning', 'RuntimeError', 'RuntimeWarning', 'StopAsyncIteration',
  'StopIteration', 'SyntaxError', 'SyntaxWarning', 'SystemError', 'SystemExit', 'TabError', 'TimeoutError',
  'TypeError', 'UnboundLocalError', 'UnicodeDecodeError', 'UnicodeEncodeError', 'UnicodeError',
  'UnicodeTranslateError', 'UnicodeWarning', 'UserWarning', 'ValueError', 'Warning', 'ZeroDivisionError',
  // constants and others
  'True', 'False', 'None', 'Ellipsis', 'NotImplemented', '__name__', '__file__', '__doc__', '__debug__',
]);

/** Names that are always defined at runtime but missing from the list above. */
const EXTRA_NAMES: ReadonlySet<string> = new Set([
  'exit', 'quit', 'copyright', 'credits', 'license', '__class__', '__builtins__', '__spec__', '__package__',
  '__loader__', '__path__', '__annotations__', '__build_class__', 'WindowsError', 'PythonFinalizationError',
  'reveal_type', 'reveal_locals',
]);

/** 1-based proposed-side line numbers of the '+' lines of a hunk. */
export function addedLines(h: Hunk): number[] {
  const out: number[] = [];
  let n = h.newStart;
  for (const l of h.lines) {
    const c = l[0];
    if (c === '+') out.push(n++);
    else if (c === ' ') n++;
  }
  return out;
}

// ---------------------------------------------------------------- scope guard

/** Whether any change of the hunk lies outside the selection (0-based inclusive lines on the base side). */
function hunkOutside(h: Hunk, sel: Selection): boolean {
  const inRemoved = (l: number) => l >= sel.startLine && l <= sel.endLine;
  // an insertion before base line p (0-based) counts as inside when it touches the selection, incl. right after it
  const inInserted = (p: number) => p >= sel.startLine && p <= sel.endLine + 1;
  let old = h.oldStart; // 1-based
  let sawChange = false;
  for (const l of h.lines) {
    const c = l[0];
    if (c === '-') {
      sawChange = true;
      if (!inRemoved(old - 1)) return true;
      old++;
    } else if (c === '+') {
      sawChange = true;
      if (!inInserted(old - 1)) return true;
    } else if (c === ' ') {
      old++;
    }
  }
  if (sawChange) return false;
  // no line detail: fall back to the hunk's whole old range
  const a = h.oldStart - 1;
  const b = a + Math.max(h.oldLines, 1) - 1;
  return a < sel.startLine || b > sel.endLine;
}

/** Marks hunks whose base-side change falls (partly) outside the selection. */
export function scopeGuard(hunks: Hunk[], sel: Selection): void {
  for (const h of hunks) h.outsideSelection = hunkOutside(h, sel);
}

// ---------------------------------------------------------------- symbol check

function addIdents(n: Node | null, out: Set<string>): void {
  if (!n) return;
  if (n.type === 'identifier') {
    out.add(n.text);
    return;
  }
  if (n.type === 'attribute' || n.type === 'subscript') return;
  for (const c of n.namedChildren) addIdents(c, out);
}

function allIdents(n: Node | null, out: Set<string>): void {
  if (!n) return;
  if (n.type === 'identifier') out.add(n.text);
  for (const i of n.descendantsOfType('identifier')) out.add(i.text);
}

/** Names bound anywhere in the scope owned by `node` (not entering nested defs/classes/lambdas). Lenient: order ignored. */
function collectBindings(node: Node, out: Set<string>): void {
  for (const c of node.namedChildren) {
    switch (c.type) {
      case 'function_definition':
      case 'class_definition': {
        const nm = c.childForFieldName('name');
        if (nm) out.add(nm.text);
        continue;
      }
      case 'lambda':
        continue;
      case 'assignment':
      case 'augmented_assignment':
      case 'for_statement':
      case 'for_in_clause':
        addIdents(c.childForFieldName('left'), out);
        break;
      case 'named_expression':
        addIdents(c.childForFieldName('name'), out);
        break;
      case 'as_pattern':
        addIdents(c.childForFieldName('alias') ?? c.namedChildren[c.namedChildren.length - 1] ?? null, out);
        break;
      case 'import_statement':
      case 'import_from_statement': {
        const mod = c.type === 'import_from_statement' ? c.childForFieldName('module_name') : null;
        for (const i of c.namedChildren) {
          if (mod && i.id === mod.id) continue;
          if (i.type === 'dotted_name') out.add(i.text.split('.')[0]);
          else if (i.type === 'aliased_import') {
            const al = i.childForFieldName('alias');
            out.add(al ? al.text : (i.childForFieldName('name')?.text ?? i.text).split('.')[0]);
          }
        }
        continue;
      }
      case 'global_statement':
      case 'nonlocal_statement':
      case 'case_pattern':
      case 'type_alias_statement':
      case 'type_parameter':
        allIdents(c, out);
        break;
      default:
        break;
    }
    collectBindings(c, out);
  }
}

function findViolations(root: Node, filePath: string, added: Set<number>, index: IndexApi): string[] {
  if (root.descendantsOfType('wildcard_import').length > 0) return []; // star import: names unknowable
  const moduleScope = new Set<string>();
  collectBindings(root, moduleScope);
  for (const g of root.descendantsOfType(['global_statement', 'nonlocal_statement'])) allIdents(g, moduleScope);
  const out: string[] = [];

  const check = (id: Node, scopes: Array<Set<string>>): void => {
    const line = id.startPosition.row + 1;
    if (!added.has(line)) return;
    const name = id.text;
    if (PYTHON_BUILTINS.has(name) || EXTRA_NAMES.has(name)) return;
    if (scopes.some((s) => s.has(name))) return;
    const elsewhere = index.byName(name).find((e) => e.name === name && e.kind !== 'doc' && e.path !== filePath);
    out.push(
      elsewhere
        ? `MISSING_SYMBOL ${name} @ ${filePath}:${line} (defined in ${elsewhere.path} but not imported)`
        : `MISSING_SYMBOL ${name} @ ${filePath}:${line}`,
    );
  };

  const walk = (node: Node, scopes: Array<Set<string>>): void => {
    for (const c of node.namedChildren) {
      if (c.type === 'string') continue; // f-string interpolations are treated as text
      let next = scopes;
      if (c.type === 'function_definition') {
        const s = new Set<string>();
        allIdents(c.childForFieldName('parameters'), s);
        allIdents(c.childForFieldName('type_parameters'), s);
        const body = c.childForFieldName('body');
        if (body) collectBindings(body, s);
        next = [...scopes, s];
      } else if (c.type === 'class_definition') {
        const s = new Set<string>();
        const body = c.childForFieldName('body');
        if (body) collectBindings(body, s);
        next = [...scopes, s];
      } else if (c.type === 'lambda') {
        const s = new Set<string>();
        allIdents(c.childForFieldName('parameters'), s);
        next = [...scopes, s];
      } else if (c.type === 'call') {
        const fn = c.childForFieldName('function');
        if (fn && fn.type === 'identifier') check(fn, scopes);
      } else if (c.type === 'decorator') {
        const d = c.namedChildren[0];
        if (d && d.type === 'identifier') check(d, scopes);
      }
      walk(c, next);
    }
  };
  walk(root, [moduleScope]);
  return out;
}

let sharedParser: Promise<Parser | undefined> | undefined;
function defaultParser(): Promise<Parser | undefined> {
  sharedParser ??= loadParser().catch((e) => {
    console.debug('[guards] tree-sitter unavailable; symbol check skipped', String(e));
    return undefined;
  });
  return sharedParser;
}

/**
 * MISSING_SYMBOL violations for bare-name calls and decorators on '+' lines of .py files.
 * `opts.hunks` are the proposal's hunks (computed from base/proposed when omitted); `opts.parser` injects a parser.
 */
export async function symbolCheck(
  files: Proposal['files'],
  index: IndexApi,
  opts: { hunks?: Hunk[]; parser?: Parser } = {},
): Promise<string[]> {
  const py = files.filter((f) => f.path.endsWith('.py'));
  if (py.length === 0) return [];
  const parser = opts.parser ?? (await defaultParser());
  if (!parser) return [];
  const out: string[] = [];
  for (const f of py) {
    const hunks = opts.hunks ? opts.hunks.filter((h) => h.path === f.path) : buildHunks(f.path, f.base, f.proposed, f.baseHash);
    const added = new Set<number>(hunks.flatMap(addedLines));
    if (added.size === 0) continue;
    const tree = parser.parse(f.proposed);
    if (!tree) continue;
    try {
      if (tree.rootNode.hasError) continue; // syntax we cannot trust; not this check's business
      for (const v of findViolations(tree.rootNode, f.path, added, index)) if (!out.includes(v)) out.push(v);
    } finally {
      tree.delete();
    }
  }
  return out;
}
