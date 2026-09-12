import { BadRequestException } from '@nestjs/common';
import type { RoleCode } from '@dukanos/shared-types';
export const ROLE_CODES: readonly RoleCode[] = [
  'OWNER',
  'MANAGER',
  'CASHIER',
  'KITCHEN',
  'DISPATCH',
];
export function validateRoles(
  roles: readonly string[],
): asserts roles is RoleCode[] {
  const unique = new Set(roles);
  if (
    !roles.length ||
    unique.size !== roles.length ||
    roles.some((role) => !ROLE_CODES.includes(role as RoleCode)) ||
    (roles.some((role) => role === 'OWNER' || role === 'MANAGER') &&
      roles.length !== 1)
  ) {
    throw new BadRequestException({
      code: 'INVALID_ROLE_COMBINATION',
      message: 'Assign one privileged role OR one or more operational roles.',
    });
  }
}
