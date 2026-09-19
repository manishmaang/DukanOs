import type {
  MenuCatalog,
  MenuItem,
  MenuItemInput,
  SalesChannel,
} from '@dukanos/shared-types';

export const rupees = (price: string) =>
  price.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
export interface DraftPrice {
  channelCode: string;
  price: string;
  available: boolean;
}
export interface DraftVariant {
  key: string;
  id?: string;
  name: string;
  displayLabel: string;
  active: boolean;
  channels: DraftPrice[];
}
export interface DishDraft {
  name: string;
  categoryId: string;
  description: string;
  kitchenName: string;
  active: boolean;
  variants: DraftVariant[];
}
let nextPortionKey = 0;
export function newPortion(channels: SalesChannel[], name = ''): DraftVariant {
  return {
    key: 'new-portion-' + nextPortionKey++,
    name,
    displayLabel: '',
    active: true,
    channels: channels.map((c) => ({
      channelCode: c.code,
      price: '',
      available: false,
    })),
  };
}
export function dishDraft(
  channels: SalesChannel[],
  item?: MenuItem,
  categoryId = '',
): DishDraft {
  if (!item)
    return {
      name: '',
      categoryId,
      description: '',
      kitchenName: '',
      active: true,
      variants: [newPortion(channels, 'Standard')],
    };
  return {
    name: item.name,
    categoryId: item.categoryId,
    description: item.description ?? '',
    kitchenName: item.kitchenName ?? '',
    active: item.active,
    variants: item.variants.map((v) => ({
      key: v.id,
      id: v.id,
      name: v.name,
      displayLabel: v.displayLabel ?? '',
      active: v.active,
      channels: channels.map((c) => {
        const s = v.channels.find((s) => s.channelCode === c.code);
        return {
          channelCode: c.code,
          price: s ? rupees(s.price) : '',
          available: s?.available ?? false,
        };
      }),
    })),
  };
}
export function dishPayload(draft: DishDraft): MenuItemInput {
  return {
    ...draft,
    variants: draft.variants.map(
      ({ id, name, displayLabel, active, channels }) => ({
        ...(id ? { id } : {}),
        name: name.trim(),
        displayLabel,
        active,
        channels: channels
          .filter((c) => c.price.trim() !== '')
          .map((c) => ({ ...c, price: c.price.trim() })),
      }),
    ),
  };
}
export function validateDish(
  draft: DishDraft,
  catalog: MenuCatalog,
  item?: MenuItem,
): string[] {
  const errors: string[] = [];
  if (!draft.name.trim()) errors.push('Item name is required.');
  const category = catalog.categories.find((c) => c.id === draft.categoryId);
  if (!category) errors.push('Choose a category.');
  if (!draft.variants.length) errors.push('At least one portion is required.');
  const names = new Set<string>();
  for (const v of draft.variants) {
    if (!v.name.trim())
      errors.push(
        'Give every portion a name, such as Standard, Half or 500 ml.',
      );
    const name = v.name.trim().toLowerCase();
    if (names.has(name))
      errors.push('Portion names must be unique within this item.');
    names.add(name);
    const previous = item?.variants.find((p) => p.id === v.id);
    for (const c of v.channels) {
      const label =
        catalog.channels.find((s) => s.code === c.channelCode)?.name ??
        c.channelCode;
      const price = c.price.trim();
      const saved = previous?.channels.find(
        (s) => s.channelCode === c.channelCode,
      );
      if (price.startsWith('-'))
        errors.push(
          `${v.name || 'Portion'}: ${label} price cannot be negative.`,
        );
      else if (price && !/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/.test(price))
        errors.push(
          `${v.name || 'Portion'}: enter a valid ${label} price with at most two decimal places.`,
        );
      if (!price && (saved || c.available))
        errors.push(
          `${v.name || 'Portion'}: keep a ${label} price, or switch off availability for an unpriced portion.`,
        );
      const changed =
        price && (!saved || rupees(saved.price) !== rupees(price));
      if (
        (changed || (c.available && !saved?.available)) &&
        !(
          category?.active &&
          draft.active &&
          v.active &&
          catalog.channels.find((s) => s.code === c.channelCode)?.active
        )
      )
        errors.push(
          `Enable the category, item, portion and ${label} before changing its price or enabling sales.`,
        );
    }
  }
  return [...new Set(errors)];
}
export function matchingItems(catalog: MenuCatalog, query: string): MenuItem[] {
  const text = query.trim().toLowerCase();
  return catalog.items.filter((i) =>
    [
      i.name,
      catalog.categories.find((c) => c.id === i.categoryId)?.name ?? '',
      ...i.variants.map((v) => v.name),
    ].some((s) => s.toLowerCase().includes(text)),
  );
}
