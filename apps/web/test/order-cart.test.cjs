const { test } = require('node:test');
const assert = require('node:assert/strict');
test('cart exact estimates and merging preserve customization boundaries', async () => {
  const { addLine, cartPaise, cartAmount, orderInput } =
    await import('../src/order-cart.ts');
  const line = {
    variantId: 'x',
    itemName: 'Noodles',
    variantName: 'Full',
    quantity: 1,
    price: '181.50',
    instruction: '',
  };
  const merged = addLine([line], line);
  assert.equal(merged[0].quantity, 2);
  assert.equal(
    addLine(merged, { ...line, instruction: 'Extra spicy' }).length,
    2,
  );
  assert.equal(
    addLine([{ ...line, instruction: 'Extra spicy' }], {
      ...line,
      instruction: ' Extra spicy ',
    })[0].quantity,
    2,
  );
  assert.throws(() => addLine([{ ...line, quantity: 99 }], line));
  assert.equal(cartAmount(cartPaise('181.5') * 2n), '363.00');
  assert.deepEqual(orderInput([line], 'key'), {
    requestId: 'key',
    lines: [{ variantId: 'x', quantity: 1, instruction: '' }],
  });
});

test('confirmation IDs support LAN HTTP without crypto.randomUUID', async () => {
  const { confirmationId } = await import('../src/order-cart.ts');
  const ids = Array.from({ length: 20 }, () => confirmationId());
  assert.equal(new Set(ids).size, 20);
  for (const id of ids)
    assert.match(
      id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
});
