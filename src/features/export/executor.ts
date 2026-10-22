import type { Approval, Asset, Project } from '@/core/types';
import type { InternalExecutor } from '@/core/jobEngine';
import { ProviderError, throwIfAborted } from '@/core/ai';
import { toImageRef, type ApprovedBundle, type ImageRef } from '@/core/graph';
import { BriefSchema, type Brief, type ShotPlan } from '@/core/schemas';
import { buildPreshootPack, type RasterImage } from './pdf';

export type Rasterizer = (asset: Asset, bytes: Uint8Array) => Promise<RasterImage | null>;

export interface ExportMeta {
  project: Project;
  /** userId → display name, for the approval record. */
  names: Record<string, string>;
}

export interface ExportExecutorDeps {
  rasterize: Rasterizer;
  loadMeta: (projectId: string) => Promise<ExportMeta>;
}

export const FINAL_NEEDS_APPROVAL =
  'A final pack needs at least one client-approved image. Export a draft instead, or get approvals first.';

/**
 * The `export:export` operation. Runs through the job engine like any other
 * operation, so the PDF is stored durably before the job is marked successful
 * and every export is a versioned run with an input snapshot.
 */
export function createExportExecutor(deps: ExportExecutorDeps): InternalExecutor {
  return async ({ node, snapshot, graph, job, loadImage, signal }) => {
    const d = node.data;
    const mode = d.mode === 'final' ? 'final' : 'draft';
    const inputs = snapshot.inputs;
    const approved = (inputs.approved as ApprovedBundle | undefined) ?? null;
    if (mode === 'final' && !approved?.assetIds.length) {
      throw new ProviderError(FINAL_NEEDS_APPROVAL, { code: 'nothing_approved' });
    }
    const briefIn = inputs.brief as Brief | undefined;
    const brief = briefIn ? BriefSchema.parse(briefIn) : null;
    const meta = await deps.loadMeta(job.projectId);
    const approvals: Approval[] = graph.approvals.map((a) => ({ ...a, reviewerName: a.reviewerName ?? meta.names[a.reviewerId] ?? 'Reviewer' }));

    const pack = await buildPreshootPack({
      project: meta.project,
      title: String(d.title || 'Preshoot pack'),
      mode,
      brief,
      approved,
      draftImageIds: ((inputs.images as ImageRef[] | undefined) ?? []).map((r) => r.assetId),
      shotplan: (inputs.shotplan as ShotPlan | undefined) ?? null,
      includeReferences: d.includeReferences !== false,
      assets: graph.assets,
      approvals,
      generatedBy: meta.names[job.requestedBy] ?? 'Accurova',
      rasterize: async (asset) => {
        throwIfAborted(signal);
        const img = await loadImage(toImageRef(asset));
        return deps.rasterize(asset, img.bytes);
      },
    });
    throwIfAborted(signal);
    return {
      output: { mode, filename: pack.filename, pageCount: pack.pageCount, imageCount: pack.imageCount },
      assets: [
        {
          bytes: pack.bytes,
          mimeType: 'application/pdf',
          width: 0,
          height: 0,
          role: 'export',
          sourceType: 'export',
          parentAssetId: null,
          versionOf: null,
          version: 1,
          label: pack.filename,
          prompt: '',
          filename: pack.filename,
        },
      ],
      usage: {},
      model: 'jspdf',
    };
  };
}

function toBase64(bytes: Uint8Array): string {
  const B = (globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } }).Buffer;
  if (B) return B.from(bytes).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * Dependency-free rasteriser: passes JPEG/PNG straight through and skips
 * anything else. Used in tests and as a fallback; the browser and server
 * provide better ones (canvas / sharp) that also handle WebP and SVG.
 */
export const passthroughRasterizer: Rasterizer = async (asset, bytes) => {
  const format = asset.mimeType === 'image/jpeg' ? 'JPEG' : asset.mimeType === 'image/png' ? 'PNG' : null;
  if (!format || !asset.width || !asset.height) return null;
  return { dataUrl: `data:${asset.mimeType};base64,${toBase64(bytes)}`, width: asset.width, height: asset.height, format };
};
