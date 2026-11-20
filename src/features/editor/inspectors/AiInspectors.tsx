import { CheckCircle2, Circle } from 'lucide-react';
import { ASPECT_RATIOS, KEEP_OPTIONS, POSE_CHANGE_OPTIONS, QUALITIES, type DirectionsOutput, type ReferenceAnalysis } from '@/core/schemas';
import { activeRun, resolveInputs, type ImageRef } from '@/core/graph';
import { conceptImagePrompt } from '@/core/prompts';
import type { Brief } from '@/core/schemas';
import { Field, Select, Textarea } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useEditor } from '../editorContext';
import { MultiChips, OpControls, OutputGallery, RunHistory, Section, SourcePicker, type InspectorProps } from './shared';

function ImageSettings({ node, update, maxVariations = 4 }: InspectorProps & { maxVariations?: number }) {
  const { canEdit } = useEditor();
  return (
    <div className="grid grid-cols-[72px_1fr_1fr] gap-2">
      <Field label="Variations">
        <Select value={String(node.data.variations)} disabled={!canEdit} onChange={(e) => update({ variations: Number(e.target.value) })}>
          {Array.from({ length: maxVariations }, (_, i) => i + 1).map((n) => <option key={n}>{n}</option>)}
        </Select>
      </Field>
      <Field label="Aspect">
        <Select value={String(node.data.aspectRatio)} disabled={!canEdit} onChange={(e) => update({ aspectRatio: e.target.value })}>
          {ASPECT_RATIOS.map((r) => <option key={r}>{r}</option>)}
        </Select>
      </Field>
      <Field label="Quality">
        <Select value={String(node.data.quality)} disabled={!canEdit} onChange={(e) => update({ quality: e.target.value })}>
          {QUALITIES.map((q) => <option key={q}>{q}</option>)}
        </Select>
      </Field>
    </div>
  );
}

export function AnalysisView({ a }: { a: ReferenceAnalysis }) {
  const rows: [string, string][] = [
    ['Composition', a.composition],
    ['Lighting', a.lighting],
    ['Background', a.background],
    ['Textures', a.textures],
    ['Pose', a.pose],
    ['Styling', a.styling],
    ['Mood', a.mood],
  ];
  return (
    <div className="space-y-2.5 text-[12.5px]">
      <p className="text-soft">{a.summary}</p>
      <div className="flex gap-1">
        {a.colour.palette.map((c) => (
          <div key={c} className="flex-1">
            <div className="h-7 rounded-md border border-line" style={{ background: c }} />
            <div className="mt-0.5 text-center font-mono text-[9px] text-mute">{c}</div>
          </div>
        ))}
      </div>
      <div className="text-[11px] text-mute">Contrast: {a.colour.contrast}. {a.colour.notes}</div>
      {rows.map(([k, v]) => (
        <div key={k}>
          <div className="label-mono">{k}</div>
          <div className="text-soft">{v}</div>
        </div>
      ))}
    </div>
  );
}

export function AnalysisInspector({ node, update }: InspectorProps) {
  const { ctx, canEdit } = useEditor();
  const run = activeRun(ctx, node.id, 'analyze');
  const focus = (node.data.focus as string[]) ?? [];
  return (
    <>
      <Section title="Run">
        <OpControls node={node} />
      </Section>
      <Section title="Settings">
        <Field label="Analyse for">
          <MultiChips options={['composition', 'lighting', 'colour', 'background', 'pose', 'styling'] as const} value={focus as never[]} disabled={!canEdit} onChange={(v) => update({ focus: v })} />
        </Field>
        <Field label="Notes for the analyst">
          <Textarea value={String(node.data.notes ?? '')} disabled={!canEdit} rows={2} onChange={(e) => update({ notes: e.target.value }, 'notes')} />
        </Field>
      </Section>
      {run && (
        <Section title="Analysis">
          <AnalysisView a={run.output as ReferenceAnalysis} />
        </Section>
      )}
      <RunHistory node={node} op="analyze" update={update} />
    </>
  );
}

export function ConceptInspector({ node, update }: InspectorProps) {
  const { ctx, canEdit, statuses } = useEditor();
  const dirRun = activeRun(ctx, node.id, 'directions');
  const out = dirRun?.output as DirectionsOutput | undefined;
  const sel = node.data.selectedDirection as number | null;
  const brief = (resolveInputs(ctx, node.id).brief as Brief | undefined) ?? null;
  const autoPrompt = out && sel != null && out.directions[sel] ? conceptImagePrompt(brief, out.directions[sel]!, '') : '';

  return (
    <>
      <Section title="1 · Creative directions">
        <Field label="Extra guidance (optional)">
          <Textarea value={String(node.data.guidance ?? '')} rows={2} disabled={!canEdit} placeholder="e.g. lean premium, avoid warm tones" onChange={(e) => update({ guidance: e.target.value }, 'guidance')} />
        </Field>
        <OpControls node={node} only={['directions']} />
        {out && (
          <div className="space-y-2">
            {out.directions.map((d, i) => (
              <button
                key={i}
                type="button"
                disabled={!canEdit}
                onClick={() => update({ selectedDirection: i })}
                className={cn('w-full rounded-xl border p-3 text-left transition', sel === i ? 'border-cyan/70 bg-cyan-dim' : 'border-line hover:border-line-2')}
              >
                <div className="flex items-center gap-2">
                  {sel === i ? <CheckCircle2 className="size-4 text-cyan" /> : <Circle className="size-4 text-mute" />}
                  <span className="font-medium">{d.title}</span>
                  <span className="ml-auto flex gap-0.5">{d.palette.map((c) => <span key={c} className="size-3 rounded-sm border border-line" style={{ background: c }} />)}</span>
                </div>
                <p className="mt-1.5 text-[12px] text-soft">{d.creativeDirection}</p>
                {sel === i && (
                  <div className="mt-2 space-y-1.5 text-[11.5px]">
                    <div><span className="label-mono">Why </span><span className="text-soft">{d.rationale}</span></div>
                    <div><span className="label-mono">Light </span><span className="text-soft">{d.lighting}</span></div>
                    <div><span className="label-mono">Shots </span><span className="text-soft">{d.proposedShots.join(' · ')}</span></div>
                    <div><span className="label-mono">Poses </span><span className="text-soft">{d.poseSuggestions.join(' · ')}</span></div>
                    <div><span className="label-mono">Set & props </span><span className="text-soft">{d.backgroundAndProps.join(' · ')}</span></div>
                    {d.negativeInstructions.length > 0 && <div><span className="label-mono">Avoid </span><span className="text-soft">{d.negativeInstructions.join(' · ')}</span></div>}
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
      </Section>
      <Section title="2 · Concept images">
        <ImageSettings node={node} update={update} />
        <Field label="Prompt" hint={node.data.promptOverride ? 'Custom prompt in use. Clear it to go back to the generated one.' : 'Generated from the selected direction. Edit to override.'}>
          <Textarea
            value={String(node.data.promptOverride || autoPrompt)}
            rows={6}
            disabled={!canEdit || sel == null}
            className="font-mono text-[11px]"
            onChange={(e) => update({ promptOverride: e.target.value === autoPrompt ? '' : e.target.value }, 'prompt')}
          />
        </Field>
        <OpControls node={node} only={['render']} />
        <OutputGallery node={node} update={update} op="render" />
        {statuses[node.id]?.ops.render?.activeRun && <p className="text-[11px] text-mute">AI concepts are planning references, not photographs of the real product.</p>}
      </Section>
      <RunHistory node={node} op="render" update={update} renderOutput={(_, ids) => <div className="font-mono text-[10.5px] text-mute">{ids.length} image(s)</div>} />
    </>
  );
}

export function PoseInspector({ node, update }: InspectorProps) {
  const { ctx, canEdit } = useEditor();
  const images = (resolveInputs(ctx, node.id).images as ImageRef[] | undefined) ?? [];
  return (
    <>
      <Section title="Source concept">
        <SourcePicker node={node} update={update} images={images} />
      </Section>
      <Section title="Variation rules">
        <Field label="May change">
          <MultiChips options={POSE_CHANGE_OPTIONS} value={(node.data.change as never[]) ?? []} disabled={!canEdit} onChange={(v) => update({ change: v })} />
        </Field>
        <Field label="Must stay identical">
          <MultiChips options={KEEP_OPTIONS} value={(node.data.keep as never[]) ?? []} disabled={!canEdit} onChange={(v) => update({ keep: v })} />
        </Field>
        <Field label="Model direction notes">
          <Textarea value={String(node.data.notes ?? '')} rows={2} disabled={!canEdit} placeholder="e.g. confident, relaxed shoulders, watch face visible" onChange={(e) => update({ notes: e.target.value }, 'notes')} />
        </Field>
        <ImageSettings node={node} update={update} maxVariations={6} />
        <OpControls node={node} />
      </Section>
      <Section title="Pose references">
        <OutputGallery node={node} update={update} op="poses" />
        <p className="text-[11px] text-mute">Pose references guide direction on set. They are not guaranteed representations of the final shoot.</p>
      </Section>
      <RunHistory node={node} op="poses" update={update} renderOutput={(o) => <div className="text-[10.5px] text-mute">{((o as { labels?: string[] }).labels ?? []).join(' / ')}</div>} />
    </>
  );
}

export function EditInspector({ node, update }: InspectorProps) {
  const { ctx, canEdit } = useEditor();
  const images = (resolveInputs(ctx, node.id).images as ImageRef[] | undefined) ?? [];
  return (
    <>
      <Section title="Source">
        <SourcePicker node={node} update={update} images={images} />
        <p className="text-[11px] text-mute">Edits create a new version. Any approval on the old version is kept, and the new version needs its own approval.</p>
      </Section>
      <Section title="Edit">
        <Field label="Instruction">
          <Textarea value={String(node.data.instruction ?? '')} rows={3} disabled={!canEdit} placeholder="e.g. swap the backdrop to warm grey, keep everything else" onChange={(e) => update({ instruction: e.target.value }, 'instruction')} />
        </Field>
        <Field label="Preserve exactly">
          <MultiChips options={KEEP_OPTIONS} value={(node.data.preserve as never[]) ?? []} disabled={!canEdit} onChange={(v) => update({ preserve: v })} />
        </Field>
        <ImageSettings node={node} update={update} />
        <OpControls node={node} />
      </Section>
      <Section title="Edited versions">
        <OutputGallery node={node} update={update} op="edit" />
      </Section>
      <RunHistory node={node} op="edit" update={update} />
    </>
  );
}
