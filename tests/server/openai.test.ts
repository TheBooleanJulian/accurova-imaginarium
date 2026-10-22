import { describe, expect, it } from 'vitest';
import { OpenAIProvider, imageSize, DIRECTIONS_SCHEMA, SHOTPLAN_SCHEMA, ANALYSIS_SCHEMA } from '../../server/ai/openai';
import { ProviderError } from '@/core/ai';
import { BriefSchema } from '@/core/schemas';
import { testImage } from './helpers';

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: (Response | (() => Response))[]) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (!r) throw new Error('unexpected call');
    return typeof r === 'function' ? r() : r;
  }) as unknown as typeof fetch;
  return { f, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const reply = (obj: unknown, extra: Record<string, unknown> = {}) =>
  json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(obj) }] }], usage: { input_tokens: 1000, output_tokens: 500 }, ...extra });
const signal = new AbortController().signal;
const brief = BriefSchema.parse({ client: 'Acme', product: 'Watch' });

function walk(schema: Record<string, unknown>, path = '$'): string[] {
  const problems: string[] = [];
  if (schema.type === 'object') {
    const props = schema.properties as Record<string, Record<string, unknown>>;
    if (schema.additionalProperties !== false) problems.push(`${path}: additionalProperties must be false`);
    const req = (schema.required as string[]) ?? [];
    for (const k of Object.keys(props)) {
      if (!req.includes(k)) problems.push(`${path}.${k}: not required`);
      problems.push(...walk(props[k]!, `${path}.${k}`));
    }
  }
  if (schema.type === 'array') problems.push(...walk(schema.items as Record<string, unknown>, `${path}[]`));
  return problems;
}

describe('OpenAI provider (mocked HTTP)', () => {
  it('uses strict-mode-compatible JSON schemas', () => {
    for (const sch of [ANALYSIS_SCHEMA, DIRECTIONS_SCHEMA, SHOTPLAN_SCHEMA]) expect(walk(sch as Record<string, unknown>)).toEqual([]);
  });

  it('sends vision input and a strict json_schema to the Responses API', async () => {
    const { f, calls } = fakeFetch([reply({ directions: [] })]);
    const p = new OpenAIProvider({ apiKey: 'sk-test', textModel: 'gpt-4.1', imageModel: 'gpt-image-2', fetch: f, prices: { textIn: 2, textOut: 8 } });
    const img = { assetId: 'a1', role: 'product' as const, mimeType: 'image/jpeg', bytes: await testImage('jpeg', 2400, 3000) };
    const r = await p.generateDirections({ prompt: 'Make three', brief, analysis: null, images: [img], seed: 's' }, signal);
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/responses');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.model).toBe('gpt-4.1');
    expect(body.text.format).toMatchObject({ type: 'json_schema', name: 'creative_directions', strict: true });
    const content = body.input[1].content as { type: string; text?: string; image_url?: string }[];
    expect(content.map((c) => c.type)).toEqual(['input_text', 'input_text', 'input_image']);
    expect(content[1]!.text).toMatch(/PRODUCT \(asset id a1\)/);
    expect(content[2]!.image_url).toMatch(/^data:image\/jpeg;base64,/);
    // Large photos are downscaled before upload to bound token cost.
    expect(content[2]!.image_url!.length).toBeLessThan(400_000);
    expect(r.usage).toEqual({ inputTokens: 1000, outputTokens: 500, estCostUsd: 0.006 });
  });

  it('maps refusals, truncation and invalid JSON to clear errors', async () => {
    const refusal = json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'Not allowed' }] }] });
    const truncated = json({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] });
    const garbage = json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{oops' }] }] });
    const { f } = fakeFetch([refusal, truncated, garbage]);
    const p = new OpenAIProvider({ apiKey: 'k', textModel: 't', imageModel: 'gpt-image-2', fetch: f });
    const req = { prompt: 'x', brief, analysis: null, images: [], seed: 's' };
    await expect(p.generateDirections(req, signal)).rejects.toMatchObject({ code: 'refusal', retryable: false });
    await expect(p.generateDirections(req, signal)).rejects.toMatchObject({ code: 'incomplete', retryable: true });
    await expect(p.generateDirections(req, signal)).rejects.toMatchObject({ code: 'invalid_output', retryable: true });
  });

  it('classifies HTTP errors as retryable or not', async () => {
    const { f } = fakeFetch([
      json({ error: { message: 'Rate limit' } }, 429),
      json({ error: { message: 'You exceeded your current quota, check billing' } }, 429),
      json({ error: { message: 'bad key' } }, 401),
      json({ error: { message: 'boom' } }, 503),
      json({ error: { message: 'Your request was rejected by the safety system', code: 'moderation_blocked' } }, 400),
    ]);
    const p = new OpenAIProvider({ apiKey: 'k', textModel: 't', imageModel: 'gpt-image-2', fetch: f });
    const req = { prompt: 'x', brief, analysis: null, images: [], seed: 's' };
    const errs: ProviderError[] = [];
    for (let i = 0; i < 5; i++) errs.push(await p.generateDirections(req, signal).catch((e) => e));
    expect(errs.map((e) => [e.code, e.retryable])).toEqual([
      ['rate_limited', true],
      ['quota', false],
      ['auth', false],
      ['upstream', true],
      ['moderation_blocked', false],
    ]);
  });

  it('generates from text alone, or edits with real product photos as inputs', async () => {
    const png = Buffer.from(await testImage('png', 1024, 1280)).toString('base64');
    const { f, calls } = fakeFetch([json({ data: [{ b64_json: png }, { b64_json: png }], usage: { input_tokens: 50, output_tokens: 4000 } }), json({ data: [{ b64_json: png }] })]);
    const p = new OpenAIProvider({ apiKey: 'k', textModel: 't', imageModel: 'gpt-image-2', fetch: f });
    const base = { kind: 'concept' as const, prompt: 'hero', n: 2, aspectRatio: '4:5' as const, quality: 'high' as const, seed: 's', hints: {} };
    const r1 = await p.generateImages({ ...base, source: null, references: [] }, signal);
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/images/generations');
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ model: 'gpt-image-2', n: 2, size: '1024x1280', quality: 'high', output_format: 'png' });
    expect(r1.value).toHaveLength(2);
    expect(r1.value[0]).toMatchObject({ mimeType: 'image/png', width: 1024, height: 1280 });

    const product = { assetId: 'p', role: 'product' as const, mimeType: 'image/jpeg', bytes: await testImage('jpeg') };
    const ref = { assetId: 'r', role: 'reference' as const, mimeType: 'image/png', bytes: await testImage('png') };
    await p.generateImages({ ...base, n: 1, source: null, references: [product, ref] }, signal);
    expect(calls[1]!.url).toBe('https://api.openai.com/v1/images/edits');
    const form = calls[1]!.init.body as FormData;
    expect(form.getAll('image[]')).toHaveLength(2);
    expect(form.get('model')).toBe('gpt-image-2');
    // gpt-image-2 does not take input_fidelity; gpt-image-1 does.
    expect(form.get('input_fidelity')).toBeNull();
  });

  it('picks valid sizes for each model family', () => {
    expect(imageSize('gpt-image-2', '16:9')).toBe('1536x864');
    expect(imageSize('gpt-image-2.5-flare', '9:16')).toBe('864x1536');
    expect(imageSize('gpt-image-1', '4:5')).toBe('1024x1536');
    expect(imageSize('gpt-image-1', '16:9')).toBe('1536x1024');
    for (const r of ['1:1', '4:5', '3:2', '2:3', '16:9', '9:16'] as const) {
      const [w, h] = imageSize('gpt-image-2', r).split('x').map(Number) as [number, number];
      expect(w % 16 + (h % 16)).toBe(0);
      expect(w * h).toBeGreaterThanOrEqual(655_360);
      expect(Math.max(w, h) / Math.min(w, h)).toBeLessThanOrEqual(3);
    }
  });

  it('honours cancellation', async () => {
    const ctrl = new AbortController();
    const f = (async (_u: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
    const p = new OpenAIProvider({ apiKey: 'k', textModel: 't', imageModel: 'gpt-image-2', fetch: f });
    const pending = p.generateDirections({ prompt: 'x', brief, analysis: null, images: [], seed: 's' }, ctrl.signal);
    ctrl.abort();
    await expect(pending).rejects.toMatchObject({ name: 'CancelledError' });
  });
});
