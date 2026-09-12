const { test } = require('node:test');
const assert = require('node:assert/strict');
const { allowedWorkspaces } = require('../src/workspaces.ts');
test('multi-role workspaces follow capabilities, not role names', () => {
  const user = {
    id: 'x',
    name: 'Staff',
    roles: ['CASHIER', 'KITCHEN'],
    permissions: ['orders.create', 'kitchen.read'],
  };
  assert.deepEqual(
    allowedWorkspaces(user).map((x) => x.label),
    ['POS', 'Kitchen'],
  );
  user.permissions.push('dispatch.read');
  assert.deepEqual(
    allowedWorkspaces(user).map((x) => x.label),
    ['POS', 'Kitchen', 'Dispatch'],
  );
  user.roles = ['OWNER'];
  user.permissions = [];
  assert.deepEqual(allowedWorkspaces(user), []);
});
