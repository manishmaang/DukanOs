/** Handover projection: sale names and limited bill settlement context only. */
export interface DispatchLine {
  id: string;
  menuItemId: string;
  itemName: string;
  variantName: string;
  quantity: number;
  instruction: string;
}
export interface DispatchOrder {
  billId: string;
  serviceType: 'DINE_IN' | 'TAKEAWAY' | null;
  amountDue: string;
  paymentStatus: import('./bills').PaymentStatus;
  orderId: string;
  businessDate: string;
  tokenNumber: number;
  source: string;
  readyAt: string;
  items: DispatchLine[];
}
export interface DispatchState {
  serverTime: string;
  businessDate: string;
  lateThresholdMinutes: number;
  orders: DispatchOrder[];
}
