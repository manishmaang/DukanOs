import type { CounterOrderInput } from '@dukanos/shared-types';
export interface CartLine {
  id: string;
  menuItemId: string;
  variantId: string;
  itemName: string;
  variantName: string;
  price: string;
  quantity: number;
  instruction: string;
}
export function cartPaise(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
}
export function cartAmount(value: bigint) {
  return `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
}
export function addLine(lines: CartLine[], line: CartLine): CartLine[] {
  const normalized = { ...line, instruction: line.instruction.trim() };
  const index = lines.findIndex(
    (l) =>
      l.menuItemId === line.menuItemId &&
      l.variantId === line.variantId &&
      cartPaise(l.price) === cartPaise(line.price) &&
      l.instruction === normalized.instruction,
  );
  if (index < 0) {
    if (lines.length >= 100)
      throw new Error('An order may contain at most 100 lines.');
    return [...lines, normalized];
  }
  if (lines[index]!.quantity + line.quantity > 99)
    throw new Error('A line may contain at most 99 portions.');
  return lines.map((l, i) =>
    i === index ? { ...l, quantity: l.quantity + line.quantity } : l,
  );
}
export function orderInput(
  lines: CartLine[],
  requestId: string,
): CounterOrderInput {
  return {
    requestId,
    lines: lines.map(({ variantId, quantity, instruction }) => ({
      variantId,
      quantity,
      instruction,
    })),
  };
}

/** getRandomValues also works on trusted-shop HTTP LAN origins without randomUUID. */
export function confirmationId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(
    '',
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Apply the complete dish selection atomically; a failed merge leaves the cart intact. */
export function addLines(lines: CartLine[], additions: CartLine[]): CartLine[] {
  return additions.reduce((next, line) => addLine(next, line), lines);
}
export function selectionLines(
  dish: import('@dukanos/shared-types').OperationalMenu['categories'][number]['items'][number],
  quantities: Record<string, number>,
  notes: Record<string, string>,
): CartLine[] {
  return dish.variants.flatMap((variant) => {
    const quantity = quantities[variant.id] ?? 0;
    if (
      !variant.available ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > 99
    )
      return [];
    return [
      {
        id: confirmationId(),
        menuItemId: dish.id,
        variantId: variant.id,
        itemName: dish.name,
        variantName: variant.name,
        price: variant.price,
        quantity,
        instruction: (notes[variant.id] ?? '').trim(),
      },
    ];
  });
}

/** Presentation grouping only; source line identities/order and payload are unchanged. */
export function groupCartLines(lines: CartLine[]) {
  const groups = new Map<
    string,
    { menuItemId: string; name: string; lines: CartLine[] }
  >();
  for (const line of lines) {
    let group = groups.get(line.menuItemId);
    if (!group) {
      group = { menuItemId: line.menuItemId, name: line.itemName, lines: [] };
      groups.set(line.menuItemId, group);
    }
    group.lines.push(line);
  }
  return [...groups.values()];
}
