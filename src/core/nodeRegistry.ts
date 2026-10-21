import { z } from 'zod';
import type { NodeType } from './types';
import { ASPECT_RATIOS, BriefSchema, KEEP_OPTIONS, POSE_CHANGE_OPTIONS, QUALITIES, ShotPlanSchema } from './schemas';

/** Data types that can flow along an edge. */
export type PortType = 'brief' | 'images' | 'analysis' | 'text' | 'direction' | 'shotplan' | 'approved';

export interface PortDef {
  id: string;
  label: string;
  type: PortType;
  /** Input ports only: accept more than one incoming edge. */
  multiple?: boolean;
  /** Input ports only: an operation cannot run without it. */
  required?: boolean;
}

export interface OperationDef {
  id: string;
  label: string;
  /** `ai` ops call a provider and cost money; `internal` ops do not. */
  kind: 'ai' | 'internal';
  /**
   * Config keys that affect this operation's result. Only these (plus resolved
   * inputs) feed the input hash, so selecting an output or editing a shot plan
   * does not mark the node itself stale.
   */
  hashKeys: string[];
  /** Bump when the prompt template changes; it is part of the hash. */
  promptVersion: string;
  /** Input ports (beyond `required` ones) this specific op needs. */
  needs?: string[];
  /** Op-specific precondition on config, returns a human message when not ready. */
  check?: (data: Record<string, unknown>) => string | null;
}

export interface NodeDef<S extends z.ZodTypeAny = z.ZodTypeAny> {
  type: NodeType;
  schemaVersion: number;
  label: string;
  description: string;
  category: 'Inputs' | 'AI' | 'Review & output';
  accent: string;
  inputs: PortDef[];
  outputs: PortDef[];
  configSchema: S;
  operations: OperationDef[];
  resizable?: boolean;
  /** Short tokens used by the node-library search. */
  keywords: string[];
}

const selectedAssets = z.array(z.string()).default([]);
const pinned = z.record(z.string(), z.string()).default({});

const imageGenConfig = {
  variations: z.number().int().min(1).max(4).default(2),
  aspectRatio: z.enum(ASPECT_RATIOS).default('4:5'),
  quality: z.enum(QUALITIES).default('medium'),
};

export const NODE_DEFS: Record<NodeType, NodeDef> = {
  brief: {
    type: 'brief',
    schemaVersion: 1,
    label: 'Brief',
    description: 'Campaign requirements: client, product, audience, objective, style, deliverables, constraints.',
    category: 'Inputs',
    accent: '#F5C842',
    inputs: [],
    outputs: [{ id: 'brief', label: 'Brief', type: 'brief' }],
    configSchema: BriefSchema,
    operations: [],
    keywords: ['brief', 'client', 'requirements', 'campaign'],
  },
  image_asset: {
    type: 'image_asset',
    schemaVersion: 1,
    label: 'Image assets',
    description: 'Real product photos, brand assets or inspiration references. Originals are preserved.',
    category: 'Inputs',
    accent: '#F5C842',
    inputs: [],
    outputs: [{ id: 'images', label: 'Images', type: 'images' }],
    configSchema: z.object({
      title: z.string().default(''),
      role: z.enum(['product', 'brand', 'reference']).default('reference'),
      assetIds: z.array(z.string()).default([]),
    }),
    operations: [],
    resizable: true,
    keywords: ['upload', 'photo', 'product', 'reference', 'inspiration', 'brand', 'image'],
  },
  reference_analysis: {
    type: 'reference_analysis',
    schemaVersion: 1,
    label: 'Reference analysis',
    description: 'Reads composition, lighting, colour, background, pose and styling from references.',
    category: 'AI',
    accent: '#00D4C8',
    inputs: [
      { id: 'images', label: 'References', type: 'images', multiple: true, required: true },
      { id: 'brief', label: 'Brief', type: 'brief' },
    ],
    outputs: [{ id: 'analysis', label: 'Analysis', type: 'analysis' }],
    configSchema: z.object({
      focus: z
        .array(z.enum(['composition', 'lighting', 'colour', 'background', 'pose', 'styling']))
        .default(['composition', 'lighting', 'colour', 'background', 'pose', 'styling']),
      notes: z.string().default(''),
      pinned,
    }),
    operations: [{ id: 'analyze', label: 'Analyse references', kind: 'ai', hashKeys: ['focus', 'notes'], promptVersion: 'analysis.v1' }],
    keywords: ['analyse', 'analyze', 'vision', 'lighting', 'composition', 'colour'],
  },
  text: {
    type: 'text',
    schemaVersion: 1,
    label: 'Text / direction',
    description: 'Editable creative direction, art-direction notes or instructions.',
    category: 'Inputs',
    accent: '#9AA4B2',
    inputs: [],
    outputs: [{ id: 'text', label: 'Text', type: 'text' }],
    configSchema: z.object({ title: z.string().default('Creative notes'), text: z.string().default('') }),
    operations: [],
    resizable: true,
    keywords: ['text', 'note', 'instruction', 'direction', 'prompt'],
  },
  concept_generator: {
    type: 'concept_generator',
    schemaVersion: 1,
    label: 'Concept generator',
    description: 'Three structured creative directions, then concept images for the chosen one.',
    category: 'AI',
    accent: '#00D4C8',
    inputs: [
      { id: 'brief', label: 'Brief', type: 'brief', required: true },
      { id: 'analysis', label: 'Analysis', type: 'analysis' },
      { id: 'images', label: 'Product & refs', type: 'images', multiple: true },
      { id: 'text', label: 'Notes', type: 'text', multiple: true },
    ],
    outputs: [
      { id: 'direction', label: 'Direction', type: 'direction' },
      { id: 'images', label: 'Concepts', type: 'images' },
    ],
    configSchema: z.object({
      guidance: z.string().default(''),
      selectedDirection: z.number().int().min(0).max(2).nullable().default(null),
      promptOverride: z.string().default(''),
      ...imageGenConfig,
      selectedAssetIds: selectedAssets,
      pinned,
    }),
    operations: [
      { id: 'directions', label: 'Generate 3 directions', kind: 'ai', hashKeys: ['guidance'], promptVersion: 'directions.v1' },
      {
        id: 'render',
        label: 'Render concept images',
        kind: 'ai',
        hashKeys: ['selectedDirection', 'promptOverride', 'variations', 'aspectRatio', 'quality'],
        promptVersion: 'render.v1',
        check: (d) => (d.selectedDirection == null ? 'Pick a creative direction first.' : null),
      },
    ],
    keywords: ['concept', 'creative', 'direction', 'generate', 'moodboard', 'campaign'],
  },
  pose_generator: {
    type: 'pose_generator',
    schemaVersion: 1,
    label: 'Pose variations',
    description: 'Varies pose and gesture while holding product, styling, lighting and background steady.',
    category: 'AI',
    accent: '#00D4C8',
    inputs: [
      { id: 'images', label: 'Source concept', type: 'images', multiple: true, required: true },
      { id: 'direction', label: 'Direction', type: 'direction' },
    ],
    outputs: [{ id: 'images', label: 'Poses', type: 'images' }],
    configSchema: z.object({
      sourceAssetId: z.string().nullable().default(null),
      change: z.array(z.enum(POSE_CHANGE_OPTIONS)).default(['hand positions', 'head angle']),
      keep: z.array(z.enum(KEEP_OPTIONS)).default(['product design', 'styling / wardrobe', 'lighting', 'background']),
      notes: z.string().default(''),
      ...imageGenConfig,
      variations: z.number().int().min(1).max(6).default(4),
      selectedAssetIds: selectedAssets,
      pinned,
    }),
    operations: [
      {
        id: 'poses',
        label: 'Generate pose variations',
        kind: 'ai',
        hashKeys: ['sourceAssetId', 'change', 'keep', 'notes', 'variations', 'aspectRatio', 'quality'],
        promptVersion: 'poses.v1',
        check: (d) => ((d.change as string[] | undefined)?.length ? null : 'Choose at least one thing that may change.'),
      },
    ],
    keywords: ['pose', 'gesture', 'model', 'variation', 'hands'],
  },
  image_edit: {
    type: 'image_edit',
    schemaVersion: 1,
    label: 'Image edit',
    description: 'Edits a concept while preserving the attributes you lock. Creates a new version.',
    category: 'AI',
    accent: '#00D4C8',
    inputs: [{ id: 'images', label: 'Source', type: 'images', multiple: true, required: true }],
    outputs: [{ id: 'images', label: 'Edited', type: 'images' }],
    configSchema: z.object({
      sourceAssetId: z.string().nullable().default(null),
      instruction: z.string().default(''),
      preserve: z.array(z.enum(KEEP_OPTIONS)).default(['product design', 'composition']),
      ...imageGenConfig,
      variations: z.number().int().min(1).max(4).default(1),
      selectedAssetIds: selectedAssets,
      pinned,
    }),
    operations: [
      {
        id: 'edit',
        label: 'Apply edit',
        kind: 'ai',
        hashKeys: ['sourceAssetId', 'instruction', 'preserve', 'variations', 'aspectRatio', 'quality'],
        promptVersion: 'edit.v1',
        check: (d) => (String(d.instruction ?? '').trim() ? null : 'Describe the edit first.'),
      },
    ],
    keywords: ['edit', 'retouch', 'change', 'inpaint', 'revise'],
  },
  shot_planner: {
    type: 'shot_planner',
    schemaVersion: 1,
    label: 'Shot planner',
    description: 'Turns concepts into a practical shot list, lighting plan and equipment checklist.',
    category: 'AI',
    accent: '#00D4C8',
    inputs: [
      { id: 'direction', label: 'Direction', type: 'direction' },
      { id: 'images', label: 'Approved refs', type: 'images', multiple: true },
      { id: 'brief', label: 'Brief', type: 'brief' },
      { id: 'analysis', label: 'Analysis', type: 'analysis' },
    ],
    outputs: [{ id: 'shotplan', label: 'Shot plan', type: 'shotplan' }],
    configSchema: z.object({
      shotCount: z.number().int().min(1).max(20).default(6),
      gearNotes: z.string().default(''),
      notes: z.string().default(''),
      /** Photographer's edits. Excluded from the hash: editing never marks the planner stale. */
      editedPlan: ShotPlanSchema.nullable().default(null),
      pinned,
    }),
    operations: [
      {
        id: 'plan',
        label: 'Generate shot plan',
        kind: 'ai',
        hashKeys: ['shotCount', 'gearNotes', 'notes'],
        promptVersion: 'shotplan.v1',
        check: () => null,
      },
    ],
    resizable: true,
    keywords: ['shot', 'list', 'lighting', 'plan', 'lens', 'equipment', 'production'],
  },
  approval: {
    type: 'approval',
    schemaVersion: 1,
    label: 'Client approval',
    description: 'Gate for client review. Only approved versions flow out.',
    category: 'Review & output',
    accent: '#7CE38B',
    inputs: [
      { id: 'images', label: 'For review', type: 'images', multiple: true, required: true },
      { id: 'direction', label: 'Direction', type: 'direction' },
      { id: 'shotplan', label: 'Shot plan', type: 'shotplan' },
    ],
    outputs: [{ id: 'approved', label: 'Approved', type: 'approved' }],
    configSchema: z.object({
      title: z.string().default('Moodboard review'),
      message: z.string().default('Please review these concepts and approve the ones you would like us to shoot.'),
    }),
    operations: [],
    keywords: ['approval', 'client', 'review', 'sign off'],
  },
  export: {
    type: 'export',
    schemaVersion: 1,
    label: 'Export pack',
    description: 'Accurova-branded PDF moodboard and production pack.',
    category: 'Review & output',
    accent: '#7CE38B',
    inputs: [
      { id: 'approved', label: 'Approved', type: 'approved' },
      { id: 'images', label: 'Images (draft)', type: 'images', multiple: true },
      { id: 'shotplan', label: 'Shot plan', type: 'shotplan' },
      { id: 'brief', label: 'Brief', type: 'brief' },
    ],
    outputs: [],
    configSchema: z.object({
      title: z.string().default('Preshoot pack'),
      mode: z.enum(['draft', 'final']).default('draft'),
      includeReferences: z.boolean().default(true),
    }),
    operations: [
      {
        id: 'export',
        label: 'Export PDF',
        kind: 'internal',
        hashKeys: ['title', 'mode', 'includeReferences'],
        promptVersion: 'export.v1',
        check: () => null,
      },
    ],
    keywords: ['export', 'pdf', 'pack', 'deliverable', 'download'],
  },
};

export function getNodeDef(type: NodeType): NodeDef {
  const def = NODE_DEFS[type];
  if (!def) throw new Error(`Unknown node type: ${type}`);
  return def;
}

/**
 * Schema migrations, keyed by node type then the version being migrated *from*.
 * Empty today (every type is at v1); kept so stored graphs can be upgraded safely.
 */
const MIGRATIONS: Partial<Record<NodeType, Record<number, (d: Record<string, unknown>) => Record<string, unknown>>>> = {};

/** Validate + default-fill node data, upgrading older schema versions first. */
export function normalizeNodeData(
  type: NodeType,
  data: unknown,
  fromVersion?: number,
): { data: Record<string, unknown>; schemaVersion: number } {
  const def = getNodeDef(type);
  let d = (data && typeof data === 'object' ? { ...(data as Record<string, unknown>) } : {}) as Record<string, unknown>;
  let v = fromVersion ?? def.schemaVersion;
  if (v > def.schemaVersion) throw new Error(`${type} data is schema v${v}, newer than this app (v${def.schemaVersion}).`);
  while (v < def.schemaVersion) {
    const step = MIGRATIONS[type]?.[v];
    if (!step) throw new Error(`No migration for ${type} v${v}→v${v + 1}`);
    d = step(d);
    v += 1;
  }
  return { data: def.configSchema.parse(d) as Record<string, unknown>, schemaVersion: def.schemaVersion };
}

export function defaultNodeData(type: NodeType): Record<string, unknown> {
  return normalizeNodeData(type, {}).data;
}

export function findPort(type: NodeType, dir: 'in' | 'out', portId: string): PortDef | undefined {
  const def = getNodeDef(type);
  return (dir === 'in' ? def.inputs : def.outputs).find((p) => p.id === portId);
}

export function getOperation(type: NodeType, opId: string): OperationDef {
  const op = getNodeDef(type).operations.find((o) => o.id === opId);
  if (!op) throw new Error(`${type} has no operation "${opId}"`);
  return op;
}
