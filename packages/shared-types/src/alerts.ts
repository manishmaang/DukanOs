export interface PaymentReminder {
  billId: string;
  billNumber: number;
  businessDate: string;
  reference: string;
  amountDue: string;
  intervalMinutes: number;
  nextDueAt: string;
  version: number;
}
export interface KitchenTimer {
  id: string;
  label: string;
  durationSeconds: number;
  startedAt: string;
  dueAt: string;
  orderId: string | null;
  orderItemId: string | null;
  tokenNumber: number | null;
  businessDate: string | null;
  itemName: string | null;
  variantName: string | null;
  status: 'ACTIVE' | 'ACKNOWLEDGED' | 'CANCELLED';
}
export interface AlertState<T> {
  serverTime: string;
  entries: T[];
}
export interface TimerInput {
  requestId: string;
  label: string;
  durationSeconds: number;
  orderId?: string;
  orderItemId?: string;
}
