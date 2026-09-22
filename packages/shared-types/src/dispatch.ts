/** Handover projection: immutable sale names, no financial fields. */
export interface DispatchLine {
  id: string;
  menuItemId: string;
  itemName: string;
  variantName: string;
  quantity: number;
  instruction: string;
}
export interface DispatchOrder {
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
