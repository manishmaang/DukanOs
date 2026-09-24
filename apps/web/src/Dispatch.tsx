import { useCallback, useEffect, useRef, useState } from 'react';
import type { DispatchOrder, DispatchState } from '@dukanos/shared-types';
import { api, errorMessage } from './api';
import { isLate } from './kitchen-presentation';
function duration(since: string, now: number) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(since)) / 60000));
  return minutes < 1 ? '<1 min' : `${minutes} min`;
}
function Items({ order }: { order: DispatchOrder }) {
  const groups = new Map<string, typeof order.items>();
  for (const item of order.items) {
    const key = JSON.stringify([item.menuItemId, item.itemName]);
    const lines = groups.get(key) ?? [];
    lines.push(item);
    groups.set(key, lines);
  }
  return (
    <div className="dispatch-lines">
      {[...groups].map(([key, lines]) => (
        <div className="dispatch-dish" key={key}>
          <h3>{lines[0]!.itemName}</h3>
          {lines.map((line) => (
            <div key={line.id} className="dispatch-line">
              <p>
                {line.variantName} <strong>×{line.quantity}</strong>
              </p>
              {line.instruction && (
                <p className="dispatch-note">Note: {line.instruction}</p>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
export function Dispatch({
  canComplete,
  canCollect = false,
}: {
  canComplete: boolean;
  canCollect?: boolean;
}) {
  const [state, setState] = useState<DispatchState | null>(null);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const clock = useRef({ server: Date.now(), received: performance.now() });
  const sequence = useRef(0);
  const inFlight = useRef(false);
  const acting = useRef(false);
  const mounted = useRef(true);
  const seen = useRef<Set<string> | null>(null);
  const arrivals = useRef(new Map<string, number>());
  const refresh = useCallback(async (force = false) => {
    if (!force && (inFlight.current || acting.current || document.hidden))
      return;
    inFlight.current = true;
    const request = ++sequence.current;
    try {
      const next = await api<DispatchState>('/dispatch/orders');
      if (!mounted.current || request !== sequence.current) return;
      const now = performance.now();
      for (const o of next.orders)
        if (seen.current && !seen.current.has(o.orderId))
          arrivals.current.set(o.orderId, now + 8000);
      for (const [id, until] of arrivals.current)
        if (until < now) arrivals.current.delete(id);
      seen.current = new Set(next.orders.map((o) => o.orderId));
      clock.current = { server: Date.parse(next.serverTime), received: now };
      setState(next);
      setError('');
    } catch (e) {
      if (!mounted.current || request !== sequence.current) return;
      setState(null);
      setError(errorMessage(e));
    } finally {
      if (request === sequence.current) inFlight.current = false;
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh(true);
    const resume = () => {
      if (!document.hidden) void refresh();
    };
    const poll = window.setInterval(resume, 2000);
    const timer = window.setInterval(() => setTick((t) => t + 1), 1000);
    window.addEventListener('focus', resume);
    window.addEventListener('online', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      mounted.current = false;
      sequence.current++;
      inFlight.current = false;
      window.clearInterval(poll);
      window.clearInterval(timer);
      window.removeEventListener('focus', resume);
      window.removeEventListener('online', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [refresh]);
  async function complete(order: DispatchOrder) {
    if (acting.current) return;
    acting.current = true;
    sequence.current++;
    inFlight.current = false;
    setPending(order.orderId);
    setFeedback('');
    try {
      await api(`/dispatch/orders/${order.orderId}/complete`, 'POST');
      if (mounted.current)
        setFeedback(`Token #${order.tokenNumber} handed over.`);
    } catch (e) {
      if (mounted.current) setFeedback(errorMessage(e));
    } finally {
      if (mounted.current) {
        await refresh(true);
        setPending(null);
      }
      acting.current = false;
    }
  }

  const now = clock.current.server + performance.now() - clock.current.received;
  const multipleDates = state
    ? new Set(state.orders.map((o) => o.businessDate)).size > 1
    : false;
  return (
    <div className="dispatch">
      <div className="dispatch-toolbar">
        <h1>Dispatch</h1>
        {state && <p>Ready: {state.orders.length}</p>}
      </div>
      {feedback && (
        <p role="status" className="notice">
          {feedback}
        </p>
      )}
      {error && (
        <div role="alert">
          <p>{error} Handover actions are paused until the queue refreshes.</p>
          <button onClick={() => void refresh(true)}>Retry connection</button>
        </div>
      )}
      {!state && !error && <p role="status">Loading Dispatch…</p>}
      {state && !state.orders.length && <p>No orders waiting for dispatch.</p>}
      {state && (
        <div className="dispatch-grid">
          {state.orders.map((order) => {
            const late = isLate(order.readyAt, now, state.lateThresholdMinutes);
            const fresh =
              (arrivals.current.get(order.orderId) ?? 0) > performance.now();
            return (
              <article
                key={order.orderId}
                data-order-id={order.orderId}
                className={`dispatch-card ${late ? 'dispatch-late' : ''} ${fresh ? 'dispatch-new' : ''}`}
              >
                <div className="dispatch-heading">
                  <h2>Token #{order.tokenNumber}</h2>
                  {fresh && <span className="dispatch-new-label">NEW</span>}
                </div>
                <p className="dispatch-age">
                  {late && <strong>LATE · </strong>}Ready{' '}
                  {duration(order.readyAt, now)}
                </p>
                {(multipleDates ||
                  order.businessDate !== state.businessDate) && (
                  <time>{order.businessDate}</time>
                )}
                {order.source !== 'COUNTER' && <p>{order.source}</p>}
                <p>
                  {order.serviceType?.replace('_', ' ') ??
                    'Legacy · service unknown'}{' '}
                  ·{' '}
                  {order.paymentStatus === 'PAID'
                    ? 'PAID'
                    : `DUE ₹${order.amountDue}`}
                </p>
                {canCollect &&
                  order.serviceType === 'TAKEAWAY' &&
                  order.paymentStatus !== 'PAID' && (
                    <a
                      className="bill-collect-link"
                      href={`#/pos?bill=${order.billId}`}
                    >
                      Collect Payment
                    </a>
                  )}
                <Items order={order} />
                {canComplete && (
                  <button
                    className="dispatch-action"
                    disabled={
                      !!pending ||
                      (order.serviceType === 'TAKEAWAY' &&
                        order.amountDue !== '0' &&
                        order.amountDue !== '0.00')
                    }
                    onClick={() => void complete(order)}
                  >
                    {pending === order.orderId
                      ? 'Updating…'
                      : order.serviceType === 'TAKEAWAY' &&
                          order.paymentStatus !== 'PAID'
                        ? 'Payment Required'
                        : 'Handed Over'}
                  </button>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
