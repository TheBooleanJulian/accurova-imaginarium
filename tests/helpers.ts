import { LocalRepository } from '@/data/local/localRepository';
import { MemoryTableStore } from '@/data/local/tableStore';
import { MockProvider, type MockOptions } from '@/ai/mockProvider';
import type { EngineOptions } from '@/core/jobEngine';
import type { GraphNode, NodeType } from '@/core/types';

/** 1×1 PNG. */
export const PNG_BYTES = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

export function pngBlob(): Blob {
  return new Blob([PNG_BYTES], { type: 'image/png' });
}

/** Several "users" sharing one database, like several browsers against one backend. */
export function makeWorld(opts: { mock?: MockOptions; engine?: EngineOptions } = {}) {
  const store = new MemoryTableStore();
  const make = () =>
    new LocalRepository({
      store,
      provider: new MockProvider({ latencyMs: 0, ...opts.mock }),
      engine: { baseDelayMs: 1, ...opts.engine },
    });
  return { store, make };
}

export function byType(nodes: GraphNode[], type: NodeType, nth = 0): GraphNode {
  const n = nodes.filter((x) => x.type === type)[nth];
  if (!n) throw new Error(`no ${type}`);
  return n;
}
