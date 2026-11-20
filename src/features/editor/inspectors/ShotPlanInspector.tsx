import { useState } from 'react';
import { ChevronRight, RotateCcw } from 'lucide-react';
import type { Shot, ShotPlan } from '@/core/schemas';
import { activeRun } from '@/core/graph';
import { AssetImage, Badge, Button, Field, Input, Select, Textarea } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useEditor } from '../editorContext';
import { ListInput, OpControls, RunHistory, Section, type InspectorProps } from './shared';

const PRIORITY_TONE = { must: 'magenta', should: 'cyan', nice: 'mute' } as const;

const TEXT_FIELDS: [keyof Shot, string][] = [
  ['poseDirection', 'Pose & model direction'],
  ['cameraAngle', 'Camera angle'],
  ['framing', 'Framing'],
  ['lens', 'Lens'],
  ['cameraPosition', 'Camera position'],
  ['lighting', 'Lighting direction & placement'],
  ['background', 'Background'],
  ['productPlacement', 'Product placement'],
  ['deliverableFormat', 'Deliverable format'],
];
const LIST_FIELDS: [keyof Shot, string][] = [
  ['modifiers', 'Modifiers'],
  ['props', 'Props'],
  ['equipment', 'Equipment'],
];

export function ShotPlanInspector({ node, update }: InspectorProps) {
  const { ctx, bundle, canEdit } = useEditor();
  const [openShot, setOpenShot] = useState<string | null>(null);
  const run = activeRun(ctx, node.id, 'plan');
  const generated = run?.output as ShotPlan | undefined;
  const edited = node.data.editedPlan as ShotPlan | null;
  const plan = edited ?? generated;
  const outdatedEdits = !!edited && !!run && node.data.editedFromRunId !== run.id;

  const write = (next: ShotPlan, key: string) =>
    update(
      { editedPlan: { ...next, totalSetupMinutes: next.shots.reduce((t, s) => t + (Number(s.setupMinutes) || 0), 0) }, editedFromRunId: (node.data.editedFromRunId as string | null) ?? run?.id ?? null },
      key,
    );
  const setShot = (i: number, patch: Partial<Shot>, key: string) => plan && write({ ...plan, shots: plan.shots.map((s, j) => (j === i ? { ...s, ...patch } : s)) }, key);

  return (
    <>
      <Section title="Settings">
        <div className="grid grid-cols-[90px_1fr] gap-2">
          <Field label="Shots">
            <Input type="number" min={1} max={20} value={Number(node.data.shotCount)} disabled={!canEdit} onChange={(e) => update({ shotCount: Math.max(1, Math.min(20, Number(e.target.value) || 1)) }, 'count')} />
          </Field>
          <Field label="Available gear / constraints">
            <Input value={String(node.data.gearNotes ?? '')} disabled={!canEdit} placeholder="e.g. 2× Profoto B10, no haze machine" onChange={(e) => update({ gearNotes: e.target.value }, 'gear')} />
          </Field>
        </div>
        <Field label="Notes">
          <Textarea value={String(node.data.notes ?? '')} rows={2} disabled={!canEdit} onChange={(e) => update({ notes: e.target.value }, 'notes')} />
        </Field>
        <OpControls node={node} />
      </Section>

      {plan && (
        <Section
          title={`Shot list · ${plan.shots.length}`}
          right={edited ? <Badge tone="warn">edited</Badge> : <Badge tone="cyan">generated</Badge>}
        >
          {outdatedEdits && (
            <div className="rounded-lg border border-warn/30 bg-warn/10 p-2.5 text-[12px] text-warn">
              A newer generated plan exists, but your manual edits are still in use.
              <Button size="sm" variant="outline" className="mt-2" onClick={() => update({ editedPlan: null, editedFromRunId: null })}>
                Use the new generated plan
              </Button>
            </div>
          )}
          <p className="text-[11px] text-mute">{plan.summary} Technical settings are recommendations: edit anything.</p>
          <div className="space-y-1.5">
            {plan.shots.map((s, i) => {
              const open = openShot === s.id;
              const ref = s.referenceAssetId ? bundle.assets.find((a) => a.id === s.referenceAssetId) : null;
              return (
                <div key={s.id} className={cn('rounded-lg border', open ? 'border-line-2 bg-ink' : 'border-line')}>
                  <button type="button" className="flex w-full items-center gap-2 px-2.5 py-2 text-left" onClick={() => setOpenShot(open ? null : s.id)}>
                    <ChevronRight className={cn('size-3.5 shrink-0 text-mute transition', open && 'rotate-90')} />
                    <span className="font-mono text-[11px] text-cyan">{s.id}</span>
                    <span className="min-w-0 flex-1 truncate text-[12.5px]">{s.title}</span>
                    <Badge tone={PRIORITY_TONE[s.priority]}>{s.priority}</Badge>
                    <span className="font-mono text-[10px] text-mute">{s.setupMinutes}m</span>
                  </button>
                  {open && (
                    <div className="space-y-2.5 border-t border-line px-2.5 pb-3 pt-2.5">
                      {ref && (
                        <div className="flex items-center gap-2">
                          <AssetImage asset={ref} className="size-12 rounded-md border border-line" />
                          <span className="text-[11px] text-mute">Linked reference: {ref.label}</span>
                        </div>
                      )}
                      <div className="grid grid-cols-[1fr_100px_80px] gap-2">
                        <Field label="Title">
                          <Input value={s.title} disabled={!canEdit} onChange={(e) => setShot(i, { title: e.target.value }, `${s.id}.title`)} />
                        </Field>
                        <Field label="Priority">
                          <Select value={s.priority} disabled={!canEdit} onChange={(e) => setShot(i, { priority: e.target.value as Shot['priority'] }, `${s.id}.p`)}>
                            <option value="must">must</option>
                            <option value="should">should</option>
                            <option value="nice">nice</option>
                          </Select>
                        </Field>
                        <Field label="Setup min">
                          <Input type="number" min={0} value={s.setupMinutes} disabled={!canEdit} onChange={(e) => setShot(i, { setupMinutes: Math.max(0, Number(e.target.value) || 0) }, `${s.id}.m`)} />
                        </Field>
                      </div>
                      {TEXT_FIELDS.map(([k, label]) => (
                        <Field key={k} label={label}>
                          <Input value={String(s[k] ?? '')} disabled={!canEdit} onChange={(e) => setShot(i, { [k]: e.target.value }, `${s.id}.${k}`)} />
                        </Field>
                      ))}
                      {LIST_FIELDS.map(([k, label]) => (
                        <Field key={k} label={`${label} (comma separated)`}>
                          <ListInput
                            value={s[k] as string[]}
                            separator=","
                            disabled={!canEdit}
                            onCommit={(v) => setShot(i, { [k]: v }, `${s.id}.${k}`)}
                          />
                        </Field>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <Field label="Lighting plan">
            <Textarea value={plan.lightingPlan} rows={3} disabled={!canEdit} onChange={(e) => write({ ...plan, lightingPlan: e.target.value }, 'lighting')} />
          </Field>
          <Field label="Equipment checklist (one per line)">
            <ListInput
              value={plan.equipmentChecklist}
              separator={'\n'}
              multiline
              disabled={!canEdit}
              onCommit={(v) => write({ ...plan, equipmentChecklist: v }, 'equipment')}
            />
          </Field>
          <div className="flex items-center justify-between font-mono text-[11px] text-mute">
            <span>Total setup ≈ {Math.round(plan.totalSetupMinutes / 6) / 10} h</span>
            {edited && canEdit && (
              <button className="inline-flex items-center gap-1 hover:text-cyan" onClick={() => update({ editedPlan: null, editedFromRunId: null })}>
                <RotateCcw className="size-3" /> Discard edits
              </button>
            )}
          </div>
        </Section>
      )}
      <RunHistory node={node} op="plan" update={update} renderOutput={(o) => <div className="text-[10.5px] text-mute">{(o as ShotPlan).shots.length} shots</div>} />
    </>
  );
}
