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

/** Give each game a distinct pack and return the payloads. */
function packsFor(games, labels) {
  return games.map((game, index) => {
    const pack = Buffer.from(labels[index]);
    game.gameData[0].sha256 = sha256(pack);
    game.gameData[0].size = pack.length;
    return pack;
  });
}

/**
 * Routes that record each pack that is actually downloaded. `override` gets
 * (request, response, respond) so a test can delay a download and then finish it.
 */
function routesFor(games, packs, downloads, override = {}) {
  const routes = {};
  games.forEach((game, index) => {
    const filename = gameDataFilename(game.gameData[0]);
    routes[`/games/${filename}`] = (request, response) => {
      const respond = () => {
        downloads.push(game.id);
        response.writeHead(200, { 'content-length': packs[index].length });
        response.end(packs[index]);
      };
      if (override[game.id]) {
        override[game.id](request, response, respond);
        return;
      }
      respond();
    };
  });
  return routes;
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

test('downloads playlist games before the rest of the catalogue', async () => {
  const { paths } = tempProject();
  const games = [makeGame(1), makeGame(2), makeGame(3)];
  const packs = packsFor(games, ['pack-one', 'pack-two', 'pack-three']);
  const downloads = [];
  const server = await startServer(routesFor(games, packs, downloads));

  try {
    const api = makeApi(games);
    configure(api, server);
    api.playlists.push({ id: 'faves', title: 'Faves', games: [{ gameId: 'game-3' }] });
    writeCatalogue(paths, catalogueFrom(games));

    // Count flag writes too: the main pass must not write them again for the
    // game the priority queue already installed.
    let flagWrites = 0;
    const save = api.saveGameData;
    api.saveGameData = async (data) => {
      flagWrites += 1;
      return save(data);
    };

    const engine = makeEngine(api, paths);
    await engine.start(await engine.prepare(baseSettings({ prioritizePlaylists: true })));
    await engine.whenIdle();

    assert.deepEqual(downloads, ['game-3', 'game-1', 'game-2']);
    assert.equal(flagWrites, 3);
    const snapshot = engine.snapshot();
    assert.equal(snapshot.status, 'done');
    assert.equal(snapshot.job.packsDone, 3);
    assert.deepEqual(snapshot.job.priority.ids, ['game-3']);
    assert.equal(snapshot.job.priority.cursor, 1);
  } finally {
    await server.close();
  }
});

test('keeps catalogue order when the setting is off', async () => {
  const { paths } = tempProject();
  const games = [makeGame(1), makeGame(2), makeGame(3)];
  const packs = packsFor(games, ['pack-one', 'pack-two', 'pack-three']);
  const downloads = [];
  const server = await startServer(routesFor(games, packs, downloads));

  try {
    const api = makeApi(games);
    configure(api, server);
    api.playlists.push({ id: 'faves', title: 'Faves', games: [{ gameId: 'game-3' }] });
    writeCatalogue(paths, catalogueFrom(games));

    const engine = makeEngine(api, paths);
    await engine.start(await engine.prepare(baseSettings({ prioritizePlaylists: false })));
    await engine.whenIdle();

    assert.deepEqual(downloads, ['game-1', 'game-2', 'game-3']);
    assert.equal(engine.snapshot().job.priority, undefined);
  } finally {
    await server.close();
  }
});

test('priority never pulls a game outside the scope in', async () => {
  const { paths } = tempProject();
  const games = [makeGame(1), makeGame(2), makeGame(3)];
  const packs = packsFor(games, ['pack-one', 'pack-two', 'pack-three']);
  const downloads = [];
  const server = await startServer(routesFor(games, packs, downloads));

  try {
    const api = makeApi(games);
    configure(api, server);
    // game-1 and game-3 are HTML5, game-2 is Flash.
    api.playlists.push({ id: 'faves', title: 'Faves', games: [{ gameId: 'game-1' }, { gameId: 'game-3' }] });
    writeCatalogue(paths, catalogueFrom(games));

    const engine = makeEngine(api, paths);
    await engine.start(await engine.prepare(baseSettings({
      scope: { kind: 'platform', value: 'Flash' },
      prioritizePlaylists: true,
    })));
    await engine.whenIdle();

    assert.deepEqual(downloads, ['game-2']);
    assert.equal(engine.snapshot().job.packsDone, 1);
    assert.equal(fs.existsSync(path.join(paths.dataPacksDir, gameDataFilename(games[0].gameData[0]))), false);
    assert.equal(fs.existsSync(path.join(paths.dataPacksDir, gameDataFilename(games[2].gameData[0]))), false);
  } finally {
    await server.close();
  }
});

test('resumes the priority plan instead of starting it over', async () => {
  const { paths } = tempProject();
  const games = [makeGame(1), makeGame(2), makeGame(3)];
  const packs = packsFor(games, ['pack-one', 'pack-two', 'pack-three']);
  const downloads = [];
  const server = await startServer(routesFor(games, packs, downloads));

  try {
    const api = makeApi(games);
    configure(api, server);
    api.playlists.push({ id: 'faves', title: 'Faves', games: [{ gameId: 'game-3' }] });
    writeCatalogue(paths, catalogueFrom(games));

    const engine = makeEngine(api, paths);

    // The limit equals one pack, so the job stops right after the playlist game.
    await engine.start(await engine.prepare(baseSettings({
      prioritizePlaylists: true,
      maxBytes: packs[2].length,
    })));
    await engine.whenIdle();

    const first = engine.snapshot();
    assert.equal(first.status, 'stopped');
    assert.equal(first.job.priority.cursor, 1);
    assert.deepEqual(downloads, ['game-3']);

    // The game that hit the limit stays pinned, so it is retried on resume.
    downloads.length = 0;
    await engine.start(await engine.prepare(baseSettings({ prioritizePlaylists: true })));
    await engine.whenIdle();

    assert.deepEqual(downloads, ['game-1', 'game-2']);
    assert.equal(engine.snapshot().status, 'done');
  } finally {
    await server.close();
  }
});

test('a game added to a playlist mid-run jumps ahead', async () => {
  const { paths } = tempProject();
  const games = [makeGame(1), makeGame(2), makeGame(3)];
  const packs = packsFor(games, ['pack-one', 'pack-two', 'pack-three']);

  let releaseFirst = () => {};
  let markStarted = () => {};
  const started = new Promise((resolve) => { markStarted = resolve; });
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const downloads = [];
  const slowFirst = async (request, response, respond) => {
    markStarted();
    await gate;
    respond();
  };
  const server = await startServer(routesFor(games, packs, downloads, { 'game-1': slowFirst }));

  try {
    const api = makeApi(games);
    configure(api, server);
    writeCatalogue(paths, catalogueFrom(games));

    let enabled = false;
    const engine = makeEngine(api, paths, {
      readPrioritize: () => enabled,
      priorityRefreshMs: 0,
    });

    await engine.start(await engine.prepare(baseSettings({ prioritizePlaylists: false })));
    await started;

    // Switch it on and add a playlist game while game-1 is still downloading.
    enabled = true;
    api.playlists.push({ id: 'faves', title: 'Faves', games: [{ gameId: 'game-3' }] });
    releaseFirst();

    await engine.whenIdle();

    assert.deepEqual(downloads, ['game-1', 'game-3', 'game-2']);
    assert.deepEqual(engine.snapshot().job.priority.ids, ['game-3']);
  } finally {
    await server.close();
  }
});

test('keeps job.json small when a playlist is enormous', async () => {
  const { paths } = tempProject();
  const game = makeGame(1);
  const packs = packsFor([game], ['only-pack']);
  const downloads = [];
  const server = await startServer(routesFor([game], packs, downloads));

  try {
    const api = makeApi([game]);
    configure(api, server);
    // 5,001 ids, none of them in the catalogue: the plan is huge, the job is not.
    api.playlists.push({
      id: 'huge',
      title: 'Huge',
      games: Array.from({ length: 5001 }, (_, index) => ({ gameId: `absent-${index}` })),
    });
    writeCatalogue(paths, catalogueFrom([game]));

    const engine = makeEngine(api, paths);
    await engine.start(await engine.prepare(baseSettings({ prioritizePlaylists: true })));
    await engine.whenIdle();

    assert.deepEqual(downloads, ['game-1']);
    const saved = JSON.parse(fs.readFileSync(paths.jobFile, 'utf8'));
    assert.equal(saved.priority.ids.length, 5000);
    // The running plan still knows about all of them.
    assert.equal(engine.snapshot().job.priority.ids.length, 5001);
  } finally {
    await server.close();
  }
});

test('never downloads a priority game twice when several workers run', async () => {
  const { paths } = tempProject();
  const games = [makeGame(1), makeGame(2)];
  const packs = packsFor(games, ['pack-one', 'pack-two']);
  const requests = [];

  let release = () => {};
  let markStarted = () => {};
  const started = new Promise((resolve) => { markStarted = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const routes = {};
  games.forEach((game, index) => {
    const filename = gameDataFilename(game.gameData[0]);
    routes[`/games/${filename}`] = async (request, response) => {
      requests.push(game.id);
      response.on('error', () => undefined);
      if (game.id === 'game-1') {
        markStarted();
        response.writeHead(200, { 'content-length': packs[0].length });
        response.write(packs[0].subarray(0, 4));
        await gate;
        try {
          response.end(packs[0].subarray(4));
        } catch {
          // Client aborted.
        }
        return;
      }
      response.writeHead(200, { 'content-length': packs[index].length });
      response.end(packs[index]);
    };
  });
  const server = await startServer(routes);

  try {
    const api = makeApi(games);
    configure(api, server);
    api.playlists.push({ id: 'faves', title: 'Faves', games: [{ gameId: 'game-1' }] });
    writeCatalogue(paths, catalogueFrom(games));

    const engine = makeEngine(api, paths);
    await engine.start(await engine.prepare(baseSettings({
      prioritizePlaylists: true,
      activeWorkers: 2,
    })));
    await started;

    // The second worker must move on to game-2 instead of fetching game-1 too.
    const deadline = Date.now() + 2000;
    while (!requests.includes('game-2') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    release();
    await engine.whenIdle();

    assert.equal(requests.filter((id) => id === 'game-1').length, 1);
    assert.equal(requests.filter((id) => id === 'game-2').length, 1);
    assert.equal(engine.snapshot().job.packsDone, 2);
  } finally {
    release();
    await server.close();
  }
});

test('switching the setting off mid-run stops new playlist games jumping ahead', async () => {
  const { paths } = tempProject();
  const games = [makeGame(1), makeGame(2), makeGame(3)];
  const packs = packsFor(games, ['pack-one', 'pack-two', 'pack-three']);

  let releaseFirst = () => {};
  let markStarted = () => {};
  const started = new Promise((resolve) => { markStarted = resolve; });
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const downloads = [];
  // The first priority download is game-2, so hold that one open.
  const slowPriority = async (request, response, respond) => {
    markStarted();
    await gate;
    respond();
  };
  const server = await startServer(routesFor(games, packs, downloads, { 'game-2': slowPriority }));

  try {
    const api = makeApi(games);
    configure(api, server);
    api.playlists.push({ id: 'faves', title: 'Faves', games: [{ gameId: 'game-2' }] });
    writeCatalogue(paths, catalogueFrom(games));

    let enabled = true;
    const engine = makeEngine(api, paths, {
      readPrioritize: () => enabled,
      priorityRefreshMs: 0,
    });

    await engine.start(await engine.prepare(baseSettings({ prioritizePlaylists: true })));
    await started;

    // While game-2 downloads, switch it off and add game-3 to the playlist.
    enabled = false;
    api.playlists[0].games.push({ gameId: 'game-3' });
    releaseFirst();
    await engine.whenIdle();

    // With the switch still on, game-3 would have come second.
    assert.deepEqual(downloads, ['game-2', 'game-1', 'game-3']);
  } finally {
    await server.close();
  }
});
