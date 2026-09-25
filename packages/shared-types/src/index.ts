/** Public API contracts only; never export persistence models or secrets. */
export interface HealthResponse {
  status: 'ok';
  service: 'dukanos-api';
}
export interface ApiError {
  code: string;
  message: string;
}
/** Decimal currency values cross JSON boundaries as strings. */
export type MoneyAmount = string;

export type RoleCode = 'OWNER' | 'MANAGER' | 'CASHIER' | 'KITCHEN' | 'DISPATCH';
export type PermissionCode =
  | 'bills.reminders.read'
  | 'bills.reminders.manage'
  | 'kitchen.timers.read'
  | 'kitchen.timers.manage'
  | 'orders.create'
  | 'orders.read'
  | 'bills.read'
  | 'bills.manage'
  | 'payments.read'
  | 'payments.collect'
  | 'kitchen.read'
  | 'kitchen.update'
  | 'dispatch.read'
  | 'dispatch.complete'
  | 'users.manage'
  | 'users.password.reset'
  | 'menu.availability.manage'
  | 'menu.manage'
  | 'menu.read'
  | 'reports.read'
  | 'payments.refund'
  | 'orders.cancel'
  | 'orders.prioritize'
  | 'credit.adjust';
export interface AuthenticatedUser {
  id: string;
  username: string;
  name: string;
  roles: RoleCode[];
  permissions: PermissionCode[];
}
export interface StaffUser extends AuthenticatedUser {
  active: boolean;
  version: number;
}

export interface PasswordResetTarget {
  id: string;
  username: string;
  name: string;
  roles: RoleCode[];
  active: boolean;
  version: number;
}

export type * from './menu';
export type * from './orders';

export type * from './kitchen';

export type * from './dispatch';

export type * from './bills';

export type * from './alerts';
