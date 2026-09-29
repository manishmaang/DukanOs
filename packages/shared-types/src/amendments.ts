import type { ConfirmedOrder } from './orders';
export type AmendmentReason =
  | 'CUSTOMER_CHANGE'
  | 'WRONG_ITEM_SELECTED'
  | 'WRONG_PORTION'
  | 'ITEM_UNAVAILABLE'
  | 'CASHIER_CORRECTION'
  | 'OTHER';
export interface AmendmentInput {
  requestId: string;
  expectedRevision: number;
  kind: 'CHANGE' | 'CANCEL';
  reason: AmendmentReason;
  note?: string;
  // Complete desired projection, using existing logical line IDs. No new lines/increases.
  lines: {
    id: string;
    variantId: string;
    quantity: number;
    instruction: string;
  }[];
}
export interface AmendmentQuote {
  orderId: string;
  revision: number;
  beforeItems: ConfirmedOrder['items'];
  items: ConfirmedOrder['items'];
  oldRoundTotal: string;
  newRoundTotal: string;
  subtotal: string;
  taxTotal: string;
  billTotalBefore: string;
  billTotalAfter: string;
  netPaid: string;
  amountDueAfter: string;
  refundDueAfter: string;
  quoteHash: string;
}
export interface CommitAmendmentInput extends AmendmentInput {
  quoteHash: string;
}
export interface AmendmentHistory {
  id: string;
  revision: number;
  kind: 'CHANGE' | 'CANCEL';
  reason: AmendmentReason;
  note: string;
  performedBy: string;
  actorName: string;
  createdAt: string;
  beforeTotal: string;
  grandTotal: string;
  beforeItems: ConfirmedOrder['items'];
  items: ConfirmedOrder['items'];
}
export interface RefundInput {
  requestId: string;
  amount: string;
}
