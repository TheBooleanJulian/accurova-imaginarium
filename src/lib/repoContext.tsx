import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Profile, ProjectBundle } from '@/core/types';
import type { Repository } from '@/data/repository';
import { errMsg } from './cn';

interface RepoCtx {
  repo: Repository;
  user: Profile | null;
  userLoaded: boolean;
  refreshUser: () => Promise<void>;
}

const Ctx = createContext<RepoCtx | null>(null);

export function RepoProvider({ repo, children }: { repo: Repository; children: ReactNode }) {
  const [user, setUser] = useState<Profile | null>(null);
  const [userLoaded, setLoaded] = useState(false);
  const refreshUser = useCallback(async () => {
    setUser(await repo.currentUser().catch(() => null));
    setLoaded(true);
  }, [repo]);
  useEffect(() => {
    void refreshUser();
  }, [refreshUser]);
  return <Ctx.Provider value={{ repo, user, userLoaded, refreshUser }}>{children}</Ctx.Provider>;
}

export function useRepo(): RepoCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('RepoProvider missing');
  return c;
}

/** Loads a project bundle and keeps it live via repository events (Realtime / BroadcastChannel). */
export function useProjectBundle(projectId: string) {
  const { repo } = useRepo();
  const [bundle, setBundle] = useState<ProjectBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const b = await repo.loadProject(projectId);
      if (mine === seq.current) {
        setBundle(b);
        setError(null);
      }
    } catch (e) {
      if (mine === seq.current) setError(errMsg(e));
    }
  }, [repo, projectId]);

  useEffect(() => {
    setBundle(null);
    void reload();
    const unsub = repo.subscribe(projectId, () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void reload(), 120);
    });
    return () => {
      unsub();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [repo, projectId, reload]);

  return { bundle, error, reload };
}
