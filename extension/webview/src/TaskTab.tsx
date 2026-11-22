/**
 * TaskTab.tsx - Task tab: the request split into requirements (R1...), each with a state badge
 * (open / proposed / accepted / applied / checked) and its linked hunks.
 *
 * Exports:
 *  - TaskTab (React component): lists the 'requirements' message items; a linked hunk opens its source via the
 *    path/line the host supplies; while a proposal is pending (message pendingHunks), each requirement has a
 *    per-hunk link toggle that posts {type:'linkRequirement'}.
 *  - State lives at module level (subscribed once) so it survives tab switches.
 *
 * Depends on: bridge.ts, ../../src/types. Depended on by: App.tsx.
 */
import { useEffect, useState } from 'react';
import type { RequirementView } from '../../src/review/requirements';
import { post, subscribe } from './bridge';

let items: RequirementView[] = [];
let pendingHunks: Array<{ id: string; path: string; line: number }> = [];
const listeners = new Set<() => void>();
subscribe((m) => {
  if (m.type === 'requirements') { items = m.items; pendingHunks = m.pendingHunks ?? []; listeners.forEach((l) => l()); }
});

export function TaskTab() {
  const [list, setList] = useState(items);
  const [pending, setPending] = useState(pendingHunks);
  useEffect(() => {
    const l = () => { setList(items); setPending(pendingHunks); };
    listeners.add(l);
    l();
    return () => { listeners.delete(l); };
  }, []);

  if (list.length === 0) return <div className="muted" style={{ padding: 8 }}>No requirements yet. Ask the agent for a change.</div>;

  return (
    <ul aria-label="Requirements" style={{ listStyle: 'none', margin: 0, padding: 8, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {list.map((r) => (
        <li key={r.id}>
          <div><strong>{r.label}</strong> <span className="pill">{r.state}</span> {r.text}</div>
          {r.links.map((l) => {
            return (
              <div key={l.hunkId} style={{ paddingLeft: 16, fontSize: 12 }}>
                {l.path
                  ? <a href="#" onClick={(e) => { e.preventDefault(); post({ type: 'openSource', path: l.path!, line: l.line ?? 1 }); }}>{l.path}:{l.line ?? 1}</a>
                  : <span>hunk {l.hunkId}</span>} ({l.source})
              </div>
            );
          })}
          {pending.length > 0 && (
            <div style={{ paddingLeft: 16, fontSize: 12 }}>
              {pending.map(({ id: hunkId, path, line }) => {
                const linked = r.links.some((l) => l.hunkId === hunkId);
                return (
                  <label key={hunkId} style={{ marginRight: 10 }}>
                    <input type="checkbox" checked={linked} onChange={() => post({ type: 'linkRequirement', requirementId: r.id, hunkId, linked: !linked })} /> {path}:{line}
                  </label>
                );
              })}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
