import { useEffect, useState } from 'react';
import { CheckCircle2, MailWarning } from 'lucide-react';
import { useRepo } from '@/lib/repoContext';
import { navigate } from '@/lib/router';
import { Badge, Button, Spinner, Wordmark, toast } from '@/components/ui';
import { errMsg } from '@/lib/cn';
import { ROLE_LABELS } from '@/core/permissions';
import type { Role } from '@/core/types';
import { SignInPage } from './SignInPage';

type Preview = { projectName: string; client: string; role: Role; email: string; status: string };

export function InvitePage({ token }: { token: string }) {
  const { repo, user, refreshUser } = useRepo();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    repo.previewInvitation(token).then(setPreview).catch((e) => setError(errMsg(e)));
  }, [repo, token]);

  const accept = async () => {
    setBusy(true);
    try {
      const { projectId, role } = await repo.acceptInvitation(token);
      toast('Welcome aboard.', 'ok');
      navigate(role === 'owner' || role === 'editor' ? `/p/${projectId}` : `/p/${projectId}/review`);
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  if (error)
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <MailWarning className="size-8 text-warn" />
        <div className="text-lg font-semibold">Invitation unavailable</div>
        <div className="text-sm text-soft">{error}</div>
        <Button variant="outline" onClick={() => navigate('/')}>Go home</Button>
      </div>
    );
  if (!preview) return <div className="flex h-full items-center justify-center"><Spinner /></div>;

  const wrongUser = user && user.email !== preview.email;
  if (!user || (wrongUser && repo.mode === 'local'))
    return <SignInPage presetEmail={preview.email} title={`Join “${preview.projectName}”`} onDone={() => void refreshUser()} />;

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-md space-y-6 rounded-2xl border border-line bg-panel p-6">
        <Wordmark />
        <div className="space-y-1">
          <div className="label-mono">You’re invited</div>
          <h1 className="text-xl font-semibold">{preview.projectName}</h1>
          <div className="text-sm text-soft">{preview.client}</div>
        </div>
        <div className="flex items-center gap-2 text-sm">
          Role <Badge tone="teal">{ROLE_LABELS[preview.role]}</Badge>
        </div>
        {preview.status !== 'pending' ? (
          <div className="rounded-lg border border-warn/30 bg-warn/10 p-3 text-sm text-warn">This invitation has been {preview.status}.</div>
        ) : wrongUser ? (
          <div className="rounded-lg border border-warn/30 bg-warn/10 p-3 text-sm text-warn">
            This invitation is for {preview.email}, but you’re signed in as {user.email}. Sign out and sign in with the invited email.
          </div>
        ) : (
          <Button variant="primary" className="w-full" onClick={accept} loading={busy}>
            <CheckCircle2 className="size-4" /> Accept and open
          </Button>
        )}
      </div>
    </div>
  );
}
