/**
 * ContextTab.tsx - Context tab list view (C1, serves criterion B1).
 *
 * Exports:
 *  - ContextTab (React component): shows the latest ContextPacket: excerpt list (path:lines,
 *    category chip impl/test/docs, reasons, ~tokens; click posts openSource); a collapsible Omitted
 *    section with a reason per drop (duplicate / lower-rank / over-budget); budget bar showing
 *    used versus excerpt budget ("≈ estimated"); embeds ContextGraph.
 *  - BudgetBar, ExcerptRow, OmittedList (small inner components).
 *  - State lives at module level (subscribed once) so the packet survives tab switches.
 *
 * Depends on: bridge.ts, ContextGraph.tsx, ../../src/types. Depended on by: App.tsx.
 */
import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import type { ContextPacket, Excerpt, Reason } from '../../src/types';
import { post, subscribe } from './bridge';
import { ContextGraph } from './ContextGraph';

let latest: ContextPacket | undefined;
const listeners = new Set<() => void>();
subscribe((m) => {
  if (m.type === 'packet') { latest = m.packet; listeners.forEach((l) => l()); }
});

const s: Record<string, CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', gap: 10, padding: 8, color: 'var(--vscode-foreground)', fontFamily: 'var(--vscode-font-family)', fontSize: 'var(--vscode-font-size)' },
  muted: { color: 'var(--vscode-descriptionForeground)', fontSize: 12 },
  barOuter: { height: 8, background: 'var(--vscode-progressBar-background)', opacity: 0.25, borderRadius: 4 },
  row: { padding: 6, border: '1px solid var(--vscode-panel-border)', borderRadius: 4, cursor: 'pointer' },
  chip: { display: 'inline-block', padding: '0 7px', borderRadius: 9, fontSize: 11, marginRight: 4, background: 'var(--vscode-badge-background)', color: 'var(--vscode-badge-foreground)' },
  reason: { display: 'inline-block', padding: '0 7px', borderRadius: 9, fontSize: 11, marginRight: 4, marginTop: 3, border: '1px solid var(--vscode-panel-border)', color: 'var(--vscode-descriptionForeground)' },
  mono: { fontFamily: 'var(--vscode-editor-font-family)' },
};

function reasonLabel(r: Reason): string {
  switch (r.kind) {
    case 'mention': return `mention ${r.token}`;
    case 'selection': return 'selection';
    case 'lexical': return `lexical "${r.term}" #${r.rank}`;
    case 'symbol-name': return `name "${r.term}" #${r.rank}`;
    default: return `${r.kind} ${r.from}`;
  }
}

function BudgetBar({ used, budget }: { used: number; budget: number }) {
  const pct = budget > 0 ? Math.min(100, (used / budget) * 100) : 0;
  return (
    <div>
      <div>{used} / {budget} tokens <span style={s.muted}>≈ estimated</span></div>
      <div style={{ position: 'relative', ...s.barOuter, opacity: 1, background: 'var(--vscode-input-background)' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: 'var(--vscode-progressBar-background)', borderRadius: 4 }} />
      </div>
    </div>
  );
}

function ExcerptRow({ e }: { e: Excerpt }) {
  return (
    <div style={s.row} onClick={() => post({ type: 'openSource', path: e.path, line: e.startLine })}>
      <div>
        <span style={s.chip}>{e.category}</span>
        <span style={s.mono}>{e.path}:{e.startLine}-{e.endLine}</span>
        <span style={s.muted}> · ≈{e.tokens} tokens</span>
      </div>
      <div>{e.reasons.map((r, i) => <span key={i} style={s.reason}>{reasonLabel(r)}</span>)}</div>
    </div>
  );
}

function OmittedList({ items }: { items: ContextPacket['omitted'] }) {
  return (
    <details>
      <summary>Omitted ({items.length})</summary>
      {items.length === 0 && <div style={s.muted}>Nothing omitted.</div>}
      {items.map((o, i) => (
        <div key={i} style={s.muted}>
          <span style={s.mono}>{o.path}:{o.startLine}-{o.endLine}</span> · {o.reason} · ≈{o.tokens} tokens
        </div>
      ))}
    </details>
  );
}

export function ContextTab() {
  const [packet, setPacket] = useState(latest);
  useEffect(() => {
    const l = () => setPacket(latest);
    listeners.add(l);
    l();
    return () => { listeners.delete(l); };
  }, []);

  if (!packet) return <div style={{ ...s.root, ...s.muted }}>No context assembled yet.</div>;
  return (
    <div style={s.root}>
      <div style={s.muted}>{packet.query}</div>
      <BudgetBar used={packet.used} budget={packet.budget} />
      {packet.excerpts.map((e) => <ExcerptRow key={e.id} e={e} />)}
      <OmittedList items={packet.omitted} />
      <ContextGraph packet={packet} />
    </div>
  );
}
