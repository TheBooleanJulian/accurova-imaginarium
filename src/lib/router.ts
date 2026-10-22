import { useEffect, useState } from 'react';

/** Tiny hash router: keeps deep links working on any static host (Vercel, Cloudflare Pages…). */
export function currentPath(): string {
  return window.location.hash.replace(/^#/, '') || '/';
}

export function navigate(path: string): void {
  if (currentPath() !== path) window.location.hash = path;
}

export function usePath(): string {
  const [path, setPath] = useState(currentPath);
  useEffect(() => {
    const on = () => setPath(currentPath());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return path;
}

export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('?')[0]!.split('/').filter(Boolean);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i]!.startsWith(':')) params[p[i]!.slice(1)] = decodeURIComponent(s[i]!);
    else if (p[i] !== s[i]) return null;
  }
  return params;
}

export function shareUrl(path: string): string {
  return `${window.location.origin}${window.location.pathname}#${path}`;
}
