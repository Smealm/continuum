const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { Catalog } = require('../dist/core/catalog.js');
const { tempProject, quietLogger } = require('./helpers.js');

function fakeGame(id, tags, platforms) {
  return {
    id,
    title: `Title ${id}`,
    library: 'arcade',
    platforms,
    tags,
    logoPath: `Logos/aa/${id}.png`,
    screenshotPath: `Screenshots/aa/${id}.png`,
    gameData: [{
      id: Number(id.replace(/\D/g, '')),
      gameId: id,
      title: 'Data Pack',
      dateAdded: '2024-01-01T00:00:00.000Z',
      sha256: 'a'.repeat(64),
      crc32: 0,
      size: 100,
      presentOnDisk: false,
      applicationPath: '',
      launchCommand: '',
    }],
  };
}

function fakeApi(gamesByTag, total) {
  return {
    getPreferences: () => ({ dataPacksFolderPath: '', imageFolderPath: '' }),
    countGames: async () => total,
    findTags: async () => Object.keys(gamesByTag).map((name) => ({ name })),
    findGamesWithTag: async (tag) => gamesByTag[tag] || [],
    findGame: async () => null,
    saveGameData: async (data) => data,
    updateGame: async (game) => game,
    findPlaylistByName: async () => null,
  };
}

test('unions tags into a complete, de-duplicated catalogue', async () => {
  const { paths } = tempProject();
  const g1 = fakeGame('g1', ['Puzzle'], ['Flash']);
  const g2 = fakeGame('g2', ['Puzzle', 'Action'], ['Flash', 'HTML5']);
  const g3 = fakeGame('g3', ['Action'], ['HTML5']);
  const api = fakeApi({ Puzzle: [g1, g2], Action: [g2, g3] }, 3);
  const catalog = new Catalog(api, paths, quietLogger());

  const progress = [];
  const meta = await catalog.scan({ signal: new AbortController().signal, onProgress: (p) => progress.push(p) });

  assert.equal(meta.games, 3);
  assert.equal(meta.packs, 3);
  assert.equal(meta.packsMissing, 3);
  assert.equal(meta.complete, true);
  assert.deepEqual(meta.tagOrder[0], 'Puzzle');

  const lines = fs.readFileSync(paths.catalogFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => line.id).sort(), ['g1', 'g2', 'g3']);
  assert.deepEqual(lines[0].data[0].gameId, lines[0].id);
  assert.ok(progress.length > 0);

  const loaded = await catalog.loadMeta();
  assert.equal(loaded.games, 3);
});

test('keeps the catalogue it replaced for the rebuild report', async () => {
  const { paths } = tempProject();

  const first = new Catalog(
    fakeApi({ Puzzle: [fakeGame('g1', ['Puzzle'], ['Flash'])] }, 1),
    paths,
    quietLogger(),
  );
  await first.scan({ signal: new AbortController().signal });

  const second = new Catalog(
    fakeApi({ Puzzle: [fakeGame('g2', ['Puzzle'], ['Flash'])] }, 1),
    paths,
    quietLogger(),
  );
  await second.scan({ signal: new AbortController().signal });

  const previous = JSON.parse(fs.readFileSync(paths.catalogPreviousFile, 'utf8').trim());
  assert.equal(previous.id, 'g1');
  const current = JSON.parse(fs.readFileSync(paths.catalogFile, 'utf8').trim());
  assert.equal(current.id, 'g2');
});

test('a cancelled scan leaves the previous catalogue alone', async () => {
  const { paths } = tempProject();
  fs.writeFileSync(paths.catalogFile, '{"id":"old"}\n');
  fs.writeFileSync(paths.catalogMetaFile, JSON.stringify({ version: 1, complete: true, generation: 'old', games: 1 }));

  const api = fakeApi({ Puzzle: [fakeGame('g1', ['Puzzle'], ['Flash'])] }, 1);
  const catalog = new Catalog(api, paths, quietLogger());
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    catalog.scan({ signal: controller.signal }),
    /cancelled/,
  );
  assert.equal(fs.readFileSync(paths.catalogFile, 'utf8'), '{"id":"old"}\n');
  assert.equal(await catalog.loadMeta().then((meta) => meta.generation), 'old');
});
