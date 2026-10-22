import clsx, { type ClassValue } from 'clsx';

export const cn = (...v: ClassValue[]) => clsx(v);

export function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString('en-SG', { day: 'numeric', month: 'short' });
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function newKey(): string {
  return crypto.randomUUID();
}
