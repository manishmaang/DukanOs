const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateRoles,
  ROLE_CODES,
} = require('../dist/modules/users/role-policy');
const {
  hashPassword,
  verifyPassword,
} = require('../dist/modules/auth/password');
test('all 32 subsets permit precisely two exclusive privileged and seven operational combinations', () => {
  let valid = 0;
  for (let mask = 0; mask < 32; mask++) {
    const roles = ROLE_CODES.filter((_, i) => mask & (1 << i));
    const expected =
      roles.length > 0 &&
      (!roles.some((r) => ['OWNER', 'MANAGER'].includes(r)) ||
        roles.length === 1);
    if (expected) {
      assert.doesNotThrow(() => validateRoles(roles));
      valid++;
    } else
      assert.throws(
        () => validateRoles(roles),
        (error) => error.getResponse().code === 'INVALID_ROLE_COMBINATION',
      );
  }
  assert.equal(valid, 9);
  for (const roles of [['CASHIER', 'CASHIER'], ['SUPERUSER'], ['cashier']])
    assert.throws(() => validateRoles(roles));
});
test('password hashes are salted and verify without accepting incorrect passwords', async () => {
  const first = await hashPassword('a strong test password');
  const second = await hashPassword('a strong test password');
  assert.notEqual(first, second);
  assert.equal(await verifyPassword('a strong test password', first), true);
  assert.equal(await verifyPassword('wrong password', first), false);
  assert.equal(
    await verifyPassword('a strong test password', 'invalid'),
    false,
  );
});
