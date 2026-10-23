import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { Project, ProjectStatus, Role } from '@/core/types';
import { can } from '@/core/permissions';
import { Button, Field, Input, Modal, Select, toast } from '@/components/ui';
import { useRepo } from '@/lib/repoContext';
import { navigate } from '@/lib/router';
import { errMsg } from '@/lib/cn';

const STATUSES: [ProjectStatus, string][] = [
  ['draft', 'Draft: in preproduction'],
  ['in_review', 'In review with the client'],
  ['approved', 'Approved: ready to shoot'],
  ['archived', 'Archived'],
];

export function ProjectSettingsDialog({ open, onClose, project, role }: { open: boolean; onClose: () => void; project: Project; role: Role }) {
  const { repo } = useRepo();
  const [client, setClient] = useState(project.client);
  const [status, setStatus] = useState<ProjectStatus>(project.status);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setClient(project.client);
    setStatus(project.status);
    setConfirm('');
  }, [open, project.client, project.status]);

  const save = async () => {
    setBusy('save');
    try {
      await repo.updateProject(project.id, { client: client.trim(), status });
      toast('Project updated', 'ok');
      onClose();
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy('delete');
    try {
      await repo.deleteProject(project.id);
      toast('Project deleted, including its files.', 'ok');
      navigate('/');
    } catch (e) {
      toast(errMsg(e), 'err');
      setBusy(null);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Project settings">
      <div className="space-y-5">
        <Field label="Client">
          <Input value={client} onChange={(e) => setClient(e.target.value)} disabled={!can(role, 'project.update')} />
        </Field>
        <Field label="Status" hint="Shown on the projects page. Doesn't change permissions.">
          <Select value={status} onChange={(e) => setStatus(e.target.value as ProjectStatus)} disabled={!can(role, 'project.update')}>
            {STATUSES.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex justify-end">
          <Button variant="primary" loading={busy === 'save'} disabled={!can(role, 'project.update')} onClick={() => void save()}>
            Save
          </Button>
        </div>

        {can(role, 'project.delete') && (
          <div className="space-y-3 rounded-xl border border-err/30 bg-err/5 p-4">
            <div className="text-sm font-medium text-err">Delete project</div>
            <p className="text-[12px] leading-relaxed text-soft">
              Permanently deletes the graph, every uploaded and generated image, PDFs, comments and approval history. Clients lose access immediately. This can&apos;t be undone.
            </p>
            <Field label={`Type “${project.name}” to confirm`}>
              <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-label="Confirm project name" />
            </Field>
            <Button variant="danger" disabled={confirm.trim() !== project.name.trim()} loading={busy === 'delete'} onClick={() => void remove()}>
              <Trash2 className="size-3.5" /> Delete permanently
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}
