export interface DailyReportSnapshot {
  schemaVersion: 1;
  businessDate: string;
  timezone: string;
  foodSold: string;
  cashReturned: string;
  recordedExpenses: string;
  expenseCategories: {
    categoryId: string;
    name: string;
    amount: string;
    count: number;
  }[];
  expenseEntries: {
    id: string;
    amount: string;
    categoryName: string;
    paymentMethod: 'CASH' | 'UPI';
    vendor: string;
    note: string;
  }[];
  bestSeller: null | {
    menuItemId: string;
    name: string;
    quantity: string;
    salesValue: string;
    variants: {
      variantId: string;
      name: string;
      quantity: string;
      salesValue: string;
    }[];
  };
}
export interface ReportDelivery {
  id: string;
  reportId: string | null;
  recipient: string;
  kind: 'AUTOMATIC' | 'MANUAL' | 'TEST';
  status: 'PENDING' | 'SENDING' | 'RETRY_PENDING' | 'SENT' | 'FAILED';
  attemptCount: number;
  nextAttemptAt: string;
  sentAt: string | null;
  lastErrorCode: string | null;
  createdAt: string;
}
export interface DailyReport {
  id: string;
  businessDate: string;
  version: number;
  generatedAt: string;
  generatedBy: { id: string; name: string } | null;
  source: 'AUTOMATIC' | 'MANUAL';
  reason: string;
  snapshot: DailyReportSnapshot;
  deliveries: ReportDelivery[];
}
export interface DailyReportSettings {
  enabled: boolean;
  recipients: string[];
  version: number;
  startDate: string | null;
  nextDate: string | null;
  smtpStatus: 'CONFIGURED' | 'NOT_CONFIGURED';
  delayMinutes: number;
  currentBusinessDate: string;
}

export type DailyReportSummary = Omit<DailyReport, 'snapshot'>;
