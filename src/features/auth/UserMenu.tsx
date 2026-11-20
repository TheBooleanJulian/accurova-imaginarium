import { useEffect, useRef, useState } from 'react';
import { ChevronDown, LogOut, Monitor, Moon, Sun, UserRound, Users } from 'lucide-react';
import type { Profile } from '@/core/types';
import { useRepo } from '@/lib/repoContext';
import { Badge, Button } from '@/components/ui';
import { navigate } from '@/lib/router';
import { getTheme, setTheme, type ThemeChoice } from '@/lib/theme';

export function UserMenu() {
  const { repo, user, refreshUser } = useRepo();
  const [open, setOpen] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [theme, setThemeState] = useState<ThemeChoice>(getTheme);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && repo.listLocalProfiles) void repo.listLocalProfiles().then(setProfiles);
  }, [open, repo]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  if (!user) return null;
  const switchTo = async (p: Profile) => {
    await repo.signIn(p.email);
    await refreshUser();
    setOpen(false);
    navigate('/');
  };

  return (
    <div className="relative" ref={ref}>
      <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)} className="gap-2">
        <span className="flex size-6 items-center justify-center rounded-full bg-raised text-[11px] font-semibold text-cyan">
          {user.displayName.slice(0, 1).toUpperCase()}
        </span>
        <span className="hidden max-w-[140px] truncate sm:inline">{user.displayName}</span>
        <ChevronDown className="size-3.5" />
      </Button>
      {open && (
        <div className="absolute right-0 top-full z-40 mt-2 w-72 rounded-xl border border-line bg-panel p-2 shadow-2xl">
          <div className="px-2 py-1.5">
            <div className="text-sm font-medium">{user.displayName}</div>
            <div className="font-mono text-[11px] text-mute">{user.email}</div>
          </div>
          {repo.listLocalProfiles && (
            <>
              <div className="mt-1 border-t border-line px-2 pt-2 label-mono flex items-center gap-1.5">
                <Users className="size-3" /> Switch account <Badge>{repo.mode === 'local' ? 'demo' : 'dev login'}</Badge>
              </div>
              <div className="max-h-56 overflow-auto py-1">
                {profiles
                  .filter((p) => p.id !== user.id)
                  .map((p) => (
                    <button key={p.id} onClick={() => switchTo(p)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-raised">
                      <UserRound className="size-3.5 text-mute" />
                      <span className="truncate">{p.displayName}</span>
                      <span className="ml-auto truncate font-mono text-[10px] text-mute">{p.email}</span>
                    </button>
                  ))}
                {profiles.length <= 1 && <div className="px-2 py-1 text-xs text-mute">Invite a client to create a second account to test their view.</div>}
              </div>
            </>
          )}
          <div className="mt-1 border-t border-line px-2 pb-1 pt-2">
            <div className="label-mono mb-1.5">Theme</div>
            <div className="flex gap-1">
              {([['system', Monitor, 'System'], ['dark', Moon, 'Dark'], ['light', Sun, 'Light']] as const).map(([v, Icon, label]) => (
                <button
                  key={v}
                  onClick={() => {
                    setTheme(v);
                    setThemeState(v);
                  }}
                  aria-pressed={theme === v}
                  className={`flex flex-1 items-center justify-center gap-1 rounded-lg border px-2 py-1 text-xs ${theme === v ? 'border-cyan/60 bg-cyan-dim text-cyan' : 'border-line text-soft hover:bg-raised'}`}
                >
                  <Icon className="size-3" /> {label}
                </button>
              ))}
            </div>
          </div>
          <button
            onClick={async () => {
              await repo.signOut();
              await refreshUser();
              navigate('/');
            }}
            className="mt-1 flex w-full items-center gap-2 rounded-lg border-t border-line px-2 py-2 text-left text-sm text-soft hover:bg-raised"
          >
            <LogOut className="size-3.5" /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}
