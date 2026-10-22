import { useRef, useState, type DragEvent } from 'react';
import { ImagePlus, Trash2 } from 'lucide-react';
import type { Asset } from '@/core/types';
import { UPLOAD_LIMITS } from '@/core/schemas';
import { Field, Input, Select, Spinner, Textarea, toast } from '@/components/ui';
import { useRepo } from '@/lib/repoContext';
import { cn, errMsg } from '@/lib/cn';
import { AssetCard, AssetLightbox } from '@/features/assets/AssetViews';
import { useEditor } from '../editorContext';
import { Section, type InspectorProps } from './shared';

const BRIEF_FIELDS: [key: string, label: string, placeholder: string, rows: number][] = [
  ['client', 'Client', 'Company / brand', 1],
  ['product', 'Product', 'What is being photographed', 1],
  ['audience', 'Audience', 'Who the campaign speaks to', 2],
  ['objective', 'Campaign objective', 'What the imagery must achieve', 2],
  ['visualStyle', 'Visual style', 'Mood words, references, brand guidelines', 2],
  ['deliverables', 'Deliverables', 'e.g. 6 hero stills, 4:5 + 9:16 crops, web banners', 2],
  ['constraints', 'Constraints', 'Budget, location, talent, timing, legal', 2],
];

export function BriefInspector({ node, update }: InspectorProps) {
  const { canEdit } = useEditor();
  return (
    <Section title="Creative brief">
      {BRIEF_FIELDS.map(([k, label, ph, rows]) => (
        <Field key={k} label={label}>
          {rows === 1 ? (
            <Input value={String(node.data[k] ?? '')} placeholder={ph} disabled={!canEdit} onChange={(e) => update({ [k]: e.target.value }, k)} />
          ) : (
            <Textarea value={String(node.data[k] ?? '')} placeholder={ph} rows={rows} disabled={!canEdit} onChange={(e) => update({ [k]: e.target.value }, k)} />
          )}
        </Field>
      ))}
    </Section>
  );
}

export function TextInspector({ node, update }: InspectorProps) {
  const { canEdit } = useEditor();
  return (
    <Section title="Note">
      <Field label="Title">
        <Input value={String(node.data.title ?? '')} disabled={!canEdit} onChange={(e) => update({ title: e.target.value }, 'title')} />
      </Field>
      <Field label="Text" hint="Flows into the concept generator as art-direction notes.">
        <Textarea value={String(node.data.text ?? '')} rows={8} disabled={!canEdit} onChange={(e) => update({ text: e.target.value }, 'text')} />
      </Field>
    </Section>
  );
}

export function ImageAssetInspector({ node, update }: InspectorProps) {
  const { repo } = useRepo();
  const { bundle, editor, canEdit } = useEditor();
  const [uploading, setUploading] = useState(0);
  const [hover, setHover] = useState(false);
  const [open, setOpen] = useState<Asset | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const role = node.data.role as 'product' | 'brand' | 'reference';
  const ids = (node.data.assetIds as string[]) ?? [];
  const assets = ids.map((id) => bundle.assets.find((a) => a.id === id)).filter((a): a is Asset => !!a);

  const upload = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    setUploading(list.length);
    const added: string[] = [];
    for (const f of list) {
      try {
        const a = await repo.uploadAsset(bundle.project.id, f, { role, filename: f.name, nodeId: node.id });
        added.push(a.id);
      } catch (e) {
        toast(errMsg(e), 'err');
      }
      setUploading((n) => n - 1);
    }
    if (added.length) {
      const current = (editor.getNode(node.id)?.data.assetIds as string[]) ?? [];
      update({ assetIds: [...current, ...added] });
      toast(`${added.length} image${added.length > 1 ? 's' : ''} uploaded`, 'ok');
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setHover(false);
    if (canEdit) void upload(e.dataTransfer.files);
  };

  return (
    <>
      <Section title="Images">
        <Field label="Title">
          <Input value={String(node.data.title ?? '')} disabled={!canEdit} onChange={(e) => update({ title: e.target.value }, 'title')} />
        </Field>
        <Field
          label="What are these?"
          hint={role === 'product' ? 'Real photos of the actual product. AI will preserve them and never edit the originals.' : role === 'brand' ? 'Logos, packaging, brand guidelines.' : 'Inspiration only: mood, light and composition.'}
        >
          <Select value={role} disabled={!canEdit} onChange={(e) => update({ role: e.target.value })}>
            <option value="product">Actual product photos</option>
            <option value="brand">Brand assets</option>
            <option value="reference">Inspiration / references</option>
          </Select>
        </Field>
        {canEdit && (
          <div
            onDragOver={(e) => (e.preventDefault(), setHover(true))}
            onDragLeave={() => setHover(false)}
            onDrop={onDrop}
            onClick={() => input.current?.click()}
            className={cn('flex cursor-pointer flex-col items-center gap-1.5 rounded-xl border border-dashed px-4 py-6 text-center transition', hover ? 'border-teal bg-teal-dim' : 'border-line-2 hover:border-teal/50')}
          >
            {uploading ? <Spinner /> : <ImagePlus className="size-5 text-teal" />}
            <div className="text-sm">{uploading ? `Uploading ${uploading}…` : 'Drop images or click to upload'}</div>
            <div className="text-[11px] text-mute">JPEG, PNG or WebP · up to {UPLOAD_LIMITS.maxBytes / 1024 / 1024} MB each</div>
            <input ref={input} type="file" accept={UPLOAD_LIMITS.mimeTypes.join(',')} multiple hidden onChange={(e) => e.target.files && void upload(e.target.files)} />
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          {assets.map((a) => (
            <AssetCard
              key={a.id}
              asset={a}
              bundle={bundle}
              showApproval={false}
              onClick={() => setOpen(a)}
              footer={
                canEdit && (
                  <button className="flex items-center gap-1 text-[10.5px] text-mute hover:text-err" onClick={() => update({ assetIds: ids.filter((x) => x !== a.id) })}>
                    <Trash2 className="size-3" /> Remove from node
                  </button>
                )
              }
            />
          ))}
        </div>
        {canEdit && <p className="text-[11px] leading-snug text-mute">Only upload images you have the rights to use. Uploaded files are sent to the AI provider when a connected node runs.</p>}
      </Section>
      <AssetLightbox asset={open} bundle={bundle} onClose={() => setOpen(null)} />
    </>
  );
}
