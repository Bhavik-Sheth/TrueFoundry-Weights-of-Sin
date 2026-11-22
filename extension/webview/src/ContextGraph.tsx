/**
 * ContextGraph.tsx - graph of the context choice (C1, criterion B1).
 *
 * React Flow (@xyflow/react) with FIXED columns, no layout library: request (x 0), terms (320), files (640),
 * symbols (960); y = index within the column * 90, centered against the tallest column, so positions are stable. Edge label = the reason;
 * dashed edges are inferred (registers / tests / documents). Clicking a file or symbol node posts openSource.
 * The viewport is persisted through bridge setState and restored on mount (fitView when there is none).
 * Node ids carry the location: `file:<path>` and `sym:<path>:<startLine>`.
 *
 * Exports:
 *  - ContextGraph({ packet }): React component.
 *
 * Depends on: @xyflow/react (+ its CSS, bundled by Vite into index.css), bridge.ts, ../../src/types.
 * Depended on by: ContextTab.tsx.
 */
import { useMemo } from 'react';
import { ReactFlow, Background, MarkerType } from '@xyflow/react';
import type { Edge, Node, NodeMouseHandler, Viewport } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { ContextPacket } from '../../src/types';
import { getState, post, setState } from './bridge';

const COLUMN: Record<ContextPacket['graph']['nodes'][number]['type'], number> = { request: 0, term: 1, file: 2, symbol: 3 };
const COL_GAP = 320;
const ROW_GAP = 90;
const FILL:Record<string, string> = {
  request: 'var(--vscode-button-background)',
  term: 'var(--vscode-badge-background)',
  file: 'var(--vscode-editorWidget-background, #252526)',
  symbol: 'var(--vscode-editorWidget-background, #252526)',
};

/** Where a node leads when clicked, derived from its id. */
export function nodeTarget(id: string): { path: string; line: number } | undefined {
  if (id.startsWith('file:')) return { path: id.slice(5), line: 1 };
  if (id.startsWith('sym:')) {
    const rest = id.slice(4);
    const i = rest.lastIndexOf(':');
    const line = Number(rest.slice(i + 1));
    if (i > 0 && Number.isFinite(line)) return { path: rest.slice(0, i), line };
  }
  return undefined;
}

export function layout(graph: ContextPacket['graph']): { nodes: Node[]; edges: Edge[] } {
  const rows = [0, 0, 0, 0];
  const counts = [0, 0, 0, 0];
  for (const n of graph.nodes) counts[COLUMN[n.type]]++;
  const tallest = Math.max(...counts);
  const nodes: Node[] = graph.nodes.map((n) => {
    const col = COLUMN[n.type];
    const target = nodeTarget(n.id);
    // Center each column vertically against the tallest one so edges between columns stay short and level.
    const y = (rows[col]++ + (tallest - counts[col]) / 2) * ROW_GAP;
    return {
      id: n.id,
      position: { x: col * COL_GAP, y },
      data: { label: <span title={n.label}>{n.label}</span>, path: target?.path, line: target?.line },
      style: {
        width: 220, fontSize: 12, padding: '6px 8px', border: '1px solid var(--vscode-panel-border)', borderRadius: 4,
        background: FILL[n.type], color: n.type === 'request' ? 'var(--vscode-button-foreground)' : 'var(--vscode-foreground)',
        cursor: target ? 'pointer' : 'default', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      draggable: false,
      connectable: false,
      sourcePosition: 'right' as Node['sourcePosition'],
      targetPosition: 'left' as Node['targetPosition'],
    };
  });
  const edges: Edge[] = graph.edges.map((e, i) => ({
    id: `e${i}`,
    source: e.from,
    target: e.to,
    label: e.label,
    // smoothstep routes same-column edges (symbol -> symbol) as a bracket instead of a loop through the nodes.
    type: 'smoothstep',
    pathOptions: { offset: 24, borderRadius: 6 },
    labelStyle: { fontSize: 11, fill: 'var(--vscode-foreground)' },
    labelBgStyle: { fill: 'var(--vscode-editor-background)', stroke: 'var(--vscode-panel-border)' },
    labelBgPadding: [4, 2] as [number, number],
    labelBgBorderRadius: 3,
    style: { stroke: 'var(--vscode-descriptionForeground)', strokeWidth: 1.25, strokeDasharray: e.inferred ? '5 4' : undefined },
    markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--vscode-descriptionForeground)' },
  }));
  return { nodes, edges };
}

export function ContextGraph({ packet }: { packet: ContextPacket }) {
  const { nodes, edges } = useMemo(() => layout(packet.graph), [packet]);
  const saved = getState<{ graphViewport?: Viewport }>().graphViewport;
  const onNodeClick: NodeMouseHandler = (_e, n) => {
    const d = n.data as { path?: string; line?: number };
    if (d.path) post({ type: 'openSource', path: d.path, line: d.line ?? 1 });
  };
  return (
    <div style={{ height: 380, border: '1px solid var(--vscode-panel-border)', borderRadius: 4 }}>
      <ReactFlow
        key={packet.id}
        nodes={nodes}
        edges={edges}
        fitView={!saved}
        defaultViewport={saved}
        minZoom={0.1}
        nodesDraggable={false}
        nodesConnectable={false}
        onNodeClick={onNodeClick}
        onMoveEnd={(_e, vp) => setState({ graphViewport: vp })}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
      </ReactFlow>
    </div>
  );
}
