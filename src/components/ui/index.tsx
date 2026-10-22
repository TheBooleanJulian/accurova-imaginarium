import {
  forwardRef,
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { Loader2, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { Asset } from '@/core/types';
import { useRepo } from '@/lib/repoContext';

type Variant = 'primary' | 'gold' | 'ghost' | 'outline' | 'danger' | 'subtle';

const variants: Record<Variant, string> = {
  primary: 'bg-teal text-void hover:bg-[#2be3d8] font-semibold',
  gold: 'bg-gold text-void hover:bg-[#ffd75e] font-semibold',
  ghost: 'text-soft hover:text-text hover:bg-raised',
  outline: 'border border-line-2 text-text hover:border-teal/60 hover:bg-raised',
  danger: 'border border-err/40 text-err hover:bg-err/10',
  subtle: 'bg-raised text-text hover:bg-line border border-line',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md' | 'icon';
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'subtle', size = 'md', loading, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-lg transition-colors disabled:opacity-40 disabled:pointer-events-none select-none',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal/60',
        size === 'sm' && 'h-7 px-2.5 text-xs',
        size === 'md' && 'h-9 px-3.5 text-sm',
        size === 'icon' && 'h-8 w-8',
        variants[variant],
        className,
      )}
      {...rest}
    >
      {loading && <Loader2 className="size-3.5 animate-spin" />}
      {children}
    </button>
  );
});

const field =
  'w-full rounded-lg border border-line bg-ink px-3 text-sm text-text placeholder:text-mute focus:outline-none focus:border-teal/70 focus:ring-2 focus:ring-teal/20 disabled:opacity-60';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...p }, ref) {
  return <input ref={ref} className={cn(field, 'h-9', className)} {...p} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...p }, ref) {
  return <textarea ref={ref} className={cn(field, 'py-2 leading-relaxed resize-y min-h-[72px]', className)} {...p} />;
});

export function Select({ className, children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(field, 'h-9 pr-8', className)} {...p}>
      {children}
    </select>
  );
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn('block space-y-1.5', className)}>
      <span className="label-mono">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-mute leading-snug">{hint}</span>}
    </label>
  );
}

export function Badge({ tone = 'mute', children, className }: { tone?: 'mute' | 'teal' | 'gold' | 'ok' | 'warn' | 'err'; children: ReactNode; className?: string }) {
  const tones = {
    mute: 'bg-raised text-soft border-line',
    teal: 'bg-teal-dim text-teal border-teal/25',
    gold: 'bg-gold-dim text-gold border-gold/25',
    ok: 'bg-ok/10 text-ok border-ok/25',
    warn: 'bg-warn/10 text-warn border-warn/25',
    err: 'bg-err/10 text-err border-err/25',
  };
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider whitespace-nowrap', tones[tone], className)}>
      {children}
    </span>
  );
}

export function Chip({ active, onClick, children, disabled }: { active: boolean; onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'rounded-full border px-2.5 py-1 text-xs transition-colors disabled:opacity-50',
        active ? 'border-teal/60 bg-teal-dim text-teal' : 'border-line text-soft hover:border-line-2 hover:text-text',
      )}
    >
      {children}
    </button>
  );
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-void/80 backdrop-blur-sm p-0 sm:p-6" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
        className={cn('w-full max-h-[92vh] overflow-auto rounded-t-2xl sm:rounded-2xl border border-line bg-panel shadow-2xl', wide ? 'sm:max-w-3xl' : 'sm:max-w-lg')}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-panel/95 px-5 py-3.5 backdrop-blur">
          <h2 className="text-base font-semibold">{title}</h2>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </Button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------- toasts

type Toast = { id: number; text: string; tone: 'ok' | 'err' | 'info' };
let toastId = 0;
const toastListeners = new Set<(t: Toast[]) => void>();
let toasts: Toast[] = [];

export function toast(text: string, tone: Toast['tone'] = 'info') {
  const t = { id: ++toastId, text, tone };
  toasts = [...toasts, t].slice(-4);
  toastListeners.forEach((l) => l(toasts));
  setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== t.id);
    toastListeners.forEach((l) => l(toasts));
  }, tone === 'err' ? 6500 : 3500);
}

export function Toaster() {
  const [list, setList] = useState<Toast[]>([]);
  useEffect(() => {
    toastListeners.add(setList);
    return () => void toastListeners.delete(setList);
  }, []);
  return createPortal(
    <div className="pointer-events-none fixed left-1/2 top-16 z-[60] flex -translate-x-1/2 flex-col items-center gap-2">
      {list.map((t) => (
        <div
          key={t.id}
          role="status"
          className={cn(
            'pointer-events-auto max-w-[90vw] rounded-lg border px-3.5 py-2 text-[13px] shadow-xl backdrop-blur',
            t.tone === 'err' && 'border-err/40 bg-[#2a1214]/95 text-[#ffd0d0]',
            t.tone === 'ok' && 'border-teal/40 bg-[#082420]/95 text-[#c9fffb]',
            t.tone === 'info' && 'border-line-2 bg-raised/95 text-text',
          )}
        >
          {t.text}
        </div>
      ))}
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------- assets

export function useAssetUrl(asset: Asset | undefined | null): string | null {
  const { repo } = useRepo();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    if (asset) repo.assetUrl(asset).then((u) => alive && setUrl(u)).catch(() => alive && setUrl(null));
    return () => {
      alive = false;
    };
  }, [repo, asset]);
  return url;
}

export function AssetImage({ asset, className, alt }: { asset: Asset | undefined | null; className?: string; alt?: string }) {
  const url = useAssetUrl(asset);
  if (!url) return <div className={cn('checker animate-pulse', className)} />;
  return <img src={url} alt={alt ?? asset?.label ?? ''} className={cn('object-cover', className)} draggable={false} />;
}

/** Fidelity label: makes it impossible to confuse an AI concept with a real photo. */
export function ProvenanceBadge({ asset }: { asset: Asset }) {
  if (asset.sourceType === 'upload') {
    return <Badge tone={asset.role === 'product' ? 'gold' : 'mute'}>{asset.role === 'product' ? 'Real product' : asset.role === 'brand' ? 'Brand asset' : 'Reference'}</Badge>;
  }
  if (asset.role === 'pose') return <Badge tone="teal">AI pose ref</Badge>;
  if (asset.role === 'edit') return <Badge tone="teal">AI edit v{asset.version}</Badge>;
  return <Badge tone="teal">AI concept</Badge>;
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-4 animate-spin text-teal', className)} />;
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line px-6 py-8 text-center">
      {icon && <div className="text-mute">{icon}</div>}
      <div className="text-sm font-medium text-soft">{title}</div>
      {children && <div className="text-xs text-mute max-w-xs">{children}</div>}
    </div>
  );
}

export function Wordmark({ compact }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5 select-none">
      <svg viewBox="0 0 64 64" className="size-7 shrink-0" aria-hidden>
        <rect width="64" height="64" rx="14" fill="#0E131B" stroke="#1D2632" />
        <circle cx="32" cy="32" r="16" fill="none" stroke="#00D4C8" strokeWidth="4" />
        <circle cx="32" cy="32" r="6" fill="#F5C842" />
      </svg>
      {!compact && (
        <div className="leading-none">
          <div className="text-[13px] font-semibold tracking-[0.18em]">ACCUROVA</div>
          <div className="mt-0.5 font-mono text-[9.5px] tracking-[0.22em] text-teal">IMAGINARIUM</div>
        </div>
      )}
    </div>
  );
}
