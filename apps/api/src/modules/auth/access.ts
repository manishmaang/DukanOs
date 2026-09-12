import { SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedUser, PermissionCode } from '@dukanos/shared-types';
export const Public = () => SetMetadata('public', true);
export const RequirePermissions = (...permissions: PermissionCode[]) =>
  SetMetadata('permissions', permissions);
export interface AuthRequest extends Request {
  user: AuthenticatedUser;
  sessionHash: string;
}
