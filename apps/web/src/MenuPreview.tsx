import { useEffect, useRef, useState } from 'react';
import type { OperationalMenu } from '@dukanos/shared-types';
import { api, errorMessage } from './api';
import { rupees } from './menu-editor';
import { MenuPhoto } from './MenuPhoto';
type Dish = OperationalMenu['categories'][number]['items'][number];
export function lowestPrice(item: Dish) {
  return item.variants.reduce(
    (lowest, v) =>
      BigInt(v.price.replace('.', '')) < BigInt(lowest.replace('.', ''))
        ? v.price
        : lowest,
    item.variants[0]!.price,
  );
}
export function MenuPreview() {
  const [menu, setMenu] = useState<OperationalMenu>();
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [selected, setSelected] = useState<string>();
  const [revision, setRevision] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    let alive = true;
    let sequence = 0;
    const refresh = async () => {
      const request = ++sequence;
      try {
        const result = await api<OperationalMenu>('/menu?channel=COUNTER');
        if (alive && request === sequence) {
          setMenu(result);
          setError('');
        }
      } catch (e) {
        if (alive && request === sequence) {
          setError(errorMessage(e));
          setMenu(undefined);
        }
      }
    };
    const visible = () => {
      if (!document.hidden) void refresh();
    };
    void refresh();
    const interval = window.setInterval(visible, 15000);
    const broadcast =
      'BroadcastChannel' in window
        ? new BroadcastChannel('dukanos-menu')
        : null;
    if (broadcast) broadcast.onmessage = visible;
    window.addEventListener('focus', visible);
    window.addEventListener('dukanos-menu-changed', visible);
    document.addEventListener('visibilitychange', visible);
    return () => {
      alive = false;
      clearInterval(interval);
      broadcast?.close();
      window.removeEventListener('focus', visible);
      window.removeEventListener('dukanos-menu-changed', visible);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [revision]);
  const dish = menu?.categories
    .flatMap((c) => c.items)
    .find((i) => i.id === selected);
  useEffect(() => {
    if (dish && !dialog.current?.open) dialog.current?.showModal();
    else if (!dish) dialog.current?.close();
  }, [dish]);
  const activeCategory = menu?.categories.some((c) => c.id === category)
    ? category
    : '';
  const text = query.trim().toLowerCase();
  const categories = menu?.categories
    .filter((c) => !activeCategory || c.id === activeCategory)
    .map((c) => ({
      ...c,
      items: c.items.filter((i) =>
        [c.name, i.name, ...i.variants.map((v) => v.name)].some((value) =>
          value.toLowerCase().includes(text),
        ),
      ),
    }))
    .filter((c) => c.items.length);
  return (
    <section className="pos-menu">
      <div className="pos-menu-heading">
        <div>
          <h1>
            POS <span className="pos-channel">Counter</span>
          </h1>
          <p className="menu-muted">
            Tap a dish to view portions. Read-only; ordering is not available
            yet.
          </p>
        </div>
        <button onClick={() => setRevision((r) => r + 1)}>Refresh menu</button>
      </div>
      <label className="pos-search">
        Search dishes
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Dish, category or portion"
        />
      </label>
      <nav className="pos-categories" aria-label="Menu categories">
        <button aria-pressed={!activeCategory} onClick={() => setCategory('')}>
          All dishes
        </button>
        {menu?.categories.map((c) => (
          <button
            key={c.id}
            aria-pressed={activeCategory === c.id}
            onClick={() => setCategory(c.id)}
          >
            {c.name}
          </button>
        ))}
      </nav>
      {error && (
        <p role="alert">
          {error} Menu is unavailable until the connection is restored.
        </p>
      )}
      {!menu && !error && <p role="status">Loading menu…</p>}
      {menu && !categories?.length && (
        <p role="status">
          {text
            ? 'No matching dishes.'
            : 'No dishes are currently available at Counter.'}
        </p>
      )}
      {categories?.map((c) => (
        <section key={c.id}>
          <h3>{c.name}</h3>
          <div className="pos-grid">
            {c.items.map((i) => (
              <button
                className="pos-card"
                key={i.id}
                onClick={() => setSelected(i.id)}
              >
                <MenuPhoto src={i.image?.url} name={i.name} />
                <span className="pos-card-info">
                  <strong>{i.name}</strong>
                  <span>
                    {i.variants.length > 1 ? 'From ' : ''}₹
                    {rupees(lowestPrice(i))}
                  </span>
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
      <dialog
        ref={dialog}
        className="pos-portions"
        onCancel={() => setSelected(undefined)}
        onClose={() => setSelected(undefined)}
        aria-label={dish ? dish.name + ' portions' : 'Portions'}
      >
        {dish && (
          <>
            <button
              className="pos-close"
              onClick={() => {
                dialog.current?.close();
                setSelected(undefined);
              }}
            >
              Close
            </button>
            <MenuPhoto src={dish.image?.url} name={dish.name} />
            <h2>{dish.name}</h2>
            <p>Counter prices · Read-only</p>
            <ul>
              {dish.variants.map((v) => (
                <li key={v.id}>
                  <strong>{v.displayLabel || v.name}</strong>
                  <span>₹{rupees(v.price)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </dialog>
    </section>
  );
}
