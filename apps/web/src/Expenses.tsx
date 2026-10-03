import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AuthenticatedUser,
  CreateExpense,
  Expense,
  ExpenseCategory,
  ExpenseConfiguration,
  ExpenseList,
  ExpenseMethod,
  ExpenseReceipt,
  ExpenseTotals,
  ExpensesReport,
  ExpenseVoidReason,
  ReportPreset,
} from '@dukanos/shared-types';
import { api, ApiFailure, errorMessage } from './api';
import { rupees } from './menu-editor';
const money = (v: string) => `₹${rupees(v)}`;
export function ExpenseSummary({
  data,
  trend,
}: {
  data: ExpenseTotals;
  trend?: ExpensesReport['trend'];
}) {
  return (
    <section className="expense-summary" aria-label="Recorded expense summary">
      <h2>Recorded Expenses</h2>
      <div className="report-summary">
        <article className="report-sales-hero">
          <span>TOTAL RECORDED EXPENSES</span>
          <strong data-expense-total>{money(data.total)}</strong>
          <small>{data.count} active entries</small>
        </article>
        <article>
          <span>Cash Expenses</span>
          <strong data-expense-cash>{money(data.cash)}</strong>
        </article>
        <article>
          <span>UPI Expenses</span>
          <strong data-expense-upi>{money(data.upi)}</strong>
        </article>
      </div>
      <p className="report-caption">
        Only expenses recorded in DukanOS. Voided entries are excluded. This is
        not a profit calculation.
      </p>
      <h3>Expense by Category</h3>
      {data.categories.length ? (
        <ul className="expense-breakdown">
          {data.categories.map((c) => (
            <li key={c.categoryId}>
              <span>{c.name}</span>
              <strong>{money(c.amount)}</strong>
            </li>
          ))}
        </ul>
      ) : (
        <p>No recorded expenses in this period.</p>
      )}
      {trend && (
        <>
          <h3>Expenses by Day</h3>
          <ul
            className="expense-breakdown expense-trend"
            tabIndex={0}
            aria-label="Expenses by day"
          >
            {trend.map((d) => (
              <li key={d.businessDate}>
                <span>{d.businessDate}</span>
                <strong>{money(d.amount)}</strong>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
const reasons: ExpenseVoidReason[] = [
  'DUPLICATE_ENTRY',
  'WRONG_AMOUNT',
  'WRONG_CATEGORY',
  'NOT_A_BUSINESS_EXPENSE',
  'OTHER',
];
export function Expenses({ user }: { user: AuthenticatedUser }) {
  const key = `dukanos-expense-pending:${user.id}`;
  const [pending, setPending] = useState<CreateExpense | undefined>(() => {
    try {
      const p = JSON.parse(sessionStorage.getItem(key) || 'null');
      return p && typeof p.requestId === 'string' ? p : undefined;
    } catch {
      return undefined;
    }
  });
  const [mode, setMode] = useState<'list' | 'create' | 'categories' | 'detail'>(
    pending ? 'create' : 'list',
  );
  const [config, setConfig] = useState<ExpenseConfiguration>(),
    [data, setData] = useState<ExpenseList>(),
    [detail, setDetail] = useState<Expense>();
  const [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false),
    [uploading, setUploading] = useState(false);
  const busyRef = useRef(false),
    sequence = useRef(0);
  const [value, setValue] = useState(pending?.amount ?? ''),
    [category, setCategory] = useState(pending?.categoryId ?? ''),
    [method, setMethod] = useState<ExpenseMethod>(
      pending?.paymentMethod ?? 'CASH',
    ),
    [date, setDate] = useState(pending?.businessDate ?? ''),
    [vendor, setVendor] = useState(pending?.vendor ?? ''),
    [note, setNote] = useState(pending?.note ?? ''),
    [receipt, setReceipt] = useState<ExpenseReceipt>();
  const [period, setPeriod] = useState<ReportPreset>('TODAY'),
    [range, setRange] = useState('period=TODAY'),
    [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [search, setSearch] = useState(''),
    [filterCategory, setFilterCategory] = useState(''),
    [filterMethod, setFilterMethod] = useState(''),
    [status, setStatus] = useState(''),
    [page, setPage] = useState(1);
  const [editing, setEditing] = useState<ExpenseCategory>(),
    [categoryName, setCategoryName] = useState(''),
    [active, setActive] = useState(true),
    [reason, setReason] = useState<ExpenseVoidReason>('DUPLICATE_ENTRY'),
    [voidNote, setVoidNote] = useState('');
  const canCreate = user.permissions.includes('expenses.create'),
    canManage = user.permissions.includes('expenses.manage'),
    canCategories = user.permissions.includes('expense_categories.manage');
  const load = useCallback(async () => {
    const token = ++sequence.current;
    try {
      const [c, d] = await Promise.all([
        api<ExpenseConfiguration>('/expense-categories'),
        api<ExpenseList>(
          `/expenses?${range}&search=${encodeURIComponent(search)}${filterCategory ? '&categoryId=' + filterCategory : ''}${filterMethod ? '&paymentMethod=' + filterMethod : ''}${status ? '&status=' + status : ''}&page=${page}`,
        ),
      ]);
      if (token !== sequence.current) return;
      setConfig(c);
      setData(d);
      setCategory((old) => old || c.categories.find((c) => c.active)?.id || '');
      setDate((old) => old || c.currentBusinessDate);
    } catch (e) {
      if (token === sequence.current) {
        setData(undefined);
        setError(errorMessage(e));
      }
    }
  }, [range, search, filterCategory, filterMethod, status, page]);
  useEffect(() => {
    void load();
    return () => {
      sequence.current++;
    };
  }, [load]);
  function begin() {
    setError('');
    setMessage('');
    setMode('create');
    if (!pending) {
      setValue('');
      setVendor('');
      setNote('');
      setReceipt(undefined);
      setDate(config?.currentBusinessDate ?? '');
    }
  }
  async function save() {
    if (busyRef.current || uploading) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    const input = pending ?? {
      requestId: crypto.randomUUID(),
      amount: value,
      categoryId: category,
      paymentMethod: method,
      ...(date === config?.currentBusinessDate ? {} : { businessDate: date }),
      vendor,
      note,
      ...(receipt ? { receiptKey: receipt.key } : {}),
    };
    try {
      sessionStorage.setItem(key, JSON.stringify(input));
      setPending(input);
      const e = await api<Expense>('/expenses', 'POST', input);
      sessionStorage.removeItem(key);
      setPending(undefined);
      setDetail(e);
      setMode('detail');
      setMessage(`Expense recorded: ${money(e.amount)}`);
      void load();
    } catch (e) {
      if (
        e instanceof ApiFailure &&
        e.status >= 400 &&
        e.status < 500 &&
        e.status !== 401
      ) {
        sessionStorage.removeItem(key);
        setPending(undefined);
        void load();
      }
      setError(errorMessage(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function upload(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    setError('');
    try {
      const form = new FormData();
      form.append('image', file);
      setReceipt(await api<ExpenseReceipt>('/expenses/receipts', 'POST', form));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setUploading(false);
    }
  }
  async function open(id: string) {
    setError('');
    setMessage('');
    setReason('DUPLICATE_ENTRY');
    setVoidNote('');
    try {
      setDetail(await api<Expense>(`/expenses/${id}`));
      setMode('detail');
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function voidEntry() {
    if (!detail || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      setDetail(
        await api<Expense>(`/expenses/${detail.id}/void`, 'POST', {
          requestId: crypto.randomUUID(),
          reason,
          note: voidNote,
        }),
      );
      setMessage('Expense voided. Original entry and receipt retained.');
      void load();
    } catch (e) {
      setError(errorMessage(e));
      try {
        setDetail(await api<Expense>(`/expenses/${detail.id}`));
      } catch {
        /* Keep current audit visible on failure. */
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function saveCategory() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      await api(
        editing ? `/expense-categories/${editing.id}` : '/expense-categories',
        editing ? 'PATCH' : 'POST',
        editing
          ? { name: categoryName, active, version: editing.version }
          : { name: categoryName },
      );
      setEditing(undefined);
      setCategoryName('');
      setActive(true);
      setMessage('Category saved.');
      await load();
    } catch (e) {
      setError(errorMessage(e));
      await load();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="expenses-workspace">
      <div className="expense-toolbar">
        <h1>Expenses</h1>
        {mode === 'list' ? (
          <>
            {canCreate && <button onClick={begin}>Add Expense</button>}
            {canCategories && (
              <button
                className="secondary"
                onClick={() => {
                  setMode('categories');
                  setMessage('');
                }}
              >
                Manage categories
              </button>
            )}
            <button
              className="secondary"
              onClick={() => {
                setError('');
                void load();
              }}
            >
              Refresh expenses
            </button>
          </>
        ) : (
          <button
            className="secondary"
            disabled={busy || uploading}
            onClick={() => {
              setMode('list');
              setError('');
              setMessage('');
            }}
          >
            Back to expenses
          </button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {pending && (
        <p className="expense-pending" role="status">
          An expense submission needs confirmation. Retry the same entry; do not
          record it again.
          {mode !== 'create' && (
            <button onClick={() => setMode('create')}>Resume expense</button>
          )}
        </p>
      )}
      {!config && !error && (
        <p role="status">Loading restaurant dates and categories…</p>
      )}
      {mode === 'create' && config && (
        <form
          className="expense-entry"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <h2>Add Expense</h2>
          <fieldset disabled={busy || !!pending}>
            <label>
              Amount (₹)
              <input
                className="expense-amount"
                aria-label="Expense amount"
                inputMode="decimal"
                required
                pattern="(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,2})?"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </label>
            <label>
              Category
              <select
                aria-label="Expense category"
                required
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                <option value="">Choose category</option>
                {config.categories.map((c) => (
                  <option key={c.id} value={c.id} disabled={!c.active}>
                    {c.name}
                    {c.active ? '' : ' (inactive)'}
                  </option>
                ))}
              </select>
            </label>
            <div className="expense-methods" role="group" aria-label="Paid via">
              {(['CASH', 'UPI'] as const).map((m) => (
                <button
                  type="button"
                  key={m}
                  aria-pressed={method === m}
                  className={method === m ? '' : 'secondary'}
                  onClick={() => setMethod(m)}
                >
                  {m === 'CASH' ? 'Cash' : 'UPI'}
                </button>
              ))}
            </div>
            <label>
              Business date · {config.timezone}
              <input
                aria-label="Expense business date"
                type="date"
                required
                min={config.earliestBusinessDate}
                max={config.currentBusinessDate}
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </label>
            <p className="report-caption">
              Restaurant today: {config.currentBusinessDate}. Up to 30 previous
              days allowed.
            </p>
            {date !== config.currentBusinessDate && (
              <p className="expense-historical">
                Historical entry: {date}. The expense will belong to this date.
              </p>
            )}
            <label>
              Vendor / payee (optional)
              <input
                aria-label="Expense vendor"
                maxLength={120}
                value={vendor}
                onChange={(e) => setVendor(e.target.value)}
              />
            </label>
            <label>
              Note (optional)
              <textarea
                aria-label="Expense note"
                maxLength={500}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
            <label>
              Receipt image (optional)
              <input
                aria-label="Expense receipt"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                disabled={uploading}
                onChange={(e) => void upload(e.target.files?.[0])}
              />
            </label>
            <small>
              JPEG, PNG or WebP, up to 5 MB. Receipt stays on the restaurant
              server.
            </small>
            {uploading && <p role="status">Uploading receipt…</p>}
            {receipt && (
              <div className="expense-receipt-preview">
                <img src={receipt.url} alt="Receipt preview" />
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setReceipt(undefined)}
                >
                  Remove receipt
                </button>
              </div>
            )}
          </fieldset>
          <button disabled={busy || uploading || !category}>
            {busy ? 'Saving…' : pending ? 'Retry Expense' : 'Save Expense'}
          </button>
        </form>
      )}
      {mode === 'categories' && canCategories && config && (
        <>
          <form
            className="expense-entry"
            onSubmit={(e) => {
              e.preventDefault();
              void saveCategory();
            }}
          >
            <h2>{editing ? 'Edit category' : 'New category'}</h2>
            <label>
              Name
              <input
                aria-label="Expense category name"
                required
                maxLength={100}
                value={categoryName}
                onChange={(e) => setCategoryName(e.target.value)}
              />
            </label>
            {editing && (
              <label className="expense-checkbox">
                <input
                  type="checkbox"
                  checked={active}
                  onChange={(e) => setActive(e.target.checked)}
                />
                Active for new expenses
              </label>
            )}
            <button disabled={busy}>Save category</button>
            {editing && (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setEditing(undefined);
                  setCategoryName('');
                  setActive(true);
                }}
              >
                New category
              </button>
            )}
          </form>
          <ul className="expense-category-list">
            {config.categories.map((c) => (
              <li key={c.id}>
                <span>
                  {c.name} · {c.active ? 'Active' : 'Inactive'}
                </span>
                <button
                  className="secondary"
                  onClick={() => {
                    setEditing(c);
                    setCategoryName(c.name);
                    setActive(c.active);
                    setMessage('');
                  }}
                >
                  Edit {c.name}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {mode === 'detail' && detail && (
        <article className="expense-detail" data-expense-id={detail.id}>
          <h2>
            {money(detail.amount)} · {detail.categoryName}
          </h2>
          <p>
            {detail.status} · {detail.businessDate} · {detail.paymentMethod}
          </p>
          {detail.vendor && <p>Vendor: {detail.vendor}</p>}
          {detail.note && <p className="expense-note">{detail.note}</p>}
          <p>
            Recorded by {detail.recordedBy.name} ·{' '}
            {new Date(detail.createdAt).toLocaleString()}
          </p>
          {detail.receipt && (
            <a
              className="expense-receipt-link"
              href={detail.receipt.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              View receipt
            </a>
          )}
          {detail.void ? (
            <div className="expense-void-audit">
              <h3>Void audit</h3>
              <p>
                {detail.void.reason.replaceAll('_', ' ')} ·{' '}
                {detail.void.by.name} ·{' '}
                {new Date(detail.void.at).toLocaleString()}
              </p>
              <p className="expense-note">{detail.void.note}</p>
              <p>
                Excluded from effective expense totals. Original entry retained.
              </p>
            </div>
          ) : (
            canManage && (
              <details className="expense-void">
                <summary>Void this expense</summary>
                <p>
                  Use a void for incorrect entries, then record a corrected
                  expense. The original record and receipt remain.
                </p>
                <form
                  className="expense-entry"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void voidEntry();
                  }}
                >
                  <label>
                    Reason
                    <select
                      aria-label="Expense void reason"
                      value={reason}
                      onChange={(e) =>
                        setReason(e.target.value as ExpenseVoidReason)
                      }
                    >
                      {reasons.map((r) => (
                        <option key={r} value={r}>
                          {r.replaceAll('_', ' ')}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Reason note
                    {reason === 'OTHER' ? ' (required)' : ' (optional)'}
                    <textarea
                      aria-label="Expense void note"
                      required={reason === 'OTHER'}
                      maxLength={500}
                      value={voidNote}
                      onChange={(e) => setVoidNote(e.target.value)}
                    />
                  </label>
                  <button disabled={busy}>Confirm void</button>
                </form>
              </details>
            )
          )}
          {canCreate && <button onClick={begin}>Add another expense</button>}
        </article>
      )}
      {mode === 'list' && (
        <>
          <div className="expense-filters">
            <label>
              Period
              <select
                aria-label="Expense period"
                value={period}
                onChange={(e) => {
                  const p = e.target.value as ReportPreset;
                  setPeriod(p);
                  if (p !== 'CUSTOM') {
                    setRange('period=' + p);
                    setPage(1);
                  }
                }}
              >
                {[
                  ['TODAY', 'Today'],
                  ['YESTERDAY', 'Yesterday'],
                  ['LAST_7_DAYS', 'Last 7 Days'],
                  ['THIS_MONTH', 'This Month'],
                  ['CUSTOM', 'Custom Range'],
                ].map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {period === 'CUSTOM' && (
              <form
                className="expense-custom-dates"
                onSubmit={(e) => {
                  e.preventDefault();
                  setRange(`period=CUSTOM&from=${from}&to=${to}`);
                  setPage(1);
                }}
              >
                <label>
                  From
                  <input
                    aria-label="Expense from"
                    type="date"
                    required
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                  />
                </label>
                <label>
                  To
                  <input
                    aria-label="Expense to"
                    type="date"
                    required
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                  />
                </label>
                <button>Apply expense dates</button>
              </form>
            )}
            <label>
              Search
              <input
                aria-label="Search expenses"
                maxLength={120}
                placeholder="Vendor, note or category"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
              />
            </label>
            <label>
              Category
              <select
                aria-label="Filter expense category"
                value={filterCategory}
                onChange={(e) => {
                  setFilterCategory(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">All categories</option>
                {config?.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.active ? '' : ' (inactive)'}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Method
              <select
                aria-label="Filter expense method"
                value={filterMethod}
                onChange={(e) => {
                  setFilterMethod(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">Cash and UPI</option>
                <option>CASH</option>
                <option>UPI</option>
              </select>
            </label>
            <label>
              Status
              <select
                aria-label="Filter expense status"
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">All entries</option>
                <option>ACTIVE</option>
                <option>VOIDED</option>
              </select>
            </label>
          </div>
          {data && (
            <>
              <p className="expense-period">
                {data.period.from} → {data.period.to} · {data.period.timezone}
              </p>
              <ExpenseSummary data={data.totals} />
              <div className="expense-list">
                {data.expenses.map((e) => (
                  <article className="expense-card" key={e.id}>
                    <h2>{money(e.amount)}</h2>
                    <strong>{e.categoryName}</strong>
                    <p>
                      {e.paymentMethod} · {e.businessDate} · {e.status}
                    </p>
                    {e.vendor && <p>{e.vendor}</p>}
                    <p>{new Date(e.createdAt).toLocaleTimeString()}</p>
                    <button
                      className="secondary"
                      onClick={() => void open(e.id)}
                    >
                      View expense
                    </button>
                  </article>
                ))}
              </div>
              {!data.expenses.length && <p>No entries match these filters.</p>}
              <div className="expense-toolbar">
                <button
                  className="secondary"
                  disabled={page === 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Previous expenses
                </button>
                <span>Page {page}</span>
                <button
                  className="secondary"
                  disabled={!data.hasMore}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next expenses
                </button>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
