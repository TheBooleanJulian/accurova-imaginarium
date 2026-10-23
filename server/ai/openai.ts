import type {
  AIProvider,
  AnalyzeRequest,
  DirectionsRequest,
  GeneratedImage,
  ImageInput,
  ImageRequest,
  ProviderResult,
  ShotPlanRequest,
} from '../../src/core/ai';
import { ProviderError, throwIfAborted } from '../../src/core/ai';
import type { AspectRatio } from '../../src/core/schemas';
import type { UsageInfo } from '../../src/core/types';
import { forVision, probeImage, toPng } from '../images';

/**
 * OpenAI adapter. Runs only on the server; the key never reaches the browser.
 *  - Reasoning: Responses API with vision input and strict JSON-schema output.
 *  - Images: Images API. Concepts that have product/reference photos go through
 *    /images/edits with those photos as inputs so the real product conditions
 *    the result; pose variations and edits transform the chosen source image.
 * Every structured reply is validated again with Zod by the executor.
 */
export interface OpenAIOptions {
  apiKey: string;
  baseUrl?: string;
  textModel: string;
  imageModel: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Optional USD price per 1M tokens, for cost estimates on jobs. */
  prices?: { textIn?: number; textOut?: number; imageIn?: number; imageOut?: number };
}

const SYSTEM = `You work for Accurova, a premium corporate photography studio in Singapore.
You help plan real photoshoots. Be concrete, practical and specific to what a photographer can physically do.
Never invent facts about the client's product beyond what the brief states or the PRODUCT photos show.`;

// ------------------------------------------------------------------ strict JSON schemas (OpenAI structured outputs)

const s = (description?: string) => ({ type: 'string', ...(description ? { description } : {}) });
const arr = (items: object, description?: string) => ({ type: 'array', items, ...(description ? { description } : {}) });
const obj = (properties: Record<string, object>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

export const ANALYSIS_SCHEMA = obj({
  summary: s('Two or three sentences on what unites the references.'),
  composition: s(),
  lighting: s('Direction, quality (hard/soft), key-to-fill ratio and likely modifiers.'),
  colour: obj({ palette: arr(s('Hex colour like #1A2B3C'), '3 to 6 dominant colours as hex codes'), contrast: s(), notes: s() }),
  background: s(),
  textures: s(),
  pose: s(),
  styling: s(),
  mood: s(),
  perImage: arr(obj({ assetId: s('The asset id given for that image'), notes: s() })),
});

const DIRECTION = obj({
  title: s('Short evocative name'),
  rationale: s('Why this direction serves the brief and audience'),
  creativeDirection: s(),
  palette: arr(s('Hex colour'), '3 to 6 hex colours'),
  lighting: s('Practical lighting setup with placement'),
  proposedShots: arr(s()),
  poseSuggestions: arr(s()),
  backgroundAndProps: arr(s()),
  constraints: arr(s()),
  negativeInstructions: arr(s('Something to avoid')),
});
export const DIRECTIONS_SCHEMA = obj({ directions: arr(DIRECTION, 'Exactly three clearly distinct directions') });

const SHOT = obj({
  id: s('S01, S02, ...'),
  priority: { type: 'string', enum: ['must', 'should', 'nice'] },
  title: s(),
  poseDirection: s(),
  cameraAngle: s(),
  framing: s(),
  lens: s('Focal length and aperture'),
  cameraPosition: s(),
  lighting: s(),
  modifiers: arr(s()),
  background: s(),
  props: arr(s()),
  productPlacement: s(),
  equipment: arr(s()),
  setupMinutes: { type: 'integer' },
  deliverableFormat: s(),
  referenceAssetId: { type: ['string', 'null'] },
  approvalStatus: { type: 'string', enum: ['pending'] },
});
export const SHOTPLAN_SCHEMA = obj({
  summary: s(),
  shots: arr(SHOT),
  equipmentChecklist: arr(s()),
  lightingPlan: s(),
  totalSetupMinutes: { type: 'integer' },
  disclaimer: s(),
});

// ------------------------------------------------------------------ sizes

/** gpt-image-2 family takes any size (multiples of 16, ≤3:1); older models take three fixed sizes. */
export function imageSize(model: string, ratio: AspectRatio): string {
  const flexible = /^gpt-image-[2-9]/.test(model);
  if (flexible) {
    const sizes: Record<AspectRatio, string> = {
      '1:1': '1024x1024',
      '4:5': '1024x1280',
      '3:2': '1536x1024',
      '2:3': '1024x1536',
      '16:9': '1536x864',
      '9:16': '864x1536',
    };
    return sizes[ratio];
  }
  if (ratio === '1:1') return '1024x1024';
  return ['3:2', '16:9'].includes(ratio) ? '1536x1024' : '1024x1536';
}

const supportsInputFidelity = (model: string) => /^gpt-image-1/.test(model);

// ------------------------------------------------------------------ provider

interface ResponsesReply {
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output?: { type: string; content?: { type: string; text?: string; refusal?: string }[] }[];
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string } | null;
}

interface ImagesReply {
  data?: { b64_json?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class OpenAIProvider implements AIProvider {
  readonly id = 'openai';
  private readonly o: Required<Omit<OpenAIOptions, 'prices'>> & Pick<OpenAIOptions, 'prices'>;

  constructor(opts: OpenAIOptions) {
    this.o = {
      baseUrl: 'https://api.openai.com/v1',
      timeoutMs: 180_000,
      fetch: globalThis.fetch.bind(globalThis),
      ...opts,
    } as Required<Omit<OpenAIOptions, 'prices'>> & Pick<OpenAIOptions, 'prices'>;
  }

  modelFor(kind: 'text' | 'image'): string {
    return kind === 'image' ? this.o.imageModel : this.o.textModel;
  }

  private cost(kind: 'text' | 'image', inTok = 0, outTok = 0): number | undefined {
    const p = this.o.prices;
    const pin = kind === 'text' ? p?.textIn : p?.imageIn;
    const pout = kind === 'text' ? p?.textOut : p?.imageOut;
    if (pin == null || pout == null) return undefined;
    return Math.round(((inTok * pin + outTok * pout) / 1_000_000) * 10000) / 10000;
  }

  private async call(path: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), this.o.timeoutMs);
    let res: Response;
    try {
      res = await this.o.fetch(`${this.o.baseUrl}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${this.o.apiKey}`, ...(init.headers as Record<string, string>) },
        signal: ctrl.signal,
      });
    } catch (e) {
      throwIfAborted(signal);
      throw new ProviderError(`Could not reach OpenAI: ${(e as Error).message}`, { retryable: true, code: 'network' });
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
    const text = await res.text();
    const body: unknown = (() => {
      try {
        return text ? JSON.parse(text) : null;
      } catch {
        return null;
      }
    })();
    if (!res.ok) {
      const err = (body as { error?: { message?: string; code?: string; type?: string } } | null)?.error;
      const msg = err?.message ?? (text.slice(0, 300) || res.statusText);
      if (res.status === 401) throw new ProviderError('OpenAI rejected the API key. Check OPENAI_API_KEY.', { code: 'auth' });
      if (res.status === 429) {
        const quota = /quota|billing/i.test(msg);
        throw new ProviderError(quota ? `OpenAI quota exhausted: ${msg}` : 'OpenAI rate limit reached; retrying shortly.', { retryable: !quota, code: quota ? 'quota' : 'rate_limited' });
      }
      if (res.status >= 500) throw new ProviderError(`OpenAI server error (${res.status}).`, { retryable: true, code: 'upstream' });
      if (err?.code === 'moderation_blocked' || /safety|moderation/i.test(msg))
        throw new ProviderError(`OpenAI declined this request under its content policy: ${msg}`, { code: 'moderation_blocked' });
      throw new ProviderError(`OpenAI error (${res.status}): ${msg}`, { code: err?.code ?? 'bad_request' });
    }
    return body;
  }

  private async imagePart(img: ImageInput) {
    const v = await forVision(img.bytes);
    return { type: 'input_image', image_url: `data:${v.mimeType};base64,${Buffer.from(v.bytes).toString('base64')}`, detail: 'high' };
  }

  private async structured(name: string, schema: object, prompt: string, images: ImageInput[], signal: AbortSignal): Promise<ProviderResult<unknown>> {
    const content: object[] = [{ type: 'input_text', text: prompt }];
    for (const [i, img] of images.entries()) {
      throwIfAborted(signal);
      content.push({ type: 'input_text', text: `Image ${i + 1}: ${img.role.toUpperCase()} (asset id ${img.assetId})` });
      content.push(await this.imagePart(img));
    }
    const body = {
      model: this.o.textModel,
      input: [
        { role: 'system', content: [{ type: 'input_text', text: SYSTEM }] },
        { role: 'user', content },
      ],
      text: { format: { type: 'json_schema', name, schema, strict: true } },
      max_output_tokens: 8000,
    };
    const r = (await this.call('/responses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, signal)) as ResponsesReply;
    if (r.error?.message) throw new ProviderError(`OpenAI error: ${r.error.message}`, { retryable: true, code: 'upstream' });
    const parts = (r.output ?? []).filter((o) => o.type === 'message').flatMap((o) => o.content ?? []);
    const refusal = parts.find((p) => p.type === 'refusal');
    if (refusal) throw new ProviderError(`The model declined: ${refusal.refusal ?? 'no reason given'}`, { code: 'refusal' });
    if (r.status === 'incomplete') {
      throw new ProviderError(`The model stopped early (${r.incomplete_details?.reason ?? 'incomplete'}).`, { retryable: true, code: 'incomplete' });
    }
    const text = parts.filter((p) => p.type === 'output_text').map((p) => p.text ?? '').join('');
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new ProviderError('The model returned text that is not valid JSON.', { retryable: true, code: 'invalid_output' });
    }
    const usage: UsageInfo = {
      inputTokens: r.usage?.input_tokens,
      outputTokens: r.usage?.output_tokens,
      estCostUsd: this.cost('text', r.usage?.input_tokens, r.usage?.output_tokens),
    };
    return { value, usage, model: this.o.textModel };
  }

  analyzeReferences(req: AnalyzeRequest, signal: AbortSignal) {
    return this.structured('reference_analysis', ANALYSIS_SCHEMA, req.prompt, req.images, signal);
  }

  generateDirections(req: DirectionsRequest, signal: AbortSignal) {
    return this.structured('creative_directions', DIRECTIONS_SCHEMA, req.prompt, req.images, signal);
  }

  generateShotPlan(req: ShotPlanRequest, signal: AbortSignal) {
    return this.structured('shot_plan', SHOTPLAN_SCHEMA, req.prompt, req.images, signal);
  }

  async generateImages(req: ImageRequest, signal: AbortSignal): Promise<ProviderResult<GeneratedImage[]>> {
    const model = this.o.imageModel;
    const size = imageSize(model, req.aspectRatio);
    const inputs = req.source ? [req.source] : req.references;
    let reply: ImagesReply;
    if (!inputs.length) {
      reply = (await this.call(
        '/images/generations',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, prompt: req.prompt, n: req.n, size, quality: req.quality, output_format: 'png' }),
        },
        signal,
      )) as ImagesReply;
    } else {
      const form = new FormData();
      form.set('model', model);
      form.set('prompt', req.prompt);
      form.set('n', String(req.n));
      form.set('size', size);
      form.set('quality', req.quality);
      form.set('output_format', 'png');
      if (supportsInputFidelity(model)) form.set('input_fidelity', 'high');
      const field = inputs.length > 1 ? 'image[]' : 'image';
      for (const [i, img] of inputs.slice(0, 8).entries()) {
        throwIfAborted(signal);
        const png = await toPng(img.bytes, 2048);
        form.append(field, new Blob([png as BlobPart], { type: 'image/png' }), `${img.role}-${i + 1}.png`);
      }
      reply = (await this.call('/images/edits', { method: 'POST', body: form }, signal)) as ImagesReply;
    }
    const images: GeneratedImage[] = [];
    for (const d of reply.data ?? []) {
      if (!d.b64_json) continue;
      const bytes = new Uint8Array(Buffer.from(d.b64_json, 'base64'));
      const dims = await probeImage(bytes);
      images.push({ bytes, mimeType: dims.mimeType, width: dims.width, height: dims.height });
    }
    if (!images.length) throw new ProviderError('OpenAI returned no images.', { retryable: true, code: 'empty_output' });
    return {
      value: images,
      usage: {
        images: images.length,
        inputTokens: reply.usage?.input_tokens,
        outputTokens: reply.usage?.output_tokens,
        estCostUsd: this.cost('image', reply.usage?.input_tokens, reply.usage?.output_tokens),
      },
      model,
    };
  }
}
