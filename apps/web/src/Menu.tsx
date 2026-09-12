import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import type {
  MenuCatalog,
  MenuItem,
  OperationalMenu,
  SalesChannel,
} from '@dukanos/shared-types';
import { api, errorMessage } from './api';

function Editor({
  children,
  save,
  disabled = false,
}: {
  children: ReactNode;
  save: (data: FormData) => Promise<void>;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setBusy(true);
    setError('');
    try {
      await save(new FormData(form));
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit}>
      <fieldset disabled={busy || disabled}>
        {children}
        <button>Save</button>
      </fieldset>
      {error && (
        <p role="alert">
          {error} Refresh the menu if another person has changed it.
        </p>
      )}
    </form>
  );
}
const value = (data: FormData, name: string) => String(data.get(name) ?? '');
function NameOrder({
  name = '',
  sortOrder = 0,
  max = 120,
}: {
  name?: string;
  sortOrder?: number;
  max?: number;
}) {
  return (
    <>
      <label>
        Name
        <input name="name" defaultValue={name} required maxLength={max} />
      </label>
      <label>
        Display order
        <input
          name="sortOrder"
          type="number"
          defaultValue={sortOrder}
          min="0"
          max="2147483647"
          required
        />
      </label>
    </>
  );
}

export function MenuAdmin() {
  const [catalog, setCatalog] = useState<MenuCatalog>();
  const [error, setError] = useState('');
  const [selected, setSelected] = useState('');
  const refresh = useCallback(async () => {
    try {
      setCatalog(await api<MenuCatalog>('/menu/admin'));
      setError('');
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  async function mutate(path: string, method: string, body: unknown) {
    await api(path, method, body);
    await refresh();
  }
  const item = catalog?.items.find((i) => i.id === selected);
  return (
    <section className="menu-admin">
      <h2>Menu management</h2>
      <button onClick={() => void refresh()}>Refresh menu</button>
      {error && <p role="alert">{error}</p>}
      {catalog && (
        <>
          <details>
            <summary>Categories</summary>
            <h3>Create category</h3>
            <Editor
              key={'create-category-' + catalog.categories.length}
              save={async (d) =>
                mutate('/menu/categories', 'POST', {
                  name: value(d, 'name'),
                  description: value(d, 'description'),
                  sortOrder: Number(value(d, 'sortOrder')),
                })
              }
            >
              <NameOrder max={100} />
              <label>
                Description
                <textarea name="description" maxLength={1000} />
              </label>
            </Editor>
            {catalog.categories.map((c) => (
              <details key={c.id + ':' + c.version}>
                <summary>
                  {c.name}
                  {!c.active ? ' (inactive)' : ''}
                </summary>
                <Editor
                  save={async (d) =>
                    mutate('/menu/categories/' + c.id, 'PATCH', {
                      version: c.version,
                      name: value(d, 'name'),
                      description: value(d, 'description'),
                      sortOrder: Number(value(d, 'sortOrder')),
                      active: d.has('active'),
                    })
                  }
                >
                  <NameOrder name={c.name} max={100} sortOrder={c.sortOrder} />
                  <label>
                    Description
                    <textarea
                      name="description"
                      defaultValue={c.description ?? ''}
                      maxLength={1000}
                    />
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      name="active"
                      defaultChecked={c.active}
                    />
                    Active category
                  </label>
                </Editor>
              </details>
            ))}
          </details>
          <details>
            <summary>Create menu item</summary>
            <Editor
              key={'new-item-' + catalog.items.length}
              disabled={!catalog.categories.some((c) => c.active)}
              save={async (d) => {
                const created = await api<MenuItem>('/menu/items', 'POST', {
                  categoryId: value(d, 'categoryId'),
                  name: value(d, 'name'),
                  description: value(d, 'description'),
                  sortOrder: Number(value(d, 'sortOrder')),
                  variants: [{ name: value(d, 'variant') }],
                });
                setSelected(created.id);
                await refresh();
              }}
            >
              <label>
                Category
                <select name="categoryId" required>
                  {catalog.categories
                    .filter((c) => c.active)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </select>
              </label>
              <NameOrder />
              <label>
                Description
                <textarea name="description" maxLength={1000} />
              </label>
              <label>
                First variant (for example Half, Large or 500 ml)
                <input name="variant" required maxLength={80} />
              </label>
              <p>Add more variants after creating the item.</p>
            </Editor>
          </details>
          <label>
            Choose item
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value="">Select an item</option>
              {catalog.items.map((i) => (
                <option key={i.id} value={i.id}>
                  {catalog.categories.find((c) => c.id === i.categoryId)?.name}{' '}
                  / {i.name}
                  {!i.active ? ' (inactive)' : ''}
                </option>
              ))}
            </select>
          </label>
          {item && (
            <div key={item.id + ':' + item.version}>
              <h3>{item.name}</h3>
              <Editor
                save={async (d) =>
                  mutate('/menu/items/' + item.id, 'PATCH', {
                    version: item.version,
                    categoryId: value(d, 'categoryId'),
                    name: value(d, 'name'),
                    description: value(d, 'description'),
                    kitchenName: value(d, 'kitchenName'),
                    sortOrder: Number(value(d, 'sortOrder')),
                    active: d.has('active'),
                  })
                }
              >
                <label>
                  Category
                  <select name="categoryId" defaultValue={item.categoryId}>
                    {catalog.categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                        {!c.active ? ' (inactive)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <NameOrder name={item.name} sortOrder={item.sortOrder} />
                <label>
                  Description
                  <textarea
                    name="description"
                    maxLength={1000}
                    defaultValue={item.description ?? ''}
                  />
                </label>
                <label>
                  Kitchen display name
                  <input
                    name="kitchenName"
                    maxLength={120}
                    defaultValue={item.kitchenName ?? ''}
                  />
                </label>
                <label>
                  <input
                    name="active"
                    type="checkbox"
                    defaultChecked={item.active}
                  />
                  Active item
                </label>
              </Editor>
              <h3>Variants and channel pricing (INR)</h3>
              <p>
                Save a price, then enable availability. Deactivating an item or
                variant hides it across all channels. Prices remain saved.
              </p>
              <div className="menu-table">
                <table>
                  <thead>
                    <tr>
                      <th>Variant</th>
                      {catalog.channels.map((c) => (
                        <th key={c.code}>
                          {c.name}
                          {!c.active ? ' (inactive)' : ''}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {item.variants.map((v) => (
                      <tr key={v.id}>
                        <td>
                          <Editor
                            save={async (d) =>
                              mutate('/menu/variants/' + v.id, 'PATCH', {
                                itemVersion: item.version,
                                name: value(d, 'name'),
                                displayLabel: value(d, 'displayLabel'),
                                sortOrder: Number(value(d, 'sortOrder')),
                                active: d.has('active'),
                              })
                            }
                          >
                            <NameOrder
                              name={v.name}
                              sortOrder={v.sortOrder}
                              max={80}
                            />
                            <label>
                              Short label
                              <input
                                name="displayLabel"
                                defaultValue={v.displayLabel ?? ''}
                                maxLength={40}
                              />
                            </label>
                            <label>
                              <input
                                name="active"
                                type="checkbox"
                                defaultChecked={v.active}
                              />
                              Active variant
                            </label>
                          </Editor>
                        </td>
                        {catalog.channels.map((c) => {
                          const setting = v.channels.find(
                            (p) => p.channelCode === c.code,
                          );
                          const active =
                            item.active &&
                            v.active &&
                            c.active &&
                            !!catalog.categories.find(
                              (cat) => cat.id === item.categoryId,
                            )?.active;
                          const base =
                            '/menu/variants/' +
                            v.id +
                            '/channels/' +
                            encodeURIComponent(c.code);
                          return (
                            <td key={c.code}>
                              <Editor
                                disabled={!active}
                                save={async (d) =>
                                  mutate(base + '/price', 'PUT', {
                                    itemVersion: item.version,
                                    price: value(d, 'price'),
                                  })
                                }
                              >
                                <label>
                                  {v.name} / {c.name} price
                                  <input
                                    name="price"
                                    inputMode="decimal"
                                    defaultValue={setting?.price ?? ''}
                                    required
                                    pattern="(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?"
                                    maxLength={15}
                                  />
                                </label>
                              </Editor>
                              <Editor
                                disabled={!setting}
                                save={async (d) =>
                                  mutate(base + '/availability', 'PATCH', {
                                    itemVersion: item.version,
                                    available: d.has('available'),
                                  })
                                }
                              >
                                <label>
                                  <input
                                    name="available"
                                    type="checkbox"
                                    defaultChecked={setting?.available ?? false}
                                  />
                                  Available on {c.name}
                                </label>
                              </Editor>
                              {!active && (
                                <small>
                                  Inactive category, item, variant or channel.
                                </small>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <details>
                <summary>Add variant</summary>
                <Editor
                  save={async (d) =>
                    mutate('/menu/items/' + item.id + '/variants', 'POST', {
                      itemVersion: item.version,
                      name: value(d, 'name'),
                      sortOrder: Number(value(d, 'sortOrder')),
                    })
                  }
                >
                  <NameOrder max={80} />
                </Editor>
              </details>
            </div>
          )}
        </>
      )}
    </section>
  );
}
export function MenuPreview() {
  const [channels, setChannels] = useState<SalesChannel[]>([]);
  const [channel, setChannel] = useState('');
  const [menu, setMenu] = useState<OperationalMenu>();
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let current = true;
    void api<SalesChannel[]>('/menu/channels')
      .then((rows) => {
        if (current) {
          setChannels(rows.filter((c) => c.active));
          setChannel(rows.find((c) => c.active)?.code ?? '');
        }
      })
      .catch((e) => {
        if (current) setError(errorMessage(e));
      });
    return () => {
      current = false;
    };
  }, []);
  useEffect(() => {
    let current = true;
    setMenu(undefined);
    if (channel)
      void api<OperationalMenu>('/menu?channel=' + encodeURIComponent(channel))
        .then((result) => {
          if (current) {
            setMenu(result);
            setError('');
          }
        })
        .catch((e) => {
          if (current) setError(errorMessage(e));
        });
    return () => {
      current = false;
    };
  }, [channel, revision]);
  return (
    <section>
      <h2>Menu preview</h2>
      <p>Read-only menu. Ordering is not available yet.</p>
      <label>
        Sales channel
        <select value={channel} onChange={(e) => setChannel(e.target.value)}>
          {channels.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <button onClick={() => setRevision((r) => r + 1)}>Refresh menu</button>
      {error && <p role="alert">{error}</p>}
      {menu?.categories.length === 0 && (
        <p>No available products for this channel.</p>
      )}
      {menu?.categories.map((c) => (
        <section key={c.id}>
          <h3>{c.name}</h3>
          {c.items.map((i) => (
            <article key={i.id}>
              <h4>{i.name}</h4>
              <ul>
                {i.variants.map((v) => (
                  <li key={v.id}>
                    {v.name} — ₹{v.price}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </section>
      ))}
    </section>
  );
}
