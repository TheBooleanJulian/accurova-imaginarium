import { useState } from 'react';
import { ExternalLink, MessageSquare } from 'lucide-react';
import type { Asset } from '@/core/types';
import { buildApprovedBundle, resolveInputs, type DirectionValue, type ImageRef } from '@/core/graph';
import type { ShotPlan } from '@/core/schemas';
import { can } from '@/core/permissions';
import { Badge, Button, Field, Input, Textarea, toast } from '@/components/ui';
import { useRepo } from '@/lib/repoContext';
import { navigate } from '@/lib/router';
import { cn, errMsg, timeAgo } from '@/lib/cn';
import { AssetCard, AssetLightbox } from '@/features/assets/AssetViews';
import { ExportPanel } from '@/features/export/ExportPanel';
import { useEditor } from '../editorContext';
import { Section, type InspectorProps } from './shared';

export function ApprovalInspector({ node, update }: InspectorProps) {
  const { ctx, bundle, canEdit } = useEditor();
  const [open, setOpen] = useState<Asset | null>(null);
  const inputs = resolveInputs(ctx, node.id);
  const images = (inputs.images as ImageRef[] | undefined) ?? [];
  const b = buildApprovedBundle(node.id, images, bundle.approvals, inputs.direction as DirectionValue | undefined, inputs.shotplan as ShotPlan | undefined);
  const current = new Set([...b.assetIds, ...b.pendingAssetIds, ...b.changesRequestedAssetIds]);
  const superseded = images.filter((i) => !current.has(i.assetId)).length;
  const list = [...b.changesRequestedAssetIds, ...b.pendingAssetIds, ...b.assetIds]
    .map((id) => bundle.assets.find((a) => a.id === id))
    .filter((a): a is Asset => !!a);

  return (
    <>
      <Section title="What the client sees">
        <Field label="Title">
          <Input value={String(node.data.title ?? '')} disabled={!canEdit} onChange={(e) => update({ title: e.target.value }, 'title')} />
        </Field>
        <Field label="Message to the client">
          <Textarea value={String(node.data.message ?? '')} rows={3} disabled={!canEdit} onChange={(e) => update({ message: e.target.value }, 'message')} />
        </Field>
        <Button variant="outline" size="sm" onClick={() => navigate(`/p/${bundle.project.id}/review`)}>
          <ExternalLink className="size-3.5" /> Open client view
        </Button>
      </Section>
      <Section title={`Review status · ${list.length}`}>
        <div className="flex flex-wrap gap-1.5">
          <Badge tone="ok">{b.assetIds.length} approved</Badge>
          <Badge tone="gold">{b.pendingAssetIds.length} pending</Badge>
          <Badge tone="err">{b.changesRequestedAssetIds.length} changes requested</Badge>
        </div>
        <div className="space-y-1 text-[11px] text-mute">
          <div>Direction: {b.direction ? <span className="text-soft">{b.direction.title}</span> : 'not connected'}</div>
          <div>Shot plan: {b.shotplan ? <span className="text-soft">{b.shotplan.shots.length} shots</span> : 'not connected'}</div>
          {superseded > 0 && <div>{superseded} older version(s) superseded by newer edits. Their approvals are kept on record.</div>}
        </div>
        {!list.length ? (
          <div className="text-xs text-mute">Connect concept, pose or edit outputs to put them up for review.</div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {list.map((a) => (
              <AssetCard key={a.id} asset={a} bundle={bundle} onClick={() => setOpen(a)} />
            ))}
          </div>
        )}
        <p className="text-[11px] text-mute">Only approved versions flow out of this node. Invite your client with Share in the toolbar.</p>
      </Section>
      <AssetLightbox asset={open} bundle={bundle} onClose={() => setOpen(null)} />
    </>
  );
}

export function ExportInspector({ node }: InspectorProps) {
  return (
    <Section title="PDF pack">
      <ExportPanel node={node} />
    </Section>
  );
}

/** Node-level comments (asset comments live in the lightbox). */
export function NodeComments({ nodeId }: { nodeId: string }) {
  const { repo } = useRepo();
  const { bundle } = useEditor();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const comments = bundle.comments.filter((c) => c.nodeId === nodeId && !c.assetId).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const open = comments.filter((c) => !c.resolved).length;
  const post = async () => {
    setBusy(true);
    try {
      await repo.addComment(bundle.project.id, { nodeId, body });
      setBody('');
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title={`Comments${open ? ` · ${open}` : ''}`} defaultOpen={open > 0} right={<MessageSquare className="size-3.5 text-mute" />}>
      {comments.map((c) => (
        <div key={c.id} className={cn('rounded-lg border border-line px-3 py-2', c.resolved && 'opacity-50')}>
          <div className="flex items-center gap-2 text-[11px] text-mute">
            <span className="text-soft">{c.authorName}</span> · {timeAgo(c.createdAt)}
            {can(bundle.myRole, 'comment.resolve') && (
              <button className="ml-auto hover:text-teal" onClick={() => repo.resolveComment(c.id, !c.resolved).catch((e) => toast(errMsg(e), 'err'))}>
                {c.resolved ? 'Reopen' : 'Resolve'}
              </button>
            )}
          </div>
          <div className="mt-0.5 whitespace-pre-wrap text-[13px]">{c.body}</div>
        </div>
      ))}
      {can(bundle.myRole, 'comment.create') && (
        <div className="space-y-2">
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} placeholder="Leave a note on this node" />
          <Button size="sm" disabled={!body.trim()} loading={busy} onClick={() => void post()}>
            Comment
          </Button>
        </div>
      )}
    </Section>
  );
}
