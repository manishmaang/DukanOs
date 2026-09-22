const { test } = require('node:test');
const assert = require('node:assert/strict');
test('instruction display groups exact whitespace-normalized notes without changing sources', async () => {
  const { instructionBreakdown } =
    await import('../src/kitchen-presentation.ts');
  const sources = [
    { quantity: 2, instruction: '' },
    { quantity: 1, instruction: 'Extra spicy' },
    { quantity: 2, instruction: ' Extra   spicy\n' },
    { quantity: 1, instruction: 'No onion' },
  ];
  const copy = JSON.parse(JSON.stringify(sources));
  assert.deepEqual(instructionBreakdown(sources), [
    { instruction: '', quantity: 2 },
    { instruction: 'Extra spicy', quantity: 3 },
    { instruction: 'No onion', quantity: 1 },
  ]);
  assert.deepEqual(sources, copy);
  assert.deepEqual(
    instructionBreakdown([{ quantity: 6, instruction: '  ' }]),
    [],
  );
  assert.deepEqual(instructionBreakdown([]), []);
  assert.equal(
    instructionBreakdown([
      { quantity: 1, instruction: 'Extra spicy' },
      { quantity: 1, instruction: 'Extra spicy, no onion' },
      { quantity: 1, instruction: 'extra spicy' },
    ]).length,
    3,
  );
});
test('late boundary is inclusive and based on queued age for queued and preparing orders', async () => {
  const { isLate } = await import('../src/kitchen-presentation.ts');
  const queuedAt = '2026-09-22T10:00:00Z',
    start = Date.parse(queuedAt);
  for (const status of ['QUEUED', 'PREPARING']) {
    const order = { status, queuedAt, preparingAt: '2026-09-22T10:10:00Z' };
    assert.equal(isLate(order.queuedAt, start + 899999, 15), false);
    assert.equal(isLate(order.queuedAt, start + 900000, 15), true);
    assert.equal(isLate(order.queuedAt, start + 960000, 15), true);
  }
  assert.equal(isLate(queuedAt, start + 900000, 20), false);
  assert.equal(isLate(queuedAt, start - 1000, 15), false);
});
