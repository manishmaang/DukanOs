import { useEffect, useRef, useState } from 'react';
import type {
  AmendmentHistory,
  AmendmentInput,
  AmendmentQuote,
  AmendmentReason,
  BillDetail,
  CommitAmendmentInput,
  ConfirmedOrder,
  OperationalMenu,
} from '@dukanos/shared-types';
import { api, ApiFailure, errorMessage } from './api';
import { confirmationId } from './order-cart';
import { MenuPhoto } from './MenuPhoto';
import { rupees } from './menu-editor';
const reasons: AmendmentReason[] = [
  'CUSTOMER_CHANGE',
  'WRONG_ITEM_SELECTED',
  'WRONG_PORTION',
  'ITEM_UNAVAILABLE',
  'CASHIER_CORRECTION',
  'OTHER',
];
export function OrderAmendment({
  round,
  userId,
  canAmend,
  canCancel,
  disabled,
  onSaved,
}: {
  round: BillDetail['orders'][number];
  userId: string;
  canAmend: boolean;
  canCancel: boolean;
  disabled: boolean;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false),
    [order, setOrder] = useState<ConfirmedOrder>(),
    [menu, setMenu] = useState<OperationalMenu>();
  const [draft, setDraft] = useState<AmendmentInput>(),
    [quote, setQuote] = useState<AmendmentQuote>(),
    [pending, setPending] = useState<CommitAmendmentInput>();
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [blocked, setBlocked] = useState(false),
    [changes, setChanges] = useState<AmendmentHistory[]>();
  const [replacement, setReplacement] = useState<string>(),
    [search, setSearch] = useState('');
  const dialog = useRef<HTMLDialogElement>(null),
    sending = useRef(false);
  const key = `dukanos-pending-amendment:${userId}:${round.id}`;
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(key);
      if (raw) {
        setPending(JSON.parse(raw));
        setOpen(true);
      }
    } catch {
      setBlocked(true);
      setError(
        'Could not restore amendment recovery. Check Changes before starting another change.',
      );
    }
  }, [key]);
  useEffect(() => {
    if (open) {
      dialog.current?.showModal();
    } else dialog.current?.close();
  }, [open]);
  async function load() {
    setBusy(true);
    setError('');
    try {
      const [o, m] = await Promise.all([
        api<ConfirmedOrder>(`/orders/${round.id}`),
        api<OperationalMenu>('/menu/counter'),
      ]);
      setOrder(o);
      setMenu(m);
      setDraft({
        requestId: confirmationId(),
        expectedRevision: o.revision,
        kind: 'CHANGE',
        reason: 'CUSTOMER_CHANGE',
        lines: o.items.map((i) => ({
          id: i.id,
          variantId: i.variantId,
          quantity: i.quantity,
          instruction: i.instruction,
        })),
      });
      setQuote(undefined);
      setReplacement(undefined);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function preview() {
    if (!draft || sending.current) return;
    sending.current = true;
    setBusy(true);
    setError('');
    try {
      setQuote(
        await api<AmendmentQuote>(
          `/orders/${round.id}/amendments/quote`,
          'POST',
          draft,
        ),
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      sending.current = false;
    }
  }
  async function commit() {
    if (sending.current || (!pending && (!draft || !quote))) return;
    sending.current = true;
    setBusy(true);
    setError('');
    try {
      const request = pending ?? { ...draft!, quoteHash: quote!.quoteHash };
      sessionStorage.setItem(key, JSON.stringify(request));
      setPending(request);
      await api(`/orders/${round.id}/amendments`, 'POST', request);
      sessionStorage.removeItem(key);
      setPending(undefined);
      setOpen(false);
      setChanges(undefined);
      onSaved();
    } catch (e) {
      const definite =
        e instanceof ApiFailure &&
        [400, 409, 413, 415].includes(e.status) &&
        e.code !== 'IDEMPOTENCY_CONFLICT';
      if (definite) {
        sessionStorage.removeItem(key);
        setPending(undefined);
        setQuote(undefined);
      }
      setError(
        errorMessage(e) +
          (definite
            ? ' Refresh the round and review again.'
            : ' Retry the same change to check its outcome.'),
      );
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  const change = (next: AmendmentInput) => {
    setDraft(next);
    setQuote(undefined);
  };
  const available = menu?.categories
    .flatMap((c) => c.items)
    .filter((i) => i.name.toLowerCase().includes(search.toLowerCase()));
  return (
    <div className="round-amendment">
      {canAmend && round.status === 'QUEUED' && (
        <button
          className="secondary"
          disabled={disabled || blocked}
          onClick={() => {
            setOpen(true);
            if (!pending) void load();
          }}
        >
          Change queued round
        </button>
      )}
      {canAmend &&
        ['PREPARING', 'READY', 'COMPLETED'].includes(round.status) && (
          <p>
            Preparation already started. Add replacement food as a new Kitchen
            round.
          </p>
        )}
      {pending && (
        <button onClick={() => setOpen(true)}>Check pending change</button>
      )}
      {error && !open && <p role="alert">{error}</p>}
      {round.revision > 0 && (
        <details
          onToggle={(e) => {
            if (e.currentTarget.open)
              void api<AmendmentHistory[]>(`/orders/${round.id}/amendments`)
                .then(setChanges)
                .catch((e) => setError(errorMessage(e)));
          }}
        >
          <summary>Changes ({round.revision})</summary>
          {changes?.map((h) => (
            <article key={h.id}>
              <strong>
                {h.kind === 'CANCEL' ? 'Round cancelled' : 'Round changed'} · ₹
                {rupees(h.beforeTotal)} → ₹{rupees(h.grandTotal)}
              </strong>
              <p>
                {h.reason.replaceAll('_', ' ')} · {h.actorName} ·{' '}
                {new Date(h.createdAt).toLocaleString()}
              </p>
              {h.note && <p>{h.note}</p>}
              <p>
                Before:{' '}
                {h.beforeItems
                  .map(
                    (i) =>
                      `${i.itemName} / ${i.variantName} ×${i.quantity}${i.instruction ? ' · ' + i.instruction : ''}`,
                  )
                  .join('; ')}
              </p>
              <p>
                After:{' '}
                {h.items
                  .map(
                    (i) =>
                      `${i.itemName} / ${i.variantName} ×${i.quantity}${i.instruction ? ' · ' + i.instruction : ''}`,
                  )
                  .join('; ') || 'Cancelled'}
              </p>
            </article>
          ))}
        </details>
      )}
      <dialog
        ref={dialog}
        className="amendment-dialog"
        aria-label="Change queued round"
        onCancel={(e) => {
          if (busy) e.preventDefault();
          else setOpen(false);
        }}
        onClose={() => setOpen(false)}
      >
        <div className="amendment-heading">
          <h2>Change Token #{round.tokenNumber}</h2>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => setOpen(false)}
          >
            Close change
          </button>
        </div>
        {error && <p role="alert">{error}</p>}
        {pending ? (
          <>
            <p>
              Check the pending change before making another. Retrying will not
              apply it twice.
            </p>
            <button disabled={busy || !canAmend} onClick={() => void commit()}>
              Retry change
            </button>
          </>
        ) : (
          <>
            {busy && !draft && <p>Loading round…</p>}
            {!busy && (
              <button className="secondary" onClick={() => void load()}>
                Refresh round
              </button>
            )}
            {draft && order && (
              <>
                {!quote && (
                  <>
                    <p>
                      Additional food uses Add Items and a new token. This
                      change keeps the current token and queue position.
                    </p>
                    {draft.kind === 'CHANGE' &&
                      draft.lines.map((line) => {
                        const old = order.items.find((i) => i.id === line.id)!;
                        const dish = menu?.categories
                          .flatMap((c) => c.items)
                          .find((i) =>
                            i.variants.some((v) => v.id === line.variantId),
                          );
                        const variant = dish?.variants.find(
                          (v) => v.id === line.variantId,
                        );
                        return (
                          <article className="amendment-line" key={line.id}>
                            <h3>
                              {line.variantId === old.variantId
                                ? old.itemName
                                : dish?.name}{' '}
                              /{' '}
                              {line.variantId === old.variantId
                                ? old.variantName
                                : variant?.name}
                            </h3>
                            <label>
                              Quantity (up to {old.quantity})
                              <input
                                aria-label={`Amend quantity ${old.itemName}`}
                                type="number"
                                min="1"
                                max={old.quantity}
                                value={line.quantity}
                                onChange={(e) =>
                                  change({
                                    ...draft,
                                    lines: draft.lines.map((l) =>
                                      l.id === line.id
                                        ? {
                                            ...l,
                                            quantity: Number(e.target.value),
                                          }
                                        : l,
                                    ),
                                  })
                                }
                              />
                            </label>
                            <label>
                              Kitchen instruction
                              <textarea
                                maxLength={500}
                                value={line.instruction}
                                onChange={(e) =>
                                  change({
                                    ...draft,
                                    lines: draft.lines.map((l) =>
                                      l.id === line.id
                                        ? { ...l, instruction: e.target.value }
                                        : l,
                                    ),
                                  })
                                }
                              />
                            </label>
                            <div className="bill-toolbar">
                              <button
                                className="secondary"
                                onClick={() => {
                                  setReplacement(line.id);
                                  setSearch('');
                                }}
                              >
                                Replace dish / portion
                              </button>
                              <button
                                className="secondary"
                                disabled={draft.lines.length === 1}
                                onClick={() =>
                                  change({
                                    ...draft,
                                    lines: draft.lines.filter(
                                      (l) => l.id !== line.id,
                                    ),
                                  })
                                }
                              >
                                Remove line
                              </button>
                            </div>
                          </article>
                        );
                      })}
                    {replacement && (
                      <section className="replacement-menu">
                        <h3>Select replacement</h3>
                        <label>
                          Find dish
                          <input
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                          />
                        </label>
                        <button
                          className="secondary"
                          onClick={() => setReplacement(undefined)}
                        >
                          Close replacement menu
                        </button>
                        <div className="replacement-grid">
                          {available?.map((i) => (
                            <article key={i.id}>
                              <MenuPhoto src={i.image?.url} name={i.name} />
                              <strong>{i.name}</strong>
                              {i.variants.map((v) => (
                                <button
                                  key={v.id}
                                  disabled={!v.available}
                                  onClick={() => {
                                    change({
                                      ...draft,
                                      lines: draft.lines.map((l) =>
                                        l.id === replacement
                                          ? { ...l, variantId: v.id }
                                          : l,
                                      ),
                                    });
                                    setReplacement(undefined);
                                  }}
                                >
                                  {v.name} · ₹{rupees(v.price)}
                                  {!v.available ? ' · Sold out' : ''}
                                </button>
                              ))}
                            </article>
                          ))}
                        </div>
                      </section>
                    )}
                    {canCancel && (
                      <button
                        className="secondary"
                        onClick={() => {
                          change({
                            ...draft,
                            kind: draft.kind === 'CANCEL' ? 'CHANGE' : 'CANCEL',
                            lines:
                              draft.kind === 'CANCEL'
                                ? order.items.map((i) => ({
                                    id: i.id,
                                    variantId: i.variantId,
                                    quantity: i.quantity,
                                    instruction: i.instruction,
                                  }))
                                : [],
                          });
                          setReplacement(undefined);
                        }}
                      >
                        {draft.kind === 'CANCEL'
                          ? 'Keep round'
                          : 'Cancel entire queued round'}
                      </button>
                    )}
                    {draft.kind === 'CANCEL' && (
                      <p role="status">
                        Cancel all food in this queued round. Original history
                        and token remain recorded.
                      </p>
                    )}
                    <label>
                      Reason
                      <select
                        value={draft.reason}
                        onChange={(e) =>
                          change({
                            ...draft,
                            reason: e.target.value as AmendmentReason,
                          })
                        }
                      >
                        {reasons.map((r) => (
                          <option key={r} value={r}>
                            {r.replaceAll('_', ' ')}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Optional note
                      <textarea
                        maxLength={500}
                        value={draft.note ?? ''}
                        onChange={(e) =>
                          change({ ...draft, note: e.target.value })
                        }
                      />
                    </label>
                    <button
                      disabled={busy || order.status !== 'QUEUED'}
                      onClick={() => void preview()}
                    >
                      Review Change
                    </button>
                  </>
                )}
                {quote && (
                  <div className="amendment-preview">
                    <h3>Change summary</h3>
                    <p>
                      {quote.beforeItems
                        .map(
                          (i) =>
                            `${i.itemName} / ${i.variantName} ×${i.quantity}`,
                        )
                        .join('; ')}{' '}
                      →{' '}
                      {quote.items
                        .map(
                          (i) =>
                            `${i.itemName} / ${i.variantName} ×${i.quantity}`,
                        )
                        .join('; ') || 'Cancelled round'}
                    </p>
                    <p>
                      Round: ₹{rupees(quote.oldRoundTotal)} → ₹
                      {rupees(quote.newRoundTotal)}
                    </p>
                    <p>
                      Bill total: ₹{rupees(quote.billTotalBefore)} → ₹
                      {rupees(quote.billTotalAfter)}
                    </p>
                    <p>Already paid (net): ₹{rupees(quote.netPaid)}</p>
                    <strong>
                      {quote.refundDueAfter !== '0.00'
                        ? `CASH REFUND DUE ₹${rupees(quote.refundDueAfter)}`
                        : `Amount due ₹${rupees(quote.amountDueAfter)}`}
                    </strong>
                    <p>
                      This records the change only. Collect or return money
                      separately at Counter.
                    </p>
                    <button disabled={busy} onClick={() => void commit()}>
                      Confirm Change
                    </button>
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() => setQuote(undefined)}
                    >
                      Back to change
                    </button>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </dialog>
    </div>
  );
}
