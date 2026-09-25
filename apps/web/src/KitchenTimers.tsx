import { useEffect, useRef, useState } from 'react';
import type {
  KitchenOrder,
  KitchenTimer,
  TimerInput,
} from '@dukanos/shared-types';
import { api, ApiFailure, errorMessage } from './api';
import { confirmationId } from './order-cart';
import { useOperationalAlerts, countdown } from './useOperationalAlerts';
export function KitchenTimers({
  userId,
  canManage,
  orders,
}: {
  userId: string;
  canManage: boolean;
  orders: KitchenOrder[];
}) {
  const { entries, offline, refresh, now } = useOperationalAlerts<KitchenTimer>(
    '/kitchen/timers',
    userId,
  );
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('Microwave');
  const [minutes, setMinutes] = useState('2');
  const [orderId, setOrderId] = useState('');
  const [itemId, setItemId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<TimerInput>();
  const sending = useRef(false);
  const key = `dukanos-pending-timer:${userId}`;
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(key);
      if (saved) {
        setPending(JSON.parse(saved));
        setOpen(true);
      }
    } catch {
      setError(
        'Could not restore timer request. Check active timers before starting another.',
      );
    }
  }, [key]);
  async function create() {
    if (sending.current || offline) return;
    sending.current = true;
    setBusy(true);
    try {
      const input = pending ?? {
        requestId: confirmationId(),
        label,
        durationSeconds: Number(minutes) * 60,
        ...(orderId ? { orderId } : {}),
        ...(itemId ? { orderItemId: itemId } : {}),
      };
      sessionStorage.setItem(key, JSON.stringify(input));
      setPending(input);
      await api('/kitchen/timers', 'POST', input);
      sessionStorage.removeItem(key);
      setPending(undefined);
      setOpen(false);
      setError('');
    } catch (e) {
      setError(errorMessage(e));
      if (
        e instanceof ApiFailure &&
        [400, 409].includes(e.status) &&
        e.code !== 'IDEMPOTENCY_CONFLICT'
      ) {
        setPending(undefined);
        sessionStorage.removeItem(key);
      }
    } finally {
      sending.current = false;
      setBusy(false);
      void refresh();
    }
  }
  async function resolve(id: string, action: string) {
    if (sending.current || offline) return;
    sending.current = true;
    setBusy(true);
    try {
      await api(`/kitchen/timers/${id}/${action}`, 'POST');
      setError('');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      sending.current = false;
      setBusy(false);
      void refresh();
    }
  }
  return (
    <section
      className="kitchen-timers operational-alerts"
      aria-label="Kitchen timers"
    >
      <div className="timer-heading">
        <h2>Timers ({entries.length})</h2>
        {canManage && (
          <button className="secondary" onClick={() => setOpen(!open)}>
            {open ? 'Close timer form' : '+ Timer'}
          </button>
        )}
      </div>
      {offline && (
        <p role="status">
          Offline / server unavailable · known timers continue locally. Changes
          require connection.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {open && canManage && (
        <form
          className="timer-form"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <fieldset disabled={busy || offline || !!pending}>
            <legend>New Kitchen timer</legend>
            <label>
              Label
              <input
                aria-label="Timer label"
                maxLength={120}
                required
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </label>
            <div className="payment-choices">
              {[1, 2, 3, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  className="secondary"
                  aria-pressed={minutes === String(n)}
                  onClick={() => setMinutes(String(n))}
                >
                  {n} min
                </button>
              ))}
            </div>
            <label>
              Duration / custom minutes
              <input
                aria-label="Timer minutes"
                type="number"
                min="1"
                max="1440"
                step="1"
                required
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
              />
            </label>
            <label>
              Order (optional)
              <select
                aria-label="Timer order"
                value={orderId}
                onChange={(e) => {
                  setOrderId(e.target.value);
                  setItemId('');
                }}
              >
                <option value="">No order</option>
                {orders.map((o) => (
                  <option key={o.orderId} value={o.orderId}>
                    Token #{o.tokenNumber} · {o.businessDate}
                  </option>
                ))}
              </select>
            </label>
            {orderId && (
              <label>
                Item (optional)
                <select
                  aria-label="Timer item"
                  value={itemId}
                  onChange={(e) => setItemId(e.target.value)}
                >
                  <option value="">Whole order</option>
                  {orders
                    .find((o) => o.orderId === orderId)
                    ?.items.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.variantName} {i.itemName}
                      </option>
                    ))}
                </select>
              </label>
            )}
          </fieldset>
          <button disabled={busy || offline}>
            {pending ? 'Retry timer creation' : 'Start timer'}
          </button>
        </form>
      )}
      <div className="alert-strip">
        {entries.map((t) => {
          const due = now >= Date.parse(t.dueAt);
          return (
            <article
              key={t.id}
              data-timer-id={t.id}
              className={due ? 'alert-due' : ''}
            >
              <strong>
                {due ? 'TIMER DONE · ' : ''}
                {t.label}
              </strong>
              <p>
                {due ? 'OVERDUE ' : ''}
                {countdown(t.dueAt, now)}
              </p>
              <details>
                <summary>Timer details</summary>
                {t.tokenNumber !== null && (
                  <p>
                    Token #{t.tokenNumber} · {t.businessDate}
                  </p>
                )}
                {t.itemName && (
                  <p>
                    {t.variantName} {t.itemName}
                  </p>
                )}
                <p>
                  Started {new Date(t.startedAt).toLocaleTimeString()} ·{' '}
                  {t.durationSeconds / 60} min
                </p>
              </details>
              {canManage && (
                <>
                  {due && (
                    <button
                      disabled={busy || offline}
                      onClick={() => void resolve(t.id, 'acknowledge')}
                    >
                      Acknowledge
                    </button>
                  )}
                  <button
                    className="secondary"
                    disabled={busy || offline}
                    onClick={() => void resolve(t.id, 'cancel')}
                  >
                    Cancel timer
                  </button>
                </>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
