import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Camera, Eye, FolderPlus, LayoutTemplate, PenSquare, Search, Sparkles, Square } from 'lucide-react';
import { useRepo } from '@/lib/repoContext';
import type { ProjectSummary } from '@/data/repository';
import { AssetImage, Badge, Button, Empty, Field, Input, Modal, Spinner, Textarea, Wordmark, toast } from '@/components/ui';
import { UserMenu } from '@/features/auth/UserMenu';
import { navigate } from '@/lib/router';
import { cn, errMsg, timeAgo } from '@/lib/cn';
import { ROLE_LABELS } from '@/core/permissions';
import type { ProjectStatus } from '@/core/types';

const STATUS_TONE: Record<ProjectStatus, 'mute' | 'teal' | 'ok' | 'gold'> = { draft: 'mute', in_review: 'gold', approved: 'ok', archived: 'mute' };

export function ProjectsPage() {
  const { repo, user } = useRepo();
  const [items, setItems] = useState<ProjectSummary[] | null>(null);
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    repo.listProjects().then(setItems).catch((e) => toast(errMsg(e), 'err'));
  }, [repo]);
  useEffect(() => {
    load();
    return repo.subscribe('*', load);
  }, [repo, load, user]);

  const filtered = (items ?? []).filter((s) => `${s.project.name} ${s.project.client}`.toLowerCase().includes(q.toLowerCase()));
  const open = (s: ProjectSummary) => navigate(s.myRole === 'owner' || s.myRole === 'editor' ? `/p/${s.project.id}` : `/p/${s.project.id}/review`);

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-20 border-b border-line bg-void/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4 sm:px-6">
          <Wordmark />
          <div className="ml-auto flex items-center gap-2">
            <Badge tone={repo.mode === 'local' ? 'gold' : 'teal'}>{repo.providerLabel}</Badge>
            <UserMenu />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        {import.meta.env.VITE_DEMO && (
          <div className="mb-6 rounded-xl border border-gold/30 bg-gold-dim px-4 py-3 text-[13px] leading-relaxed text-soft">
            <span className="font-medium text-gold">Preview demo.</span> Everything stays in this browser and the AI is a mock that draws labelled
            placeholders. File downloads (PDF packs) are blocked in this preview. Run the app or deploy it for real AI, client logins and PDF downloads.
          </div>
        )}
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <div className="label-mono">Preshoot studio</div>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">Campaigns</h1>
          </div>
          <div className="ml-auto flex w-full items-center gap-2 sm:w-auto">
            <div className="relative flex-1 sm:w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-mute" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search projects or clients" className="pl-9" />
            </div>
            <Button variant="primary" onClick={() => setCreating(true)}>
              <FolderPlus className="size-4" /> New project
            </Button>
          </div>
        </div>

        <div className="mt-8">
          {!items ? (
            <div className="flex justify-center py-20"><Spinner /></div>
          ) : !items.length ? (
            <Empty icon={<Camera className="size-7" />} title="No campaigns yet">
              Start a project from the Accurova campaign template: brief → references → concepts → poses → shot plan → client approval → PDF pack.
              <div className="mt-4">
                <Button variant="primary" onClick={() => setCreating(true)}><Sparkles className="size-4" /> Create your first project</Button>
              </div>
            </Empty>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((s) => (
                <button
                  key={s.project.id}
                  onClick={() => open(s)}
                  className="group overflow-hidden rounded-2xl border border-line bg-panel text-left transition hover:-translate-y-0.5 hover:border-teal/40"
                >
                  <div className="relative aspect-[16/10] overflow-hidden bg-ink">
                    {s.coverAsset ? (
                      <AssetImage asset={s.coverAsset} className="h-full w-full transition duration-500 group-hover:scale-[1.03]" thumb />
                    ) : (
                      <div className="flex h-full items-center justify-center bg-[radial-gradient(circle_at_30%_20%,#00d4c822,transparent_60%)]">
                        <LayoutTemplate className="size-8 text-line-2" />
                      </div>
                    )}
                    <div className="absolute left-3 top-3 flex gap-1.5">
                      <Badge tone={STATUS_TONE[s.project.status]}>{s.project.status.replace('_', ' ')}</Badge>
                      {s.pendingReviews > 0 && <Badge tone="gold">{s.pendingReviews} awaiting review</Badge>}
                    </div>
                  </div>
                  <div className="space-y-1 p-4">
                    <div className="flex items-center gap-2">
                      <div className="truncate font-medium">{s.project.name}</div>
                      <span className="ml-auto shrink-0 text-mute">{s.myRole === 'owner' || s.myRole === 'editor' ? <PenSquare className="size-3.5" /> : <Eye className="size-3.5" />}</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-soft">
                      <span className="truncate">{s.project.client || '—'}</span>
                      <span className="text-line-2">•</span>
                      <span>{ROLE_LABELS[s.myRole]}</span>
                      <span className="ml-auto font-mono text-[10.5px] text-mute">{timeAgo(s.project.updatedAt)}</span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </main>
      <NewProjectDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function NewProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { repo } = useRepo();
  const [name, setName] = useState('');
  const [client, setClient] = useState('');
  const [product, setProduct] = useState('');
  const [objective, setObjective] = useState('');
  const [template, setTemplate] = useState<'campaign' | 'blank'>('campaign');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const p = await repo.createProject({ name, client, template, brief: { product, objective } });
      navigate(`/p/${p.id}`);
    } catch (err) {
      toast(errMsg(err), 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="New campaign project">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Project name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Acme Field Watch — Q1 launch" required autoFocus />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Client">
            <Input value={client} onChange={(e) => setClient(e.target.value)} placeholder="Company" required />
          </Field>
          <Field label="Product">
            <Input value={product} onChange={(e) => setProduct(e.target.value)} placeholder="What we’re shooting" />
          </Field>
        </div>
        <Field label="Campaign objective">
          <Textarea value={objective} onChange={(e) => setObjective(e.target.value)} rows={2} placeholder="What should this shoot achieve?" />
        </Field>
        <div className="space-y-1.5">
          <span className="label-mono">Start from</span>
          <div className="grid gap-2 sm:grid-cols-2">
            {([
              ['campaign', 'Accurova campaign', 'Brief, references, analysis, concepts, poses, shot plan, approval and export — pre-wired.', LayoutTemplate],
              ['blank', 'Blank canvas', 'Just a brief node. Build your own graph.', Square],
            ] as const).map(([id, title, desc, Icon]) => (
              <button
                type="button"
                key={id}
                onClick={() => setTemplate(id)}
                className={cn('rounded-xl border p-3 text-left transition', template === id ? 'border-teal/60 bg-teal-dim' : 'border-line hover:border-line-2')}
              >
                <Icon className={cn('mb-2 size-4', template === id ? 'text-teal' : 'text-mute')} />
                <div className="text-sm font-medium">{title}</div>
                <div className="mt-0.5 text-xs text-soft">{desc}</div>
              </button>
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy}>Create project</Button>
        </div>
      </form>
    </Modal>
  );
}
