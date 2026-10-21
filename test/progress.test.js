const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildProgressView } = require('../dist/core/progress.js');

const settings = {
  mode: 'active',
  scope: { kind: 'all', value: '' },
  includeImages: true,
  reserveBytes: 1024,
  maxBytes: 0,
  activeWorkers: 4,
  passiveWorkers: 1,
  passiveDelayMs: 0,
  respectFlashpointSettings: true,
  autoMirror: false,
};

const idleScan = {
  kind: null,
  running: false,
  percent: 0,
  lines: [],
  startedAt: 0,
  updatedAt: 0,
  outcome: null,
  error: null,
};

const meta = {
  version: 1,
  generation: 'g1',
  scannedAt: '2024-01-01T00:00:00.000Z',
  tagsTotal: 1,
  tagsScanned: 1,
  games: 100,
  packs: 120,
  packsMissing: 20,
  bytesTotal: 1000,
  bytesMissing: 200,
  images: 200,
  complete: true,
  tagOrder: [],
};

function idleEngine() {
  return {
    status: 'idle',
    message: '',
    mode: null,
    job: null,
    meta: null,
    live: null,
    settings: null,
    progress: { sessionBytes: 0, estimateBytes: 0, percent: 0 },
    startedAt: null,
  };
}

test('shows catalogue rebuild progress with elapsed time and ETA', () => {
  const now = 120_000;
  const view = buildProgressView({
    scan: {
      kind: 'catalogue',
      running: true,
      percent: 0.5,
      lines: ['Tag 500 / 1,000', '20,000 games found · 21,000 packs'],
      startedAt: 60_000,
      updatedAt: now,
      outcome: null,
      error: null,
    },
    engine: idleEngine(),
    meta: null,
    freeBytes: null,
    now,
  });

  assert.equal(view.active, true);
  assert.equal(view.percent, 50);
  assert.match(view.title, /Rebuilding/);
  assert.match(view.activity, /Tag 500/);
  assert.match(view.stats, /20,000 games/);
  assert.match(view.timing, /Elapsed 1m 00s/);
  assert.match(view.timing, /ETA 1m 00s/);
  assert.match(view.message, /does not stop the rebuild/);
});

test('shows download activity, totals and speed', () => {
  const now = Date.parse('2024-01-01T00:02:00.000Z');
  const job = {
    version: 1,
    generation: 'g1',
    scopeKey: 'all:|images=1',
    mode: 'active',
    cursor: 100,
    bytes: 52_428_800,
    packsDone: 12,
    packsFailed: 1,
    gamesDone: 10,
    gamesFailed: 1,
    imagesDone: 5,
    status: 'running',
    message: 'Downloading (active)',
    updatedAt: '2024-01-01T00:01:59.000Z',
  };
  const view = buildProgressView({
    scan: idleScan,
    engine: {
      status: 'running',
      message: '',
      mode: 'active',
      job,
      meta: null,
      live: {
        gameId: 'g1',
        gameTitle: 'Game One',
        received: 5_000_000,
        total: 10_000_000,
        bytesPerSecond: 1_000_000,
      },
      settings,
      progress: { sessionBytes: 52_428_800, estimateBytes: 104_857_600, percent: 0.5 },
      startedAt: now - 60_000,
    },
    meta: null,
    freeBytes: 10 * 1024 * 1024 * 1024,
    now,
  });

  assert.equal(view.active, true);
  assert.equal(view.percent, 50);
  assert.match(view.title, /Downloading \(active\)/);
  assert.match(view.activity, /Game One \(4\.77 MB \/ 9\.54 MB\)/);
  assert.match(view.stats, /10 games/);
  assert.match(view.stats, /1 failed/);
  assert.match(view.timing, /Elapsed 1m 00s/);
  assert.match(view.timing, /ETA 1m 00s/);
  assert.match(view.timing, /free/);
  assert.match(view.message, /does not stop the download/);
});

test('the ETA uses the measured peak instead of the slow first minutes of the queue', () => {
  const now = Date.parse('2024-01-01T00:20:00.000Z');
  const view = buildProgressView({
    scan: idleScan,
    engine: {
      status: 'running',
      message: '',
      mode: 'active',
      job: {
        version: 1,
        generation: 'g1',
        scopeKey: 'all:|images=1',
        mode: 'active',
        cursor: 100,
        bytes: 1024 * 1024 * 1024,
        packsDone: 100,
        packsFailed: 0,
        gamesDone: 100,
        gamesFailed: 0,
        imagesDone: 0,
        status: 'running',
        message: 'Downloading (active)',
        updatedAt: '2024-01-01T00:19:59.000Z',
      },
      meta: null,
      live: null,
      settings,
      progress: {
        sessionBytes: 100 * 1024 * 1024,
        doneBytes: 1024 * 1024 * 1024,
        estimateBytes: 10 * 1024 * 1024 * 1024,
        percent: 0.1,
        remainingBytes: 9 * 1024 * 1024 * 1024,
        remainingPacks: 1000,
        peakBytesPerSecond: 8 * 1024 * 1024,
        currentBytesPerSecond: 1.5 * 1024 * 1024,
        peakPacksPerSecond: 20,
      },
      startedAt: now - 600_000,
    },
    meta: null,
    freeBytes: null,
    now,
  });

  assert.equal(view.percent, 10);
  // 9 GiB at the measured 8 MB/s, not at the 1.7 MB/s lifetime average that
  // the wall of small games dragged down.
  assert.match(view.timing, /1\.50 MB\/s/);
  assert.match(view.timing, /peak 8\.00 MB\/s/);
  assert.match(view.timing, /ETA 19m 12s/);
});

test('a queue of tiny games puts a floor under the ETA', () => {
  const now = Date.parse('2024-01-01T00:10:00.000Z');
  const view = buildProgressView({
    scan: idleScan,
    engine: {
      status: 'running',
      message: '',
      mode: 'active',
      job: {
        version: 1,
        generation: 'g1',
        scopeKey: 'all:|images=1',
        mode: 'active',
        cursor: 100,
        bytes: 1024,
        packsDone: 10,
        packsFailed: 0,
        gamesDone: 10,
        gamesFailed: 0,
        imagesDone: 0,
        status: 'running',
        message: 'Downloading (active)',
        updatedAt: '2024-01-01T00:09:59.000Z',
      },
      meta: null,
      live: null,
      settings,
      progress: {
        sessionBytes: 1024,
        doneBytes: 1024,
        estimateBytes: 10 * 1024 * 1024,
        percent: 0.01,
        remainingBytes: 10 * 1024 * 1024,
        remainingPacks: 100,
        remainingGames: 1000,
        peakBytesPerSecond: 8 * 1024 * 1024,
        currentBytesPerSecond: 1024,
        peakPacksPerSecond: 5,
        peakGamesPerSecond: 25,
      },
      startedAt: now - 60_000,
    },
    meta: null,
    freeBytes: null,
    now,
  });

  // 10 MB of bytes is a second at 8 MB/s and 100 packs is 20 s, but 1,000 games
  // at the best rate of 25 a second takes 40 s.
  assert.match(view.timing, /ETA 40s/);
});

test('shows a paused job as still resumable', () => {
  const now = Date.parse('2024-01-01T00:05:00.000Z');
  const job = {
    version: 1,
    generation: 'g1',
    scopeKey: 'all:|images=1',
    mode: 'passive',
    cursor: 10,
    bytes: 1024,
    packsDone: 1,
    packsFailed: 0,
    gamesDone: 1,
    gamesFailed: 0,
    imagesDone: 0,
    status: 'paused',
    message: 'Paused: only 1 GB free (reserve 5 GB).',
    updatedAt: '2024-01-01T00:04:00.000Z',
  };
  const view = buildProgressView({
    scan: idleScan,
    engine: {
      status: 'paused',
      message: job.message,
      mode: 'passive',
      job,
      meta: null,
      live: null,
      settings: { ...settings, mode: 'passive' },
      progress: { sessionBytes: 1024, estimateBytes: 2048, percent: 0.5 },
      startedAt: now - 120_000,
    },
    meta: null,
    freeBytes: 1024 * 1024 * 1024,
    now,
  });

  assert.equal(view.active, true);
  assert.equal(view.title, 'Download paused');
  assert.match(view.message, /only 1 GB free/);
  assert.match(view.timing, /Elapsed 1m 00s/);
});

test('idle view summarises the catalogue and last outcome', () => {
  const view = buildProgressView({
    scan: { ...idleScan, outcome: 'Catalogue rebuilt: 100 games, 120 packs' },
    engine: idleEngine(),
    meta,
    freeBytes: 5 * 1024 * 1024 * 1024,
    now: 1000,
  });

  assert.equal(view.active, false);
  assert.match(view.title, /idle/i);
  assert.match(view.message, /Catalogue rebuilt: 100 games/);
  assert.match(view.message, /Catalogue: 100 games · 120 packs/);
  assert.match(view.message, /Missing from disk: 20 packs/);
  assert.match(view.message, /Free space: 5\.00 GB/);
  assert.equal(view.percent, 0);
});
