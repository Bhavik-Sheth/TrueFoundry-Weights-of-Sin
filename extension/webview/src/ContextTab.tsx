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
import type { ContextPacket, Excerpt, FileChange, FileContext, Reason } from '../../src/types';
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

/** Readable chip text per reason kind. */
function reasonLabel(r: Reason): string {
  switch (r.kind) {
    case 'mention': return `you mentioned ${r.token}`;
    case 'selection': return 'your selection';
    case 'source-preview': return `search preview "${r.term}" (#${r.rank})`;
    case 'semantic': return `semantic match #${r.rank}`;
    case 'lexical': return `text match "${r.term}" (#${r.rank})`;
    case 'symbol-name': return `name match "${r.term}" (#${r.rank})`;
    case 'calls': return `called by ${r.from}`;
    case 'called-by': return `calls ${r.from}`;
    case 'registers': return `registered like ${r.from}`;
    case 'tests': return `tests ${r.from}`;
    case 'documents': return `documents ${r.from}`;
  }
}

function BudgetBar({ used, budget }: { used: number; budget: number }) {
  const pct = budget > 0 ? Math.min(100, (used / budget) * 100) : 0;
  return (
    <div>
      <div>{used} / {budget} tokens <span style={s.muted}>(≈ estimated tokens)</span></div>
      <div style={{ ...s.barOuter, opacity: 1, background: 'var(--vscode-input-background)' }}>
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

function ChangeDetails({ label, change }: { label: string; change: FileChange }) {
  return <div>
    <strong>{label}</strong> · {change.status}
    {change.added !== undefined && ` · +${change.added} / −${change.removed} lines`}
    {change.detail && <div style={s.muted}>{change.detail}</div>}
    {change.hunks?.map(hunk => <div key={`${hunk.oldStart}:${hunk.newStart}`} style={s.muted}>
      Old L{hunk.oldStart} ({hunk.oldLines} lines) → new L{hunk.newStart} ({hunk.newLines} lines)
      {!!hunk.symbols.length && ` · ${hunk.symbols.join(', ')}`}
      {!!hunk.lines?.length && <pre style={{ ...s.mono, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{hunk.lines.join('\n')}</pre>}
      {hunk.truncated && <div>Excerpt clipped</div>}
    </div>)}
  </div>;
}

function FileRow({ file, delivered }: { file: FileContext; delivered?: boolean }) {
  const last = file.lastCommit;
  return <details>
    <summary>
      <span style={s.mono}>{file.path}</span>
      {delivered !== undefined && <span style={s.muted}> · {delivered ? 'Summary sent' : 'Available in workspace context'}</span>}
    </summary>
    <div style={{ display: 'grid', gap: 6, padding: 6 }}>
      <div>{file.reasons.map((reason, index) => <span style={s.reason} key={index}>{reasonLabel(reason)}</span>)}</div>
      {file.symbolCount > 0 && <div>
        <strong>Indexed contents</strong> · {file.symbolCount} symbols
        {file.symbols.map(symbol => <div key={`${symbol.name}:${symbol.start}`} style={s.mono}>
          {symbol.name} · {symbol.kind} · L{symbol.start}–{symbol.end}
        </div>)}
      </div>}
      {!!file.openingLines?.length && <div>
        <strong>Opening lines</strong>
        {file.openingLines.map(line => <div key={line.line} style={s.mono}>L{line.line} · {line.text}</div>)}
      </div>}
      {file.changes && <ChangeDetails label={`${file.source} vs Git HEAD`} change={file.changes} />}
      {last && <div>
        <strong>Last file commit</strong> · {last.commit.slice(0, 12)} · {last.date.slice(0, 10)}
        <div>{last.subject}</div>
        {last.parent && <div style={s.muted}>Previous revision {last.parent.slice(0, 12)}{last.previousPath !== file.path && last.previousPath && ` · ${last.previousPath}`}</div>}
      </div>}
      {file.previousChanges && <ChangeDetails label="Last commit delta" change={file.previousChanges} />}
      {file.workingStatus === 'text' && <div>
        <button type="button" onClick={() => post({ type: 'openSource', path: file.path, line: file.symbols[0]?.start ?? 1 })}>
          Open source
        </button>
      </div>}
    </div>
  </details>;
}

const OMIT_TEXT: Record<ContextPacket['omitted'][number]['reason'], string> = {
  duplicate: 'duplicate (overlaps an included excerpt)',
  'lower-rank': 'lower rank (below the cut)',
  'over-budget': 'over budget',
};

function OmittedList({ items }: { items: ContextPacket['omitted'] }) {
  return (
    <details>
      <summary>Omitted ({items.length})</summary>
      {items.length === 0 && <div style={s.muted}>Nothing omitted.</div>}
      {items.map((o, i) => (
        <div key={i} style={s.muted}>
          <span style={s.mono}>{o.path}:{o.startLine}-{o.endLine}</span> · {OMIT_TEXT[o.reason]} · ≈{o.tokens} tokens
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
      <ContextGraph packet={packet} />
      {packet.delivery && <div style={s.muted}>
        Sent to model: {packet.delivery.excerptIds.length} excerpts, ≈{packet.delivery.excerptTokens.toLocaleString()} source tokens,
        {packet.delivery.packetTokens !== undefined && ` ≈${packet.delivery.packetTokens.toLocaleString()} tokens with packet metadata,`}
        {' '}{packet.delivery.serializedCharacters.toLocaleString()} / {packet.delivery.characterLimit.toLocaleString()} serialized characters.
        {packet.delivery.omittedExcerpts > 0 && ` Transport omitted ${packet.delivery.omittedExcerpts} excerpts.`}
      </div>}
      {!!packet.files?.length && <section aria-label="File map">
        <strong>File map</strong>
        {packet.files.map(file => <FileRow key={file.path} file={file}
          delivered={packet.delivery?.filePaths?.includes(file.path)} />)}
      </section>}
      {packet.excerpts.filter(e => !packet.delivery || packet.delivery.excerptIds.includes(e.id))
        .map((e) => <ExcerptRow key={e.id} e={e} />)}
      {packet.delivery && packet.delivery.omittedExcerpts > 0 && <details>
        <summary>Packed excerpts excluded by the transport limit</summary>
        {packet.excerpts.filter(e => !packet.delivery!.excerptIds.includes(e.id))
          .map(e => <ExcerptRow key={e.id} e={e} />)}
      </details>}
      <OmittedList items={packet.omitted} />
    </div>
  );
}
