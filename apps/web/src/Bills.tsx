import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BillDetail,
  BillList,
  BillSummary,
  CollectPaymentInput,
} from '@dukanos/shared-types';
import { api, ApiFailure, errorMessage } from './api';
import { confirmationId } from './order-cart';
import { rupees } from './menu-editor';
export function Bills({
  userId,
  initialId,
  onAdd,
  onBack,
  canCollect,
  canManage,
}: {
  canCollect: boolean;
  canManage: boolean;
  userId: string;
  initialId?: string;
  onAdd: (bill: BillSummary) => void;
  onBack: () => void;
}) {
  const [list, setList] = useState<BillList>();
  const [bill, setBill] = useState<BillDetail>();
  const [id, setId] = useState(initialId ?? '');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [value, setValue] = useState('');
  const [method, setMethod] = useState<'CASH' | 'UPI'>('CASH');
  const [pending, setPending] = useState<CollectPaymentInput>();
  const sending = useRef(false);
  const revision = useRef(0);
  const [recoveryBlocked, setRecoveryBlocked] = useState(false);
  const [cursor, setCursor] = useState<string>();
  const storageKey = `dukanos-pending-payment:${userId}:${id}`;
  const refresh = useCallback(async () => {
    if (sending.current) return;
    const current = ++revision.current;
    try {
      if (id) {
        const next = await api<BillDetail>(`/bills/${id}`);
        if (current === revision.current) setBill(next);
      } else {
        const next = await api<BillList>(
          `/bills?search=${encodeURIComponent(query)}${cursor ? '&after=' + cursor : ''}`,
        );
        if (current === revision.current) setList(next);
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [id, query, cursor]);
  useEffect(() => {
    setBill(undefined);
    setError('');
    setValue('');
    setRecoveryBlocked(false);
    try {
      const p = sessionStorage.getItem(storageKey);
      setPending(p ? JSON.parse(p) : undefined);
    } catch {
      setRecoveryBlocked(true);
      setError(
        'Could not restore payment recovery. Check payment history before recording another payment.',
      );
    }
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 3000);
    return () => {
      clearInterval(timer);
      revision.current++;
    };
  }, [refresh, storageKey]);
  async function collect() {
    if (sending.current) return;
    sending.current = true;
    revision.current++;
    setBusy(true);
    setError('');
    try {
      const request = pending ?? {
        requestId: confirmationId(),
        method,
        amount: value,
      };
      sessionStorage.setItem(storageKey, JSON.stringify(request));
      setPending(request);
      const next = await api<BillDetail>(
        `/bills/${id}/payments`,
        'POST',
        request,
      );
      setBill(next);
      sessionStorage.removeItem(storageKey);
      setPending(undefined);
      setValue('');
    } catch (e) {
      const definitive =
        e instanceof ApiFailure &&
        [400, 409, 413, 415].includes(e.status) &&
        e.code !== 'IDEMPOTENCY_CONFLICT';
      if (definitive) {
        sessionStorage.removeItem(storageKey);
        setPending(undefined);
      }
      setError(
        errorMessage(e) +
          (definitive
            ? ''
            : ' Retry the same payment to check its outcome; do not collect the money again.'),
      );
      void refresh();
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  async function close() {
    if (sending.current) return;
    sending.current = true;
    revision.current++;
    setBusy(true);
    try {
      setBill(await api<BillDetail>(`/bills/${id}/close`, 'POST'));
      setError('');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="bills-workspace">
      <div className="bill-toolbar">
        <h1>{id ? 'Bill details' : 'Open Bills'}</h1>
        <button className="secondary" disabled={busy} onClick={onBack}>
          Back to POS
        </button>
        {id && (
          <button
            className="secondary"
            disabled={busy}
            onClick={() => {
              setId('');
              setCursor(undefined);
              history.replaceState(null, '', '#/pos');
            }}
          >
            Open Bills
          </button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {!id && (
        <>
          <label>
            Find table, reference or bill number
            <input
              aria-label="Find bill"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setCursor(undefined);
              }}
            />
          </label>
          <div className="bill-grid">
            {list?.bills.map((b) => (
              <article className="bill-card" key={b.id}>
                <h2>{b.reference || `Bill #${b.billNumber}`}</h2>
                <p>
                  {b.serviceType?.replace('_', ' ') ??
                    'Legacy · service unknown'}{' '}
                  · #{b.billNumber} · {b.businessDate}
                </p>
                <p>
                  Total ₹{rupees(b.billTotal)} · Paid ₹{rupees(b.netPaid)}
                </p>
                <strong>
                  {b.paymentStatus === 'PAID'
                    ? 'PAID'
                    : `Due ₹${rupees(b.amountDue)}`}
                </strong>
                <button
                  onClick={() => {
                    setId(b.id);
                    history.replaceState(null, '', `#/pos?bill=${b.id}`);
                  }}
                >
                  Open bill
                </button>
              </article>
            ))}
          </div>
          {list && !list.bills.length && <p>No open bills found.</p>}
          {cursor && (
            <button onClick={() => setCursor(undefined)}>First page</button>
          )}
          {list?.nextCursor && (
            <button onClick={() => setCursor(list.nextCursor!)}>
              Next page
            </button>
          )}
        </>
      )}
      {id && !bill && <p role="status">Loading bill…</p>}
      {bill && (
        <>
          <h2>{bill.reference || `Bill #${bill.billNumber}`}</h2>
          <p>
            Bill #{bill.billNumber} · {bill.businessDate} ·{' '}
            {bill.serviceType?.replace('_', ' ') ?? 'Legacy · service unknown'}{' '}
            · {bill.status}
          </p>
          {bill.legacy && (
            <p>
              Imported order: service and historical payments were not recorded.
              Shown due is the recorded ledger balance, not proof of an unpaid
              historical sale.
            </p>
          )}
          <dl className="bill-totals">
            <div>
              <dt>Bill total</dt>
              <dd>₹{rupees(bill.billTotal)}</dd>
            </div>
            <div>
              <dt>Paid</dt>
              <dd>₹{rupees(bill.netPaid)}</dd>
            </div>
            <div>
              <dt>Amount due</dt>
              <dd>₹{rupees(bill.amountDue)}</dd>
            </div>
            {bill.refundDue !== '0.00' && (
              <div>
                <dt>Refund due</dt>
                <dd>₹{rupees(bill.refundDue)}</dd>
              </div>
            )}
          </dl>
          <p className="bill-payment-status">
            {bill.paymentStatus.replace('_', ' ')}
          </p>
          {bill.status === 'OPEN' && (
            <div className="bill-toolbar">
              <button
                disabled={busy || !!pending || recoveryBlocked}
                onClick={() => onAdd(bill)}
              >
                Add Items
              </button>
              <button
                className="secondary"
                disabled={
                  !canManage ||
                  busy ||
                  !!pending ||
                  bill.amountDue !== '0.00' ||
                  bill.refundDue !== '0.00' ||
                  bill.orders.some((o) => o.status !== 'COMPLETED')
                }
                onClick={() => void close()}
              >
                Close Bill
              </button>
              <p>
                Close after settlement and completion of every Kitchen round.
              </p>
            </div>
          )}
          {canCollect &&
            ((bill.status === 'OPEN' && bill.amountDue !== '0.00') ||
              pending) && (
              <form
                className="bill-payment"
                onSubmit={(e) => {
                  e.preventDefault();
                  void collect();
                }}
              >
                <h2>Record received payment</h2>
                <p>
                  Record money already received at Counter. UPI is verified by
                  staff, not by DukanOS.
                </p>
                {pending ? (
                  <p role="status">
                    Check pending {pending.method} payment ₹{pending.amount}.
                    Retry safely; do not take payment again.
                  </p>
                ) : (
                  <>
                    <label>
                      Amount (₹)
                      <input
                        aria-label="Payment amount"
                        inputMode="decimal"
                        required
                        pattern="(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,2})?"
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                      />
                    </label>
                    <label>
                      Method
                      <select
                        aria-label="Payment method"
                        value={method}
                        onChange={(e) =>
                          setMethod(e.target.value as 'CASH' | 'UPI')
                        }
                      >
                        <option value="CASH">Cash</option>
                        <option value="UPI">UPI</option>
                      </select>
                    </label>
                  </>
                )}
                <button disabled={busy || recoveryBlocked}>
                  {busy
                    ? 'Checking…'
                    : pending
                      ? 'Retry payment'
                      : 'Record Payment'}
                </button>
              </form>
            )}
          <h2>Kitchen rounds</h2>
          <ul className="bill-rounds">
            {bill.orders.map((o) => (
              <li key={o.id}>
                Token #{o.tokenNumber} · {o.businessDate} · {o.status} · ₹
                {rupees(o.grandTotal)}
              </li>
            ))}
          </ul>
          <h2>Payment history</h2>
          {!bill.payments.length && <p>No payments recorded.</p>}
          <ul className="bill-history">
            {bill.payments.map((p) => (
              <li key={p.id}>
                <strong>
                  {p.method} ₹{rupees(p.amount)}
                </strong>
                <span>
                  {new Date(p.createdAt).toLocaleString()} · {p.actorName}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
