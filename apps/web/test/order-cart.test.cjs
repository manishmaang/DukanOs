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

test('multi-portion selection applies shared/overridden notes, excludes zero and sold-out portions, and totals exactly', async () => {
  const { selectionLines, addLines, cartPaise, cartAmount } =
    await import('../src/order-cart.ts');
  const dish = {
    id: 'dish',
    name: 'Soya Chaap Gravy',
    variants: [
      {
        id: 'half',
        name: 'Half',
        displayLabel: 'SCG-F',
        price: '200.00',
        available: true,
      },
      {
        id: 'full',
        name: 'Full',
        displayLabel: 'SCG-H',
        price: '250.00',
        available: true,
      },
      { id: 'regular', name: 'Regular', price: '80.50', available: true },
      { id: 'zero', name: 'Large', price: '400', available: true },
      { id: 'sold', name: 'Unavailable', price: '500', available: false },
    ],
  };
  const selected = selectionLines(
    dish,
    { half: 1, full: 1, regular: 2, zero: 0, sold: 2 },
    ' Extra spicy ',
    { regular: 'No onion' },
  );
  assert.deepEqual(
    selected.map((l) => [l.variantName, l.quantity, l.instruction]),
    [
      ['Half', 1, 'Extra spicy'],
      ['Full', 1, 'Extra spicy'],
      ['Regular', 2, 'No onion'],
    ],
  );
  assert.equal(
    cartAmount(
      selected.reduce(
        (n, l) => n + cartPaise(l.price) * BigInt(l.quantity),
        0n,
      ),
    ),
    '611.00',
  );
  const existing = { ...selected[1], instruction: 'No vegetables' };
  const cart = addLines([existing], selected);
  assert.equal(cart.length, 4);
  assert.equal(cart[0], existing);
  assert.equal(
    addLines(cart, selectionLines(dish, { full: 1 }, 'Extra spicy', {})).find(
      (l) => l.variantId === 'full' && l.instruction === 'Extra spicy',
    ).quantity,
    2,
  );
  assert.equal(
    selectionLines(dish, { full: 1 }, 'Shared', { full: '' })[0].instruction,
    '',
  );
  assert.deepEqual(selectionLines(dish, {}, '', {}), []);
});
test('multi-add is all-or-nothing when a later merge exceeds the line limit', async () => {
  const { addLines } = await import('../src/order-cart.ts');
  const line = {
    variantId: 'full',
    itemName: 'Chaap',
    variantName: 'Full',
    price: '250',
    quantity: 99,
    instruction: '',
  };
  const original = [line];
  assert.throws(() =>
    addLines(original, [
      { ...line, variantId: 'half', quantity: 1 },
      { ...line, quantity: 1 },
    ]),
  );
  assert.deepEqual(original, [line]);
  assert.equal(original[0].quantity, 99);
});
