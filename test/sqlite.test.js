const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');

const { FastCatalog, catalogSource, decodeHex } = require('../dist/core/sqlite.js');
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

test('finds the sqlite3 tool that ships with Flashpoint', () => {
  const { root } = tempProject();
  assert.equal(FastCatalog.findCli(root), null);

  fs.mkdirSync(path.join(root, 'Legacy'), { recursive: true });
  const exe = path.join(root, 'Legacy', 'sqlite3.exe');
  fs.writeFileSync(exe, 'binary');
  assert.equal(FastCatalog.findCli(root), exe);
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
