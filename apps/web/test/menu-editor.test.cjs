const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  dishDraft,
  dishPayload,
  validateDish,
  matchingItems,
  rupees,
} = require('../src/menu-editor.ts');
const channels = [
  { code: 'COUNTER', name: 'Counter', active: true },
  { code: 'SWIGGY', name: 'Swiggy', active: true },
];
const catalog = {
  channels,
  categories: [{ id: 'category', name: 'Chinese', active: true }],
  items: [],
};
test('single-portion draft and exact price display avoid floating-point conversion', () => {
  const draft = dishDraft(channels, undefined, 'category');
  assert.equal(draft.variants[0].name, 'Standard');
  draft.name = 'Water';
  draft.variants[0].channels[0] = {
    channelCode: 'COUNTER',
    price: '999999999999.99',
    available: true,
  };
  assert.deepEqual(validateDish(draft, catalog), []);
  const body = dishPayload(draft);
  assert.equal(body.variants[0].channels[0].price, '999999999999.99');
  assert.equal(body.variants[0].channels.length, 1);
  assert.equal(body.variants[0].key, undefined);
  assert.equal(rupees('120.00'), '120');
  assert.equal(rupees('120.50'), '120.5');
  assert.equal(rupees('0.01'), '0.01');
});
test('draft validation gives dish/portion/channel-specific errors and preserves saved prices', () => {
  const item = {
    id: 'item',
    name: 'Noodles',
    categoryId: 'category',
    active: true,
    variants: [
      {
        id: 'variant',
        name: 'Full',
        active: true,
        channels: [
          { channelCode: 'COUNTER', price: '180.00', available: true },
        ],
      },
    ],
  };
  const draft = dishDraft(channels, item);
  assert.equal(draft.variants[0].id, 'variant');
  draft.variants[0].channels[0].price = '-1';
  assert.ok(
    validateDish(draft, catalog, item).some((e) =>
      e.includes('Counter price cannot be negative'),
    ),
  );
  draft.variants[0].channels[0].price = '';
  assert.ok(
    validateDish(draft, catalog, item).some((e) =>
      e.includes('keep a Counter price'),
    ),
  );
  draft.variants[0].channels[0].price = '180';
  draft.active = false;
  assert.deepEqual(validateDish(draft, catalog, item), []);
  draft.variants.push({ ...draft.variants[0], name: 'full' });
  assert.ok(
    validateDish(draft, catalog, item).some((e) => e.includes('unique')),
  );
  assert.equal(
    matchingItems({ ...catalog, items: [item] }, 'CHINESE').length,
    1,
  );
  assert.equal(matchingItems({ ...catalog, items: [item] }, 'full').length, 1);
  assert.equal(matchingItems({ ...catalog, items: [item] }, 'Nood').length, 1);
  assert.equal(
    matchingItems({ ...catalog, items: [item] }, 'missing').length,
    0,
  );
});
