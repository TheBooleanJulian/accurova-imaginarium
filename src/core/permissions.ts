import type { Role } from './types';

/**
 * Role → capability matrix. The UI and the local backend use this directly; the
 * Supabase RLS policies in supabase/migrations implement the same matrix in SQL.
 */
export type Action =
  | 'project.read'
  | 'project.update'
  | 'project.delete'
  | 'graph.edit'
  | 'node.run'
  | 'job.read'
  | 'job.cancel'
  | 'asset.read'
  | 'asset.upload'
  | 'comment.create'
  | 'comment.resolve'
  | 'approval.create'
  | 'member.manage'
  | 'export.create';

const MATRIX: Record<Role, Action[]> = {
  owner: [
    'project.read', 'project.update', 'project.delete', 'graph.edit', 'node.run', 'job.read', 'job.cancel', 'asset.read',
    'asset.upload', 'comment.create', 'comment.resolve', 'approval.create', 'member.manage', 'export.create',
  ],
  editor: [
    'project.read', 'project.update', 'graph.edit', 'node.run', 'job.read', 'job.cancel', 'asset.read', 'asset.upload',
    'comment.create', 'comment.resolve', 'approval.create', 'export.create',
  ],
  reviewer: ['project.read', 'asset.read', 'comment.create', 'approval.create'],
  viewer: ['project.read', 'asset.read'],
};

export function can(role: Role | null | undefined, action: Action): boolean {
  return !!role && MATRIX[role].includes(action);
}

export class PermissionError extends Error {
  constructor(action: Action) {
    super(`You don't have permission to do that (${action}).`);
    this.name = 'PermissionError';
  }
}

export function assertCan(role: Role | null | undefined, action: Action): void {
  if (!can(role, action)) throw new PermissionError(action);
}

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  editor: 'Editor',
  reviewer: 'Client reviewer',
  viewer: 'Viewer',
};
