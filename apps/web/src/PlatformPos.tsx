import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  PlatformMenu,
  PlatformOrder,
  PlatformOrderInput,
  PlatformOrderList,
  PlatformSource,
  ServingSnapshot,
} from '@dukanos/shared-types';
import { api, ApiFailure, errorMessage } from './api';
import { CartSurface } from './CartSurface';
import { MenuPhoto } from './MenuPhoto';
import { ServingLabel, SourceLabel } from './ServingLabel';
type Dish = PlatformMenu['categories'][number]['items'][number];
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
  const [discount, setDiscount] =
    useState<PlatformOrderInput['discountClassification']>('UNKNOWN');
  const [lines, setLines] = useState<Line[]>([]);
  const [dish, setDish] = useState<Dish>();
  const [selected, setSelected] = useState<
    Record<
      string,
      { quantity: number; instruction: string; serving: ServingSnapshot | null }
    >
  >({});
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
  const dialog = useRef<HTMLDialogElement>(null);
  const dirty = !!pending || !!lines.length || !!reference;
  useEffect(() => onDraftStateChange(dirty), [dirty, onDraftStateChange]);
  useEffect(() => {
    if (dish) dialog.current?.showModal();
    else dialog.current?.close();
  }, [dish]);
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
  function choose(item: Dish) {
    setDish(item);
    setSelected(
      Object.fromEntries(
        item.variants.map((v) => [
          v.id,
          { quantity: 0, instruction: '', serving: v.normal },
        ]),
      ),
    );
  }
  function add() {
    if (!dish) return;
    const additions = dish.variants.flatMap((v) => {
      const s = selected[v.id];
      return s && s.quantity > 0 && s.serving
        ? [
            {
              key: crypto.randomUUID(),
              variantId: v.id,
              quantity: s.quantity,
              instruction: s.instruction.trim(),
              serving: s.serving,
              itemName: dish.name,
              variantName: v.name,
            },
          ]
        : [];
    });
    if (lines.length + additions.length > 100) {
      setNotice('An order supports at most 100 lines.');
      return;
    }
    setLines([...lines, ...additions]);
    setDish(undefined);
    setNotice(
      'Added to platform order. Review each serving before submission.',
    );
  }
  function clear() {
    setLines([]);
    setReference('');
    setReview(false);
    setConfirmed(undefined);
    setNotice('');
  }
  async function submit() {
    if (sending.current) return;
    let body = pending;
    if (!body) {
      body = {
        requestId: crypto.randomUUID(),
        source,
        externalReference: reference,
        discountClassification: discount,
        lines: lines.map(({ variantId, quantity, instruction, serving }) => ({
          variantId,
          quantity,
          instruction,
          serving,
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
      if (e instanceof ApiFailure && e.status < 500) {
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
          <label>
            External platform order ID
            <input
              maxLength={80}
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              disabled={review}
            />
          </label>
          <label>
            Discount observed
            <select
              value={discount}
              onChange={(e) => setDiscount(e.target.value as typeof discount)}
              disabled={review}
            >
              <option value="NONE">No discount</option>
              <option value="APPLIED">Discount applied</option>
              <option value="UNKNOWN">Unknown / not confirmed</option>
            </select>
          </label>
          <p>
            Match the actual platform offering. A discount never selects a
            smaller serving automatically.
          </p>
          <div className="platform-cart-lines">
            {lines.map((line, index) => (
              <article key={line.key}>
                <h3>
                  {line.variantName} {line.itemName} ×{line.quantity}
                </h3>
                <ServingLabel serving={line.serving} />
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
                Confirm the platform reference, discount classification and
                exact serving for every line. DukanOS will allocate a token; no
                bill or payment is created.
              </p>
              <button disabled={busy} onClick={() => void submit()}>
                Submit to Kitchen
              </button>
              <button onClick={() => setReview(false)}>Back to edit</button>
            </>
          ) : (
            <>
              <button
                disabled={!lines.length || !reference.trim() || !menu}
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
                {detail.businessDate} · {detail.discountClassification}
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
              Operational entry only. Select exact servings shown on the
              platform.
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
                          onClick={() => choose(i)}
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
                enable availability and configure serving sizes.
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
      <dialog
        ref={dialog}
        className="platform-dish-dialog"
        onCancel={() => setDish(undefined)}
      >
        <button onClick={() => setDish(undefined)}>Close</button>
        {dish && (
          <>
            <h2>{dish.name}</h2>
            {dish.variants.map((v) => {
              const s = selected[v.id];
              return (
                <section key={v.id}>
                  <h3>{v.name}</h3>
                  {!v.available ? (
                    <p>Unavailable on {source}</p>
                  ) : !v.normal ? (
                    <p>
                      Serving size not configured. Ask a Menu administrator.
                    </p>
                  ) : (
                    <>
                      <label>
                        Serving offered
                        <select
                          aria-label={`${v.name} serving`}
                          value={s?.serving?.mode ?? 'NORMAL'}
                          onChange={(e) =>
                            setSelected({
                              ...selected,
                              [v.id]: {
                                ...s!,
                                serving:
                                  e.target.value === 'NORMAL'
                                    ? v.normal
                                    : v.reduced,
                              },
                            })
                          }
                        >
                          <option value="NORMAL">
                            NORMAL — {v.normal.amount} {v.normal.unit} each
                          </option>
                          {v.reduced && (
                            <option value="REDUCED">
                              REDUCED — {v.reduced.amount} {v.reduced.unit} each
                            </option>
                          )}
                        </select>
                      </label>
                      {s?.serving?.mode === 'REDUCED' && (
                        <p>
                          Use only when this matches the actual platform
                          offering.
                        </p>
                      )}
                      <label>
                        Quantity
                        <input
                          aria-label={`${v.name} quantity`}
                          type="number"
                          min={0}
                          max={99}
                          value={s?.quantity ?? 0}
                          onChange={(e) => {
                            const n = Number(e.target.value);
                            if (Number.isInteger(n) && n >= 0 && n <= 99)
                              setSelected({
                                ...selected,
                                [v.id]: { ...s!, quantity: n },
                              });
                          }}
                        />
                      </label>
                      <label>
                        Kitchen instruction
                        <textarea
                          aria-label={`${v.name} instruction`}
                          maxLength={500}
                          value={s?.instruction ?? ''}
                          onChange={(e) =>
                            setSelected({
                              ...selected,
                              [v.id]: { ...s!, instruction: e.target.value },
                            })
                          }
                        />
                      </label>
                    </>
                  )}
                </section>
              );
            })}
            <button
              disabled={
                !Object.values(selected).some(
                  (s) => s.quantity > 0 && s.serving,
                )
              }
              onClick={add}
            >
              Add to Order
            </button>
          </>
        )}
      </dialog>
    </>
  );
}
