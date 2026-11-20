import { useState } from 'react';
import { Download, FileText, Loader2 } from 'lucide-react';
import type { Asset, GraphNode } from '@/core/types';
import { resolveInputs, runsFor, type ApprovedBundle, type ImageRef } from '@/core/graph';
import type { ShotPlan } from '@/core/schemas';
import { Badge, Button, Chip, Field, Input, toast } from '@/components/ui';
import { useRepo } from '@/lib/repoContext';
import { cn, errMsg, timeAgo } from '@/lib/cn';
import { useEditor } from '@/features/editor/editorContext';

export async function downloadAsset(repo: ReturnType<typeof useRepo>['repo'], asset: Asset) {
  const url = await repo.assetUrl(asset, { download: true });
  const a = document.createElement('a');
  a.href = url;
  a.download = asset.originalFilename ?? asset.label ?? 'download';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Settings, run button and history for one export node. Shared by the inspector and the toolbar dialog. */
export function ExportPanel({ node }: { node: GraphNode }) {
  const { repo } = useRepo();
  const { ctx, bundle, statuses, runOp, editor, canEdit } = useEditor();
  const [busy, setBusy] = useState(false);
  const d = node.data;
  const mode = d.mode === 'final' ? 'final' : 'draft';
  const inputs = resolveInputs(ctx, node.id);
  const approved = inputs.approved as ApprovedBundle | undefined;
  const extra = (inputs.images as ImageRef[] | undefined) ?? [];
  const plan = (inputs.shotplan as ShotPlan | undefined) ?? approved?.shotplan ?? null;
  const op = statuses[node.id]?.ops.export;
  const job = op?.job;
  const active = job && (job.status === 'queued' || job.status === 'running');
  const finalBlocked = mode === 'final' && !approved?.assetIds.length;
  const update = (patch: Record<string, unknown>, key?: string) => editor.updateData(node.id, patch, key);

  const runs = runsFor(ctx, node.id, 'export').slice().reverse();

  const go = async () => {
    setBusy(true);
    try {
      await runOp(node.id, 'export', { force: op?.freshness === 'fresh' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Field label="Pack title">
        <Input value={String(d.title ?? '')} disabled={!canEdit} onChange={(e) => update({ title: e.target.value }, 'title')} />
      </Field>
      <Field
        label="Pack type"
        hint={mode === 'final' ? 'Only client-approved images and the approved direction. Watermark-free.' : 'Everything in progress, clearly marked DRAFT with review status on every image.'}
      >
        <div className="flex gap-1.5">
          <Chip active={mode === 'draft'} disabled={!canEdit} onClick={() => update({ mode: 'draft' })}>
            Internal draft
          </Chip>
          <Chip active={mode === 'final'} disabled={!canEdit} onClick={() => update({ mode: 'final' })}>
            Final approved pack
          </Chip>
        </div>
      </Field>
      <label className="flex items-center gap-2 text-[13px] text-soft">
        <input
          type="checkbox"
          className="accent-cyan"
          checked={d.includeReferences !== false}
          disabled={!canEdit}
          onChange={(e) => update({ includeReferences: e.target.checked })}
        />
        Include product photos and inspiration references
      </label>

      <div className="grid grid-cols-3 gap-2 text-center">
        {[
          ['Approved', approved?.assetIds.length ?? 0, 'text-ok'],
          ['Pending', (approved?.pendingAssetIds.length ?? 0) + (approved?.changesRequestedAssetIds.length ?? 0), 'text-magenta'],
          ['Shots', plan?.shots.length ?? 0, 'text-cyan'],
        ].map(([k, v, c]) => (
          <div key={k as string} className="rounded-lg border border-line bg-ink py-2">
            <div className={cn('text-lg font-semibold', c as string)}>{v as number}</div>
            <div className="label-mono">{k as string}</div>
          </div>
        ))}
      </div>
      {!approved && <p className="text-[11px] text-mute">Connect a Client approval node to include review status{extra.length ? '' : ' and images'}.</p>}
      {finalBlocked && <p className="text-[12px] text-warn">Nothing is approved yet, so a final pack can&apos;t be made. Export a draft or ask the client to review.</p>}

      <Button variant="primary" className="w-full" disabled={!canEdit || finalBlocked || !!active} loading={busy || !!active} onClick={() => void go()}>
        <FileText className="size-4" /> {active ? (job.status === 'running' ? 'Building PDF…' : 'Queued…') : `Export ${mode === 'final' ? 'final' : 'draft'} PDF`}
      </Button>
      {job?.status === 'failed' && !active && <p className="text-[12px] text-err">{job.error?.message}</p>}

      <div className="space-y-1.5">
        <div className="label-mono">Exports · {runs.length}</div>
        {!runs.length && <div className="text-xs text-mute">No exports yet.</div>}
        {runs.map((r) => {
          const asset = bundle.assets.find((a) => a.id === r.outputAssetIds[0]);
          const out = r.output as { mode?: string; pageCount?: number; filename?: string };
          return (
            <div key={r.id} className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-2">
              <FileText className="size-4 shrink-0 text-mute" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px]">{out.filename ?? asset?.label ?? 'Pack'}</div>
                <div className="font-mono text-[10px] text-mute">
                  {timeAgo(r.completedAt)} · {out.pageCount ?? '?'} pages
                </div>
              </div>
              <Badge tone={out.mode === 'final' ? 'ok' : 'warn'}>{out.mode ?? 'draft'}</Badge>
              {asset && (
                <Button size="icon" variant="ghost" title="Download" aria-label="Download PDF" onClick={() => downloadAsset(repo, asset).catch((e) => toast(errMsg(e), 'err'))}>
                  <Download className="size-4" />
                </Button>
              )}
            </div>
          );
        })}
      </div>
      {active && (
        <div className="flex items-center gap-2 text-[11px] text-mute">
          <Loader2 className="size-3 animate-spin" /> The PDF is stored before the job is marked complete.
        </div>
      )}
    </div>
  );
}
