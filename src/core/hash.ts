/**
 * Deterministic JSON serialisation + a fast synchronous 106-bit hash.
 * Used for input hashes and idempotency keys (change detection, not security).
 */

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortDeep(v);
    }
    return out;
  }
  return value;
}

function cyrb53(str: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export function hashString(str: string): string {
  return cyrb53(str, 0).toString(16).padStart(14, '0') + cyrb53(str, 0x9e3779b9).toString(16).padStart(14, '0');
}

export function hashValue(value: unknown): string {
  return hashString(stableStringify(value));
}

/** Hash raw bytes (used for asset content hashes in local mode and tests). */
export function hashBytes(bytes: Uint8Array): string {
  let s = '';
  const step = Math.max(1, Math.floor(bytes.length / 65536));
  for (let i = 0; i < bytes.length; i += step) s += String.fromCharCode(bytes[i]!);
  return hashString(`${bytes.length}:${s}`);
}
