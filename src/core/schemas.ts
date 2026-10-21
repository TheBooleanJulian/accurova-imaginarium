import { z } from 'zod';

/**
 * Structured AI outputs. Every provider response is parsed through these
 * before it is stored, so a malformed model reply fails the job loudly
 * instead of leaking into the graph.
 */

export const BriefSchema = z.object({
  client: z.string().default(''),
  product: z.string().default(''),
  audience: z.string().default(''),
  objective: z.string().default(''),
  visualStyle: z.string().default(''),
  deliverables: z.string().default(''),
  constraints: z.string().default(''),
});
export type Brief = z.infer<typeof BriefSchema>;

export const ReferenceAnalysisSchema = z.object({
  summary: z.string(),
  composition: z.string(),
  lighting: z.string(),
  colour: z.object({
    palette: z.array(z.string()).min(1).max(8),
    contrast: z.string(),
    notes: z.string(),
  }),
  background: z.string(),
  textures: z.string(),
  pose: z.string(),
  styling: z.string(),
  mood: z.string(),
  perImage: z
    .array(z.object({ assetId: z.string(), notes: z.string() }))
    .default([]),
});
export type ReferenceAnalysis = z.infer<typeof ReferenceAnalysisSchema>;

export const DirectionSchema = z.object({
  title: z.string().min(1),
  rationale: z.string(),
  creativeDirection: z.string(),
  palette: z.array(z.string()).min(2).max(8),
  lighting: z.string(),
  proposedShots: z.array(z.string()).min(1),
  poseSuggestions: z.array(z.string()).min(1),
  backgroundAndProps: z.array(z.string()).min(1),
  constraints: z.array(z.string()).default([]),
  negativeInstructions: z.array(z.string()).default([]),
});
export type Direction = z.infer<typeof DirectionSchema>;

export const DirectionsOutputSchema = z.object({
  directions: z.array(DirectionSchema).length(3),
});
export type DirectionsOutput = z.infer<typeof DirectionsOutputSchema>;

export const ShotSchema = z.object({
  id: z.string(),
  priority: z.enum(['must', 'should', 'nice']),
  title: z.string(),
  poseDirection: z.string(),
  cameraAngle: z.string(),
  framing: z.string(),
  lens: z.string(),
  cameraPosition: z.string(),
  lighting: z.string(),
  modifiers: z.array(z.string()).default([]),
  background: z.string(),
  props: z.array(z.string()).default([]),
  productPlacement: z.string(),
  equipment: z.array(z.string()).default([]),
  setupMinutes: z.number().int().min(0).max(600),
  deliverableFormat: z.string(),
  referenceAssetId: z.string().nullable().default(null),
  approvalStatus: z.enum(['pending', 'approved', 'changes_requested']).default('pending'),
});
export type Shot = z.infer<typeof ShotSchema>;

export const ShotPlanSchema = z.object({
  summary: z.string(),
  shots: z.array(ShotSchema).min(1),
  equipmentChecklist: z.array(z.string()),
  lightingPlan: z.string(),
  totalSetupMinutes: z.number().int().min(0),
  disclaimer: z.string(),
});
export type ShotPlan = z.infer<typeof ShotPlanSchema>;

export const ASPECT_RATIOS = ['1:1', '4:5', '3:2', '2:3', '16:9', '9:16'] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];
export const QUALITIES = ['low', 'medium', 'high'] as const;
export type Quality = (typeof QUALITIES)[number];

export function aspectToSize(ratio: AspectRatio, longEdge = 1024): { width: number; height: number } {
  const [w, h] = ratio.split(':').map(Number) as [number, number];
  if (w >= h) return { width: longEdge, height: Math.round((longEdge * h) / w) };
  return { width: Math.round((longEdge * w) / h), height: longEdge };
}

export const POSE_CHANGE_OPTIONS = [
  'hand positions',
  'head angle',
  'body orientation',
  'expression',
  'gaze direction',
  'framing / crop',
  'camera height',
] as const;

export const KEEP_OPTIONS = [
  'product design',
  'styling / wardrobe',
  'lighting',
  'background',
  'colour palette',
  'composition',
] as const;

export const UPLOAD_LIMITS = {
  maxBytes: 20 * 1024 * 1024,
  mimeTypes: ['image/jpeg', 'image/png', 'image/webp'] as string[],
};
