/**
 * ContextGraph.tsx - graph of the context choice (C1; cut candidate, the list is kept).
 *
 * Slice 0 status: PLACEHOLDER listing node and edge counts. Slice 5 replaces it with @xyflow/react
 * using fixed columns (request, terms, files, symbols), labelled edges (dashed = inferred) and
 * node click -> openSource.
 *
 * Exports:
 *  - ContextGraph({ packet }): React component.
 *
 * Depends on: ../../src/types. Depended on by: ContextTab.tsx.
 */
import type { CSSProperties } from 'react';
import type { ContextPacket } from '../../src/types';

const box: CSSProperties = { padding: 8, border: '1px dashed var(--vscode-panel-border)', color: 'var(--vscode-descriptionForeground)', fontSize: 12 };

export function ContextGraph({ packet }: { packet: ContextPacket }) {
  const { nodes, edges } = packet.graph;
  const by = (t: string) => nodes.filter((n) => n.type === t).length;
  return (
    <div style={box}>
      Graph (placeholder): {nodes.length} nodes ({by('request')} request, {by('term')} terms, {by('file')} files,{' '}
      {by('symbol')} symbols), {edges.length} edges ({edges.filter((e) => e.inferred).length} inferred).
    </div>
  );
}
