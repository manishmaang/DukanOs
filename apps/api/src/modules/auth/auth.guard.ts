import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PermissionCode } from '@dukanos/shared-types';
import { AuthService, tokenHash } from './auth.service';
import type { AuthRequest } from './access';
export function sessionCookie(cookie: string | undefined): string {
  return (
    cookie
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('dukanos_session='))
      ?.slice('dukanos_session='.length) ?? ''
  );
}
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    context.switchToHttp().getResponse().setHeader('Cache-Control', 'no-store');
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      request.header('X-DukanOS-Request') !== '1'
    )
      throw new ForbiddenException({
        code: 'CSRF_CHECK_FAILED',
        message: 'This request must originate from the DukanOS application.',
      });
    if (
      this.reflector.getAllAndOverride<boolean>('public', [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;
    const token = sessionCookie(request.headers.cookie);
    request.user = await this.auth.authenticate(token);
    request.sessionHash = tokenHash(token);
    const required =
      this.reflector.getAllAndMerge<PermissionCode[]>('permissions', [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    if (
      !required.every((permission) =>
        request.user.permissions.includes(permission),
      )
    )
      throw new ForbiddenException({
        code: 'PERMISSION_DENIED',
        message: 'You do not have permission for this action.',
      });
    return true;
  }
}
