import type { ComponentType } from 'react';
import { Copy, Trash2, X } from 'lucide-react';
import type { NodeType } from '@/core/types';
import { getNodeDef } from '@/core/nodeRegistry';
import { Button } from '@/components/ui';
import { useEditor } from './editorContext';
import type { InspectorProps } from './inspectors/shared';
import { BriefInspector, ImageAssetInspector, TextInspector } from './inspectors/InputInspectors';
import { AnalysisInspector, ConceptInspector, EditInspector, PoseInspector } from './inspectors/AiInspectors';
import { ShotPlanInspector } from './inspectors/ShotPlanInspector';
import { ApprovalInspector, ExportInspector, NodeComments } from './inspectors/ReviewInspectors';
import { WorkflowGuide } from './WorkflowGuide';

const INSPECTORS: Record<NodeType, ComponentType<InspectorProps>> = {
  brief: BriefInspector,
  image_asset: ImageAssetInspector,
  text: TextInspector,
  reference_analysis: AnalysisInspector,
  concept_generator: ConceptInspector,
  pose_generator: PoseInspector,
  image_edit: EditInspector,
  shot_planner: ShotPlanInspector,
  approval: ApprovalInspector,
  export: ExportInspector,
};

export function InspectorPanel() {
  const { selectedId, editor, select, canEdit, userId } = useEditor();
  const node = selectedId ? editor.graph.nodes.find((n) => n.id === selectedId) : undefined;
  if (!node) return <WorkflowGuide />;
  const def = getNodeDef(node.type);
  const Body = INSPECTORS[node.type];
  const update = (patch: Record<string, unknown>, key?: string) => editor.updateData(node.id, patch, key);

  return (
    <div className="flex h-full max-h-[inherit] flex-col" data-testid="inspector">
      <div className="flex items-start gap-2 border-b border-line px-4 py-3">
        <span className="mt-1.5 size-2.5 shrink-0 rounded-full" style={{ background: def.accent }} />
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold leading-tight">{def.label}</div>
          <div className="mt-0.5 text-[11.5px] leading-snug text-mute">{def.description}</div>
          <div className="mt-1 font-mono text-[9.5px] uppercase tracking-wider text-mute">
            {node.type} · schema v{node.schemaVersion} · {node.id.slice(0, 8)}
          </div>
        </div>
        <div className="flex shrink-0 items-center">
          {canEdit && (
            <>
              <Button
                variant="ghost"
                size="icon"
                title="Duplicate (Ctrl/⌘ D)"
                aria-label="Duplicate node"
                onClick={() => {
                  const [copy] = editor.duplicate([node.id], userId);
                  if (copy) select(copy.id);
                }}
              >
                <Copy className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                title="Delete node"
                aria-label="Delete node"
                className="hover:text-err"
                onClick={() => {
                  editor.remove([node.id], []);
                  select(null);
                }}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </>
          )}
          <Button variant="ghost" size="icon" title="Close" aria-label="Close inspector" onClick={() => select(null)}>
            <X className="size-4" />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Body key={node.id} node={node} update={update} />
        <NodeComments nodeId={node.id} />
      </div>
    </div>
  );
}
