const { test } = require('node:test');
const assert = require('node:assert/strict');
const { aggregateProduction } = require('../dist/modules/kitchen/production');
test('production preserves source lines and snapshot identity, quantity and earliest urgency', () => {
  const line = {
    id: 'l1',
    menuItemId: 'm1',
    variantId: 'v1',
    itemName: 'Noodles',
    kitchenName: 'Noodles',
    variantName: 'Full',
    quantity: 2,
    instruction: '',
  };
  const order = {
    orderId: 'o1',
    businessDate: '2026-09-22',
    tokenNumber: 1,
    status: 'QUEUED',
    queuedAt: '2026-09-22T10:00:00Z',
    preparingAt: null,
    items: [line],
  };
  const result = aggregateProduction([
    order,
    {
      ...order,
      orderId: 'o2',
      tokenNumber: 2,
      queuedAt: '2026-09-22T10:01:00Z',
      items: [
        { ...line, id: 'l2', quantity: 1, instruction: 'Extra spicy' },
        { ...line, id: 'l3', quantity: 1, instruction: 'No vegetables' },
      ],
    },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].totalQuantity, 4);
  assert.equal(result[0].earliestQueuedAt, order.queuedAt);
  assert.deepEqual(
    result[0].sources.map((s) => [s.lineId, s.quantity, s.instruction]),
    [
      ['l1', 2, ''],
      ['l2', 1, 'Extra spicy'],
      ['l3', 1, 'No vegetables'],
    ],
  );
  const distinct = aggregateProduction([
    order,
    {
      ...order,
      items: [
        { ...line, id: 'l2', itemName: 'Renamed' },
        { ...line, id: 'l3', menuItemId: 'other' },
        { ...line, id: 'l4', variantName: 'Half' },
      ],
    },
  ]);
  assert.equal(distinct.length, 4);
  assert.equal(distinct[0].itemName, 'Noodles');
  assert.deepEqual(aggregateProduction([]), []);
});
