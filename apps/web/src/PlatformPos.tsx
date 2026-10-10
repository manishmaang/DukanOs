import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  PlatformMenu,
  PlatformOrder,
  PlatformOrderInput,
  PlatformOrderList,
  PlatformSource,
  ServingMode,
} from '@dukanos/shared-types';
import { api, ApiFailure, errorMessage } from './api';
import { CartSurface } from './CartSurface';
import { DishSelection, type PortionSelection } from './DishSelection';
import { confirmationId } from './order-cart';
import { MenuPhoto } from './MenuPhoto';
import { ServingLabel, SourceLabel } from './ServingLabel';
type Line = PlatformOrderInput['lines'][number] & {
  key: string;
  itemName: string;
  variantName: string;
};
export function PlatformPos({
  source,
  userId,
  canRead,
  canCancel,
  onDraftStateChange,
}: {
  source: PlatformSource;
  userId: string;
  canRead: boolean;
  canCancel: boolean;
  onDraftStateChange: (v: boolean) => void;
}) {
  const storage = `dukanos-platform-pending:${userId}:${source}`;
  const [menu, setMenu] = useState<PlatformMenu>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [reference, setReference] = useState('');
  const [preparationMode, setPreparationMode] = useState<ServingMode>('NORMAL');
  const [lines, setLines] = useState<Line[]>([]);
  const [dishId, setDishId] = useState<string>();
  const [open, setOpen] = useState(false);
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [pending, setPending] = useState<PlatformOrderInput | undefined>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(storage) ?? 'null') ?? undefined;
    } catch {
      return undefined;
    }
  });
  const [confirmed, setConfirmed] = useState<PlatformOrder>();
  const [tracking, setTracking] = useState(false);
  const [recent, setRecent] = useState<PlatformOrderList>();
  const [lookup, setLookup] = useState('');
  const [cursor, setCursor] = useState<string>();
  const trackingSequence = useRef(0);
  const [detail, setDetail] = useState<PlatformOrder>();
  const [cancelReason, setCancelReason] = useState('');
  const dish = menu?.categories
    .flatMap((c) => c.items)
    .find((i) => i.id === dishId);
  const dirty = !!pending || !!lines.length || !!reference;
  useEffect(() => onDraftStateChange(dirty), [dirty, onDraftStateChange]);
  const refresh = useCallback(async () => {
    try {
      setMenu(
        await api<PlatformMenu>(`/platform-orders/menu?source=${source}`),
      );
      setError('');
    } catch (e) {
      setMenu(undefined);
      setError(errorMessage(e));
    }
  }, [source]);
  useEffect(() => {
    void refresh();
    const poll = () => {
      if (!document.hidden) void refresh();
    };
    const timer = setInterval(poll, 5000);
    window.addEventListener('focus', poll);
    window.addEventListener('online', poll);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', poll);
      window.removeEventListener('online', poll);
    };
  }, [refresh]);
  const refreshOrders = useCallback(async () => {
    const sequence = ++trackingSequence.current;
    try {
      const value = await api<PlatformOrderList>(
        `/platform-orders?search=${encodeURIComponent(lookup)}${cursor ? '&after=' + cursor : ''}`,
      );
      if (sequence !== trackingSequence.current) return;
      setRecent(value);
      if (detail) {
        const order = await api<PlatformOrder>(`/platform-orders/${detail.id}`);
        if (sequence === trackingSequence.current) setDetail(order);
      }
    } catch (e) {
      if (sequence !== trackingSequence.current) return;
      setRecent(undefined);
      setDetail(undefined);
      setError(errorMessage(e));
    }
  }, [lookup, cursor, detail?.id]);
  useEffect(() => {
    if (!tracking || !canRead) return;
    void refreshOrders();
    const timer = setInterval(() => {
      if (!document.hidden) void refreshOrders();
    }, 3000);
    return () => clearInterval(timer);
  }, [tracking, canRead, refreshOrders]);
  function add(selected: PortionSelection[]) {
    if (!dish) return;
    if (lines.length + selected.length > 100)
      throw new Error('An order supports at most 100 lines.');
    setLines([
      ...lines,
      ...selected.map((s) => ({
        ...s,
        key: confirmationId(),
        itemName: dish.name,
      })),
    ]);
    setNotice('Added to platform order.');
    setReview(false);
  }
  function clear() {
    setLines([]);
    setReference('');
    setPreparationMode('NORMAL');
    setReview(false);
    setConfirmed(undefined);
    setNotice('');
  }
  async function submit() {
    if (sending.current) return;
    let body = pending;
    if (!body) {
      body = {
        requestId: confirmationId(),
        source,
        externalReference: reference,
        preparationMode,
        lines: lines.map(({ variantId, quantity, instruction }) => ({
          variantId,
          quantity,
          instruction,
        })),
      };
      try {
        sessionStorage.setItem(storage, JSON.stringify(body));
      } catch {
        setNotice(
          'Cannot save retry identity in this browser. Enable session storage before submitting.',
        );
        return;
      }
      setPending(body);
    }
    sending.current = true;
    setBusy(true);
    setNotice('');
    try {
      const result = await api<PlatformOrder>('/platform-orders', 'POST', body);
      sessionStorage.removeItem(storage);
      setPending(undefined);
      setConfirmed(result);
      setLines([]);
      setReference('');
      setReview(false);
      setOpen(true);
    } catch (e) {
      setNotice(errorMessage(e));
      if (
        e instanceof ApiFailure &&
        [400, 409, 413, 415].includes(e.status) &&
        e.code !== 'IDEMPOTENCY_CONFLICT'
      ) {
        sessionStorage.removeItem(storage);
        setPending(undefined);
        setReview(false);
        void refresh();
      }
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  const cart = (
    <section className="order-cart platform-cart">
      <h2>{confirmed ? 'Order confirmed' : 'Current platform order'}</h2>
      {notice && <p role="status">{notice}</p>}
      {confirmed ? (
        <>
          <SourceLabel
            source={confirmed.source}
            reference={confirmed.externalReference}
          />
          <h2>TOKEN #{confirmed.tokenNumber}</h2>
          <p>Sent to Kitchen · No DukanOS bill or payment</p>
          <button
            onClick={() => {
              clear();
              setOpen(false);
            }}
          >
            New Order
          </button>
        </>
      ) : pending ? (
        <>
          <p>
            Submission is awaiting confirmation. Retry this same request; do not
            enter it again.
          </p>
          <SourceLabel
            source={pending.source}
            reference={pending.externalReference}
          />
          <button disabled={busy} onClick={() => void submit()}>
            Retry submission
          </button>
        </>
      ) : (
        <>
          {review && (
            <>
              <label>
                External platform order ID
                <input
                  aria-label="External platform order ID"
                  maxLength={80}
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  disabled={busy}
                />
              </label>
              <fieldset className="preparation-choice" disabled={busy}>
                <legend>Kitchen quantity — all items</legend>
                {(['NORMAL', 'REDUCED'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={preparationMode === mode}
                    onClick={() => setPreparationMode(mode)}
                  >
                    {mode === 'NORMAL' ? 'NORMAL QUANTITY' : 'LESS QUANTITY'}
                  </button>
                ))}
              </fieldset>
              <p>
                Choose the quantity promised on the platform. A discount alone
                does not mean less food.
              </p>
            </>
          )}
          <div className="platform-cart-lines">
            {lines.map((line, index) => (
              <article key={line.key}>
                <h3>
                  {line.variantName} {line.itemName} ×{line.quantity}
                </h3>
                {review ? (
                  <p>{line.instruction}</p>
                ) : (
                  <>
                    <label>
                      Quantity
                      <input
                        aria-label={`Line ${index + 1} quantity`}
                        type="number"
                        min={1}
                        max={99}
                        value={line.quantity}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          if (Number.isInteger(n) && n >= 1 && n <= 99)
                            setLines(
                              lines.map((l) =>
                                l.key === line.key ? { ...l, quantity: n } : l,
                              ),
                            );
                        }}
                      />
                    </label>
                    <label>
                      Kitchen instruction
                      <textarea
                        maxLength={500}
                        value={line.instruction ?? ''}
                        onChange={(e) =>
                          setLines(
                            lines.map((l) =>
                              l.key === line.key
                                ? { ...l, instruction: e.target.value }
                                : l,
                            ),
                          )
                        }
                      />
                    </label>
                    <button
                      onClick={() =>
                        setLines(lines.filter((l) => l.key !== line.key))
                      }
                    >
                      Remove {line.variantName}
                    </button>
                  </>
                )}
              </article>
            ))}
          </div>
          {review ? (
            <>
              <p>
                Confirm the platform reference and quantity instruction for all
                items. DukanOS will allocate a token; no bill or payment is
                created.
              </p>
              <button
                disabled={
                  busy ||
                  !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(reference.trim())
                }
                onClick={() => void submit()}
              >
                Submit to Kitchen
              </button>
              <button onClick={() => setReview(false)}>Back to edit</button>
            </>
          ) : (
            <>
              <button
                disabled={!lines.length || !menu}
                onClick={() => {
                  setNotice('');
                  setReview(true);
                }}
              >
                Review platform order
              </button>
              <button onClick={clear}>Clear draft</button>
            </>
          )}
        </>
      )}
    </section>
  );
  return (
    <>
      <div className="bill-toolbar">
        {canRead && (
          <button onClick={() => setTracking(!tracking)}>
            {tracking ? 'Back to entry' : 'Track platform orders'}
          </button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {tracking ? (
        <section className="platform-tracking">
          <h1>Platform orders</h1>
          <label>
            Search platform reference or token
            <input
              value={lookup}
              maxLength={80}
              onChange={(e) => {
                setCursor(undefined);
                setLookup(e.target.value);
              }}
            />
          </label>
          <button onClick={() => void refreshOrders()}>Refresh orders</button>
          {detail && (
            <article>
              <button
                onClick={() => {
                  setDetail(undefined);
                  setCancelReason('');
                }}
              >
                Close details
              </button>
              <SourceLabel
                source={detail.source}
                reference={detail.externalReference}
              />
              <h2>
                Token #{detail.tokenNumber} · {detail.status}
              </h2>
              <p>
                {detail.businessDate}
                {detail.discountClassification &&
                  ` · Historical discount: ${detail.discountClassification}`}
              </p>
              {detail.items.map((i) => (
                <div key={i.id}>
                  <strong>
                    {i.variantName} {i.itemName} ×{i.quantity}
                  </strong>
                  <ServingLabel serving={i.serving} />
                  <p>{i.instruction}</p>
                </div>
              ))}
              {detail.history.map((h, i) => (
                <p key={i}>
                  {h.toStatus} · {h.actorName} ·{' '}
                  {new Date(h.occurredAt).toLocaleString()} · {h.reason}
                </p>
              ))}
              {canCancel &&
                ['QUEUED', 'PREPARING', 'READY'].includes(detail.status) && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (
                        !window.confirm(
                          'Record cancellation locally? This does not cancel the external platform order, and its reference cannot be reused.',
                        )
                      )
                        return;
                      setBusy(true);
                      void api<PlatformOrder>(
                        `/platform-orders/${detail.id}/cancel`,
                        'POST',
                        { reason: cancelReason },
                      )
                        .then((o) => {
                          setDetail(o);
                          setCancelReason('');
                          void refreshOrders();
                        })
                        .catch((e) => setNotice(errorMessage(e)))
                        .finally(() => setBusy(false));
                    }}
                  >
                    <label>
                      Cancellation reason
                      <textarea
                        required
                        maxLength={500}
                        value={cancelReason}
                        onChange={(e) => setCancelReason(e.target.value)}
                      />
                    </label>
                    <button disabled={busy || !cancelReason.trim()}>
                      Record platform cancellation
                    </button>
                  </form>
                )}
            </article>
          )}
          {notice && <p role="status">{notice}</p>}
          {recent?.orders.map((o) => (
            <button
              className="platform-track-card"
              key={o.id}
              onClick={() => {
                setDetail(o);
                setCancelReason('');
              }}
            >
              <SourceLabel source={o.source} reference={o.externalReference} />
              <strong>
                Token #{o.tokenNumber} · {o.status}
              </strong>
              <span>{new Date(o.queuedAt).toLocaleString()}</span>
            </button>
          ))}
          {recent?.nextCursor && (
            <button onClick={() => setCursor(recent.nextCursor!)}>
              Older orders
            </button>
          )}
          {cursor && (
            <button onClick={() => setCursor(undefined)}>
              Most recent orders
            </button>
          )}
        </section>
      ) : (
        <div className="pos-order-layout">
          <section className="pos-menu">
            <h1>POS · {source}</h1>
            <p>
              Select dishes and portions, then choose Normal or Less Quantity at
              review.
            </p>
            <label>
              Search dishes
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <nav className="pos-categories" aria-label="Menu categories">
              <button aria-pressed={!category} onClick={() => setCategory('')}>
                All
              </button>
              {menu?.categories.map((c) => (
                <button
                  key={c.id}
                  aria-pressed={category === c.id}
                  onClick={() => setCategory(c.id)}
                >
                  {c.name}
                </button>
              ))}
            </nav>
            {menu?.categories
              .filter((c) => !category || c.id === category)
              .map((c) => (
                <section key={c.id}>
                  <h2>{c.name}</h2>
                  <div className="pos-grid">
                    {c.items
                      .filter((i) =>
                        [i.name, ...i.variants.map((v) => v.name)]
                          .join(' ')
                          .toLowerCase()
                          .includes(search.toLowerCase()),
                      )
                      .map((i) => (
                        <button
                          className="pos-card pos-dish-card"
                          key={i.id}
                          disabled={!!pending || !!confirmed}
                          onClick={() => {
                            setDishId(i.id);
                            setReview(false);
                          }}
                        >
                          <MenuPhoto src={i.image?.url} name={i.name} />
                          <span className="pos-card-info">
                            <strong>{i.name}</strong>
                            <small>
                              {i.variants.length}{' '}
                              {i.variants.length === 1 ? 'portion' : 'portions'}
                            </small>
                          </span>
                        </button>
                      ))}
                  </div>
                </section>
              ))}
            {menu && !menu.categories.length && (
              <p>
                No platform portions configured. Ask a Menu administrator to
                enable platform availability.
              </p>
            )}
          </section>
          <CartSurface
            open={open}
            setOpen={setOpen}
            summary={`${lines.reduce((n, l) => n + l.quantity, 0)} portions · ${source}`}
          >
            {cart}
          </CartSurface>
        </div>
      )}
      {dish && (
        <DishSelection
          key={dish.id}
          channel={source}
          dish={dish}
          canCreateOrders
          canManageAvailability={false}
          locked={!!pending || !!confirmed}
          busy={busy}
          actionError=""
          onAvailability={() => {}}
          onAdd={add}
          onDismiss={() => setDishId(undefined)}
        />
      )}
    </>
  );
}
