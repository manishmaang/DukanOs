import { SoundControl, useAlertSound } from './OperationalAudio';
import { useState } from 'react';
import type { PaymentReminder } from '@dukanos/shared-types';
import { api, errorMessage } from './api';
import { useOperationalAlerts, countdown } from './useOperationalAlerts';
import { rupees } from './menu-editor';
export function PaymentReminders({
  userId,
  canManage,
  onOpen,
}: {
  userId: string;
  canManage: boolean;
  onOpen: (id: string) => void;
}) {
  const { entries, offline, now, refresh } =
    useOperationalAlerts<PaymentReminder>('/reminders/active', userId);
  const silence = useAlertSound(
    'PAYMENT_REMINDER',
    entries.map((r) => ({ id: r.billId, dueAt: r.nextDueAt })),
    now,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function snooze(r: PaymentReminder) {
    if (busy || offline) return;
    setBusy(true);
    const restore = silence(r.billId);
    try {
      await api(`/bills/${r.billId}/reminder/snooze`, 'POST', {
        version: r.version,
      });
      setError('');
    } catch (e) {
      restore();
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      void refresh();
    }
  }
  if (!entries.length && !error)
    return <SoundControl kind="PAYMENT_REMINDER" />;
  return (
    <>
      <SoundControl kind="PAYMENT_REMINDER" />
      <details
        className="payment-reminders operational-alerts"
        aria-label="Payment reminders"
      >
        <summary>
          <strong aria-live="polite">
            Payment reminders ·{' '}
            {entries.filter((r) => now >= Date.parse(r.nextDueAt)).length} due
          </strong>
          {offline ? ' · Offline' : ''}
        </summary>
        <div className="reminder-tray-content">
          {offline && (
            <p role="status">
              Offline / server unavailable · amounts are from last sync. Known
              reminders continue locally.
            </p>
          )}
          {error && <p role="alert">{error}</p>}
          <div className="alert-strip">
            {entries.map((r) => {
              const due = now >= Date.parse(r.nextDueAt);
              const occurrence = Math.max(
                0,
                Math.floor(
                  (now - Date.parse(r.nextDueAt)) / (r.intervalMinutes * 60000),
                ),
              );
              return (
                <article
                  key={r.billId}
                  className={due ? 'alert-due' : ''}
                  data-bill-reminder={r.billId}
                >
                  <strong>
                    {due ? 'PAYMENT REMINDER' : 'Payment reminder scheduled'} ·{' '}
                    {r.reference || `Bill #${r.billNumber}`}
                  </strong>
                  <p>
                    ₹{rupees(r.amountDue)} due · {r.businessDate}
                  </p>
                  <p>
                    {due
                      ? `Overdue ${countdown(r.nextDueAt, now)} · reminder ${occurrence + 1}`
                      : `In ${countdown(r.nextDueAt, now)}`}{' '}
                    · every {r.intervalMinutes} min
                  </p>
                  <button
                    onClick={(e) => {
                      e.currentTarget
                        .closest('details.payment-reminders')
                        ?.removeAttribute('open');
                      onOpen(r.billId);
                    }}
                  >
                    Open Bill
                  </button>
                  {canManage && (
                    <button
                      className="secondary"
                      disabled={offline || busy}
                      onClick={() => void snooze(r)}
                    >
                      Snooze {r.intervalMinutes} min
                    </button>
                  )}
                </article>
              );
            })}
          </div>
        </div>
      </details>
    </>
  );
}
export function ReminderSetting({ billId }: { billId: string }) {
  const [minutes, setMinutes] = useState('5');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function save() {
    if (busy) return;
    setBusy(true);
    try {
      await api(`/bills/${billId}/reminder`, 'POST', {
        intervalMinutes: Number(minutes),
      });
      setMessage(`Payment reminder saved: every ${minutes} minutes.`);
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="reminder-setting">
      <summary>Payment reminder</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="payment-choices">
          {[5, 10, 15].map((n) => (
            <button
              type="button"
              className="secondary"
              aria-pressed={minutes === String(n)}
              key={n}
              onClick={() => setMinutes(String(n))}
            >
              {n} min
            </button>
          ))}
        </div>
        <label>
          Interval / custom minutes
          <input
            aria-label="Reminder minutes"
            type="number"
            min="1"
            max="1440"
            step="1"
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
          />
        </label>
        <button disabled={busy}>Set reminder</button>
        {message && <p role="status">{message}</p>}
      </form>
    </details>
  );
}
