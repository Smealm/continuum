const { test } = require('node:test');
const assert = require('node:assert/strict');

const { ActivityTracker } = require('../dist/core/activity.js');
const { describeCatalogSource, scanCatalogue } = require('../dist/manager.js');
const { quietLogger } = require('./helpers.js');

function meta(source, games = 3) {
  return {
    version: 1,
    generation: 'gen-1',
    scannedAt: '2024-01-01T00:00:00.000Z',
    tagsTotal: 2,
    tagsScanned: 2,
    games,
    packs: games,
    packsMissing: 0,
    bytesTotal: 0,
    bytesMissing: 0,
    images: 0,
    complete: true,
    tagOrder: [],
    source,
  };
}

function makeCtx({ fast = null, fastEnabled = true, fastError = null, tagError = null } = {}) {
  const calls = { fast: 0, tags: 0, dialogs: [], tasks: [] };
  const ctx = {
    log: quietLogger(),
    activity: new ActivityTracker(),
    fastCatalog: fast === null && fastError === null ? null : {
      scan: async () => {
        calls.fast += 1;
        if (fastError) {
          throw fastError;
        }
        return fast;
      },
    },
    readFastCatalogue: () => fastEnabled,
    engine: { isRunning: () => false },
    catalog: {
      scan: async () => {
        calls.tags += 1;
        if (tagError) {
          throw tagError;
        }
        return meta('api', 7);
      },
      loadMeta: async () => null,
    },
    fp: {
      status: {
        newTask: (task) => {
          calls.tasks.push({ ...task });
          return { id: 'task-1' };
        },
        setTask: (update) => calls.tasks.push(update),
      },
      dialogs: {
        showMessageBox: async (options) => {
          calls.dialogs.push(options);
          return 0;
        },
      },
    },
  };
  return { ctx, calls };
}

test('uses the database build when it is enabled and available', async () => {
  const fastMeta = meta('database', 221288);
  const { ctx, calls } = makeCtx({ fast: fastMeta });

  const result = await scanCatalogue(ctx);

  assert.equal(result, fastMeta);
  assert.equal(calls.fast, 1);
  assert.equal(calls.tags, 0);
  assert.equal(calls.dialogs.length, 0);
  assert.equal(calls.tasks[0].status, 'Reading the launcher database...');
  assert.equal(calls.tasks[calls.tasks.length - 1].finished, true);
  assert.equal(ctx.activity.snapshot().running, false);
  assert.match(ctx.activity.snapshot().outcome, /221,288 games/);
});

test('uses the tag scan when the fast build is switched off', async () => {
  const { ctx, calls } = makeCtx({ fast: meta('database'), fastEnabled: false });

  const result = await scanCatalogue(ctx);

  assert.equal(result.games, 7);
  assert.equal(calls.fast, 0);
  assert.equal(calls.tags, 1);
  assert.equal(calls.tasks[0].status, 'Reading tags...');
});

test('falls back to the tag scan when the database read fails', async () => {
  const { ctx, calls } = makeCtx({
    fastError: new Error('The launcher database does not have the expected shape (3 of 8 tables).'),
  });

  const result = await scanCatalogue(ctx);

  assert.equal(result.games, 7);
  assert.equal(calls.fast, 1);
  assert.equal(calls.tags, 1);
  assert.equal(calls.dialogs.length, 1);
  assert.match(calls.dialogs[0].message, /Continuing with the tag scan/);
  assert.match(calls.dialogs[0].message, /expected shape/);
});

test('a cancelled database read does not fall back or start over', async () => {
  const { ctx, calls } = makeCtx({ fastError: new Error('Catalogue scan cancelled') });

  const result = await scanCatalogue(ctx);

  assert.equal(result, null);
  assert.equal(calls.fast, 1);
  assert.equal(calls.tags, 0);
  assert.match(calls.dialogs[0].message, /Catalogue rebuild failed/);
  assert.equal(ctx.activity.snapshot().error, 'Catalogue scan cancelled');
});

test('reports how the next rebuild will run', () => {
  const fast = makeCtx({ fast: meta('database') }).ctx;
  assert.match(describeCatalogSource(fast), /Fast build: on/);

  const off = makeCtx({ fast: meta('database'), fastEnabled: false }).ctx;
  assert.match(describeCatalogSource(off), /switched off/);

  const missing = makeCtx({ fastEnabled: true }).ctx;
  assert.match(describeCatalogSource(missing), /unavailable/);
});
