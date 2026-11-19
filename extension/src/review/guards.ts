/**
 * review/guards.ts - C4 symbol check and scope guard.
 *
 * S0 status: symbolCheck STUB ([]), scopeGuard STUB (no-op), PYTHON_BUILTINS REAL. Slice 6 fills the rest.
 *
 * Exports:
 *  - symbolCheck(files, index): Promise<string[]> of "MISSING_SYMBOL name @ path:line".
 *    Parses proposed files with Tree-sitter; collects bare-name calls and decorator names on '+' lines.
 *    A name passes if defined/imported in the proposed file (incl. defs added in the proposal), a
 *    Python builtin, known in the workspace index and importable, or a parameter/local of the
 *    enclosing function. Names possibly from star imports are unknown-but-allowed. Dynamic
 *    attributes (x.foo) are skipped.
 *  - scopeGuard(hunks, selection): sets outsideSelection by mapping each hunk's old range against
 *    the selection range. Accept stays available.
 *  - PYTHON_BUILTINS: builtin name set.
 *
 * Rules: pure (no vscode import; stubs log via console.debug); lexical/structural only; avoid false denials.
 * Will load grammars/tree-sitter-python.wasm.
 * Depends on: context/indexer (type), web-tree-sitter, types. Depended on by: review/diffView.
 */
import type { Hunk, Proposal, Selection } from '../types';
import type { IndexApi } from '../context/indexer';

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

export async function symbolCheck(files: Proposal['files'], index: IndexApi): Promise<string[]> {
  console.debug('[stub] symbolCheck', files.length, index.symbols().length);
  return [];
}

export function scopeGuard(hunks: Hunk[], sel: Selection): void {
  console.debug('[stub] scopeGuard', hunks.length, sel.path);
}
