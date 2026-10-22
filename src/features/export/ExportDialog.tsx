import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { GraphEdge } from '@/core/types';
import { Button, Empty, Modal, Select } from '@/components/ui';
import { makeEdge } from '@/data/templates';
import { useEditor } from '@/features/editor/editorContext';
import { ExportPanel } from './ExportPanel';

export function ExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { editor, userId, select } = useEditor();
  const exportNodes = editor.graph.nodes.filter((n) => n.type === 'export');
  const [chosen, setChosen] = useState<string | null>(null);
  const node = exportNodes.find((n) => n.id === chosen) ?? exportNodes[0];

  const addExportNode = () => {
    const g = editor.graph;
    const right = Math.max(0, ...g.nodes.map((n) => n.position.x)) + 380;
    const n = editor.addNode('export', { x: right, y: 200 }, userId);
    // Wire it to whatever already exists so the pack has content.
    const approval = g.nodes.find((x) => x.type === 'approval');
    const brief = g.nodes.find((x) => x.type === 'brief');
    const planner = g.nodes.find((x) => x.type === 'shot_planner');
    const edges = [
      approval && makeEdge(n.projectId, approval, 'approved', n, 'approved'),
      brief && makeEdge(n.projectId, brief, 'brief', n, 'brief'),
      !approval && planner && makeEdge(n.projectId, planner, 'shotplan', n, 'shotplan'),
    ].filter((e): e is GraphEdge => !!e);
    for (const e of edges) editor.connect({ source: e.source, sourcePort: e.sourcePort, target: e.target, targetPort: e.targetPort });
    setChosen(n.id);
    select(n.id);
  };

  return (
    <Modal open={open} onClose={onClose} title="Export preshoot pack">
      {!node ? (
        <Empty title="No export node in this project">
          Add one and it will be connected to your approval node and brief.
          <div className="mt-3">
            <Button variant="primary" onClick={addExportNode}>
              <Plus className="size-4" /> Add export node
            </Button>
          </div>
        </Empty>
      ) : (
        <div className="space-y-4">
          {exportNodes.length > 1 && (
            <Select value={node.id} onChange={(e) => setChosen(e.target.value)} aria-label="Export node">
              {exportNodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {String(n.data.title || 'Export pack')}
                </option>
              ))}
            </Select>
          )}
          <ExportPanel node={node} />
        </div>
      )}
    </Modal>
  );
}
