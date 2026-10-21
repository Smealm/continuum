const { test } = require('node:test');
const assert = require('node:assert/strict');

const { ConcurrencyController, WorkGate } = require('../dist/core/concurrency.js');

function makeController(options = {}) {
  let now = 0;
  const controller = new ConcurrencyController({ min: 1, max: 8, start: 2, ...options }, () => now);
  return {
    controller,
    advance: (ms) => { now += ms; },
  };
}

test('climbs while more connections deliver more data, then stops at the ceiling', () => {
  const { controller } = makeController();

  assert.equal(controller.limit, 2);
  const first = controller.sample({ bytes: 1000, failures: 0, elapsedMs: 1000 });
  assert.equal(first.changed, false, 'the first sample only learns the baseline');

  let previous = 1000;
  const seen = [];
  for (let step = 0; step < 10; step += 1) {
    previous = Math.round(previous * 1.2);
    const decision = controller.sample({ bytes: previous, failures: 0, elapsedMs: 1000 });
    seen.push(decision.limit);
  }

  assert.deepEqual(seen.slice(0, 6), [3, 4, 5, 6, 7, 8]);
  assert.equal(controller.limit, 8, 'never above the configured ceiling');
  assert.equal(seen[seen.length - 1], 8);
});

test('backs off to the width that produced the peak when an extra connection lowers goodput', () => {
  const { controller } = makeController({ start: 3 });

  controller.sample({ bytes: 3000, failures: 0, elapsedMs: 1000 });
  const raised = controller.sample({ bytes: 3600, failures: 0, elapsedMs: 1000 });
  assert.equal(raised.limit, 4, 'a better rate earns one more worker');

  const worse = controller.sample({ bytes: 3000, failures: 0, elapsedMs: 1000 });
  assert.equal(worse.changed, true);
  assert.equal(worse.limit, 3);
  assert.match(worse.reason, /fell/);
});

test('a rate near the measured peak holds instead of thrashing', () => {
  const { controller } = makeController({ start: 4 });

  controller.sample({ bytes: 4000, failures: 0, elapsedMs: 1000 });
  const steady = controller.sample({ bytes: 3900, failures: 0, elapsedMs: 1000 });

  assert.equal(steady.changed, false);
  assert.equal(steady.limit, 4);
  assert.match(steady.reason, /peak/);
});

test('climbs towards a peak measured by a probe, doubling while far below it', () => {
  const { controller } = makeController({ start: 2, max: 20 });

  controller.observePeak(8_000_000);

  const first = controller.sample({ bytes: 1_000_000, failures: 0, elapsedMs: 1000 });
  assert.equal(first.changed, true);
  assert.equal(first.limit, 4, '2 MB/s against an 8 MB/s peak doubles the width');
  assert.match(first.reason, /peak/);

  const second = controller.sample({ bytes: 3_500_000, failures: 0, elapsedMs: 1000 });
  assert.equal(second.limit, 8);

  const pressed = controller.sample({ bytes: 7_500_000, failures: 0, elapsedMs: 1000 });
  assert.equal(pressed.changed, false, 'within 10% of the peak the link is considered pressed');
  assert.equal(pressed.limit, 8);
  assert.match(pressed.reason, /peak/);
});

test('stays at the ceiling through a wall of small files below the probe peak', () => {
  const { controller } = makeController({ start: 2, max: 4 });

  controller.observePeak(8_000_000);
  for (let step = 0; step < 6; step += 1) {
    const decision = controller.sample({ bytes: 500_000, failures: 0, elapsedMs: 1000 });
    assert.equal(decision.limit, 4, 'the width stays at the ceiling the user configured');
  }
});

test('server failures halve the width and pause probing upwards', () => {
  const { controller, advance } = makeController({ start: 8 });

  const failed = controller.sample({ bytes: 8000, failures: 2, elapsedMs: 1000 });
  assert.equal(failed.limit, 4);
  assert.match(failed.reason, /failures/);

  advance(1000);
  const cooling = controller.sample({ bytes: 100_000, failures: 0, elapsedMs: 1000 });
  assert.equal(cooling.changed, false);
  assert.equal(cooling.limit, 4);
  assert.match(cooling.reason, /cooling/);

  advance(61_000);
  controller.sample({ bytes: 4000, failures: 0, elapsedMs: 1000 });
  const after = controller.sample({ bytes: 8000, failures: 0, elapsedMs: 1000 });
  assert.equal(after.limit, 5, 'climbing resumes after the cooldown');
});

test('never goes below the floor', () => {
  const { controller, advance } = makeController({ start: 1, min: 1 });

  controller.sample({ bytes: 1000, failures: 0, elapsedMs: 1000 });
  const floor = controller.sample({ bytes: 10, failures: 0, elapsedMs: 1000 });
  assert.equal(floor.limit, 1);
  assert.equal(floor.changed, false);

  const failure = controller.sample({ bytes: 10, failures: 1, elapsedMs: 1000 });
  assert.equal(failure.limit, 1);
  advance(61_000);
  assert.equal(controller.limit, 1);
});

test('a zero-length sample does not divide by zero', () => {
  const { controller } = makeController();
  assert.doesNotThrow(() => controller.sample({ bytes: 0, failures: 0, elapsedMs: 0 }));
});

test('the gate lets exactly the configured number of workers through', async () => {
  const gate = new WorkGate(2);
  assert.equal(await gate.acquire(), true);
  assert.equal(await gate.acquire(), true);
  assert.equal(gate.inFlight, 2);

  let third = null;
  const waiting = gate.acquire().then((open) => { third = open; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(third, null, 'a third worker waits');

  gate.release();
  await waiting;
  assert.equal(third, true);
  assert.equal(gate.inFlight, 2);
});

test('raising the limit wakes waiting workers without stopping the running ones', async () => {
  const gate = new WorkGate(1);
  await gate.acquire();
  let second = null;
  const waiting = gate.acquire().then((open) => { second = open; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(second, null);

  gate.setLimit(2);
  await waiting;
  assert.equal(second, true);
  assert.equal(gate.inFlight, 2);
  assert.equal(gate.width, 2);
});

test('cancelling releases waiters with false', async () => {
  const gate = new WorkGate(1);
  await gate.acquire();
  const waiting = gate.acquire();
  gate.cancel();
  assert.equal(await waiting, false);
});

test('a cancelled or stopped gate is not entered', async () => {
  const gate = new WorkGate(1);
  assert.equal(await gate.acquire(() => true), false);
  assert.equal(gate.inFlight, 0);
});
