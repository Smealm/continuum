const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { resolvePaths } = require('../dist/core/paths.js');

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function tempProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-test-'));
  const extensionPath = path.join(root, 'Data', 'Extensions', 'Continuum');
  const prefs = {
    dataPacksFolderPath: 'Data/Games',
    imageFolderPath: 'Data/Images',
    onDemandBaseUrl: 'http://127.0.0.1:1/images/',
    onDemandImages: true,
    onDemandImagesCompressed: true,
    gameDataSources: [],
    disableExtremeGames: false,
    tagFilters: [],
  };
  const paths = resolvePaths(root, prefs, extensionPath);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.mkdirSync(paths.dataPacksDir, { recursive: true });
  fs.mkdirSync(paths.imagesDir, { recursive: true });
  return { root, extensionPath, prefs, paths };
}

function makeGame(index) {
  const id = `game-${index}`;
  const dateAdded = `2024-01-0${index % 9 + 1}T00:00:00.000Z`;
  return {
    id,
    title: `Game ${index}`,
    library: 'arcade',
    platforms: index % 2 === 0 ? ['Flash'] : ['HTML5'],
    tags: index % 2 === 0 ? ['Puzzle'] : ['Action'],
    logoPath: `Logos/aa/${id}.png`,
    screenshotPath: `Screenshots/aa/${id}.png`,
    activeDataId: index,
    activeDataOnDisk: false,
    gameData: [{
      id: index,
      gameId: id,
      title: 'Data Pack',
      dateAdded,
      sha256: '',
      crc32: 0,
      size: 0,
      presentOnDisk: false,
      path: undefined,
      applicationPath: '',
      launchCommand: '',
    }],
  };
}

function writeCatalogue(paths, records, generation = 'gen-1') {
  const lines = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
  fs.writeFileSync(paths.catalogFile, lines);
  fs.writeFileSync(paths.catalogMetaFile, JSON.stringify({
    version: 1,
    generation,
    scannedAt: new Date('2024-01-01T00:00:00.000Z').toISOString(),
    tagsTotal: 1,
    tagsScanned: 1,
    games: records.length,
    packs: records.reduce((sum, record) => sum + record.data.length, 0),
    packsMissing: records.reduce((sum, record) => sum + record.data.filter((data) => !data.present).length, 0),
    bytesTotal: records.reduce((sum, record) => sum + record.data.reduce((total, data) => total + data.size, 0), 0),
    bytesMissing: records.reduce((sum, record) => sum + record.data.filter((data) => !data.present).reduce((total, data) => total + data.size, 0), 0),
    images: records.length * 2,
    complete: true,
    tagOrder: ['Puzzle'],
  }));
}

function makeApi(store) {
  const games = new Map();
  for (const game of store) {
    games.set(game.id, JSON.parse(JSON.stringify(game)));
  }
  const prefs = {
    dataPacksFolderPath: 'Data/Games',
    imageFolderPath: 'Data/Images',
    onDemandBaseUrl: '',
    onDemandImages: true,
    onDemandImagesCompressed: true,
    gameDataSources: [],
    disableExtremeGames: false,
    tagFilters: [],
  };
  return {
    prefs,
    games,
    getPreferences: () => prefs,
    countGames: async () => games.size,
    findTags: async () => [],
    findGamesWithTag: async () => [],
    findGame: async (id) => {
      const game = games.get(id);
      return game ? JSON.parse(JSON.stringify(game)) : null;
    },
    saveGameData: async (data) => {
      const game = games.get(data.gameId);
      const index = game.gameData.findIndex((entry) => entry.id === data.id);
      if (index >= 0) {
        game.gameData[index] = { ...game.gameData[index], ...data };
      }
      return data;
    },
    updateGame: async (game) => {
      games.set(game.id, JSON.parse(JSON.stringify(game)));
      return game;
    },
    findPlaylistByName: async () => {
      throw 'Playlist does not exist';
    },
  };
}

function quietLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function makeSink() {
  const tasks = [];
  const notices = [];
  return {
    tasks,
    notices,
    createTask: (name) => {
      const id = `task-${tasks.length}`;
      tasks.push({ id, name });
      return id;
    },
    updateTask: (id, update) => {
      tasks.push({ id, ...update });
    },
    notify: (message, level) => {
      notices.push({ message, level });
    },
  };
}

async function startServer(routes) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const handler = routes[url.pathname];
    if (!handler) {
      response.statusCode = 404;
      response.end('not found');
      return;
    }
    handler(request, response, url);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = {
  sha256,
  tempProject,
  makeGame,
  makeApi,
  writeCatalogue,
  quietLogger,
  makeSink,
  startServer,
};
