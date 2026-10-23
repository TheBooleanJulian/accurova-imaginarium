import { useMemo, useState, type ReactNode } from 'react';
import { ArrowLeft, CheckCircle2, ChevronDown, Download, FileText, PenSquare } from 'lucide-react';
import type { Asset, ProjectBundle } from '@/core/types';
import { approvalStateOf, buildApprovedBundle, resolveInputs, type DirectionValue, type GraphContext, type ImageRef } from '@/core/graph';
import type { ShotPlan } from '@/core/schemas';
import { can, ROLE_LABELS } from '@/core/permissions';
import { AI_DISCLAIMER } from '@/core/executors';
import { AssetImage, Badge, Button, Empty, Spinner, Wordmark, toast } from '@/components/ui';
import { useProjectBundle, useRepo } from '@/lib/repoContext';
import { navigate } from '@/lib/router';
import { cn, errMsg, timeAgo } from '@/lib/cn';
import { UserMenu } from '@/features/auth/UserMenu';
import { AssetCard, AssetLightbox } from '@/features/assets/AssetViews';
import { downloadAsset } from '@/features/export/ExportPanel';

export default function ReviewPage({ projectId }: { projectId: string }) {
  const { bundle, error } = useProjectBundle(projectId);
  if (error && !bundle)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="text-lg font-semibold">This moodboard isn&apos;t available</div>
        <div className="text-sm text-soft">{error}</div>
        <Button onClick={() => navigate('/')}>Go home</Button>
      </div>
    );
  if (!bundle)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-6" />
      </div>
    );
  return <Review bundle={bundle} />;
}

function SectionHead({ kicker, title, right }: { kicker: string; title: string; right?: ReactNode }) {
  return (
    <div className="mb-3 flex items-end gap-3">
      <div>
        <div className="label-mono">{kicker}</div>
        <h2 className="mt-0.5 text-lg font-semibold tracking-tight">{title}</h2>
      </div>
      <div className="ml-auto">{right}</div>
    </div>
  );
}

function QuickApprove({ asset, bundle, onOpen }: { asset: Asset; bundle: ProjectBundle; onOpen: () => void }) {
  const { repo } = useRepo();
  const [busy, setBusy] = useState(false);
  const state = approvalStateOf(bundle.approvals, asset.id);
  if (!can(bundle.myRole, 'approval.create')) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1.5 sm:flex-row">
      {state !== 'approved' && (
        <Button
          size="sm"
          variant="primary"
          className="min-w-0 flex-1 px-2"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await repo.recordApproval(asset.projectId, asset.id, 'approved');
              toast('Approved', 'ok');
            } catch (e) {
              toast(errMsg(e), 'err');
            } finally {
              setBusy(false);
            }
          }}
        >
          <CheckCircle2 className="size-3.5" /> Approve
        </Button>
      )}
      <Button size="sm" variant="outline" className="min-w-0 flex-1 px-2" onClick={onOpen} title="Comment or request changes">
        <span className="truncate">{state === 'approved' ? 'Details' : 'Comment'}</span>
      </Button>
    </div>
  );
}

function Review({ bundle }: { bundle: ProjectBundle }) {
  const { repo } = useRepo();
  const [open, setOpen] = useState<Asset | null>(null);
  const ctx: GraphContext = useMemo(
    () => ({ nodes: bundle.nodes, edges: bundle.edges, assets: bundle.assets, runs: bundle.runs, approvals: bundle.approvals }),
    [bundle],
  );

  const boards = useMemo(
    () =>
      bundle.nodes
        .filter((n) => n.type === 'approval')
        .sort((a, b) => a.position.y - b.position.y)
        .map((n) => {
          const inputs = resolveInputs(ctx, n.id);
          const images = (inputs.images as ImageRef[] | undefined) ?? [];
          const direction = inputs.direction as DirectionValue | undefined;
          const shotplan = inputs.shotplan as ShotPlan | undefined;
          const b = buildApprovedBundle(n.id, images, bundle.approvals, direction, shotplan);
          const ids = new Set([...b.assetIds, ...b.pendingAssetIds, ...b.changesRequestedAssetIds]);
          const assets = images.map((i) => bundle.assets.find((a) => a.id === i.assetId)).filter((a): a is Asset => !!a && ids.has(a.id));
          return { node: n, bundle: b, concepts: assets.filter((a) => a.role !== 'pose'), poses: assets.filter((a) => a.role === 'pose') };
        }),
    [bundle, ctx],
  );

  const total = boards.reduce((t, b) => t + b.concepts.length + b.poses.length, 0);
  const approved = boards.reduce((t, b) => t + b.bundle.assetIds.length, 0);
  const changes = boards.reduce((t, b) => t + b.bundle.changesRequestedAssetIds.length, 0);
  const uploads = bundle.assets.filter((a) => a.sourceType === 'upload');
  const exports = bundle.assets
    .filter((a) => a.role === 'export')
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const exportMode = (a: Asset) => (bundle.runs.find((r) => r.outputAssetIds.includes(a.id))?.output as { mode?: string } | undefined)?.mode ?? 'draft';
  const latestFinal = exports.find((a) => exportMode(a) === 'final');

  const grid = (list: Asset[]) => (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {list.map((a) => (
        <AssetCard key={a.id} asset={a} bundle={bundle} onClick={() => setOpen(a)} footer={<QuickApprove asset={a} bundle={bundle} onOpen={() => setOpen(a)} />} />
      ))}
    </div>
  );

  return (
    <div className="min-h-full" data-testid="review-page">
      <header className="sticky top-0 z-20 border-b border-line bg-void/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 sm:px-6">
          {can(bundle.myRole, 'graph.edit') ? (
            <Button variant="ghost" size="sm" onClick={() => navigate(`/p/${bundle.project.id}`)}>
              <ArrowLeft className="size-3.5" /> <PenSquare className="size-3.5" /> <span className="hidden sm:inline">Editor</span>
            </Button>
          ) : (
            <button onClick={() => navigate('/')} aria-label="All projects">
              <Wordmark />
            </button>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Badge tone="teal">{ROLE_LABELS[bundle.myRole]}</Badge>
            <UserMenu />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-12 px-4 py-8 sm:px-6">
        <section className="space-y-4">
          <div className="label-mono">Preshoot moodboard · {bundle.project.client}</div>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{bundle.project.name}</h1>
          {boards[0] && <p className="max-w-2xl text-[15px] leading-relaxed text-soft">{String(boards[0].node.data.message ?? '')}</p>}
          {total > 0 && (
            <div className="max-w-md space-y-2">
              <div className="flex items-center gap-3 text-sm">
                <span>
                  <span className="font-semibold text-ok">{approved}</span> of {total} approved
                </span>
                {changes > 0 && <Badge tone="err">{changes} changes requested</Badge>}
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-raised">
                <div className="h-full rounded-full bg-ok transition-all" style={{ width: `${(approved / total) * 100}%` }} />
              </div>
            </div>
          )}
          {latestFinal && (
            <Button variant="gold" onClick={() => downloadAsset(repo, latestFinal).catch((e) => toast(errMsg(e), 'err'))}>
              <Download className="size-4" /> Download approved preshoot pack
            </Button>
          )}
        </section>

        {!boards.length || !total ? (
          <Empty title="Nothing to review yet">Accurova will share concepts here as soon as they&apos;re ready. You&apos;ll be able to approve each image or request changes.</Empty>
        ) : (
          boards.map(({ node, bundle: b, concepts, poses }) => (
            <div key={node.id} className="space-y-10">
              {boards.length > 1 && <h2 className="border-b border-line pb-2 text-xl font-semibold">{String(node.data.title || 'Review')}</h2>}
              {b.direction && <DirectionCard d={b.direction} />}
              {concepts.length > 0 && (
                <section>
                  <SectionHead kicker="Concepts" title="Campaign concepts" right={<span className="font-mono text-[11px] text-mute">{concepts.length} images</span>} />
                  {grid(concepts)}
                </section>
              )}
              {poses.length > 0 && (
                <section>
                  <SectionHead kicker="Direction on set" title="Pose references" />
                  {grid(poses)}
                </section>
              )}
              {b.shotplan && <ShotList plan={b.shotplan} bundle={bundle} />}
            </div>
          ))
        )}

        {uploads.length > 0 && (
          <section>
            <SectionHead kicker="Inputs" title="Your product & references" />
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-6">
              {uploads.map((a) => (
                <button key={a.id} onClick={() => setOpen(a)} className="group relative aspect-square overflow-hidden rounded-lg border border-line">
                  <AssetImage asset={a} className="h-full w-full" thumb />
                  <span className="absolute inset-x-0 bottom-0 bg-void/80 px-1.5 py-1 text-left font-mono text-[9.5px] uppercase tracking-wider text-soft">
                    {a.role === 'product' ? 'Real product' : a.role === 'brand' ? 'Brand' : 'Reference'}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        {exports.length > 0 && (
          <section>
            <SectionHead kicker="Documents" title="Preshoot packs" />
            <div className="space-y-2">
              {exports.slice(0, 6).map((a) => (
                <div key={a.id} className="flex items-center gap-3 rounded-xl border border-line bg-panel px-4 py-3">
                  <FileText className="size-5 text-mute" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{a.label}</div>
                    <div className="font-mono text-[11px] text-mute">{timeAgo(a.createdAt)}</div>
                  </div>
                  <Badge tone={exportMode(a) === 'final' ? 'ok' : 'gold'}>{exportMode(a)}</Badge>
                  <Button size="sm" variant="outline" onClick={() => downloadAsset(repo, a).catch((e) => toast(errMsg(e), 'err'))}>
                    <Download className="size-3.5" /> PDF
                  </Button>
                </div>
              ))}
            </div>
          </section>
        )}

        <footer className="border-t border-line pt-6 text-[12px] leading-relaxed text-mute">
          {AI_DISCLAIMER} Real product photos are shown as supplied. Prepared by Accurova, Singapore.
        </footer>
      </main>
      <AssetLightbox asset={open} bundle={bundle} onClose={() => setOpen(null)} />
    </div>
  );
}

function DirectionCard({ d }: { d: DirectionValue }) {
  const [more, setMore] = useState(false);
  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-panel">
      <div className="flex h-3">
        {d.palette.map((c) => (
          <div key={c} className="flex-1" style={{ background: c }} />
        ))}
      </div>
      <div className="space-y-3 p-5 sm:p-6">
        <div className="label-mono">Creative direction</div>
        <h2 className="text-2xl font-semibold tracking-tight">{d.title}</h2>
        <p className="max-w-3xl text-[15px] leading-relaxed text-soft">{d.creativeDirection}</p>
        <div className="flex flex-wrap gap-2">
          {d.palette.map((c) => (
            <span key={c} className="inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-1 font-mono text-[11px] text-soft">
              <span className="size-3 rounded-sm" style={{ background: c }} />
              {c}
            </span>
          ))}
        </div>
        <button className="inline-flex items-center gap-1 text-[13px] text-teal hover:underline" onClick={() => setMore(!more)}>
          <ChevronDown className={cn('size-3.5 transition', more && 'rotate-180')} /> {more ? 'Less' : 'Lighting, poses and set'}
        </button>
        {more && (
          <div className="grid gap-4 pt-1 text-[13px] sm:grid-cols-2">
            {(
              [
                ['Why it works', d.rationale],
                ['Lighting', d.lighting],
                ['Poses', d.poseSuggestions.join(' · ')],
                ['Set & props', d.backgroundAndProps.join(' · ')],
                ['Shots', d.proposedShots.join(' · ')],
                ['We will avoid', d.negativeInstructions.join(' · ')],
              ] as const
            )
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <div key={k}>
                  <div className="label-mono">{k}</div>
                  <div className="mt-0.5 text-soft">{v}</div>
                </div>
              ))}
          </div>
        )}
      </div>
    </section>
  );
}

function ShotList({ plan, bundle }: { plan: ShotPlan; bundle: ProjectBundle }) {
  return (
    <section>
      <SectionHead kicker="Production plan" title="Shot list" right={<span className="font-mono text-[11px] text-mute">≈ {Math.round(plan.totalSetupMinutes / 6) / 10} h setup</span>} />
      <div className="grid min-w-0 gap-2 md:grid-cols-2">
        {plan.shots.map((s) => {
          const ref = s.referenceAssetId ? bundle.assets.find((a) => a.id === s.referenceAssetId) : null;
          return (
            <div key={s.id} className="flex min-w-0 gap-3 rounded-xl border border-line bg-panel p-3">
              {ref ? <AssetImage asset={ref} className="size-16 shrink-0 rounded-lg border border-line" thumb /> : <div className="size-16 shrink-0 rounded-lg border border-dashed border-line" />}
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0 font-mono text-[11px] text-teal">{s.id}</span>
                  <span className="min-w-0 truncate text-[13.5px] font-medium">{s.title}</span>
                  <Badge tone={s.priority === 'must' ? 'gold' : s.priority === 'should' ? 'teal' : 'mute'} className="ml-auto shrink-0">
                    {s.priority}
                  </Badge>
                </div>
                <div className="text-[12px] text-soft">{s.poseDirection}</div>
                <div className="break-words font-mono text-[10.5px] text-mute">
                  {s.framing} · {s.cameraAngle} · {s.deliverableFormat}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-[11px] text-mute">{plan.disclaimer}</p>
    </section>
  );
}
