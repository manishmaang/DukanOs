import type { ReportPeriod } from './reports';
export type ExpenseMethod = 'CASH' | 'UPI';
export type ExpenseVoidReason =
  | 'DUPLICATE_ENTRY'
  | 'WRONG_AMOUNT'
  | 'WRONG_CATEGORY'
  | 'NOT_A_BUSINESS_EXPENSE'
  | 'OTHER';
export interface ExpenseCategory {
  id: string;
  name: string;
  active: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface ExpenseReceipt {
  key: string;
  url: string;
  width: number;
  height: number;
}
export interface CreateExpense {
  requestId: string;
  amount: string;
  categoryId: string;
  paymentMethod: ExpenseMethod;
  businessDate?: string;
  vendor?: string;
  note?: string;
  receiptKey?: string;
}
export interface VoidExpense {
  requestId: string;
  reason: ExpenseVoidReason;
  note?: string;
}
export interface Expense {
  id: string;
  businessDate: string;
  amount: string;
  categoryId: string;
  categoryName: string;
  paymentMethod: ExpenseMethod;
  vendor: string;
  note: string;
  receipt: ExpenseReceipt | null;
  recordedBy: { id: string; name: string };
  createdAt: string;
  status: 'ACTIVE' | 'VOIDED';
  void: {
    by: { id: string; name: string };
    at: string;
    reason: ExpenseVoidReason;
    note: string;
  } | null;
}
export interface ExpenseTotals {
  total: string;
  cash: string;
  upi: string;
  count: number;
  categories: {
    categoryId: string;
    name: string;
    amount: string;
    count: number;
  }[];
}
export interface ExpensesReport extends ExpenseTotals {
  period: ReportPeriod;
  trend: { businessDate: string; amount: string }[];
}
export interface ExpenseList {
  period: ReportPeriod;
  expenses: Expense[];
  totals: ExpenseTotals;
  page: number;
  hasMore: boolean;
}
export interface ExpenseConfiguration {
  currentBusinessDate: string;
  earliestBusinessDate: string;
  timezone: string;
  categories: ExpenseCategory[];
}
