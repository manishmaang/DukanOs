const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  paise,
  amount,
  totals,
  canTransition,
  orderConfiguration,
} = require('../dist/modules/orders/order-policy');
test('exact paise totals, fractional tax half-up and configurable defaults', () => {
  assert.equal(paise('181.5'), 18150n);
  assert.equal(amount(paise('999999999999.99') * 99n), '98999999999999.01');
  assert.deepEqual(totals(18150n, '0.00'), {
    subtotal: '181.50',
    taxTotal: '0.00',
    grandTotal: '181.50',
  });
  assert.deepEqual(totals(10n, '5.00'), {
    subtotal: '0.10',
    taxTotal: '0.01',
    grandTotal: '0.11',
  });
  assert.equal(orderConfiguration({}).taxRate, '0.00');
  for (const rate of ['-1', '100.01', '1.001', 'NaN', '5e0'])
    assert.throws(() => orderConfiguration({ ORDER_TAX_RATE: rate }));
  assert.throws(() =>
    orderConfiguration({ RESTAURANT_TIMEZONE: 'Invalid/Zone' }),
  );
});
test('explicit lifecycle only allows intended transitions', () => {
  const statuses = [
    'DRAFT',
    'QUEUED',
    'PREPARING',
    'READY',
    'COMPLETED',
    'CANCELLED',
  ];
  const valid = [
    'DRAFT:QUEUED',
    'DRAFT:CANCELLED',
    'QUEUED:PREPARING',
    'QUEUED:CANCELLED',
    'PREPARING:READY',
    'READY:COMPLETED',
  ];
  for (const from of statuses)
    for (const to of statuses)
      assert.equal(canTransition(from, to), valid.includes(`${from}:${to}`));
});
