const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  canResetPassword,
  validateNewPassword,
} = require('../dist/modules/users/password-policy');
test('password resets require capability and enforce exclusive privileged actor/target rules', () => {
  const combinations = [
    ['OWNER'],
    ['MANAGER'],
    ['CASHIER'],
    ['KITCHEN'],
    ['DISPATCH'],
    ['CASHIER', 'KITCHEN'],
    ['CASHIER', 'DISPATCH'],
    ['KITCHEN', 'DISPATCH'],
    ['CASHIER', 'KITCHEN', 'DISPATCH'],
  ];
  for (const roles of combinations)
    for (const targetRoles of combinations) {
      const actor = {
        id: 'actor',
        roles,
        permissions: ['users.password.reset'],
      };
      const target = { id: 'target', roles: targetRoles };
      const allowed =
        roles.length === 1 &&
        ((roles[0] === 'OWNER' && !targetRoles.includes('OWNER')) ||
          (roles[0] === 'MANAGER' &&
            !targetRoles.some((r) => ['OWNER', 'MANAGER'].includes(r))));
      assert.equal(canResetPassword(actor, target), allowed);
      assert.equal(
        canResetPassword({ ...actor, permissions: [] }, target),
        false,
      );
      assert.equal(canResetPassword(actor, { ...target, id: actor.id }), false);
    }
});
test('password management shares the existing 12–128 character strength bounds', () => {
  for (const value of [undefined, null, 123, 'short', 'x'.repeat(129)])
    assert.throws(
      () => validateNewPassword(value),
      (e) => e.getResponse().code === 'INVALID_PASSWORD',
    );
  for (const value of ['x'.repeat(12), 'x'.repeat(128)])
    assert.doesNotThrow(() => validateNewPassword(value));
});
