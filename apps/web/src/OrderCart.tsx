import { ConfirmationPayment } from './ConfirmationPayment';
import { CartSurface } from './CartSurface';
import type { ReactNode } from 'react';
import { InstructionEditor } from './InstructionEditor';
import { useEffect, useRef, useState } from 'react';
import type {
  BillSummary,
  ServiceType,
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
  bill,
  canCollect,
  onNewBill,
  onViewBill,
  lines,
  setLines,
  userId,
  locked,
  setLocked,
}: {
  bill?: BillSummary;
  canCollect: boolean;
  onNewBill: () => void;
  onViewBill: (id: string) => void;
  lines: CartLine[];
  setLines: (lines: CartLine[]) => void;
  userId: string;
  locked: boolean;
  setLocked: (value: boolean) => void;
}) {
  const [review, setReview] = useState<CounterOrderInput>();
  const [serviceType, setServiceType] = useState<ServiceType>('DINE_IN');
  const [reference, setReference] = useState('');
  const [mobileOpen, setMobileOpen] = useState(false);
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
  async function confirm(selected?: CounterOrderInput) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError('');
    try {
      if (!pending.current) {
        const request = selected ?? {
          ...orderInput(lines, confirmationId()),
          ...(bill
            ? { billId: bill.id }
            : { serviceType, reference: reference.trim() }),
        };
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
      setReview(undefined);
      setConfirmed(order);
      setLines([]);
      sessionStorage.removeItem(storageKey);
      pending.current = undefined;
    } catch (e) {
      setReview(undefined);
      const definitive =
        e instanceof ApiFailure &&
        [400, 409, 413, 415].includes(e.status) &&
        e.code !== 'IDEMPOTENCY_CONFLICT';
      if (definitive) {
        sessionStorage.removeItem(storageKey);
        pending.current = undefined;
        setReview(undefined);
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
  function surface(content: ReactNode) {
    return (
      <CartSurface
        open={mobileOpen}
        setOpen={setMobileOpen}
        summary={
          confirmed
            ? `Token #${confirmed.tokenNumber} confirmed`
            : locked
              ? 'Confirmation needs checking'
              : `Current Order · ${lines.reduce((n, l) => n + l.quantity, 0)} items · ₹${rupees(cartAmount(subtotal + tax))} estimated`
        }
      >
        {content}
      </CartSurface>
    );
  }
  if (confirmed)
    return surface(
      <aside className="order-cart order-confirmed" aria-label="Current order">
        <div role="status">
          <h2>Order confirmed</h2>
          <p className="order-token">TOKEN #{confirmed.tokenNumber}</p>
          <p>₹{rupees(confirmed.grandTotal)}</p>
          <p>Queued for kitchen · {confirmed.businessDate}</p>
        </div>
        <button
          onClick={() => {
            onNewBill();
            setReference('');
            setMobileOpen(false);
            setConfirmed(undefined);
            setLocked(false);
          }}
        >
          New Order
        </button>
        <button
          className="secondary"
          onClick={() => {
            setMobileOpen(false);
            setConfirmed(undefined);
            setReference('');
            onViewBill(confirmed.billId);
          }}
        >
          View Bill / Payment
        </button>
      </aside>,
    );
  if (review)
    return surface(
      <>
        <ConfirmationPayment
          request={review}
          canCollect={canCollect}
          busy={busy}
          onConfirm={(request) => void confirm(request)}
          onBack={() => {
            setReview(undefined);
            setLocked(false);
          }}
        />
        {error && <p role="alert">{error}</p>}
      </>,
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
  return surface(
    <aside className="order-cart" aria-label="Current order">
      {!locked && (
        <div className="cart-bill-selection">
          {bill ? (
            <p>
              Bill #{bill.billNumber} ·{' '}
              {bill.reference ||
                bill.serviceType?.replace('_', ' ') ||
                'Legacy bill'}
            </p>
          ) : (
            <>
              <label>
                Service
                <select
                  aria-label="Service type"
                  value={serviceType}
                  onChange={(e) =>
                    setServiceType(e.target.value as ServiceType)
                  }
                >
                  <option value="DINE_IN">Dine In</option>
                  <option value="TAKEAWAY">Takeaway</option>
                </select>
              </label>
              <label>
                Table / Reference (optional)
                <input
                  aria-label="Table / Reference"
                  maxLength={80}
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                />
              </label>
            </>
          )}
        </div>
      )}
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
                  confirmation. Review payment before submitting.
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
              onClick={() => {
                if (pending.current) {
                  void confirm();
                  return;
                }
                setError('');
                setLocked(true);
                setReview({
                  ...orderInput(lines, confirmationId()),
                  ...(bill
                    ? { billId: bill.id }
                    : { serviceType, reference: reference.trim() }),
                });
              }}
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
    </aside>,
  );
}
