/**
 * WiringMap.tsx - before/after wiring map shown above the hunk list in the Changes tab.
 *
 * Fixed columns like ContextGraph: calling symbols on the left (x 0), targets on the right (x 320), y = row * 50.
 * Added edges are green, removed edges red; clicking an edge calls onOpenHunk(path, line) for the hunk that creates it.
 *
 * Exports:
 *  - WiringMap({ graph, onOpenHunk }): React component.
 *
 * Depends on: @xyflow/react (+ CSS), ../../src/types (type only). Depended on by: ChangesTab.tsx.
 */
import { useMemo } from 'react';
import { ReactFlow, Background, MarkerType } from '@xyflow/react';
import type { Edge, EdgeMouseHandler, Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { WiringGraph } from '../../src/types';

const COLOR = {
  added: 'var(--vscode-gitDecoration-addedResourceForeground)',
  removed: 'var(--vscode-gitDecoration-deletedResourceForeground)',
};

export function wiringLayout(graph: WiringGraph): { nodes: Node[]; edges: Edge[] } {
  const sources = new Set(graph.edges.map(e => e.from));
  const rows = [0, 0];
  const nodes: Node[] = graph.nodes.map(n => {
    const col = sources.has(n.id) ? 0 : 1;
    return {
      id: n.id,
      position: { x: col * 320, y: rows[col]++ * 50 },
      data: { label: n.label },
      style: {
        width: 240, fontSize: 11, padding: 4, border: '1px solid var(--vscode-panel-border)', borderRadius: 4,
        background: 'var(--vscode-editorWidget-background, #252526)', color: 'var(--vscode-foreground)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      draggable: false,
      connectable: false,
      sourcePosition: 'right' as Node['sourcePosition'],
      targetPosition: 'left' as Node['targetPosition'],
    };
  });
  const edges: Edge[] = graph.edges.map(e => ({
    id: e.id,
    source: e.from,
    target: e.to,
    label: `${e.change} ${e.kind}`,
    labelStyle: { fontSize: 10, fill: COLOR[e.change] },
    labelBgStyle: { fill: 'var(--vscode-editor-background)' },
    style: { stroke: COLOR[e.change], strokeDasharray: e.change === 'removed' ? '5 4' : undefined, cursor: e.hunkId ? 'pointer' : 'default' },
    markerEnd: { type: MarkerType.ArrowClosed, color: COLOR[e.change] },
  }));
  return { nodes, edges };
}

export function WiringMap({ graph, onOpenHunk }: { graph: WiringGraph; onOpenHunk: (path: string, line: number) => void }) {
  const { nodes, edges } = useMemo(() => wiringLayout(graph), [graph]);
  const onEdgeClick: EdgeMouseHandler = (_e, edge) => {
    const found = graph.edges.find(g => g.id === edge.id);
    const path = graph.nodes.find(n => n.id === found?.from)?.path;
    if (found?.hunkLine !== undefined && path) onOpenHunk(path, found.hunkLine);
  };
  return (
    <div style={{ height: 260, border: '1px solid var(--vscode-panel-border)', borderRadius: 4 }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        minZoom={0.1}
        nodesDraggable={false}
        nodesConnectable={false}
        onEdgeClick={onEdgeClick}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
      </ReactFlow>
    </div>
  );
}
