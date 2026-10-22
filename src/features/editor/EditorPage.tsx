import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { AlertTriangle, ArrowLeft } from 'lucide-react';
import type { ProjectBundle } from '@/core/types';
import type { GraphContext } from '@/core/graph';
import { can } from '@/core/permissions';
import { SubmitError } from '@/core/jobEngine';
import { Button, Spinner, toast } from '@/components/ui';
import { useProjectBundle, useRepo } from '@/lib/repoContext';
import { navigate } from '@/lib/router';
import { errMsg, newKey } from '@/lib/cn';
import { EditorContext, computeStatuses, type EditorCtx } from './editorContext';
import { useGraphEditor } from './useGraphEditor';
import { Canvas } from './Canvas';
import { NodeLibrary } from './NodeLibrary';
import { InspectorPanel } from './InspectorPanel';
import { ActivityPanel } from './ActivityPanel';
import { EditorToolbar } from './EditorToolbar';

function useMediaQuery(q: string): boolean {
  const [match, setMatch] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setMatch(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [q]);
  return match;
}

export default function EditorPage({ projectId }: { projectId: string }) {
  const { bundle, error, reload } = useProjectBundle(projectId);
  if (error && !bundle) return <LoadError message={error} />;
  if (!bundle) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-6" />
      </div>
    );
  }
  return (
    <ReactFlowProvider>
      <EditorShell key={projectId} bundle={bundle} reload={reload} />
    </ReactFlowProvider>
  );
}

function LoadError({ message }: { message: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
      <AlertTriangle className="size-7 text-warn" />
      <div>
        <div className="text-lg font-semibold">This project couldn&apos;t be opened</div>
        <div className="mt-1 text-sm text-soft">{message}</div>
      </div>
      <Button onClick={() => navigate('/')}>
        <ArrowLeft className="size-4" /> All projects
      </Button>
    </div>
  );
}

function EditorShell({ bundle, reload }: { bundle: ProjectBundle; reload: () => Promise<void> }) {
  const { repo, user } = useRepo();
  const projectId = bundle.project.id;
  const canEdit = can(bundle.myRole, 'graph.edit');
  const editor = useGraphEditor(repo, projectId, { nodes: bundle.nodes, edges: bundle.edges, revision: bundle.project.graphRevision }, !canEdit);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const wide = useMediaQuery('(min-width: 1024px)');
  const { applyRemote } = editor;

  // Reviewers and viewers get the client review screen instead of the node editor.
  useEffect(() => {
    if (!canEdit) navigate(`/p/${projectId}/review`);
  }, [canEdit, projectId]);

  // Pull in graph changes saved elsewhere (another tab or teammate) when we have nothing pending.
  useEffect(() => {
    applyRemote({ nodes: bundle.nodes, edges: bundle.edges, revision: bundle.project.graphRevision });
  }, [bundle.nodes, bundle.edges, bundle.project.graphRevision, applyRemote]);

  // Execution state comes from the server; graph + config from the local (possibly unsaved) editor copy.
  const ctx: GraphContext = useMemo(
    () => ({ nodes: editor.graph.nodes, edges: editor.graph.edges, assets: bundle.assets, runs: bundle.runs, approvals: bundle.approvals }),
    [editor.graph, bundle.assets, bundle.runs, bundle.approvals],
  );
  const statuses = useMemo(() => computeStatuses(ctx, bundle.jobs), [ctx, bundle.jobs]);

  const select = useCallback((id: string | null) => setSelectedId(id), []);

  const runOp = useCallback<EditorCtx['runOp']>(
    async (nodeId, op, opts = {}) => {
      try {
        // The server resolves inputs from the saved graph, so flush pending edits first.
        await editor.save();
        const r = await repo.runNode(projectId, nodeId, op, { force: opts.force, idempotencyKey: newKey() });
        if (r.deduped === 'already_running') toast('Already running. Watch the activity panel.', 'info');
        else if (r.deduped === 'up_to_date') toast('Already up to date with these inputs.', 'info');
        else toast(op === 'export' ? 'Building the PDF pack…' : 'Queued', 'ok');
      } catch (e) {
        if (e instanceof SubmitError) toast(e.message, 'err');
        else toast(errMsg(e), 'err');
      }
    },
    [editor, repo, projectId],
  );

  // Keyboard shortcuts. Ignored while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest('input, textarea, select, [contenteditable="true"]') || t.isContentEditable)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        editor.undo();
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault();
        editor.redo();
      } else if (k === 'd' && selectedId && canEdit) {
        e.preventDefault();
        const [copy] = editor.duplicate([selectedId], user!.id);
        if (copy) setSelectedId(copy.id);
      } else if (k === 's') {
        e.preventDefault();
        void editor.save().catch(() => undefined);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editor, selectedId, canEdit, user]);

  // Drop a selection whose node disappeared (undo, remote delete).
  useEffect(() => {
    if (selectedId && !editor.graph.nodes.some((n) => n.id === selectedId)) setSelectedId(null);
  }, [editor.graph.nodes, selectedId]);

  const value: EditorCtx = {
    bundle,
    editor,
    ctx,
    statuses,
    selectedId,
    select,
    runOp,
    canEdit,
    userId: user?.id ?? '',
  };

  const resolveConflict = async (keepMine: boolean) => {
    try {
      const latest = await repo.loadProject(projectId);
      if (keepMine) await editor.overwrite(latest.project.graphRevision);
      else editor.applyRemote({ nodes: latest.nodes, edges: latest.edges, revision: latest.project.graphRevision }, { force: true });
      await reload();
      toast(keepMine ? 'Your version was saved on top.' : 'Loaded the latest version.', 'ok');
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };

  return (
    <EditorContext.Provider value={value}>
      <div className="flex h-full flex-col bg-void">
        <EditorToolbar />
        <div className="flex min-h-0 flex-1">
          <div className="hidden w-60 shrink-0 md:block">
            <NodeLibrary canvasRef={canvasRef} />
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <div ref={canvasRef} className="relative min-h-0 flex-1">
              <Canvas />
              {editor.saveState === 'conflict' && (
                <div className="absolute inset-x-0 top-3 z-10 mx-auto flex w-fit max-w-[92%] flex-wrap items-center gap-3 rounded-xl border border-warn/40 bg-[#221a0c]/95 px-4 py-2.5 text-sm shadow-xl backdrop-blur">
                  <AlertTriangle className="size-4 shrink-0 text-warn" />
                  <span>Someone else saved this project while you were editing.</span>
                  <Button size="sm" onClick={() => void resolveConflict(false)}>
                    Load theirs
                  </Button>
                  <Button size="sm" variant="primary" onClick={() => void resolveConflict(true)}>
                    Keep mine
                  </Button>
                </div>
              )}
            </div>
            <ActivityPanel />
          </div>
          {wide && (
            <div className="w-[372px] shrink-0 border-l border-line bg-ink">
              <InspectorPanel />
            </div>
          )}
        </div>
        {/* Small screens: the inspector slides over the canvas when a node is selected. */}
        {!wide && selectedId && (
          <div className="fixed inset-x-0 bottom-0 z-30 h-[70vh] overflow-hidden rounded-t-2xl border-t border-line bg-ink shadow-2xl">
            <InspectorPanel />
          </div>
        )}
      </div>
    </EditorContext.Provider>
  );
}
