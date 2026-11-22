/**
 * TaskTab.tsx - Task tab: the request split into requirements (R1...), each with a state badge
 * (open / proposed / accepted / applied / checked) and its linked hunks.
 *
 * Exports:
 *  - TaskTab (React component): lists the 'requirements' message items; a linked hunk opens its source when the
 *    pending review's summary locates it; while a proposal is pending, each requirement has a per-hunk link toggle
 *    that posts {type:'linkRequirement'}. Pending hunk ids come from the first 'review' summary fact (all hunks).
 *  - State lives at module level (subscribed once) so it survives tab switches.
 *
 * Depends on: bridge.ts, ../../src/types. Depended on by: App.tsx.
 */
import { useEffect, useState } from 'react';
import type { RequirementView } from '../../src/review/requirements';
import type { SummaryFact } from '../../src/review/summary';
import { post, subscribe } from './bridge';

let items: RequirementView[] = [];
let review: { key: string; summary: SummaryFact[] } | undefined;
const listeners = new Set<() => void>();
subscribe((m) => {
  if (m.type === 'requirements') { items = m.items; listeners.forEach((l) => l()); }
  if (m.type === 'review') { review = { key: m.key, summary: m.summary }; listeners.forEach((l) => l()); }
  if (m.type === 'reviewClosed' && review?.key === m.key) { review = undefined; listeners.forEach((l) => l()); }
});

export function TaskTab() {
  const [list, setList] = useState(items);
  const [pending, setPending] = useState(review);
  useEffect(() => {
    const l = () => { setList(items); setPending(review); };
    listeners.add(l);
    l();
    return () => { listeners.delete(l); };
  }, []);

  if (list.length === 0) return <div className="muted" style={{ padding: 8 }}>No requirements yet. Ask the agent for a change.</div>;
  const pendingHunks = pending?.summary[0]?.hunkIds ?? [];
  const locate = (hunkId: string) => pending?.summary.find((f) => f.path && f.hunkIds.includes(hunkId));

  return (
    <ul aria-label="Requirements" style={{ listStyle: 'none', margin: 0, padding: 8, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {list.map((r) => (
        <li key={r.id}>
          <div><strong>{r.label}</strong> <span className="pill">{r.state}</span> {r.text}</div>
          {r.links.map((l) => {
            const where = locate(l.hunkId);
            return (
              <div key={l.hunkId} style={{ paddingLeft: 16, fontSize: 12 }}>
                {where
                  ? <a href="#" onClick={(e) => { e.preventDefault(); post({ type: 'openSource', path: where.path!, line: where.line ?? 1 }); }}>hunk {l.hunkId}</a>
                  : <span>hunk {l.hunkId}</span>} ({l.source})
              </div>
            );
          })}
          {pendingHunks.length > 0 && (
            <div style={{ paddingLeft: 16, fontSize: 12 }}>
              {pendingHunks.map((hunkId) => {
                const linked = r.links.some((l) => l.hunkId === hunkId);
                return (
                  <label key={hunkId} style={{ marginRight: 10 }}>
                    <input type="checkbox" checked={linked} onChange={() => post({ type: 'linkRequirement', requirementId: r.id, hunkId, linked: !linked })} /> {hunkId}
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
