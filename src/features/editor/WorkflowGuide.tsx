import { CheckCircle2, Circle, CircleDot } from 'lucide-react';
import type { GraphNode, NodeType } from '@/core/types';
import { activeRun, approvalStateOf } from '@/core/graph';
import { cn } from '@/lib/cn';
import { useEditor } from './editorContext';

interface Step {
  label: string;
  hint: string;
  done: boolean;
  node?: GraphNode;
}

/** Shown when nothing is selected: where this campaign is in the Accurova workflow, and what to do next. */
export function WorkflowGuide() {
  const { ctx, bundle, select, editor } = useEditor();
  const nodes = editor.graph.nodes;
  const first = (t: NodeType, pred: (n: GraphNode) => boolean = () => true) => nodes.find((n) => n.type === t && pred(n)) ?? nodes.find((n) => n.type === t);
  const has = (t: NodeType, op: string) => nodes.some((n) => n.type === t && !!activeRun(ctx, n.id, op));
  const imagesOf = (role: string) => nodes.some((n) => n.type === 'image_asset' && n.data.role === role && ((n.data.assetIds as string[]) ?? []).length > 0);
  const brief = first('brief');
  const briefFilled = brief ? Object.values(brief.data).filter((v) => String(v ?? '').trim()).length >= 4 : false;
  const concept = first('concept_generator');
  const reviewers = bundle.members.filter((m) => m.role === 'reviewer').length + bundle.invitations.filter((i) => i.status === 'pending' && i.role === 'reviewer').length;
  const approvedCount = bundle.assets.filter((a) => a.sourceType === 'ai_generated' && approvalStateOf(bundle.approvals, a.id) === 'approved').length;
  const exported = bundle.runs.some((r) => r.operation === 'export');

  const steps: Step[] = [
    { label: 'Fill in the brief', hint: 'Client, product, audience, objective, style, deliverables, constraints.', done: briefFilled, node: brief },
    { label: 'Upload real product photos', hint: 'These are preserved as originals and never edited.', done: imagesOf('product'), node: first('image_asset', (n) => n.data.role === 'product') },
    { label: 'Add inspiration references', hint: 'Mood, light and composition you like.', done: imagesOf('reference'), node: first('image_asset', (n) => n.data.role === 'reference') },
    { label: 'Analyse references', hint: 'Composition, lighting, palette, pose and styling.', done: has('reference_analysis', 'analyze'), node: first('reference_analysis') },
    { label: 'Generate 3 creative directions', hint: 'Structured concepts from the brief and analysis.', done: has('concept_generator', 'directions'), node: concept },
    { label: 'Pick a direction', hint: 'Choose one in the concept generator.', done: nodes.some((n) => n.type === 'concept_generator' && n.data.selectedDirection != null), node: concept },
    { label: 'Render concept images', hint: 'Variations in your chosen aspect ratio.', done: has('concept_generator', 'render'), node: concept },
    { label: 'Explore pose variations', hint: 'Change gestures, keep product, light and set.', done: has('pose_generator', 'poses'), node: first('pose_generator') },
    { label: 'Plan the shoot', hint: 'Shot list, lenses, lighting and equipment.', done: has('shot_planner', 'plan'), node: first('shot_planner') },
    { label: 'Invite the client', hint: 'Share → invite as Client reviewer.', done: reviewers > 0 },
    { label: 'Collect approvals', hint: 'The client approves or requests changes per image.', done: approvedCount > 0, node: first('approval') },
    { label: 'Export the PDF pack', hint: 'Draft any time; final once approved.', done: exported, node: first('export') },
  ];
  const nextIdx = steps.findIndex((s) => !s.done);
  const doneCount = steps.filter((s) => s.done).length;
  const cost = bundle.jobs.reduce((t, j) => t + (j.usage?.estCostUsd ?? 0), 0);

  return (
    <div className="flex h-full flex-col" data-testid="workflow-guide">
      <div className="border-b border-line px-4 py-3">
        <div className="label-mono">Campaign workflow</div>
        <div className="mt-1 flex items-baseline gap-2">
          <span className="text-2xl font-semibold">{doneCount}</span>
          <span className="text-sm text-mute">of {steps.length} steps</span>
        </div>
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-raised">
          <div className="h-full rounded-full bg-cyan transition-all" style={{ width: `${(doneCount / steps.length) * 100}%` }} />
        </div>
      </div>
      <ol className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
        {steps.map((s, i) => (
          <li key={s.label}>
            <button
              type="button"
              disabled={!s.node}
              onClick={() => s.node && select(s.node.id)}
              className={cn(
                'flex w-full gap-2.5 rounded-lg px-2.5 py-2 text-left transition enabled:hover:bg-raised',
                i === nextIdx && 'bg-cyan-dim ring-1 ring-cyan/25',
              )}
            >
              {s.done ? (
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" />
              ) : i === nextIdx ? (
                <CircleDot className="mt-0.5 size-4 shrink-0 text-cyan" />
              ) : (
                <Circle className="mt-0.5 size-4 shrink-0 text-line-2" />
              )}
              <span className="min-w-0">
                <span className={cn('block text-[13px]', s.done ? 'text-soft' : 'text-text')}>{s.label}</span>
                {i === nextIdx && <span className="block text-[11px] leading-snug text-mute">{s.hint}</span>}
              </span>
            </button>
          </li>
        ))}
      </ol>
      <div className="grid grid-cols-3 gap-px border-t border-line bg-line text-center">
        {[
          ['Assets', bundle.assets.filter((a) => a.sourceType !== 'export').length],
          ['Jobs', bundle.jobs.length],
          ['AI cost', cost ? `$${cost.toFixed(2)}` : '$0'],
        ].map(([k, v]) => (
          <div key={k as string} className="bg-ink py-2.5">
            <div className="text-[13px] font-semibold">{v}</div>
            <div className="label-mono">{k}</div>
          </div>
        ))}
      </div>
      <div className="border-t border-line px-4 py-2.5 text-[10.5px] leading-relaxed text-mute">
        Select a node to edit it. Nothing runs until you press Run. Moving nodes never triggers generation.
      </div>
    </div>
  );
}
