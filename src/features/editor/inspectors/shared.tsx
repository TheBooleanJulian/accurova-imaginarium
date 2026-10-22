import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, CircleStop, History, Pin, Play, RefreshCw } from 'lucide-react';
import type { Asset, GraphNode } from '@/core/types';
import { getNodeDef } from '@/core/nodeRegistry';
import { runsFor, type ImageRef } from '@/core/graph';
import { AssetImage, Badge, Button, Chip, Input, Textarea, toast } from '@/components/ui';
import { useRepo } from '@/lib/repoContext';
import { cn, errMsg, timeAgo } from '@/lib/cn';
import { AssetCard, AssetLightbox } from '@/features/assets/AssetViews';
import { useEditor } from '../editorContext';

export interface InspectorProps {
  node: GraphNode;
  update: (patch: Record<string, unknown>, coalesceKey?: string) => void;
}

export function Section({ title, children, right, defaultOpen = true }: { title: string; children: ReactNode; right?: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b border-line">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-4 py-2.5 text-left">
        <ChevronDown className={cn('size-3.5 text-mute transition', !open && '-rotate-90')} />
        <span className="label-mono">{title}</span>
        <span className="ml-auto" onClick={(e) => e.stopPropagation()}>{right}</span>
      </button>
      {open && <div className="space-y-3 px-4 pb-4">{children}</div>}
    </section>
  );
}

export function MultiChips<T extends string>({ options, value, onChange, disabled }: { options: readonly T[]; value: T[]; onChange: (v: T[]) => void; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <Chip key={o} active={value.includes(o)} disabled={disabled} onClick={() => onChange(value.includes(o) ? value.filter((x) => x !== o) : [...value, o])}>
          {o}
        </Chip>
      ))}
    </div>
  );
}

/** Run / regenerate / cancel controls for each operation of a node. */
export function OpControls({ node, only }: { node: GraphNode; only?: string[] }) {
  const { statuses, runOp, canEdit } = useEditor();
  const { repo } = useRepo();
  const def = getNodeDef(node.type);
  const status = statuses[node.id];
  const ops = def.operations.filter((o) => o.kind === 'ai' && (!only || only.includes(o.id)));
  if (!ops.length || !status) return null;
  return (
    <div className="space-y-2">
      {ops.map((op) => {
        const s = status.ops[op.id];
        const job = s?.job;
        const active = job && (job.status === 'queued' || job.status === 'running');
        const notReady = op.check?.(node.data);
        const fresh = s?.freshness === 'fresh';
        return (
          <div key={op.id} className="rounded-lg border border-line bg-ink p-2.5">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium">{op.label}</div>
                <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                  {s?.freshness === 'stale' && <Badge tone="warn">stale · inputs changed</Badge>}
                  {fresh && <Badge tone="ok">up to date</Badge>}
                  {s?.freshness === 'never_run' && <Badge>not run</Badge>}
                  {s?.newerCandidate && <Badge tone="gold">newer version held back</Badge>}
                  {active && <Badge tone="teal">{job.status}{job.attempts > 1 ? ` · attempt ${job.attempts}` : ''}</Badge>}
                  {!active && job?.status === 'failed' && <Badge tone="err">failed</Badge>}
                </div>
              </div>
              {active ? (
                <Button size="sm" variant="danger" onClick={() => repo.cancelJob(job.id).catch((e) => toast(errMsg(e), 'err'))}>
                  <CircleStop className="size-3.5" /> Cancel
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant={fresh ? 'outline' : 'primary'}
                  disabled={!canEdit || !!notReady}
                  title={notReady ?? undefined}
                  onClick={() => void runOp(node.id, op.id, { force: fresh || s?.freshness === 'stale' })}
                >
                  {s?.activeRun ? <RefreshCw className="size-3.5" /> : <Play className="size-3.5" />}
                  {s?.activeRun ? 'Regenerate' : 'Run'}
                </Button>
              )}
            </div>
            {notReady && <div className="mt-1.5 text-[11px] text-mute">{notReady}</div>}
            {!active && job?.status === 'failed' && job.error && <div className="mt-1.5 text-[11px] text-err">{job.error.message}</div>}
          </div>
        );
      })}
    </div>
  );
}

/** Output version history for one operation, with "use this version". */
export function RunHistory({ node, op, update, renderOutput }: { node: GraphNode; op: string; update: InspectorProps['update']; renderOutput?: (output: unknown, ids: string[]) => ReactNode }) {
  const { ctx, statuses, bundle, canEdit } = useEditor();
  const runs = runsFor(ctx, node.id, op).slice().reverse();
  const activeId = statuses[node.id]?.ops[op]?.activeRun?.id;
  const pinned = (node.data.pinned as Record<string, string> | undefined)?.[op];
  if (runs.length < 1) return null;
  return (
    <Section title={`History · ${runs.length}`} defaultOpen={runs.length > 1} right={<History className="size-3.5 text-mute" />}>
      <div className="space-y-2">
        {runs.map((r, i) => {
          const job = bundle.jobs.find((j) => j.id === r.jobId);
          const isActive = r.id === activeId;
          return (
            <div key={r.id} className={cn('rounded-lg border p-2', isActive ? 'border-teal/50 bg-teal-dim' : 'border-line')}>
              <div className="flex items-center gap-2 text-[11px]">
                <span className="font-mono text-soft">v{runs.length - i}</span>
                <span className="text-mute">{timeAgo(r.completedAt)}</span>
                {job && <span className="truncate font-mono text-[10px] text-mute">{job.model}</span>}
                {r.inputHash !== statuses[node.id]?.ops[op]?.currentHash && <Badge tone="warn">old inputs</Badge>}
                <span className="ml-auto flex items-center gap-1">
                  {isActive ? (
                    <Badge tone="teal">{pinned === r.id ? 'pinned' : 'active'}</Badge>
                  ) : (
                    canEdit && (
                      <Button size="sm" variant="ghost" onClick={() => update({ pinned: { ...(node.data.pinned as object), [op]: r.id }, selectedAssetIds: [] })}>
                        <Pin className="size-3" /> Use
                      </Button>
                    )
                  )}
                  {isActive && pinned === r.id && canEdit && (
                    <Button size="sm" variant="ghost" onClick={() => {
                      const next = { ...(node.data.pinned as Record<string, string>) };
                      delete next[op];
                      update({ pinned: next });
                    }}>
                      Unpin
                    </Button>
                  )}
                </span>
              </div>
              {renderOutput && <div className="mt-2">{renderOutput(r.output, r.outputAssetIds)}</div>}
            </div>
          );
        })}
      </div>
    </Section>
  );
}

/** Gallery of a node's active outputs with selection for downstream use. */
export function OutputGallery({ node, op, update }: InspectorProps & { op: string }) {
  const { statuses, bundle, canEdit } = useEditor();
  const [open, setOpen] = useState<Asset | null>(null);
  const run = statuses[node.id]?.ops[op]?.activeRun;
  if (!run) return null;
  const selected = (node.data.selectedAssetIds as string[]) ?? [];
  const assets = run.outputAssetIds.map((id) => bundle.assets.find((a) => a.id === id)).filter((a): a is Asset => !!a);
  const toggle = (id: string) => update({ selectedAssetIds: selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id] });
  return (
    <div className="space-y-2">
      <div className="text-[11px] text-mute">
        {selected.length ? `${selected.filter((s) => run.outputAssetIds.includes(s)).length} selected → only these flow downstream.` : 'All outputs flow downstream. Select some to narrow it.'}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {assets.map((a) => (
          <AssetCard key={a.id} asset={a} bundle={bundle} selected={selected.includes(a.id)} onClick={() => setOpen(a)} onToggle={canEdit ? () => toggle(a.id) : undefined} />
        ))}
      </div>
      <AssetLightbox asset={open} bundle={bundle} onClose={() => setOpen(null)} />
    </div>
  );
}

export function SourcePicker({ node, update, images }: InspectorProps & { images: ImageRef[] }) {
  const { bundle, canEdit } = useEditor();
  const current = (node.data.sourceAssetId as string | null) ?? null;
  if (!images.length) return <div className="text-xs text-mute">Connect an image source.</div>;
  const effective = images.find((i) => i.assetId === current)?.assetId ?? images.find((i) => i.sourceType === 'ai_generated')?.assetId ?? images[0]!.assetId;
  return (
    <div className="grid grid-cols-4 gap-1.5">
      {images.map((i) => {
        const a = bundle.assets.find((x) => x.id === i.assetId);
        if (!a) return null;
        const on = effective === i.assetId;
        return (
          <button
            key={i.assetId}
            type="button"
            disabled={!canEdit}
            onClick={() => update({ sourceAssetId: i.assetId })}
            className={cn('relative aspect-square overflow-hidden rounded-md border', on ? 'border-teal ring-1 ring-teal/50' : 'border-line opacity-70 hover:opacity-100')}
            title={a.label ?? ''}
          >
            <ImageThumb asset={a} />
            {on && <span className="absolute inset-x-0 bottom-0 bg-teal/90 py-0.5 text-center font-mono text-[9px] font-semibold text-void">SOURCE</span>}
          </button>
        );
      })}
    </div>
  );
}

function ImageThumb({ asset }: { asset: Asset }) {
  return <AssetImage asset={asset} className="h-full w-full" thumb />;
}

/**
 * Edits a string list as free text. The text is kept as typed while focused
 * (so separators and blank lines can be typed) and parsed into the list on blur.
 */
export function ListInput({
  value,
  separator,
  multiline,
  disabled,
  onCommit,
}: {
  value: string[];
  separator: string;
  multiline?: boolean;
  disabled?: boolean;
  onCommit: (v: string[]) => void;
}) {
  const joiner = separator === ',' ? ', ' : separator;
  const [draft, setDraft] = useState(value.join(joiner));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(value.join(joiner));
  }, [value, joiner, focused]);
  const commit = () => {
    setFocused(false);
    const next = draft.split(separator).map((x) => x.trim()).filter(Boolean);
    if (next.join('\u0000') !== value.join('\u0000')) onCommit(next);
  };
  const common = {
    value: draft,
    disabled,
    onFocus: () => setFocused(true),
    onBlur: commit,
  };
  return multiline ? (
    <Textarea {...common} rows={5} onChange={(e) => setDraft(e.target.value)} />
  ) : (
    <Input {...common} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
  );
}
