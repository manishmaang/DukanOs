import { validateNewPassword } from './password-policy';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PoolClient } from 'pg';
import type {
  AuthenticatedUser,
  StaffUser,
  RoleCode,
} from '@dukanos/shared-types';
import { DatabaseService } from '../../database/database.service';
import { hashPassword } from '../auth/password';
import { validateRoles } from './role-policy';

export const USER_SELECT = `SELECT u.id, u.username, u.name, u.active, u.version,
 ARRAY(SELECT role_code FROM user_roles WHERE user_id=u.id ORDER BY role_code) AS roles,
 ARRAY(SELECT DISTINCT rp.permission_code FROM user_roles ur JOIN role_permissions rp ON rp.role_code=ur.role_code WHERE ur.user_id=u.id ORDER BY rp.permission_code) AS permissions
 FROM users u`;
@Injectable()
export class UsersService {
  constructor(private readonly db: DatabaseService) {}
  async context(id: string): Promise<StaffUser | undefined> {
    return (
      await this.db.query<StaffUser>(USER_SELECT + ' WHERE u.id=$1', [id])
    ).rows[0];
  }
  async list(): Promise<StaffUser[]> {
    return (
      await this.db.query<StaffUser>(USER_SELECT + ' ORDER BY u.username')
    ).rows;
  }
  private async authorize(
    client: PoolClient,
    actor: AuthenticatedUser,
    sessionHash?: string,
  ) {
    await client.query('SELECT id FROM users WHERE id=$1 FOR SHARE', [
      actor.id,
    ]);
    if (
      sessionHash !== undefined &&
      !(
        await client.query(
          'SELECT 1 FROM auth_sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>clock_timestamp()',
          [sessionHash, actor.id],
        )
      ).rowCount
    )
      throw new UnauthorizedException({
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Please sign in again.',
      });
    // Recheck authority inside the serialized mutation, not only in the HTTP guard.
    const allowed = await client.query(
      `SELECT 1 FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN role_permissions rp ON rp.role_code=ur.role_code WHERE u.id=$1 AND u.active AND rp.permission_code='users.manage'`,
      [actor.id],
    );
    if (!allowed.rowCount)
      throw new ForbiddenException({
        code: 'PERMISSION_DENIED',
        message: 'Staff management permission is required.',
      });
  }
  private async assign(
    client: PoolClient,
    id: string,
    roles: readonly RoleCode[],
  ) {
    await client.query('DELETE FROM user_roles WHERE user_id=$1', [id]);
    for (const role of roles)
      await client.query(
        'INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)',
        [id, role],
      );
  }
  async create(
    input: {
      username: string;
      name: string;
      password: string;
      roles: string[];
    },
    actor?: AuthenticatedUser,
    sessionHash?: string,
  ): Promise<StaffUser> {
    validateRoles(input.roles);
    validateNewPassword(input.password);
    const username = input.username.trim().toLowerCase();
    const name = input.name.trim();
    if (
      !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username) ||
      !name ||
      name.length > 100
    )
      throw new BadRequestException({
        code: 'INVALID_USER',
        message:
          'Use a valid username, name, and a password of 12–128 characters.',
      });
    const passwordHash = await hashPassword(input.password);
    try {
      return await this.db.transaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(742019322)');
        if (actor) await this.authorize(client, actor, sessionHash);
        else {
          if (
            input.roles.length !== 1 ||
            input.roles[0] !== 'OWNER' ||
            (await client.query('SELECT 1 FROM users LIMIT 1')).rowCount
          )
            throw new ConflictException({
              code: 'BOOTSTRAP_DISABLED',
              message:
                'Initial owner creation is only allowed in an empty staff database.',
            });
        }
        const id = (
          await client.query<{ id: string }>(
            'INSERT INTO users(username,name,password_hash) VALUES ($1,$2,$3) RETURNING id',
            [username, name, passwordHash],
          )
        ).rows[0]!.id;
        await this.assign(client, id, input.roles as RoleCode[]);
        const user = (
          await client.query<StaffUser>(USER_SELECT + ' WHERE u.id=$1', [id])
        ).rows[0]!;
        await client.query(
          'INSERT INTO user_audit(actor_id,target_id,action,reason,new_value) VALUES ($1,$2,$3,$4,$5)',
          [
            actor?.id ?? null,
            id,
            actor ? 'CREATED' : 'BOOTSTRAP',
            actor ? 'Staff account created' : 'Initial owner setup',
            JSON.stringify({ username, name, roles: user.roles, active: true }),
          ],
        );
        return user;
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new ConflictException({
          code: 'USERNAME_TAKEN',
          message: 'This username is already in use.',
        });
      throw error;
    }
  }
  async updateAccess(
    id: string,
    input: {
      roles: string[];
      active: boolean;
      version: number;
      reason: string;
    },
    actor: AuthenticatedUser,
    sessionHash?: string,
  ): Promise<StaffUser> {
    validateRoles(input.roles);
    if (!input.reason.trim())
      throw new BadRequestException({
        code: 'REASON_REQUIRED',
        message: 'An access-change reason is required.',
      });
    return this.db.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(742019322)');
      await this.authorize(client, actor, sessionHash);
      const current = (
        await client.query<StaffUser>(
          USER_SELECT + ' WHERE u.id=$1 FOR UPDATE OF u',
          [id],
        )
      ).rows[0];
      if (!current)
        throw new NotFoundException({
          code: 'USER_NOT_FOUND',
          message: 'Staff member was not found.',
        });
      if (current.version !== input.version)
        throw new ConflictException({
          code: 'USER_VERSION_CONFLICT',
          message: 'Staff access changed. Reload and try again.',
        });
      if (
        current.active &&
        current.roles.includes('OWNER') &&
        (!input.active || !input.roles.includes('OWNER'))
      ) {
        const others = await client.query(
          `SELECT 1 FROM users u JOIN user_roles ur ON ur.user_id=u.id WHERE u.active AND ur.role_code='OWNER' AND u.id<>$1`,
          [id],
        );
        if (!others.rowCount)
          throw new ConflictException({
            code: 'LAST_OWNER_REQUIRED',
            message: 'At least one active owner must remain.',
          });
      }
      await client.query(
        'UPDATE users SET active=$2,version=version+1 WHERE id=$1',
        [id, input.active],
      );
      await this.assign(client, id, input.roles as RoleCode[]);
      await client.query('DELETE FROM auth_sessions WHERE user_id=$1', [id]);
      const updated = (
        await client.query<StaffUser>(USER_SELECT + ' WHERE u.id=$1', [id])
      ).rows[0]!;
      await client.query(
        'INSERT INTO user_audit(actor_id,target_id,action,reason,old_value,new_value) VALUES ($1,$2,$3,$4,$5,$6)',
        [
          actor.id,
          id,
          'ACCESS_CHANGED',
          input.reason.trim(),
          JSON.stringify({ roles: current.roles, active: current.active }),
          JSON.stringify({ roles: updated.roles, active: updated.active }),
        ],
      );
      return updated;
    });
  }
}
