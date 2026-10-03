import { ExpenseSummary } from './Expenses';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DashboardReport,
  ExpensesReport,
  ItemsReport,
  OperationsReport,
  PaymentsReport,
  ReportItem,
  ReportPeriod,
  ReportPreset,
  SalesReport,
  SalesSummary,
  SalesTrend,
} from '@dukanos/shared-types';
import { api, errorMessage } from './api';
import { rupees } from './menu-editor';
const money = (v: string) => `₹${rupees(v)}`;
const presets: { value: ReportPreset; label: string }[] = [
  { value: 'TODAY', label: 'Today' },
  { value: 'YESTERDAY', label: 'Yesterday' },
  { value: 'LAST_7_DAYS', label: 'Last 7 Days' },
  { value: 'THIS_MONTH', label: 'This Month' },
  { value: 'CUSTOM', label: 'Custom' },
];
type Tab = 'sales' | 'payments' | 'items' | 'operations' | 'expenses';
type Result =
  | DashboardReport
  | SalesReport
  | PaymentsReport
  | ItemsReport
  | OperationsReport
  | ExpensesReport;
function OwnerSummary({ s }: { s: SalesSummary }) {
  return (
    <section
      aria-label="Food sold summary"
      className="report-summary dashboard-summary"
    >
      <article className="report-sales-hero">
        <span>FOOD SOLD</span>
        <strong data-metric="sales">{money(s.salesValue)}</strong>
        <small>
          Final value of food sold, including tax, after order changes and
          cancellations.
        </small>
      </article>
      <article>
        <span>BILLS</span>
        <strong data-metric="bills">{s.billCount}</strong>
      </article>
      <article className="dashboard-unpaid">
        <span>UNPAID</span>
        <strong data-metric="due">{money(s.outstandingDue)}</strong>
        <small>Money still to collect from bills in this period.</small>
      </article>
      <article>
        <span>AVG BILL</span>
        <strong>{money(s.averageBill)}</strong>
        <small>Food sold ÷ bills</small>
      </article>
    </section>
  );
}
function OwnerMoney({ d }: { d: DashboardReport }) {
  const p = d.payments,
    e = d.explanation,
    s = d.sales.summary;
  const reasons: string[] = [];
  if (e.collectionsForEarlierBills !== '0.00')
    reasons.push(
      `${money(e.collectionsForEarlierBills)} received during this period came from earlier bills.`,
    );
  if (e.collectionsForLaterBills !== '0.00')
    reasons.push(
      `${money(e.collectionsForLaterBills)} received during this period belongs to bills dated after this period.`,
    );
  if (s.outstandingDue !== '0.00')
    reasons.push(
      `${money(s.outstandingDue)} from bills in this period is still unpaid.`,
    );
  if (p.cashRefunds !== '0.00')
    reasons.push(
      `${money(p.cashRefunds)} was returned in cash during this period.`,
    );
  if (e.refundsForOtherBills !== '0.00')
    reasons.push(
      `${money(e.refundsForOtherBills)} of those returns belonged to bills outside this sales period.`,
    );
  if (s.refundDue !== '0.00')
    reasons.push(
      `${money(s.refundDue)} still needs to be returned for bills in this period.`,
    );
  if (e.selectedBillCollectionsOutsidePeriod !== '0.00')
    reasons.push(
      `${money(e.selectedBillCollectionsOutsidePeriod)} for bills in this period was received on other dates.`,
    );
  if (e.selectedBillRefundsOutsidePeriod !== '0.00')
    reasons.push(
      `${money(e.selectedBillRefundsOutsidePeriod)} was returned for these bills on other dates.`,
    );
  if (s.legacyDue !== '0.00')
    reasons.push(
      `${money(s.legacyDue)} of legacy balances needs review because historical receipts are unknown.`,
    );
  return (
    <section className="report-panel owner-money" aria-label="Money received">
      <h2>MONEY RECEIVED</h2>
      <dl className="report-money-grid">
        <div>
          <dt>Cash Received</dt>
          <dd data-metric="cash">{money(p.cashCollections)}</dd>
        </div>
        <div>
          <dt>UPI Received</dt>
          <dd data-metric="upi">{money(p.upiCollections)}</dd>
        </div>
        <div>
          <dt>Cash Returned</dt>
          <dd data-metric="refunds">{money(p.cashRefunds)}</dd>
        </div>
        <div className="owner-net">
          <dt>Net Money Received</dt>
          <dd data-metric="net">{money(p.netCollected)}</dd>
          <small>
            Cash + UPI received, minus cash returned during this period.
          </small>
        </div>
      </dl>
      <p className="report-caption">
        Payments can belong to bills from an earlier day. Net Money Received is
        not profit or cash-drawer balance.
      </p>
      {(reasons.length > 0 || s.salesValue !== p.netCollected) && (
        <div
          className="dashboard-explanation"
          aria-label="Food sold and money received explained"
        >
          <h3>
            {s.salesValue !== p.netCollected
              ? 'Why are these different?'
              : 'How these amounts relate'}
          </h3>
          {reasons.length > 0 ? (
            <ul>
              {reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : (
            <p>
              Food Sold follows bill dates and current order changes. Money
              Received follows payment dates.
            </p>
          )}
        </div>
      )}
      {s.refundDue !== '0.00' && (
        <div className="owner-refund-due">
          <strong>REFUND DUE</strong>
          <strong>{money(s.refundDue)}</strong>
          <span>
            Money still to return for bills in this period. This is separate
            from Unpaid.
          </span>
        </div>
      )}
    </section>
  );
}
function Summary({ s }: { s: SalesSummary }) {
  return (
    <section aria-label="Sales summary" className="report-summary">
      <article className="report-sales-hero">
        <span>Sales Value</span>
        <strong data-metric="sales">{money(s.salesValue)}</strong>
        <small>Effective food orders, including tax</small>
      </article>
      <article>
        <span>Bills</span>
        <strong data-metric="bills">{s.billCount}</strong>
        <small>
          {s.openBills} open · {s.closedBills} closed
        </small>
      </article>
      <article>
        <span>Average Bill</span>
        <strong>{money(s.averageBill)}</strong>
        <small>Sales ÷ distinct bills</small>
      </article>
      <article>
        <span>Customer Due</span>
        <strong data-metric="due">{money(s.outstandingDue)}</strong>
        <small>{s.billsWithDue} bills with an amount due</small>
      </article>
    </section>
  );
}
function PaymentSummary({ p }: { p: PaymentsReport }) {
  return (
    <section className="report-panel" aria-label="Payment cash flow">
      <h2>Payment cash flow</h2>
      <p className="report-caption">
        Money recorded during these restaurant dates, including settlement of
        older bills.
      </p>
      <dl className="report-money-grid">
        <div>
          <dt>Cash Collected</dt>
          <dd data-metric="cash">{money(p.cashCollections)}</dd>
          <small>{p.cashTransactions} transactions</small>
        </div>
        <div>
          <dt>UPI Collected</dt>
          <dd data-metric="upi">{money(p.upiCollections)}</dd>
          <small>{p.upiTransactions} transactions</small>
        </div>
        <div>
          <dt>Cash Refunds</dt>
          <dd data-metric="refunds">{money(p.cashRefunds)}</dd>
          <small>{p.refundTransactions} transactions</small>
        </div>
        <div>
          <dt>Net Collected</dt>
          <dd data-metric="net">{money(p.netCollected)}</dd>
          <small>Collections − refunds paid</small>
        </div>
      </dl>
      <p>
        Total collections {money(p.totalCollections)}. Refunds settle
        overpayment; they are not subtracted again from Sales Value.
      </p>
    </section>
  );
}
function Balances({
  due,
  refund,
  legacy,
}: {
  due: string;
  refund: string;
  legacy: string;
}) {
  return (
    <section className="report-panel">
      <h2>Current balances of selected bills</h2>
      <p>These balances are current now, not a historical closing balance.</p>
      <dl className="report-money-grid">
        <div>
          <dt>Customer Due</dt>
          <dd>{money(due)}</dd>
        </div>
        <div>
          <dt>Refund Due</dt>
          <dd>{money(refund)}</dd>
        </div>
      </dl>
      {legacy !== '0.00' && (
        <p className="notice">
          Legacy balance requiring review: {money(legacy)}. Historical receipts
          were not recorded; this is not confirmed customer debt.
        </p>
      )}
    </section>
  );
}
function Trend({
  trend,
  owner = false,
}: {
  trend: SalesTrend;
  owner?: boolean;
}) {
  const amounts = trend.buckets.map((b) =>
    BigInt(b.salesValue.replace('.', '')),
  );
  const max = amounts.reduce((m, v) => (v > m ? v : m), 0n);
  const peak = trend.buckets[amounts.findIndex((v) => v === max)];
  const label = (key: string) =>
    trend.granularity === 'HOUR'
      ? `${key}:00–${String(Number(key) + 1).padStart(2, '0')}:00`
      : key;
  return (
    <section className="report-panel">
      <h2>
        {owner ? 'Food Sold' : 'Sales'} by{' '}
        {trend.granularity === 'HOUR' ? 'Hour' : 'Day'}
      </h2>
      <p className="report-caption">
        Effective values attributed to original Kitchen-round confirmation time.
      </p>
      {max > 0n && peak && (
        <p>
          Peak {trend.granularity === 'HOUR' ? 'hour' : 'day'}:{' '}
          {label(peak.key)} · {money(peak.salesValue)}
        </p>
      )}
      <div
        className="report-trend"
        role="region"
        aria-label="Sales trend values"
        tabIndex={0}
      >
        {trend.buckets.map((b, i) => (
          <div className="report-trend-row" key={b.key}>
            <span>{label(b.key)}</span>
            <strong>{money(b.salesValue)}</strong>
            <div className="report-bar-track" aria-hidden="true">
              <div
                style={{
                  width: `${max ? Number((amounts[i]! * 10000n) / max) / 100 : 0}%`,
                }}
              />
            </div>
          </div>
        ))}
      </div>
      {trend.outsidePeriodSales !== '0.00' && (
        <p className="notice">
          Older multi-day bills: {money(trend.outsidePeriodSales)} belongs to
          rounds confirmed outside this date range. This separate bucket is
          included in Sales Value.
        </p>
      )}
    </section>
  );
}
function ItemList({ items }: { items: ReportItem[] }) {
  return (
    <ol className="report-items">
      {items.map((i) => (
        <li key={i.menuItemId + ':' + i.variantId}>
          <strong>
            {i.variantName} {i.itemName}
          </strong>
          <span>Quantity {i.quantity}</span>
          <span>{money(i.salesValue)} before tax</span>
        </li>
      ))}
    </ol>
  );
}
function ServiceTypes({ sales }: { sales: SalesReport }) {
  return (
    <section className="report-panel">
      <h2>Dine In vs Takeaway</h2>
      {sales.serviceTypes.length ? (
        <dl className="report-money-grid">
          {sales.serviceTypes.map((s) => (
            <div key={s.serviceType}>
              <dt>
                {s.serviceType === 'UNKNOWN'
                  ? 'Unknown / Legacy'
                  : s.serviceType === 'DINE_IN'
                    ? 'Dine In'
                    : 'Takeaway'}
              </dt>
              <dd>{money(s.salesValue)}</dd>
              <small>{s.billCount} bills</small>
            </div>
          ))}
        </dl>
      ) : (
        <p>No bills in this period.</p>
      )}
      {sales.summary.legacyBills > 0 && (
        <p>
          {sales.summary.legacyBills} legacy bills have unknown service/payment
          history. No receipts are inferred.
        </p>
      )}
    </section>
  );
}
function Operations({ o }: { o: OperationsReport }) {
  return (
    <section className="report-panel">
      <h2>Operations</h2>
      <p>
        <strong>
          {o.billCount} Bills · {o.kitchenRounds} Kitchen Rounds
        </strong>
      </p>
      <p className="report-caption">
        Current status of rounds on the selected bills.
      </p>
      <dl className="report-statuses">
        {o.statuses.map((s) => (
          <div key={s.status}>
            <dt>{s.status.toLowerCase()}</dt>
            <dd>{s.count}</dd>
          </div>
        ))}
      </dl>
      <h3>Bills by service</h3>
      <ul>
        {o.serviceTypes.map((s) => (
          <li key={s.serviceType}>
            {s.serviceType === 'UNKNOWN'
              ? 'Unknown / Legacy'
              : s.serviceType === 'DINE_IN'
                ? 'Dine In'
                : 'Takeaway'}
            : {s.billCount} bills
          </li>
        ))}
      </ul>
      <h3>Amendments: {o.amendments}</h3>
      <p>
        Revisions recorded in this period, including cancellation revisions.
      </p>
      {o.amendmentReasons.length > 0 && (
        <ul>
          {o.amendmentReasons.map((r) => (
            <li key={r.reason}>
              {r.reason.replaceAll('_', ' ')}: {r.count}
            </li>
          ))}
        </ul>
      )}
      <h3>Kitchen turnaround</h3>
      <p>
        {o.averageQueuedToReadySeconds === null
          ? 'No READY timestamps in this bill cohort.'
          : `${o.averageQueuedToReadySeconds} seconds average · ${o.readySampleCount} rounds reached READY`}
      </p>
      <small>
        Original QUEUED → first READY, including waiting time. Unready/cancelled
        rounds are excluded.
      </small>
    </section>
  );
}
export function ReportsWorkspace({ dashboard }: { dashboard: boolean }) {
  const [tab, setTab] = useState<Tab>('sales');
  const [choice, setChoice] = useState<ReportPreset>('TODAY');
  const [periodQuery, setPeriodQuery] = useState('period=TODAY');
  const [from, setFrom] = useState(''),
    [to, setTo] = useState('');
  const [sort, setSort] = useState<'QUANTITY' | 'SALES'>('QUANTITY'),
    [page, setPage] = useState(1);
  const [data, setData] = useState<Result>(),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true);
  const sequence = useRef(0),
    inFlight = useRef(false);
  const endpoint = dashboard ? '/dashboard' : `/reports/${tab}`;
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    inFlight.current = true;
    setLoading(true);
    setData(undefined);
    setError('');
    try {
      const next = await api<Result>(
        `${endpoint}?${periodQuery}${!dashboard && tab === 'items' ? `&sort=${sort}&page=${page}` : ''}`,
      );
      if (request === sequence.current) setData(next);
    } catch (e) {
      if (request === sequence.current) setError(errorMessage(e));
    } finally {
      if (request === sequence.current) {
        setLoading(false);
        inFlight.current = false;
      }
    }
  }, [endpoint, periodQuery, dashboard, tab, sort, page]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (
        periodQuery === 'period=TODAY' &&
        !document.hidden &&
        !inFlight.current
      )
        void refresh();
    }, 60000);
    return () => {
      sequence.current++;
      clearInterval(timer);
    };
  }, [refresh, periodQuery]);
  const period: ReportPeriod | undefined = data?.period;
  const d = dashboard ? (data as DashboardReport | undefined) : undefined;
  const sales =
    d?.sales ??
    (!dashboard && tab === 'sales'
      ? (data as SalesReport | undefined)
      : undefined);
  const payments =
    d?.payments ??
    (!dashboard && tab === 'payments'
      ? (data as PaymentsReport | undefined)
      : undefined);
  const items =
    !dashboard && tab === 'items'
      ? (data as ItemsReport | undefined)
      : undefined;
  const operations =
    d?.operations ??
    (!dashboard && tab === 'operations'
      ? (data as OperationsReport | undefined)
      : undefined);
  return (
    <section className="reports-workspace">
      <div className="report-heading">
        <div>
          <h1>{dashboard ? 'Dashboard' : 'Reports'}</h1>
          <p>Restaurant performance · INR</p>
        </div>
        <button
          className="secondary"
          disabled={loading}
          onClick={() => void refresh()}
        >
          Refresh
        </button>
      </div>
      <div className="report-filters">
        <label>
          Period
          <select
            aria-label="Report period"
            value={choice}
            onChange={(e) => {
              const next = e.target.value as ReportPreset;
              setChoice(next);
              if (next === 'CUSTOM') {
                setFrom(period?.from ?? '');
                setTo(period?.to ?? '');
              } else {
                setPage(1);
                setPeriodQuery('period=' + next);
              }
            }}
          >
            {presets.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        {choice === 'CUSTOM' && (
          <form
            className="report-custom"
            onSubmit={(e) => {
              e.preventDefault();
              if (!from || !to || from > to) {
                setError('Choose From and To dates in order.');
                return;
              }
              setPage(1);
              setPeriodQuery(
                `period=CUSTOM&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
              );
            }}
          >
            <label>
              From
              <input
                aria-label="Report from"
                type="date"
                required
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </label>
            <label>
              To
              <input
                aria-label="Report to"
                type="date"
                required
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </label>
            <button>Apply period</button>
          </form>
        )}
      </div>
      {!dashboard && (
        <nav className="report-tabs" aria-label="Report sections">
          {(
            ['sales', 'payments', 'items', 'operations', 'expenses'] as const
          ).map((t) => (
            <button
              className={tab === t ? '' : 'secondary'}
              aria-pressed={tab === t}
              key={t}
              onClick={() => {
                if (tab === t) return;
                sequence.current++;
                setData(undefined);
                setTab(t);
                setPage(1);
              }}
            >
              {t[0]!.toUpperCase() + t.slice(1)}
            </button>
          ))}
        </nav>
      )}
      {loading && (
        <p role="status">Loading {dashboard ? 'dashboard' : 'report'}…</p>
      )}
      {error && (
        <div role="alert" className="notice">
          <p>{error}</p>
          <button onClick={() => void refresh()}>Retry report</button>
        </div>
      )}
      {period && (
        <p className="report-period">
          {period.from} → {period.to} · {period.timezone} · Updated{' '}
          {new Date(period.asOf).toLocaleTimeString('en-IN', {
            timeZone: period.timezone,
          })}
        </p>
      )}
      {sales && (
        <>
          {dashboard ? (
            <OwnerSummary s={sales.summary} />
          ) : (
            <Summary s={sales.summary} />
          )}
          {sales.summary.salesValue === '0.00' && (
            <p className="report-empty">
              {period?.preset === 'TODAY'
                ? dashboard
                  ? 'No food sold yet today.'
                  : 'No sales yet today.'
                : dashboard
                  ? 'No food sold in this period.'
                  : 'No sales in this period.'}
            </p>
          )}
          {!dashboard && (
            <p className="report-caption">
              Sales use current effective bill totals, whether paid or unpaid.
              Refund payments do not reduce sales a second time.
            </p>
          )}
        </>
      )}
      {d && (
        <section className="report-panel dashboard-expenses">
          <h2>RECORDED EXPENSES</h2>
          <strong data-metric="expenses">{money(d.recordedExpenses)}</strong>
          <p className="report-caption">
            Expenses recorded for this period, excluding voided entries. Shown
            separately from sales and customer payments.
          </p>
        </section>
      )}
      {!dashboard && tab === 'expenses' && data && (
        <ExpenseSummary
          data={data as ExpensesReport}
          trend={(data as ExpensesReport).trend}
        />
      )}
      {d ? <OwnerMoney d={d} /> : payments && <PaymentSummary p={payments} />}
      {sales && <Trend trend={sales.trend} owner={dashboard} />}
      {d && (
        <div className="report-columns">
          <section className="report-panel">
            <h2>Top Selling Items</h2>
            {d.topItems.length ? (
              <ItemList items={d.topItems} />
            ) : (
              <p>No effective items in this period.</p>
            )}
            <p className="report-caption">
              By quantity · portions stay separate · snapshot prices before tax.
            </p>
          </section>
          <ServiceTypes sales={d.sales} />
        </div>
      )}
      {sales && !dashboard && <ServiceTypes sales={sales} />}
      {payments && !dashboard && (
        <Balances
          due={payments.outstandingDue}
          refund={payments.refundDue}
          legacy={payments.legacyDue}
        />
      )}
      {sales && !dashboard && (
        <Balances
          due={sales.summary.outstandingDue}
          refund={sales.summary.refundDue}
          legacy={sales.summary.legacyDue}
        />
      )}
      {items && (
        <section className="report-panel">
          <h2>Items / Portions</h2>
          <p>
            Effective items only. Names use the latest sale snapshot in this
            bill cohort. Values exclude order-level tax.
          </p>
          <label>
            Sort items
            <select
              aria-label="Sort report items"
              value={sort}
              onChange={(e) => {
                setSort(e.target.value as 'QUANTITY' | 'SALES');
                setPage(1);
              }}
            >
              <option value="QUANTITY">By Quantity</option>
              <option value="SALES">By Sales Value</option>
            </select>
          </label>
          <p>
            {items.totalQuantity} portions · {money(items.totalSalesValue)}{' '}
            before tax · {items.totalItems} item/variant groups
          </p>
          {items.items.length ? (
            <ItemList items={items.items} />
          ) : (
            <p>No effective items on this page.</p>
          )}
          <div className="report-pagination">
            <button disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
              Previous page
            </button>
            <span>Page {items.page}</span>
            <button
              disabled={page * items.pageSize >= items.totalItems}
              onClick={() => setPage((p) => p + 1)}
            >
              Next page
            </button>
          </div>
        </section>
      )}
      {operations &&
        (dashboard ? (
          <details className="dashboard-operations">
            <summary>Operations summary</summary>
            <Operations o={operations} />
          </details>
        ) : (
          <Operations o={operations} />
        ))}
    </section>
  );
}
