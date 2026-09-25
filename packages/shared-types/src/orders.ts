export type OrderStatus =
  'DRAFT' | 'QUEUED' | 'PREPARING' | 'READY' | 'COMPLETED' | 'CANCELLED';
export interface CounterOrderInput {
  payment?: ConfirmationPayment;
  requestId: string;
  billId?: string;
  serviceType?: 'DINE_IN' | 'TAKEAWAY';
  reference?: string;
  lines: { variantId: string; quantity: number; instruction?: string }[];
}
export interface OrderConfiguration {
  timezone: string;
  taxLabel: string;
  taxRate: string;
  taxMode: 'EXCLUSIVE';
  rounding: 'HALF_UP_PAISE';
}
export interface ConfirmedOrder {
  billId: string;
  id: string;
  source: 'COUNTER';
  status: OrderStatus;
  businessDate: string;
  tokenNumber: number;
  queuedAt: string;
  confirmedBy: string;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  roundingAdjustment: string;
  grandTotal: string;
  tax: OrderConfiguration;
  items: {
    id: string;
    menuItemId: string;
    variantId: string;
    itemName: string;
    kitchenName: string;
    variantName: string;
    quantity: number;
    unitPrice: string;
    lineSubtotal: string;
    instruction: string;
  }[];
}
export interface OrderList {
  orders: ConfirmedOrder[];
  nextCursor: string | null;
}

export interface OrderTransitionResult {
  orderId: string;
  status: 'PREPARING' | 'READY' | 'COMPLETED';
  occurredAt: string;
}

export interface ConfirmationPayment {
  expectedDue: string;
  cash: string;
  upi: string;
}
export interface OrderQuote {
  roundTotal: string;
  existingDue: string;
  amountDue: string;
}
