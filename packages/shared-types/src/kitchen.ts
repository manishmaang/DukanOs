/** Kitchen-only projections deliberately omit financial data. */
export interface KitchenLine {
  servedQuantity?: number;
  pendingQuantity?: number;
  serving?: import('./platform-orders').ServingSnapshot | null;
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
  revision?: number;
  serviceType?: import('./bills').ServiceType | null;
  reference?: string | null;
  source?: import('./platform-orders').OrderSource;
  externalReference?: string | null;
  orderId: string;
  businessDate: string;
  tokenNumber: number;
  status: 'QUEUED' | 'PREPARING' | 'READY';
  queuedAt: string;
  preparingAt: string | null;
  items: KitchenLine[];
}
export interface ProductionSource {
  serviceType?: import('./bills').ServiceType | null;
  reference?: string | null;
  orderId: string;
  lineId: string;
  businessDate: string;
  tokenNumber: number;
  quantity: number;
  instruction: string;
  queuedAt: string;
}
export interface ProductionGroup {
  source?: import('./platform-orders').OrderSource;
  serving?: import('./platform-orders').ServingSnapshot | null;
  key: string;
  itemName: string;
  kitchenName: string;
  variantName: string;
  totalQuantity: number;
  earliestQueuedAt: string;
  sources: ProductionSource[];
}
export interface KitchenProduction {
  pending: ProductionGroup[];
  queued: ProductionGroup[];
  preparing: ProductionGroup[];
}
export interface KitchenState {
  pending: KitchenOrder[];
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
