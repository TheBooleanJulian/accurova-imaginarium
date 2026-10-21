import type { AssetRole, UsageInfo } from './types';
import type { AspectRatio, Brief, Direction, Quality, ReferenceAnalysis } from './schemas';

/** An image handed to a provider: real bytes, never a URL the provider could leak. */
export interface ImageInput {
  assetId: string;
  role: AssetRole;
  mimeType: string;
  bytes: Uint8Array;
}

export interface GeneratedImage {
  bytes: Uint8Array;
  mimeType: string;
  width: number;
  height: number;
}

export interface ProviderResult<T> {
  value: T;
  usage: UsageInfo;
  model: string;
}

export interface AnalyzeRequest {
  prompt: string;
  images: ImageInput[];
  brief: Brief | null;
  focus: string[];
}

export interface DirectionsRequest {
  prompt: string;
  brief: Brief;
  analysis: ReferenceAnalysis | null;
  images: ImageInput[];
  seed: string;
}

export interface ImageRequest {
  kind: 'concept' | 'pose' | 'edit';
  prompt: string;
  /** Edit/pose: the image being transformed. */
  source: ImageInput | null;
  /** Conditioning references (real product photos first). */
  references: ImageInput[];
  n: number;
  aspectRatio: AspectRatio;
  quality: Quality;
  seed: string;
  /** Structured hints; real providers ignore these, the mock uses them to draw. */
  hints: { palette?: string[]; title?: string; lighting?: string; variationLabels?: string[] };
}

export interface ShotPlanRequest {
  prompt: string;
  brief: Brief | null;
  direction: Direction | null;
  referenceAssetIds: string[];
  images: ImageInput[];
  shotCount: number;
  seed: string;
}

export interface AIProvider {
  readonly id: string;
  analyzeReferences(req: AnalyzeRequest, signal: AbortSignal): Promise<ProviderResult<unknown>>;
  generateDirections(req: DirectionsRequest, signal: AbortSignal): Promise<ProviderResult<unknown>>;
  generateImages(req: ImageRequest, signal: AbortSignal): Promise<ProviderResult<GeneratedImage[]>>;
  generateShotPlan(req: ShotPlanRequest, signal: AbortSignal): Promise<ProviderResult<unknown>>;
  /** Model name recorded on the job before it runs. */
  modelFor(kind: 'text' | 'image'): string;
}

export class ProviderError extends Error {
  readonly retryable: boolean;
  readonly code: string;
  constructor(message: string, opts: { retryable?: boolean; code?: string } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.retryable = opts.retryable ?? false;
    this.code = opts.code ?? 'provider_error';
  }
}

export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
  }
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new CancelledError();
}
