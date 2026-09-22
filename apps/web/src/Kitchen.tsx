import { KitchenAvailability } from './KitchenAvailability';
import { instructionBreakdown, isLate } from './kitchen-presentation';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  KitchenOrder,
  KitchenState,
  ProductionGroup,
} from '@dukanos/shared-types';
import { api, errorMessage } from './api';
function duration(since: string, now: number) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(since)) / 60000));
  return minutes < 1 ? '<1 min' : `${minutes} min`;
}
function OrderItems({ order }: { order: KitchenOrder }) {
  const groups = new Map<string, typeof order.items>();
  for (const item of order.items) {
    const key = JSON.stringify([
      item.menuItemId,
      item.itemName,
      item.kitchenName,
    ]);
    const lines = groups.get(key) ?? [];
    lines.push(item);
    groups.set(key, lines);
  }
  return (
    <div className="kds-lines">
      {[...groups].map(([key, lines]) => (
        <div key={key} className="kds-dish">
          <h3>{lines[0]!.kitchenName}</h3>
          {lines.map((line) => (
            <div key={line.id} className="kds-line">
              <p>
                {line.variantName} <strong>×{line.quantity}</strong>
              </p>
              {line.instruction && (
                <p className="kds-instruction">{line.instruction}</p>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
function Production({
  groups,
  label,
}: {
  groups: ProductionGroup[];
  label: string;
}) {
  return (
    <section className="kds-column kds-production-section" aria-label={label}>
      <h2>
        {label} <span>{groups.length}</span>
      </h2>
      <div className="kds-production-grid">
        {groups.map((g) => (
          <article className="kds-card kds-production" key={g.key}>
            <div className="kds-production-total">
              <h3>{`${g.variantName} ${g.itemName}`.toUpperCase()}</h3>
              <strong>×{g.totalQuantity}</strong>
            </div>
            <ul className="kds-breakdown">
              {instructionBreakdown(g.sources).map((part) => (
                <li key={part.instruction}>
                  <span className={part.instruction ? 'kds-exception' : ''}>
                    {part.instruction || 'Normal'}
                  </span>
                  <strong>×{part.quantity}</strong>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </section>
  );
}
export function Kitchen({
  canUpdate,
  canManageAvailability,
}: {
  canUpdate: boolean;
  canManageAvailability: boolean;
}) {
  const [availabilityOpen, setAvailabilityOpen] = useState(false);
  const [state, setState] = useState<KitchenState | null>(null);
  const [mode, setMode] = useState<'orders' | 'production'>('orders');
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
      const next = await api<KitchenState>('/kitchen/orders');
      if (!mounted.current || request !== sequence.current) return;
      const now = performance.now();
      for (const o of next.queued)
        if (seen.current && !seen.current.has(o.orderId))
          arrivals.current.set(o.orderId, now + 8000);
      for (const [id, until] of arrivals.current)
        if (until < now) arrivals.current.delete(id);
      seen.current = new Set(
        [...next.queued, ...next.preparing].map((o) => o.orderId),
      );
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
  async function transition(order: KitchenOrder) {
    if (acting.current) return;
    acting.current = true;
    sequence.current++;
    inFlight.current = false;
    setPending(order.orderId);
    setFeedback('');
    try {
      await api(
        `/kitchen/orders/${order.orderId}/${order.status === 'QUEUED' ? 'start' : 'ready'}`,
        'POST',
      );
      if (mounted.current)
        setFeedback(
          `Token #${order.tokenNumber} ${order.status === 'QUEUED' ? 'started' : 'ready'}.`,
        );
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
  // Tick rerenders locally; the clock uses the server sample plus monotonic elapsed time.
  const now = clock.current.server + performance.now() - clock.current.received;
  const multipleDates = state
    ? new Set([...state.queued, ...state.preparing].map((o) => o.businessDate))
        .size > 1
    : false;
  return (
    <div className="kds">
      <div className="kds-toolbar">
        <div>
          <h1>Kitchen</h1>
          <p>Oldest token starts first</p>
        </div>
        <div className="kds-modes" role="group" aria-label="Kitchen views">
          <button
            aria-pressed={mode === 'orders'}
            onClick={() => setMode('orders')}
          >
            Order View
          </button>
          <button
            aria-pressed={mode === 'production'}
            onClick={() => setMode('production')}
          >
            Production View
          </button>
          {canManageAvailability && (
            <button onClick={() => setAvailabilityOpen(true)}>
              Availability
            </button>
          )}
        </div>
      </div>
      {feedback && (
        <p role="status" className="notice">
          {mode === 'production'
            ? feedback.replace(/^Token #\d+ /, 'Order ')
            : feedback}
        </p>
      )}
      {error && (
        <div role="alert">
          <p>{error} Kitchen actions are paused until the queue refreshes.</p>
          <button onClick={() => void refresh(true)}>Retry connection</button>
        </div>
      )}
      {!state && !error && <p role="status">Loading Kitchen…</p>}
      {state &&
        (mode === 'production' ? (
          <>
            <p className="kds-help">
              Quantities follow whole orders. Start and mark ready in Order
              View.
            </p>
            <div className="kds-production-sections">
              <Production groups={state.production.queued} label="To start" />
              <Production
                groups={state.production.preparing}
                label="In preparation"
              />
            </div>
          </>
        ) : (
          <div className="kds-columns">
            {(['QUEUED', 'PREPARING'] as const).map((status) => {
              const orders =
                status === 'QUEUED' ? state.queued : state.preparing;
              return (
                <section
                  className={`kds-column ${status === 'PREPARING' ? 'kds-preparing' : ''}`}
                  key={status}
                  aria-label={status === 'QUEUED' ? 'Queued' : 'Preparing'}
                >
                  <h2>
                    {status === 'QUEUED' ? 'Queued' : 'Preparing'}{' '}
                    <span>{orders.length}</span>
                  </h2>
                  {!orders.length && (
                    <p className="kds-empty">
                      {status === 'QUEUED'
                        ? 'No orders waiting.'
                        : 'No orders in preparation.'}
                    </p>
                  )}
                  <div className="kds-order-grid">
                    {orders.map((order) => {
                      const late = isLate(
                        order.queuedAt,
                        now,
                        state.lateThresholdMinutes,
                      );
                      const showDate =
                        order.businessDate !== state.businessDate ||
                        multipleDates;
                      const next = state.nextOrderId === order.orderId;
                      const fresh =
                        (arrivals.current.get(order.orderId) ?? 0) >
                        performance.now();
                      return (
                        <article
                          className={`kds-card ${next ? 'kds-next' : ''} ${fresh ? 'kds-new' : ''} ${late ? 'kds-late' : ''}`}
                          key={order.orderId}
                          data-order-id={order.orderId}
                        >
                          <div className="kds-token-row">
                            <h3 className="kds-token">#{order.tokenNumber}</h3>
                            {next && (
                              <strong className="kds-badge">NEXT</strong>
                            )}
                            {fresh && <span className="kds-badge">NEW</span>}
                            {late && (
                              <strong className="kds-late-badge">
                                LATE · {duration(order.queuedAt, now)}
                              </strong>
                            )}
                            <p className="kds-age">
                              {status === 'QUEUED' ? 'Waiting' : 'Preparing'}{' '}
                              {duration(
                                status === 'QUEUED'
                                  ? order.queuedAt
                                  : order.preparingAt!,
                                now,
                              )}
                            </p>
                          </div>
                          {showDate && (
                            <time className="kds-date">
                              {order.businessDate}
                            </time>
                          )}
                          <OrderItems order={order} />
                          {canUpdate && (
                            <button
                              className="kds-action"
                              disabled={
                                !!pending || (status === 'QUEUED' && !next)
                              }
                              onClick={() => void transition(order)}
                            >
                              {pending === order.orderId
                                ? 'Updating…'
                                : status === 'PREPARING'
                                  ? 'Mark Ready'
                                  : next
                                    ? 'Start Order'
                                    : 'Waiting for older token'}
                            </button>
                          )}
                        </article>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        ))}
      {availabilityOpen && canManageAvailability && (
        <KitchenAvailability onClose={() => setAvailabilityOpen(false)} />
      )}
    </div>
  );
}
