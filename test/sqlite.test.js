const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');

const {
  FastCatalog,
  catalogSource,
  cliCandidates,
  decodeHex,
  locateCli,
  resetCliCache,
} = require('../dist/core/sqlite.js');
const { tempProject, quietLogger } = require('./helpers.js');

const hex = (value) => Buffer.from(value, 'utf8').toString('hex');

function rows(spec) {
  return `${spec.join('\n')}\n`;
}

function dataset() {
  return rows([
    's|8',
    'n|3',
    `T|1|${hex('Puzzle')}`,
    `T|2|${hex('Action')}`,
    `T|3|${hex('Zeta')}`,
    `P|5|${hex('Flash')}`,
    `t|${hex('a')}|1`,
    `t|${hex('b')}|1`,
    `t|${hex('b')}|2`,
    `t|${hex('c')}|1`,
    `t|${hex('c')}|2`,
    `t|${hex('c')}|3`,
    `p|${hex('a')}|5`,
    `p|${hex('b')}|5`,
    `d|${hex('a')}|10|${hex('a'.repeat(64))}|100|${hex('2024-01-01T00:00:00.000Z')}|0|`,
    `d|${hex('b')}|11|${hex('b'.repeat(64))}|250|${hex('2024-01-02T00:00:00.000Z')}|1|${hex('b-2024.zip')}`,
    `d|${hex('b')}|12|${hex('c'.repeat(64))}|50|${hex('2024-01-03T00:00:00.000Z')}|0|`,
    `g|${hex('a')}|${hex('Alpha')}|${hex('arcade')}|${hex('Logos/aa/a.png')}|${hex('Screenshots/aa/a.png')}`,
    `g|${hex('b')}|${hex('Beta \u2603')}|${hex('theatre')}|${hex('Logos/bb/b.png')}|${hex('')}`,
    `g|${hex('c')}|${hex('Gamma')}|${hex('arcade')}|${hex('')}|${hex('')}`,
  ]);
}

function fakeChild(payload, options = {}) {
  const child = new EventEmitter();
  child.stdout = Readable.from(payload === null ? [] : [Buffer.from(payload)]);
  child.stderr = Readable.from(options.stderr ? [Buffer.from(options.stderr)] : []);
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    setImmediate(() => child.emit('close', 1));
    return true;
  };
  if (payload !== null) {
    child.stdout.on('end', () => setImmediate(() => child.emit('close', options.code ?? 0)));
  }
  return child;
}

function makeFast(paths, payload, options = {}) {
  const calls = [];
  const fast = new FastCatalog({
    dbPath: paths.databaseFile,
    cliPath: path.join(paths.flashpointRoot, 'Legacy', 'sqlite3.exe'),
    catalogFile: paths.catalogFile,
    catalogMetaFile: paths.catalogMetaFile,
    log: quietLogger(),
    spawnCli: (cliPath, args) => {
      calls.push({ cliPath, args });
      return fakeChild(payload, options);
    },
  });
  return { fast, calls };
}

function prepare(paths) {
  fs.mkdirSync(path.dirname(paths.databaseFile), { recursive: true });
  fs.writeFileSync(paths.databaseFile, 'not really a database');
  fs.mkdirSync(paths.stateDir, { recursive: true });
}

function versionChild(payload, code = 0) {
  const child = new EventEmitter();
  child.stdout = Readable.from(payload ? [Buffer.from(payload)] : []);
  child.stderr = Readable.from([]);
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    setImmediate(() => child.emit('close', 1));
    return true;
  };
  child.stdout.on('end', () => setImmediate(() => child.emit('close', code)));
  return child;
}

function locateOptions(root, overrides = {}) {
  const spawns = [];
  const options = {
    flashpointRoot: root,
    pathEnv: '',
    platform: 'linux',
    log: quietLogger(),
    spawnCli: (cliPath, args) => {
      spawns.push({ cliPath, args });
      return versionChild('3.45.1 2024-01-30 16:01:20\n');
    },
    ...overrides,
  };
  return { spawns, options };
}

function writeTool(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'binary');
  return file;
}

test('finds the sqlite3 tool that ships with Flashpoint', async () => {
  const { root } = tempProject();
  assert.equal(await locateCli(locateOptions(root, { platform: 'win32' }).options), null);

  fs.mkdirSync(path.join(root, 'Legacy'), { recursive: true });
  const exe = path.join(root, 'Legacy', 'sqlite3.exe');
  fs.writeFileSync(exe, 'binary');
  const found = await locateCli(locateOptions(root, { platform: 'win32' }).options);
  assert.equal(found.path, exe);
  assert.equal(found.source, 'flashpoint');
});

test('finds the tool in the macOS and Linux layouts', async () => {
  const { root } = tempProject();
  const bin = writeTool(path.join(root, 'Legacy', 'bin', 'sqlite3'));
  assert.equal((await locateCli(locateOptions(root).options)).path, bin);

  const linux = tempProject().root;
  const utilities = writeTool(path.join(linux, 'Utilities', 'sqlite3'));
  assert.equal((await locateCli(locateOptions(linux).options)).path, utilities);
});

test('looks at the configured path, the Flashpoint folder, then PATH', () => {
  const { root } = tempProject();
  const pathFolder = path.join(root, 'usr-bin');
  const pathTool = writeTool(path.join(pathFolder, 'sqlite3'));

  const candidates = cliCandidates({ flashpointRoot: root, pathEnv: pathFolder, platform: 'linux' });
  assert.deepEqual(candidates.find((candidate) => candidate.source === 'path'), { path: pathTool, source: 'path' });
  assert.equal(new Set(candidates.map((candidate) => candidate.path)).size, candidates.length);

  const configured = writeTool(path.join(root, 'tools', 'sqlite3'));
  const ordered = cliCandidates({
    flashpointRoot: root,
    configured,
    pathEnv: pathFolder,
    platform: 'linux',
  });
  assert.deepEqual(ordered[0], { path: configured, source: 'configured' });
});

test('uses a tool from PATH when the Flashpoint folder has none', async () => {
  const { root } = tempProject();
  const pathFolder = path.join(root, 'bin');
  const tool = writeTool(path.join(pathFolder, 'sqlite3'));
  const { options } = locateOptions(root, { pathEnv: pathFolder });

  const found = await locateCli(options);
  assert.equal(found.path, tool);
  assert.equal(found.source, 'path');
  assert.equal(found.version, '3.45.1');
});

test('skips a file that exists but does not answer as sqlite3', async () => {
  const { root } = tempProject();
  const stub = writeTool(path.join(root, 'Legacy', 'sqlite3'));
  const good = writeTool(path.join(root, 'sqlite3'));

  const tried = [];
  const { options } = locateOptions(root, {
    spawnCli: (cliPath, args) => {
      tried.push(cliPath);
      return cliPath === stub ? versionChild('not a database tool\n', 1) : versionChild('3.40.1 2022-12-28\n');
    },
  });

  const found = await locateCli(options);
  assert.deepEqual(tried, [stub, good]);
  assert.equal(found.path, good);
  assert.equal(found.version, '3.40.1');
});

test('gives a tool in the Flashpoint folder its execute bit back', async () => {
  const { root } = tempProject();
  const tool = writeTool(path.join(root, 'Legacy', 'sqlite3'));

  const changes = [];
  const changed = locateOptions(root, {
    isExecutable: () => false,
    chmod: (file, mode) => changes.push({ file, mode }),
  });
  const found = await locateCli(changed.options);

  assert.equal(found.path, tool);
  assert.deepEqual(changes, [{ file: tool, mode: 0o755 }]);
});

test('leaves an executable tool and anything on PATH alone', async () => {
  const { root } = tempProject();
  writeTool(path.join(root, 'Legacy', 'sqlite3'));

  const changes = [];
  const ready = locateOptions(root, {
    isExecutable: () => true,
    chmod: (file, mode) => changes.push({ file, mode }),
  });
  await locateCli(ready.options);
  assert.deepEqual(changes, []);

  const pathFolder = path.join(root, 'bin');
  writeTool(path.join(pathFolder, 'sqlite3'));
  const fromPath = locateOptions(tempProject().root, {
    pathEnv: pathFolder,
    isExecutable: () => false,
    chmod: (file, mode) => changes.push({ file, mode }),
  });
  const found = await locateCli(fromPath.options);
  assert.equal(found.source, 'path');
  assert.deepEqual(changes, []);
});

test('skips a tool that cannot be made executable', async () => {
  const { root } = tempProject();
  const locked = writeTool(path.join(root, 'Legacy', 'sqlite3'));
  const good = writeTool(path.join(root, 'sqlite3'));

  const { options } = locateOptions(root, {
    isExecutable: () => false,
    chmod: (file) => {
      if (file === locked) {
        throw new Error('EPERM');
      }
    },
  });

  const found = await locateCli(options);
  assert.equal(found.path, good);
});

test('probes each tool once per session', async () => {
  const { root } = tempProject();
  const tool = writeTool(path.join(root, 'Legacy', 'sqlite3'));
  resetCliCache();
  const { spawns, options } = locateOptions(root);

  assert.equal((await locateCli(options)).path, tool);
  assert.equal((await locateCli(options)).path, tool);
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].args, ['--version']);
});

test('only uses the database when it is switched on and available', () => {
  assert.equal(catalogSource(true, true), 'database');
  assert.equal(catalogSource(true, false), 'api');
  assert.equal(catalogSource(false, true), 'api');
  assert.equal(catalogSource(false, false), 'api');
});

test('decodes hex columns and empty values', () => {
  assert.equal(decodeHex(hex('Beta \u2603')), 'Beta \u2603');
  assert.equal(decodeHex(''), '');
  assert.equal(decodeHex(undefined), '');
});

test('builds the whole catalogue from the launcher database', async () => {
  const { paths } = tempProject();
  prepare(paths);
  const { fast, calls } = makeFast(paths, dataset());

  const progress = [];
  const meta = await fast.scan({
    signal: new AbortController().signal,
    onProgress: (update) => progress.push(update),
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0], '-readonly');
  assert.equal(calls[0].args[1], paths.databaseFile);

  assert.equal(meta.source, 'database');
  assert.equal(meta.complete, true);
  assert.equal(meta.games, 3);
  assert.equal(meta.packs, 3);
  assert.equal(meta.packsMissing, 2);
  assert.equal(meta.bytesTotal, 400);
  assert.equal(meta.bytesMissing, 150);
  assert.equal(meta.images, 3);
  assert.equal(meta.tagsTotal, 3);
  // Most used tag first, ties by name, so an API rescan starts with the big ones.
  assert.deepEqual(meta.tagOrder, ['Puzzle', 'Action', 'Zeta']);

  const records = fs.readFileSync(paths.catalogFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(records.map((record) => record.id), ['a', 'b', 'c']);

  const [a, b, c] = records;
  assert.equal(a.title, 'Alpha');
  assert.equal(a.library, 'arcade');
  assert.deepEqual(a.platforms, ['Flash']);
  assert.deepEqual(a.tags, ['Puzzle']);
  assert.equal(a.data.length, 1);
  assert.equal(a.data[0].gameId, 'a');
  assert.equal(a.data[0].size, 100);
  assert.equal(a.data[0].present, false);
  assert.equal(a.data[0].path, '');
  assert.equal(a.data[0].dateAdded, '2024-01-01T00:00:00.000Z');

  assert.equal(b.title, 'Beta \u2603');
  assert.deepEqual(b.platforms, ['Flash']);
  assert.deepEqual(b.tags, ['Puzzle', 'Action']);
  assert.deepEqual(b.data.map((entry) => [entry.id, entry.present, entry.path]), [
    [11, true, 'b-2024.zip'],
    [12, false, ''],
  ]);

  assert.deepEqual(c.platforms, []);
  assert.deepEqual(c.tags, ['Puzzle', 'Action', 'Zeta']);
  assert.deepEqual(c.data, []);

  assert.ok(progress.length > 0);
  assert.ok(progress.every((update) => update.percent >= 0 && update.percent <= 1));
  assert.equal(progress[progress.length - 1].stage, 5);
  assert.equal(fs.existsSync(`${paths.catalogFile}.tmp`), false);

  const meta2 = JSON.parse(fs.readFileSync(paths.catalogMetaFile, 'utf8'));
  assert.equal(meta2.version, 1);
});

test('keeps the catalogue it replaced for the rebuild report', async () => {
  const { paths } = tempProject();
  prepare(paths);

  await makeFast(paths, dataset()).fast.scan({ signal: new AbortController().signal });
  await makeFast(paths, dataset().replace(hex('Alpha'), hex('Alpha2')))
    .fast.scan({ signal: new AbortController().signal });

  const previous = fs.readFileSync(paths.catalogPreviousFile, 'utf8');
  assert.match(previous, /"title":"Alpha"/);
  assert.doesNotMatch(previous, /Alpha2/);

  const current = fs.readFileSync(paths.catalogFile, 'utf8');
  assert.match(current, /"title":"Alpha2"/);
});

test('refuses a database without the expected tables and keeps the old catalogue', async () => {
  const { paths } = tempProject();
  prepare(paths);
  fs.writeFileSync(paths.catalogFile, '{"id":"old"}\n');
  fs.writeFileSync(paths.catalogMetaFile, JSON.stringify({ version: 1, complete: true, generation: 'old' }));

  const { fast } = makeFast(paths, rows(['s|3', 'n|1', `g|${hex('a')}|${hex('A')}|${hex('arcade')}|||`]));

  await assert.rejects(fast.scan({ signal: new AbortController().signal }), /does not have the expected shape/);
  assert.equal(fs.readFileSync(paths.catalogFile, 'utf8'), '{"id":"old"}\n');
  assert.equal(JSON.parse(fs.readFileSync(paths.catalogMetaFile, 'utf8')).generation, 'old');
  assert.equal(fs.existsSync(`${paths.catalogFile}.tmp`), false);
});

test('keeps the old catalogue when sqlite3 fails', async () => {
  const { paths } = tempProject();
  prepare(paths);
  fs.writeFileSync(paths.catalogFile, '{"id":"old"}\n');

  const { fast } = makeFast(paths, rows(['s|8', 'n|1']), { code: 1, stderr: 'database is locked' });

  await assert.rejects(fast.scan({ signal: new AbortController().signal }), /database is locked/);
  assert.equal(fs.readFileSync(paths.catalogFile, 'utf8'), '{"id":"old"}\n');
});

test('refuses to replace the catalogue with an empty database', async () => {
  const { paths } = tempProject();
  prepare(paths);
  fs.writeFileSync(paths.catalogFile, '{"id":"old"}\n');

  const { fast } = makeFast(paths, rows(['s|8', 'n|0']));

  await assert.rejects(fast.scan({ signal: new AbortController().signal }), /no games/);
  assert.equal(fs.readFileSync(paths.catalogFile, 'utf8'), '{"id":"old"}\n');
});

test('cancelling stops the read and leaves the old catalogue alone', async () => {
  const { paths } = tempProject();
  prepare(paths);
  fs.writeFileSync(paths.catalogFile, '{"id":"old"}\n');

  const { fast } = makeFast(paths, null);
  const controller = new AbortController();
  const scan = fast.scan({ signal: controller.signal });
  setTimeout(() => controller.abort(), 20);

  await assert.rejects(scan, /cancelled/);
  assert.equal(fs.readFileSync(paths.catalogFile, 'utf8'), '{"id":"old"}\n');
  assert.equal(fs.existsSync(`${paths.catalogFile}.tmp`), false);
});
