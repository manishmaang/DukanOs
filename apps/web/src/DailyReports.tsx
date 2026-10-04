import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DailyReport,
  DailyReportSummary,
  DailyReportSettings,
  PermissionCode,
  ReportDelivery,
} from '@dukanos/shared-types';
import { api, ApiFailure, errorMessage } from './api';
import { rupees } from './menu-editor';
interface Pending {
  path: string;
  body: Record<string, unknown>;
}
export function DailyReports({
  permissions,
  userId,
}: {
  permissions: PermissionCode[];
  userId: string;
}) {
  const manage = permissions.includes('daily_reports.manage'),
    send = permissions.includes('daily_reports.send');
  const [page, setPage] = useState(1),
    [history, setHistory] = useState<{
      reports: DailyReportSummary[];
      hasMore: boolean;
    }>(),
    [detail, setDetail] = useState<DailyReport>(),
    [settings, setSettings] = useState<DailyReportSettings>(),
    [deliveries, setDeliveries] = useState<ReportDelivery[]>([]);
  const [mode, setMode] = useState<'history' | 'detail' | 'settings'>(
      'history',
    ),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [date, setDate] = useState(''),
    [reason, setReason] = useState(''),
    [recipients, setRecipients] = useState(''),
    [enabled, setEnabled] = useState(false),
    [testRecipient, setTestRecipient] = useState(''),
    [confirm, setConfirm] = useState(false);
  const storageKey = 'dukanos.daily-request.' + userId;
  const [pending, setPending] = useState<Pending | undefined>(() => {
    try {
      return (
        JSON.parse(sessionStorage.getItem(storageKey) || 'null') ?? undefined
      );
    } catch {
      return undefined;
    }
  });
  const inFlight = useRef(false),
    sequence = useRef(0);
  const refresh = useCallback(async () => {
    const n = ++sequence.current;
    try {
      const h = await api<{ reports: DailyReportSummary[]; hasMore: boolean }>(
        `/daily-reports?page=${page}`,
      );
      if (n !== sequence.current) return;
      setHistory(h);
      setError('');
      if (manage) {
        const s = await api<DailyReportSettings>('/daily-reports/settings');
        if (n !== sequence.current) return;
        setSettings(s);
      }
      const ds = await api<ReportDelivery[]>('/daily-reports/deliveries');
      if (n === sequence.current) setDeliveries(ds);
    } catch (e) {
      if (n === sequence.current) setError(errorMessage(e));
    }
  }, [page, manage]);
  useEffect(() => {
    void refresh();
    return () => {
      sequence.current++;
    };
  }, [refresh]);
  async function open(id: string) {
    try {
      const r = await api<DailyReport>('/daily-reports/' + id);
      setDetail(r);
      setMode('detail');
      setConfirm(false);
      setError('');
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function mutate(next: Pending) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(next));
      setPending(next);
      const result = await api<DailyReport | { deliveryIds: string[] }>(
        next.path,
        'POST',
        next.body,
      );
      sessionStorage.removeItem(storageKey);
      setPending(undefined);
      setNotice(
        'snapshot' in result
          ? 'Report generated. This stored version will not change.'
          : 'Email request saved. The background worker will process it.',
      );
      if ('snapshot' in result) {
        setDetail(result);
        setMode('detail');
        setReason('');
      } else if (detail) await open(detail.id);
      await refresh();
    } catch (e) {
      if (
        e instanceof ApiFailure &&
        e.status >= 400 &&
        e.status < 500 &&
        e.status !== 401
      ) {
        sessionStorage.removeItem(storageKey);
        setPending(undefined);
      }
      setError(errorMessage(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  const post = (path: string, body: Record<string, unknown>) =>
    void mutate({ path, body: { ...body, requestId: crypto.randomUUID() } });
  const locked = busy || Boolean(pending);
  const money = (s: string) => '₹' + rupees(s);
  const deliveryCard = (d: ReportDelivery) => (
    <article className="daily-card" key={d.id}>
      <strong>{d.recipient}</strong>
      <p>
        {d.kind} · {d.status} · {d.attemptCount} attempts
      </p>
      <p>
        {d.sentAt
          ? 'Sent ' + new Date(d.sentAt).toLocaleString()
          : 'Next check ' + new Date(d.nextAttemptAt).toLocaleString()}
      </p>
      {d.lastErrorCode && <p>{d.lastErrorCode.replaceAll('_', ' ')}</p>}
      {send && ['FAILED', 'PENDING', 'RETRY_PENDING'].includes(d.status) && (
        <button
          disabled={locked}
          onClick={() => post(`/daily-reports/deliveries/${d.id}/retry`, {})}
        >
          Retry Email
        </button>
      )}
    </article>
  );
  return (
    <section className="daily-reports">
      <h1>Daily Reports</h1>
      <p>
        Stored versions preserve exactly what was generated. Live Reports may
        reflect later corrections.
      </p>
      <nav className="report-tabs" aria-label="Daily report sections">
        <button
          className="secondary"
          onClick={() => {
            setMode('history');
            void refresh();
          }}
        >
          History
        </button>
        {manage && (
          <button
            className="secondary"
            onClick={() => {
              setRecipients(settings?.recipients.join('\n') ?? '');
              setEnabled(settings?.enabled ?? false);
              setMode('settings');
            }}
          >
            Settings
          </button>
        )}
        <button
          className="secondary"
          onClick={() => {
            void refresh();
            if (mode === 'detail' && detail) void open(detail.id);
          }}
        >
          Refresh
        </button>
      </nav>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {pending && (
        <div className="notice">
          <p>
            A request needs confirmation. Retry the same request to avoid
            duplicates.
          </p>
          <button disabled={busy} onClick={() => void mutate(pending)}>
            Retry pending request
          </button>
        </div>
      )}
      {mode === 'history' && (
        <>
          {manage && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                post('/daily-reports', { businessDate: date });
              }}
            >
              <label>
                Completed business date
                <input
                  type="date"
                  required
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </label>
              <button disabled={locked}>Generate report</button>
            </form>
          )}
          {history?.reports.map((r) => (
            <article className="daily-card" key={r.id}>
              <h2>
                {r.businessDate} · v{r.version}
              </h2>
              <p>
                {r.version > 1 ? 'Revised report' : 'Daily report'} ·{' '}
                {new Date(r.generatedAt).toLocaleString()}
              </p>
              <p>
                Email:{' '}
                {r.deliveries.length
                  ? r.deliveries.map((d) => d.status).join(', ')
                  : 'Not requested'}
              </p>
              <button onClick={() => void open(r.id)}>Open report</button>
            </article>
          ))}
          {history?.reports.length === 0 && (
            <p>No daily reports generated yet.</p>
          )}
          <div className="report-tabs">
            <button disabled={page === 1} onClick={() => setPage(page - 1)}>
              Previous
            </button>
            <span>Page {page}</span>
            <button
              disabled={!history?.hasMore}
              onClick={() => setPage(page + 1)}
            >
              Next
            </button>
          </div>
        </>
      )}
      {mode === 'detail' && detail && (
        <>
          <h2>
            {detail.version > 1 ? 'REVISED DAILY REPORT' : 'DAILY REPORT'} ·{' '}
            {detail.businessDate} · Version {detail.version}
          </h2>
          <p>
            Generated {new Date(detail.generatedAt).toLocaleString()} ·{' '}
            {detail.generatedBy?.name ?? 'Automatic'} ·{' '}
            {detail.snapshot.timezone}
          </p>
          {detail.reason && <p>Reason: {detail.reason}</p>}
          <div className="report-summary">
            <article>
              <span>FOOD SOLD</span>
              <strong>{money(detail.snapshot.foodSold)}</strong>
            </article>
            <article>
              <span>CASH RETURNED</span>
              <strong>{money(detail.snapshot.cashReturned)}</strong>
            </article>
            <article>
              <span>RECORDED EXPENSES</span>
              <strong>{money(detail.snapshot.recordedExpenses)}</strong>
            </article>
          </div>
          <h2>Expense categories</h2>
          {detail.snapshot.expenseCategories.map((c) => (
            <p key={c.categoryId}>
              {c.name}: {money(c.amount)}
            </p>
          ))}
          {!detail.snapshot.expenseEntries.length && (
            <p>No expenses recorded.</p>
          )}
          <h2>Expense details</h2>
          {detail.snapshot.expenseEntries.map((e) => (
            <article className="daily-card" key={e.id}>
              <strong>
                {money(e.amount)} · {e.categoryName}
              </strong>
              <p>
                {e.paymentMethod} {e.vendor && '· ' + e.vendor}
              </p>
              {e.note && <p>{e.note}</p>}
            </article>
          ))}
          <h2>BEST SELLING ITEM</h2>
          {detail.snapshot.bestSeller ? (
            <>
              <h3>
                {detail.snapshot.bestSeller.name} ·{' '}
                {detail.snapshot.bestSeller.quantity} sold
              </h3>
              {detail.snapshot.bestSeller.variants.map((v) => (
                <p key={v.variantId}>
                  {v.name}: {v.quantity}
                </p>
              ))}
            </>
          ) : (
            <p>No food sales recorded.</p>
          )}
          {manage && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                post(`/daily-reports/${detail.id}/regenerate`, { reason });
              }}
            >
              <label>
                Regeneration reason
                <textarea
                  required
                  maxLength={500}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              <button disabled={locked}>Regenerate Report</button>
              <small>
                Creates a new version. Does not email it automatically.
              </small>
            </form>
          )}
          {send && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                post(`/daily-reports/${detail.id}/send`, {
                  confirmResend: confirm,
                });
              }}
            >
              <p>
                Send this exact version to the current configured recipients:{' '}
                {settings?.recipients.join(', ') || 'See settings'}.
              </p>
              {detail.deliveries.some((d) => d.status === 'SENT') && (
                <label className="daily-check">
                  <input
                    type="checkbox"
                    checked={confirm}
                    onChange={(e) => setConfirm(e.target.checked)}
                  />
                  I confirm resending this stored version.
                </label>
              )}
              <button
                disabled={
                  locked ||
                  (detail.deliveries.some((d) => d.status === 'SENT') &&
                    !confirm)
                }
              >
                {detail.deliveries.some((d) => d.status === 'SENT')
                  ? 'Resend Email'
                  : 'Send Email'}
              </button>
            </form>
          )}
          <h2>Delivery history</h2>
          {detail.deliveries.length ? (
            detail.deliveries.map(deliveryCard)
          ) : (
            <p>No deliveries requested.</p>
          )}
        </>
      )}
      {mode === 'settings' && settings && (
        <>
          <p>
            Email delivery:{' '}
            {settings.smtpStatus === 'CONFIGURED'
              ? 'Configured'
              : 'Not configured'}
          </p>
          <p>
            Generated after completed business days, with a{' '}
            {settings.delayMinutes}-minute delay. Automatic history starts{' '}
            {settings.startDate ?? 'at first worker startup'}.
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (inFlight.current) return;
              inFlight.current = true;
              setBusy(true);
              try {
                const s = await api<DailyReportSettings>(
                  '/daily-reports/settings',
                  'PATCH',
                  {
                    enabled,
                    recipients: recipients
                      .split('\n')
                      .map((r) => r.trim())
                      .filter(Boolean),
                    version: settings.version,
                  },
                );
                setSettings(s);
                setNotice('Settings saved.');
                setError('');
              } catch (e) {
                setError(errorMessage(e));
              } finally {
                inFlight.current = false;
                setBusy(false);
              }
            }}
          >
            <label className="daily-check">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              Daily Email Reports ON
            </label>
            <label>
              Recipients (one email per line, up to 10)
              <textarea
                value={recipients}
                onChange={(e) => setRecipients(e.target.value)}
                rows={4}
              />
            </label>
            <button disabled={locked}>Save settings</button>
          </form>
          {send && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                post('/daily-reports/test-email', { recipient: testRecipient });
              }}
            >
              <label>
                Test recipient
                <select
                  required
                  value={testRecipient}
                  onChange={(e) => setTestRecipient(e.target.value)}
                >
                  <option value="">Choose a saved recipient</option>
                  {settings.recipients.map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
              </label>
              <button disabled={locked}>Send Test Email</button>
            </form>
          )}
          <h2>Recent deliveries and test emails</h2>
          {deliveries.map(deliveryCard)}
        </>
      )}
    </section>
  );
}
