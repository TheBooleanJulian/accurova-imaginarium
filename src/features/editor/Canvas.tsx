import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type IsValidConnection,
} from '@xyflow/react';
import { validateConnection } from '@/core/graph';
import { findPort, getNodeDef } from '@/core/nodeRegistry';
import type { NodeType, XY } from '@/core/types';
import { toast } from '@/components/ui';
import { useEditor } from './editorContext';
import { ImaginariumNode, PORT_COLORS, type FlowNode } from './nodes/ImaginariumNode';

const nodeTypes = { imaginarium: ImaginariumNode };
export const DND_MIME = 'application/x-imaginarium-node';

export function Canvas() {
  const { editor, statuses, selectedId, select, canEdit, userId } = useEditor();
  const { nodes, edges } = editor.graph;
  const { screenToFlowPosition } = useReactFlow();
  const [rfNodes, setRfNodes] = useState<FlowNode[]>([]);
  const [selectedEdges, setSelectedEdges] = useState<Set<string>>(new Set());
  const dragKey = useRef('');

  useEffect(() => {
    setRfNodes((prev) => {
      const byId = new Map(prev.map((n) => [n.id, n]));
      return nodes.map((g) => {
        const p = byId.get(g.id);
        return {
          id: g.id,
          type: 'imaginarium' as const,
          position: g.position,
          data: { node: g, status: statuses[g.id] ?? { state: 'idle', ops: {} } },
          selected: g.id === selectedId,
          measured: p?.measured,
          ...(g.size ? { width: g.size.width, height: g.size.height } : {}),
          dragging: p?.dragging,
        };
      });
    });
  }, [nodes, statuses, selectedId]);

  const rfEdges: Edge[] = useMemo(
    () =>
      edges.map((e) => {
        const src = nodes.find((n) => n.id === e.source);
        const port = src ? findPort(src.type, 'out', e.sourcePort) : undefined;
        const running = statuses[e.target]?.state === 'running';
        const color = port ? PORT_COLORS[port.type] : '#3a4656';
        return {
          id: e.id,
          source: e.source,
          sourceHandle: e.sourcePort,
          target: e.target,
          targetHandle: e.targetPort,
          selected: selectedEdges.has(e.id),
          animated: running,
          style: { stroke: selectedEdges.has(e.id) ? '#00D4C8' : `${color}99` },
        };
      }),
    [edges, nodes, statuses, selectedEdges],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      setRfNodes((ns) => applyNodeChanges(changes, ns));
      const positions: Record<string, XY> = {};
      let finalDrag = false;
      const removed: string[] = [];
      for (const c of changes) {
        if (c.type === 'position' && c.position) {
          if (!dragKey.current) dragKey.current = crypto.randomUUID();
          positions[c.id] = { x: Math.round(c.position.x), y: Math.round(c.position.y) };
          if (!c.dragging) finalDrag = true;
        } else if (c.type === 'position' && c.dragging === false) {
          finalDrag = true;
        } else if (c.type === 'dimensions' && c.resizing && c.dimensions) {
          editor.resize(c.id, { width: Math.round(c.dimensions.width), height: Math.round(c.dimensions.height) });
        } else if (c.type === 'remove') {
          removed.push(c.id);
        }
      }
      if (Object.keys(positions).length && canEdit) editor.move(positions, finalDrag, dragKey.current);
      if (finalDrag) dragKey.current = '';
      if (removed.length && canEdit) {
        editor.remove(removed, []);
        if (selectedId && removed.includes(selectedId)) select(null);
      }
    },
    [editor, canEdit, selectedId, select],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const removed = changes.filter((c) => c.type === 'remove').map((c) => c.id);
      if (removed.length && canEdit) editor.remove([], removed);
      const sel = changes.filter((c) => c.type === 'select');
      if (sel.length)
        setSelectedEdges((prev) => {
          const next = new Set(prev);
          for (const c of sel) {
            if (c.type !== 'select') continue;
            if (c.selected) next.add(c.id);
            else next.delete(c.id);
          }
          return next;
        });
    },
    [editor, canEdit],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      const reason = editor.connect({ source: c.source, sourcePort: c.sourceHandle ?? '', target: c.target, targetPort: c.targetHandle ?? '' });
      if (reason) toast(reason, 'err');
    },
    [editor],
  );

  const isValidConnection: IsValidConnection = useCallback(
    (c) =>
      validateConnection(editor.graph.nodes, editor.graph.edges, {
        source: c.source,
        sourcePort: c.sourceHandle ?? '',
        target: c.target,
        targetPort: c.targetHandle ?? '',
      }).ok,
    [editor.graph],
  );

  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      const type = e.dataTransfer.getData(DND_MIME) as NodeType;
      if (!type || !canEdit) return;
      const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const n = editor.addNode(type, { x: Math.round(pos.x - 130), y: Math.round(pos.y - 30) }, userId);
      select(n.id);
    },
    [editor, screenToFlowPosition, canEdit, userId, select],
  );

  return (
    <div className="h-full w-full" onDragOver={(e) => (e.preventDefault(), (e.dataTransfer.dropEffect = 'copy'))} onDrop={onDrop}>
      <ReactFlow<FlowNode>
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onNodeClick={(_, n) => select(n.id)}
        onPaneClick={() => select(null)}
        nodesDraggable={canEdit}
        nodesConnectable={canEdit}
        deleteKeyCode={canEdit ? ['Backspace', 'Delete'] : null}
        multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
        minZoom={0.15}
        maxZoom={2}
        attributionPosition="top-right"
        colorMode="dark"
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="#1d2632" />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap
          position="bottom-right"
          pannable
          zoomable
          nodeColor={(n) => getNodeDef((n as FlowNode).data.node.type).accent}
          maskColor="#05050899"
          style={{ width: 160, height: 100 }}
        />
      </ReactFlow>
    </div>
  );
}
