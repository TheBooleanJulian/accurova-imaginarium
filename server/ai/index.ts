import type { AIProvider } from '../../src/core/ai';
import { MockProvider } from '../../src/ai/mockProvider';
import type { Config } from '../config';
import { OpenAIProvider } from './openai';

export interface ProviderInfo {
  provider: AIProvider;
  /** Shown in the UI so mock output is never mistaken for a real model. */
  label: string;
}

/**
 * The provider lives only on the server: API keys never reach the browser.
 * The mock provider draws clearly-labelled SVG placeholders; the job store
 * rasterises them to PNG before they are stored.
 */
export function createProvider(cfg: Config): ProviderInfo {
  if (cfg.env.AI_PROVIDER === 'openai') {
    const provider = new OpenAIProvider({
      apiKey: cfg.env.OPENAI_API_KEY!,
      baseUrl: cfg.env.OPENAI_BASE_URL,
      textModel: cfg.env.OPENAI_TEXT_MODEL,
      imageModel: cfg.env.OPENAI_IMAGE_MODEL,
      timeoutMs: cfg.env.OPENAI_TIMEOUT_MS,
      prices: {
        textIn: cfg.env.OPENAI_PRICE_TEXT_IN,
        textOut: cfg.env.OPENAI_PRICE_TEXT_OUT,
        imageIn: cfg.env.OPENAI_PRICE_IMAGE_IN,
        imageOut: cfg.env.OPENAI_PRICE_IMAGE_OUT,
      },
    });
    return { provider, label: `OpenAI · ${cfg.env.OPENAI_IMAGE_MODEL}` };
  }
  return { provider: new MockProvider({ latencyMs: cfg.env.MOCK_LATENCY_MS }), label: 'Mock AI · no API key' };
}
