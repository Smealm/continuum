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
    // The first pass reached the end of the catalogue, so this is a fresh pass
    // and its counters start again from zero. It only repaired the flag: no
    // bytes were transferred and no pack was downloaded.
    assert.equal(snapshot.job.packsDone, 0);
    assert.equal(snapshot.progress.sessionBytes, 0);
    assert.equal(snapshot.progress.doneBytes, 0);
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

      const engine = makeEngine(api, paths, {});
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

test('smallest-first sorts the whole catalogue, not just the first few hundred games', async () => {
  const { paths } = tempProject();
  const total = 520;
  const games = [];
  for (let index = 1; index <= total; index += 1) {
    const game = makeGame(index);
    // Everything is the same size except the very last catalogue record, which
    // is the smallest. The old 500-record window could not see it yet and would
    // start with game-1 instead.
    const size = index === total ? 1 : 1000;
    const pack = Buffer.alloc(size, index % 250);
    game.gameData[0].sha256 = sha256(pack);
    game.gameData[0].size = pack.length;
    games.push({ game, pack });
  }

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

    const engine = makeEngine(api, paths);
    await engine.start(await engine.prepare(baseSettings({ includeImages: false, order: 'smallest' })));
    await engine.whenIdle();

    assert.equal(requested.length, total);
    assert.equal(requested[0], `game-${total}`, 'the smallest game anywhere in the catalogue goes first');
    assert.equal(requested[requested.length - 1], 'game-519');
    assert.equal(new Set(requested).size, total, 'every game is downloaded once');

    const saved = JSON.parse(fs.readFileSync(paths.jobFile, 'utf8'));
    assert.equal(saved.order.total, total);
    assert.equal(saved.order.cursor, total, 'the queue position is saved');
  } finally {
    await server.close();
  }
});

test('a saved smallest-first position resumes the queue where it stopped', async () => {
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

    // A job that already finished the smallest game (game-2) and stopped.
    fs.writeFileSync(paths.jobFile, JSON.stringify({
      version: 1,
      generation: 'gen-1',
      scopeKey: 'all:|images=0',
      mode: 'active',
      cursor: 0,
      bytes: 10,
      packsDone: 1,
      packsFailed: 0,
      gamesDone: 1,
      gamesFailed: 0,
      imagesDone: 0,
      status: 'stopped',
      message: 'Stopped.',
      updatedAt: new Date('2024-01-01T00:00:00.000Z').toISOString(),
      order: { generation: 'gen-1', scopeKey: 'all:|images=0', cursor: 1, total: 3 },
    }));

    const engine = makeEngine(api, paths);
    await engine.start(await engine.prepare(baseSettings({ includeImages: false, order: 'smallest' })));
    await engine.whenIdle();

    assert.deepEqual(requested, ['game-3', 'game-1'], 'the finished game is not downloaded again');
  } finally {
    await server.close();
  }
});

test('a short probe warms the peak the ETA and worker count aim at', async () => {
  const { paths } = tempProject();
  const game = makeGame(1);
  const pack = Buffer.from('probe-pack');
  game.gameData[0].sha256 = sha256(pack);
  // Large enough to be worth probing, even though the test body is short.
  game.gameData[0].size = 20 * 1024 * 1024;
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
    writeCatalogue(paths, catalogueFrom([game]));

    const probed = [];
    const engine = makeEngine(api, paths, {
      probeSpeed: async (url) => {
        probed.push(url);
        return {
          bytes: 30 * 1024 * 1024,
          elapsedMs: 4000,
          bytesPerSecond: 7_500_000,
          stopped: 'plateau',
        };
      },
    });

    await engine.start(await engine.prepare(baseSettings({
      includeImages: false,
      order: 'smallest',
      adaptiveWorkers: true,
      activeWorkers: 4,
    })));
    assert.ok(await waitFor(() => probed.length === 1), 'the probe should run once at the start');
    await engine.whenIdle();

    assert.ok(probed[0].endsWith(filename), probed[0]);
    assert.ok(
      await waitFor(() => engine.snapshot().progress.peakBytesPerSecond >= 7_500_000),
      `peak was ${engine.snapshot().progress.peakBytesPerSecond}`,
    );
  } finally {
    await server.close();
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

test('a probed link keeps the width climbing through a wall of tiny games', async () => {
  const { paths } = tempProject();
  // Seven 11-byte packs are the wall the queue actually downloads; the eighth
  // is the large pending pack the probe picks up. Its size is what makes it a
  // candidate; the probe itself is stubbed, so it still only measures.
  const games = [1, 2, 3, 4, 5, 6, 7].map((index) => {
    const game = makeGame(index);
    const pack = Buffer.from(`tiny-pack-${index}`);
    game.gameData[0].sha256 = sha256(pack);
    game.gameData[0].size = pack.length;
    return { game, pack };
  });
  const large = makeGame(8);
  const largepack = Buffer.alloc(20 * 1024 * 1024, 7);
  large.gameData[0].sha256 = sha256(largepack);
  large.gameData[0].size = largepack.length;
  games.push({ game: large, pack: largepack });

  const server = await startServer({
    '*': (request, response, url) => {
      const match = games.find(({ game }) => `/${gameDataFilename(game.gameData[0])}` === url.pathname
        || url.pathname.endsWith(`/${gameDataFilename(game.gameData[0])}`));
      // A wall of 120 KB-class downloads: each request costs latency, so the
      // byte rate stays tiny however fast the link is.
      setTimeout(() => {
        response.writeHead(200, { 'content-length': match ? match.pack.length : 0 });
        response.end(match ? match.pack : '');
      }, 200);
    },
  });

  try {
    const api = makeApi(games.map(({ game }) => game));
    api.prefs.gameDataSources = [{ type: 'raw', name: 'test', arguments: [`http://127.0.0.1:${server.port}/games/`] }];
    writeCatalogue(paths, catalogueFrom(games.map(({ game }) => game)));

    const engine = makeEngine(api, paths, {
      adaptIntervalMs: 50,
      probeSpeed: async () => ({
        bytes: 30 * 1024 * 1024,
        elapsedMs: 4000,
        bytesPerSecond: 8_000_000,
        stopped: 'plateau',
      }),
    });

    await engine.start(await engine.prepare(baseSettings({
      includeImages: false,
      order: 'smallest',
      adaptiveWorkers: true,
      activeWorkers: 4,
    })));

    assert.ok(
      await waitFor(() => engine.snapshot().workers?.limit === 4),
      `the probed 8 MB/s should widen the job past the start width: ${JSON.stringify(engine.snapshot())}`,
    );
    await engine.whenIdle();

    const snapshot = engine.snapshot();
    assert.equal(snapshot.status, 'done');
    assert.equal(snapshot.job.packsDone, 8);
    assert.ok(
      snapshot.progress.peakBytesPerSecond >= 8_000_000,
      'the probed peak is not replaced by the tiny-file byte rate',
    );
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
