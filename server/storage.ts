import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Config } from './config';

export interface UploadTarget {
  /** Absolute (Supabase) or API-relative (local) URL the browser PUTs the raw file to. */
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
}

/** Private object storage. Keys always start with the project id. */
export interface ObjectStorage {
  readonly kind: 'local' | 'supabase';
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(keys: string[]): Promise<void>;
  /** Short-lived read URL. `download` sets a Content-Disposition filename. */
  signedUrl(key: string, opts: { ttlSeconds: number; download?: string }): Promise<string>;
  /** Where the browser uploads directly (keeps large files off the API server). */
  uploadTarget(key: string, contentType: string, opts: { ttlSeconds: number; maxBytes: number }): Promise<UploadTarget>;
}

export class ObjectNotFoundError extends Error {
  constructor(key: string) {
    super(`File not found: ${key}`);
    this.name = 'ObjectNotFoundError';
  }
}

const KEY_RE = /^[0-9a-f-]{36}\/[A-Za-z0-9._/-]{1,200}$/;
export function assertKey(key: string): void {
  if (!KEY_RE.test(key) || key.includes('..') || key.includes('//')) throw new Error(`Invalid storage key: ${key}`);
}

/** Identify the bytes we serve. We never trust a stored or client-declared content type. */
export function sniffMime(b: Uint8Array): string {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf';
  return 'application/octet-stream';
}

// ------------------------------------------------------------------ local filesystem

/**
 * Files under DATA_DIR/storage. Signed URLs point at this API
 * (/api/files/...) and carry an HMAC + expiry, like Supabase signed URLs.
 */
export class LocalStorage implements ObjectStorage {
  readonly kind = 'local' as const;
  private readonly root: string;
  private readonly secret: string;

  constructor(dataDir: string, secret: string) {
    this.root = path.join(dataDir, 'storage');
    this.secret = secret;
  }

  private file(key: string): string {
    assertKey(key);
    const p = path.resolve(this.root, key);
    if (!p.startsWith(path.resolve(this.root) + path.sep)) throw new Error('Invalid storage key');
    return p;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const p = this.file(key);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, bytes);
  }

  async get(key: string): Promise<Uint8Array> {
    try {
      return new Uint8Array(await readFile(this.file(key)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new ObjectNotFoundError(key);
      throw e;
    }
  }

  async delete(keys: string[]): Promise<void> {
    await Promise.all(keys.map((k) => rm(this.file(k), { force: true })));
  }

  sign(parts: string[]): string {
    return createHmac('sha256', this.secret).update(parts.join('\n')).digest('base64url');
  }

  verify(parts: string[], sig: string, exp: number): boolean {
    if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
    const want = Buffer.from(this.sign(parts));
    const got = Buffer.from(sig);
    return want.length === got.length && timingSafeEqual(want, got);
  }

  async signedUrl(key: string, opts: { ttlSeconds: number; download?: string }): Promise<string> {
    assertKey(key);
    const exp = Math.floor(Date.now() / 1000) + opts.ttlSeconds;
    const dl = opts.download ?? '';
    const sig = this.sign(['GET', key, String(exp), dl]);
    const q = new URLSearchParams({ exp: String(exp), sig });
    if (dl) q.set('dl', dl);
    return `/api/files/${key}?${q}`;
  }

  async uploadTarget(key: string, contentType: string, opts: { ttlSeconds: number; maxBytes: number }): Promise<UploadTarget> {
    assertKey(key);
    const exp = Math.floor(Date.now() / 1000) + opts.ttlSeconds;
    const sig = this.sign(['PUT', key, String(exp), String(opts.maxBytes)]);
    const q = new URLSearchParams({ exp: String(exp), max: String(opts.maxBytes), sig });
    return { url: `/api/files/${key}?${q}`, method: 'PUT', headers: { 'Content-Type': contentType } };
  }
}

// ------------------------------------------------------------------ Supabase Storage

export class SupabaseStorage implements ObjectStorage {
  readonly kind = 'supabase' as const;
  private readonly client: SupabaseClient;
  private readonly bucket: string;

  constructor(url: string, serviceRoleKey: string, bucket: string) {
    this.client = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
    this.bucket = bucket;
  }

  private get store() {
    return this.client.storage.from(this.bucket);
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    assertKey(key);
    const { error } = await this.store.upload(key, bytes, { contentType, upsert: true, cacheControl: '3600' });
    if (error) throw new Error(`Storage upload failed: ${error.message}`);
  }

  async get(key: string): Promise<Uint8Array> {
    assertKey(key);
    const { data, error } = await this.store.download(key);
    if (error || !data) {
      if (/not.?found|404/i.test(error?.message ?? '')) throw new ObjectNotFoundError(key);
      throw new Error(`Storage download failed: ${error?.message ?? 'no data'}`);
    }
    return new Uint8Array(await data.arrayBuffer());
  }

  async delete(keys: string[]): Promise<void> {
    if (!keys.length) return;
    keys.forEach(assertKey);
    const { error } = await this.store.remove(keys);
    if (error) throw new Error(`Storage delete failed: ${error.message}`);
  }

  async signedUrl(key: string, opts: { ttlSeconds: number; download?: string }): Promise<string> {
    assertKey(key);
    const { data, error } = await this.store.createSignedUrl(key, opts.ttlSeconds, opts.download ? { download: opts.download } : undefined);
    if (error || !data) throw new Error(`Could not sign URL: ${error?.message}`);
    return data.signedUrl;
  }

  async uploadTarget(key: string, contentType: string): Promise<UploadTarget> {
    assertKey(key);
    const { data, error } = await this.store.createSignedUploadUrl(key);
    if (error || !data) throw new Error(`Could not create upload URL: ${error?.message}`);
    return { url: data.signedUrl, method: 'PUT', headers: { 'Content-Type': contentType, 'x-upsert': 'false' } };
  }
}

export function createStorage(cfg: Config): ObjectStorage {
  if (cfg.storageMode === 'supabase') {
    return new SupabaseStorage(cfg.env.SUPABASE_URL!, cfg.env.SUPABASE_SERVICE_ROLE_KEY!, cfg.env.STORAGE_BUCKET);
  }
  return new LocalStorage(cfg.dataDir, cfg.signingSecret);
}
