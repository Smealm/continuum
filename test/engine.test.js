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
    respectFlashpointSettings: false,
    autoMirror: false,
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

test('repairs a pack that is on disk but not marked in the database', async () => {
  const { paths } = tempProject();
  const game = makeGame(1);
  const pack = Buffer.from('already-here');
  game.gameData[0].sha256 = sha256(pack);
  game.gameData[0].size = pack.length;
  const filename = gameDataFilename(game.gameData[0]);
  fs.writeFileSync(path.join(paths.dataPacksDir, filename), pack);

  const api = makeApi([game]);
  api.prefs.gameDataSources = [{ type: 'raw', name: 'test', arguments: ['http://127.0.0.1:9/games/'] }];
  writeCatalogue(paths, catalogueFrom([game]));

  const engine = new Engine({
    api,
    paths,
    log: quietLogger(),
    sink: makeSink(),
    probeFree: async () => ({ freeBytes: 10 * 1024 * 1024 * 1024 }),
    retryWaitMs: 0,
  }, new Catalog(api, paths, quietLogger()));

  await engine.start(await engine.prepare(baseSettings({ includeImages: false })));
  await engine.whenIdle();

  const snapshot = engine.snapshot();
  assert.equal(snapshot.status, 'done');
  assert.equal(snapshot.job.packsDone, 0);
  assert.equal(snapshot.job.packsFailed, 0);
  assert.equal(snapshot.job.gamesDone, 1);
  assert.equal(api.games.get('game-1').gameData[0].presentOnDisk, true);
  assert.equal(api.games.get('game-1').gameData[0].path, filename);
});

test('a finished download with a failed flag write is not a pack failure', async () => {
  const { paths } = tempProject();
  const game = makeGame(1);
  const pack = Buffer.from('flag-pack');
  game.gameData[0].sha256 = sha256(pack);
  game.gameData[0].size = pack.length;
  const filename = gameDataFilename(game.gameData[0]);

  const server = await startServer({
    [`/games/${filename}`]: (request, response) => {
      response.writeHead(200, { 'content-length': pack.length });
      response.end(pack);
    },
  });

  try {
    const api = makeApi([game]);
    api.prefs.gameDataSources = [{ type: 'raw', name: 'test', arguments: [`http://127.0.0.1:${server.port}/games/`] }];
    api.saveGameData = async () => {
      throw new Error('SQLite error: no such table: game_data');
    };
    writeCatalogue(paths, catalogueFrom([game]));

    const engine = new Engine({
      api,
      paths,
      log: quietLogger(),
      sink: makeSink(),
      probeFree: async () => ({ freeBytes: 10 * 1024 * 1024 * 1024 }),
      retryWaitMs: 0,
    }, new Catalog(api, paths, quietLogger()));

    await engine.start(await engine.prepare(baseSettings({ includeImages: false })));
    await engine.whenIdle();

    const snapshot = engine.snapshot();
    assert.equal(snapshot.status, 'done');
    assert.equal(snapshot.job.packsDone, 1);
    assert.equal(snapshot.job.packsFailed, 0);
    assert.equal(snapshot.job.gamesFailed, 0);
    assert.equal(snapshot.job.packFlagsFailed, 1);
    assert.equal(snapshot.retryPending, 0);
    assert.ok(fs.existsSync(path.join(paths.dataPacksDir, filename)));

    const audit = fs.readFileSync(paths.failuresFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(audit.length, 1);
    assert.equal(audit[0].kind, 'flag');
    assert.equal(audit[0].packId, 1);
  } finally {
    await server.close();
  }
});

test('the next pass repairs the flag and resets the flag-failure counter', async () => {
  const { paths } = tempProject();
  const game = makeGame(1);
  const pack = Buffer.from('repair-me');
  game.gameData[0].sha256 = sha256(pack);
  game.gameData[0].size = pack.length;
  const filename = gameDataFilename(game.gameData[0]);

  const server = await startServer({
    [`/games/${filename}`]: (request, response) => {
      response.writeHead(200, { 'content-length': pack.length });
      response.end(pack);
    },
  });

  try {
    const api = makeApi([game]);
    api.prefs.gameDataSources = [{ type: 'raw', name: 'test', arguments: [`http://127.0.0.1:${server.port}/games/`] }];
    const save = api.saveGameData;
    api.saveGameData = async () => {
      throw new Error('SQLite error: no such table: game_data');
    };
    writeCatalogue(paths, catalogueFrom([game]));

    const engine = new Engine({
      api,
      paths,
      log: quietLogger(),
      sink: makeSink(),
      probeFree: async () => ({ freeBytes: 10 * 1024 * 1024 * 1024 }),
      retryWaitMs: 0,
    }, new Catalog(api, paths, quietLogger()));

    await engine.start(await engine.prepare(baseSettings({ includeImages: false })));
    await engine.whenIdle();
    assert.equal(engine.snapshot().job.packFlagsFailed, 1);
    assert.equal(api.games.get('game-1').gameData[0].presentOnDisk, false);

    api.saveGameData = save;
    await engine.start(await engine.prepare(baseSettings({ includeImages: false })));
    await engine.whenIdle();

    const snapshot = engine.snapshot();
    assert.equal(snapshot.status, 'done');
    assert.equal(snapshot.job.packFlagsFailed, 0);
    // The counter is cumulative (one pack from the first run), but this pass
    // only repaired the flag: no new bytes were transferred.
    assert.equal(snapshot.job.packsDone, 1);
    assert.equal(snapshot.progress.sessionBytes, 0);
    assert.equal(api.games.get('game-1').gameData[0].presentOnDisk, true);
    assert.equal(api.games.get('game-1').gameData[0].path, filename);
  } finally {
    await server.close();
  }
});

test('retries a locked flag write instead of reporting a failure', async () => {
  const { paths } = tempProject();
  const game = makeGame(1);
  const pack = Buffer.from('locked-pack');
  game.gameData[0].sha256 = sha256(pack);
  game.gameData[0].size = pack.length;
  const filename = gameDataFilename(game.gameData[0]);

  const server = await startServer({
    [`/games/${filename}`]: (request, response) => {
      response.writeHead(200, { 'content-length': pack.length });
      response.end(pack);
    },
  });

  try {
    const api = makeApi([game]);
    api.prefs.gameDataSources = [{ type: 'raw', name: 'test', arguments: [`http://127.0.0.1:${server.port}/games/`] }];
    const save = api.saveGameData;
    let attempts = 0;
    api.saveGameData = async (data) => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error('SQLite error: database is locked');
      }
      return save(data);
    };
    writeCatalogue(paths, catalogueFrom([game]));

    const engine = new Engine({
      api,
      paths,
      log: quietLogger(),
      sink: makeSink(),
      probeFree: async () => ({ freeBytes: 10 * 1024 * 1024 * 1024 }),
      retryWaitMs: 0,
    }, new Catalog(api, paths, quietLogger()));

    await engine.start(await engine.prepare(baseSettings({ includeImages: false })));
    await engine.whenIdle();

    const snapshot = engine.snapshot();
    assert.equal(attempts, 3);
    assert.equal(snapshot.job.packFlagsFailed, 0);
    assert.equal(snapshot.job.packsFailed, 0);
    assert.equal(api.games.get('game-1').gameData[0].presentOnDisk, true);
    assert.equal(fs.existsSync(paths.failuresFile), false);
  } finally {
    await server.close();
  }
});

test('retries a queued pack before walking the catalogue', async () => {
  const { paths } = tempProject();
  const game = makeGame(1);
  const pack = Buffer.from('retry-pack');
  game.gameData[0].sha256 = sha256(pack);
  game.gameData[0].size = pack.length;
  const data = game.gameData[0];
  const filename = gameDataFilename(data);

  const server = await startServer({
    [`/games/${filename}`]: (request, response) => {
      response.writeHead(200, { 'content-length': pack.length });
      response.end(pack);
    },
  });

  try {
    const api = makeApi([game]);
    api.prefs.gameDataSources = [{ type: 'raw', name: 'test', arguments: [`http://127.0.0.1:${server.port}/games/`] }];
    // The catalogue has no packs, so only the retry queue can fetch this file.
    const record = catalogueFrom([game])[0];
    record.data = [];
    writeCatalogue(paths, [record]);

    fs.writeFileSync(paths.retriesFile, JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      entries: [{
        key: `pack|game-1|${filename}`,
        kind: 'pack',
        gameId: 'game-1',
        title: 'Game 1',
        packId: data.id,
        target: filename,
        sha256: data.sha256,
        size: data.size,
        attempts: 1,
        lastError: 'HTTP 500',
        firstFailedAt: new Date(Date.now() - 120_000).toISOString(),
        nextAttemptAt: new Date(Date.now() - 1000).toISOString(),
      }],
    }));

    const engine = new Engine({
      api,
      paths,
      log: quietLogger(),
      sink: makeSink(),
      probeFree: async () => ({ freeBytes: 10 * 1024 * 1024 * 1024 }),
      retryWaitMs: 0,
    }, new Catalog(api, paths, quietLogger()));

    await engine.start(await engine.prepare(baseSettings({ includeImages: false })));
    await engine.whenIdle();

    const snapshot = engine.snapshot();
    assert.equal(snapshot.status, 'done');
    assert.equal(snapshot.job.packsDone, 1);
    assert.equal(snapshot.job.packsFailed, 0);
    assert.equal(snapshot.retryPending, 0);
    assert.deepEqual(fs.readFileSync(path.join(paths.dataPacksDir, filename)), pack);
    assert.equal(api.games.get('game-1').gameData[0].presentOnDisk, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.retriesFile, 'utf8')).entries, []);
  } finally {
    await server.close();
  }
});

test('does not queue a missing file for retry', async () => {
  const { paths } = tempProject();
  const game = makeGame(1);
  game.gameData[0].sha256 = sha256(Buffer.from('never-served'));
  game.gameData[0].size = 12;

  const server = await startServer({});

  try {
    const api = makeApi([game]);
    api.prefs.gameDataSources = [{ type: 'raw', name: 'test', arguments: [`http://127.0.0.1:${server.port}/games/`] }];
    writeCatalogue(paths, catalogueFrom([game]));

    const engine = new Engine({
      api,
      paths,
      log: quietLogger(),
      sink: makeSink(),
      probeFree: async () => ({ freeBytes: 10 * 1024 * 1024 * 1024 }),
      retryWaitMs: 0,
    }, new Catalog(api, paths, quietLogger()));

    await engine.start(await engine.prepare(baseSettings({ includeImages: false })));
    await engine.whenIdle();

    const snapshot = engine.snapshot();
    assert.equal(snapshot.job.packsFailed, 1);
    assert.equal(snapshot.retryPending, 0);
    if (fs.existsSync(paths.retriesFile)) {
      assert.deepEqual(JSON.parse(fs.readFileSync(paths.retriesFile, 'utf8')).entries, []);
    }
  } finally {
    await server.close();
  }
});

function makeEngine(api, paths, deps = {}) {
  return new Engine({
    api,
    paths,
    log: quietLogger(),
    sink: makeSink(),
    probeFree: async () => ({ freeBytes: 10 * 1024 * 1024 * 1024 }),
    retryWaitMs: 0,
    ...deps,
  }, new Catalog(api, paths, quietLogger()));
}

async function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

test('smallest games first finishes more games sooner, in catalogue order on request', async () => {
  for (const order of ['smallest', 'catalogue']) {
    const { paths } = tempProject();
    const sizes = [300, 10, 100];
    const games = sizes.map((size, index) => {
      const game = makeGame(index + 1);
      const pack = Buffer.alloc(size, index + 1);
      game.gameData[0].sha256 = sha256(pack);
      game.gameData[0].size = pack.length;
      return { game, pack };
    });

    const requested = [];
    const routes = {};
    for (const { game, pack } of games) {
      routes[`/games/${gameDataFilename(game.gameData[0])}`] = (request, response) => {
        requested.push(game.id);
        response.writeHead(200, { 'content-length': pack.length });
        response.end(pack);
      };
    }
    const server = await startServer(routes);

    try {
      const api = makeApi(games.map((entry) => entry.game));
      api.prefs.gameDataSources = [{ type: 'raw', name: 'test', arguments: [`http://127.0.0.1:${server.port}/games/`] }];
      writeCatalogue(paths, catalogueFrom(games.map((entry) => entry.game)));

      const engine = makeEngine(api, paths, { orderWindowSize: 500 });
      await engine.start(await engine.prepare(baseSettings({ includeImages: false, order })));
      await engine.whenIdle();

      assert.equal(engine.snapshot().status, 'done');
      assert.deepEqual(
        requested,
        order === 'smallest' ? ['game-2', 'game-3', 'game-1'] : ['game-1', 'game-2', 'game-3'],
        `order: ${order}`,
      );
    } finally {
      await server.close();
    }
  }
});

test('a refusal from the archive host stops the job at once and is recorded', async () => {
  const { paths } = tempProject();
  const games = [1, 2, 3].map((index) => {
    const game = makeGame(index);
    game.gameData[0].sha256 = sha256(Buffer.from(`pack-${index}`));
    game.gameData[0].size = 64;
    return game;
  });

  let requests = 0;
  const server = await startServer({
    '*': (request, response) => {
      requests += 1;
      response.writeHead(403, { 'content-type': 'text/plain' });
      response.end('not allowed');
    },
  });

  try {
    const api = makeApi(games);
    api.prefs.gameDataSources = [{ type: 'raw', name: 'test', arguments: [`http://127.0.0.1:${server.port}/games/`] }];
    writeCatalogue(paths, catalogueFrom(games));

    const engine = makeEngine(api, paths);
    await engine.start(await engine.prepare(baseSettings({ includeImages: false, activeWorkers: 1 })));
    await engine.whenIdle();

    const snapshot = engine.snapshot();
    assert.equal(snapshot.status, 'error');
    assert.match(snapshot.job.message, /refused access/);
    assert.match(snapshot.job.message, /403/);
    assert.equal(requests, 1, 'no retry and no other game after a refusal');
    assert.equal(snapshot.job.packsFailed, 0, 'a refusal is not a failed download');
    assert.equal(snapshot.retryPending, 0);

    const { readDenial } = require('../dist/core/permission.js');
    const denied = await readDenial(paths.deniedFile);
    assert.equal(denied.status, 403);
    assert.match(denied.url, /\/games\//);
  } finally {
    await server.close();
  }
});

test('adaptive parallelism starts narrow, reports its ceiling and stops cleanly', async () => {
  const { paths } = tempProject();
  const game = makeGame(1);
  const pack = Buffer.from('slow-pack');
  game.gameData[0].sha256 = sha256(pack);
  game.gameData[0].size = pack.length;
  const filename = gameDataFilename(game.gameData[0]);

  let release = null;
  const server = await startServer({
    [`/games/${filename}`]: (request, response) => {
      release = () => {
        response.writeHead(200, { 'content-length': pack.length });
        response.end(pack);
      };
    },
  });

  try {
    const api = makeApi([game]);
    api.prefs.gameDataSources = [{ type: 'raw', name: 'test', arguments: [`http://127.0.0.1:${server.port}/games/`] }];
    writeCatalogue(paths, catalogueFrom([game]));

    const engine = makeEngine(api, paths);
    await engine.start(await engine.prepare(baseSettings({
      includeImages: false,
      activeWorkers: 6,
      adaptiveWorkers: true,
    })));

    assert.ok(await waitFor(() => release !== null), 'the pack request should arrive');
    const running = engine.snapshot();
    assert.deepEqual(running.workers, { limit: 2, ceiling: 6, inFlight: 1 });

    release();
    await engine.whenIdle();
    assert.equal(engine.snapshot().status, 'done');
    assert.equal(engine.snapshot().workers, null, 'no controller is left after the run');
  } finally {
    await server.close();
  }
});
