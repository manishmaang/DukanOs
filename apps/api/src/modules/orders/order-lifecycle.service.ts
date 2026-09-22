import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { OrderTransitionResult, OrderStatus } from '@dukanos/shared-types';
import { DatabaseService } from '../../database/database.service';
import type { AuthRequest } from '../auth/access';
import { canTransition } from './order-policy';
@Injectable()
export class OrderLifecycleService {
  constructor(private readonly db: DatabaseService) {}
  transition(
    id: string,
    to: 'PREPARING' | 'READY' | 'COMPLETED',
    actor: AuthRequest,
  ): Promise<OrderTransitionResult> {
    return this.db.transaction(async (c) => {
      // Same lock order as confirmation: shared restaurant writes, user, session, order.
      await c.query('SELECT pg_advisory_xact_lock(742019323)');
      await c.query('SELECT id FROM users WHERE id=$1 FOR SHARE', [
        actor.user.id,
      ]);
      const session = await c.query(
        'SELECT 1 FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND u.id=$2 AND u.active AND s.expires_at>clock_timestamp() FOR SHARE OF s',
        [actor.sessionHash, actor.user.id],
      );
      if (!session.rowCount)
        throw new UnauthorizedException({
          code: 'AUTHENTICATION_REQUIRED',
          message: 'Please sign in again.',
        });
      const permission = await c.query(
        'SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_code=ur.role_code WHERE ur.user_id=$1 AND rp.permission_code=$2',
        [
          actor.user.id,
          to === 'COMPLETED' ? 'dispatch.complete' : 'kitchen.update',
        ],
      );
      if (!permission.rowCount)
        throw new ForbiddenException({
          code: 'PERMISSION_DENIED',
          message: 'Permission to perform this order transition is required.',
        });
      const order = (
        await c.query<{ status: OrderStatus }>(
          'SELECT status FROM orders WHERE id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0];
      if (!order)
        throw new NotFoundException({
          code: 'ORDER_NOT_FOUND',
          message: 'Order was not found.',
        });
      if (order.status === to)
        throw new ConflictException({
          code:
            to === 'PREPARING'
              ? 'ORDER_ALREADY_STARTED'
              : to === 'READY'
                ? 'ORDER_ALREADY_READY'
                : 'ORDER_ALREADY_COMPLETED',
          message:
            'Another device already updated this order. The queue will refresh.',
        });
      if (!canTransition(order.status, to))
        throw new ConflictException({
          code: 'INVALID_ORDER_TRANSITION',
          message:
            'This order is no longer in the expected state. The queue will refresh.',
        });
      if (to === 'PREPARING') {
        const first = (
          await c.query<{ id: string }>(
            "SELECT id FROM orders WHERE status='QUEUED' ORDER BY queued_at,id LIMIT 1",
          )
        ).rows[0];
        if (first?.id !== id)
          throw new ConflictException({
            code: 'OLDER_ORDER_WAITING',
            message:
              'Start the oldest waiting token first. The queue will refresh.',
          });
      }
      // The database checks the same policy and atomically applies status from history.
      const history = (
        await c.query<{ occurred_at: Date }>(
          `INSERT INTO order_status_history(id,order_id,from_status,to_status,actor_id,occurred_at,reason)
        VALUES($1,$2,$3,$4,$5,GREATEST(clock_timestamp(),(SELECT max(occurred_at) FROM order_status_history WHERE order_id=$2)),$6) RETURNING occurred_at`,
          [
            randomUUID(),
            id,
            order.status,
            to,
            actor.user.id,
            to === 'PREPARING'
              ? 'Kitchen started order'
              : to === 'READY'
                ? 'Kitchen marked order ready'
                : 'Dispatch handed order over',
          ],
        )
      ).rows[0]!;
      return {
        orderId: id,
        status: to,
        occurredAt: history.occurred_at.toISOString(),
      };
    });
  }
}
