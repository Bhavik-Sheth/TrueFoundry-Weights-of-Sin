/**
 * summary.ts - grounded review summary facts (no model call).
 *
 * Exports:
 *  - SummaryFact: one sentence about a proposal, with the hunks (and optionally the check) that back it;
 *    path/line locate its first hunk so the webview can open it.
 *  - SummaryCheck: a recorded run_command result (argv, exit code, parsed pytest counts).
 *  - summarizeProposal(p, wiring, checks, symbolsBefore, symbolsAfter): up to 8 facts, derived deterministically.
 *  - checksFromJournal(jsonl): SummaryCheck[] from a run's journal text (run_command tool-call + tool-output records).
 *
 * Must not import 'vscode'. Depended on by: src/types.ts, extension.ts.
 */
import type { Hunk, Proposal, SymbolEntry, WiringGraph } from '../types';

export interface SummaryFact { text: string; hunkIds: string[]; checkId?: string; path?: string; line?: number }
export interface SummaryCheck { id: string; argv: string[]; exitCode: number; passed?: number; failed?: number }

const MAX_FACTS = 8;

function fact(text: string, hunks: Hunk[], checkId?: string): SummaryFact {
  const first = hunks[0];
  return { text, hunkIds: hunks.map(h => h.id), ...(checkId ? { checkId } : {}), ...(first ? { path: first.path, line: first.newStart } : {}) };
}

function hunksTouching(p: Proposal, s: SymbolEntry, side: 'new' | 'old'): Hunk[] {
  return p.hunks.filter(h => {
    if (h.path !== s.path) return false;
    const start = side === 'new' ? h.newStart : h.oldStart;
    const end = start + (side === 'new' ? h.newLines : h.oldLines) - 1;
    return start <= s.endLine && end >= s.startLine;
  });
}

function importedModules(line: string): string[] {
  const m = /^\+\s*(?:from\s+(\S+)\s+import\b|import\s+(.+))/.exec(line);
  if (!m) return [];
  if (m[1]) return [m[1]];
  return m[2].split(',').map(part => part.trim().split(/\s+/)[0]).filter(Boolean);
}

export function summarizeProposal(p: Proposal, wiring: WiringGraph, checks: SummaryCheck[], symbolsBefore: SymbolEntry[], symbolsAfter: SymbolEntry[]): SummaryFact[] {
  const facts: SummaryFact[] = [];
  const paths = p.files.map(f => f.path);
  facts.push(fact(`Changes ${paths.length} ${paths.length === 1 ? 'file' : 'files'}: ${paths.join(', ')}`, p.hunks));

  const key = (s: SymbolEntry) => s.kind + ' ' + s.qualifiedName;
  const beforeKeys = new Set(symbolsBefore.map(key));
  const afterKeys = new Set(symbolsAfter.map(key));
  for (const s of symbolsAfter) if (!beforeKeys.has(key(s))) facts.push(fact(`Adds ${key(s)}`, hunksTouching(p, s, 'new')));
  for (const s of symbolsBefore) if (!afterKeys.has(key(s))) facts.push(fact(`Removes ${key(s)}`, hunksTouching(p, s, 'old')));

  const imports = new Map<string, Hunk[]>();
  for (const h of p.hunks) {
    if (!h.path.endsWith('.py')) continue;
    for (const line of h.lines) for (const mod of importedModules(line)) imports.set(mod, [...(imports.get(mod) ?? []), h]);
  }
  for (const [mod, hs] of imports) facts.push(fact(`New import: ${mod}`, [...new Set(hs)]));

  const label = (id: string) => wiring.nodes.find(n => n.id === id)?.label ?? id;
  for (const e of wiring.edges) {
    if (e.change !== 'added' || e.kind !== 'call') continue;
    facts.push(fact(`New call: ${label(e.from)} → ${label(e.to)}`, p.hunks.filter(h => h.id === e.hunkId)));
  }

  for (const c of checks) {
    const counts = c.passed !== undefined || c.failed !== undefined ? ` (${c.passed ?? 0} passed, ${c.failed ?? 0} failed)` : '';
    facts.push(fact(`Check ${c.argv.join(' ')}: exit ${c.exitCode}${counts}`, [], c.id));
  }

  const outside = p.hunks.filter(h => h.outsideSelection);
  const history = p.hunks.filter(h => h.historyConcern);
  const flagged = new Set([...outside, ...history]);
  if (flagged.size) {
    const reasons = [outside.length ? 'outside selection' : '', history.length ? 'history concern' : ''].filter(Boolean).join(', ');
    facts.push(fact(`${flagged.size} ${flagged.size === 1 ? 'hunk' : 'hunks'} flagged: ${reasons}`, [...flagged]));
  }
  return facts.slice(0, MAX_FACTS);
}

function argvOf(raw: unknown): string[] | undefined {
  let v: any = raw; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return undefined; } }
  if (!v || typeof v !== 'object') return undefined;
  if (Array.isArray(v.argv) && v.argv.length && v.argv.every((x: unknown) => typeof x === 'string')) return v.argv;
  return argvOf(v.arguments) ?? argvOf(v.args) ?? argvOf(v.tool_arguments) ?? argvOf(v.input);
}

function resultOf(content: unknown): { exitCode: number; text: string } | undefined {
  let v: any = content; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (Array.isArray(v)) v = v.map(part => part?.text).filter((t: unknown) => typeof t === 'string').join('\n');
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return undefined; } }
  if (!v || typeof v !== 'object' || typeof v.exitCode !== 'number') return undefined;
  return { exitCode: v.exitCode, text: String(v.stdout ?? '') + '\n' + String(v.stderr ?? '') };
}

export function checksFromJournal(jsonl: string): SummaryCheck[] {
  const calls = new Map<string, string[]>();
  const checks: SummaryCheck[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let evidence: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    try { evidence = JSON.parse(line)?.evidence; } catch { continue; }
    if (evidence?.kind === 'agent-event' && evidence.event?.kind === 'tool-call') {
      const argv = argvOf(evidence.event.args);
      if (argv && typeof evidence.event.toolCallId === 'string') calls.set(evidence.event.toolCallId, argv);
    } else if (evidence?.kind === 'tool-output' && calls.has(evidence.toolCallId)) {
      const result = resultOf(evidence.content);
      if (!result) continue;
      const passed = /(\d+) passed/.exec(result.text);
      const failed = /(\d+) failed/.exec(result.text);
      checks.push({
        id: evidence.toolCallId, argv: calls.get(evidence.toolCallId)!, exitCode: result.exitCode,
        ...(passed || failed ? { passed: passed ? Number(passed[1]) : 0, failed: failed ? Number(failed[1]) : 0 } : {}),
      });
    }
  }
  return checks;
}
