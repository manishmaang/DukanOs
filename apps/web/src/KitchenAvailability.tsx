import { useCallback, useEffect, useRef, useState } from 'react';
import type { OperationalMenu } from '@dukanos/shared-types';
import { api, ApiFailure, errorMessage } from './api';
import { notifyMenuChanged } from './menu-refresh';
type Dish = OperationalMenu['categories'][number]['items'][number];
export function KitchenAvailability({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(true);
  const sequence = useRef(0);
  const changing = useRef(false);
  const reading = useRef(false);
  const [menu, setMenu] = useState<OperationalMenu | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const refresh = useCallback(async (force = false) => {
    if (!force && (changing.current || reading.current || document.hidden))
      return;
    const request = ++sequence.current;
    reading.current = true;
    try {
      const next = await api<OperationalMenu>('/menu/counter');
      if (alive.current && request === sequence.current) {
        setMenu(next);
        setError('');
      }
    } catch (e) {
      if (alive.current && request === sequence.current) {
        setMenu(null);
        setError(errorMessage(e));
      }
    } finally {
      if (request === sequence.current) reading.current = false;
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    const modal = dialog.current!;
    modal.showModal();
    void refresh(true);
    const visible = () => {
      void refresh();
    };
    const timer = window.setInterval(visible, 5000);
    const channel =
      'BroadcastChannel' in window
        ? new BroadcastChannel('dukanos-menu')
        : null;
    if (channel) channel.onmessage = visible;
    window.addEventListener('focus', visible);
    window.addEventListener('online', visible);
    window.addEventListener('dukanos-menu-changed', visible);
    document.addEventListener('visibilitychange', visible);
    return () => {
      alive.current = false;
      sequence.current++;
      reading.current = false;
      modal.close();
      clearInterval(timer);
      channel?.close();
      window.removeEventListener('focus', visible);
      window.removeEventListener('online', visible);
      window.removeEventListener('dukanos-menu-changed', visible);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [refresh]);
  async function change(item: Dish, available: boolean, variantId?: string) {
    if (changing.current) return;
    changing.current = true;
    sequence.current++;
    setBusy(true);
    setNotice('');
    try {
      const next = await api<OperationalMenu>(
        `/menu/counter/items/${item.id}/availability`,
        'PATCH',
        {
          version: item.version,
          available,
          ...(variantId ? { variantId } : {}),
        },
      );
      if (alive.current) {
        setMenu(next);
        setError('');
        setNotice(
          `${item.name}${variantId ? ' / ' + item.variants.find((v) => v.id === variantId)?.name : ''}: ${available ? 'available' : 'sold out'} at Counter.`,
        );
      }
      notifyMenuChanged();
    } catch (e) {
      if (alive.current) {
        setMenu(null);
        setNotice(
          e instanceof ApiFailure && e.status === 409
            ? 'Availability changed on another device. Review the refreshed list and try again.'
            : errorMessage(e),
        );
        await refresh(true);
      }
    } finally {
      changing.current = false;
      reading.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const text = query.trim().toLowerCase();
  const items = menu?.categories.flatMap((c) =>
    c.items.filter((i) =>
      [c.name, i.name, ...i.variants.map((v) => v.name)].some((s) =>
        s.toLowerCase().includes(text),
      ),
    ),
  );
  return (
    <dialog
      ref={dialog}
      className="kds-availability"
      aria-labelledby="availability-heading"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="availability-header">
        <h2 id="availability-heading">Counter availability</h2>
        <button onClick={onClose} aria-label="Close availability">
          Close
        </button>
      </div>
      <p>Sold-out changes affect new Counter orders only.</p>
      <label>
        Search dishes
        <input
          autoFocus
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Dish, category or portion"
        />
      </label>
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert">
          {error} <button onClick={() => void refresh(true)}>Retry</button>
        </p>
      )}
      {!menu && !error && <p role="status">Loading availability…</p>}
      <div className="availability-list">
        {items?.map((item) => (
          <article key={item.id} className="availability-dish">
            <div className="availability-dish-heading">
              <h3>{item.name}</h3>
              <button
                disabled={busy}
                onClick={() =>
                  void change(item, !item.variants.some((v) => v.available))
                }
              >
                {item.variants.some((v) => v.available)
                  ? 'Mark whole dish sold out'
                  : 'Make whole dish available'}
              </button>
            </div>
            {item.variants.map((v) => (
              <div key={v.id} className="availability-portion">
                <strong>{v.name}</strong>
                <span className={v.available ? '' : 'availability-sold'}>
                  {v.available ? 'Available' : 'SOLD OUT'}
                </span>
                <button
                  disabled={busy}
                  aria-label={`${item.name} / ${v.name}: ${v.available ? 'Mark sold out' : 'Make available'}`}
                  onClick={() => void change(item, !v.available, v.id)}
                >
                  {v.available ? 'Mark sold out' : 'Make available'}
                </button>
              </div>
            ))}
          </article>
        ))}
        {items?.length === 0 && <p>No matching Counter dishes.</p>}
      </div>
    </dialog>
  );
}
