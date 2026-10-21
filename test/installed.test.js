const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { Catalog } = require('../dist/core/catalog.js');
const { Engine } = require('../dist/core/engine.js');
const { gameDataFilename } = require('../dist/core/format.js');
const {
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

function catalogueFrom(games) {
  return games.map((game) => ({
    id: game.id,
    title: game.title,
    library: game.library,
    platforms: game.platforms,
    tags: game.tags,
    logo: game.logoPath,
    screenshot: game.screenshotPath,
    data: game.gameData.map((data) => ({
      id: data.id,
      gameId: data.gameId,
      sha256: data.sha256,
      size: data.size,
      dateAdded: data.dateAdded,
      present: false,
    })),
  }));
}

function packsFor(games, labels) {
  return games.map((game, index) => {
    const pack = Buffer.from(labels[index]);
    game.gameData[0].sha256 = sha256(pack);
    game.gameData[0].size = pack.length;
    return pack;
  });
}

function makeEngine(api, paths, extra = {}) {
  return new Engine({
    api,
    paths,
    log: quietLogger(),
    sink: makeSink(),
    probeFree: async () => ({ freeBytes: 10 * 1024 * 1024 * 1024 }),
    retryWaitMs: 0,
    ...extra,
  }, new Catalog(api, paths, quietLogger()));
}

function configure(api, server) {
  api.prefs.gameDataSources = [{ type: 'raw', name: 'test', arguments: [`http://127.0.0.1:${server.port}/games/`] }];
}

/**
 * A server where game-1's pack starts but never finishes until the test says
 * so, and every other pack is immediate. Lets a test call the engine while a
 * transfer is in flight.
 */
async function gatedServer(games, packs) {
  const downloads = [];
  const routes = {};
  let release = () => {};
  let markStarted = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { markStarted = resolve; });

  games.forEach((game, index) => {
    const filename = gameDataFilename(game.gameData[0]);
    routes[`/games/${filename}`] = async (request, response) => {
      response.on('error', () => undefined);
      if (game.id === games[0].id) {
        markStarted();
        try {
          response.writeHead(200, { 'content-length': packs[0].length });
          response.write(packs[0].subarray(0, 4));
        } catch {
          // The client aborted before the first byte.
        }
        await gate;
        try {
          response.end(packs[0].subarray(4));
        } catch {
          // Already destroyed by the abort.
        }
        return;
      }
      downloads.push(game.id);
      response.writeHead(200, { 'content-length': packs[index].length });
      response.end(packs[index]);
    };
  });

  const server = await startServer(routes);
  return { server, downloads, started, release };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

test('cancels an in-flight pack when the launcher installs that game', async () => {
  const { paths } = tempProject();
  const games = [makeGame(1), makeGame(2)];
  const packs = packsFor(games, ['pack-one', 'pack-two']);
  const { server, downloads, started, release } = await gatedServer(games, packs);

  try {
    const api = makeApi(games);
    configure(api, server);
    writeCatalogue(paths, catalogueFrom(games));

    const engine = makeEngine(api, paths);
    await engine.start(await engine.prepare(baseSettings()));
    await started;

    // The launcher finishes its own install of game-1 while ours is in flight.
    const launcherFile = path.join(paths.dataPacksDir, gameDataFilename(games[0].gameData[0]));
    fs.writeFileSync(launcherFile, packs[0]);
    engine.noteGameInstalled('game-1');
    release();
    await engine.whenIdle();

    const snapshot = engine.snapshot();
    assert.equal(snapshot.status, 'done');
    assert.equal(snapshot.job.packsFailed, 0);
    assert.equal(snapshot.job.gamesFailed, 0);
    assert.deepEqual(downloads, ['game-2']);
    // The launcher's file is untouched and nothing was logged as a failure.
    assert.deepEqual(fs.readFileSync(launcherFile), packs[0]);
    assert.equal(fs.existsSync(paths.failuresFile), false);
    // The launcher owns the flags for game-1; Continuum did not write them.
    assert.equal(api.games.get('game-1').gameData[0].presentOnDisk, false);
  } finally {
    release();
    await server.close();
  }
});

test('skips a game later in the catalogue that the launcher installs', async () => {
  const { paths } = tempProject();
  const games = [makeGame(1), makeGame(2)];
  const packs = packsFor(games, ['pack-one', 'pack-two']);
  const { server, downloads, started, release } = await gatedServer(games, packs);

  try {
    const api = makeApi(games);
    configure(api, server);
    writeCatalogue(paths, catalogueFrom(games));

    const engine = makeEngine(api, paths);
    await engine.start(await engine.prepare(baseSettings()));
    await started;

    engine.noteGameInstalled('game-2');
    release();
    await engine.whenIdle();

    assert.deepEqual(downloads, []);
    assert.equal(fs.existsSync(path.join(paths.dataPacksDir, gameDataFilename(games[1].gameData[0]))), false);
    assert.equal(engine.snapshot().job.packsFailed, 0);
  } finally {
    release();
    await server.close();
  }
});

test('downloads a game the launcher uninstalls before its turn', async () => {
  const { paths } = tempProject();
  const games = [makeGame(1), makeGame(2)];
  const packs = packsFor(games, ['pack-one', 'pack-two']);
  const { server, downloads, started, release } = await gatedServer(games, packs);

  try {
    const api = makeApi(games);
    configure(api, server);
    writeCatalogue(paths, catalogueFrom(games));

    const engine = makeEngine(api, paths);
    await engine.start(await engine.prepare(baseSettings()));
    await started;

    engine.noteGameInstalled('game-2');
    engine.noteGameUninstalled('game-2');
    release();
    await engine.whenIdle();

    assert.deepEqual(downloads, ['game-2']);
    assert.ok(fs.existsSync(path.join(paths.dataPacksDir, gameDataFilename(games[1].gameData[0]))));
  } finally {
    release();
    await server.close();
  }
});

test('cancels a queued retry when the launcher installs that game', async () => {
  const { paths } = tempProject();
  const games = [makeGame(1)];
  const packs = packsFor(games, ['pack-one']);
  const { server, started, release } = await gatedServer(games, packs);
  const filename = gameDataFilename(games[0].gameData[0]);

  try {
    const api = makeApi(games);
    configure(api, server);
    writeCatalogue(paths, catalogueFrom(games));
    fs.writeFileSync(paths.retriesFile, JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      entries: [{
        key: `pack|game-1|${filename}`,
        kind: 'pack',
        gameId: 'game-1',
        title: 'Game 1',
        packId: 1,
        target: filename,
        sha256: games[0].gameData[0].sha256,
        size: games[0].gameData[0].size,
        attempts: 1,
        lastError: 'HTTP 500',
        firstFailedAt: new Date(Date.now() - 120_000).toISOString(),
        nextAttemptAt: new Date(Date.now() - 1000).toISOString(),
      }],
    }));

    const engine = makeEngine(api, paths);
    await engine.start(await engine.prepare(baseSettings()));
    await started;

    engine.noteGameInstalled('game-1');
    release();
    await engine.whenIdle();

    const snapshot = engine.snapshot();
    assert.equal(snapshot.status, 'done');
    assert.equal(snapshot.job.packsDone, 0);
    assert.equal(snapshot.job.packsFailed, 0);
    assert.equal(snapshot.retryPending, 0);
    assert.equal(fs.existsSync(paths.failuresFile), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.retriesFile, 'utf8')).entries, []);
  } finally {
    release();
    await server.close();
  }
});

test('drops queued retries for a game the launcher installs', async () => {
  const { paths } = tempProject();
  const api = makeApi([]);
  const engine = makeEngine(api, paths);
  await engine.loadState();

  const entry = (gameId, target, kind) => ({
    key: `${kind}|${gameId}|${target}`,
    kind,
    gameId,
    title: `Game ${gameId}`,
    target,
    attempts: 1,
    lastError: 'socket hang up',
    firstFailedAt: new Date(Date.now() - 60_000).toISOString(),
    nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
  });
  fs.writeFileSync(paths.retriesFile, JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    entries: [
      entry('game-1', 'game-1-pack.zip', 'pack'),
      entry('game-1', 'Logos/aa/game-1.png', 'image'),
      entry('game-2', 'game-2-pack.zip', 'pack'),
    ],
  }));
  await engine.loadState();
  assert.equal(engine.snapshot().retryPending, 3);

  engine.noteGameInstalled('game-1');

  const cleared = await waitFor(
    () => JSON.parse(fs.readFileSync(paths.retriesFile, 'utf8')).entries.length === 1,
  );
  assert.equal(cleared, true);
  const left = JSON.parse(fs.readFileSync(paths.retriesFile, 'utf8')).entries;
  assert.deepEqual(left.map((item) => item.gameId), ['game-2']);
  assert.equal(engine.snapshot().retryPending, 1);
});
