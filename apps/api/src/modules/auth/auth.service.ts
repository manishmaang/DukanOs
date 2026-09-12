import { createHash, randomBytes } from 'node:crypto';
import {
  HttpException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuthenticatedUser } from '@dukanos/shared-types';
import { DatabaseService } from '../../database/database.service';
import { UsersService } from '../users/users.service';
import { DUMMY_HASH, verifyPassword } from './password';
export const tokenHash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
@Injectable()
export class AuthService {
  constructor(
    private readonly db: DatabaseService,
    private readonly users: UsersService,
  ) {}
  async login(
    username: string,
    password: string,
    ip: string,
    oldToken?: string,
  ) {
    const normalized = username.trim().toLowerCase();
    // Atomic counters persist across process restarts; both successful and failed attempts count.
    for (const [key, limit] of [
      [`user:${normalized}`, 10],
      [`ip:${ip}`, 60],
    ] as const) {
      const row = (
        await this.db.query<{ attempts: number }>(
          `INSERT INTO login_attempts(key,attempts) VALUES ($1,1)
    ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN login_attempts.window_start < now()-interval '15 minutes' THEN 1 ELSE login_attempts.attempts+1 END,
    window_start=CASE WHEN login_attempts.window_start < now()-interval '15 minutes' THEN now() ELSE login_attempts.window_start END RETURNING attempts`,
          [tokenHash(key)],
        )
      ).rows[0]!;
      if (row.attempts > limit)
        throw new HttpException(
          {
            code: 'LOGIN_RATE_LIMITED',
            message: 'Too many sign-in attempts. Try again after 15 minutes.',
          },
          429,
        );
    }
    await this.db.query(
      "DELETE FROM login_attempts WHERE window_start < now()-interval '1 day'",
    );
    const record = (
      await this.db.query<{
        id: string;
        password_hash: string;
        active: boolean;
        version: number;
      }>(
        'SELECT id,password_hash,active,version FROM users WHERE username=$1',
        [normalized],
      )
    ).rows[0];
    const valid = await verifyPassword(
      password,
      record?.password_hash ?? DUMMY_HASH,
    );
    if (!valid || !record?.active)
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid username or password.',
      });
    const token = randomBytes(32).toString('hex');
    await this.db.transaction(async (client) => {
      const current = (
        await client.query<{ active: boolean; version: number }>(
          'SELECT active,version FROM users WHERE id=$1 FOR UPDATE',
          [record.id],
        )
      ).rows[0];
      if (!current?.active || current.version !== record.version)
        throw new UnauthorizedException({
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid username or password.',
        });
      if (oldToken)
        await client.query('DELETE FROM auth_sessions WHERE token_hash=$1', [
          tokenHash(oldToken),
        ]);
      await client.query('DELETE FROM auth_sessions WHERE expires_at<=now()');
      await client.query(
        "INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES ($1,$2,now()+interval '12 hours')",
        [tokenHash(token), record.id],
      );
    });
    const user = await this.users.context(record.id);
    return { token, user };
  }
  async authenticate(token: string): Promise<AuthenticatedUser> {
    if (!/^[a-f0-9]{64}$/.test(token))
      throw new UnauthorizedException({
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Please sign in.',
      });
    // One SQL statement gives a coherent view of session, status, roles and permissions.
    const user = (
      await this.db.query<AuthenticatedUser>(
        `SELECT u.id,u.name,u.username,
   ARRAY(SELECT role_code FROM user_roles WHERE user_id=u.id ORDER BY role_code) AS roles,
   ARRAY(SELECT DISTINCT rp.permission_code FROM user_roles ur JOIN role_permissions rp ON rp.role_code=ur.role_code WHERE ur.user_id=u.id ORDER BY rp.permission_code) AS permissions
   FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active`,
        [tokenHash(token)],
      )
    ).rows[0];
    if (!user)
      throw new UnauthorizedException({
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Please sign in.',
      });
    return user;
  }
  async logout(hash: string) {
    await this.db.query('DELETE FROM auth_sessions WHERE token_hash=$1', [
      hash,
    ]);
  }
}
