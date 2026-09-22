const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  dispatchConfiguration,
} = require('../dist/modules/dispatch/dispatch-config');
test('Dispatch READY late configuration is independent, bounded and defaults to five minutes', () => {
  assert.equal(dispatchConfiguration({}).lateThresholdMinutes, 5);
  assert.equal(
    dispatchConfiguration({ KITCHEN_LATE_THRESHOLD_MINUTES: '60' })
      .lateThresholdMinutes,
    5,
  );
  for (const value of ['1', '1440'])
    assert.equal(
      dispatchConfiguration({ DISPATCH_LATE_THRESHOLD_MINUTES: value })
        .lateThresholdMinutes,
      Number(value),
    );
  for (const value of ['0', '-1', '1.5', '1441', '5min', ''])
    assert.throws(() =>
      dispatchConfiguration({ DISPATCH_LATE_THRESHOLD_MINUTES: value }),
    );
});
