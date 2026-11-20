import { useState, type FormEvent } from 'react';
import { Check, Copy, Link2, Trash2, UserPlus } from 'lucide-react';
import type { Invitation, ProjectBundle, Role } from '@/core/types';
import { ROLE_LABELS } from '@/core/permissions';
import { Badge, Button, Field, Input, Modal, Select, toast } from '@/components/ui';
import { useRepo } from '@/lib/repoContext';
import { shareUrl } from '@/lib/router';
import { errMsg, timeAgo } from '@/lib/cn';

type InviteRole = Exclude<Role, 'owner'>;
const ROLE_HELP: Record<InviteRole, string> = {
  editor: 'Edits the graph, uploads, runs AI and exports.',
  reviewer: 'Your client: sees the moodboard, comments, approves or requests changes.',
  viewer: 'Read-only access to the moodboard.',
};

function CopyLink({ inv }: { inv: Invitation }) {
  const [copied, setCopied] = useState(false);
  const url = shareUrl(`/invite/${inv.token}`);
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          window.prompt('Copy this invitation link', url);
        }
      }}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {copied ? 'Copied' : 'Copy link'}
    </Button>
  );
}

export function ShareDialog({ open, onClose, bundle }: { open: boolean; onClose: () => void; bundle: ProjectBundle }) {
  const { repo, user } = useRepo();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InviteRole>('reviewer');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Invitation | null>(null);
  const pending = bundle.invitations.filter((i) => i.status === 'pending');

  const invite = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const inv = await repo.createInvitation(bundle.project.id, email, role);
      setCreated(inv);
      setEmail('');
      toast('Invitation created. Send the link to your client.', 'ok');
    } catch (err) {
      toast(errMsg(err), 'err');
    } finally {
      setBusy(false);
    }
  };

  const guard = (fn: () => Promise<void>) => () => void fn().catch((e) => toast(errMsg(e), 'err'));

  return (
    <Modal open={open} onClose={onClose} title="Share project" wide>
      <div className="space-y-6">
        <form onSubmit={invite} className="space-y-3 rounded-xl border border-line bg-ink p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <UserPlus className="size-4 text-cyan" /> Invite someone
          </div>
          <div className="grid gap-3 sm:grid-cols-[1fr_180px_auto] sm:items-end">
            <Field label="Email">
              <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="client@company.com" />
            </Field>
            <Field label="Role">
              <Select value={role} onChange={(e) => setRole(e.target.value as InviteRole)}>
                <option value="reviewer">Client reviewer</option>
                <option value="editor">Editor</option>
                <option value="viewer">Viewer</option>
              </Select>
            </Field>
            <Button variant="primary" type="submit" loading={busy}>
              Create invite
            </Button>
          </div>
          <p className="text-[11px] text-mute">{ROLE_HELP[role]} The link only works for this email address.</p>
          {created && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-cyan/30 bg-cyan-dim p-2.5 text-[12px]">
              <Link2 className="size-3.5 text-cyan" />
              <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{shareUrl(`/invite/${created.token}`)}</span>
              <CopyLink inv={created} />
            </div>
          )}
          {repo.authMode !== 'supabase' && (
            <p className="text-[11px] text-warn">
              {repo.mode === 'local'
                ? 'Demo mode: everyone shares this browser. Open the link, sign in as the invited email, and you’ll see exactly what your client sees.'
                : 'Dev sign-in: open the link in a private window and sign in as the invited email to see exactly what your client sees.'}
            </p>
          )}
        </form>

        <div className="space-y-2">
          <div className="label-mono">People with access · {bundle.members.length}</div>
          {bundle.members.map((m) => (
            <div key={m.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-line px-3 py-2">
              <div className="flex size-8 items-center justify-center rounded-full bg-raised text-[12px] font-semibold text-cyan">
                {(m.displayName ?? m.email ?? '?').slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">
                  {m.displayName ?? m.email} {m.userId === user?.id && <span className="text-mute">(you)</span>}
                </div>
                <div className="truncate font-mono text-[11px] text-mute">{m.email}</div>
              </div>
              {m.role === 'owner' ? (
                <Badge tone="cyan">Owner</Badge>
              ) : (
                <>
                  <Select
                    value={m.role}
                    className="h-8 w-40 text-[13px]"
                    onChange={(e) => guard(() => repo.updateMemberRole(m.id, e.target.value as InviteRole))()}
                    aria-label={`Role for ${m.email}`}
                  >
                    <option value="reviewer">Client reviewer</option>
                    <option value="editor">Editor</option>
                    <option value="viewer">Viewer</option>
                  </Select>
                  <Button size="icon" variant="ghost" className="hover:text-err" title="Remove access" aria-label={`Remove ${m.email}`} onClick={guard(() => repo.removeMember(m.id))}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </>
              )}
            </div>
          ))}
        </div>

        {pending.length > 0 && (
          <div className="space-y-2">
            <div className="label-mono">Pending invitations · {pending.length}</div>
            {pending.map((inv) => (
              <div key={inv.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-line px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{inv.email}</div>
                  <div className="font-mono text-[11px] text-mute">
                    {ROLE_LABELS[inv.role]} · invited {timeAgo(inv.createdAt)}
                  </div>
                </div>
                <CopyLink inv={inv} />
                <Button size="sm" variant="ghost" className="hover:text-err" onClick={guard(() => repo.revokeInvitation(inv.id))}>
                  Revoke
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
