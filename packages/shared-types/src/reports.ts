export type ReportPreset =
  'TODAY' | 'YESTERDAY' | 'LAST_7_DAYS' | 'THIS_MONTH' | 'CUSTOM';
export interface ReportPeriod {
  preset: ReportPreset;
  from: string;
  to: string;
  currentBusinessDate: string;
  timezone: string;
  asOf: string;
}
export interface SalesSummary {
  salesValue: string;
  foodSubtotal: string;
  taxValue: string;
  billCount: number;
  averageBill: string;
  openBills: number;
  closedBills: number;
  legacyBills: number;
  outstandingDue: string;
  billsWithDue: number;
  refundDue: string;
  legacyDue: string;
}
export interface ReportServiceType {
  serviceType: 'DINE_IN' | 'TAKEAWAY' | 'UNKNOWN';
  billCount: number;
  salesValue: string;
}
export interface SalesTrend {
  granularity: 'HOUR' | 'DAY';
  buckets: { key: string; salesValue: string }[];
  outsidePeriodSales: string;
}
export interface SalesReport {
  period: ReportPeriod;
  summary: SalesSummary;
  serviceTypes: ReportServiceType[];
  trend: SalesTrend;
}
export interface PaymentsReport {
  period: ReportPeriod;
  cashCollections: string;
  upiCollections: string;
  totalCollections: string;
  cashRefunds: string;
  netCollected: string;
  cashTransactions: number;
  upiTransactions: number;
  refundTransactions: number;
  outstandingDue: string;
  refundDue: string;
  legacyDue: string;
}
export interface ReportItem {
  menuItemId: string;
  variantId: string;
  itemName: string;
  variantName: string;
  quantity: string;
  salesValue: string;
}
export interface ItemsReport {
  period: ReportPeriod;
  items: ReportItem[];
  sort: 'QUANTITY' | 'SALES';
  page: number;
  pageSize: number;
  totalItems: number;
  totalQuantity: string;
  totalSalesValue: string;
}
export interface OperationsReport {
  period: ReportPeriod;
  billCount: number;
  kitchenRounds: number;
  serviceTypes: {
    serviceType: ReportServiceType['serviceType'];
    billCount: number;
  }[];
  statuses: { status: string; count: number }[];
  amendments: number;
  amendmentReasons: { reason: string; count: number }[];
  averageQueuedToReadySeconds: number | null;
  readySampleCount: number;
}
export interface DashboardExplanation {
  collectionsForSelectedBills: string;
  collectionsForEarlierBills: string;
  collectionsForLaterBills: string;
  refundsForOtherBills: string;
  selectedBillCollectionsOutsidePeriod: string;
  selectedBillRefundsOutsidePeriod: string;
}
export interface DashboardReport {
  recordedExpenses: string;
  explanation: DashboardExplanation;
  period: ReportPeriod;
  sales: SalesReport;
  payments: PaymentsReport;
  topItems: ReportItem[];
  operations: OperationsReport;
}
