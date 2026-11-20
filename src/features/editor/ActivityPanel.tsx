import { useState, type ReactElement } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, CircleStop, Clock, Loader2, CheckCircle2, XCircle, Ban } from 'lucide-react';
import type { GenerationJob, JobStatus } from '@/core/types';
import { getNodeDef } from '@/core/nodeRegistry';
import { Badge, Button, toast } from '@/components/ui';
import { useRepo } from '@/lib/repoContext';
import { cn, errMsg, timeAgo } from '@/lib/cn';
import { useEditor } from './editorContext';

type Tab = 'jobs' | 'comments' | 'activity' | 'errors';

const JOB_ICON: Record<JobStatus, ReactElement> = {
  queued: <Clock className="size-3.5 text-magenta" />,
  running: <Loader2 className="size-3.5 animate-spin text-cyan" />,
  succeeded: <CheckCircle2 className="size-3.5 text-ok" />,
  failed: <XCircle className="size-3.5 text-err" />,
  cancelled: <Ban className="size-3.5 text-mute" />,
};

const ACTION_LABEL: Record<string, string> = {
  'project.create': 'created the project',
  'project.update': 'updated project details',
  'graph.update': 'changed the graph',
  'asset.upload': 'uploaded an image',
  'job.submit': 'started a job',
  'job.regenerate': 'regenerated',
  'job.succeeded': 'job finished',
  'job.failed': 'job failed',
  'job.cancelled': 'job cancelled',
  'comment.create': 'commented',
  'approval.approved': 'approved',
  'approval.changes_requested': 'requested changes',
  'member.invite': 'invited',
  'member.join': 'joined the project',
  'export.create': 'exported a PDF',
};

function duration(j: GenerationJob): string {
  if (!j.startedAt) return '';
  const end = j.finishedAt ? Date.parse(j.finishedAt) : Date.now();
  const s = Math.max(0, Math.round((end - Date.parse(j.startedAt)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function ActivityPanel() {
  const { repo } = useRepo();
  const { bundle, editor, select } = useEditor();
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState<Tab>('jobs');
  const nodeLabel = (id: string) => {
    const n = editor.graph.nodes.find((x) => x.id === id);
    return n ? String(n.data.title || getNodeDef(n.type).label) : 'Deleted node';
  };
  const jobs = [...bundle.jobs].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const active = jobs.filter((j) => j.status === 'queued' || j.status === 'running');
  const failed = jobs.filter((j) => j.status === 'failed');
  const openComments = bundle.comments.filter((c) => !c.resolved);
  const errorsCount = failed.length + (editor.saveError ? 1 : 0);

  const tabs: [Tab, string, number][] = [
    ['jobs', 'Jobs', active.length],
    ['comments', 'Comments', openComments.length],
    ['activity', 'Activity', 0],
    ['errors', 'Errors', errorsCount],
  ];

  return (
    <section className={cn('shrink-0 border-t border-line bg-ink', open ? 'h-[216px]' : 'h-9')} data-testid="activity-panel">
      <div className="flex h-9 items-center gap-1 border-b border-line px-2">
        {tabs.map(([id, label, count]) => (
          <button
            key={id}
            onClick={() => {
              setTab(id);
              setOpen(true);
            }}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] transition',
              open && tab === id ? 'bg-raised text-text' : 'text-mute hover:text-soft',
            )}
          >
            {label}
            {count > 0 && (
              <span className={cn('rounded px-1 font-mono text-[10px]', id === 'errors' ? 'bg-err/15 text-err' : 'bg-cyan-dim text-cyan')}>{count}</span>
            )}
          </button>
        ))}
        <button className="ml-auto rounded-md p-1 text-mute hover:text-text" onClick={() => setOpen(!open)} aria-label={open ? 'Collapse panel' : 'Expand panel'}>
          {open ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
        </button>
      </div>
      {open && (
        <div className="h-[calc(100%-36px)] overflow-y-auto px-2 py-1.5 text-[12px]">
          {tab === 'jobs' &&
            (jobs.length ? (
              <table className="w-full">
                <tbody>
                  {jobs.slice(0, 80).map((j) => (
                    <tr key={j.id} className="border-b border-line/50 last:border-0 hover:bg-raised/50">
                      <td className="w-6 py-1.5 pl-1">{JOB_ICON[j.status]}</td>
                      <td className="py-1.5">
                        <button className="hover:text-cyan" onClick={() => select(j.nodeId)}>
                          {nodeLabel(j.nodeId)}
                        </button>
                        <span className="ml-1.5 font-mono text-[10.5px] text-mute">{j.operation}</span>
                      </td>
                      <td className="hidden py-1.5 font-mono text-[10.5px] text-mute md:table-cell">
                        {j.provider}/{j.model}
                      </td>
                      <td className="py-1.5 font-mono text-[10.5px] text-mute">
                        {j.attempts > 1 && <span className="text-warn">try {j.attempts} · </span>}
                        {duration(j)}
                      </td>
                      <td className="max-w-[240px] truncate py-1.5 text-[11px] text-err" title={j.error?.message}>
                        {j.status === 'failed' || (j.status === 'queued' && j.error) ? j.error?.message : ''}
                      </td>
                      <td className="py-1.5 text-right font-mono text-[10.5px] text-mute">{timeAgo(j.createdAt)}</td>
                      <td className="w-16 py-1.5 pr-1 text-right">
                        {(j.status === 'queued' || j.status === 'running') && (
                          <Button size="sm" variant="ghost" onClick={() => repo.cancelJob(j.id).catch((e) => toast(errMsg(e), 'err'))} title="Cancel job">
                            <CircleStop className="size-3.5" />
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="p-3 text-mute">No jobs yet. AI only runs when you press Run on a node.</div>
            ))}

          {tab === 'comments' &&
            (bundle.comments.length ? (
              <div className="space-y-1">
                {[...bundle.comments]
                  .sort((a, b) => Number(a.resolved) - Number(b.resolved) || (a.createdAt < b.createdAt ? 1 : -1))
                  .map((c) => {
                    const asset = c.assetId ? bundle.assets.find((a) => a.id === c.assetId) : null;
                    return (
                      <div key={c.id} className={cn('flex gap-2 rounded-md px-2 py-1.5 hover:bg-raised/50', c.resolved && 'opacity-50')}>
                        <span className="shrink-0 text-soft">{c.authorName}</span>
                        <span className="min-w-0 flex-1 truncate">{c.body}</span>
                        <span className="shrink-0 truncate text-[11px] text-mute">
                          {asset ? `on ${asset.label}` : c.nodeId ? (
                            <button className="hover:text-cyan" onClick={() => select(c.nodeId!)}>
                              on {nodeLabel(c.nodeId)}
                            </button>
                          ) : null}
                        </span>
                        {c.resolved && <Badge>resolved</Badge>}
                        <span className="shrink-0 font-mono text-[10.5px] text-mute">{timeAgo(c.createdAt)}</span>
                      </div>
                    );
                  })}
              </div>
            ) : (
              <div className="p-3 text-mute">No comments yet. Clients comment from the client view.</div>
            ))}

          {tab === 'activity' && (
            <div className="space-y-0.5">
              {[...bundle.activity]
                .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
                .slice(0, 120)
                .map((e) => (
                  <div key={e.id} className="flex gap-2 px-2 py-1">
                    <span className="shrink-0 font-mono text-[10.5px] text-mute">{timeAgo(e.createdAt)}</span>
                    <span className="text-soft">{e.actorName}</span>
                    <span>{ACTION_LABEL[e.action] ?? e.action}</span>
                    <span className="truncate text-mute">
                      {typeof e.meta?.label === 'string' ? e.meta.label : typeof e.meta?.filename === 'string' ? e.meta.filename : typeof e.meta?.email === 'string' ? e.meta.email : ''}
                    </span>
                  </div>
                ))}
            </div>
          )}

          {tab === 'errors' && (
            <div className="space-y-1">
              {editor.saveError && (
                <div className="flex items-start gap-2 rounded-md border border-err/30 bg-err/5 px-2 py-1.5 text-err">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> Save failed: {editor.saveError}
                </div>
              )}
              {failed.map((j) => (
                <div key={j.id} className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-raised/50">
                  <XCircle className="mt-0.5 size-3.5 shrink-0 text-err" />
                  <button className="shrink-0 text-soft hover:text-cyan" onClick={() => select(j.nodeId)}>
                    {nodeLabel(j.nodeId)}
                  </button>
                  <span className="min-w-0 flex-1 text-err">{j.error?.message}</span>
                  <span className="shrink-0 font-mono text-[10.5px] text-mute">
                    {j.error?.code} · {timeAgo(j.createdAt)}
                  </span>
                </div>
              ))}
              {!errorsCount && <div className="p-3 text-mute">No errors.</div>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
