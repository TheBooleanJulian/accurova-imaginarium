import type { Repository } from './repository';

/** `server` = talk to the Imaginarium API (Postgres/Supabase + real AI). Anything else = browser-only demo mode. */
export function backendMode(): 'server' | 'local' {
  return import.meta.env.VITE_BACKEND === 'server' ? 'server' : 'local';
}

async function probeImage(blob: Blob): Promise<{ width: number; height: number } | null> {
  try {
    const bmp = await createImageBitmap(blob);
    const dims = { width: bmp.width, height: bmp.height };
    bmp.close();
    return dims;
  } catch {
    return null;
  }
}

/**
 * Server mode when VITE_BACKEND=server (API + Postgres/Supabase + real AI provider),
 * otherwise a fully working offline demo (IndexedDB + mock AI, everything in this browser).
 */
export async function createRepository(): Promise<Repository> {
  if (backendMode() === 'server') {
    const { ApiRepository } = await import('./api/apiRepository');
    return ApiRepository.connect(import.meta.env.VITE_API_URL ?? '');
  }
  // Loaded lazily: server-mode clients never download the local backend or the PDF library.
  const [{ LocalRepository }, { IndexedDbTableStore }, { browserRasterizer }] = await Promise.all([
    import('./local/localRepository'),
    import('./local/tableStore'),
    import('@/features/export/rasterize.browser'),
  ]);
  const SESSION_KEY = 'imaginarium.session';
  const { MemoryTableStore } = await import('./local/tableStore');
  // Private windows and some embedded previews block IndexedDB: fall back to memory (lost on reload).
  const store = await (async () => {
    try {
      const s = new IndexedDbTableStore();
      await s.read(['projects']);
      return s;
    } catch {
      return new MemoryTableStore();
    }
  })();
  return new LocalRepository({
    store,
    session: (() => {
      let mem: string | null = null;
      return {
        get: () => {
          try {
            return localStorage.getItem(SESSION_KEY);
          } catch {
            return mem;
          }
        },
        set: (v: string | null) => {
          mem = v;
          try {
            if (v) localStorage.setItem(SESSION_KEY, v);
            else localStorage.removeItem(SESSION_KEY);
          } catch {
            /* storage blocked: keep the session in memory */
          }
        },
      };
    })(),
    channel: typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('accurova-imaginarium') : null,
    probeImage,
    rasterize: browserRasterizer,
    autoProvisionOwner: true,
  });
}
