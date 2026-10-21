const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { JsonlCursor } = require('../dist/core/jsonl.js');
const { buildDownloadOrder } = require('../dist/core/order.js');
const { tempProject } = require('./helpers.js');

function record(id, size, extra = {}) {
  return {
    id,
    title: `Game ${id}`,
    library: 'arcade',
    platforms: ['Flash'],
    tags: [],
    logo: '',
    screenshot: '',
    data: [{
      id: 1,
      gameId: id,
      sha256: '',
      size,
      dateAdded: '2024-01-01T00:00:00.000Z',
      present: false,
    }],
    ...extra,
  };
}

function writeCatalog(paths, records) {
  fs.writeFileSync(paths.catalogFile, records.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
}

async function idsInOrder(paths, entries) {
  const cursor = new JsonlCursor(paths.catalogFile);
  const ids = [];
  try {
    for (const entry of entries) {
      cursor.seek(entry.offset);
      const next = await cursor.next();
      assert.ok(next, 'every order entry must point at a record');
      ids.push(next.value.id);
    }
  } finally {
    await cursor.close().catch(() => undefined);
  }
  return ids;
}

test('sorts the whole catalogue by remaining size, not just the first records', async () => {
  const { paths } = tempProject();
  const sizes = [900, 10, 500, 30, 2000, 40, 120, 70, 1, 800, 5, 600];
  writeCatalog(paths, sizes.map((size, index) => record(`game-${index}`, size)));

  const entries = await buildDownloadOrder(paths.catalogFile, () => true);
  assert.equal(entries.length, sizes.length);
  assert.deepEqual(await idsInOrder(paths, entries), [
    'game-8', 'game-10', 'game-1', 'game-3', 'game-5', 'game-7',
    'game-6', 'game-2', 'game-11', 'game-9', 'game-0', 'game-4',
  ]);
});

test('the order is deterministic and keeps catalogue order for ties', async () => {
  const { paths } = tempProject();
  writeCatalog(paths, [
    record('first', 50),
    record('second', 50),
    record('third', 50),
    record('cheap', 1),
  ]);

  const one = await buildDownloadOrder(paths.catalogFile, () => true);
  const two = await buildDownloadOrder(paths.catalogFile, () => true);
  assert.deepEqual(one, two);
  assert.deepEqual(await idsInOrder(paths, one), ['cheap', 'first', 'second', 'third']);
});

test('a game with everything on disk sorts first for its missing images', async () => {
  const { paths } = tempProject();
  const complete = record('complete', 500);
  complete.data[0].present = true;
  writeCatalog(paths, [record('big', 900), complete, record('small', 10)]);

  const entries = await buildDownloadOrder(paths.catalogFile, () => true);
  assert.deepEqual(await idsInOrder(paths, entries), ['complete', 'small', 'big']);
});

test('only games in scope are queued', async () => {
  const { paths } = tempProject();
  writeCatalog(paths, [
    record('apl', 900, { library: 'apl' }),
    record('arcade', 10, { library: 'arcade' }),
    record('apl-small', 1, { library: 'apl' }),
  ]);

  const entries = await buildDownloadOrder(
    paths.catalogFile,
    (game) => game.library === 'apl',
  );
  assert.deepEqual(await idsInOrder(paths, entries), ['apl-small', 'apl']);
});

test('a missing catalogue file rejects instead of returning an empty queue', async () => {
  const { paths } = tempProject();
  await assert.rejects(buildDownloadOrder(`${paths.catalogFile}.missing`, () => true));
});
