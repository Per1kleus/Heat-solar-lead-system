/**
 * Role-based permissions. Enforced server-side on every route; the same matrix is
 * served to the client (GET /api/me) so the UI can hide what the user cannot do.
 */
export type Role = 'owner' | 'admin' | 'sales_manager' | 'salesperson' | 'technician';

export const PERMISSIONS = [
  'leads:read:own', 'leads:read:all', 'leads:write', 'leads:assign', 'leads:delete',
  'customers:read', 'customers:write',
  'projects:read', 'projects:write',
  'quotes:read:own', 'quotes:read:all', 'quotes:write', 'quotes:send',
  'tasks:read:own', 'tasks:read:all', 'tasks:write',
  'appointments:read', 'appointments:write',
  'surveys:read', 'surveys:write', 'surveys:complete',
  'documents:read', 'documents:write',
  'messages:read', 'messages:send',
  'analytics:view', 'analytics:revenue', 'analytics:team',
  'automation:read', 'automation:write',
  'settings:read', 'settings:write',
  'users:read', 'users:write',
  'integrations:read', 'integrations:write',
  'billing:read', 'billing:write',
  'audit:read',
  'data:export', 'data:import', 'data:erase',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const SALESPERSON: Permission[] = [
  'leads:read:own', 'leads:write',
  'customers:read', 'customers:write',
  'projects:read',
  'quotes:read:own', 'quotes:write', 'quotes:send',
  'tasks:read:own', 'tasks:write',
  'appointments:read', 'appointments:write',
  'surveys:read', 'surveys:write',
  'documents:read', 'documents:write',
  'messages:read', 'messages:send',
  'analytics:view',
  'settings:read',
];

const SALES_MANAGER: Permission[] = [
  ...SALESPERSON,
  'leads:read:all', 'leads:assign',
  'quotes:read:all',
  'tasks:read:all',
  'analytics:team', 'analytics:revenue',
  'automation:read', 'automation:write',
  'users:read',
  'data:export',
  'projects:write',
  'surveys:complete',
];

const TECHNICIAN: Permission[] = [
  'leads:read:own',
  'customers:read',
  'projects:read', 'projects:write',
  'appointments:read', 'appointments:write',
  'surveys:read', 'surveys:write', 'surveys:complete',
  'documents:read', 'documents:write',
  'tasks:read:own', 'tasks:write',
];

const ADMIN: Permission[] = [...PERMISSIONS];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  owner: ADMIN,
  admin: ADMIN,
  sales_manager: [...new Set(SALES_MANAGER)],
  salesperson: [...new Set(SALESPERSON)],
  technician: [...new Set(TECHNICIAN)],
};

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Administrator',
  sales_manager: 'Sales Manager',
  salesperson: 'Salesperson',
  technician: 'Technician / Installer',
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

/** True when the role may see records that belong to other users. */
export function seesEverything(role: Role): boolean {
  return can(role, 'leads:read:all');
}
