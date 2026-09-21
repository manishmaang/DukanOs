import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import type {
  MenuCatalog,
  MenuCategory,
  MenuItem,
  MenuImage,
} from '@dukanos/shared-types';
import { api, ApiFailure, errorMessage } from './api';
import { MenuPhoto } from './MenuPhoto';
import { notifyMenuChanged } from './menu-refresh';
import {
  dishDraft,
  dishPayload,
  matchingItems,
  newPortion,
  validateDish,
  type DishDraft,
  type DraftVariant,
} from './menu-editor';

function MixedCheckbox({
  checked,
  mixed,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  mixed: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed;
  }, [mixed]);
  return (
    <label className="menu-check">
      <input
        ref={ref}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
      {mixed && <span className="menu-muted"> · some portions</span>}
    </label>
  );
}
function CategoryEditor({
  category,
  onSaved,
  onCancel,
}: {
  category?: MenuCategory;
  onSaved: (category: MenuCategory) => void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    const name = String(d.get('name') ?? '').trim();
    if (!name) {
      setError('Category name is required.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      onSaved(
        await api<MenuCategory>(
          '/menu/categories' + (category ? '/' + category.id : ''),
          category ? 'PATCH' : 'POST',
          {
            name,
            description: d.get('description'),
            active: d.has('active'),
            ...(category ? { version: category.version } : {}),
          },
        ),
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="category-editor" onSubmit={save}>
      <fieldset disabled={busy}>
        <legend>{category ? 'Edit category' : 'Add category'}</legend>
        <label>
          Category name
          <input
            name="name"
            autoFocus
            defaultValue={category?.name ?? ''}
            required
            maxLength={100}
          />
        </label>
        <label>
          Description <span className="menu-muted">optional</span>
          <textarea
            name="description"
            defaultValue={category?.description ?? ''}
            maxLength={1000}
          />
        </label>
        <label className="menu-check">
          <input
            name="active"
            type="checkbox"
            defaultChecked={category?.active ?? true}
          />
          Category active
        </label>
        <small>Inactive categories hide all their dishes from the POS.</small>
        {error && <p role="alert">{error}</p>}
        <div className="menu-actions">
          <button type="submit">{busy ? 'Saving…' : 'Save category'}</button>
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </fieldset>
    </form>
  );
}

function DishEditor({
  catalog,
  item: initialItem,
  categoryId,
  onSaved,
  onDirty,
}: {
  catalog: MenuCatalog;
  item?: MenuItem;
  categoryId: string;
  onSaved: (item: MenuItem) => void;
  onDirty: (dirty: boolean) => void;
}) {
  const [item] = useState(initialItem);
  const [draft, setDraft] = useState<DishDraft>(() =>
    dishDraft(catalog.channels, item, categoryId),
  );
  const [dirty, setDirty] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [photo, setPhoto] = useState<File>();
  const [imageKey, setImageKey] = useState<string | null | undefined>();
  const [preview, setPreview] = useState<string>();
  useEffect(() => {
    if (!photo) {
      setPreview(undefined);
      return;
    }
    const url = URL.createObjectURL(photo);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);
  const errors = validateDish(draft, catalog, item);
  const category = catalog.categories.find((c) => c.id === draft.categoryId);
  function change(next: DishDraft) {
    setDraft(next);
    setDirty(true);
    onDirty(true);
    setError('');
  }
  function portion(key: string, patch: Partial<DraftVariant>) {
    change({
      ...draft,
      variants: draft.variants.map((v) =>
        v.key === key ? { ...v, ...patch } : v,
      ),
    });
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (errors.length) return;
    setBusy(true);
    setError('');
    try {
      let uploadedKey = imageKey;
      if (photo && imageKey === undefined) {
        const data = new FormData();
        data.append('image', photo);
        const uploaded = await api<MenuImage>('/menu/images', 'POST', data);
        uploadedKey = uploaded.key;
        setImageKey(uploaded.key);
      }
      const saved = await api<MenuItem>(
        '/menu/items' + (item ? '/' + item.id : ''),
        item ? 'PUT' : 'POST',
        {
          ...dishPayload(draft),
          ...(uploadedKey !== undefined ? { imageKey: uploadedKey } : {}),
          ...(item ? { version: item.version } : {}),
        },
      );
      onDirty(false);
      notifyMenuChanged();
      onSaved(saved);
    } catch (e) {
      setError(
        e instanceof ApiFailure && e.status === 409
          ? 'This dish changed or a name is already in use. Your edits are still here. Reload the menu and review before saving again.'
          : errorMessage(e),
      );
    } finally {
      setBusy(false);
    }
  }
  const unavailable = !category?.active || !draft.active;
  return (
    <form className="dish-editor" onSubmit={save} noValidate>
      <fieldset disabled={busy}>
        <div className="dish-heading">
          <div>
            <p className="eyebrow">{item ? 'EDIT DISH' : 'NEW DISH'}</p>
            <h2>{draft.name.trim() || 'Create a dish'}</h2>
          </div>
          <span className={'menu-badge ' + (unavailable ? 'off' : '')}>
            {unavailable ? 'Unavailable' : 'Active'}
          </span>
        </div>
        <div className="dish-photo-editor">
          <MenuPhoto
            src={preview ?? (imageKey === null ? undefined : item?.image?.url)}
            name={draft.name || 'Dish'}
          />
          <div>
            <label>
              Dish photo (optional)
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  if (
                    !['image/jpeg', 'image/png', 'image/webp'].includes(
                      file.type,
                    ) ||
                    file.size > 5 * 1024 * 1024
                  ) {
                    setError(
                      'Choose a JPEG, PNG or WebP photo no larger than 5 MB.',
                    );
                    e.target.value = '';
                    return;
                  }
                  e.target.value = '';
                  setPhoto(file);
                  setImageKey(undefined);
                  change(draft);
                }}
              />
            </label>
            <p className="menu-muted">
              JPEG, PNG or WebP, up to 5 MB. Photo changes apply when you save
              this dish.
            </p>
            {(photo || (item?.image && imageKey !== null)) && (
              <button
                type="button"
                onClick={() => {
                  setPhoto(undefined);
                  setImageKey(null);
                  change(draft);
                }}
              >
                Remove photo
              </button>
            )}
          </div>
        </div>
        <aside className="counter-visibility" aria-label="Counter visibility">
          <strong>Counter / POS visibility</strong>
          {!category?.active ? (
            <p>Activate the category to show this dish.</p>
          ) : !draft.active ? (
            <p>This item is paused. Turn on Item active to show it in POS.</p>
          ) : !catalog.channels.find((c) => c.code === 'COUNTER')?.active ? (
            <p>The Counter channel is inactive.</p>
          ) : !draft.variants.some((v) => v.active) ? (
            <p>All portions are inactive. Enable at least one portion.</p>
          ) : !draft.variants.some(
              (v) =>
                v.active &&
                v.channels.some(
                  (c) =>
                    c.channelCode === 'COUNTER' &&
                    c.price.trim() &&
                    c.available,
                ),
            ) ? (
            <ul>
              {draft.variants
                .filter((v) => v.active)
                .map((v) => {
                  const counter = v.channels.find(
                    (c) => c.channelCode === 'COUNTER',
                  );
                  return (
                    <li key={v.key}>
                      {v.name || 'Unnamed portion'}:{' '}
                      {counter?.price.trim()
                        ? 'Counter availability is off.'
                        : 'No Counter price configured.'}
                    </li>
                  );
                })}
            </ul>
          ) : (
            <p>Available portions will appear in POS after saving.</p>
          )}
        </aside>
        <div className="dish-fields">
          <label>
            Item name
            <input
              name="itemName"
              value={draft.name}
              onChange={(e) => change({ ...draft, name: e.target.value })}
              placeholder="e.g. Veg Noodles"
              maxLength={120}
              required
              autoFocus
            />
          </label>
          <label>
            Category
            <select
              name="categoryId"
              value={draft.categoryId}
              onChange={(e) => change({ ...draft, categoryId: e.target.value })}
              required
            >
              <option value="">Choose a category</option>
              {catalog.categories.map((c) => (
                <option
                  key={c.id}
                  value={c.id}
                  disabled={!c.active && c.id !== item?.categoryId}
                >
                  {c.name}
                  {!c.active ? ' (inactive)' : ''}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          Description <span className="menu-muted">optional</span>
          <textarea
            name="description"
            value={draft.description}
            onChange={(e) => change({ ...draft, description: e.target.value })}
            maxLength={1000}
            rows={2}
          />
        </label>
        <label className="menu-check item-availability">
          <input
            name="itemActive"
            type="checkbox"
            checked={draft.active}
            onChange={(e) => change({ ...draft, active: e.target.checked })}
          />
          Item active{' '}
          <span className="menu-muted">
            Turn off to pause this dish on every channel.
          </span>
        </label>
        {!category?.active && category && (
          <p className="notice">
            This category is inactive. Its dishes stay hidden until the category
            is active again.
          </p>
        )}
        <div className="portion-heading">
          <div>
            <h3>Portions & prices</h3>
            <p>
              Prices in ₹ INR. Leave a new price blank if that portion is not
              offered on a channel.
            </p>
          </div>
          <button
            type="button"
            className="secondary"
            onClick={() =>
              change({
                ...draft,
                variants: [...draft.variants, newPortion(catalog.channels)],
              })
            }
          >
            + Add variant
          </button>
        </div>
        <div
          className="dish-prices"
          tabIndex={0}
          role="region"
          aria-label="Portion and channel prices"
        >
          <table>
            <thead>
              <tr>
                <th scope="col">Portion</th>
                {catalog.channels.map((c) => (
                  <th scope="col" key={c.code}>
                    {c.name}
                    {!c.active && (
                      <span className="menu-muted"> (inactive)</span>
                    )}
                  </th>
                ))}
                <th scope="col">Active</th>
              </tr>
            </thead>
            <tbody>
              {draft.variants.map((v, index) => (
                <tr key={v.key} className={!v.active ? 'portion-inactive' : ''}>
                  <th scope="row">
                    <input
                      aria-label={`Portion ${index + 1} name`}
                      value={v.name}
                      placeholder="Standard, Half, 500 ml…"
                      maxLength={80}
                      onChange={(e) => portion(v.key, { name: e.target.value })}
                    />
                    {!v.id && draft.variants.length > 1 && (
                      <button
                        className="text-button"
                        type="button"
                        onClick={() =>
                          change({
                            ...draft,
                            variants: draft.variants.filter(
                              (p) => p.key !== v.key,
                            ),
                          })
                        }
                      >
                        Remove unsaved portion
                      </button>
                    )}
                  </th>
                  {v.channels.map((c) => {
                    const channel = catalog.channels.find(
                      (s) => s.code === c.channelCode,
                    )!;
                    const enabled =
                      !!category?.active &&
                      draft.active &&
                      v.active &&
                      channel.active;
                    return (
                      <td key={c.channelCode}>
                        <label className="price-input">
                          <span aria-hidden="true">₹</span>
                          <input
                            aria-label={`${v.name || `Portion ${index + 1}`} ${channel.name} price`}
                            inputMode="decimal"
                            value={c.price}
                            maxLength={15}
                            placeholder="—"
                            disabled={!enabled}
                            onChange={(e) =>
                              portion(v.key, {
                                channels: v.channels.map((p) =>
                                  p.channelCode === c.channelCode
                                    ? { ...p, price: e.target.value }
                                    : p,
                                ),
                              })
                            }
                          />
                        </label>
                        <label className="menu-check portion-channel">
                          <input
                            type="checkbox"
                            aria-label={`${v.name || `Portion ${index + 1}`} available on ${channel.name}`}
                            checked={c.available}
                            disabled={
                              !c.price.trim() || (!enabled && !c.available)
                            }
                            onChange={(e) =>
                              portion(v.key, {
                                channels: v.channels.map((p) =>
                                  p.channelCode === c.channelCode
                                    ? { ...p, available: e.target.checked }
                                    : p,
                                ),
                              })
                            }
                          />
                          Available
                        </label>
                      </td>
                    );
                  })}
                  <td>
                    <label className="menu-check">
                      <input
                        type="checkbox"
                        aria-label={`${v.name || `Portion ${index + 1}`} active`}
                        checked={v.active}
                        onChange={(e) =>
                          portion(v.key, { active: e.target.checked })
                        }
                      />
                      <span>{v.active ? 'Yes' : 'No'}</span>
                    </label>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="channel-availability">
          <h3>Available on</h3>
          <p>
            Apply to all priced, active portions, or use the individual controls
            above. Saved prices stay when you pause sales.
          </p>
          <div className="menu-actions">
            {catalog.channels.map((c) => {
              const priced = draft.variants.filter((v) =>
                v.channels.some(
                  (s) => s.channelCode === c.code && s.price.trim(),
                ),
              );
              const count = priced.filter((v) =>
                v.channels.some((s) => s.channelCode === c.code && s.available),
              ).length;
              return (
                <MixedCheckbox
                  key={c.code}
                  label={c.name}
                  checked={priced.length > 0 && count === priced.length}
                  mixed={count > 0 && count < priced.length}
                  disabled={
                    !priced.length ||
                    (!count &&
                      (!c.active ||
                        unavailable ||
                        !priced.some((v) => v.active)))
                  }
                  onChange={(checked) =>
                    change({
                      ...draft,
                      variants: draft.variants.map((v) => ({
                        ...v,
                        channels: v.channels.map((s) =>
                          s.channelCode === c.code
                            ? {
                                ...s,
                                available: checked
                                  ? !!s.price.trim() &&
                                    v.active &&
                                    draft.active &&
                                    !!category?.active &&
                                    c.active
                                  : false,
                              }
                            : s,
                        ),
                      })),
                    })
                  }
                />
              );
            })}
          </div>
        </div>
        <details className="dish-extra">
          <summary>
            Kitchen name & short portion labels{' '}
            <span className="menu-muted">optional</span>
          </summary>
          <label>
            Kitchen display name
            <input
              name="kitchenName"
              value={draft.kitchenName}
              maxLength={120}
              onChange={(e) =>
                change({ ...draft, kitchenName: e.target.value })
              }
            />
          </label>
          {draft.variants.map((v) => (
            <label key={v.key}>
              {v.name || 'Portion'} short label
              <input
                value={v.displayLabel}
                maxLength={40}
                onChange={(e) =>
                  portion(v.key, { displayLabel: e.target.value })
                }
              />
            </label>
          ))}
        </details>
        {(dirty || submitted) && errors.length > 0 && (
          <div className="menu-errors" role="alert">
            <ul>
              {errors.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </div>
        )}
        {error && <p role="alert">{error}</p>}
        <div className="dish-save">
          <span>
            {busy
              ? 'Saving the complete dish…'
              : dirty
                ? 'Unsaved changes'
                : item
                  ? 'All changes saved'
                  : 'Create your dish in one save'}
          </span>
          <button type="submit" disabled={busy || (!dirty && !!item)}>
            {busy ? 'Saving…' : item ? 'Save Changes' : 'Save Item'}
          </button>
        </div>
      </fieldset>
    </form>
  );
}
export function MenuAdmin() {
  const [catalog, setCatalog] = useState<MenuCatalog>();
  const [selected, setSelected] = useState<string>('');
  const [draftKey, setDraftKey] = useState(0);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [categoryEditor, setCategoryEditor] = useState<
    MenuCategory | 'new' | null
  >(null);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setCatalog(await api<MenuCatalog>('/menu/admin'));
      setError('');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  function leaveDraft() {
    return !dirty || window.confirm('Discard your unsaved dish changes?');
  }
  function select(id: string) {
    if (id === selected) return;
    if (!leaveDraft()) return;
    setSelected(id);
    setDirty(false);
    setNotice('');
    setDraftKey((k) => k + 1);
  }
  const item = catalog?.items.find((i) => i.id === selected);
  const matches = catalog ? matchingItems(catalog, query) : [];
  function saved(savedItem: MenuItem) {
    notifyMenuChanged();
    setCatalog((c) =>
      c
        ? {
            ...c,
            items: c.items.some((i) => i.id === savedItem.id)
              ? c.items.map((i) => (i.id === savedItem.id ? savedItem : i))
              : [savedItem, ...c.items],
          }
        : c,
    );
    setSelected(savedItem.id);
    setDirty(false);
    setDraftKey((k) => k + 1);
    setNotice(`${savedItem.name} saved.`);
    void refresh();
  }
  return (
    <section className="menu-workspace">
      <div className="menu-title">
        <div>
          <p className="eyebrow">YOUR RESTAURANT</p>
          <h1>Menu</h1>
          <p>Create and maintain a dish in one place.</p>
        </div>
        <button
          className="secondary"
          disabled={loading}
          onClick={async () => {
            if (leaveDraft()) {
              await refresh();
              setDirty(false);
              setDraftKey((k) => k + 1);
            }
          }}
        >
          Reload menu
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {notice && (
        <p className="menu-success" role="status">
          {notice}
        </p>
      )}
      {!catalog && (
        <p role="status">
          {loading
            ? 'Loading menu…'
            : 'Menu could not be loaded. Try reloading.'}
        </p>
      )}
      {catalog && (
        <div className="menu-layout">
          <aside className="menu-sidebar" aria-label="Menu dishes">
            <label className="menu-search">
              Search menu
              <input
                type="search"
                value={query}
                placeholder="Dish, category or portion"
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <button
              className="add-dish"
              onClick={() => {
                if (leaveDraft()) {
                  setSelected('new');
                  setDirty(false);
                  setDraftKey((k) => k + 1);
                  setNotice('');
                }
              }}
            >
              + Add Item
            </button>
            <div className="menu-list">
              {catalog.categories
                .filter(
                  (c) =>
                    !query.trim() ||
                    matches.some((i) => i.categoryId === c.id) ||
                    c.name.toLowerCase().includes(query.trim().toLowerCase()),
                )
                .map((c) => (
                  <div className="menu-group" key={c.id}>
                    <div className="menu-group-heading">
                      <h3>
                        {c.name}
                        {!c.active && (
                          <span className="menu-badge off">Inactive</span>
                        )}
                      </h3>
                      <button
                        className="text-button"
                        aria-label={'Edit category ' + c.name}
                        onClick={() => setCategoryEditor(c)}
                      >
                        Edit
                      </button>
                    </div>
                    {matches
                      .filter((i) => i.categoryId === c.id)
                      .map((i) => (
                        <button
                          className={
                            'dish-link ' + (selected === i.id ? 'selected' : '')
                          }
                          aria-pressed={selected === i.id}
                          key={i.id}
                          onClick={() => select(i.id)}
                        >
                          <span>{i.name}</span>
                          <span
                            className={
                              'menu-badge ' +
                              (!i.active || !c.active ? 'off' : '')
                            }
                          >
                            {!i.active || !c.active
                              ? 'Inactive'
                              : i.variants.some(
                                    (v) =>
                                      v.active &&
                                      v.channels.some(
                                        (s) =>
                                          s.available &&
                                          catalog.channels.find(
                                            (ch) => ch.code === s.channelCode,
                                          )?.active,
                                      ),
                                  )
                                ? 'Available'
                                : 'Not offered'}
                          </span>
                        </button>
                      ))}
                    {!matches.some((i) => i.categoryId === c.id) && (
                      <p className="menu-empty">No dishes yet</p>
                    )}
                  </div>
                ))}
            </div>
            {query && !matches.length && (
              <p className="menu-empty">No matching dishes.</p>
            )}
            <button
              className="secondary"
              onClick={() => setCategoryEditor('new')}
            >
              + Add Category
            </button>
            {categoryEditor && (
              <CategoryEditor
                key={
                  categoryEditor === 'new'
                    ? 'new'
                    : categoryEditor.id + categoryEditor.version
                }
                category={categoryEditor === 'new' ? undefined : categoryEditor}
                onCancel={() => setCategoryEditor(null)}
                onSaved={(category) => {
                  notifyMenuChanged();
                  setCatalog((c) =>
                    c
                      ? {
                          ...c,
                          categories: c.categories.some(
                            (p) => p.id === category.id,
                          )
                            ? c.categories.map((p) =>
                                p.id === category.id ? category : p,
                              )
                            : [category, ...c.categories],
                        }
                      : c,
                  );
                  setCategoryEditor(null);
                  void refresh();
                }}
              />
            )}
          </aside>
          <div className="menu-detail">
            {item || selected === 'new' ? (
              <DishEditor
                key={selected + ':' + draftKey}
                catalog={catalog}
                item={item}
                categoryId={catalog.categories.find((c) => c.active)?.id ?? ''}
                onDirty={setDirty}
                onSaved={saved}
              />
            ) : (
              <div className="menu-welcome">
                <h2>Your dishes, made simple</h2>
                <p>
                  Select a dish to edit its portions, prices and availability.
                  Or add your first item.
                </p>
                <button onClick={() => select('new')}>+ Add Item</button>
                {!catalog.categories.length && (
                  <p>Create a category in the menu list first.</p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
export { MenuPreview } from './MenuPreview';
