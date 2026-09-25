import type { OrderStatus } from './orders';
export type ServiceType = 'DINE_IN' | 'TAKEAWAY';
export type PaymentStatus = 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' | 'REFUND_DUE';
export interface BillSummary {
  id: string;
  businessDate: string;
  billNumber: number;
  serviceType: ServiceType | null;
  legacy: boolean;
  reference: string;
  status: 'OPEN' | 'CLOSED';
  openedAt: string;
  closedAt: string | null;
  billTotal: string;
  totalCollected: string;
  totalRefunded: string;
  netPaid: string;
  amountDue: string;
  refundDue: string;
  paymentStatus: PaymentStatus;
}
export interface BillDetail extends BillSummary {
  orders: {
    id: string;
    tokenNumber: number;
    businessDate: string;
    status: OrderStatus;
    grandTotal: string;
    items: {
      id: string;
      itemName: string;
      variantName: string;
      quantity: number;
      instruction: string;
    }[];
  }[];
  payments: {
    id: string;
    type: 'COLLECTION' | 'REFUND';
    method: 'CASH' | 'UPI';
    amount: string;
    performedBy: string;
    actorName: string;
    createdAt: string;
  }[];
}
export interface BillList {
  bills: BillSummary[];
  nextCursor: string | null;
}
export interface CollectPaymentInput {
  requestId: string;
  method: 'CASH' | 'UPI';
  amount: string;
}
