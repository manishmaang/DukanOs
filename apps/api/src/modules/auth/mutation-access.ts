import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { PermissionCode } from '@dukanos/shared-types';
import type { AuthRequest } from './access';
export async function authorizeMutation(
  c: PoolClient,
  actor: AuthRequest,
  capability: PermissionCode,
) {
  await c.query('SELECT pg_advisory_xact_lock(742019323)');
  await c.query('SELECT id FROM users WHERE id=$1 FOR SHARE', [actor.user.id]);
  const session = await c.query(
    'SELECT 1 FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND u.id=$2 AND u.active AND s.expires_at>clock_timestamp() FOR SHARE OF s',
    [actor.sessionHash, actor.user.id],
  );
  if (!session.rowCount)
    throw new UnauthorizedException({
      code: 'AUTHENTICATION_REQUIRED',
      message: 'Please sign in again.',
    });
  if (
    !(
      await c.query(
        'SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_code=ur.role_code WHERE ur.user_id=$1 AND rp.permission_code=$2',
        [actor.user.id, capability],
      )
    ).rowCount
  )
    throw new ForbiddenException({
      code: 'PERMISSION_DENIED',
      message: 'Permission is required.',
    });
}
