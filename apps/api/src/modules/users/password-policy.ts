import { BadRequestException } from '@nestjs/common';
import type { AuthenticatedUser, RoleCode } from '@dukanos/shared-types';
const operational: readonly RoleCode[] = ['CASHIER', 'KITCHEN', 'DISPATCH'];
export function canResetPassword(
  actor: AuthenticatedUser,
  target: { id: string; roles: RoleCode[] },
): boolean {
  if (
    actor.id === target.id ||
    !actor.permissions.includes('users.password.reset')
  )
    return false;
  const operationalTarget =
    target.roles.length > 0 &&
    target.roles.every((role) => operational.includes(role));
  if (actor.roles.length !== 1) return false;
  if (actor.roles[0] === 'OWNER')
    return (
      operationalTarget ||
      (target.roles.length === 1 && target.roles[0] === 'MANAGER')
    );
  return actor.roles[0] === 'MANAGER' && operationalTarget;
}
export function validateNewPassword(
  password: unknown,
): asserts password is string {
  if (
    typeof password !== 'string' ||
    password.length < 12 ||
    password.length > 128
  )
    throw new BadRequestException({
      code: 'INVALID_PASSWORD',
      message: 'The new password must contain 12–128 characters.',
    });
}
export function validatePasswordReason(
  reason: unknown,
): asserts reason is string {
  if (
    typeof reason !== 'string' ||
    !reason.trim() ||
    reason.trim().length > 500
  )
    throw new BadRequestException({
      code: 'REASON_REQUIRED',
      message: 'Provide a reason of 1–500 nonblank characters.',
    });
}
