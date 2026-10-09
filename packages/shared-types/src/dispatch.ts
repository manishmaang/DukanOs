/** Handover projection: sale names and limited bill settlement context only. */
export interface DispatchLine {
  serving?: import('./platform-orders').ServingSnapshot | null;
  id: string;
  menuItemId: string;
  itemName: string;
  variantName: string;
  quantity: number;
  instruction: string;
}
export interface DispatchOrder {
  billId: string | null;
  serviceType: 'DINE_IN' | 'TAKEAWAY' | null;
  amountDue: string | null;
  refundDue: string | null;
  paymentStatus: import('./bills').PaymentStatus | null;
  orderId: string;
  businessDate: string;
  tokenNumber: number;
  source: string;
  externalReference: string | null;
  readyAt: string;
  items: DispatchLine[];
}
export interface DispatchState {
  serverTime: string;
  businessDate: string;
  lateThresholdMinutes: number;
  orders: DispatchOrder[];
}
