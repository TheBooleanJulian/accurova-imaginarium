import { memo, type ReactNode } from 'react';
import { Handle, NodeResizer, Position, type NodeProps, type Node } from '@xyflow/react';
import { AlertTriangle, CheckCircle2, Clock, Loader2, Play, RefreshCw } from 'lucide-react';
import type { GraphNode } from '@/core/types';
import { getNodeDef, type PortType } from '@/core/nodeRegistry';
import { approvalStateOf, getOutputValue, resolveInputs, type ApprovedBundle, type ImageRef } from '@/core/graph';
import type { Brief, DirectionsOutput, ReferenceAnalysis, ShotPlan } from '@/core/schemas';
import { AssetImage } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useEditor, type NodeStatus } from '../editorContext';

export const PORT_COLORS: Record<PortType, string> = {
  brief: '#F5C842',
  images: '#00D4C8',
  analysis: '#B794F6',
  text: '#9AA4B2',
  direction: '#F5A742',
  shotplan: '#7CE38B',
  approved: '#5AC8FA',
};

export type FlowNodeData = { node: GraphNode; status: NodeStatus };
export type FlowNode = Node<FlowNodeData, 'imaginarium'>;

const STATE_UI: Record<NodeStatus['state'], { label: string; cls: string; icon?: ReactNode } | null> = {
  idle: null,
  never_run: { label: 'not run', cls: 'text-mute border-line' },
  queued: { label: 'queued', cls: 'text-gold border-gold/40', icon: <Clock className="size-3" /> },
  running: { label: 'running', cls: 'text-teal border-teal/50', icon: <Loader2 className="size-3 animate-spin" /> },
  failed: { label: 'failed', cls: 'text-err border-err/40', icon: <AlertTriangle className="size-3" /> },
  stale: { label: 'stale', cls: 'text-warn border-warn/40', icon: <RefreshCw className="size-3" /> },
  fresh: { label: 'up to date', cls: 'text-ok border-ok/30', icon: <CheckCircle2 className="size-3" /> },
};

/** The operation the header play-button should run next. */
export function nextOp(node: GraphNode, status: NodeStatus): string | null {
  const def = getNodeDef(node.type);
  const ai = def.operations.filter((o) => o.kind === 'ai');
  if (!ai.length) return null;
  if (node.type === 'concept_generator') {
    const dirs = status.ops.directions;
    if (!dirs?.activeRun || dirs.freshness === 'stale' || node.data.selectedDirection == null) return 'directions';
    return 'render';
  }
  return ai[0]!.id;
}

function Thumbs({ ids, max = 8 }: { ids: string[]; max?: number }) {
  const { bundle } = useEditor();
  const assets = ids.map((id) => bundle.assets.find((a) => a.id === id)).filter(Boolean);
  if (!assets.length) return null;
  return (
    <div className="grid grid-cols-4 gap-1">
      {assets.slice(0, max).map((a) => (
        <div key={a!.id} className="relative aspect-square overflow-hidden rounded-md border border-line">
          <AssetImage asset={a} className="h-full w-full" />
          {(() => {
            const s = approvalStateOf(bundle.approvals, a!.id);
            return s !== 'pending' ? <span className={cn('absolute right-1 top-1 size-2 rounded-full', s === 'approved' ? 'bg-ok' : 'bg-err')} /> : null;
          })()}
        </div>
      ))}
      {assets.length > max && <div className="flex aspect-square items-center justify-center rounded-md border border-line font-mono text-[10px] text-mute">+{assets.length - max}</div>}
    </div>
  );
}

function Preview({ node }: { node: GraphNode }) {
  const { ctx } = useEditor();
  const d = node.data;
  const line = (k: string, v: unknown) =>
    v ? (
      <div className="truncate">
        <span className="text-mute">{k} </span>
        {String(v)}
      </div>
    ) : null;
  switch (node.type) {
    case 'brief': {
      const b = d as unknown as Brief;
      const filled = Object.values(b).filter((v) => String(v ?? '').trim()).length;
      return (
        <div className="space-y-0.5 text-xs">
          {line('Client', b.client)}
          {line('Product', b.product)}
          {line('Objective', b.objective)}
          <div className="font-mono text-[10px] text-mute">{filled}/7 fields</div>
        </div>
      );
    }
    case 'image_asset': {
      const ids = (d.assetIds as string[]) ?? [];
      return ids.length ? <Thumbs ids={ids} max={node.size ? 24 : 8} /> : <div className="text-xs text-mute">Select, then upload in the inspector →</div>;
    }
    case 'text':
      return <div className="line-clamp-4 whitespace-pre-wrap text-xs text-soft">{String(d.text || 'Empty note')}</div>;
    case 'reference_analysis': {
      const a = getOutputValue(ctx, node, 'analysis') as ReferenceAnalysis | undefined;
      if (!a) return <div className="text-xs text-mute">Analyses connected references.</div>;
      return (
        <div className="space-y-1.5">
          <div className="flex gap-1">{a.colour.palette.map((c) => <span key={c} className="h-4 flex-1 rounded-sm border border-line" style={{ background: c }} title={c} />)}</div>
          <div className="line-clamp-3 text-xs text-soft">{a.summary}</div>
        </div>
      );
    }
    case 'concept_generator': {
      const out = ctx.runs.filter((r) => r.nodeId === node.id && r.operation === 'directions').at(-1)?.output as DirectionsOutput | undefined;
      const imgs = (getOutputValue(ctx, node, 'images') as ImageRef[] | undefined) ?? [];
      return (
        <div className="space-y-2">
          {out ? (
            <div className="space-y-1">
              {out.directions.map((dir, i) => (
                <div key={i} className={cn('flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs', d.selectedDirection === i ? 'border-teal/60 bg-teal-dim text-text' : 'border-line text-soft')}>
                  <span className="flex gap-0.5">{dir.palette.slice(0, 3).map((c) => <span key={c} className="size-2 rounded-full" style={{ background: c }} />)}</span>
                  <span className="truncate">{dir.title}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-xs text-mute">Generates 3 creative directions from the brief.</div>
          )}
          <Thumbs ids={imgs.map((i) => i.assetId)} />
        </div>
      );
    }
    case 'pose_generator':
    case 'image_edit': {
      const imgs = (getOutputValue(ctx, node, 'images') as ImageRef[] | undefined) ?? [];
      return imgs.length ? (
        <Thumbs ids={imgs.map((i) => i.assetId)} />
      ) : (
        <div className="text-xs text-mute">{node.type === 'pose_generator' ? `Change: ${((d.change as string[]) ?? []).join(', ') || '—'}` : String(d.instruction || 'Describe an edit in the inspector.')}</div>
      );
    }
    case 'shot_planner': {
      const plan = getOutputValue(ctx, node, 'shotplan') as ShotPlan | undefined;
      if (!plan) return <div className="text-xs text-mute">Turns direction + references into a practical shot list.</div>;
      return (
        <div className="space-y-1 text-xs">
          {plan.shots.slice(0, 4).map((s) => (
            <div key={s.id} className="flex gap-2 truncate">
              <span className="font-mono text-teal">{s.id}</span>
              <span className="truncate text-soft">{s.title}</span>
            </div>
          ))}
          <div className="font-mono text-[10px] text-mute">
            {plan.shots.length} shots · ~{Math.round(plan.totalSetupMinutes / 6) / 10}h setup{d.editedPlan ? ' · edited' : ''}
          </div>
        </div>
      );
    }
    case 'approval': {
      const b = getOutputValue(ctx, node, 'approved') as ApprovedBundle | undefined;
      const imgs = (resolveInputs(ctx, node.id).images as ImageRef[] | undefined) ?? [];
      if (!imgs.length) return <div className="text-xs text-mute">Connect concepts or poses for client review.</div>;
      return (
        <div className="flex flex-wrap gap-1.5 font-mono text-[10.5px]">
          <span className="rounded border border-ok/30 px-1.5 py-0.5 text-ok">{b?.assetIds.length ?? 0} approved</span>
          <span className="rounded border border-gold/30 px-1.5 py-0.5 text-gold">{b?.pendingAssetIds.length ?? 0} pending</span>
          <span className="rounded border border-err/30 px-1.5 py-0.5 text-err">{b?.changesRequestedAssetIds.length ?? 0} changes</span>
        </div>
      );
    }
    case 'export': {
      const last = ctx.runs.filter((r) => r.nodeId === node.id).at(-1)?.output as { filename: string; mode: string } | undefined;
      return <div className="text-xs text-soft">{last ? `Last: ${last.filename}` : `${String(d.mode) === 'final' ? 'Final approved pack' : 'Draft pack'} · PDF`}</div>;
    }
  }
}

export const ImaginariumNode = memo(function ImaginariumNode({ data, selected }: NodeProps<FlowNode>) {
  const { node, status } = data;
  const { runOp, canEdit } = useEditor();
  const def = getNodeDef(node.type);
  const ui = STATE_UI[status.state];
  const op = nextOp(node, status);

  return (
    <div
      className={cn(
        'group/node relative flex flex-col rounded-xl border bg-panel/95 shadow-[0_8px_30px_-12px_#000] backdrop-blur',
        node.size ? 'h-full w-full min-w-[260px]' : 'w-[280px]',
        selected ? 'border-teal/70 ring-1 ring-teal/30' : 'border-line hover:border-line-2',
        status.state === 'running' && 'running-glow',
      )}
    >
      {def.resizable && canEdit && <NodeResizer isVisible={selected} minWidth={260} minHeight={140} />}
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="size-2 shrink-0 rounded-full" style={{ background: def.accent }} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold leading-tight">{(node.data.title as string) || def.label}</div>
          <div className="font-mono text-[9.5px] uppercase tracking-wider text-mute">{node.type}</div>
        </div>
        {ui && (
          <span className={cn('inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[9.5px] uppercase', ui.cls)}>
            {ui.icon}
            {ui.label}
          </span>
        )}
        {op && canEdit && (
          <button
            title={`Run: ${def.operations.find((o) => o.id === op)?.label}`}
            className="nodrag flex size-6 items-center justify-center rounded-md bg-teal/10 text-teal opacity-80 hover:bg-teal hover:text-void group-hover/node:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              void runOp(node.id, op, { force: status.ops[op]?.freshness === 'fresh' });
            }}
            disabled={status.state === 'running' || status.state === 'queued'}
          >
            <Play className="size-3 fill-current" />
          </button>
        )}
      </div>

      <div className="flex">
        <div className="flex-1 py-1.5">
          {def.inputs.map((p) => (
            <div key={p.id} className="relative flex h-6 items-center pl-3 pr-2 text-[11px] text-soft">
              <Handle type="target" position={Position.Left} id={p.id} style={{ background: PORT_COLORS[p.type] }} isConnectable={canEdit} />
              {p.label}
              {p.required && <span className="ml-0.5 text-gold">*</span>}
            </div>
          ))}
        </div>
        <div className="flex-1 py-1.5 text-right">
          {def.outputs.map((p) => (
            <div key={p.id} className="relative flex h-6 items-center justify-end pl-2 pr-3 text-[11px] text-soft">
              {p.label}
              <Handle type="source" position={Position.Right} id={p.id} style={{ background: PORT_COLORS[p.type] }} isConnectable={canEdit} />
            </div>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden border-t border-line/60 px-3 py-2.5">
        <Preview node={node} />
      </div>
      {status.lastError && status.state === 'failed' && (
        <div className="line-clamp-2 border-t border-err/20 bg-err/5 px-3 py-1.5 text-[11px] text-err">{status.lastError}</div>
      )}
    </div>
  );
});
