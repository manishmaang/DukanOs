import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type {
  DailyReport,
  DailyReportSettings,
  ReportDelivery,
} from '@dukanos/shared-types';
import { DatabaseService } from '../../database/database.service';
import { RestaurantClock } from '../../database/restaurant-clock';
import { ReportsService } from '../reports/reports.service';
import { authorizeMutation } from '../auth/mutation-access';
import type { AuthRequest } from '../auth/access';
import { EmailDeliveryAdapter } from './email-adapter';
import type {
  GenerateReportDto,
  RegenerateReportDto,
  ReportSettingsDto,
  SendReportDto,
  TestEmailDto,
} from './daily-reports.dto';
const recipientAddress = (value: string) => {
  const trimmed = value.trim(),
    at = trimmed.lastIndexOf('@');
  return trimmed.slice(0, at) + '@' + trimmed.slice(at + 1).toLowerCase();
};
const hash = (v: unknown) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex');
const reportFields = `SELECT r.id,r.business_date::text AS "businessDate",r.version,r.generated_at AS "generatedAt",r.source,r.reason,r.snapshot,CASE WHEN u.id IS NULL THEN NULL ELSE json_build_object('id',u.id,'name',u.name) END AS "generatedBy" FROM daily_reports r LEFT JOIN users u ON u.id=r.generated_by`;
export const deliveryFields = `SELECT id,report_id AS "reportId",recipient,kind,status,attempt_count AS "attemptCount",next_attempt_at AS "nextAttemptAt",sent_at AS "sentAt",last_error_code AS "lastErrorCode",created_at AS "createdAt" FROM report_deliveries`;
@Injectable()
export class DailyReportsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly clock: RestaurantClock,
    private readonly reports: ReportsService,
    private readonly email: EmailDeliveryAdapter,
  ) {}
  async settings(): Promise<DailyReportSettings> {
    return this.db.transaction(async (c) => {
      const s = (
        await c.query(
          'SELECT enabled,recipients,version,start_date::text AS "startDate",next_date::text AS "nextDate" FROM daily_report_settings WHERE id',
        )
      ).rows[0];
      return {
        ...s,
        smtpStatus: this.email.configured ? 'CONFIGURED' : 'NOT_CONFIGURED',
        delayMinutes: this.email.config.delay,
        currentBusinessDate: (await this.clock.read(c)).business_date,
      };
    });
  }
  async updateSettings(q: ReportSettingsDto, actor: AuthRequest) {
    const recipients = q.recipients.map(recipientAddress);
    if (
      new Set(recipients.map((r) => r.toLowerCase())).size !==
        recipients.length ||
      recipients.some((r) => /[\r\n]/.test(r)) ||
      (q.enabled && !recipients.length)
    )
      throw new BadRequestException({
        code: 'INVALID_RECIPIENTS',
        message:
          'Use distinct email recipients; enabled reports need at least one.',
      });
    await this.db.transaction(async (c) => {
      await authorizeMutation(c, actor, 'daily_reports.manage');
      const before = (
        await c.query(
          'SELECT enabled,recipients,version FROM daily_report_settings WHERE id FOR UPDATE',
        )
      ).rows[0];
      if (before.version !== q.version)
        throw new ConflictException({
          code: 'STALE_REPORT_SETTINGS',
          message: 'Settings changed. Refresh and try again.',
        });
      await c.query(
        'UPDATE daily_report_settings SET enabled=$1,recipients=$2,version=version+1 WHERE id',
        [q.enabled, recipients],
      );
      await c.query(
        'INSERT INTO daily_report_settings_audit(id,actor_id,before_value,after_value) VALUES($1,$2,$3,$4)',
        [
          randomUUID(),
          actor.user.id,
          JSON.stringify(before),
          JSON.stringify({
            enabled: q.enabled,
            recipients,
            version: q.version + 1,
          }),
        ],
      );
    });
    return this.settings();
  }
  async list(page = 1) {
    return this.db.transaction(async (c) => {
      await c.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      const rows = (
        await c.query(
          `${reportFields.replace('r.snapshot,', '')} ORDER BY r.business_date DESC,r.version DESC LIMIT 26 OFFSET $1`,
          [(page - 1) * 25],
        )
      ).rows;
      const reports = [];
      const jobs = (
        await c.query<ReportDelivery>(
          `${deliveryFields} WHERE report_id=ANY($1::uuid[]) ORDER BY created_at,id`,
          [rows.slice(0, 25).map((r) => r.id)],
        )
      ).rows;
      for (const row of rows.slice(0, 25))
        reports.push({
          ...row,
          deliveries: jobs.filter((d) => d.reportId === row.id),
        });
      return { reports, page, hasMore: rows.length > 25 };
    });
  }
  async detail(id: string): Promise<DailyReport> {
    return this.db.transaction(async (c) => {
      await c.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      return this.detailIn(c, id);
    });
  }
  private async detailIn(c: PoolClient, id: string): Promise<DailyReport> {
    const r = (await c.query(`${reportFields} WHERE r.id=$1`, [id])).rows[0];
    if (!r)
      throw new NotFoundException({
        code: 'REPORT_NOT_FOUND',
        message: 'Report not found.',
      });
    return {
      ...r,
      deliveries: (
        await c.query<ReportDelivery>(
          `${deliveryFields} WHERE report_id=$1 ORDER BY created_at,id`,
          [id],
        )
      ).rows,
    };
  }
  async generate(
    q: GenerateReportDto,
    actor?: AuthRequest,
    revision?: { id: string; reason: string },
  ): Promise<DailyReport> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.db.transaction(async (c) => {
          await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
          if (actor) await authorizeMutation(c, actor, 'daily_reports.manage');
          await c.query('SELECT pg_advisory_xact_lock(742019324)');
          let date = q.businessDate;
          const reason = revision?.reason.trim() ?? '';
          if (revision) {
            const original = (
              await c.query(
                'SELECT business_date::text AS date FROM daily_reports WHERE id=$1',
                [revision.id],
              )
            ).rows[0];
            if (!original) throw new NotFoundException();
            date = original.date;
            if (!reason)
              throw new BadRequestException({
                code: 'REASON_REQUIRED',
                message: 'Enter a regeneration reason.',
              });
          }
          const fingerprint = hash({
            date,
            revision: revision?.id ?? null,
            reason,
          });
          if (actor) {
            const prior = (
              await c.query(
                'SELECT id,request_hash FROM daily_reports WHERE generated_by=$1 AND request_id=$2',
                [actor.user.id, q.requestId],
              )
            ).rows[0];
            if (prior) {
              if (prior.request_hash !== fingerprint)
                throw new ConflictException({
                  code: 'IDEMPOTENCY_CONFLICT',
                  message: 'Request already used for another report.',
                });
              return this.detailIn(c, prior.id);
            }
          }
          const now = await this.clock.read(c),
            parsed = new Date(date + 'T00:00:00Z');
          if (
            !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
            !Number.isFinite(parsed.getTime()) ||
            parsed.toISOString().slice(0, 10) !== date ||
            date < '0001-01-01' ||
            date >= now.business_date
          )
            throw new BadRequestException({
              code: 'REPORT_DAY_NOT_COMPLETE',
              message: 'Choose a valid completed restaurant date.',
            });
          const latest = (
            await c.query(
              'SELECT id,version FROM daily_reports WHERE business_date=$1 ORDER BY version DESC LIMIT 1',
              [date],
            )
          ).rows[0];
          if (latest && !revision)
            return this.detailIn(
              c,
              (
                await c.query(
                  'SELECT id FROM daily_reports WHERE business_date=$1 AND version=1',
                  [date],
                )
              ).rows[0].id,
            );
          const snapshot = await this.reports.dailySnapshot(c, date),
            id = randomUUID(),
            version = (latest?.version ?? 0) + 1;
          await c.query(
            'INSERT INTO daily_reports(id,business_date,version,generated_at,generated_by,source,reason,request_id,request_hash,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
            [
              id,
              date,
              version,
              now.queued_at,
              actor?.user.id ?? null,
              actor ? 'MANUAL' : 'AUTOMATIC',
              reason,
              actor ? q.requestId : null,
              actor ? fingerprint : null,
              JSON.stringify(snapshot),
            ],
          );
          if (!actor) {
            const s = (
              await c.query(
                'SELECT enabled,recipients FROM daily_report_settings WHERE id',
              )
            ).rows[0];
            if (s.enabled)
              for (const recipient of s.recipients)
                await c.query(
                  "INSERT INTO report_deliveries(id,report_id,kind,recipient) VALUES($1,$2,'AUTOMATIC',$3) ON CONFLICT DO NOTHING",
                  [randomUUID(), id, recipient],
                );
          }
          return this.detailIn(c, id);
        });
      } catch (e) {
        if (
          attempt < 4 &&
          ['40001', '23505'].includes((e as { code?: string }).code ?? '')
        )
          continue;
        throw e;
      }
    }
  }
  regenerate(id: string, q: RegenerateReportDto, actor: AuthRequest) {
    return this.generate({ requestId: q.requestId, businessDate: '' }, actor, {
      id,
      reason: q.reason,
    });
  }
  async send(
    id: string | null,
    q: SendReportDto | TestEmailDto,
    actor: AuthRequest,
  ) {
    return this.db.transaction(async (c) => {
      await authorizeMutation(c, actor, 'daily_reports.send');
      const fingerprint = hash({
        id,
        ...('recipient' in q
          ? { recipient: recipientAddress(q.recipient) }
          : { confirmResend: q.confirmResend }),
      });
      const prior = (
        await c.query(
          'SELECT id,request_hash FROM report_deliveries WHERE requested_by=$1 AND request_id=$2',
          [actor.user.id, q.requestId],
        )
      ).rows;
      if (prior.length) {
        if (prior.some((p) => p.request_hash !== fingerprint))
          throw new ConflictException({
            code: 'IDEMPOTENCY_CONFLICT',
            message: 'Request already used for another delivery.',
          });
        return { deliveryIds: prior.map((p) => p.id) };
      }
      const s = (
        await c.query('SELECT recipients FROM daily_report_settings WHERE id')
      ).rows[0];
      const recipients: string[] =
        'recipient' in q ? [recipientAddress(q.recipient)] : s.recipients;
      if (
        !recipients.length ||
        ('recipient' in q && !s.recipients.includes(recipients[0]))
      )
        throw new BadRequestException({
          code: 'NO_REPORT_RECIPIENTS',
          message: 'Save the recipient in settings first.',
        });
      if (id) {
        await this.detailIn(c, id);
        const existing = (
          await c.query(
            'SELECT status FROM report_deliveries WHERE report_id=$1 AND recipient=ANY($2::text[])',
            [id, recipients],
          )
        ).rows;
        if (
          existing.some((r) =>
            ['PENDING', 'SENDING', 'RETRY_PENDING'].includes(r.status),
          )
        )
          throw new ConflictException({
            code: 'DELIVERY_PENDING',
            message: 'An email is already pending. Retry that delivery.',
          });
        if (
          existing.some((r) => r.status === 'SENT') &&
          'confirmResend' in q &&
          !q.confirmResend
        )
          throw new ConflictException({
            code: 'RESEND_CONFIRMATION_REQUIRED',
            message: 'Confirm intentional resend of this stored version.',
          });
      }
      const ids = [];
      for (const recipient of recipients) {
        const deliveryId = randomUUID();
        ids.push(deliveryId);
        await c.query(
          'INSERT INTO report_deliveries(id,report_id,kind,recipient,requested_by,request_id,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            deliveryId,
            id,
            id ? 'MANUAL' : 'TEST',
            recipient,
            actor.user.id,
            q.requestId,
            fingerprint,
          ],
        );
      }
      return { deliveryIds: ids };
    });
  }
  async deliveries() {
    return (
      await this.db.query(
        `${deliveryFields} ORDER BY created_at DESC,id DESC LIMIT 50`,
      )
    ).rows;
  }
  async retry(id: string, requestId: string, actor: AuthRequest) {
    return this.db.transaction(async (c) => {
      await authorizeMutation(c, actor, 'daily_reports.send');
      const prior = (
        await c.query(
          'SELECT delivery_id FROM report_delivery_actions WHERE actor_id=$1 AND request_id=$2',
          [actor.user.id, requestId],
        )
      ).rows[0];
      if (prior) {
        if (prior.delivery_id !== id) throw new ConflictException();
        return { id };
      }
      const d = (
        await c.query(
          'SELECT status FROM report_deliveries WHERE id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0];
      if (!d) throw new NotFoundException();
      if (['SENT', 'SENDING'].includes(d.status))
        throw new ConflictException({
          code: 'DELIVERY_NOT_RETRYABLE',
          message:
            'Already sent or currently sending. Refresh the delivery status.',
        });
      await c.query(
        "UPDATE report_deliveries SET status='PENDING',next_attempt_at=clock_timestamp(),last_error_code=NULL WHERE id=$1",
        [id],
      );
      await c.query(
        'INSERT INTO report_delivery_actions(id,delivery_id,actor_id,request_id) VALUES($1,$2,$3,$4)',
        [randomUUID(), id, actor.user.id, requestId],
      );
      return { id };
    });
  }
}
