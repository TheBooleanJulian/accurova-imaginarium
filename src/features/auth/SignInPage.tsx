import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, UserRound } from 'lucide-react';
import type { Profile } from '@/core/types';
import { useRepo } from '@/lib/repoContext';
import { Badge, Button, Field, Input, Wordmark, toast } from '@/components/ui';
import { errMsg } from '@/lib/cn';

export function SignInPage({ presetEmail, onDone, title }: { presetEmail?: string; onDone?: () => void; title?: string }) {
  const { repo, refreshUser } = useRepo();
  const [email, setEmail] = useState(presetEmail ?? '');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [busy, setBusy] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>([]);

  useEffect(() => {
    if (repo.listLocalProfiles) void repo.listLocalProfiles().then(setProfiles);
  }, [repo]);

  const done = async () => {
    await refreshUser();
    onDone?.();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === 'up' && repo.signUp) {
        const p = await repo.signUp(email, password, name);
        if (!p) {
          toast('Check your inbox to confirm your email, then sign in.', 'ok');
          setMode('in');
          return;
        }
      } else {
        await repo.signIn(email, password);
      }
      await done();
    } catch (err) {
      toast(errMsg(err), 'err');
    } finally {
      setBusy(false);
    }
  };

  const local = repo.mode === 'local';
  const passwordless = repo.authMode !== 'supabase';

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6">
        <Wordmark />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{title ?? 'Sign in'}</h1>
          <p className="mt-1 text-sm text-soft">
            {local ? (
              <>Local mode: accounts live in this browser, so you can test the client experience by signing in as the invited email. <Badge>no password</Badge></>
            ) : passwordless ? (
              <>Development sign-in: email only. <Badge>dev server</Badge></>
            ) : (
              'Preshoot moodboards, concepts and shot plans for Accurova clients.'
            )}
          </p>
        </div>
        <form onSubmit={submit} className="space-y-3">
          {mode === 'up' && (
            <Field label="Your name">
              <Input value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />
            </Field>
          )}
          <Field label="Email">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus autoComplete="email" disabled={!!presetEmail && passwordless} />
          </Field>
          {!passwordless && (
            <Field label="Password">
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoComplete={mode === 'up' ? 'new-password' : 'current-password'} />
            </Field>
          )}
          <Button variant="primary" className="w-full" loading={busy} type="submit">
            {mode === 'up' ? 'Create account' : 'Continue'} <ArrowRight className="size-4" />
          </Button>
          {!passwordless && repo.signUp && (
            <button type="button" className="w-full text-center text-xs text-soft hover:text-teal" onClick={() => setMode(mode === 'in' ? 'up' : 'in')}>
              {mode === 'in' ? 'New here? Create an account' : 'Already have an account? Sign in'}
            </button>
          )}
        </form>
        {passwordless && profiles.length > 0 && !presetEmail && (
          <div className="space-y-2">
            <div className="label-mono">{local ? 'Accounts in this browser' : 'Accounts on this dev server'}</div>
            {profiles.map((p) => (
              <button
                key={p.id}
                onClick={async () => {
                  await repo.signIn(p.email);
                  await done();
                }}
                className="flex w-full items-center gap-3 rounded-lg border border-line bg-panel px-3 py-2.5 text-left hover:border-teal/50"
              >
                <UserRound className="size-4 text-mute" />
                <div className="min-w-0">
                  <div className="truncate text-sm">{p.displayName}</div>
                  <div className="truncate font-mono text-[11px] text-mute">{p.email}</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
