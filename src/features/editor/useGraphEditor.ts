import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GraphEdge, GraphNode, NodeType, XY } from '@/core/types';
import { validateConnection, type ConnectionRequest } from '@/core/graph';
import { makeNode } from '@/data/templates';
import { ConflictError, type Repository } from '@/data/repository';
import { errMsg } from '@/lib/cn';

export type SaveState = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error' | 'readonly';

interface Snapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const HISTORY_LIMIT = 100;

/**
 * Editor-side graph state. Visual changes (move/resize) and creative changes
 * (node data) both go through here; neither ever triggers generation.
 */
export function useGraphEditor(repo: Repository, projectId: string, initial: Snapshot & { revision: number }, readOnly: boolean) {
  const [graph, setGraph] = useState<Snapshot>({ nodes: initial.nodes, edges: initial.edges });
  const [saveState, setSaveState] = useState<SaveState>(readOnly ? 'readonly' : 'saved');
  const [saveError, setSaveError] = useState<string | null>(null);
  const revision = useRef(initial.revision);
  const past = useRef<Snapshot[]>([]);
  const future = useRef<Snapshot[]>([]);
  const lastCoalesce = useRef<{ key: string; at: number } | null>(null);
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const dirtyRef = useRef(false);
  const savingRef = useRef<Promise<void> | null>(null);
  const [, force] = useState(0);

  const commit = useCallback(
    (next: Snapshot, opts: { coalesceKey?: string; history?: boolean } = {}) => {
      if (readOnly) return;
      const prev = graphRef.current;
      if (opts.history !== false) {
        const now = Date.now();
        const c = lastCoalesce.current;
        const coalesce = opts.coalesceKey && c && c.key === opts.coalesceKey && now - c.at < 1200;
        if (!coalesce) {
          past.current = [...past.current, prev].slice(-HISTORY_LIMIT);
          future.current = [];
        }
        lastCoalesce.current = opts.coalesceKey ? { key: opts.coalesceKey, at: now } : null;
      }
      graphRef.current = next;
      setGraph(next);
      dirtyRef.current = true;
      setSaveState((s) => (s === 'conflict' ? s : 'dirty'));
    },
    [readOnly],
  );

  const save = useCallback(async (): Promise<void> => {
    if (readOnly) return;
    if (savingRef.current) await savingRef.current;
    if (!dirtyRef.current) return;
    const snapshot = graphRef.current;
    dirtyRef.current = false;
    setSaveState('saving');
    const p = (async () => {
      try {
        const { revision: r } = await repo.saveGraph(projectId, snapshot, revision.current);
        revision.current = r;
        setSaveError(null);
        setSaveState(dirtyRef.current ? 'dirty' : 'saved');
      } catch (e) {
        dirtyRef.current = true;
        if (e instanceof ConflictError) {
          setSaveState('conflict');
        } else {
          setSaveError(errMsg(e));
          setSaveState('error');
        }
        throw e;
      }
    })();
    savingRef.current = p.catch(() => undefined).finally(() => (savingRef.current = null)) as Promise<void>;
    await p;
  }, [repo, projectId, readOnly]);

  // Autosave, debounced.
  useEffect(() => {
    if (saveState !== 'dirty') return;
    const t = setTimeout(() => void save().catch(() => undefined), 700);
    return () => clearTimeout(t);
  }, [graph, saveState, save]);

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    const onBefore = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBefore);
    return () => window.removeEventListener('beforeunload', onBefore);
  }, []);

  /** Apply a server copy (remote edit or explicit reload). Skipped while local edits are pending. */
  const applyRemote = useCallback((s: Snapshot & { revision: number }, opts: { force?: boolean } = {}) => {
    if (!opts.force && (dirtyRef.current || s.revision <= revision.current)) return;
    revision.current = s.revision;
    dirtyRef.current = false;
    graphRef.current = { nodes: s.nodes, edges: s.edges };
    setGraph(graphRef.current);
    setSaveState(readOnly ? 'readonly' : 'saved');
    if (opts.force) {
      past.current = [];
      future.current = [];
    }
  }, [readOnly]);

  /** Resolve a conflict by keeping local changes on top of the newer server revision. */
  const overwrite = useCallback(async (serverRevision: number) => {
    revision.current = serverRevision;
    dirtyRef.current = true;
    setSaveState('dirty');
    await save();
  }, [save]);

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(graphRef.current);
    lastCoalesce.current = null;
    commit(prev, { history: false });
    force((x) => x + 1);
  }, [commit]);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(graphRef.current);
    lastCoalesce.current = null;
    commit(next, { history: false });
    force((x) => x + 1);
  }, [commit]);

  const actions = useMemo(
    () => ({
      getNode(id: string): GraphNode | undefined {
        return graphRef.current.nodes.find((n) => n.id === id);
      },
      addNode(type: NodeType, position: XY, createdBy: string, data?: Record<string, unknown>): GraphNode {
        const node = makeNode(projectId, type, position, createdBy, data);
        const g = graphRef.current;
        commit({ nodes: [...g.nodes, node], edges: g.edges });
        return node;
      },
      updateData(nodeId: string, patch: Record<string, unknown>, coalesceKey?: string) {
        const g = graphRef.current;
        commit(
          {
            nodes: g.nodes.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...patch }, updatedAt: new Date().toISOString() } : n)),
            edges: g.edges,
          },
          { coalesceKey: coalesceKey ? `${nodeId}:${coalesceKey}` : undefined },
        );
      },
      /** Visual only. `final` = drag ended (adds an undo step). */
      move(positions: Record<string, XY>, final: boolean, dragKey: string) {
        const g = graphRef.current;
        commit(
          { nodes: g.nodes.map((n) => (positions[n.id] ? { ...n, position: positions[n.id]! } : n)), edges: g.edges },
          { coalesceKey: `move:${dragKey}`, history: true },
        );
        if (final) lastCoalesce.current = null;
      },
      resize(nodeId: string, size: { width: number; height: number }) {
        const g = graphRef.current;
        commit({ nodes: g.nodes.map((n) => (n.id === nodeId ? { ...n, size } : n)), edges: g.edges }, { coalesceKey: `resize:${nodeId}` });
      },
      connect(c: ConnectionRequest): string | null {
        const g = graphRef.current;
        const check = validateConnection(g.nodes, g.edges, c);
        if (!check.ok) return check.reason;
        commit({ nodes: g.nodes, edges: [...g.edges, { id: crypto.randomUUID(), projectId, ...c }] });
        return null;
      },
      remove(nodeIds: string[], edgeIds: string[]) {
        if (!nodeIds.length && !edgeIds.length) return;
        const g = graphRef.current;
        const nset = new Set(nodeIds);
        const eset = new Set(edgeIds);
        commit({
          nodes: g.nodes.filter((n) => !nset.has(n.id)),
          edges: g.edges.filter((e) => !eset.has(e.id) && !nset.has(e.source) && !nset.has(e.target)),
        });
      },
      duplicate(nodeIds: string[], createdBy: string): GraphNode[] {
        const g = graphRef.current;
        const copies = g.nodes
          .filter((n) => nodeIds.includes(n.id))
          .map((n) => {
            // Creative config is copied; execution history and selections are not.
            const data = { ...n.data };
            delete data.pinned;
            delete data.selectedAssetIds;
            return makeNode(projectId, n.type, { x: n.position.x + 40, y: n.position.y + 40 }, createdBy, data);
          });
        commit({ nodes: [...g.nodes, ...copies], edges: g.edges });
        return copies;
      },
    }),
    [commit, projectId],
  );

  return {
    graph,
    saveState,
    saveError,
    revision,
    save,
    applyRemote,
    overwrite,
    undo,
    redo,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
    ...actions,
  };
}

export type GraphEditor = ReturnType<typeof useGraphEditor>;
