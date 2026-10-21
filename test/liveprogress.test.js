const { test } = require('node:test');
const assert = require('node:assert/strict');

const { showProgress } = require('../dist/liveprogress.js');

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

const settings = {
  mode: 'active',
  scope: { kind: 'all', value: '' },
  includeImages: true,
  reserveBytes: 0,
  maxBytes: 0,
  activeWorkers: 4,
  passiveWorkers: 1,
  passiveDelayMs: 0,
  respectExtremeFilter: true,
  autoResume: false,
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

function runningEngine(now) {
  return {
    status: 'running',
    message: '',
    mode: 'active',
    job: {
      version: 1,
      generation: 'g1',
      scopeKey: 'all:|images=1',
      mode: 'active',
      cursor: 10,
      bytes: 1024,
      packsDone: 1,
      packsFailed: 0,
      gamesDone: 1,
      gamesFailed: 0,
      imagesDone: 0,
      status: 'running',
      message: 'Downloading (active)',
      updatedAt: new Date(now - 1000).toISOString(),
    },
    meta: null,
    live: {
      gameId: 'g1',
      gameTitle: 'Game One',
      received: 512,
      total: 1024,
      bytesPerSecond: 256,
    },
    settings,
    progress: { sessionBytes: 1024, estimateBytes: 2048, percent: 0.5 },
    startedAt: now - 60_000,
  };
}

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

test('opens a live dialog and updates its fields', async () => {
  const now = Date.now();
  const updates = [];
  let options = null;
  let awaited = null;

  const ctx = {
    catalog: { loadMeta: async () => meta },
    paths: { dataPacksDir: 'unused' },
    activity: { snapshot: () => idleScan },
    engine: { snapshot: () => runningEngine(now) },
    probeFreeBytes: async () => 10 * 1024 * 1024 * 1024,
    fp: {
      dialogs: {
        showMessageBoxWithHandle: async (template) => {
          options = template;
          return 'dialog-1';
        },
        awaitDialog: async (dialogId) => {
          awaited = dialogId;
          await new Promise((resolve) => setTimeout(resolve, 120));
          return { buttonIdx: 0, dialog: {} };
        },
        updateDialogField: (id, name, value) => {
          updates.push({ id, name, value });
        },
        showMessageBox: async () => {
          throw new Error('static dialog should not be used while active');
        },
      },
    },
  };

  await showProgress(ctx);

  assert.equal(awaited, 'dialog-1');
  assert.ok(options);
  assert.match(options.message, /does not stop the download/);
  assert.equal(options.buttons[0], 'Back');
  assert.deepEqual(options.fields.map((field) => field.name), ['activity', 'stats', 'timing', 'progress']);
  assert.match(options.fields[0].value, /Game One/);

  const progressUpdate = updates.find((update) => update.name === 'progress');
  assert.ok(progressUpdate);
  assert.equal(progressUpdate.value, 50);
  const activityUpdate = updates.find((update) => update.name === 'activity');
  assert.match(activityUpdate.value, /Game One/);
});

test('shows a single static summary when idle', async () => {
  let shown = null;
  let liveUsed = false;

  const ctx = {
    catalog: { loadMeta: async () => meta },
    paths: { dataPacksDir: 'unused' },
    activity: { snapshot: () => idleScan },
    engine: { snapshot: () => idleEngine() },
    probeFreeBytes: async () => 5 * 1024 * 1024 * 1024,
    fp: {
      dialogs: {
        showMessageBoxWithHandle: async () => {
          liveUsed = true;
          return 'dialog-1';
        },
        awaitDialog: async () => ({ buttonIdx: 0, dialog: {} }),
        updateDialogField: () => undefined,
        showMessageBox: async (template) => {
          shown = template;
          return 0;
        },
      },
    },
  };

  await showProgress(ctx);

  assert.equal(liveUsed, false);
  assert.ok(shown);
  assert.match(shown.message, /Continuum is idle/);
  assert.match(shown.message, /Catalogue: 100 games/);
  assert.equal(shown.buttons[0], 'Back');
});
