const { test } = require('node:test');
const assert = require('node:assert/strict');

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
    respectFlashpointSettings: true,
    autoMirror: false,
    prioritizePlaylists: false,
    ...overrides,
  };
}

const EXTREME_PREFS = {
  disableExtremeGames: true,
  tagFilters: [{ extreme: true, tags: ['Extreme'] }],
};

/**
 * One mirror over two games: game-1 is ordinary, game-2 is tagged Extreme.
 * Returns the preparation, the finished snapshot, and every image URL and pack
 * the fake servers were asked for.
 */
async function mirror({ prefs = {}, settings = {} } = {}) {
  const { paths } = tempProject();
  const games = [makeGame(1), makeGame(2)];
  games[1].tags = ['Action', 'Extreme'];
  const packs = games.map((game) => {
    const pack = Buffer.from(`pack-${game.id}`);
    game.gameData[0].sha256 = sha256(pack);
    game.gameData[0].size = pack.length;
    return pack;
  });

  const imageRequests = [];
  const packRequests = [];
  const routes = {};
  games.forEach((game, index) => {
    routes[`/games/${gameDataFilename(game.gameData[0])}`] = (request, response) => {
      packRequests.push(game.id);
      response.writeHead(200, { 'content-length': packs[index].length });
      response.end(packs[index]);
    };
  });
  routes['*'] = (request, response) => {
    imageRequests.push(request.url);
    response.writeHead(200, { 'content-length': 3 });
    response.end('img');
  };
  const server = await startServer(routes);

  try {
    const api = makeApi(games);
    api.prefs.onDemandBaseUrl = `http://127.0.0.1:${server.port}/images/`;
    api.prefs.gameDataSources = [{ type: 'raw', name: 'test', arguments: [`http://127.0.0.1:${server.port}/games/`] }];
    Object.assign(api.prefs, prefs);
    writeCatalogue(paths, catalogueFrom(games));

    const engine = new Engine({
      api,
      paths,
      log: quietLogger(),
      sink: makeSink(),
      probeFree: async () => ({ freeBytes: 10 * 1024 * 1024 * 1024 }),
      retryWaitMs: 0,
    }, new Catalog(api, paths, quietLogger()));

    const prep = await engine.prepare(baseSettings(settings));
    if (prep.estimate.totalBytes > 0) {
      await engine.start(prep);
      await engine.whenIdle();
    }
    return { prep, snapshot: engine.snapshot(), imageRequests, packRequests };
  } finally {
    await server.close();
  }
}

test('the extreme filter is followed while the switch is on', async () => {
  const { prep, packRequests } = await mirror({ prefs: EXTREME_PREFS });

  assert.equal(prep.settings.respectFlashpointSettings, true);
  assert.equal(prep.filter.excludeExtreme, true);
  assert.equal(prep.estimate.gamesInScope, 1);
  assert.deepEqual(packRequests, ['game-1']);
});

test('the extreme filter is ignored when the switch is off', async () => {
  const { prep, packRequests } = await mirror({
    prefs: EXTREME_PREFS,
    settings: { respectFlashpointSettings: false },
  });

  assert.equal(prep.filter.excludeExtreme, false);
  assert.equal(prep.estimate.gamesInScope, 2);
  assert.deepEqual(packRequests.sort(), ['game-1', 'game-2']);
});

test('compressed images are requested when the launcher asks for them', async () => {
  const { imageRequests } = await mirror({
    prefs: { onDemandImagesCompressed: true },
    settings: { includeImages: true },
  });

  assert.ok(imageRequests.length > 0);
  assert.ok(imageRequests.every((url) => /[?&]type=jpg$/.test(url)), imageRequests.join(', '));
});

test('uncompressed images are requested when the launcher does not compress', async () => {
  const { imageRequests } = await mirror({
    prefs: { onDemandImagesCompressed: false },
    settings: { includeImages: true },
  });

  assert.ok(imageRequests.length > 0);
  assert.ok(imageRequests.every((url) => !url.includes('type=jpg')), imageRequests.join(', '));
});

test('images are always uncompressed when the switch is off', async () => {
  const { imageRequests } = await mirror({
    prefs: { onDemandImagesCompressed: true },
    settings: { includeImages: true, respectFlashpointSettings: false },
  });

  assert.ok(imageRequests.length > 0);
  assert.ok(imageRequests.every((url) => !url.includes('type=jpg')), imageRequests.join(', '));
});

test('images are skipped when the launcher has image caching off', async () => {
  const { prep, imageRequests, packRequests } = await mirror({
    prefs: { onDemandImages: false },
    settings: { includeImages: true },
  });

  assert.equal(prep.settings.includeImages, false);
  assert.equal(prep.estimate.imageEstimateBytes, 0);
  assert.equal(imageRequests.length, 0);
  assert.equal(packRequests.length, 2);
  assert.ok(prep.warnings.some((warning) => /image caching/i.test(warning)), prep.warnings.join('\n'));
});

test('ignoring the launcher caches images even when its image caching is off', async () => {
  const { prep, imageRequests } = await mirror({
    prefs: { onDemandImages: false, onDemandImagesCompressed: true },
    settings: { includeImages: true, respectFlashpointSettings: false },
  });

  // The launcher's image caching is only honoured while it is being respected.
  // There is no separate Continuum switch any more, so with the respect switch
  // off the default is to cache the images with the packs.
  assert.equal(prep.settings.includeImages, true);
  assert.ok(prep.estimate.imageEstimateBytes > 0);
  assert.ok(imageRequests.length > 0);
  assert.equal(prep.warnings.some((warning) => /image caching/i.test(warning)), false);
});

test('images are cached when the launcher caches them', async () => {
  const { prep, imageRequests } = await mirror({
    prefs: { onDemandImages: true, onDemandImagesCompressed: true },
    settings: { includeImages: true },
  });

  assert.equal(prep.settings.includeImages, true);
  assert.ok(prep.estimate.imageEstimateBytes > 0);
  assert.ok(imageRequests.length > 0);
});
