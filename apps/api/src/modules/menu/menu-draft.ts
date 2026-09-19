import { ConflictException } from '@nestjs/common';
import type {
  MenuCatalog,
  MenuItem,
  MenuItemInput,
} from '@dukanos/shared-types';
import { menuError, money, optionalText, textName } from './menu-policy';

/** Validate a complete dish without writing; omitted stored records are never deleted. */
function duplicate(message: string): never {
  throw new ConflictException({ code: 'MENU_DUPLICATE', message });
}
export function prepareDish(
  catalog: MenuCatalog,
  input: MenuItemInput,
  old?: MenuItem,
) {
  const category = catalog.categories.find((c) => c.id === input.categoryId);
  if (!category)
    menuError('MENU_CATEGORY_NOT_FOUND', 'Choose an existing category.');
  const active = input.active ?? old?.active ?? true;
  if (
    !category.active &&
    (!old || old.categoryId !== category.id || (!old.active && active))
  )
    menuError(
      'MENU_REFERENCE_INACTIVE',
      'Activate this category before adding or enabling a dish.',
    );
  const name = textName(input.name, 120);
  if (
    catalog.items.some(
      (i) =>
        i.id !== old?.id &&
        i.categoryId === category.id &&
        i.name.toLowerCase() === name.toLowerCase(),
    )
  )
    duplicate('A dish with this name already exists in this category.');
  if (!input.variants?.length)
    menuError('ITEM_REQUIRES_VARIANT', 'At least one portion is required.');
  const ids = new Set<string>();
  const names = new Set<string>();
  const variants = input.variants.map((v) => {
    const previous = v.id
      ? old?.variants.find((p) => p.id === v.id)
      : undefined;
    if (v.id && (!previous || ids.has(v.id)))
      menuError(
        'MENU_VARIANT_INVALID',
        'A portion was repeated or does not belong to this dish. Reload the dish.',
      );
    if (v.id) ids.add(v.id);
    const variantName = textName(v.name, 80);
    const key = variantName.toLowerCase();
    if (names.has(key))
      duplicate('Portion names must be unique within this dish.');
    names.add(key);
    const variantActive = v.active ?? previous?.active ?? true;
    if (
      ((!previous && !!old) ||
        (previous && !previous.active && variantActive)) &&
      !(category.active && active)
    )
      menuError(
        'MENU_REFERENCE_INACTIVE',
        'Enable the category and dish before adding or enabling portions.',
      );
    const codes = new Set<string>();
    const channels = (v.channels ?? []).map((s) => {
      const channel = catalog.channels.find((c) => c.code === s.channelCode);
      if (!channel)
        menuError('MENU_CHANNEL_INVALID', 'Choose a configured sales channel.');
      if (codes.has(s.channelCode))
        duplicate('A sales channel was repeated for this portion.');
      codes.add(s.channelCode);
      const price = money(s.price);
      const before = previous?.channels.find(
        (c) => c.channelCode === s.channelCode,
      );
      const changedPrice = !before || money(before.price) !== price;
      const enabling = s.available && !before?.available;
      // Unchanged saved flags/prices survive deactivation. New prices or enabling
      // require active final references, just like the existing granular endpoints.
      if (
        (changedPrice || enabling) &&
        !(category.active && active && variantActive && channel.active)
      )
        menuError(
          'MENU_REFERENCE_INACTIVE',
          `Enable the category, dish, portion and ${channel.name} before changing its price or enabling sales.`,
        );
      return { channelCode: s.channelCode, price, available: s.available };
    });
    if (previous?.channels.some((c) => !codes.has(c.channelCode)))
      menuError(
        'MENU_PRICE_REQUIRED',
        'Keep saved prices and turn off availability instead of clearing them.',
      );
    return {
      id: v.id,
      name: variantName,
      displayLabel: optionalText(v.displayLabel, 40),
      active: variantActive,
      channels,
    };
  });
  if (old?.variants.some((v) => !ids.has(v.id)))
    menuError(
      'MENU_VARIANT_REQUIRED',
      'Keep existing portions and deactivate any that are no longer needed.',
    );
  return {
    categoryId: category.id,
    name,
    description: optionalText(input.description, 1000),
    kitchenName: optionalText(input.kitchenName, 120),
    active,
    variants,
  };
}
