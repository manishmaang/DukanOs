import type { AuthenticatedUser, PermissionCode } from '@dukanos/shared-types';
export interface WorkspaceLink {
  path: string;
  label: string;
  permissions: PermissionCode[];
}
export const workspaces: WorkspaceLink[] = [
  { path: '/pos', label: 'POS', permissions: ['orders.create'] },
  { path: '/kitchen', label: 'Kitchen', permissions: ['kitchen.read'] },
  { path: '/dispatch', label: 'Dispatch', permissions: ['dispatch.read'] },
  {
    path: '/admin',
    label: 'Admin',
    permissions: [
      'users.manage',
      'users.password.reset',
      'menu.manage',
      'reports.read',
    ],
  },
];
export function allowedWorkspaces(user: AuthenticatedUser): WorkspaceLink[] {
  return workspaces.filter((workspace) =>
    workspace.permissions.some((permission) =>
      user.permissions.includes(permission),
    ),
  );
}
