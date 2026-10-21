const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const { gameDataFilename } = require('../dist/core/format.js');
const { makeGame, sha256, startServer, tempProject } = require('./helpers.js');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('activates against a mocked launcher and mirrors a game through the command flow', async () => {
  const { root, extensionPath, prefs, paths } = tempProject();
  const originalLoad = Module._load;

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
  prefs.gameDataSources = [{ type: 'raw', name: 'test', arguments: [`http://127.0.0.1:${server.port}/games/`] }];

  const store = new Map([[game.id, clone(game)]]);
  const commands = new Map();
  const tasks = new Map();
  const config = {
    'continuum.scope': 'all',
    'continuum.includeImages': false,
    'continuum.reserveGB': '0',
    'continuum.maxTotalGB': '0',
    'continuum.activeWorkers': '1',
    'continuum.passiveWorkers': '1',
    'continuum.passiveDelayMs': '0',
    'continuum.respectExtremeFilter': false,
    'continuum.autoResume': false,
  };

  const fakeFlashpoint = {
    config: { flashpointPath: root },
    extensionPath,
    dataVersion: undefined,
    getPreferences: () => prefs,
    getExtConfigValue: (key) => config[key],
    setExtConfigValue: async () => undefined,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    commands: {
      registerCommand(name, callback) {
        commands.set(name, callback);
        return { toDispose: [], isDisposed: false, dispose() { commands.delete(name); } };
      },
      registerShortcut() {
        return { toDispose: [], isDisposed: false };
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
    onDidInit: () => ({ toDispose: [], isDisposed: false }),
    onExtConfigChange: () => ({ toDispose: [], isDisposed: false }),
    tags: {
      findTags: async () => [{ name: 'Puzzle' }],
    },
    games: {
      countGames: async () => store.size,
      findGamesWithTag: async (tag) => (tag === 'Puzzle' ? [clone(store.get('game-1'))] : []),
      findGame: async (id) => (store.has(id) ? clone(store.get(id)) : null),
      updateGame: async (value) => {
        store.set(value.id, clone(value));
        return value;
      },
      findPlaylistByName: async () => null,
    },
    gameData: {
      save: async (data) => {
        const current = store.get(data.gameId);
        current.gameData = current.gameData.map((entry) => (entry.id === data.id ? { ...entry, ...data } : entry));
        store.set(data.gameId, current);
        return data;
      },
    },
  };

  Module._load = function load(request, parent, isMain) {
    if (request === 'flashpoint-launcher') {
      return fakeFlashpoint;
    }
    return originalLoad.apply(this, arguments);
  };

  try {
    const extension = require('../dist/extension.js');
    const subscriptions = { toDispose: [], isDisposed: false };
    await extension.activate({ subscriptions });

    assert.ok(fs.existsSync(paths.stateDir));
    assert.ok(commands.has('continuum.startActive'));

    const run = commands.get('continuum.startActive');
    run();

    const target = path.join(paths.dataPacksDir, filename);
    const deadline = Date.now() + 15_000;
    while (!fs.existsSync(target) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(fs.existsSync(target), 'pack should be downloaded');
    assert.deepEqual(fs.readFileSync(target), pack);

    const stored = store.get('game-1');
    assert.equal(stored.gameData[0].presentOnDisk, true);
    assert.equal(stored.gameData[0].path, filename);
    assert.equal(stored.activeDataOnDisk, true);

    const catalogue = fs.readFileSync(paths.catalogFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(catalogue.length, 1);
    assert.equal(catalogue[0].id, 'game-1');

    extension.deactivate();
  } finally {
    Module._load = originalLoad;
    await server.close();
  }
});
