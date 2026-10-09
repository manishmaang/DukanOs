import type { MenuImage } from './menu';
import type { OrderStatus } from './orders';
export type PlatformSource = 'ZOMATO' | 'SWIGGY';
export type OrderSource = 'COUNTER' | PlatformSource;
export type ServingMode = 'NORMAL' | 'REDUCED';
export interface ServingSnapshot {
  mode: ServingMode;
  amount: string;
  unit: 'g' | 'ml';
}
export interface PlatformMenu {
  source: PlatformSource;
  categories: {
    id: string;
    name: string;
    items: {
      id: string;
      name: string;
      image: MenuImage | null;
      variants: {
        id: string;
        name: string;
        available: boolean;
        normal: ServingSnapshot | null;
        reduced: ServingSnapshot | null;
      }[];
    }[];
  }[];
}
export interface PlatformOrderInput {
  requestId: string;
  source: PlatformSource;
  externalReference: string;
  discountClassification: 'NONE' | 'APPLIED' | 'UNKNOWN';
  lines: {
    variantId: string;
    quantity: number;
    instruction?: string;
    serving: ServingSnapshot;
  }[];
}
export interface PlatformOrder {
  id: string;
  source: PlatformSource;
  externalReference: string;
  discountClassification: PlatformOrderInput['discountClassification'];
  businessDate: string;
  tokenNumber: number;
  status: OrderStatus;
  queuedAt: string;
  confirmedBy: string;
  items: {
    id: string;
    menuItemId: string;
    variantId: string;
    itemName: string;
    variantName: string;
    quantity: number;
    instruction: string;
    serving: ServingSnapshot;
  }[];
  history: {
    fromStatus: OrderStatus;
    toStatus: OrderStatus;
    actorId: string | null;
    actorName: string;
    occurredAt: string;
    reason: string;
  }[];
}
export interface PlatformOrderList {
  orders: PlatformOrder[];
  nextCursor: string | null;
}
