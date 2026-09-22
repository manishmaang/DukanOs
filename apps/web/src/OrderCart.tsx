import { useEffect, useRef, useState } from 'react';
import type {
  ConfirmedOrder,
  CounterOrderInput,
  OrderConfiguration,
} from '@dukanos/shared-types';
import { api, ApiFailure, errorMessage } from './api';
import {
  cartAmount,
  cartPaise,
  confirmationId,
  orderInput,
  type CartLine,
} from './order-cart';
import { rupees } from './menu-editor';
export function OrderCart({
  lines,
  setLines,
  userId,
  locked,
  setLocked,
}: {
  lines: CartLine[];
  setLines: (lines: CartLine[]) => void;
  userId: string;
  locked: boolean;
  setLocked: (value: boolean) => void;
}) {
  const [config, setConfig] = useState<OrderConfiguration>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState<ConfirmedOrder>();
  const pending = useRef<CounterOrderInput | undefined>(undefined);
  const sending = useRef(false);
  const storageKey = `dukanos-pending-order:${userId}`;
  useEffect(() => {
    void api<OrderConfiguration>('/orders/configuration')
      .then(setConfig)
      .catch((e) => setError(errorMessage(e)));
    try {
      const saved = sessionStorage.getItem(storageKey);
      if (saved) {
        pending.current = JSON.parse(saved) as CounterOrderInput;
        setLocked(true);
        setError(
          'An earlier confirmation needs checking. Retry to retrieve its result without creating a duplicate.',
        );
      }
    } catch {
      setError(
        'Could not restore the pending confirmation. Check recent orders before submitting again.',
      );
      setLocked(true);
    }
  }, [storageKey, setLocked]);
  const subtotal = lines.reduce(
    (sum, l) => sum + cartPaise(l.price) * BigInt(l.quantity),
    0n,
  );
  const tax = config
    ? (subtotal * cartPaise(config.taxRate) + 5000n) / 10000n
    : 0n;
  async function confirm() {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError('');
    try {
      if (!pending.current) {
        const request = orderInput(lines, confirmationId());
        // Store before sending so refresh/network retries keep the same request identity.
        sessionStorage.setItem(storageKey, JSON.stringify(request));
        pending.current = request;
      }
      setLocked(true);
      const order = await api<ConfirmedOrder>(
        '/orders/counter',
        'POST',
        pending.current,
      );
      setConfirmed(order);
      setLines([]);
      sessionStorage.removeItem(storageKey);
      pending.current = undefined;
    } catch (e) {
      const definitive =
        e instanceof ApiFailure &&
        [400, 409, 413, 415].includes(e.status) &&
        e.code !== 'IDEMPOTENCY_CONFLICT';
      if (definitive) {
        sessionStorage.removeItem(storageKey);
        pending.current = undefined;
        setLocked(false);
      }
      setError(
        errorMessage(e) +
          (definitive
            ? ''
            : ' Retry this confirmation to safely recover the result.'),
      );
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  if (confirmed)
    return (
      <aside className="order-cart" aria-label="Current order">
        <div role="status">
          <h2>Order confirmed</h2>
          <p className="order-token">TOKEN #{confirmed.tokenNumber}</p>
          <p>₹{rupees(confirmed.grandTotal)}</p>
          <p>Queued for kitchen · {confirmed.businessDate}</p>
        </div>
        <button
          onClick={() => {
            setConfirmed(undefined);
            setLocked(false);
          }}
        >
          New Order
        </button>
      </aside>
    );
  return (
    <aside className="order-cart" aria-label="Current order">
      <h2>Current Order</h2>
      {!lines.length && !locked && <p>Choose a dish and portion to start.</p>}
      {lines.map((line, index) => (
        <div className="cart-line" key={index}>
          <strong>
            {line.itemName} / {line.variantName}
          </strong>
          <div className="cart-quantity">
            <button
              aria-label={`Decrease line ${index + 1}`}
              disabled={locked || line.quantity <= 1}
              onClick={() =>
                setLines(
                  lines.map((l, i) =>
                    i === index ? { ...l, quantity: l.quantity - 1 } : l,
                  ),
                )
              }
            >
              −
            </button>
            <span>{line.quantity}</span>
            <button
              aria-label={`Increase line ${index + 1}`}
              disabled={locked || line.quantity >= 99}
              onClick={() =>
                setLines(
                  lines.map((l, i) =>
                    i === index ? { ...l, quantity: l.quantity + 1 } : l,
                  ),
                )
              }
            >
              +
            </button>
            <span>
              ₹
              {rupees(
                cartAmount(cartPaise(line.price) * BigInt(line.quantity)),
              )}
            </span>
          </div>
          <label>
            Kitchen instruction
            <textarea
              maxLength={500}
              value={line.instruction}
              disabled={locked}
              onChange={(e) =>
                setLines(
                  lines.map((l, i) =>
                    i === index ? { ...l, instruction: e.target.value } : l,
                  ),
                )
              }
            />
          </label>
          <button
            disabled={locked}
            onClick={() => setLines(lines.filter((_, i) => i !== index))}
          >
            Remove line {index + 1}
          </button>
        </div>
      ))}
      {!!lines.length && (
        <>
          <p>Subtotal ₹{rupees(cartAmount(subtotal))}</p>
          <p>
            {config?.taxLabel ?? 'Tax'} ({config?.taxRate ?? '…'}%) ₹
            {rupees(cartAmount(tax))}
          </p>
          <strong>Estimated total ₹{rupees(cartAmount(subtotal + tax))}</strong>
          <p className="menu-muted">
            Current Counter prices and configured tax apply at confirmation. No
            payment is collected.
          </p>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      <button
        className="confirm-order"
        disabled={
          busy ||
          (locked && !pending.current) ||
          (!locked && (!lines.length || !config))
        }
        onClick={() => void confirm()}
      >
        {busy ? 'Confirming…' : locked ? 'Retry confirmation' : 'Confirm Order'}
      </button>
      <button
        disabled={locked || !lines.length}
        onClick={() => {
          if (window.confirm('Clear the current draft?')) setLines([]);
        }}
      >
        Clear draft
      </button>
    </aside>
  );
}
