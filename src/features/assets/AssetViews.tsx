import { useState, type ReactNode } from 'react';
import { CheckCircle2, Download, MessageSquare, RotateCcw, XCircle } from 'lucide-react';
import type { Asset, ProjectBundle } from '@/core/types';
import { approvalStateOf, type ApprovalState } from '@/core/graph';
import { can } from '@/core/permissions';
import { AI_DISCLAIMER } from '@/core/executors';
import { AssetImage, Badge, Button, Modal, ProvenanceBadge, Textarea, toast, useAssetUrl } from '@/components/ui';
import { useRepo } from '@/lib/repoContext';
import { cn, errMsg, timeAgo } from '@/lib/cn';

export function ApprovalPill({ state }: { state: ApprovalState }) {
  if (state === 'approved') return <Badge tone="ok"><CheckCircle2 className="size-3" /> Approved</Badge>;
  if (state === 'changes_requested') return <Badge tone="err"><RotateCcw className="size-3" /> Changes</Badge>;
  return <Badge tone="gold">Pending</Badge>;
}

export function AssetCard({
  asset,
  bundle,
  selected,
  onClick,
  onToggle,
  footer,
  showApproval = true,
}: {
  asset: Asset;
  bundle: ProjectBundle;
  selected?: boolean;
  onClick?: () => void;
  onToggle?: () => void;
  footer?: ReactNode;
  showApproval?: boolean;
}) {
  const state = approvalStateOf(bundle.approvals, asset.id);
  const comments = bundle.comments.filter((c) => c.assetId === asset.id && !c.resolved).length;
  return (
    <div className={cn('group overflow-hidden rounded-lg border bg-ink', selected ? 'border-teal ring-1 ring-teal/40' : 'border-line')}>
      <button type="button" onClick={onClick} className="relative block aspect-square w-full overflow-hidden">
        <AssetImage asset={asset} className="h-full w-full transition group-hover:scale-[1.02]" />
        <div className="absolute left-1.5 top-1.5"><ProvenanceBadge asset={asset} /></div>
        {comments > 0 && (
          <span className="absolute bottom-1.5 right-1.5 inline-flex items-center gap-1 rounded-md bg-void/80 px-1.5 py-0.5 font-mono text-[10px] text-soft">
            <MessageSquare className="size-3" />{comments}
          </span>
        )}
      </button>
      <div className="space-y-1 p-1.5">
        <div className="truncate text-[11px] text-soft" title={asset.label ?? ''}>{asset.label}</div>
        <div className="flex items-center gap-1">
          {showApproval && asset.sourceType !== 'upload' && <ApprovalPill state={state} />}
          {onToggle && (
            <button type="button" onClick={onToggle} className={cn('ml-auto rounded-md border px-1.5 py-0.5 font-mono text-[10px] uppercase', selected ? 'border-teal/60 text-teal' : 'border-line text-mute hover:text-soft')}>
              {selected ? 'Selected' : 'Select'}
            </button>
          )}
        </div>
        {footer}
      </div>
    </div>
  );
}

/** Full-size view with provenance, version history, comments and approval actions. */
export function AssetLightbox({ asset, bundle, onClose }: { asset: Asset | null; bundle: ProjectBundle; onClose: () => void }) {
  const { repo } = useRepo();
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const url = useAssetUrl(asset);
  if (!asset) return null;

  const state = approvalStateOf(bundle.approvals, asset.id);
  const history = bundle.approvals.filter((a) => a.assetId === asset.id).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const comments = bundle.comments.filter((c) => c.assetId === asset.id).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const lineage = asset.versionOf ?? asset.id;
  const versions = bundle.assets.filter((a) => (a.versionOf ?? a.id) === lineage).sort((a, b) => a.version - b.version);
  const parent = asset.parentAssetId ? bundle.assets.find((a) => a.id === asset.parentAssetId) : null;
  const job = asset.jobId ? bundle.jobs.find((j) => j.id === asset.jobId) : null;
  const canApprove = can(bundle.myRole, 'approval.create') && asset.sourceType === 'ai_generated';
  const canComment = can(bundle.myRole, 'comment.create');

  const act = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try {
      await fn();
      toast(ok, 'ok');
      setComment('');
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal open onClose={onClose} title={<span className="flex items-center gap-2"><ProvenanceBadge asset={asset} /> <span className="truncate">{asset.label}</span></span>} wide>
      <div className="grid gap-5 md:grid-cols-[1.4fr_1fr]">
        <div className="space-y-2">
          <div className="checker overflow-hidden rounded-xl border border-line">
            {url ? <img src={url} alt={asset.label ?? ''} className="mx-auto max-h-[62vh] w-auto object-contain" /> : <div className="aspect-square" />}
          </div>
          {asset.sourceType === 'ai_generated' && <p className="text-[11px] leading-snug text-mute">{asset.role === 'pose' ? 'Pose reference only — not a final photograph.' : AI_DISCLAIMER}</p>}
          {asset.sourceType === 'upload' && <p className="text-[11px] text-mute">Original file, preserved unmodified{asset.width ? ` · ${asset.width}×${asset.height}` : ''}.</p>}
          {versions.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-soft">
              <span className="label-mono">Versions</span>
              {versions.map((v) => (
                <span key={v.id} className={cn('rounded border px-1.5 py-0.5 font-mono', v.id === asset.id ? 'border-teal/60 text-teal' : 'border-line')}>
                  v{v.version} · {approvalStateOf(bundle.approvals, v.id).replace('_', ' ')}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-4 text-sm">
          {canApprove && (
            <div className="space-y-2 rounded-xl border border-line bg-ink p-3">
              <div className="flex items-center justify-between">
                <span className="label-mono">Decision · v{asset.version}</span>
                <ApprovalPill state={state} />
              </div>
              <Textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Add a note (required when requesting changes)" rows={2} />
              <div className="grid grid-cols-2 gap-2">
                <Button variant="primary" loading={busy === 'approve'} onClick={() => act('approve', () => repo.recordApproval(asset.projectId, asset.id, 'approved', comment), 'Approved')}>
                  <CheckCircle2 className="size-4" /> Approve
                </Button>
                <Button
                  variant="danger"
                  loading={busy === 'changes'}
                  onClick={() => act('changes', () => repo.recordApproval(asset.projectId, asset.id, 'changes_requested', comment), 'Change request sent')}
                >
                  <XCircle className="size-4" /> Request changes
                </Button>
              </div>
              {history.length > 0 && (
                <div className="space-y-1 border-t border-line pt-2">
                  {history.map((h) => (
                    <div key={h.id} className="text-[11px] text-soft">
                      <span className={h.decision === 'approved' ? 'text-ok' : 'text-err'}>{h.decision === 'approved' ? 'Approved' : 'Changes requested'}</span> by {h.reviewerName} · {timeAgo(h.createdAt)}
                      {h.comment && <div className="text-mute">“{h.comment}”</div>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="space-y-2">
            <div className="label-mono">Comments</div>
            {comments.length === 0 && <div className="text-xs text-mute">No comments yet.</div>}
            {comments.map((c) => (
              <div key={c.id} className={cn('rounded-lg border border-line px-3 py-2', c.resolved && 'opacity-50')}>
                <div className="flex items-center gap-2 text-[11px] text-mute">
                  <span className="text-soft">{c.authorName}</span> · {timeAgo(c.createdAt)}
                  {c.resolved && <Badge>resolved</Badge>}
                  {can(bundle.myRole, 'comment.resolve') && (
                    <button className="ml-auto hover:text-teal" onClick={() => repo.resolveComment(c.id, !c.resolved).catch((e) => toast(errMsg(e), 'err'))}>
                      {c.resolved ? 'Reopen' : 'Resolve'}
                    </button>
                  )}
                </div>
                <div className="mt-0.5 whitespace-pre-wrap text-[13px]">{c.body}</div>
              </div>
            ))}
            {canComment && !canApprove && (
              <div className="space-y-2">
                <Textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Comment on this image" rows={2} />
                <Button size="sm" loading={busy === 'comment'} onClick={() => act('comment', () => repo.addComment(asset.projectId, { assetId: asset.id, body: comment }), 'Comment added')}>
                  Comment
                </Button>
              </div>
            )}
            {canComment && canApprove && (
              <Button size="sm" variant="ghost" disabled={!comment.trim()} loading={busy === 'comment'} onClick={() => act('comment', () => repo.addComment(asset.projectId, { assetId: asset.id, body: comment }), 'Comment added')}>
                <MessageSquare className="size-3.5" /> Post note as comment only
              </Button>
            )}
          </div>

          <div className="space-y-1 rounded-xl border border-line p-3 text-[11px] text-soft">
            <div className="label-mono mb-1">Provenance</div>
            <div>Source: <span className="text-text">{asset.sourceType === 'upload' ? 'Uploaded original' : asset.sourceType === 'export' ? 'Export' : 'AI generated'}</span></div>
            <div>Role: <span className="text-text">{asset.role}</span> · v{asset.version}</div>
            {parent && <div>Derived from: <span className="text-text">{parent.label}</span></div>}
            {job && <div>Model: <span className="font-mono text-text">{job.provider}/{job.model}</span></div>}
            <div>Created {timeAgo(asset.createdAt)}</div>
            {asset.prompt && (
              <details className="pt-1">
                <summary className="cursor-pointer text-mute hover:text-soft">Prompt</summary>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[10.5px] text-mute">{asset.prompt}</pre>
              </details>
            )}
            {url && (
              <a href={url} download={asset.originalFilename ?? `${asset.id}`} className="mt-1 inline-flex items-center gap-1 text-teal hover:underline">
                <Download className="size-3" /> Download
              </a>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
