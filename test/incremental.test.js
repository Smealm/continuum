const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { Catalog } = require('../dist/core/catalog.js');
const { Engine } = require('../dist/core/engine.js');
const { gameDataFilename } = require('../dist/core/format.js');
const {
  catalogueFrom,
  makeApi,
  makeGame,
  makeSink,
  quietLogger,
  sha256,
  startServer,
  tempProject,
  writeCatalogue,
} = require('./helpers.js');

function baseSettings(overrides = {}) {
  return {
    mode: 'active',
    scope: { kind: 'all', value: '' },
    includeImages: false,
    reserveBytes: 1024,
    maxBytes: 0,
    activeWorkers: 1,
    passiveWorkers: 1,
    passiveDelayMs: 0,
    respectFlashpointSettings: false,
    autoMirror: false,
    prioritizePlaylists: false,
    ...overrides,
  };
}

function packsFor(games, labels) {
  return games.map((game, index) => {
    const pack = Buffer.from(labels[index]);
    game.gameData[0].sha256 = sha256(pack);
    game.gameData[0].size = pack.length;
    return pack;
  });
}

function routesFor(games, packs, downloads) {
  const routes = {};
  games.forEach((game, index) => {
    routes[`/games/${gameDataFilename(game.gameData[0])}`] = (request, response) => {
      downloads.push(game.id);
      response.writeHead(200, { 'content-length': packs[index].length });
      response.end(packs[index]);
    };
  });
  return routes;
}

function makeEngine(api, paths) {
  return new Engine({
    api,
    paths,
    log: quietLogger(),
    sink: makeSink(),
    probeFree: async () => ({ freeBytes: 10 * 1024 * 1024 * 1024 }),
    retryWaitMs: 0,
  }, new Catalog(api, paths, quietLogger()));
}

/** Byte offset of every record, as the rebuild diff records them. */
function recordOffsets(paths) {
  const raw = fs.readFileSync(paths.catalogFile);
  const offsets = new Map();
  let start = 0;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== 0x0a) {
      continue;
    }
    const line = raw.subarray(start, index).toString('utf8');
    if (line.trim()) {
      offsets.set(JSON.parse(line).id, start);
    }
    start = index + 1;
  }
  return offsets;
}

function writeChangedList(paths, generation, ids) {
  const offsets = recordOffsets(paths);
  const entries = ids.map((id) => {
    assert.equal(typeof offsets.get(id), 'number', `no offset for ${id}`);
    return { id, offset: offsets.get(id) };
  });
  fs.writeFileSync(paths.changedFile, JSON.stringify({
    version: 1,
    generation,
    scannedAt: '2024-01-01T00:00:00.000Z',
    entries,
  }));
}

function setup() {
  const { paths } = tempProject();
  const games = [makeGame(1), makeGame(2), makeGame(3)];
  const packs = packsFor(games, ['pack-one', 'pack-two', 'pack-three']);
  writeCatalogue(paths, catalogueFrom(games), 'gen-1');
  return { paths, games, packs };
}

function configure(api, server) {
  api.prefs.gameDataSources = [{ type: 'raw', name: 'test', arguments: [`http://127.0.0.1:${server.port}/games/`] }];
}

test('a changed-only pass downloads just the changed games', async () => {
  const { paths, games, packs } = setup();
  const downloads = [];
  const server = await startServer(routesFor(games, packs, downloads));

  try {
    const api = makeApi(games);
    configure(api, server);
    writeChangedList(paths, 'gen-1', ['game-2']);

    const engine = makeEngine(api, paths);
    const prep = await engine.prepare(baseSettings(), { changedOnly: true });

    assert.equal(prep.changedOnly, true);
    assert.equal(prep.changed.entries.length, 1);
    assert.equal(prep.estimate.gamesInScope, 1);
    assert.equal(prep.estimate.packsMissing, 1);

    await engine.start(prep);
    await engine.whenIdle();

    assert.deepEqual(downloads, ['game-2']);

    const snapshot = engine.snapshot();
    assert.equal(snapshot.status, 'done');
    assert.equal(snapshot.job.gamesDone, 1);
    assert.equal(snapshot.job.changed.total, 1);
    assert.equal(snapshot.job.changed.cursor, 1);
    // The main catalogue pass is untouched, so the next full pass starts fresh.
    assert.equal(snapshot.job.cursor, 0);

    const untouched = path.join(paths.dataPacksDir, gameDataFilename(games[0].gameData[0]));
    assert.equal(fs.existsSync(untouched), false);

    // Once the list is handled it is removed, so the next start is a full pass.
    assert.equal(fs.existsSync(paths.changedFile), false);
    const again = await engine.prepare(baseSettings());
    assert.equal(again.changed, null);
    assert.equal(again.changedOnly, false);
  } finally {
    await server.close();
  }
});

test('a full pass afterwards fetches everything the changed pass skipped', async () => {
  const { paths, games, packs } = setup();
  const downloads = [];
  const server = await startServer(routesFor(games, packs, downloads));

  try {
    const api = makeApi(games);
    configure(api, server);
    writeChangedList(paths, 'gen-1', ['game-2']);

    const engine = makeEngine(api, paths);
    await engine.start(await engine.prepare(baseSettings(), { changedOnly: true }));
    await engine.whenIdle();

    const full = await engine.prepare(baseSettings());
    assert.equal(full.changedOnly, false);
    // The handled list is gone, so Start goes straight to a full pass.
    assert.equal(full.changed, null);
    // A changed pass and a full pass are different jobs, even on the same catalogue.
    assert.equal(full.resumable, false);

    await engine.start(full);
    await engine.whenIdle();

    assert.deepEqual(downloads, ['game-2', 'game-1', 'game-3']);
    assert.equal(engine.snapshot().job.changed, undefined);
  } finally {
    await server.close();
  }
});

test('a changed pass resumes its list instead of starting over', async () => {
  const { paths, games, packs } = setup();
  const downloads = [];
  const server = await startServer(routesFor(games, packs, downloads));

  try {
    const api = makeApi(games);
    configure(api, server);
    writeChangedList(paths, 'gen-1', ['game-1', 'game-2']);

    const engine = makeEngine(api, paths);
    // The first pack fits exactly; the second would exceed the limit and stop.
    const limited = await engine.prepare(
      baseSettings({ maxBytes: packs[0].length }),
      { changedOnly: true },
    );
    await engine.start(limited);
    await engine.whenIdle();

    assert.deepEqual(downloads, ['game-1']);
    const stopped = engine.snapshot();
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.job.changed.total, 2);
    assert.equal(stopped.job.changed.cursor, 1);

    const resumed = await engine.prepare(baseSettings(), { changedOnly: true });
    assert.equal(resumed.resumable, true);
    assert.equal(resumed.job.changed.cursor, 1);

    await engine.start(resumed);
    await engine.whenIdle();

    assert.deepEqual(downloads, ['game-1', 'game-2']);
    const finished = engine.snapshot();
    assert.equal(finished.status, 'done');
    assert.equal(finished.job.changed.cursor, 2);
  } finally {
    await server.close();
  }
});

test('the engine reports how many games a rebuild left to download', async () => {
  const { paths, games } = setup();
  const meta = JSON.parse(fs.readFileSync(paths.catalogMetaFile, 'utf8'));
  const engine = makeEngine(makeApi(games), paths);

  assert.equal(await engine.pendingChanges(meta), 0);

  writeChangedList(paths, 'gen-1', ['game-2', 'game-3']);
  assert.equal(await engine.pendingChanges(meta), 2);

  // A list from the previous catalogue says nothing about this one.
  assert.equal(await engine.pendingChanges({ ...meta, generation: 'gen-0' }), 0);
});

test('a changed list from another catalogue generation is ignored', async () => {
  const { paths, games } = setup();
  writeChangedList(paths, 'gen-0', ['game-2']);

  const api = makeApi(games);
  const engine = makeEngine(api, paths);
  const prep = await engine.prepare(baseSettings(), { changedOnly: true });

  assert.equal(prep.changed, null);
  assert.equal(prep.changedOnly, false);
  assert.equal(prep.estimate.gamesInScope, 3);
});

test('without a changed list a full pass still estimates the whole scope', async () => {
  const { paths, games } = setup();
  const api = makeApi(games);
  const engine = makeEngine(api, paths);

  const prep = await engine.prepare(baseSettings());
  assert.equal(prep.changed, null);
  assert.equal(prep.changedOnly, false);
  assert.equal(prep.estimate.gamesInScope, 3);
  assert.equal(prep.estimate.packsMissing, 3);
});

test('an out-of-scope changed game is counted only when it matches the scope', async () => {
  const { paths, games } = setup();
  // makeGame gives game-2 the Flash platform and game-1 HTML5.
  writeChangedList(paths, 'gen-1', ['game-1', 'game-2']);

  const api = makeApi(games);
  const engine = makeEngine(api, paths);
  const prep = await engine.prepare(
    baseSettings({ scope: { kind: 'platform', value: 'Flash' } }),
    { changedOnly: true },
  );

  assert.equal(prep.changed.entries.length, 2);
  assert.equal(prep.estimate.gamesInScope, 1);
  assert.equal(prep.estimate.packsMissing, 1);
});
