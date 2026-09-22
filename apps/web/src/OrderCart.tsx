import { InstructionEditor } from './InstructionEditor';
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
  groupCartLines,
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
      <aside className="order-cart order-confirmed" aria-label="Current order">
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
  const groups = groupCartLines(lines);
  function updateLine(
    id: string,
    change: Partial<Pick<CartLine, 'quantity' | 'instruction'>>,
  ) {
    setLines(
      lines.map((line) => (line.id === id ? { ...line, ...change } : line)),
    );
  }
  return (
    <aside className="order-cart" aria-label="Current order">
      <div className="cart-heading">
        <h2>Current Order</h2>
        {!!lines.length && (
          <button
            className="secondary-control"
            disabled={locked}
            onClick={() => {
              if (window.confirm('Clear the current draft?')) setLines([]);
            }}
          >
            Clear draft
          </button>
        )}
      </div>
      {!lines.length && !locked && (
        <p className="cart-empty">
          No items yet. <span>Tap a dish to add it.</span>
        </p>
      )}
      {!!lines.length && (
        <div
          className="cart-items"
          role="region"
          aria-label="Order items"
          tabIndex={0}
        >
          {groups.map((group) => (
            <div
              className="cart-dish"
              key={group.menuItemId}
              data-menu-item-id={group.menuItemId}
            >
              <h3>{group.name}</h3>
              {group.lines.map((line) => (
                <div
                  className="cart-line"
                  key={line.id}
                  data-line-id={line.id}
                  data-variant-id={line.variantId}
                >
                  <div className="cart-line-main">
                    <strong className="cart-variant">{line.variantName}</strong>
                    <div
                      className="cart-quantity"
                      role="group"
                      aria-label={`${line.itemName} / ${line.variantName} quantity`}
                    >
                      <button
                        aria-label={`Decrease ${line.variantName} quantity`}
                        disabled={locked || line.quantity <= 1}
                        onClick={() =>
                          updateLine(line.id, { quantity: line.quantity - 1 })
                        }
                      >
                        −
                      </button>
                      <span>{line.quantity}</span>
                      <button
                        aria-label={`Increase ${line.variantName} quantity`}
                        disabled={locked || line.quantity >= 99}
                        onClick={() =>
                          updateLine(line.id, { quantity: line.quantity + 1 })
                        }
                      >
                        +
                      </button>
                    </div>
                    <strong className="cart-line-price">
                      ₹
                      {rupees(
                        cartAmount(
                          cartPaise(line.price) * BigInt(line.quantity),
                        ),
                      )}
                    </strong>
                  </div>
                  <div className="cart-line-actions">
                    <InstructionEditor
                      label={`${line.itemName} / ${line.variantName}`}
                      value={line.instruction}
                      disabled={locked}
                      onChange={(instruction) =>
                        updateLine(line.id, { instruction })
                      }
                    />
                    <button
                      className="secondary-control cart-remove"
                      aria-label={`Remove ${line.itemName} / ${line.variantName}`}
                      disabled={locked}
                      onClick={() =>
                        setLines(lines.filter((l) => l.id !== line.id))
                      }
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      {(!!lines.length || locked || error) && (
        <div className="cart-summary">
          {!!lines.length && (
            <>
              <dl className="cart-totals">
                <div>
                  <dt>Subtotal</dt>
                  <dd>₹{rupees(cartAmount(subtotal))}</dd>
                </div>
                <div>
                  <dt>
                    {config?.taxLabel ?? 'Tax'} ({config?.taxRate ?? '…'}%)
                  </dt>
                  <dd>₹{rupees(cartAmount(tax))}</dd>
                </div>
                <div className="cart-grand-total">
                  <dt>
                    Total <small>(estimate)</small>
                  </dt>
                  <dd>₹{rupees(cartAmount(subtotal + tax))}</dd>
                </div>
              </dl>
              <details className="cart-price-help">
                <summary>Pricing details</summary>
                <p>
                  Current Counter prices and configured tax apply at
                  confirmation. No payment is collected.
                </p>
              </details>
            </>
          )}
          {error && <p role="alert">{error}</p>}
          {(!!lines.length || locked) && (
            <button
              className="confirm-order"
              disabled={
                busy ||
                (locked && !pending.current) ||
                (!locked && (!lines.length || !config))
              }
              onClick={() => void confirm()}
            >
              {busy
                ? 'Confirming…'
                : locked
                  ? 'Retry confirmation'
                  : 'Confirm Order'}
            </button>
          )}
        </div>
      )}
    </aside>
  );
}
