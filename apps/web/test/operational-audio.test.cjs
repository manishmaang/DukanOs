const { test } = require('node:test');
const assert = require('node:assert/strict');
async function fixture() {
  const { OperationalAudio, AUDIO_POLICY } =
    await import('../src/operational-audio.ts');
  let playing = false,
    ready = false;
  const events = [];
  const driver = {
    ready: () => ready,
    playing: () => playing,
    play: (k) => {
      assert.equal(playing, false);
      events.push(k);
      playing = true;
    },
    stop: () => {
      playing = false;
    },
  };
  const engine = new OperationalAudio(driver);
  engine.setScope(['PAYMENT_REMINDER', 'KITCHEN_TIMER']);
  return {
    engine,
    events,
    policy: AUDIO_POLICY,
    unlock: () => {
      ready = true;
      engine.setEnabled(true);
    },
    finish: () => {
      playing = false;
    },
    lock: () => {
      ready = false;
    },
  };
}
const alert = (id, due = 1000) => ({ id, dueAt: new Date(due).toISOString() });
test('locked/muted audio never plays; unlocking discovers overdue alerts without witnessing initial due', async () => {
  const f = await fixture();
  f.engine.update('PAYMENT_REMINDER', [alert('a')], 2000);
  f.engine.tick(0);
  assert.deepEqual(f.events, []);
  f.unlock();
  f.engine.tick(0);
  assert.deepEqual(f.events, ['PAYMENT_REMINDER']);
  f.engine.setEnabled(false);
  f.engine.tick(100000);
  assert.equal(f.events.length, 1);
  f.unlock();
  f.engine.tick(100000);
  assert.equal(f.events.length, 2);
});
test('payment future/due, poll deduplication, 60s cadence, snooze and settlement', async () => {
  const f = await fixture();
  f.unlock();
  f.engine.update('PAYMENT_REMINDER', [alert('a'), alert('b')], 0);
  f.engine.tick(0);
  assert.equal(f.events.length, 0);
  f.engine.update('PAYMENT_REMINDER', [alert('a'), alert('b')], 1000);
  f.engine.tick(1000);
  f.finish();
  for (let t = 2000; t < 61000; t += 2000) {
    f.engine.update('PAYMENT_REMINDER', [alert('a'), alert('b')], t);
    f.engine.tick(t);
  }
  assert.equal(f.events.length, 1);
  f.engine.tick(61000);
  assert.equal(f.events.length, 2);
  f.engine.silence('PAYMENT_REMINDER', 'a');
  f.engine.silence('PAYMENT_REMINDER', 'b');
  f.engine.tick(121000);
  assert.equal(f.events.length, 2);
  f.engine.update('PAYMENT_REMINDER', [alert('a', 180000)], 121000);
  f.engine.tick(121000);
  assert.equal(f.events.length, 2);
  f.engine.update('PAYMENT_REMINDER', [alert('a', 180000)], 180000);
  f.engine.tick(180000);
  assert.equal(f.events.length, 3);
  f.engine.update('PAYMENT_REMINDER', [], 180001);
  f.engine.tick(1000000);
  assert.equal(f.events.length, 3);
});
test('multiple Kitchen timers coalesce, repeat at 20s, acknowledge/cancel and action failure', async () => {
  const f = await fixture();
  f.unlock();
  f.engine.update(
    'KITCHEN_TIMER',
    [alert('a'), alert('b'), alert('c', 5000)],
    0,
  );
  f.engine.tick(0);
  assert.equal(f.events.length, 0);
  f.engine.update(
    'KITCHEN_TIMER',
    [alert('a'), alert('b'), alert('c', 5000)],
    1000,
  );
  f.engine.tick(1000);
  assert.equal(f.events.length, 1);
  f.engine.update(
    'KITCHEN_TIMER',
    [alert('a'), alert('b'), alert('c', 5000)],
    6000,
  );
  f.engine.tick(6000);
  assert.equal(f.events.length, 1);
  f.finish();
  f.engine.tick(20000);
  assert.equal(f.events.length, 1);
  f.engine.tick(21000);
  assert.equal(f.events.length, 2);
  const restore = f.engine.silence('KITCHEN_TIMER', 'a');
  f.engine.silence('KITCHEN_TIMER', 'b');
  f.engine.silence('KITCHEN_TIMER', 'c');
  f.engine.tick(41000);
  assert.equal(f.events.length, 2);
  restore();
  f.engine.tick(41000);
  assert.equal(f.events.length, 3);
  f.engine.update('KITCHEN_TIMER', [], 42000);
  f.engine.tick(100000);
  assert.equal(f.events.length, 3);
});
test('Kitchen priority serializes sound types and test sound does not acknowledge or trigger poll spam', async () => {
  const f = await fixture();
  f.unlock();
  for (const k of ['PAYMENT_REMINDER', 'KITCHEN_TIMER'])
    f.engine.update(k, [alert('a')], 1000);
  f.engine.tick(1000);
  assert.deepEqual(f.events, ['KITCHEN_TIMER']);
  f.engine.tick(1500);
  assert.equal(f.events.length, 1);
  f.finish();
  f.engine.tick(2000);
  assert.deepEqual(f.events, ['KITCHEN_TIMER', 'PAYMENT_REMINDER']);
  f.finish();
  assert.equal(f.engine.test('PAYMENT_REMINDER', 3000), true);
  f.finish();
  f.engine.tick(4000);
  assert.equal(f.events.length, 3);
  f.engine.tick(63000);
  assert.equal(f.events.at(-1), 'KITCHEN_TIMER');
});
test('workspace/permission scope, remount deduplication, logout and failed playback availability', async () => {
  const f = await fixture();
  f.unlock();
  f.engine.setScope(['PAYMENT_REMINDER']);
  f.engine.update('KITCHEN_TIMER', [alert('a')], 1000);
  f.engine.tick(1000);
  assert.equal(f.events.length, 0);
  f.engine.update('PAYMENT_REMINDER', [alert('b')], 1000);
  f.engine.tick(1000);
  f.engine.detach('PAYMENT_REMINDER');
  f.engine.update('PAYMENT_REMINDER', [alert('b')], 2000);
  f.engine.tick(2000);
  assert.equal(f.events.length, 1);
  f.engine.setScope(['KITCHEN_TIMER']);
  f.engine.update('KITCHEN_TIMER', [alert('a')], 2000);
  f.lock();
  f.engine.tick(2000);
  assert.equal(f.events.length, 1);
  f.unlock();
  f.engine.tick(2000);
  assert.equal(f.events.length, 2);
  f.engine.stop();
  f.engine.tick(200000);
  assert.equal(f.events.length, 2);
});
test('cached deadlines continue without responses; authoritative reconciliation cancels future sound', async () => {
  const f = await fixture();
  f.unlock();
  const known = [alert('a', 5000)];
  for (const k of ['KITCHEN_TIMER', 'PAYMENT_REMINDER']) {
    f.engine.update(k, known, 4000);
    f.engine.tick(4000);
    assert.equal(f.events.includes(k), false);
    f.engine.update(k, known, 6000);
    f.engine.tick(6000);
    assert.equal(f.events.at(-1), k);
    f.finish();
    f.engine.update(k, [], 6001);
    f.engine.tick(200000);
    assert.equal(f.events.filter((e) => e === k).length, 1);
  }
});
test('cancelling before the deadline also suppresses audio during an in-flight request', async () => {
  const f = await fixture();
  f.unlock();
  f.engine.update('KITCHEN_TIMER', [alert('a', 5000)], 1000);
  const restore = f.engine.silence('KITCHEN_TIMER', 'a');
  f.engine.update('KITCHEN_TIMER', [alert('a', 5000)], 6000);
  f.engine.tick(6000);
  assert.equal(f.events.length, 0);
  restore();
  f.engine.tick(6000);
  assert.equal(f.events.length, 1);
});
