import type { OrderConfiguration, OrderStatus } from '@dukanos/shared-types';
export function paise(value: string): bigint {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) throw new Error('Invalid exact amount');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
}
export function amount(value: bigint): string {
  return `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
}
export function totals(subtotal: bigint, rate: string) {
  // Rate has two fractional percentage digits; round once on order subtotal.
  const tax = (subtotal * paise(rate) + 5000n) / 10000n;
  return {
    subtotal: amount(subtotal),
    taxTotal: amount(tax),
    grandTotal: amount(subtotal + tax),
  };
}
export function orderConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): OrderConfiguration {
  const timezone = env.RESTAURANT_TIMEZONE ?? 'Asia/Kolkata';
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
  } catch {
    throw new Error('RESTAURANT_TIMEZONE must be a valid IANA timezone');
  }
  const taxRate = env.ORDER_TAX_RATE ?? '0';
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(taxRate) || paise(taxRate) > 10000n)
    throw new Error(
      'ORDER_TAX_RATE must be a decimal percentage from 0 to 100 with at most two fractional digits',
    );
  const taxLabel = (env.ORDER_TAX_LABEL ?? 'Tax').trim();
  if (!taxLabel || taxLabel.length > 80)
    throw new Error('ORDER_TAX_LABEL must have 1–80 characters');
  return {
    timezone,
    taxRate: amount(paise(taxRate)),
    taxLabel,
    taxMode: 'EXCLUSIVE',
    rounding: 'HALF_UP_PAISE',
  };
}
export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  const next: Record<OrderStatus, OrderStatus[]> = {
    DRAFT: ['QUEUED', 'CANCELLED'],
    QUEUED: ['PREPARING', 'CANCELLED'],
    PREPARING: ['READY'],
    READY: ['COMPLETED'],
    COMPLETED: [],
    CANCELLED: [],
  };
  return next[from].includes(to);
}
