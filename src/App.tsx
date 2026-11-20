import { lazy, Suspense, useEffect } from 'react';
import { match, navigate, usePath } from './lib/router';
import { useRepo } from './lib/repoContext';
import { Spinner, Toaster } from './components/ui';
import { ProjectsPage } from './features/projects/ProjectsPage';
import { SignInPage } from './features/auth/SignInPage';
import { InvitePage } from './features/auth/InvitePage';

const EditorPage = lazy(() => import('./features/editor/EditorPage'));
const ReviewPage = lazy(() => import('./features/review/ReviewPage'));

function FullScreenSpinner() {
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner className="size-6" />
    </div>
  );
}

function DemoBanner() {
  return (
    <div role="status" className="flex h-6 shrink-0 items-center justify-center gap-2 border-b border-line bg-panel px-3 font-mono text-[10px] uppercase tracking-wider text-soft">
      <span className="rounded border border-warn/40 bg-warn/10 px-1.5 text-warn">Demo</span>
      <span className="truncate">Mock AI placeholders · data stays in this browser · not the live service</span>
    </div>
  );
}

export function App() {
  const path = usePath();
  const { repo, user, userLoaded } = useRepo();

  useEffect(() => {
    document.title = 'Accurova Imaginarium';
  }, [path]);

  const invite = match('/invite/:token', path);
  let page;
  if (!userLoaded) page = <FullScreenSpinner />;
  else if (invite) page = <InvitePage token={invite.token!} />;
  else if (!user) page = <SignInPage />;
  else {
    const edit = match('/p/:id', path);
    const review = match('/p/:id/review', path);
    if (edit) page = <EditorPage projectId={edit.id!} />;
    else if (review) page = <ReviewPage projectId={review.id!} />;
    else if (path === '/' || path === '') page = <ProjectsPage />;
    else {
      navigate('/');
      page = <FullScreenSpinner />;
    }
  }

  return (
    <div className="flex h-full flex-col">
      {repo.mode === 'local' && <DemoBanner />}
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0">
          <Suspense fallback={<FullScreenSpinner />}>{page}</Suspense>
        </div>
      </div>
      <Toaster />
    </div>
  );
}
