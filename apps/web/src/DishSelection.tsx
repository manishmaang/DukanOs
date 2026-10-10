import { InstructionEditor } from './InstructionEditor';
import { useEffect, useRef, useState } from 'react';
import type {
  OperationalMenu,
  PlatformMenu,
  PlatformSource,
} from '@dukanos/shared-types';
import { MenuPhoto } from './MenuPhoto';
import { rupees } from './menu-editor';
import {
  cartAmount,
  cartPaise,
  selectionLines,
  type CartLine,
} from './order-cart';
type Dish = OperationalMenu['categories'][number]['items'][number];
export interface PortionSelection {
  variantId: string;
  variantName: string;
  quantity: number;
  instruction: string;
}
type SelectionProps = {
  canCreateOrders: boolean;
  canManageAvailability: boolean;
  locked: boolean;
  busy: boolean;
  actionError: string;
  onAvailability: (available: boolean, variantId?: string) => void;
  onDismiss: () => void;
} & (
  | { channel?: 'COUNTER'; dish: Dish; onAdd: (lines: CartLine[]) => void }
  | {
      channel: PlatformSource;
      dish: PlatformMenu['categories'][number]['items'][number];
      onAdd: (lines: PortionSelection[]) => void;
    }
);
export function DishSelection(props: SelectionProps) {
  const {
    dish,
    canCreateOrders,
    canManageAvailability,
    locked,
    busy,
    actionError,
    onAvailability,
    onDismiss,
  } = props;
  const dialog = useRef<HTMLDialogElement>(null);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    const lost = Object.entries(quantities).filter(
      ([id, quantity]) =>
        quantity > 0 && !dish.variants.some((v) => v.id === id && v.available),
    );
    if (lost.length) {
      setQuantities((current) =>
        Object.fromEntries(
          Object.entries(current).filter(
            ([id]) => !lost.some(([gone]) => gone === id),
          ),
        ),
      );
      setError(
        'A selected portion is no longer available and was removed from this selection. Review before adding.',
      );
    }
  }, [dish.variants, quantities]);
  const selected: PortionSelection[] = dish.variants.flatMap((v) => {
    const quantity = quantities[v.id] ?? 0;
    return v.available && quantity > 0
      ? [
          {
            variantId: v.id,
            variantName: v.name,
            quantity,
            instruction: (notes[v.id] ?? '').trim(),
          },
        ]
      : [];
  });
  const count = selected.reduce((n, l) => n + l.quantity, 0);
  const counterLines =
    !props.channel || props.channel === 'COUNTER'
      ? selectionLines(props.dish as Dish, quantities, notes)
      : null;
  const total = counterLines
    ? cartAmount(
        counterLines.reduce(
          (n, l) => n + cartPaise(l.price) * BigInt(l.quantity),
          0n,
        ),
      )
    : null;
  function changeQuantity(id: string, change: number) {
    setQuantities((current) => ({
      ...current,
      [id]: Math.max(0, Math.min(99, (current[id] ?? 0) + change)),
    }));
    setError('');
  }
  return (
    <dialog
      ref={dialog}
      className="pos-portions"
      onCancel={onDismiss}
      onClose={onDismiss}
      aria-labelledby="dish-selection-title"
    >
      <div className="selection-heading">
        <h2 id="dish-selection-title">{dish.name}</h2>
        <button
          className="pos-close"
          aria-label="Close dish selection"
          onClick={onDismiss}
        >
          ×
        </button>
      </div>
      <div className="portion-content">
        <div className="portion-aside">
          <MenuPhoto src={dish.image?.url} name={dish.name} />
          <p className="menu-muted">{props.channel ?? 'Counter'} portions</p>
          {canManageAvailability && (
            <button
              className="pos-item-availability secondary-control"
              disabled={busy}
              onClick={() =>
                onAvailability(!dish.variants.some((v) => v.available))
              }
            >
              {busy
                ? 'Saving…'
                : dish.variants.some((v) => v.available)
                  ? 'Mark dish sold out'
                  : 'Make dish available'}
            </button>
          )}
        </div>
        <div className="portion-options">
          <div className="portion-rows">
            {dish.variants.map((v) => {
              const quantity = v.available ? (quantities[v.id] ?? 0) : 0;
              return (
                <div
                  className={
                    'portion-row' +
                    (quantity > 0 ? ' selected' : '') +
                    (!v.available ? ' unavailable' : '')
                  }
                  key={v.id}
                  data-variant-id={v.id}
                >
                  <div className="portion-row-main">
                    <div className="portion-name">
                      <strong>{v.name}</strong>
                      {'price' in v && <span>₹{rupees(v.price)}</span>}
                    </div>
                    {canCreateOrders && (
                      <div
                        className="portion-quantity"
                        role="group"
                        aria-label={`${v.name} quantity`}
                      >
                        <button
                          aria-label={`Decrease ${v.name} quantity`}
                          disabled={locked || busy || quantity === 0}
                          onClick={() => changeQuantity(v.id, -1)}
                        >
                          −
                        </button>
                        <output aria-label={`${v.name} quantity`}>
                          {quantity}
                        </output>
                        <button
                          aria-label={`Increase ${v.name} quantity`}
                          disabled={
                            locked || busy || !v.available || quantity === 99
                          }
                          onClick={() => changeQuantity(v.id, 1)}
                        >
                          +
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="portion-row-actions">
                    <small>{v.available ? 'Available' : 'Sold out'}</small>
                    {canCreateOrders && v.available && (
                      <InstructionEditor
                        label={`${dish.name} / ${v.name}`}
                        value={notes[v.id] ?? ''}
                        disabled={locked}
                        onChange={(value) =>
                          setNotes((current) => ({ ...current, [v.id]: value }))
                        }
                      />
                    )}
                    {canManageAvailability && (
                      <button
                        className="secondary-control portion-availability"
                        disabled={busy}
                        aria-label={`${v.name}: ${v.available ? 'Mark sold out' : 'Make available'}`}
                        onClick={() => onAvailability(!v.available, v.id)}
                      >
                        {v.available ? 'Mark sold out' : 'Make available'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {actionError && <p role="alert">{actionError}</p>}
          {error && <p role="alert">{error}</p>}
        </div>
      </div>
      {canCreateOrders && (
        <div className="portion-footer">
          <div aria-live="polite">
            <strong>
              {count} {count === 1 ? 'item' : 'items'}
              {total !== null && ` · ₹${rupees(total)}`}
            </strong>
            <div className="portion-summary">
              {selected.length
                ? selected
                    .map((l) => `${l.variantName} ×${l.quantity}`)
                    .join(' · ')
                : 'Choose quantities to add'}
            </div>
          </div>
          <button
            className="portion-add"
            disabled={locked || busy || count === 0}
            onClick={() => {
              try {
                if (props.channel === 'ZOMATO' || props.channel === 'SWIGGY')
                  props.onAdd(selected);
                else props.onAdd(counterLines!);
                onDismiss();
              } catch (e) {
                setError(
                  e instanceof Error ? e.message : 'Could not add selection.',
                );
              }
            }}
          >
            Add {count} {count === 1 ? 'item' : 'items'}
            {total !== null && ` · ₹${rupees(total)}`}
          </button>
        </div>
      )}
    </dialog>
  );
}
