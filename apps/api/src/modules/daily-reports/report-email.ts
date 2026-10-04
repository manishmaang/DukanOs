import type { DailyReportSnapshot } from '@dukanos/shared-types';
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
export function renderReport(s: DailyReportSnapshot, version: number) {
  const date = new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(s.businessDate + 'T00:00:00Z'));
  const title = version > 1 ? 'REVISED DAILY REPORT' : 'DAILY REPORT';
  const subject = `DukanOS ${version > 1 ? 'Revised Daily Report' : 'Daily Report'} — ${date}${version > 1 ? ` — v${version}` : ''}`;
  const lines = [
    'DUKANOS',
    title,
    date,
    `Version ${version}`,
    '',
    `FOOD SOLD: ₹${s.foodSold}`,
    `CASH RETURNED: ₹${s.cashReturned}`,
    `RECORDED EXPENSES: ₹${s.recordedExpenses}`,
    '',
    'EXPENSE CATEGORIES',
    ...s.expenseCategories.map((c) => `${c.name}: ₹${c.amount}`),
    ...(s.expenseEntries.length
      ? [
          '',
          'EXPENSE DETAILS',
          ...s.expenseEntries.flatMap((e) => [
            `₹${e.amount} — ${e.categoryName} — ${e.paymentMethod}`,
            ...(e.vendor ? [e.vendor] : []),
            ...(e.note ? [e.note] : []),
            '',
          ]),
        ]
      : ['No expenses recorded.']),
    '',
    'BEST SELLING ITEM',
    ...(s.bestSeller
      ? [
          `${s.bestSeller.name} — ${s.bestSeller.quantity} sold`,
          ...s.bestSeller.variants.map((v) => `${v.name}: ${v.quantity}`),
        ]
      : ['No food sales recorded.']),
    '',
    'Stored report snapshot. Recorded Expenses may not include every business cost.',
  ];
  const text = lines.join('\n');
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;background:#f3f6f2;font-family:Arial,sans-serif;color:#183d31"><div style="max-width:600px;margin:auto;padding:24px;background:white;overflow-wrap:anywhere">${lines.map((l, i) => (i < 4 ? `<h${i === 1 ? '1' : '2'} style="font-size:${i === 1 ? '24' : '18'}px">${escape(l)}</h${i === 1 ? '1' : '2'}>` : `<p style="line-height:1.6;margin:8px 0;white-space:pre-wrap">${escape(l) || '&nbsp;'}</p>`)).join('')}</div></body></html>`;
  return { subject, text, html };
}
