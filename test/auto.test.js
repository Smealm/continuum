const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  AUTO_MODE,
  currentDatabaseSignature,
  databaseSignature,
  decideAutoAction,
  readAutoState,
  runAutoTasks,
  writeAutoState,
} = require('../dist/core/auto.js');
const { clearDenial, recordDenial } = require('../dist/core/permission.js');
const { quietLogger } = require('./helpers.js');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-auto-'));
}

function meta(overrides = {}) {
  return {
    version: 1,
    generation: 'gen-1',
    scannedAt: new Date('2024-01-01T00:00:00.000Z').toISOString(),
    tagsTotal: 1,
    tagsScanned: 1,
    games: 3,
    packs: 3,
    packsMissing: 0,
    bytesTotal: 0,
    bytesMissing: 0,
    images: 0,
    complete: true,
    tagOrder: [],
    ...overrides,
  };
}

function job(overrides = {}) {
  return {
    version: 1,
    generation: 'gen-1',
    scopeKey: 'all|images',
    mode: 'active',
    cursor: 10,
    bytes: 0,
    packsDone: 0,
    packsFailed: 0,
    gamesDone: 0,
    gamesFailed: 0,
    imagesDone: 0,
    status: 'paused',
    message: '',
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function savedState(overrides = {}) {
  return {
    version: 1,
    database: '1000:4096',
    dataVersion: '12.0',
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function decide(overrides = {}) {
  return decideAutoAction({
    enabled: true,
    running: false,
    meta: meta(),
    job: null,
    database: '1000:4096',
    dataVersion: '12.0',
    saved: savedState(),
    pendingChanges: 0,
    ...overrides,
  });
}

test('automatic tasks are off unless the master switch is on', () => {
  assert.deepEqual(decide({ enabled: false }), { kind: 'off' });
});

test('a running job or rebuild is left alone', () => {
  assert.deepEqual(decide({ running: true }), { kind: 'busy' });
});

test('a recorded refusal blocks every automatic action', () => {
  const denied = decide({ denied: { version: 1, at: new Date().toISOString(), status: 403 } });
  assert.equal(denied.kind, 'none');
  assert.match(denied.reason, /refused access/);
  assert.match(denied.reason, /403/);

  // Even a rebuild, which only reads the launcher database, waits: the refusal
  // is about permission, and a person has not yet chosen to try again.
  assert.equal(decide({ meta: null, denied: { version: 1, at: new Date().toISOString(), status: 401 } }).kind, 'none');
  assert.equal(decide({ running: true, denied: { version: 1, at: new Date().toISOString(), status: 403 } }).kind, 'none');
});

test('no catalogue, no saved database or a moved database means a rebuild', () => {
  const missingCatalogue = decide({ meta: null });
  assert.equal(missingCatalogue.kind, 'rebuild');
  assert.match(missingCatalogue.reason, /no catalogue/i);

  const unrecorded = decide({ saved: null });
  assert.equal(unrecorded.kind, 'rebuild');
  assert.match(unrecorded.reason, /not recorded/i);

  const moved = decide({ saved: savedState({ database: '999:4096' }) });
  assert.equal(moved.kind, 'rebuild');
  assert.equal(moved.database, '1000:4096');
  assert.match(moved.reason, /database changed/i);

  const version = decide({ saved: savedState({ dataVersion: '11.0' }) });
  assert.equal(version.kind, 'rebuild');
  assert.match(version.reason, /data version/i);

  // A launcher that does not expose dataVersion must not rebuild every check.
  assert.notEqual(decide({ dataVersion: undefined, saved: savedState({ dataVersion: undefined }) }).kind, 'rebuild');
});

test('a saved job for this catalogue resumes in the mode it was started with', () => {
  assert.deepEqual(decide({ job: job() }), { kind: 'resume', mode: 'active', status: 'paused' });
  assert.deepEqual(decide({ job: job({ status: 'stopped' }) }), { kind: 'resume', mode: 'active', status: 'stopped' });
  assert.deepEqual(decide({ job: job({ status: 'running', mode: 'passive' }) }), {
    kind: 'resume',
    mode: 'passive',
    status: 'running',
  });
});

test('a finished pass or a failed job is not started again by itself', () => {
  const finished = decide({ job: job({ status: 'done' }) });
  assert.equal(finished.kind, 'none');
  assert.match(finished.reason, /finished/i);

  const failed = decide({ job: job({ status: 'error', message: 'disk gone' }) });
  assert.equal(failed.kind, 'none');
  assert.match(failed.reason, /disk gone/);
});

test('a job from an older catalogue is replaced by a changed pass, then a full one', () => {
  const changed = decide({ job: job({ generation: 'gen-0' }), pendingChanges: 12 });
  assert.deepEqual(changed, { kind: 'changed', mode: AUTO_MODE, count: 12 });

  const missing = decide({ job: job({ generation: 'gen-0' }), meta: meta({ packsMissing: 40 }) });
  assert.deepEqual(missing, { kind: 'pass', mode: AUTO_MODE });

  const complete = decide({ job: job({ generation: 'gen-0' }) });
  assert.equal(complete.kind, 'none');
  assert.match(complete.reason, /on disk/i);
});

test('database signatures notice metadata and content changes', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'flashpoint.sqlite');
  assert.equal(databaseSignature(null), 'missing');
  assert.equal(await currentDatabaseSignature(file), 'missing');

  fs.writeFileSync(file, 'one');
  const first = await currentDatabaseSignature(file);
  assert.match(first, /^\d+:\d+$/);
  assert.equal(databaseSignature(fs.statSync(file)), first);

  fs.writeFileSync(file, 'two!');
  assert.notEqual(await currentDatabaseSignature(file), first);
});

test('the recorded database state survives a restart and rejects junk', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'database.json');
  assert.equal(await readAutoState(file), null);

  await writeAutoState(file, '123:45', '12.1');
  const loaded = await readAutoState(file);
  assert.equal(loaded.version, 1);
  assert.equal(loaded.database, '123:45');
  assert.equal(loaded.dataVersion, '12.1');

  await writeAutoState(file, '123:45', undefined);
  assert.equal((await readAutoState(file)).dataVersion, undefined);

  fs.writeFileSync(file, JSON.stringify({ version: 99, database: 'x' }));
  assert.equal(await readAutoState(file), null);
  fs.writeFileSync(file, 'not json');
  assert.equal(await readAutoState(file), null);
});

/** A temp project plus fake deps, with the database recorded unless told otherwise. */
async function makeDeps(options = {}) {
  const dir = tempDir();
  const databaseFile = path.join(dir, 'Data', 'flashpoint.sqlite');
  fs.mkdirSync(path.dirname(databaseFile), { recursive: true });
  fs.writeFileSync(databaseFile, 'launcher database');

  const paths = {
    databaseFile,
    databaseStateFile: path.join(dir, 'state', 'database.json'),
    changedFile: path.join(dir, 'state', 'changed.json'),
    deniedFile: path.join(dir, 'state', 'denied.json'),
  };
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  if (options.saved === undefined) {
    await writeAutoState(paths.databaseStateFile, await currentDatabaseSignature(databaseFile), '12.0');
  } else if (options.saved) {
    await writeAutoState(paths.databaseStateFile, options.saved.database, options.saved.dataVersion);
  }

  const calls = { rebuild: 0, prepare: [], start: [] };
  const baseSettings = {
    mode: AUTO_MODE,
    scope: { kind: 'all', value: '' },
    includeImages: false,
    reserveBytes: 0,
    maxBytes: 0,
    activeWorkers: 4,
    passiveWorkers: 1,
    passiveDelayMs: 0,
    respectFlashpointSettings: false,
    autoMirror: options.enabled !== false,
    prioritizePlaylists: false,
  };

  const deps = {
    log: quietLogger(),
    paths,
    readSettings: (mode) => ({ ...baseSettings, mode }),
    readDataVersion: () => ('dataVersion' in options ? options.dataVersion : '12.0'),
    loadMeta: async () => (options.meta === undefined ? meta() : options.meta),
    pendingChanges: async () => options.pendingChanges || 0,
    rebuild: async () => {
      calls.rebuild += 1;
      return options.rebuilt === undefined ? null : options.rebuilt;
    },
    prepare: async (settings, prepareOptions) => {
      calls.prepare.push({ settings, options: prepareOptions });
      if (options.prepareError) {
        throw new Error(options.prepareError);
      }
      const estimate = typeof options.estimate === 'function'
        ? options.estimate(prepareOptions)
        : options.estimate || { gamesInScope: 2, packsMissing: 2, packBytes: 400, imageEstimateBytes: 0, totalBytes: 400 };
      return {
        settings,
        changedOnly: prepareOptions && prepareOptions.changedOnly ? options.changedOnly !== false : false,
        estimate,
      };
    },
    start: async (prep) => {
      calls.start.push(prep);
      return options.startResult || { ok: true };
    },
    isRunning: () => !!options.running,
    readJob: async () => ('job' in options ? options.job : null),
  };
  return { deps, paths, calls, databaseFile };
}

test('a rebuild downloads only the games it changed', async () => {
  const { deps, calls, paths, databaseFile } = await makeDeps({
    saved: { database: '1:1', dataVersion: '12.0' },
    rebuilt: { meta: meta({ generation: 'gen-2', packsMissing: 5 }), changed: 3 },
  });

  const result = await runAutoTasks(deps);

  assert.equal(result.action, 'changed');
  assert.equal(result.started, true);
  assert.equal(result.mode, 'passive');
  assert.equal(calls.rebuild, 1);
  assert.equal(calls.prepare.length, 1);
  assert.deepEqual(calls.prepare[0].options, { changedOnly: true });
  assert.equal(calls.start.length, 1);

  const recorded = await readAutoState(paths.databaseStateFile);
  assert.equal(recorded.database, await currentDatabaseSignature(databaseFile));
});

test('a rebuild with nothing changed but packs missing starts a full pass', async () => {
  const { deps, calls } = await makeDeps({
    saved: { database: '1:1', dataVersion: '12.0' },
    rebuilt: { meta: meta({ generation: 'gen-2', packsMissing: 5 }), changed: 0 },
  });

  const result = await runAutoTasks(deps);

  assert.equal(result.action, 'pass');
  assert.equal(result.started, true);
  assert.deepEqual(calls.prepare[0].options, undefined);
});

test('a changed list with nothing left to fetch falls through to the full pass', async () => {
  const { deps, calls, paths } = await makeDeps({
    saved: { database: '1:1', dataVersion: '12.0' },
    rebuilt: { meta: meta({ generation: 'gen-2', packsMissing: 7 }), changed: 2 },
    estimate: (prepareOptions) => (prepareOptions && prepareOptions.changedOnly
      ? { gamesInScope: 2, packsMissing: 0, packBytes: 0, imageEstimateBytes: 0, totalBytes: 0 }
      : { gamesInScope: 3, packsMissing: 7, packBytes: 700, imageEstimateBytes: 0, totalBytes: 700 }),
  });
  fs.writeFileSync(paths.changedFile, JSON.stringify({ version: 1, generation: 'gen-2', entries: [] }));

  const result = await runAutoTasks(deps);

  assert.equal(result.action, 'pass');
  assert.equal(result.started, true);
  assert.equal(calls.prepare.length, 2);
  assert.equal(fs.existsSync(paths.changedFile), false, 'the handled list should be removed');
});

test('a rebuild that finds nothing to do does not start a job', async () => {
  const { deps, calls } = await makeDeps({
    saved: { database: '1:1', dataVersion: '12.0' },
    rebuilt: { meta: meta({ generation: 'gen-2', packsMissing: 0 }), changed: 0 },
  });

  const result = await runAutoTasks(deps);

  assert.equal(result.action, 'rebuild');
  assert.equal(result.started, false);
  assert.equal(calls.start.length, 0);
});

test('a failed rebuild is retried later and records nothing', async () => {
  const { deps, calls, paths } = await makeDeps({
    saved: { database: '1:1', dataVersion: '12.0' },
    rebuilt: null,
  });

  const result = await runAutoTasks(deps);

  assert.equal(result.action, 'rebuild-failed');
  assert.equal(calls.rebuild, 1);
  assert.equal(calls.start.length, 0);
  // Still the old signature, so the next check rebuilds again.
  assert.equal((await readAutoState(paths.databaseStateFile)).database, '1:1');
});

test('a saved job is resumed through the engine', async () => {
  const { deps, calls } = await makeDeps({ job: job({ mode: 'active' }) });

  const result = await runAutoTasks(deps);

  assert.equal(result.action, 'resume');
  assert.equal(result.started, true);
  assert.equal(calls.rebuild, 0);
  assert.equal(calls.prepare[0].settings.mode, 'active');
  assert.equal(calls.start.length, 1);
});

test('a new pass starts only when something is missing', async () => {
  const withMissing = await makeDeps({ meta: meta({ packsMissing: 9 }) });
  const started = await runAutoTasks(withMissing.deps);
  assert.equal(started.action, 'pass');
  assert.deepEqual(withMissing.calls.prepare[0].options, undefined);
  assert.equal(withMissing.calls.prepare[0].settings.mode, AUTO_MODE);

  const complete = await makeDeps({ meta: meta({ packsMissing: 0 }) });
  const skipped = await runAutoTasks(complete.deps);
  assert.equal(skipped.action, 'none');
  assert.equal(complete.calls.prepare.length, 0);
});

test('nothing is started when there is nothing to download or the scope is empty', async () => {
  const empty = await makeDeps({
    meta: meta({ packsMissing: 9 }),
    estimate: { gamesInScope: 2, packsMissing: 0, packBytes: 0, imageEstimateBytes: 0, totalBytes: 0 },
  });
  const onDisk = await runAutoTasks(empty.deps);
  assert.equal(onDisk.started, false);
  assert.match(onDisk.reason, /on disk/i);

  const outOfScope = await makeDeps({
    meta: meta({ packsMissing: 9 }),
    estimate: { gamesInScope: 0, packsMissing: 0, packBytes: 0, imageEstimateBytes: 0, totalBytes: 0 },
  });
  const nothing = await runAutoTasks(outOfScope.deps);
  assert.equal(nothing.started, false);
  assert.match(nothing.reason, /scope/i);
});

test('a recorded refusal pauses automatic work until a person tries again', async () => {
  const { deps, calls, paths } = await makeDeps({ meta: meta({ packsMissing: 9 }) });
  await recordDenial(paths.deniedFile, { status: 403, url: 'https://data.example/game.zip' });

  const paused = await runAutoTasks(deps);
  assert.equal(paused.action, 'none');
  assert.match(paused.reason, /refused access/);
  assert.equal(calls.prepare.length, 0);
  assert.equal(calls.start.length, 0);

  // Only an explicit act clears it; the next automatic check then works again.
  await clearDenial(paths.deniedFile);
  const resumed = await runAutoTasks(deps);
  assert.equal(resumed.action, 'pass');
  assert.equal(resumed.started, true);
});

test('a job that is already running is not started twice', async () => {
  const { deps, calls } = await makeDeps({ running: true, job: job() });
  const result = await runAutoTasks(deps);
  assert.equal(result.action, 'busy');
  assert.equal(calls.prepare.length, 0);
  assert.equal(calls.start.length, 0);
});

test('a changed list that disappeared means no start, not a full pass', async () => {
  const { deps, calls } = await makeDeps({
    job: job({ generation: 'gen-0' }),
    pendingChanges: 4,
    changedOnly: false,
  });

  const result = await runAutoTasks(deps);

  assert.equal(result.action, 'none');
  assert.equal(result.started, false);
  assert.equal(calls.start.length, 0);
});

test('a refused or failing start leaves the job alone', async () => {
  const refused = await makeDeps({ job: job(), startResult: { ok: false, reason: 'catalogue is empty' } });
  const refusedResult = await runAutoTasks(refused.deps);
  assert.equal(refusedResult.started, false);
  assert.match(refusedResult.reason, /empty/);

  const broken = await makeDeps({ job: job(), prepareError: 'no catalogue yet' });
  const brokenResult = await runAutoTasks(broken.deps);
  assert.equal(brokenResult.started, false);
  assert.match(brokenResult.reason, /no catalogue/);
});
