/**
 * ChangesTab.tsx - Changes tab (C1, serves criterion B2).
 *
 * Exports:
 *  - ChangesTab (React component): lists AppliedHunk records (from the 'changes' message) grouped by
 *    run then file, with Undo / Redo per hunk, a mini +/- preview, row click -> openSource, and Undo run.
 *  - State lives at module level (subscribed once) so the list survives tab switches.
 *
 * Depends on: bridge.ts, ../../src/types. Depended on by: App.tsx.
 */
import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import type { AppliedHunk } from '../../src/types';
import { post, subscribe } from './bridge';

let hunks: AppliedHunk[] = [];
const listeners = new Set<() => void>();
subscribe((m) => {
  if (m.type === 'changes') { hunks = m.hunks; listeners.forEach((l) => l()); }
});

const s: Record<string, CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', gap: 10, padding: 8, color: 'var(--vscode-foreground)', fontFamily: 'var(--vscode-font-family)', fontSize: 'var(--vscode-font-size)' },
  muted: { color: 'var(--vscode-descriptionForeground)', fontSize: 12 },
  mono: { fontFamily: 'var(--vscode-editor-font-family)' },
  row: { display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0' },
  btn: { background: 'var(--vscode-button-secondaryBackground)', color: 'var(--vscode-button-secondaryForeground)', border: 0, padding: '2px 8px', cursor: 'pointer' },
};

function firstHunkLine(patch: string): string {
  const m = patch.match(/^@@ -\d+(?:,\d+)? \+(\d+)/m);
  return m ? m[1] : '?';
}

function preview(patch: string): string[] {
  return patch.split(/\r?\n/).filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).slice(0, 3);
}

export function ChangesTab() {
  const [list, setList] = useState(hunks);
  useEffect(() => {
    const l = () => setList(hunks);
    listeners.add(l);
    l();
    return () => { listeners.delete(l); };
  }, []);

  if (list.length === 0) return <div style={{ ...s.root, ...s.muted }}>No applied changes yet.</div>;

  const byRun = new Map<string, AppliedHunk[]>();
  for (const h of list) byRun.set(h.runId, [...(byRun.get(h.runId) ?? []), h]);

  const undoRun = (hs: AppliedHunk[]) => {
    for (const h of [...hs].reverse()) if (!h.undone) post({ type: 'undo', hunkId: h.hunkId });
  };

  return (
    <div style={s.root}>
      {[...byRun.entries()].map(([runId, rhs]) => {
        const byFile = new Map<string, AppliedHunk[]>();
        for (const h of rhs) byFile.set(h.path, [...(byFile.get(h.path) ?? []), h]);
        return (
          <div key={runId}>
            <div style={s.row}>
              <strong>Run {runId.slice(0, 8)}</strong>
              <button style={s.btn} disabled={rhs.every((h) => h.undone)} onClick={() => undoRun(rhs)}>Undo run</button>
            </div>
            {[...byFile.entries()].map(([path, hs]) => (
              <div key={path}>
                <div style={s.mono}>{path}</div>
                {hs.map((h) => {
                  const line = firstHunkLine(h.patch);
                  return (
                    <div key={h.hunkId} style={{ ...s.row, cursor: 'pointer' }} onClick={() => post({ type: 'openSource', path: h.path, line: Number(line) || 1 })}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ ...s.mono, textDecoration: h.undone ? 'line-through' : 'none' }}>{h.path}:{line}</span>
                        {h.undone && <span style={s.muted}> undone</span>}
                        {preview(h.patch).map((l, i) => (
                          <div key={i} style={{ ...s.mono, fontSize: 11, whiteSpace: 'pre', overflow: 'hidden', textOverflow: 'ellipsis', color: l[0] === '+' ? 'var(--vscode-gitDecoration-addedResourceForeground)' : 'var(--vscode-gitDecoration-deletedResourceForeground)' }}>{l}</div>
                        ))}
                      </div>
                      <button style={s.btn} disabled={h.undone} onClick={(e) => { e.stopPropagation(); post({ type: 'undo', hunkId: h.hunkId }); }}>Undo</button>
                      <button style={s.btn} disabled={!h.undone} onClick={(e) => { e.stopPropagation(); post({ type: 'redo', hunkId: h.hunkId }); }}>Redo</button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
