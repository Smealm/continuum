const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const { currentDatabaseSignature, databaseSignature, readAutoState, writeAutoState } = require('../dist/core/auto.js');
const { gameDataFilename } = require('../dist/core/format.js');
const { scopeKey } = require('../dist/core/scope.js');
const { makeGame, sha256, startServer, tempProject } = require('./helpers.js');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function disposable() {
  return { toDispose: [], isDisposed: false, dispose() {} };
}

/**
 * The launcher surface extension.ts uses, with its events recorded so a test
 * can fire them. Everything else is inert.
 */
function makeLauncher({ root, extensionPath, prefs, store, config, logs, listeners }) {
  const commands = new Map();
  const tasks = new Map();
  return {
    config: { flashpointPath: root },
    extensionPath,
    dataVersion: undefined,
    getPreferences: () => prefs,
    getExtConfigValue: (key) => config[key],
    setExtConfigValue: async () => undefined,
    log: {
      debug: (message) => logs.push(message),
      info: (message) => logs.push(message),
      warn: (message) => logs.push(message),
      error: (message) => logs.push(message),
    },
    commands: {
      registerCommand(name, callback) {
        commands.set(name, callback);
        return { toDispose: [], isDisposed: false, dispose() { commands.delete(name); } };
      },
      registerShortcut() {
        return disposable();
      },
    },
    registerDisposable(parent, child) {
      parent.toDispose.push(child);
    },
    status: {
      newTask(task) {
        const id = `task-${tasks.size}`;
        tasks.set(id, { ...task, id });
        return { ...task, id };
      },
      setTask(update) {
        tasks.set(update.id, { ...(tasks.get(update.id) || {}), ...update });
      },
    },
    dialogs: {
      showMessageBox: async () => 0,
      showOpenDialog: async () => undefined,
      showSaveDialog: async () => undefined,
    },
    onDidInit: (listener) => {
      listeners.init.push(listener);
      return disposable();
    },
    onExtConfigChange: (listener) => {
      listeners.config.push(listener);
      return disposable();
    },
    tags: {
      findTags: async () => [{ name: 'Puzzle' }, { name: 'Action' }],
    },
    games: {
      countGames: async () => store.size,
      findGamesWithTag: async (tag) => [...store.values()]
        .filter((game) => (game.tags || []).includes(tag))
        .map(clone),
      findGame: async (id) => (store.has(id) ? clone(store.get(id)) : null),
      updateGame: async (value) => {
        store.set(value.id, clone(value));
        return value;
      },
      findPlaylistByName: async () => null,
      findPlaylists: () => [],
      findPlaylist: () => null,
      onDidInstallGameData: (listener) => {
        listeners.installed.push(listener);
        return disposable();
      },
      onDidUninstallGameData: (listener) => {
        listeners.uninstalled.push(listener);
        return disposable();
      },
    },
    gameData: {
      save: async (data) => {
        const current = store.get(data.gameId);
        current.gameData = current.gameData.map((entry) => (entry.id === data.id ? { ...entry, ...data } : entry));
        store.set(data.gameId, current);
        return data;
      },
    },
    commandsMap: commands,
  };
}

/** Load extension.js fresh, so its `flashpoint-launcher` import is this fake. */
function freshDist() {
  const prefix = `${path.sep}dist${path.sep}`;
  for (const key of Object.keys(require.cache)) {
    if (key.includes(prefix)) {
      delete require.cache[key];
    }
  }
}

async function withExtension(launcher, run) {
  freshDist();
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'flashpoint-launcher') {
      return launcher;
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    const extension = require('../dist/extension.js');
    const subscriptions = { toDispose: [], isDisposed: false };
    await extension.activate({ subscriptions });
    try {
      await run(extension, subscriptions);
    } finally {
      extension.deactivate();
    }
  } finally {
    Module._load = originalLoad;
  }
}

function baseConfig(overrides = {}) {
  return {
    'continuum.scope': 'all',
    'continuum.reserveGB': '0',
    'continuum.maxTotalGB': '0',
    'continuum.activeWorkers': '1',
    'continuum.passiveWorkers': '1',
    'continuum.passiveDelayMs': '0',
    'continuum.respectFlashpointSettings': false,
    'continuum.autoMirror': false,
    'continuum.fastCatalogue': false,
    'continuum.sqlitePath': '',
    ...overrides,
  };
}

async function waitFor(predicate, deadlineMs = 15_000) {
  const deadline = Date.now() + deadlineMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

function waitForFile(file, deadlineMs = 15_000) {
  return waitFor(() => fs.existsSync(file), deadlineMs);
}

test('activates against a mocked launcher and mirrors a game through the command flow', async () => {
  const { root, extensionPath, prefs, paths } = tempProject();
  const listenerSet = { init: [], config: [], installed: [], uninstalled: [] };
  const logs = [];

  const game = makeGame(1);
  const pack = Buffer.from('extension-flow-pack');
  game.gameData[0].sha256 = sha256(pack);
  game.gameData[0].size = pack.length;
  const filename = gameDataFilename(game.gameData[0]);

  const server = await startServer({
    [`/games/${filename}`]: (request, response) => {
      response.writeHead(200, { 'content-length': pack.length });
      response.end(pack);
    },
  });

  prefs.onDemandBaseUrl = `http://127.0.0.1:${server.port}/images/`;
  // Images follow the launcher; keep these flow tests on packs only.
  prefs.onDemandImages = false;
  prefs.gameDataSources = [{ type: 'raw', name: 'test', arguments: [`http://127.0.0.1:${server.port}/games/`] }];

  const store = new Map([[game.id, clone(game)]]);
  const launcher = makeLauncher({
    root,
    extensionPath,
    prefs,
    store,
    config: baseConfig(),
    logs,
    listeners: listenerSet,
  });

  try {
    await withExtension(launcher, async () => {
      assert.ok(fs.existsSync(paths.stateDir));
      assert.ok(launcher.commandsMap.has('continuum.startActive'));

      // The launcher's install/uninstall events are wired to the engine.
      assert.equal(listenerSet.installed.length, 1);
      assert.equal(listenerSet.uninstalled.length, 1);
      listenerSet.installed[0]({ gameId: 'game-999' });
      assert.ok(logs.some((line) => /launcher installed game-999/i.test(line)));
      listenerSet.uninstalled[0]({ gameId: 'game-999' });
      assert.ok(logs.some((line) => /uninstalled game-999/i.test(line)));

      launcher.commandsMap.get('continuum.startActive')();

      const target = path.join(paths.dataPacksDir, filename);
      assert.ok(await waitForFile(target), 'pack should be downloaded');
      assert.deepEqual(fs.readFileSync(target), pack);

      const stored = store.get('game-1');
      assert.equal(stored.gameData[0].presentOnDisk, true);
      assert.equal(stored.gameData[0].path, filename);
      assert.equal(stored.activeDataOnDisk, true);

      const catalogue = fs.readFileSync(paths.catalogFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(catalogue.length, 1);
      assert.equal(catalogue[0].id, 'game-1');
    });
  } finally {
    await server.close();
  }
});

test('the automatic switch resumes a saved job when the launcher starts', async () => {
  const { root, extensionPath, prefs, paths } = tempProject();
  const listenerSet = { init: [], config: [], installed: [], uninstalled: [] };
  const logs = [];

  const game = makeGame(2);
  const pack = Buffer.from('automatic-start-pack');
  game.gameData[0].sha256 = sha256(pack);
  game.gameData[0].size = pack.length;
  const filename = gameDataFilename(game.gameData[0]);

  const server = await startServer({
    [`/games/${filename}`]: (request, response) => {
      response.writeHead(200, { 'content-length': pack.length });
      response.end(pack);
    },
  });

  prefs.onDemandBaseUrl = `http://127.0.0.1:${server.port}/images/`;
  // Images follow the launcher; keep these flow tests on packs only.
  prefs.onDemandImages = false;
  prefs.gameDataSources = [{ type: 'raw', name: 'test', arguments: [`http://127.0.0.1:${server.port}/games/`] }];

  const store = new Map([[game.id, clone(game)]]);
  const launcher = makeLauncher({
    root,
    extensionPath,
    prefs,
    store,
    config: baseConfig({ 'continuum.autoMirror': true }),
    logs,
    listeners: listenerSet,
  });

  try {
    // A catalogue and a stopped job for it, and the database they were built
    // from: this is a normal launcher restart in the middle of a mirror.
    fs.mkdirSync(path.dirname(paths.databaseFile), { recursive: true });
    fs.writeFileSync(paths.databaseFile, 'launcher database');
    fs.writeFileSync(paths.catalogFile, `${JSON.stringify({
      id: game.id,
      title: game.title,
      library: game.library,
      platforms: game.platforms,
      tags: game.tags,
      logo: game.logoPath,
      screenshot: game.screenshotPath,
      data: [{
        id: game.gameData[0].id,
        gameId: game.id,
        sha256: game.gameData[0].sha256,
        size: game.gameData[0].size,
        dateAdded: game.gameData[0].dateAdded,
        present: false,
      }],
    })}\n`);
    const meta = {
      version: 1,
      generation: 'gen-auto',
      scannedAt: new Date('2024-01-01T00:00:00.000Z').toISOString(),
      tagsTotal: 1,
      tagsScanned: 1,
      games: 1,
      packs: 1,
      packsMissing: 1,
      bytesTotal: pack.length,
      bytesMissing: pack.length,
      images: 0,
      complete: true,
      tagOrder: ['Puzzle'],
    };
    fs.writeFileSync(paths.catalogMetaFile, JSON.stringify(meta));
    await writeAutoState(
      paths.databaseStateFile,
      databaseSignature(fs.statSync(paths.databaseFile)),
      undefined,
    );
    fs.writeFileSync(paths.jobFile, JSON.stringify({
      version: 1,
      generation: meta.generation,
      scopeKey: scopeKey({ kind: 'all', value: '' }, false),
      mode: 'passive',
      cursor: 0,
      bytes: 0,
      packsDone: 0,
      packsFailed: 0,
      gamesDone: 0,
      gamesFailed: 0,
      imagesDone: 0,
      status: 'stopped',
      message: 'Stopped. Progress was saved.',
      updatedAt: new Date().toISOString(),
    }));

    await withExtension(launcher, async () => {
      assert.equal(listenerSet.init.length, 1);
      listenerSet.init[0]();

      const target = path.join(paths.dataPacksDir, filename);
      assert.ok(await waitForFile(target), 'the saved job should resume on startup');
      assert.deepEqual(fs.readFileSync(target), pack);
      assert.ok(
        await waitFor(() => store.get(game.id).gameData[0].presentOnDisk === true),
        'the database flag should be written by the resumed job',
      );
      assert.ok(logs.some((line) => /automatic passive job started/i.test(line)));
    });
  } finally {
    await server.close();
  }
});

test('switching the automatic mirror on builds the catalogue and starts mirroring', async () => {
  const { root, extensionPath, prefs, paths } = tempProject();
  const listenerSet = { init: [], config: [], installed: [], uninstalled: [] };
  const logs = [];

  // makeGame(4) is tagged Puzzle, which is the tag the fake launcher knows.
  const game = makeGame(4);
  const pack = Buffer.from('automatic-first-build-pack');
  game.gameData[0].sha256 = sha256(pack);
  game.gameData[0].size = pack.length;
  const filename = gameDataFilename(game.gameData[0]);

  const server = await startServer({
    [`/games/${filename}`]: (request, response) => {
      response.writeHead(200, { 'content-length': pack.length });
      response.end(pack);
    },
  });

  prefs.onDemandBaseUrl = `http://127.0.0.1:${server.port}/images/`;
  // Images follow the launcher; keep these flow tests on packs only.
  prefs.onDemandImages = false;
  prefs.gameDataSources = [{ type: 'raw', name: 'test', arguments: [`http://127.0.0.1:${server.port}/games/`] }];

  fs.mkdirSync(path.dirname(paths.databaseFile), { recursive: true });
  fs.writeFileSync(paths.databaseFile, 'launcher database');

  const store = new Map([[game.id, clone(game)]]);
  const config = baseConfig();
  const launcher = makeLauncher({
    root,
    extensionPath,
    prefs,
    store,
    config,
    logs,
    listeners: listenerSet,
  });

  try {
    await withExtension(launcher, async () => {
      assert.equal(listenerSet.init.length, 1);
      assert.equal(listenerSet.config.length, 1);

      // Off: the startup check does nothing at all.
      listenerSet.init[0]();
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(logs.some((line) => /automatic catalogue rebuild/i.test(line)), false);
      assert.equal(fs.existsSync(paths.catalogFile), false);

      // Switching it on runs a check immediately instead of waiting for the
      // five-minute tick.
      config['continuum.autoMirror'] = true;
      listenerSet.config[0]({ key: 'continuum.autoMirror', value: true });

      const target = path.join(paths.dataPacksDir, filename);
      assert.ok(await waitForFile(target), `the automatic rebuild and pass should download the game\n${logs.join('\n')}`);
      assert.deepEqual(fs.readFileSync(target), pack);

      const meta = JSON.parse(fs.readFileSync(paths.catalogMetaFile, 'utf8'));
      assert.equal(meta.games, 1);
      assert.equal(meta.complete, true);
      assert.ok(logs.some((line) => /automatic catalogue rebuild: there is no catalogue yet/i.test(line)));
      assert.ok(logs.some((line) => /automatic passive job started/i.test(line)));

      const recorded = await readAutoState(paths.databaseStateFile);
      assert.equal(recorded.database, await currentDatabaseSignature(paths.databaseFile));

      // Wait for the pass to finish, then check again: nothing should be
      // rebuilt or restarted while the catalogue is current.
      assert.ok(
        await waitFor(() => {
          try {
            return JSON.parse(fs.readFileSync(paths.jobFile, 'utf8')).status === 'done';
          } catch {
            return false;
          }
        }),
        'the automatic pass should finish',
      );
      const rebuilds = logs.filter((line) => /automatic catalogue rebuild/i.test(line)).length;
      assert.equal(rebuilds, 1);

      listenerSet.init[0]();
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(
        logs.filter((line) => /automatic catalogue rebuild/i.test(line)).length,
        rebuilds,
        'a current catalogue must not be rebuilt again',
      );
    });
  } finally {
    await server.close();
  }
});
