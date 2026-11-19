/**
 * ChangesTab.tsx - Changes tab (C1, serves criterion B2).
 *
 * Exports:
 *  - ChangesTab (React component): lists AppliedHunk records (from the 'changes' message) grouped by
 *    file, with Undo / Redo buttons per hunk (post undo / redo with hunkId). In the base the buttons
 *    are DISABLED (Slice 4 enables them and groups by run). Shows undone state.
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

// Flip to true in Slice 4 when the host implements undo/redo.
const UNDO_ENABLED = false;

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

export function ChangesTab() {
  const [list, setList] = useState(hunks);
  useEffect(() => {
    const l = () => setList(hunks);
    listeners.add(l);
    l();
    return () => { listeners.delete(l); };
  }, []);

  if (list.length === 0) return <div style={{ ...s.root, ...s.muted }}>No applied changes yet.</div>;

  const byFile = new Map<string, AppliedHunk[]>();
  for (const h of list) byFile.set(h.path, [...(byFile.get(h.path) ?? []), h]);

  return (
    <div style={s.root}>
      {[...byFile.entries()].map(([path, hs]) => (
        <div key={path}>
          <div style={s.mono}>{path}</div>
          {hs.map((h) => (
            <div key={h.hunkId} style={s.row}>
              <span style={{ ...s.mono, textDecoration: h.undone ? 'line-through' : 'none' }}>
                line {firstHunkLine(h.patch)} · {h.hunkId}
              </span>
              {h.undone && <span style={s.muted}>undone</span>}
              <button style={s.btn} disabled={!UNDO_ENABLED || h.undone} onClick={() => post({ type: 'undo', hunkId: h.hunkId })}>Undo</button>
              <button style={s.btn} disabled={!UNDO_ENABLED || !h.undone} onClick={() => post({ type: 'redo', hunkId: h.hunkId })}>Redo</button>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
