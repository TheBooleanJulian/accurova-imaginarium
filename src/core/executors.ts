import type { AssetRole, GraphNode, UsageInfo } from './types';
import type { AIProvider, ImageInput } from './ai';
import { throwIfAborted, ProviderError } from './ai';
import type { DirectionValue, ImageRef, InputSnapshot, TextValue } from './graph';
import {
  DirectionsOutputSchema,
  ReferenceAnalysisSchema,
  ShotPlanSchema,
  type AspectRatio,
  type Brief,
  type Direction,
  type DirectionsOutput,
  type Quality,
  type ReferenceAnalysis,
} from './schemas';
import { analysisPrompt, conceptImagePrompt, directionsPrompt, editPrompt, posePrompt, shotPlanPrompt } from './prompts';

export const AI_DISCLAIMER =
  'AI-generated concept for planning only. Not a photograph of the real product and not a guarantee of the final shoot.';

/** A generated image waiting to be persisted. The engine assigns its id. */
export interface PendingAsset {
  bytes: Uint8Array;
  mimeType: string;
  width: number;
  height: number;
  role: AssetRole;
  parentAssetId: string | null;
  versionOf: string | null;
  version: number;
  label: string;
  prompt: string;
}

export interface ExecResult {
  output: unknown;
  assets: PendingAsset[];
  usage: UsageInfo;
  model: string;
}

export interface ExecContext {
  node: GraphNode;
  op: string;
  snapshot: InputSnapshot;
  provider: AIProvider;
  loadImage: (ref: ImageRef) => Promise<ImageInput>;
  /** Next version number for a revision chain (edits). */
  nextVersion: (lineage: string) => number;
  seed: string;
  signal: AbortSignal;
}

function parseOrFail<T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { message: string } } }, value: unknown, what: string): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new ProviderError(`The model returned an invalid ${what}: ${r.error.message.slice(0, 300)}`, { retryable: true, code: 'invalid_output' });
  return r.data;
}

function mergeUsage(a: UsageInfo, b: UsageInfo): UsageInfo {
  const add = (x?: number, y?: number) => (x == null && y == null ? undefined : (x ?? 0) + (y ?? 0));
  return {
    inputTokens: add(a.inputTokens, b.inputTokens),
    outputTokens: add(a.outputTokens, b.outputTokens),
    images: add(a.images, b.images),
    estCostUsd: add(a.estCostUsd, b.estCostUsd),
  };
}

async function loadAll(ctx: ExecContext, refs: ImageRef[], limit: number): Promise<ImageInput[]> {
  const order: Record<string, number> = { product: 0, brand: 1, reference: 2, concept: 3, pose: 3, edit: 3, export: 9 };
  const sorted = [...refs].sort((a, b) => (order[a.role] ?? 5) - (order[b.role] ?? 5)).slice(0, limit);
  const out: ImageInput[] = [];
  for (const r of sorted) {
    throwIfAborted(ctx.signal);
    out.push(await ctx.loadImage(r));
  }
  return out;
}

function pickSource(images: ImageRef[] | undefined, sourceAssetId: unknown): ImageRef {
  if (!images?.length) throw new ProviderError('No source image connected.', { code: 'missing_input' });
  return images.find((i) => i.assetId === sourceAssetId) ?? images.find((i) => i.sourceType === 'ai_generated') ?? images[0]!;
}

const POSE_BANK: Record<string, string[]> = {
  'hand positions': ['hands relaxed at sides', 'one hand in pocket', 'hands lightly clasped', 'hand resting on product', 'arms folded loosely', 'hand gesturing mid-conversation'],
  'head angle': ['head tilted slightly left', 'chin lifted', 'three-quarter turn', 'looking down at product', 'head straight to camera', 'over-the-shoulder glance'],
  'body orientation': ['square to camera', 'angled 30° away', 'side profile', 'leaning on set piece', 'walking toward camera', 'seated, forward lean'],
  expression: ['quiet confidence', 'warm smile', 'focused, thoughtful', 'candid laugh', 'neutral editorial', 'approachable half-smile'],
  'gaze direction': ['eyes to lens', 'gaze off-frame left', 'gaze off-frame right', 'eyes on product', 'looking into distance', 'eyes closed, serene'],
  'framing / crop': ['three-quarter length', 'waist-up', 'tight portrait', 'full length', 'detail crop on hands + product', 'wide environmental'],
  'camera height': ['eye level', 'slightly low angle', 'slightly high angle', 'chest height', 'low hero angle', 'overhead'],
};

export function poseVariationLabels(change: string[], n: number, seed: string): string[] {
  const offset = [...seed].reduce((s, c) => s + c.charCodeAt(0), 0);
  return Array.from({ length: n }, (_, i) =>
    change.map((c) => {
      const bank = POSE_BANK[c] ?? ['variation'];
      return bank[(i + offset) % bank.length];
    }).join(' · '),
  );
}

export async function executeAiOperation(ctx: ExecContext): Promise<ExecResult> {
  const { node, op, snapshot, provider, signal, seed } = ctx;
  const d = node.data;
  const inputs = snapshot.inputs;
  const brief = (inputs.brief as Brief | undefined) ?? null;
  throwIfAborted(signal);

  switch (`${node.type}:${op}`) {
    case 'reference_analysis:analyze': {
      const refs = (inputs.images as ImageRef[]) ?? [];
      const images = await loadAll(ctx, refs, 6);
      const focus = (d.focus as string[]) ?? [];
      const res = await provider.analyzeReferences(
        { prompt: analysisPrompt(brief, focus, String(d.notes ?? ''), images.map((i) => `${i.role} ${i.assetId}`)), images, brief, focus },
        signal,
      );
      const parsed = parseOrFail<ReferenceAnalysis>(ReferenceAnalysisSchema, res.value, 'reference analysis');
      const known = new Set(refs.map((r) => r.assetId));
      parsed.perImage = parsed.perImage.filter((p) => known.has(p.assetId));
      return { output: parsed, assets: [], usage: res.usage, model: res.model };
    }

    case 'concept_generator:directions': {
      if (!brief) throw new ProviderError('Connect a brief first.', { code: 'missing_input' });
      const images = await loadAll(ctx, (inputs.images as ImageRef[]) ?? [], 4);
      const analysis = (inputs.analysis as ReferenceAnalysis | undefined) ?? null;
      const notes = (inputs.text as TextValue[] | undefined) ?? [];
      const res = await provider.generateDirections(
        { prompt: directionsPrompt(brief, analysis, notes, String(d.guidance ?? '')), brief, analysis, images, seed },
        signal,
      );
      const parsed = parseOrFail<DirectionsOutput>(DirectionsOutputSchema, res.value, 'set of creative directions');
      return { output: parsed, assets: [], usage: res.usage, model: res.model };
    }

    case 'concept_generator:render': {
      const direction = inputs.__direction as DirectionValue | undefined;
      if (!direction) throw new ProviderError('Pick a creative direction first.', { code: 'missing_input' });
      const references = await loadAll(ctx, (inputs.images as ImageRef[]) ?? [], 4);
      const prompt = conceptImagePrompt(brief, direction, String(d.promptOverride ?? ''));
      const n = Number(d.variations ?? 2);
      const res = await provider.generateImages(
        {
          kind: 'concept',
          prompt,
          source: null,
          references,
          n,
          aspectRatio: d.aspectRatio as AspectRatio,
          quality: d.quality as Quality,
          seed,
          hints: { palette: direction.palette, title: direction.title, lighting: direction.lighting },
        },
        signal,
      );
      return {
        output: { prompt, direction: direction.title, disclaimer: AI_DISCLAIMER },
        assets: res.value.map((img, i) => ({
          ...img,
          role: 'concept',
          parentAssetId: null,
          versionOf: null,
          version: 1,
          label: `${direction.title} · concept ${i + 1}`,
          prompt,
        })),
        usage: res.usage,
        model: res.model,
      };
    }

    case 'pose_generator:poses': {
      const src = pickSource(inputs.images as ImageRef[], d.sourceAssetId);
      const source = await ctx.loadImage(src);
      const direction = (inputs.direction as Direction | undefined) ?? null;
      const n = Number(d.variations ?? 4);
      const labels = poseVariationLabels((d.change as string[]) ?? [], n, seed);
      // One call per variation so each gets its own explicit instruction.
      const assets: PendingAsset[] = [];
      let usage: UsageInfo = {};
      let model = provider.modelFor('image');
      for (const label of labels) {
        throwIfAborted(signal);
        const prompt = posePrompt((d.change as string[]) ?? [], (d.keep as string[]) ?? [], String(d.notes ?? ''), direction, label);
        const res = await provider.generateImages(
          {
            kind: 'pose',
            prompt,
            source,
            references: [],
            n: 1,
            aspectRatio: d.aspectRatio as AspectRatio,
            quality: d.quality as Quality,
            seed: `${seed}:${label}`,
            hints: { palette: direction?.palette, title: label, variationLabels: [label] },
          },
          signal,
        );
        usage = mergeUsage(usage, res.usage);
        model = res.model;
        for (const img of res.value)
          assets.push({ ...img, role: 'pose', parentAssetId: src.assetId, versionOf: null, version: 1, label: `Pose · ${label}`, prompt });
      }
      return { output: { sourceAssetId: src.assetId, labels, disclaimer: 'Pose reference only — not a final photograph.' }, assets, usage, model };
    }

    case 'image_edit:edit': {
      const src = pickSource(inputs.images as ImageRef[], d.sourceAssetId);
      if (src.sourceType === 'upload' && src.role === 'product')
        throw new ProviderError('Original product photographs are never edited. Edit an AI concept instead.', { code: 'protected_original' });
      const source = await ctx.loadImage(src);
      const prompt = editPrompt(String(d.instruction ?? ''), (d.preserve as string[]) ?? []);
      const res = await provider.generateImages(
        {
          kind: 'edit',
          prompt,
          source,
          references: [],
          n: Number(d.variations ?? 1),
          aspectRatio: d.aspectRatio as AspectRatio,
          quality: d.quality as Quality,
          seed,
          hints: { title: String(d.instruction ?? '').slice(0, 40) },
        },
        signal,
      );
      const base = ctx.nextVersion(src.lineage);
      return {
        output: { sourceAssetId: src.assetId, instruction: d.instruction, disclaimer: AI_DISCLAIMER },
        assets: res.value.map((img, i) => ({
          ...img,
          role: 'edit',
          parentAssetId: src.assetId,
          versionOf: src.lineage,
          version: base + i,
          label: `Edit v${base + i} · ${String(d.instruction ?? '').slice(0, 48)}`,
          prompt,
        })),
        usage: res.usage,
        model: res.model,
      };
    }

    case 'shot_planner:plan': {
      const refs = (inputs.images as ImageRef[] | undefined) ?? [];
      const direction = (inputs.direction as Direction | undefined) ?? null;
      const images = await loadAll(ctx, refs, 4);
      const shotCount = Number(d.shotCount ?? 6);
      const refIds = refs.map((r) => r.assetId);
      const res = await provider.generateShotPlan(
        {
          prompt: shotPlanPrompt(brief, direction, shotCount, String(d.gearNotes ?? ''), String(d.notes ?? ''), refIds),
          brief,
          direction,
          referenceAssetIds: refIds,
          images,
          shotCount,
          seed,
        },
        signal,
      );
      const plan = parseOrFail(ShotPlanSchema, res.value, 'shot plan');
      const known = new Set(refIds);
      plan.shots = plan.shots.map((s) => ({
        ...s,
        referenceAssetId: s.referenceAssetId && known.has(s.referenceAssetId) ? s.referenceAssetId : null,
        approvalStatus: 'pending' as const,
      }));
      plan.totalSetupMinutes = plan.shots.reduce((t, s) => t + s.setupMinutes, 0);
      return { output: plan, assets: [], usage: res.usage, model: res.model };
    }

    default:
      throw new ProviderError(`No AI executor for ${node.type}:${op}`, { code: 'no_executor' });
  }
}
