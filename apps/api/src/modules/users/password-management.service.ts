import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  AuthenticatedUser,
  PasswordResetTarget,
  StaffUser,
} from '@dukanos/shared-types';
import { DatabaseService } from '../../database/database.service';
import { hashPassword, verifyPassword } from '../auth/password';
import { USER_SELECT } from './users.service';
import {
  canResetPassword,
  validateNewPassword,
  validatePasswordReason,
} from './password-policy';
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
interface CredentialRow {
  id: string;
  password_hash: string;
  version: number;
  active: boolean;
}
@Injectable()
export class PasswordManagementService {
  constructor(private readonly db: DatabaseService) {}
  async resetTargets(actor: AuthenticatedUser): Promise<PasswordResetTarget[]> {
    if (!actor.permissions.includes('users.password.reset'))
      throw new ForbiddenException({
        code: 'PERMISSION_DENIED',
        message: 'Password reset permission is required.',
      });
    const users = (
      await this.db.query<StaffUser>(USER_SELECT + ' ORDER BY u.username')
    ).rows;
    return users
      .filter((user) => canResetPassword(actor, user))
      .map(({ id, username, name, roles, active, version }) => ({
        id,
        username,
        name,
        roles,
        active,
        version,
      }));
  }
  private async lockUsers(client: PoolClient, ids: string[]) {
    await client.query('SELECT pg_advisory_xact_lock(742019322)');
    await client.query(
      'SELECT id FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
      [ids],
    );
  }
  private async actor(
    client: PoolClient,
    id: string,
    sessionHash: string,
  ): Promise<StaffUser> {
    const user = (
      await client.query<StaffUser>(USER_SELECT + ' WHERE u.id=$1', [id])
    ).rows[0];
    const session = await client.query(
      'SELECT 1 FROM auth_sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>clock_timestamp()',
      [sessionHash, id],
    );
    if (!user?.active || !session.rowCount)
      throw new UnauthorizedException({
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Please sign in again.',
      });
    return user;
  }
  private async replace(
    client: PoolClient,
    target: { id: string; username: string },
    passwordHash: string,
    actorId: string | null,
    action: 'PASSWORD_CHANGED' | 'PASSWORD_RESET' | 'OWNER_RECOVERED',
    reason: string,
  ) {
    await client.query(
      'UPDATE users SET password_hash=$2,version=version+1 WHERE id=$1',
      [target.id, passwordHash],
    );
    await client.query('DELETE FROM auth_sessions WHERE user_id=$1', [
      target.id,
    ]);
    // Recovery also removes the account's sign-in lockout; IP limits remain intact.
    await client.query('DELETE FROM login_attempts WHERE key=ANY($1::text[])', [
      [
        digest(`user:${target.username}`),
        digest(`password-change:${target.id}`),
      ],
    ]);
    await client.query(
      'INSERT INTO user_audit(actor_id,target_id,action,reason,new_value) VALUES ($1,$2,$3,$4,$5)',
      [
        actorId,
        target.id,
        action,
        reason,
        JSON.stringify({ passwordChanged: true, sessionsRevoked: true }),
      ],
    );
  }
  private async limitChanges(id: string) {
    const row = (
      await this.db.query<{ attempts: number }>(
        `INSERT INTO login_attempts(key,attempts) VALUES ($1,1)
   ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN login_attempts.window_start < now()-interval '15 minutes' THEN 1 ELSE login_attempts.attempts+1 END,
   window_start=CASE WHEN login_attempts.window_start < now()-interval '15 minutes' THEN now() ELSE login_attempts.window_start END RETURNING attempts`,
        [digest(`password-change:${id}`)],
      )
    ).rows[0]!;
    if (row.attempts > 10)
      throw new HttpException(
        {
          code: 'PASSWORD_CHANGE_RATE_LIMITED',
          message: 'Too many password attempts. Try again after 15 minutes.',
        },
        429,
      );
  }
  async changeOwn(
    id: string,
    sessionHash: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    validateNewPassword(newPassword);
    if (
      typeof currentPassword !== 'string' ||
      !currentPassword.length ||
      currentPassword.length > 128
    )
      throw new BadRequestException({
        code: 'CURRENT_PASSWORD_REQUIRED',
        message: 'Enter your current password.',
      });
    await this.limitChanges(id);
    const record = (
      await this.db.query<CredentialRow>(
        'SELECT id,password_hash,version,active FROM users WHERE id=$1',
        [id],
      )
    ).rows[0];
    if (!record?.active)
      throw new UnauthorizedException({
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Please sign in again.',
      });
    if (!(await verifyPassword(currentPassword, record.password_hash)))
      throw new BadRequestException({
        code: 'CURRENT_PASSWORD_INCORRECT',
        message: 'The current password is incorrect.',
      });
    const passwordHash = await hashPassword(newPassword);
    await this.db.transaction(async (client) => {
      await this.lockUsers(client, [id]);
      const actor = await this.actor(client, id, sessionHash);
      if (actor.version !== record.version)
        throw new ConflictException({
          code: 'PASSWORD_CHANGE_CONFLICT',
          message: 'Your account changed. Sign in again and retry.',
        });
      await this.replace(
        client,
        actor,
        passwordHash,
        id,
        'PASSWORD_CHANGED',
        'Staff changed their own password',
      );
    });
  }
  async resetStaff(
    actorId: string,
    sessionHash: string,
    targetId: string,
    input: { newPassword: string; version: number; reason: string },
  ): Promise<void> {
    validateNewPassword(input.newPassword);
    validatePasswordReason(input.reason);
    const passwordHash = await hashPassword(input.newPassword);
    await this.db.transaction(async (client) => {
      await this.lockUsers(client, [actorId, targetId]);
      const actor = await this.actor(client, actorId, sessionHash);
      const target = (
        await client.query<StaffUser>(USER_SELECT + ' WHERE u.id=$1', [
          targetId,
        ])
      ).rows[0];
      if (!target)
        throw new NotFoundException({
          code: 'USER_NOT_FOUND',
          message: 'Staff member was not found.',
        });
      if (!canResetPassword(actor, target))
        throw new ForbiddenException({
          code: 'PASSWORD_RESET_FORBIDDEN',
          message:
            'You cannot reset this account. Use Change Password for your own account.',
        });
      if (target.version !== input.version)
        throw new ConflictException({
          code: 'USER_VERSION_CONFLICT',
          message:
            'The staff account changed. Refresh the staff list and try again.',
        });
      await this.replace(
        client,
        target,
        passwordHash,
        actor.id,
        'PASSWORD_RESET',
        input.reason.trim(),
      );
    });
  }
  // CLI-only recovery. No controller calls this method.
  async recoverOwner(
    username: string,
    newPassword: string,
    reason: string,
  ): Promise<void> {
    validateNewPassword(newPassword);
    validatePasswordReason(reason);
    if (
      typeof username !== 'string' ||
      !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username.trim().toLowerCase())
    )
      throw new BadRequestException({
        code: 'INVALID_USERNAME',
        message: 'Provide the exact owner username.',
      });
    const normalized = username.trim().toLowerCase();
    const passwordHash = await hashPassword(newPassword);
    await this.db.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(742019322)');
      const owner = (
        await client.query<StaffUser>(
          USER_SELECT + ' WHERE u.username=$1 FOR UPDATE OF u',
          [normalized],
        )
      ).rows[0];
      if (!owner || owner.roles.length !== 1 || owner.roles[0] !== 'OWNER')
        throw new NotFoundException({
          code: 'OWNER_NOT_FOUND',
          message:
            'No OWNER account matches that username. No account was changed.',
        });
      if (!owner.active)
        throw new ConflictException({
          code: 'OWNER_INACTIVE',
          message:
            'This owner is inactive. Recovery does not change account activation.',
        });
      await this.replace(
        client,
        owner,
        passwordHash,
        null,
        'OWNER_RECOVERED',
        reason.trim(),
      );
    });
  }
}
