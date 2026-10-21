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
    includeImages: true,
    reserveBytes: 1024,
    maxBytes: 0,
    activeWorkers: 1,
    passiveWorkers: 1,
    passiveDelayMs: 0,
    respectExtremeFilter: false,
    autoResume: false,
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

function imageRoutes(routes) {
  routes['/images/Logos/aa/game-1.png'] = (request, response) => {
    response.writeHead(200, { 'content-length': 4 });
    response.end('logo');
  };
  routes['/images/Screenshots/aa/game-1.png'] = (request, response) => {
    response.writeHead(200, { 'content-length': 4 });
    response.end('shot');
  };
  routes['/images/Logos/aa/game-2.png'] = (request, response) => {
    response.writeHead(200, { 'content-length': 4 });
    response.end('logo');
  };
  routes['/images/Screenshots/aa/game-2.png'] = (request, response) => {
    response.writeHead(200, { 'content-length': 4 });
    response.end('shot');
  };
}

test('mirrors game data and images and updates the database', async () => {
  const { paths } = tempProject();
  const game = makeGame(1);
  const pack = Buffer.from('pack-one');
  game.gameData[0].sha256 = sha256(pack);
  game.gameData[0].size = pack.length;
  const filename = gameDataFilename(game.gameData[0]);

  const routes = {};
  imageRoutes(routes);
  routes[`/games/${filename}`] = (request, response) => {
    response.writeHead(200, { 'content-length': pack.length });
    response.end(pack);
  };
  const server = await startServer(routes);

  try {
    const api = makeApi([game]);
    api.prefs.onDemandBaseUrl = `http://127.0.0.1:${server.port}/images/`;
    api.prefs.gameDataSources = [{ type: 'raw', name: 'test', arguments: [`http://127.0.0.1:${server.port}/games/`] }];
    writeCatalogue(paths, catalogueFrom([game]));

    const catalog = new Catalog(api, paths, quietLogger());
    const sink = makeSink();
    const engine = new Engine({
      api,
      paths,
      log: quietLogger(),
      sink,
      probeFree: async () => ({ freeBytes: 10 * 1024 * 1024 * 1024 }),
    }, catalog);

    const prep = await engine.prepare(baseSettings());
    assert.equal(prep.estimate.packsMissing, 1);
    assert.equal(prep.fits, true);
    assert.equal(prep.warnings.length, 0);

    const start = await engine.start(prep);
    assert.equal(start.ok, true);
    await engine.whenIdle();

    const snapshot = engine.snapshot();
    assert.equal(snapshot.status, 'done');
    assert.equal(snapshot.job.packsDone, 1);
    assert.equal(snapshot.job.packsFailed, 0);
    assert.equal(snapshot.job.bytes, pack.length);
    assert.ok(fs.existsSync(path.join(paths.dataPacksDir, filename)));
    assert.equal(fs.readFileSync(path.join(paths.imagesDir, 'Logos/aa/game-1.png'), 'utf8'), 'logo');
    assert.equal(fs.readFileSync(path.join(paths.imagesDir, 'Screenshots/aa/game-1.png'), 'utf8'), 'shot');

    const stored = api.games.get('game-1');
    assert.equal(stored.gameData[0].presentOnDisk, true);
    assert.equal(stored.gameData[0].path, filename);
    assert.equal(stored.activeDataOnDisk, true);
    assert.ok(sink.tasks.some((task) => task.finished === true));
  } finally {
    await server.close();
  }
});

test('pauses instead of filling the disk', async () => {
  const { paths } = tempProject();
  const game = makeGame(1);
  game.gameData[0].sha256 = sha256(Buffer.from('x'));
  game.gameData[0].size = 5;

  const api = makeApi([game]);
  api.prefs.gameDataSources = [{ type: 'raw', name: 'test', arguments: ['http://127.0.0.1:9/games/'] }];
  writeCatalogue(paths, catalogueFrom([game]));

  const catalog = new Catalog(api, paths, quietLogger());
  const sink = makeSink();
  const engine = new Engine({
    api,
    paths,
    log: quietLogger(),
    sink,
    probeFree: async () => ({ freeBytes: 4096 }),
  }, catalog);

  const prep = await engine.prepare(baseSettings({ reserveBytes: 100_000 }));
  assert.equal(prep.fits, false);
  assert.match(prep.warnings.join(' '), /needs approximately/i);

  const start = await engine.start(prep);
  assert.equal(start.ok, true);
  await engine.whenIdle();

  const snapshot = engine.snapshot();
  assert.equal(snapshot.status, 'paused');
  assert.equal(snapshot.job.packsDone, 0);
  assert.match(snapshot.job.message, /free/i);
  assert.equal(sink.notices.length, 1);
  assert.equal(fs.existsSync(path.join(paths.dataPacksDir, gameDataFilename(game.gameData[0]))), false);
});

test('resumes where it stopped without skipping a game', async () => {
  const { paths } = tempProject();
  const games = [makeGame(1), makeGame(2)];
  const packs = [Buffer.from('first-pack'), Buffer.from('second-pack')];
  games.forEach((game, index) => {
    game.gameData[0].sha256 = sha256(packs[index]);
    game.gameData[0].size = packs[index].length;
  });

  const routes = {};
  imageRoutes(routes);
  games.forEach((game, index) => {
    const filename = gameDataFilename(game.gameData[0]);
    routes[`/games/${filename}`] = (request, response) => {
      response.writeHead(200, { 'content-length': packs[index].length });
      response.end(packs[index]);
    };
  });
  const server = await startServer(routes);

  try {
    const api = makeApi(games);
    api.prefs.onDemandBaseUrl = `http://127.0.0.1:${server.port}/images/`;
    api.prefs.gameDataSources = [{ type: 'raw', name: 'test', arguments: [`http://127.0.0.1:${server.port}/games/`] }];
    writeCatalogue(paths, catalogueFrom(games));

    const catalog = new Catalog(api, paths, quietLogger());
    const firstEngine = new Engine({
      api,
      paths,
      log: quietLogger(),
      sink: makeSink(),
      probeFree: async () => ({ freeBytes: 10 * 1024 * 1024 * 1024 }),
    }, catalog);

    const firstPrep = await firstEngine.prepare(baseSettings({ maxBytes: packs[0].length }));
    await firstEngine.start(firstPrep);
    await firstEngine.whenIdle();

    const firstSnapshot = firstEngine.snapshot();
    assert.equal(firstSnapshot.status, 'stopped');
    assert.equal(firstSnapshot.job.packsDone, 1);
    assert.ok(firstSnapshot.job.cursor > 0);
    const secondFile = path.join(paths.dataPacksDir, gameDataFilename(games[1].gameData[0]));
    assert.equal(fs.existsSync(secondFile), false);

    const secondEngine = new Engine({
      api,
      paths,
      log: quietLogger(),
      sink: makeSink(),
      probeFree: async () => ({ freeBytes: 10 * 1024 * 1024 * 1024 }),
    }, catalog);
    const secondPrep = await secondEngine.prepare(baseSettings({ maxBytes: 0 }));
    assert.equal(secondPrep.resumable, true);
    await secondEngine.start(secondPrep);
    await secondEngine.whenIdle();

    assert.equal(secondEngine.snapshot().status, 'done');
    assert.ok(fs.existsSync(secondFile));
  } finally {
    await server.close();
  }
});

test('records a pack failure and keeps going', async () => {
  const { paths } = tempProject();
  const game = makeGame(1);
  game.gameData[0].sha256 = sha256(Buffer.from('expected'));
  game.gameData[0].size = 8;
  const filename = gameDataFilename(game.gameData[0]);

  const routes = {
    [`/games/${filename}`]: (request, response) => {
      response.writeHead(200, { 'content-length': 5 });
      response.end('wrong');
    },
  };
  const server = await startServer(routes);

  try {
    const api = makeApi([game]);
    api.prefs.onDemandBaseUrl = '';
    api.prefs.gameDataSources = [{ type: 'raw', name: 'test', arguments: [`http://127.0.0.1:${server.port}/games/`] }];
    writeCatalogue(paths, catalogueFrom([game]));

    const catalog = new Catalog(api, paths, quietLogger());
    const engine = new Engine({
      api,
      paths,
      log: quietLogger(),
      sink: makeSink(),
      probeFree: async () => ({ freeBytes: 10 * 1024 * 1024 * 1024 }),
    }, catalog);

    await engine.start(await engine.prepare(baseSettings({ includeImages: false })));
    await engine.whenIdle();

    const snapshot = engine.snapshot();
    assert.equal(snapshot.status, 'done');
    assert.equal(snapshot.job.packsFailed, 1);
    assert.equal(snapshot.job.gamesFailed, 1);
    assert.equal(fs.existsSync(path.join(paths.dataPacksDir, filename)), false);
    const failures = fs.readFileSync(paths.failuresFile, 'utf8').trim().split('\n');
    assert.equal(failures.length, 1);
    assert.equal(JSON.parse(failures[0]).kind, 'pack');
  } finally {
    await server.close();
  }
});
