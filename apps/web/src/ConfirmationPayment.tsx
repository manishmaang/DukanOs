import { useEffect, useState } from 'react';
import type { CounterOrderInput, OrderQuote } from '@dukanos/shared-types';
import { api, errorMessage } from './api';
import { cartAmount, cartPaise } from './order-cart';
import { rupees } from './menu-editor';
export function ConfirmationPayment({
  request,
  canCollect,
  onConfirm,
  onBack,
  busy,
}: {
  request: CounterOrderInput;
  canCollect: boolean;
  onConfirm: (input: CounterOrderInput) => void;
  onBack: () => void;
  busy: boolean;
}) {
  const [quote, setQuote] = useState<OrderQuote>();
  const [error, setError] = useState('');
  const [partial, setPartial] = useState(false);
  const [cash, setCash] = useState('');
  const [upi, setUpi] = useState('');
  useEffect(() => {
    let live = true;
    void api<OrderQuote>('/orders/counter/quote', 'POST', request)
      .then((q) => {
        if (live) setQuote(q);
      })
      .catch((e) => {
        if (live) setError(errorMessage(e));
      });
    return () => {
      live = false;
    };
  }, [request]);
  const valid = [cash, upi].every(
    (v) => !v || /^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/.test(v),
  );
  const received = valid ? cartPaise(cash || '0') + cartPaise(upi || '0') : 0n;
  const due = quote ? cartPaise(quote.amountDue) : 0n;
  function pay(c: string, u: string) {
    if (quote)
      onConfirm({
        ...request,
        payment: { expectedDue: quote.amountDue, cash: c, upi: u },
      });
  }
  return (
    <aside className="order-cart payment-review" aria-label="Confirm payment">
      <h2>Confirm Order</h2>
      {error && <p role="alert">{error}</p>}
      {!quote && !error && (
        <p role="status">Checking current prices and bill due…</p>
      )}
      {quote && (
        <>
          <dl className="cart-totals">
            <div>
              <dt>Existing due</dt>
              <dd>₹{rupees(quote.existingDue)}</dd>
            </div>
            <div>
              <dt>New round</dt>
              <dd>₹{rupees(quote.roundTotal)}</dd>
            </div>
            <div className="cart-grand-total">
              <dt>Bill due</dt>
              <dd>₹{rupees(quote.amountDue)}</dd>
            </div>
          </dl>
          <p>Record money already received. UPI is not verified by DukanOS.</p>
          {canCollect && due > 0n && (
            <>
              <div className="payment-choices">
                <button
                  disabled={busy}
                  onClick={() => pay(quote.amountDue, '0')}
                >
                  Cash ₹{rupees(quote.amountDue)}
                </button>
                <button
                  disabled={busy}
                  onClick={() => pay('0', quote.amountDue)}
                >
                  UPI ₹{rupees(quote.amountDue)}
                </button>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => setPartial(!partial)}
                >
                  Partial / Split
                </button>
              </div>
              {partial && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (valid && received > 0n && received <= due)
                      pay(cash || '0', upi || '0');
                  }}
                >
                  <label>
                    Cash ₹
                    <input
                      aria-label="Confirmation Cash"
                      inputMode="decimal"
                      value={cash}
                      disabled={busy}
                      onChange={(e) => setCash(e.target.value)}
                    />
                  </label>
                  <label>
                    UPI ₹
                    <input
                      aria-label="Confirmation UPI"
                      inputMode="decimal"
                      value={upi}
                      disabled={busy}
                      onChange={(e) => setUpi(e.target.value)}
                    />
                  </label>
                  {valid && (
                    <p>
                      Collecting ₹{rupees(cartAmount(received))} · Remaining{' '}
                      {received <= due
                        ? '₹' + rupees(cartAmount(due - received))
                        : '— exceeds due'}
                    </p>
                  )}
                  <button
                    disabled={
                      busy || !valid || received <= 0n || received > due
                    }
                  >
                    Confirm split payment
                  </button>
                </form>
              )}
            </>
          )}
          <button
            className="secondary"
            disabled={busy}
            onClick={() => onConfirm(request)}
          >
            Pay Later
          </button>
        </>
      )}
      <button className="secondary" disabled={busy} onClick={onBack}>
        Back to order
      </button>
    </aside>
  );
}
