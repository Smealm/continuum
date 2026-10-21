const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { gameDataFilename } = require('../dist/core/format.js');
const { JsonlCursor } = require('../dist/core/jsonl.js');
const {
  MAX_CHANGED_ENTRIES,
  deletePacks,
  describeDiff,
  diffCatalogues,
  scanOrphanPacks,
  writeChangedList,
} = require('../dist/core/reconcile.js');
const { tempProject } = require('./helpers.js');

/** Older than the 24-hour age floor, so a scan will consider these files. */
const OLD = Date.now() - 3 * 24 * 60 * 60 * 1000;
const ADDED = '2024-01-01T00:00:00.000Z';
/** Date.parse(ADDED), as it appears in a pack file name. */
const ADDED_MS = 1704067200000;

function record(id, packs = []) {
  return {
    id,
    title: `Game ${id}`,
    library: 'arcade',
    platforms: [],
    tags: [],
    logo: '',
    screenshot: '',
    data: packs.map((pack, index) => ({
      id: index + 1,
      gameId: id,
      sha256: pack.sha || 'a'.repeat(64),
      size: pack.size ?? 100,
      dateAdded: pack.dateAdded || ADDED,
      present: false,
    })),
  };
}

function writeRecords(file, records) {
  fs.writeFileSync(file, records.map((entry) => `${JSON.stringify(entry)}\n`).join(''), 'utf8');
}

function packName(gameId, dateAdded = ADDED) {
  return gameDataFilename({ gameId, dateAdded });
}

function writePack(dir, name, bytes = 10, mtime = OLD) {
  const target = path.join(dir, name);
  fs.writeFileSync(target, Buffer.alloc(bytes, 1));
  fs.utimesSync(target, new Date(mtime), new Date(mtime));
  return target;
}

test('reports new and removed games and changed packs', async () => {
  const { paths } = tempProject();
  writeRecords(paths.catalogPreviousFile, [
    record('a', [{ dateAdded: '2024-01-01T00:00:00.000Z' }]),
    record('b', [{ sha: 'b'.repeat(64) }]),
    record('c', [{ sha: 'c'.repeat(64) }]),
  ]);
  writeRecords(paths.catalogFile, [
    record('a', [{ dateAdded: '2024-06-01T00:00:00.000Z' }]),
    record('c', [{ sha: 'c'.repeat(64) }]),
    record('d'),
  ]);

  const diff = await diffCatalogues(paths.catalogPreviousFile, paths.catalogFile);

  assert.equal(diff.previousGames, 3);
  assert.equal(diff.currentGames, 3);
  assert.equal(diff.newGames, 1);
  assert.equal(diff.removedGames, 1);
  assert.deepEqual(diff.removedExamples, ['Game b']);
  // a's pack got a new dateAdded, so its old file was replaced; c is unchanged.
  assert.equal(diff.updatedPacks, 1);
  // b disappeared together with its pack.
  assert.equal(diff.removedPacks, 1);

  // Only the game with a changed pack and the new game need another look.
  assert.deepEqual(diff.changed.map((entry) => entry.id).sort(), ['a', 'd']);

  // The offsets are byte positions, so a changed pass can seek straight to the
  // record instead of walking the catalogue.
  const cursor = new JsonlCursor(paths.catalogFile);
  try {
    for (const entry of diff.changed) {
      cursor.seek(entry.offset);
      const next = await cursor.next();
      assert.equal(next.value.id, entry.id);
    }
  } finally {
    await cursor.close();
  }
});

test('writes the changed list a later pass reads', async () => {
  const { paths } = tempProject();
  writeRecords(paths.catalogPreviousFile, [record('a', [{}])]);
  writeRecords(paths.catalogFile, [record('a', [{}]), record('b', [{}])]);
  const diff = await diffCatalogues(paths.catalogPreviousFile, paths.catalogFile);

  const result = await writeChangedList(paths.changedFile, 'gen-2', diff);
  assert.equal(result.written, 1);
  assert.equal(result.tooMany, false);

  const list = JSON.parse(fs.readFileSync(paths.changedFile, 'utf8'));
  assert.equal(list.version, 1);
  assert.equal(list.generation, 'gen-2');
  assert.deepEqual(list.entries.map((entry) => entry.id), ['b']);
});

test('a huge change set or no changes leaves no changed list behind', async () => {
  const { paths } = tempProject();
  const entries = Array.from(
    { length: MAX_CHANGED_ENTRIES + 1 },
    (_, index) => ({ id: `g${index}`, offset: index }),
  );
  const diff = {
    newGames: entries.length,
    removedGames: 0,
    updatedPacks: 0,
    removedPacks: 0,
    previousGames: 0,
    currentGames: entries.length,
    removedExamples: [],
    changed: entries,
  };

  fs.writeFileSync(paths.changedFile, '{"stale":true}');
  const huge = await writeChangedList(paths.changedFile, 'gen-2', diff);
  assert.equal(huge.written, 0);
  assert.equal(huge.tooMany, true);
  assert.equal(fs.existsSync(paths.changedFile), false);

  fs.writeFileSync(paths.changedFile, '{"stale":true}');
  const none = await writeChangedList(paths.changedFile, 'gen-2', { ...diff, newGames: 0, changed: [] });
  assert.deepEqual(none, { written: 0, tooMany: false });
  assert.equal(fs.existsSync(paths.changedFile), false);
});

test('a changed hash counts as an updated pack even with the same file name', async () => {
  const { paths } = tempProject();
  writeRecords(paths.catalogPreviousFile, [record('a', [{ sha: 'a'.repeat(64) }])]);
  writeRecords(paths.catalogFile, [record('a', [{ sha: 'f'.repeat(64) }])]);

  const diff = await diffCatalogues(paths.catalogPreviousFile, paths.catalogFile);

  assert.equal(diff.newGames, 0);
  assert.equal(diff.removedGames, 0);
  assert.equal(diff.updatedPacks, 1);
});

test('returns null when there is nothing to compare', async () => {
  const { paths } = tempProject();
  writeRecords(paths.catalogFile, [record('a')]);

  assert.equal(await diffCatalogues(paths.catalogPreviousFile, paths.catalogFile), null);
});

test('summarises the diff for the dialog', () => {
  const text = describeDiff({
    newGames: 2,
    removedGames: 1,
    updatedPacks: 3,
    removedPacks: 1,
    previousGames: 5,
    currentGames: 6,
    removedExamples: ['Old Game'],
  });

  assert.match(text, /2 new game\(s\)/);
  assert.match(text, /1 removed upstream/);
  assert.match(text, /3 data pack\(s\) updated/);
  assert.match(text, /Removed: Old Game/);
  assert.match(text, /Clean up old game files/);
  assert.equal(describeDiff(null), '');
});

test('lists only old, unreferenced pack files', async () => {
  const { paths } = tempProject();
  writeRecords(paths.catalogFile, [record('kept', [{}])]);
  writePack(paths.dataPacksDir, packName('kept'), 5);
  writePack(paths.dataPacksDir, 'gone-1700000000000.zip', 30);
  writePack(paths.dataPacksDir, `kept-${ADDED_MS - 1000}.zip`, 20);
  writePack(paths.dataPacksDir, 'gone-1750000000000.zip', 40, Date.now());
  writePack(paths.dataPacksDir, 'notes.txt', 5);
  writePack(paths.dataPacksDir, 'no-timestamp.zip', 5);
  writePack(paths.dataPacksDir, 'gone-1700000000000.zip.part', 5);
  fs.mkdirSync(path.join(paths.dataPacksDir, 'folder-1700000000000.zip'));

  const scan = await scanOrphanPacks({
    dataPacksDir: paths.dataPacksDir,
    catalogFile: paths.catalogFile,
  });

  assert.deepEqual(scan.items.map((item) => item.filename), ['gone-1700000000000.zip']);
  assert.equal(scan.bytes, 30);
  assert.equal(scan.items[0].superseded, false);

  assert.deepEqual(scan.supersededItems.map((item) => item.filename), [`kept-${ADDED_MS - 1000}.zip`]);
  assert.equal(scan.supersededBytes, 20);
  assert.equal(scan.supersededItems[0].superseded, true);

  assert.equal(scan.tooNew, 1);
  assert.equal(scan.ignored, 4);
});

test('a reference in different case is not a leftover where the file system folds case', async () => {
  const { paths } = tempProject();
  writeRecords(paths.catalogFile, [record('Mixed')]);
  const name = packName('Mixed');
  writePack(paths.dataPacksDir, name.toLowerCase(), 12);

  const folded = await scanOrphanPacks({
    dataPacksDir: paths.dataPacksDir,
    catalogFile: paths.catalogFile,
    caseInsensitive: true,
  });
  assert.equal(folded.items.length, 0);

  const exact = await scanOrphanPacks({
    dataPacksDir: paths.dataPacksDir,
    catalogFile: paths.catalogFile,
    caseInsensitive: false,
  });
  assert.deepEqual(exact.items.map((item) => item.filename), [name.toLowerCase()]);
});

test('delete removes the listed files and reports failures without stopping', async () => {
  const { paths } = tempProject();
  const one = writePack(paths.dataPacksDir, 'gone-1.zip', 12);
  const two = writePack(paths.dataPacksDir, 'gone-2.zip', 8);
  const escape = path.join(paths.dataPacksDir, '..', 'escape.zip');
  fs.writeFileSync(escape, 'keep me');

  const result = await deletePacks(paths.dataPacksDir, [
    { filename: 'gone-1.zip', bytes: 12 },
    { filename: 'missing-3.zip', bytes: 1 },
    { filename: '../escape.zip', bytes: 1 },
    { filename: 'gone-2.zip', bytes: 8 },
  ]);

  assert.equal(result.deleted, 2);
  assert.equal(result.bytes, 20);
  assert.deepEqual(result.failed.map((failure) => failure.filename), ['missing-3.zip', '../escape.zip']);
  assert.equal(fs.existsSync(one), false);
  assert.equal(fs.existsSync(two), false);
  assert.equal(fs.existsSync(escape), true);
});

test('a referenced file is never listed, however old it is', async () => {
  const { paths } = tempProject();
  writeRecords(paths.catalogFile, [record('a', [{}])]);
  const referenced = writePack(paths.dataPacksDir, packName('a'), 7, OLD);

  const scan = await scanOrphanPacks({
    dataPacksDir: paths.dataPacksDir,
    catalogFile: paths.catalogFile,
  });

  assert.equal(scan.items.length, 0);
  assert.equal(scan.supersededItems.length, 0);
  const result = await deletePacks(paths.dataPacksDir, scan.items);
  assert.equal(result.deleted, 0);
  assert.equal(fs.existsSync(referenced), true);
});
