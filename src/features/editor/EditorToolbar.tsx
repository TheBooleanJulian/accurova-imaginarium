import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, CloudOff, Eye, FileDown, Loader2, Lock, Redo2, Share2, Undo2 } from 'lucide-react';
import { can, ROLE_LABELS } from '@/core/permissions';
import { Badge, Button, Wordmark, toast } from '@/components/ui';
import { useRepo } from '@/lib/repoContext';
import { navigate } from '@/lib/router';
import { cn, errMsg } from '@/lib/cn';
import { UserMenu } from '@/features/auth/UserMenu';
import { ShareDialog } from '@/features/share/ShareDialog';
import { ExportDialog } from '@/features/export/ExportDialog';
import { useEditor } from './editorContext';
import type { SaveState } from './useGraphEditor';

const SAVE_UI: Record<SaveState, { label: string; cls: string; icon: ReactNode }> = {
  saved: { label: 'Saved', cls: 'text-mute', icon: <Check className="size-3.5" /> },
  dirty: { label: 'Unsaved', cls: 'text-soft', icon: <span className="size-1.5 rounded-full bg-gold" /> },
  saving: { label: 'Saving…', cls: 'text-soft', icon: <Loader2 className="size-3.5 animate-spin" /> },
  conflict: { label: 'Conflict', cls: 'text-warn', icon: <AlertTriangle className="size-3.5" /> },
  error: { label: 'Not saved', cls: 'text-err', icon: <CloudOff className="size-3.5" /> },
  readonly: { label: 'Read-only', cls: 'text-mute', icon: <Lock className="size-3.5" /> },
};

export function EditorToolbar() {
  const { repo } = useRepo();
  const { bundle, editor, canEdit } = useEditor();
  const [name, setName] = useState(bundle.project.name);
  const [share, setShare] = useState(false);
  const [exporting, setExporting] = useState(false);
  const save = SAVE_UI[editor.saveState];

  useEffect(() => setName(bundle.project.name), [bundle.project.name]);

  const rename = async () => {
    const next = name.trim();
    if (!next || next === bundle.project.name) return setName(bundle.project.name);
    try {
      await repo.updateProject(bundle.project.id, { name: next });
    } catch (e) {
      toast(errMsg(e), 'err');
      setName(bundle.project.name);
    }
  };

  return (
    <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-line bg-ink px-2 sm:px-3">
      <button onClick={() => navigate('/')} className="rounded-lg p-1 hover:bg-raised" title="All projects" aria-label="All projects">
        <Wordmark compact />
      </button>
      <div className="mx-1 h-6 w-px bg-line" />
      <div className="min-w-0">
        <input
          value={name}
          disabled={!can(bundle.myRole, 'project.update')}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => void rename()}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          aria-label="Project name"
          className="w-[min(36vw,320px)] truncate rounded-md bg-transparent px-1.5 py-0.5 text-[14px] font-semibold outline-none hover:bg-raised focus:bg-raised focus:ring-1 focus:ring-teal/40 disabled:hover:bg-transparent"
        />
        <div className="truncate px-1.5 font-mono text-[10px] uppercase tracking-wider text-mute">
          {bundle.project.client || 'No client'} · {ROLE_LABELS[bundle.myRole]}
        </div>
      </div>

      <div
        className={cn('ml-2 hidden items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-wider sm:flex', save.cls)}
        title={editor.saveError ?? undefined}
        data-testid="save-state"
      >
        {save.icon}
        {save.label}
      </div>

      <div className="ml-2 flex items-center">
        <Button variant="ghost" size="icon" onClick={editor.undo} disabled={!canEdit || !editor.canUndo} title="Undo (Ctrl/⌘ Z)" aria-label="Undo">
          <Undo2 className="size-4" />
        </Button>
        <Button variant="ghost" size="icon" onClick={editor.redo} disabled={!canEdit || !editor.canRedo} title="Redo (Ctrl/⌘ Shift Z)" aria-label="Redo">
          <Redo2 className="size-4" />
        </Button>
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        <Badge tone={repo.providerLabel.toLowerCase().includes('mock') ? 'gold' : 'teal'} className="hidden md:inline-flex">
          {repo.providerLabel}
        </Badge>
        <Button variant="ghost" size="sm" onClick={() => navigate(`/p/${bundle.project.id}/review`)} title="See what your client sees">
          <Eye className="size-3.5" /> <span className="hidden sm:inline">Client view</span>
        </Button>
        {can(bundle.myRole, 'member.manage') && (
          <Button variant="outline" size="sm" onClick={() => setShare(true)}>
            <Share2 className="size-3.5" /> <span className="hidden sm:inline">Share</span>
          </Button>
        )}
        {can(bundle.myRole, 'export.create') && (
          <Button variant="primary" size="sm" onClick={() => setExporting(true)}>
            <FileDown className="size-3.5" /> <span className="hidden sm:inline">Export</span>
          </Button>
        )}
        <UserMenu />
      </div>
      <ShareDialog open={share} onClose={() => setShare(false)} bundle={bundle} />
      <ExportDialog open={exporting} onClose={() => setExporting(false)} />
    </header>
  );
}
