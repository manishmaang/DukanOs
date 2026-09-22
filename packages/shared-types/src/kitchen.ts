/** Kitchen-only projections deliberately omit financial data. */
export interface KitchenLine {
  id: string;
  menuItemId: string;
  variantId: string;
  itemName: string;
  kitchenName: string;
  variantName: string;
  quantity: number;
  instruction: string;
}
export interface KitchenOrder {
  orderId: string;
  businessDate: string;
  tokenNumber: number;
  status: 'QUEUED' | 'PREPARING';
  queuedAt: string;
  preparingAt: string | null;
  items: KitchenLine[];
}
export interface ProductionSource {
  orderId: string;
  lineId: string;
  businessDate: string;
  tokenNumber: number;
  quantity: number;
  instruction: string;
  queuedAt: string;
}
export interface ProductionGroup {
  key: string;
  itemName: string;
  kitchenName: string;
  variantName: string;
  totalQuantity: number;
  earliestQueuedAt: string;
  sources: ProductionSource[];
}
export interface KitchenProduction {
  queued: ProductionGroup[];
  preparing: ProductionGroup[];
}
export interface KitchenState {
  serverTime: string;
  businessDate: string;
  lateThresholdMinutes: number;
  nextOrderId: string | null;
  queued: KitchenOrder[];
  preparing: KitchenOrder[];
  production: KitchenProduction;
}
export interface KitchenTransitionResult {
  orderId: string;
  status: 'PREPARING' | 'READY';
  occurredAt: string;
}
