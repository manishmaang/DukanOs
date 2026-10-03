import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type {
  Expense,
  ExpenseCategory,
  ExpenseConfiguration,
  ExpenseList,
  ExpenseTotals,
  ExpensesReport,
  ReportPeriod,
} from '@dukanos/shared-types';
import { DatabaseService } from '../../database/database.service';
import { RestaurantClock } from '../../database/restaurant-clock';
import { reportPeriod } from '../../reporting/period';
import type { ReportPeriodDto } from '../../reporting/period.dto';
import { authorizeMutation } from '../auth/mutation-access';
import type { AuthRequest } from '../auth/access';
import { amount, paise } from '../orders/order-policy';
import { ExpenseMediaService, type PhotoUpload } from './expense-media.service';
import type {
  CreateExpenseDto,
  VoidExpenseDto,
  ExpenseCategoryDto,
  UpdateExpenseCategoryDto,
  ExpensesQueryDto,
} from './expenses.dto';
const fingerprint = (v: unknown) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex');
const categoryFields =
  'id,name,active,version,created_at AS "createdAt",updated_at AS "updatedAt"';
const expenseFields = `SELECT e.id,e.business_date::text AS "businessDate",e.amount::text AS amount,e.category_id AS "categoryId",e.category_name_snapshot AS "categoryName",e.payment_method AS "paymentMethod",e.vendor,e.note,e.created_at AS "createdAt",e.status,
 json_build_object('id',u.id,'name',u.name) AS "recordedBy",
 CASE WHEN r.key IS NULL THEN NULL ELSE json_build_object('key',r.key,'url','/api/expenses/receipts/'||r.key,'width',r.width,'height',r.height) END AS receipt,
 CASE WHEN e.status='ACTIVE' THEN NULL ELSE json_build_object('by',json_build_object('id',v.id,'name',v.name),'at',e.voided_at,'reason',e.void_reason,'note',e.void_note) END AS void
 FROM expenses e JOIN users u ON u.id=e.recorded_by LEFT JOIN users v ON v.id=e.voided_by LEFT JOIN expense_receipts r ON r.key=e.receipt_key JOIN expense_categories c ON c.id=e.category_id`;
const filtered = `e.business_date BETWEEN $1::date AND $2::date
 AND ($3::uuid IS NULL OR e.category_id=$3) AND ($4::text IS NULL OR e.payment_method=$4)
 AND ($5::text IS NULL OR e.status=$5)
 AND ($6::text='' OR strpos(lower(e.vendor||' '||e.note||' '||e.category_name_snapshot||' '||c.name),lower($6))>0)`;
@Injectable()
export class ExpensesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly clock: RestaurantClock,
    private readonly media: ExpenseMediaService,
  ) {}
  private read<T>(
    q: ReportPeriodDto,
    work: (c: PoolClient, p: ReportPeriod) => Promise<T>,
  ) {
    return this.db.transaction(async (c) => {
      await c.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      await c.query("SET LOCAL statement_timeout='8s'");
      return work(c, await reportPeriod(c, this.clock, q));
    });
  }
  configuration(): Promise<ExpenseConfiguration> {
    return this.read({}, async (c, p) => ({
      currentBusinessDate: p.currentBusinessDate,
      earliestBusinessDate: (
        await c.query('SELECT ($1::date-30)::text AS date', [
          p.currentBusinessDate,
        ])
      ).rows[0].date,
      timezone: p.timezone,
      categories: (
        await c.query<ExpenseCategory>(
          `SELECT ${categoryFields} FROM expense_categories ORDER BY lower(name),id`,
        )
      ).rows,
    }));
  }
  async category(
    input: ExpenseCategoryDto | UpdateExpenseCategoryDto,
    actor: AuthRequest,
    id?: string,
  ): Promise<ExpenseCategory> {
    const name = input.name.trim();
    if (!name)
      throw new BadRequestException({
        code: 'INVALID_EXPENSE_CATEGORY',
        message: 'Enter a category name.',
      });
    return this.db.transaction(async (c) => {
      await authorizeMutation(c, actor, 'expense_categories.manage');
      const before = id
        ? (
            await c.query(
              `SELECT ${categoryFields} FROM expense_categories WHERE id=$1 FOR UPDATE`,
              [id],
            )
          ).rows[0]
        : null;
      if (id && !before)
        throw new NotFoundException({
          code: 'EXPENSE_CATEGORY_NOT_FOUND',
          message: 'Category was not found.',
        });
      if (id && before.version !== (input as UpdateExpenseCategoryDto).version)
        throw new ConflictException({
          code: 'STALE_EXPENSE_CATEGORY',
          message: 'Category changed. Refresh before saving.',
        });
      if (
        (
          await c.query(
            'SELECT 1 FROM expense_categories WHERE lower(btrim(name))=lower($1) AND ($2::uuid IS NULL OR id<>$2)',
            [name, id ?? null],
          )
        ).rowCount
      )
        throw new ConflictException({
          code: 'DUPLICATE_EXPENSE_CATEGORY',
          message: 'A category with this name already exists.',
        });
      const key = id ?? randomUUID();
      const result = id
        ? await c.query<ExpenseCategory>(
            `UPDATE expense_categories SET name=$2,active=$3,version=version+1 WHERE id=$1 RETURNING ${categoryFields}`,
            [key, name, (input as UpdateExpenseCategoryDto).active],
          )
        : await c.query<ExpenseCategory>(
            `INSERT INTO expense_categories(id,name) VALUES($1,$2) RETURNING ${categoryFields}`,
            [key, name],
          );
      await c.query(
        'INSERT INTO expense_category_audit(id,category_id,performed_by,before_state,after_state) VALUES($1,$2,$3,$4,$5)',
        [randomUUID(), key, actor.user.id, before, result.rows[0]],
      );
      return result.rows[0]!;
    });
  }
  private async detail(c: PoolClient, id: string): Promise<Expense> {
    const row = (await c.query<Expense>(expenseFields + ' WHERE e.id=$1', [id]))
      .rows[0];
    if (!row)
      throw new NotFoundException({
        code: 'EXPENSE_NOT_FOUND',
        message: 'Expense was not found.',
      });
    return row;
  }
  get(id: string) {
    return this.read({}, (c) => this.detail(c, id));
  }
  create(input: CreateExpenseDto, actor: AuthRequest): Promise<Expense> {
    const value = amount(paise(input.amount));
    if (paise(value) <= 0n)
      throw new BadRequestException({
        code: 'INVALID_EXPENSE_AMOUNT',
        message: 'Expense amount must be greater than zero.',
      });
    const canonical = {
      amount: value,
      categoryId: input.categoryId,
      businessDate: input.businessDate ?? null,
      paymentMethod: input.paymentMethod,
      vendor: input.vendor?.trim() ?? '',
      note: input.note?.trim() ?? '',
      receiptKey: input.receiptKey ?? null,
    };
    const hash = fingerprint(canonical);
    return this.db.transaction(async (c) => {
      await authorizeMutation(c, actor, 'expenses.create');
      const prior = (
        await c.query(
          'SELECT id,request_hash FROM expenses WHERE recorded_by=$1 AND request_id=$2',
          [actor.user.id, input.requestId],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_hash !== hash)
          throw new ConflictException({
            code: 'IDEMPOTENCY_CONFLICT',
            message: 'This request was used for a different expense.',
          });
        return this.detail(c, prior.id);
      }
      const now = await this.clock.read(c);
      const date = input.businessDate ?? now.business_date;
      const parsed = new Date(date + 'T00:00:00Z');
      const days =
        (Date.parse(now.business_date) - parsed.getTime()) / 86400000;
      if (
        !Number.isFinite(days) ||
        parsed.toISOString().slice(0, 10) !== date ||
        days < 0 ||
        days > 30
      )
        throw new BadRequestException({
          code: 'INVALID_EXPENSE_DATE',
          message:
            'Choose today or one of the previous 30 restaurant business dates.',
        });
      const category = (
        await c.query(
          'SELECT name,active FROM expense_categories WHERE id=$1 FOR SHARE',
          [input.categoryId],
        )
      ).rows[0];
      if (!category?.active)
        throw new ConflictException({
          code: 'EXPENSE_CATEGORY_INACTIVE',
          message:
            'This category is no longer available. Choose an active category.',
        });
      if (input.receiptKey) {
        const receipt = await c.query(
          'SELECT 1 FROM expense_receipts r WHERE r.key=$1 AND r.uploaded_by=$2 AND NOT EXISTS(SELECT 1 FROM expenses WHERE receipt_key=r.key) FOR UPDATE',
          [input.receiptKey, actor.user.id],
        );
        if (!receipt.rowCount || !(await this.media.exists(input.receiptKey)))
          throw new ConflictException({
            code: 'INVALID_EXPENSE_RECEIPT',
            message:
              'Receipt is missing or already attached. Choose the image again.',
          });
      }
      const id = randomUUID();
      await c.query(
        `INSERT INTO expenses(id,business_date,restaurant_timezone,amount,category_id,category_name_snapshot,payment_method,vendor,note,receipt_key,recorded_by,created_at,request_id,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          id,
          date,
          this.clock.timezone,
          value,
          input.categoryId,
          category.name,
          input.paymentMethod,
          canonical.vendor,
          canonical.note,
          canonical.receiptKey,
          actor.user.id,
          now.queued_at,
          input.requestId,
          hash,
        ],
      );
      return this.detail(c, id);
    });
  }
  void(
    id: string,
    input: VoidExpenseDto,
    actor: AuthRequest,
  ): Promise<Expense> {
    const note = input.note?.trim() ?? '';
    if (input.reason === 'OTHER' && !note)
      throw new BadRequestException({
        code: 'EXPENSE_VOID_REASON_REQUIRED',
        message: 'Explain the reason for this void.',
      });
    const hash = fingerprint({ id, reason: input.reason, note });
    return this.db.transaction(async (c) => {
      await authorizeMutation(c, actor, 'expenses.manage');
      const prior = (
        await c.query(
          'SELECT id,void_request_hash FROM expenses WHERE voided_by=$1 AND void_request_id=$2',
          [actor.user.id, input.requestId],
        )
      ).rows[0];
      if (prior) {
        if (prior.void_request_hash !== hash)
          throw new ConflictException({
            code: 'IDEMPOTENCY_CONFLICT',
            message: 'This request was used for a different void.',
          });
        return this.detail(c, prior.id);
      }
      const original = await this.detail(c, id);
      if (original.status !== 'ACTIVE')
        throw new ConflictException({
          code: 'EXPENSE_ALREADY_VOIDED',
          message: 'This expense was already voided. Refresh to see the audit.',
        });
      await c.query(
        "UPDATE expenses SET status='VOIDED',voided_by=$2,voided_at=GREATEST(clock_timestamp(),created_at),void_reason=$3,void_note=$4,void_request_id=$5,void_request_hash=$6 WHERE id=$1",
        [id, actor.user.id, input.reason, note, input.requestId, hash],
      );
      return this.detail(c, id);
    });
  }
  async upload(file: PhotoUpload | undefined, actor: AuthRequest) {
    const receipt = await this.media.prepare(file);
    try {
      await this.db.transaction(async (c) => {
        await authorizeMutation(c, actor, 'expenses.create');
        await c.query(
          'INSERT INTO expense_receipts(key,uploaded_by,width,height,byte_size) VALUES($1,$2,$3,$4,$5)',
          [
            receipt.key,
            actor.user.id,
            receipt.width,
            receipt.height,
            receipt.byteSize,
          ],
        );
      });
      return {
        key: receipt.key,
        url: receipt.url,
        width: receipt.width,
        height: receipt.height,
      };
    } catch (e) {
      await this.media.discardUnused(receipt.key);
      throw e;
    }
  }
  readReceipt(key: string, actor: AuthRequest) {
    return this.media.read(key, actor);
  }
  private values(p: ReportPeriod, q: ExpensesQueryDto = {}) {
    return [
      p.from,
      p.to,
      q.categoryId ?? null,
      q.paymentMethod ?? null,
      q.status ?? null,
      q.search?.trim() ?? '',
    ];
  }
  async totals(
    c: PoolClient,
    p: ReportPeriod,
    q: ExpensesQueryDto = {},
  ): Promise<ExpenseTotals> {
    const values = this.values(p, q);
    const row = (
      await c.query(
        `SELECT coalesce(sum(e.amount),0)::text AS total,coalesce(sum(e.amount) FILTER(WHERE e.payment_method='CASH'),0)::text AS cash,coalesce(sum(e.amount) FILTER(WHERE e.payment_method='UPI'),0)::text AS upi,count(*)::int AS count FROM expenses e JOIN expense_categories c ON c.id=e.category_id WHERE ${filtered} AND e.status='ACTIVE'`,
        values,
      )
    ).rows[0];
    const categories = (
      await c.query(
        `SELECT e.category_id AS "categoryId",(array_agg(e.category_name_snapshot ORDER BY e.created_at DESC,e.id DESC))[1] AS name,sum(e.amount)::text AS amount,count(*)::int AS count FROM expenses e JOIN expense_categories c ON c.id=e.category_id WHERE ${filtered} AND e.status='ACTIVE' GROUP BY e.category_id ORDER BY sum(e.amount) DESC,e.category_id`,
        values,
      )
    ).rows;
    return {
      total: amount(paise(row.total)),
      cash: amount(paise(row.cash)),
      upi: amount(paise(row.upi)),
      count: row.count,
      categories: categories.map((r) => ({
        ...r,
        amount: amount(paise(r.amount)),
      })),
    };
  }
  list(q: ExpensesQueryDto): Promise<ExpenseList> {
    return this.read(q, async (c, p) => {
      const page = Number(q.page ?? '1');
      const rows = (
        await c.query<Expense>(
          expenseFields +
            ` WHERE ${filtered} ORDER BY e.business_date DESC,e.created_at DESC,e.id DESC LIMIT 51 OFFSET $7`,
          [...this.values(p, q), (page - 1) * 50],
        )
      ).rows;
      return {
        period: p,
        expenses: rows.slice(0, 50),
        totals: await this.totals(c, p, q),
        page,
        hasMore: rows.length > 50,
      };
    });
  }
  report(q: ReportPeriodDto): Promise<ExpensesReport> {
    return this.read(q, async (c, p) => {
      const totals = await this.totals(c, p);
      const trend = (
        await c.query(
          `SELECT d::date::text AS "businessDate",coalesce(sum(e.amount),0)::text AS amount FROM generate_series($1::date,$2::date,interval '1 day') d LEFT JOIN expenses e ON e.business_date=d::date AND e.status='ACTIVE' GROUP BY d ORDER BY d`,
          [p.from, p.to],
        )
      ).rows.map((r) => ({ ...r, amount: amount(paise(r.amount)) }));
      return { ...totals, period: p, trend };
    });
  }
}
