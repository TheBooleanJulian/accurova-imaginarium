import type {
  ActivityEvent,
  Approval,
  Asset,
  Comment,
  GenerationJob,
  GraphEdge,
  GraphNode,
  Invitation,
  NodeRun,
  Profile,
  Project,
  ProjectMember,
} from '@/core/types';

export interface Tables {
  profiles: Profile[];
  projects: Project[];
  members: ProjectMember[];
  invitations: Invitation[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  assets: Asset[];
  jobs: GenerationJob[];
  runs: NodeRun[];
  comments: Comment[];
  approvals: Approval[];
  activity: ActivityEvent[];
}
export type TableName = keyof Tables;
export const TABLE_NAMES: TableName[] = [
  'profiles', 'projects', 'members', 'invitations', 'nodes', 'edges', 'assets', 'jobs', 'runs', 'comments', 'approvals', 'activity',
];

/**
 * Minimal transactional table store. `mutate` runs `fn` synchronously against
 * the latest persisted state and writes the result atomically, so several tabs
 * can share one browser database without clobbering each other.
 */
export interface TableStore {
  read<K extends TableName>(names: K[]): Promise<Pick<Tables, K>>;
  mutate<K extends TableName, R>(names: K[], fn: (t: Pick<Tables, K>) => R): Promise<R>;
  putBlob(key: string, bytes: Uint8Array, mimeType: string): Promise<void>;
  getBlob(key: string): Promise<{ bytes: Uint8Array; mimeType: string } | undefined>;
}

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryTableStore implements TableStore {
  private data: Tables = Object.fromEntries(TABLE_NAMES.map((n) => [n, []])) as unknown as Tables;
  private blobs = new Map<string, { bytes: Uint8Array; mimeType: string }>();
  /** Test hook: make the next putBlob calls fail. */
  failBlobWrites = 0;

  async read<K extends TableName>(names: K[]): Promise<Pick<Tables, K>> {
    return Object.fromEntries(names.map((n) => [n, clone(this.data[n])])) as Pick<Tables, K>;
  }

  async mutate<K extends TableName, R>(names: K[], fn: (t: Pick<Tables, K>) => R): Promise<R> {
    const draft = await this.read(names);
    const result = fn(draft);
    for (const n of names) (this.data as unknown as Record<string, unknown>)[n] = draft[n];
    return result;
  }

  async putBlob(key: string, bytes: Uint8Array, mimeType: string): Promise<void> {
    if (this.failBlobWrites > 0) {
      this.failBlobWrites--;
      throw new Error('Storage write failed');
    }
    this.blobs.set(key, { bytes: bytes.slice(), mimeType });
  }

  async getBlob(key: string) {
    const b = this.blobs.get(key);
    return b ? { bytes: b.bytes.slice(), mimeType: b.mimeType } : undefined;
  }
}

const DB_NAME = 'accurova-imaginarium';
const DB_VERSION = 1;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export class IndexedDbTableStore implements TableStore {
  private dbp: Promise<IDBDatabase>;

  constructor() {
    this.dbp = new Promise((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, DB_VERSION);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains('tables')) db.createObjectStore('tables');
        if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
  }

  async read<K extends TableName>(names: K[]): Promise<Pick<Tables, K>> {
    const db = await this.dbp;
    const store = db.transaction('tables', 'readonly').objectStore('tables');
    const values = await Promise.all(names.map((n) => req(store.get(n))));
    return Object.fromEntries(names.map((n, i) => [n, (values[i] as unknown[]) ?? []])) as Pick<Tables, K>;
  }

  async mutate<K extends TableName, R>(names: K[], fn: (t: Pick<Tables, K>) => R): Promise<R> {
    const db = await this.dbp;
    return new Promise<R>((resolve, reject) => {
      const tx = db.transaction('tables', 'readwrite');
      const store = tx.objectStore('tables');
      const draft = {} as Pick<Tables, K>;
      let pending = names.length;
      let result: R;
      let failed: unknown = null;
      for (const n of names) {
        const g = store.get(n);
        g.onsuccess = () => {
          (draft as Record<string, unknown>)[n] = g.result ?? [];
          if (--pending === 0) {
            try {
              result = fn(draft);
              for (const m of names) store.put(draft[m], m);
            } catch (e) {
              failed = e;
              tx.abort();
            }
          }
        };
      }
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failed ?? tx.error ?? new Error('Transaction aborted'));
      tx.onerror = () => undefined;
    });
  }

  async putBlob(key: string, bytes: Uint8Array, mimeType: string): Promise<void> {
    const db = await this.dbp;
    const tx = db.transaction('blobs', 'readwrite');
    tx.objectStore('blobs').put({ bytes, mimeType }, key);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async getBlob(key: string) {
    const db = await this.dbp;
    const v = await req(db.transaction('blobs', 'readonly').objectStore('blobs').get(key));
    return v as { bytes: Uint8Array; mimeType: string } | undefined;
  }
}
