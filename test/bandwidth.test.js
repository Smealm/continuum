const { test } = require('node:test');
const assert = require('node:assert/strict');

const { BandwidthMeter } = require('../dist/core/bandwidth.js');

/** Feed `count` one-second windows of `bytes` each. */
function feed(meter, bytes, count, packs = 0, startAt = 0, games = 0) {
  for (let index = 0; index < count; index += 1) {
    meter.observeWindow(bytes, packs, games, 1000, startAt + index * 1000);
  }
}

test('a sample needs three seconds of data before it counts', () => {
  const meter = new BandwidthMeter();
  meter.observeWindow(5_000_000, 1, 0, 1000, 0);
  assert.equal(meter.snapshot().peakBytesPerSecond, 0);
  assert.equal(meter.snapshot().currentBytesPerSecond, 0);

  feed(meter, 5_000_000, 2, 1, 1000);
  assert.equal(meter.snapshot().peakBytesPerSecond, 5_000_000);
  assert.equal(meter.snapshot().currentBytesPerSecond, 5_000_000);
});

test('keeps the best rate instead of the average, so the small-file wall does not skew it', () => {
  const meter = new BandwidthMeter();
  // The opening minutes: 120 KB games, 1 MB/s in total, 4 games a second.
  feed(meter, 1_000_000, 9, 8, 0, 4);
  assert.equal(meter.snapshot().peakBytesPerSecond, 1_000_000);

  // Large packs arrive: 8 MB/s.
  feed(meter, 8_000_000, 3, 2, 9000);
  const snapshot = meter.snapshot();
  assert.equal(snapshot.peakBytesPerSecond, 8_000_000);
  assert.equal(snapshot.currentBytesPerSecond, 8_000_000);
  assert.equal(snapshot.peakPacksPerSecond, 8, 'the best pack rate is kept too');
  assert.equal(snapshot.peakGamesPerSecond, 4, 'and the best game rate, for the ETA');
});

test('a probe rate is accepted as the peak even before the download reaches it', () => {
  const meter = new BandwidthMeter();
  feed(meter, 500_000, 3, 4, 0);
  meter.observePeak(10_000_000);

  const snapshot = meter.snapshot();
  assert.equal(snapshot.peakBytesPerSecond, 10_000_000);
  assert.equal(snapshot.currentBytesPerSecond, 500_000, 'the current rate stays what it is');
});

test('a peak is lowered only after five minutes at less than half of it', () => {
  const meter = new BandwidthMeter();
  feed(meter, 8_000_000, 3, 1, 0);
  assert.equal(meter.snapshot().peakBytesPerSecond, 8_000_000);

  // 99 slow samples (297 s) are not enough.
  feed(meter, 1_000_000, 297, 1, 3000);
  assert.equal(meter.snapshot().peakBytesPerSecond, 8_000_000);

  feed(meter, 1_000_000, 3, 1, 300_000);
  assert.equal(meter.snapshot().peakBytesPerSecond, 4_000_000, 'half the stale peak');
});

test('a wall of small files cannot halve a peak the probe measured', () => {
  const meter = new BandwidthMeter();
  meter.observePeak(10_000_000);

  // Twenty minutes of 120 KB packs at 500 KB/s: plenty of slow samples.
  feed(meter, 500_000, 400, 4, 0);

  assert.equal(
    meter.snapshot().peakBytesPerSecond,
    10_000_000,
    'the link was measured, so the queue shape is not evidence it got slower',
  );
});

test('a newer probe sets the floor, so a genuinely slower link can still lower the peak', () => {
  const meter = new BandwidthMeter();
  feed(meter, 8_000_000, 3, 1, 0);
  meter.observePeak(8_000_000);
  meter.observePeak(1_000_000);

  // Five minutes at a quarter of the old peak: it halves, but not past the probe.
  feed(meter, 2_000_000, 300, 2, 3000);
  assert.equal(meter.snapshot().peakBytesPerSecond, 4_000_000);

  // Ten more minutes: 4 MB/s halves to 2, then to the probe's 1 MB/s and stops.
  feed(meter, 500_000, 600, 2, 310_000);
  assert.equal(meter.snapshot().peakBytesPerSecond, 1_000_000);
});

test('a reset forgets the previous job', () => {
  const meter = new BandwidthMeter();
  feed(meter, 1_000_000, 3, 1, 0);
  meter.reset();

  const snapshot = meter.snapshot();
  assert.equal(snapshot.peakBytesPerSecond, 0);
  assert.equal(snapshot.currentBytesPerSecond, 0);
  assert.equal(snapshot.peakPacksPerSecond, 0);
  assert.equal(snapshot.peakGamesPerSecond, 0);
});

test('ignores zero-length and nonsense windows', () => {
  const meter = new BandwidthMeter();
  meter.observeWindow(1000, 1, 0, 0, 0);
  meter.observeWindow(NaN, -1, 0, 1000, 0);
  meter.observePeak(-5);
  meter.observePeak(NaN);
  assert.equal(meter.snapshot().peakBytesPerSecond, 0);
});
