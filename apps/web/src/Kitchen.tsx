import { serviceLabel } from './service-label';
import { confirmationId } from './order-cart';
import { ServingLabel, SourceLabel } from './ServingLabel';
import { KitchenTimers } from './KitchenTimers';
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
function OrderItems({
  order,
  enabled,
  serve,
}: {
  order: KitchenOrder;
  enabled: boolean;
  serve: (
    line: KitchenOrder['items'][number],
    quantity: number,
    reason: string,
  ) => void;
}) {
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
            <div
              key={line.id}
              className={`kds-line ${line.pendingQuantity === 0 ? 'kds-served' : ''}`}
            >
              <p>
                {line.variantName} <strong>×{line.quantity}</strong>
              </p>
              <ServingLabel serving={line.serving} />
              {line.instruction && (
                <p className="kds-instruction">{line.instruction}</p>
              )}
              {order.serviceType === 'DINE_IN' && (
                <>
                  <p>
                    {line.pendingQuantity === 0
                      ? 'SERVED'
                      : `${line.pendingQuantity ?? line.quantity} pending`}{' '}
                    · {line.servedQuantity ?? 0} served
                  </p>
                  {enabled && (
                    <ServingControls
                      key={`${line.id}:${line.servedQuantity}`}
                      line={line}
                      onServe={(quantity, reason) =>
                        serve(line, quantity, reason)
                      }
                    />
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
function ServingControls({
  line,
  onServe,
}: {
  line: KitchenOrder['items'][number];
  onServe: (quantity: number, reason: string) => void;
}) {
  const remaining = line.pendingQuantity ?? line.quantity;
  const [quantity, setQuantity] = useState(remaining || 1);
  const [correct, setCorrect] = useState(false);
  const [reason, setReason] = useState('');
  const max = correct ? (line.servedQuantity ?? 0) : remaining;
  return (
    <form
      className="kds-serve-controls"
      onSubmit={(e) => {
        e.preventDefault();
        onServe(correct ? -quantity : quantity, reason);
      }}
    >
      {max > 0 && (
        <>
          <label>
            {correct ? 'Quantity to correct' : 'Quantity to serve'}
            <input
              type="number"
              min={1}
              max={max}
              required
              value={quantity}
              onChange={(e) => setQuantity(Number(e.target.value))}
            />
          </label>
          {correct && (
            <label>
              Correction reason
              <input
                required
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
          )}
          <button
            type="submit"
            disabled={
              !Number.isInteger(quantity) ||
              quantity < 1 ||
              quantity > max ||
              (correct && !reason.trim())
            }
          >
            {correct ? 'Record correction' : 'Serve'}
          </button>
        </>
      )}
      {!!line.servedQuantity && (
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setCorrect(!correct);
            setQuantity(1);
          }}
        >
          {correct ? 'Back to serving' : 'Correct served quantity'}
        </button>
      )}
    </form>
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
            <SourceLabel source={g.source ?? 'COUNTER'} />
            <ServingLabel serving={g.serving} />
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
            <ul className="kds-production-sources">
              {g.sources.map((source) => (
                <li key={`${source.orderId}:${source.lineId}`}>
                  Token #{source.tokenNumber} ·{' '}
                  {g.source && g.source !== 'COUNTER'
                    ? g.source
                    : serviceLabel(source.serviceType)}
                  {source.reference ? ` · ${source.reference}` : ''} · ×
                  {source.quantity}
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
  userId,
  canReadTimers,
  canManageTimers,
  canUpdate,
  canManageAvailability,
}: {
  userId: string;
  canReadTimers: boolean;
  canManageTimers: boolean;
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
  async function transition(
    order: KitchenOrder,
    line?: KitchenOrder['items'][number],
    quantity?: number,
    reason = '',
  ) {
    if (acting.current) return;
    acting.current = true;
    sequence.current++;
    inFlight.current = false;
    setPending(order.orderId);
    setFeedback('');
    try {
      await api(
        `/kitchen/orders/${order.orderId}/${line ? `lines/${line.id}/serve` : 'fulfill'}`,
        'POST',
        {
          requestId: confirmationId(),
          expectedRevision: order.revision,
          ...(line
            ? {
                expectedServedQuantity: line.servedQuantity ?? 0,
                quantity,
                reason,
              }
            : {}),
        },
      );
      if (mounted.current)
        setFeedback(
          `Token #${order.tokenNumber} ${line ? 'serving updated' : 'handed over'}.`,
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
          <p>Oldest tokens first · Serve food as it is ready</p>
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
      {canReadTimers && (
        <KitchenTimers
          userId={userId}
          canManage={canManageTimers}
          orders={state?.pending ?? []}
        />
      )}
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
              Pending quantities only. Serve or hand over in Order View.
            </p>
            <div className="kds-production-sections">
              <Production
                groups={state.production.pending}
                label="Pending production"
              />
            </div>
          </>
        ) : (
          <div className="kds-columns">
            {(['PENDING'] as const).map((status) => {
              const orders = state.pending;
              return (
                <section
                  className="kds-column"
                  key={status}
                  aria-label="Pending orders"
                >
                  <h2>
                    Pending orders <span>{orders.length}</span>
                  </h2>
                  {!orders.length && (
                    <p className="kds-empty">No orders waiting.</p>
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
                      const next = state.pending[0]?.orderId === order.orderId;
                      const fresh =
                        (arrivals.current.get(order.orderId) ?? 0) >
                        performance.now();
                      return (
                        <article
                          className={`kds-card ${next ? 'kds-next' : ''} ${fresh ? 'kds-new' : ''} ${late ? 'kds-late' : ''}`}
                          key={order.orderId}
                          data-order-id={order.orderId}
                        >
                          <SourceLabel
                            source={order.source ?? 'COUNTER'}
                            reference={order.externalReference}
                          />
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
                              Waiting {duration(order.queuedAt, now)}
                            </p>
                          </div>
                          {showDate && (
                            <time className="kds-date">
                              {order.businessDate}
                            </time>
                          )}
                          {(order.source ?? 'COUNTER') === 'COUNTER' && (
                            <p className="kds-service">
                              <strong>{serviceLabel(order.serviceType)}</strong>
                              {order.reference && (
                                <span> · {order.reference}</span>
                              )}
                            </p>
                          )}
                          <OrderItems
                            order={order}
                            enabled={canUpdate && !pending}
                            serve={(line, quantity, reason) =>
                              void transition(order, line, quantity, reason)
                            }
                          />
                          {canUpdate && order.serviceType !== 'DINE_IN' && (
                            <button
                              className="kds-action"
                              disabled={!!pending}
                              onClick={() => void transition(order)}
                            >
                              {pending === order.orderId
                                ? 'Updating…'
                                : 'Ready & Handed Over'}
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
