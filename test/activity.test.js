const { test } = require('node:test');
const assert = require('node:assert/strict');

const { ActivityTracker } = require('../dist/core/activity.js');

test('tracks a catalogue rebuild from start to finish', () => {
  const tracker = new ActivityTracker();
  assert.equal(tracker.snapshot().running, false);

  tracker.begin('catalogue', 1000);
  tracker.update(0.25, ['Tag 25 / 100', '50 games found'], 2000);

  const running = tracker.snapshot();
  assert.equal(running.kind, 'catalogue');
  assert.equal(running.running, true);
  assert.equal(running.percent, 0.25);
  assert.deepEqual(running.lines, ['Tag 25 / 100', '50 games found']);
  assert.equal(running.startedAt, 1000);

  tracker.finish('Catalogue rebuilt: 200 games', 3000);
  const done = tracker.snapshot();
  assert.equal(done.running, false);
  assert.equal(done.percent, 1);
  assert.equal(done.outcome, 'Catalogue rebuilt: 200 games');
});

test('ignores updates after finishing and clamps bad values', () => {
  const tracker = new ActivityTracker();
  tracker.begin('catalogue', 1000);
  tracker.update(4, ['over'], 1100);
  assert.equal(tracker.snapshot().percent, 1);

  tracker.update(-1, ['under'], 1200);
  assert.equal(tracker.snapshot().percent, 0);

  tracker.finish('done', 1300);
  tracker.update(0.5, ['late'], 1400);
  const snap = tracker.snapshot();
  assert.equal(snap.percent, 1);
  assert.deepEqual(snap.lines, ['under']);
});

test('records failures and can be reset', () => {
  const tracker = new ActivityTracker();
  tracker.begin('catalogue', 1000);
  tracker.fail('tag query failed', 2000);
  const failed = tracker.snapshot();
  assert.equal(failed.running, false);
  assert.equal(failed.error, 'tag query failed');

  tracker.reset();
  assert.deepEqual(tracker.snapshot(), {
    kind: null,
    running: false,
    percent: 0,
    lines: [],
    startedAt: 0,
    updatedAt: 0,
    outcome: null,
    error: null,
  });
});
