const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ActivityTracker } = require('../dist/core/activity.js');
const { progressBar } = require('../dist/core/format.js');
const {
  buildCatalogueMessage,
  buildCleanupMessage,
  buildSettingsMessage,
  buildStatusCard,
  cleanupFlow,
  describeCatalogSource,
  managerActionLabel,
  openManager,
  packsToDelete,
  reportCatalogueRebuild,
  scanCatalogue,
  startFlow,
} = require('../dist/manager.js');
const { quietLogger, tempProject } = require('./helpers.js');

function meta(source, games = 3) {
  return {
    version: 1,
    generation: 'gen-1',
    scannedAt: '2024-01-01T00:00:00.000Z',
    tagsTotal: 2,
    tagsScanned: 2,
    games,
    packs: games,
    packsMissing: 0,
    bytesTotal: 0,
    bytesMissing: 0,
    images: 0,
    complete: true,
    tagOrder: [],
    source,
  };
}

function makeCtx({ fast = null, fastEnabled = true, fastError = null, tagError = null } = {}) {
  const calls = { fast: 0, tags: 0, dialogs: [], tasks: [] };
  const ctx = {
    log: quietLogger(),
    activity: new ActivityTracker(),
    fastCatalog: fast === null && fastError === null ? null : {
      scan: async () => {
        calls.fast += 1;
        if (fastError) {
          throw fastError;
        }
        return fast;
      },
    },
    readFastCatalogue: () => fastEnabled,
    engine: { isRunning: () => false },
    catalog: {
      scan: async () => {
        calls.tags += 1;
        if (tagError) {
          throw tagError;
        }
        return meta('api', 7);
      },
      loadMeta: async () => null,
    },
    fp: {
      status: {
        newTask: (task) => {
          calls.tasks.push({ ...task });
          return { id: 'task-1' };
        },
        setTask: (update) => calls.tasks.push(update),
      },
      dialogs: {
        showMessageBox: async (options) => {
          calls.dialogs.push(options);
          return 0;
        },
      },
    },
  };
  return { ctx, calls };
}

function settings(overrides = {}) {
  return {
    mode: 'passive',
    scope: { kind: 'all', value: '' },
    includeImages: true,
    reserveBytes: 5 * 1024 ** 3,
    maxBytes: 0,
    activeWorkers: 4,
    passiveWorkers: 1,
    passiveDelayMs: 750,
    respectFlashpointSettings: true,
    autoMirror: false,
    prioritizePlaylists: false,
    ...overrides,
  };
}

function job(overrides = {}) {
  return {
    version: 1,
    generation: 'gen-1',
    scopeKey: 'all|images',
    mode: 'passive',
    cursor: 10,
    bytes: 2 * 1024 ** 3,
    packsDone: 12,
    packsFailed: 1,
    gamesDone: 10,
    gamesFailed: 1,
    imagesDone: 0,
    status: 'running',
    message: '',
    updatedAt: new Date('2024-01-01T00:00:00.000Z').toISOString(),
    ...overrides,
  };
}

function statusCard(overrides = {}) {
  return buildStatusCard({
    status: 'running',
    catalogueBusy: false,
    meta: meta('database'),
    job: job(),
    percent: 0.5,
    sessionBytes: 1024 ** 3,
    estimateBytes: 2 * 1024 ** 3,
    retryPending: 2,
    freeBytes: 500 * 1024 ** 3,
    reserveBytes: 5 * 1024 ** 3,
    ...overrides,
  });
}

test('the manager card is five lines: state, catalogue, job, progress, free space', () => {
  const card = statusCard();
  const lines = card.split('\n');

  assert.equal(lines.length, 5);
  assert.match(lines[0], /^Continuum — downloading$/);
  assert.match(lines[1], /^Catalogue: 3 games · 3 packs · launcher database · built /);
  assert.match(lines[2], /^Job: running · passive · 10 games · 12 packs · 2\.00 GB · 1 failed · 2 waiting to retry$/);
  assert.match(lines[3], /^Progress: ████████░░░░░░░░ 50% · 1\.00 GB of 2\.00 GB$/);
  assert.match(lines[4], /^Free space: 500 GB \(keeping 5\.00 GB\)$/);
});

test('the manager card copes with no catalogue, no job and no free space', () => {
  const card = statusCard({ meta: null, job: null, freeBytes: null, status: 'idle' });
  const lines = card.split('\n');

  assert.equal(lines.length, 4);
  assert.match(card, /Continuum — idle/);
  assert.match(card, /Catalogue: not built yet/);
  assert.match(card, /Job: none saved/);
  assert.match(card, /Free space: unavailable/);
  assert.doesNotMatch(card, /Progress:/);
});

test('the manager card shows a rebuild, a full bar and an error message', () => {
  const rebuilding = statusCard({ catalogueBusy: true, status: 'idle' });
  assert.match(rebuilding, /Continuum — rebuilding the catalogue/);

  const finished = statusCard({
    status: 'done',
    percent: 1,
    sessionBytes: 2 * 1024 ** 3,
    retryPending: 0,
    job: job({ status: 'done', packsFailed: 0, gamesFailed: 0 }),
  });
  assert.match(finished, /Continuum — finished/);
  assert.match(finished, /Progress: ████████████████ 100%/);
  assert.doesNotMatch(finished, /waiting to retry/);

  const failed = statusCard({ status: 'error', job: job({ status: 'error' }), message: 'disk is full\nagain' });
  assert.match(failed, /Job: error · disk is full again/);
});

test('the progress bar is clamped and exactly as wide as asked', () => {
  assert.equal(progressBar(0), '░'.repeat(16));
  assert.equal(progressBar(0.5), `${'█'.repeat(8)}${'░'.repeat(8)}`);
  assert.equal(progressBar(1), '█'.repeat(16));
  assert.equal(progressBar(-3), '░'.repeat(16));
  assert.equal(progressBar(4), '█'.repeat(16));
  assert.equal(progressBar(Number.NaN), '░'.repeat(16));
  assert.equal(progressBar(0.5, 4), '██░░');
});

test('the one button reads Pause, Resume or Start', () => {
  assert.equal(managerActionLabel('running', job()), 'Pause');
  assert.equal(managerActionLabel('idle', job({ status: 'paused' })), 'Resume');
  assert.equal(managerActionLabel('idle', job({ status: 'stopped' })), 'Resume');
  assert.equal(managerActionLabel('idle', job({ status: 'done' })), 'Start');
  assert.equal(managerActionLabel('error', job({ status: 'error' })), 'Start');
  assert.equal(managerActionLabel('idle', null), 'Start');
});

test('the catalogue dialog shows totals, source, build time and the last diff', () => {
  const report = {
    version: 1,
    generation: 'gen-1',
    updatedAt: '2024-01-02T00:00:00.000Z',
    summary: 'Since the last build: 2 new game(s), 1 removed upstream, 0 data pack(s) updated.',
    changed: 2,
  };
  const text = buildCatalogueMessage(meta('database'), report, 'Fast build: on.');

  assert.match(text, /^Catalogue\n3 games · 3 packs · 0 packs missing \(0 B\)/);
  assert.match(text, /Built .* from the launcher database\./);
  assert.match(text, /Last change: Since the last build: 2 new game\(s\), 1 removed upstream/);
  assert.match(text, /Fast build: on\./);

  assert.match(buildCatalogueMessage(meta('api'), null, 'Fast build: off.'), /from the tag scan/);
  assert.match(buildCatalogueMessage(meta('api'), null, 'x'), /No rebuild comparison has been saved yet/);
  assert.match(
    buildCatalogueMessage(meta('api'), { ...report, summary: '' }, 'x'),
    /no previous catalogue to compare with/,
  );
  const empty = buildCatalogueMessage(null, null, 'Fast build: on.');
  assert.match(empty, /Not built yet\./);
  assert.match(empty, /Fast build: on\./);
});

test('the settings dialog explains each setting and where to change it', () => {
  const text = buildSettingsMessage(
    settings({ autoMirror: true, prioritizePlaylists: true }),
    { fastBuild: 'on' },
  );

  assert.match(text, /Values live on the launcher's Config → Continuum - Offline Mirror page/);
  assert.match(text, /cannot change them/);
  assert.match(text, /Mode: passive/);
  assert.match(text, /Scope: the whole archive/);
  assert.match(text, /Logos and screenshots: follow the launcher's image caching setting/);
  assert.match(text, /Launcher settings: followed/);
  assert.match(text, /Fast catalogue build: on/);
  assert.match(text, /SQLite Tool Path: optional path to sqlite3/);
  assert.match(text, /Keep free space: 5\.00 GB/);
  assert.match(text, /Download limit: none/);
  assert.match(text, /Workers: 4 active, 1 passive/);
  assert.match(text, /Playlist games first: on/);
  assert.match(text, /Automatic: on/);
  assert.match(text, /Reset saved progress forgets the saved cursor/);
});

test('the settings dialog says images are cached when the launcher is ignored', () => {
  const text = buildSettingsMessage(settings({ respectFlashpointSettings: false }));

  assert.match(text, /Logos and screenshots: cached/);
  assert.match(text, /Launcher settings: ignored/);
});

function prep(overrides = {}) {
  return {
    settings: settings(),
    meta: meta('database'),
    filter: { scope: { kind: 'all', value: '' } },
    estimate: { gamesInScope: 3, packsMissing: 3, packBytes: 100, imageEstimateBytes: 0, totalBytes: 100 },
    freeBytes: 10 * 1024 ** 3,
    fits: true,
    warnings: [],
    job: job({ status: 'stopped' }),
    resumable: false,
    changedOnly: false,
    changed: null,
    ...overrides,
  };
}

function startCtx(prepared, { choice = 0 } = {}) {
  const calls = { dialogs: [], prepare: [], start: [] };
  const ctx = {
    log: quietLogger(),
    paths: {},
    activity: new ActivityTracker(),
    catalog: { loadMeta: async () => prepared.meta, scan: async () => prepared.meta },
    readSettings: (mode) => ({ ...settings(), mode }),
    readMode: () => 'passive',
    engine: {
      isRunning: () => false,
      prepare: async (settingsValue) => {
        calls.prepare.push(settingsValue);
        return prepared;
      },
      start: async (value) => {
        calls.start.push(value);
        return { ok: true };
      },
    },
    fp: {
      status: { newTask: () => ({ id: 'task-1' }), setTask: () => {} },
      dialogs: {
        showMessageBox: async (options) => {
          calls.dialogs.push(options);
          return choice;
        },
      },
    },
  };
  return { ctx, calls };
}

test('a new pass asks about size and disk space before starting', async () => {
  const { ctx, calls } = startCtx(prep());

  await startFlow(ctx, 'passive');

  assert.equal(calls.dialogs.length, 1);
  assert.deepEqual(calls.dialogs[0].buttons, ['Start', 'Cancel']);
  assert.match(calls.dialogs[0].message, /Continuum - passive download/);
  assert.match(calls.dialogs[0].message, /Estimated total: 100 B/);
  assert.equal(calls.start.length, 1);
});

test('resuming a saved job starts it without asking again', async () => {
  const { ctx, calls } = startCtx(prep({ resumable: true }));

  await startFlow(ctx, 'passive');

  assert.equal(calls.dialogs.length, 0);
  assert.equal(calls.start.length, 1);
});

test('Start waits while the catalogue is being rebuilt', async () => {
  const { ctx, calls } = startCtx(prep());
  ctx.activity.begin('catalogue');

  await startFlow(ctx, 'passive');

  assert.equal(calls.prepare.length, 0);
  assert.equal(calls.start.length, 0);
  assert.equal(calls.dialogs.length, 1);
  assert.match(calls.dialogs[0].message, /catalogue rebuild is running/i);
});

test('a cancelled Start dialog starts nothing', async () => {
  const { ctx, calls } = startCtx(prep(), { choice: 1 });

  await startFlow(ctx, 'passive');

  assert.equal(calls.dialogs.length, 1);
  assert.equal(calls.start.length, 0);
});

test('a recorded refusal asks before trying again and clears only on consent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-manager-denied-'));
  const deniedFile = path.join(dir, 'denied.json');
  const { readDenial, recordDenial } = require('../dist/core/permission.js');
  await recordDenial(deniedFile, { status: 403, url: 'https://data.example/game.zip' });

  const cancelled = startCtx(prep(), { choice: 1 });
  cancelled.ctx.paths.deniedFile = deniedFile;
  await startFlow(cancelled.ctx, 'passive');

  assert.match(cancelled.calls.dialogs[0].message, /refused Continuum access \(HTTP 403\)/);
  assert.match(cancelled.calls.dialogs[0].message, /blacklist/);
  assert.deepEqual(cancelled.calls.dialogs[0].buttons, ['Try again', 'Cancel']);
  assert.equal(cancelled.calls.start.length, 0);
  assert.ok(await readDenial(deniedFile), 'cancelling keeps the refusal recorded');

  const retried = startCtx(prep(), { choice: 0 });
  retried.ctx.paths.deniedFile = deniedFile;
  await startFlow(retried.ctx, 'passive');

  assert.equal(retried.calls.dialogs.length, 2, 'try again, then the normal start confirmation');
  assert.equal(retried.calls.start.length, 1);
  assert.equal(await readDenial(deniedFile), null);
});

function snapshot(overrides = {}) {
  return {
    status: 'idle',
    message: '',
    mode: null,
    job: null,
    meta: null,
    live: null,
    settings: null,
    progress: { sessionBytes: 0, estimateBytes: 0, percent: 0 },
    startedAt: null,
    retryPending: 0,
    ...overrides,
  };
}

function managerCtx({ snap = snapshot(), script = [], metaValue = meta('database'), report = null } = {}) {
  const project = tempProject();
  const paths = {
    jobFile: path.join(project.paths.stateDir, 'missing-job.json'),
    rebuildReportFile: project.paths.rebuildReportFile,
    dataPacksDir: '.',
  };
  if (report) {
    fs.writeFileSync(paths.rebuildReportFile, JSON.stringify(report));
  }
  const dialogs = [];
  const starts = [];
  let call = 0;
  const ctx = {
    log: quietLogger(),
    paths,
    activity: new ActivityTracker(),
    readFastCatalogue: () => true,
    fastCatalog: {},
    catalog: { loadMeta: async () => metaValue },
    probeFreeBytes: async () => 500 * 1024 ** 3,
    readSettings: (mode) => ({ ...settings(), mode }),
    readMode: () => 'passive',
    engine: {
      snapshot: () => snap,
      pause: () => false,
      isRunning: () => snap.status === 'running',
      prepare: async () => prep(),
      start: async (value) => {
        starts.push(value);
        return { ok: true };
      },
    },
    fp: {
      status: { newTask: () => ({ id: 'task-1' }), setTask: () => {} },
      dialogs: {
        showMessageBox: async (options) => {
          dialogs.push(options);
          const value = script[call];
          call += 1;
          return value === undefined ? options.buttons.length - 1 : value;
        },
      },
    },
  };
  return { ctx, dialogs, starts };
}

test('the manager is one card with Start/Pause, progress, catalogue, settings and close', async () => {
  const saved = job({ status: 'stopped' });
  const { ctx, dialogs } = managerCtx({
    snap: snapshot({ job: saved }),
    script: [4],
  });

  await openManager(ctx);

  assert.equal(dialogs.length, 1);
  assert.deepEqual(dialogs[0].buttons, ['Resume', 'Live progress', 'Catalogue', 'Settings', 'Close']);
  assert.equal(dialogs[0].buttons.length, 5);
  assert.ok(dialogs[0].message.split('\n').length <= 5);
  assert.match(dialogs[0].message, /Job: stopped/);
});

test('the manager opens the catalogue and settings submenus and closes', async () => {
  const { ctx, dialogs } = managerCtx({
    script: [2, 2, 3, 1, 4],
    report: {
      version: 1,
      generation: 'gen-1',
      updatedAt: '2024-01-02T00:00:00.000Z',
      summary: 'Since the last build: 1 new game(s), 0 removed upstream, 0 data pack(s) updated.',
      changed: 1,
    },
  });

  await openManager(ctx);

  assert.equal(dialogs.length, 5);
  assert.deepEqual(dialogs[0].buttons, ['Start', 'Live progress', 'Catalogue', 'Settings', 'Close']);
  assert.deepEqual(dialogs[1].buttons, ['Rebuild catalogue', 'Clean up old game files', 'Back']);
  assert.match(dialogs[1].message, /^Catalogue\n/);
  assert.match(dialogs[1].message, /from the launcher database/);
  assert.match(dialogs[1].message, /Last change: Since the last build: 1 new game\(s\)/);
  assert.deepEqual(dialogs[3].buttons, ['Reset saved progress', 'Back']);
  assert.match(dialogs[3].message, /Values live on the launcher/);
  assert.match(dialogs[3].message, /Fast catalogue build: on/);
});

test('uses the database build when it is enabled and available', async () => {
  const fastMeta = meta('database', 221288);
  const { ctx, calls } = makeCtx({ fast: fastMeta });

  const result = await scanCatalogue(ctx);

  assert.equal(result, fastMeta);
  assert.equal(calls.fast, 1);
  assert.equal(calls.tags, 0);
  assert.equal(calls.dialogs.length, 0);
  assert.equal(calls.tasks[0].status, 'Reading the launcher database...');
  assert.equal(calls.tasks[calls.tasks.length - 1].finished, true);
  assert.equal(ctx.activity.snapshot().running, false);
  assert.match(ctx.activity.snapshot().outcome, /221,288 games/);
});

test('uses the tag scan when the fast build is switched off', async () => {
  const { ctx, calls } = makeCtx({ fast: meta('database'), fastEnabled: false });

  const result = await scanCatalogue(ctx);

  assert.equal(result.games, 7);
  assert.equal(calls.fast, 0);
  assert.equal(calls.tags, 1);
  assert.equal(calls.tasks[0].status, 'Reading tags...');
});

test('falls back to the tag scan when the database read fails', async () => {
  const { ctx, calls } = makeCtx({
    fastError: new Error('The launcher database does not have the expected shape (3 of 8 tables).'),
  });

  const result = await scanCatalogue(ctx);

  assert.equal(result.games, 7);
  assert.equal(calls.fast, 1);
  assert.equal(calls.tags, 1);
  assert.equal(calls.dialogs.length, 1);
  assert.match(calls.dialogs[0].message, /Continuing with the tag scan/);
  assert.match(calls.dialogs[0].message, /expected shape/);
});

test('a cancelled database read does not fall back or start over', async () => {
  const { ctx, calls } = makeCtx({ fastError: new Error('Catalogue scan cancelled') });

  const result = await scanCatalogue(ctx);

  assert.equal(result, null);
  assert.equal(calls.fast, 1);
  assert.equal(calls.tags, 0);
  assert.match(calls.dialogs[0].message, /Catalogue rebuild failed/);
  assert.equal(ctx.activity.snapshot().error, 'Catalogue scan cancelled');
});

test('describes the cleanup before anything is deleted', () => {
  const text = buildCleanupMessage({
    items: [{ filename: 'gone-1.zip', bytes: 1024, superseded: false }],
    bytes: 1024,
    supersededItems: [{ filename: 'kept-1.zip', bytes: 2048, superseded: true }],
    supersededBytes: 2048,
    tooNew: 3,
    ignored: 0,
  });

  assert.match(text, /Games no longer in Flashpoint: 1 file\(s\)/);
  assert.match(text, /Older versions of games that still exist: 1 file\(s\)/);
  assert.match(text, /Use the second option to include those/);
  assert.match(text, /3 unreferenced file\(s\) are less than 24 hours old/);
  assert.match(text, /nothing in the launcher database is changed/);
});

test('the cleanup choice never deletes more than it listed', () => {
  const removed = [{ filename: 'gone-1.zip', bytes: 1, superseded: false }];
  const superseded = [{ filename: 'kept-1.zip', bytes: 2, superseded: true }];
  const both = {
    items: removed,
    bytes: 1,
    supersededItems: superseded,
    supersededBytes: 2,
    tooNew: 0,
    ignored: 0,
  };

  assert.deepEqual(packsToDelete(both, 0), removed);
  assert.deepEqual(packsToDelete(both, 1), [...removed, ...superseded]);
  // Only older versions exist: the single Delete button removes those.
  assert.deepEqual(packsToDelete({ ...both, items: [], bytes: 0 }, 0), superseded);
  // Only removed games exist: even a "both" choice cannot invent superseded files.
  assert.deepEqual(packsToDelete({ ...both, supersededItems: [], supersededBytes: 0 }, 1), removed);
});

test('the cleanup dialog says when only older versions are left', () => {
  const text = buildCleanupMessage({
    items: [],
    bytes: 0,
    supersededItems: [{ filename: 'kept-1.zip', bytes: 2048, superseded: true }],
    supersededBytes: 2048,
    tooNew: 0,
    ignored: 0,
  });

  assert.match(text, /No removed game has files left behind/);
  assert.doesNotMatch(text, /less than 24 hours old/);
});

function catalogueRecord(id, dateAdded) {
  return {
    id,
    title: `Game ${id}`,
    library: 'arcade',
    platforms: [],
    tags: [],
    logo: '',
    screenshot: '',
    data: [{ id: 1, gameId: id, sha256: 'a'.repeat(64), size: 10, dateAdded, present: false }],
  };
}

function cleanupCtx(paths, { running = false, choice = 0 } = {}) {
  const dialogs = [];
  const ctx = {
    log: quietLogger(),
    paths,
    catalog: { loadMeta: async () => ({ games: 1 }) },
    engine: { isRunning: () => running },
    fp: {
      status: { newTask: () => ({ id: 'task-1' }), setTask: () => {} },
      dialogs: {
        showMessageBox: async (options) => {
          dialogs.push(options);
          return dialogs.length === 1 ? choice : 0;
        },
      },
    },
  };
  return { ctx, dialogs };
}

function orphanSetup() {
  const { paths } = tempProject();
  fs.writeFileSync(
    paths.catalogFile,
    `${JSON.stringify(catalogueRecord('kept', '2024-01-01T00:00:00.000Z'))}\n`,
  );
  const orphan = path.join(paths.dataPacksDir, 'gone-1700000000000.zip');
  fs.writeFileSync(orphan, Buffer.alloc(30, 1));
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  fs.utimesSync(orphan, old, old);
  return { paths, orphan };
}

test('a rebuild keeps its diff summary for the catalogue dialog', async () => {
  const { paths } = tempProject();
  const kept = catalogueRecord('kept', '2024-01-01T00:00:00.000Z');
  fs.writeFileSync(paths.catalogPreviousFile, `${JSON.stringify(kept)}\n`);
  fs.writeFileSync(
    paths.catalogFile,
    `${JSON.stringify(kept)}\n${JSON.stringify(catalogueRecord('added', '2024-02-01T00:00:00.000Z'))}\n`,
  );
  const ctx = {
    log: quietLogger(),
    paths,
    fp: {
      status: { newTask: () => ({ id: 'task-1' }), setTask: () => {} },
    },
  };

  const report = await reportCatalogueRebuild(ctx, meta('database'));

  assert.equal(report.changed, 1);
  assert.match(report.summary, /1 new game\(s\)/);
  const saved = JSON.parse(fs.readFileSync(paths.rebuildReportFile, 'utf8'));
  assert.equal(saved.version, 1);
  assert.equal(saved.generation, 'gen-1');
  assert.equal(saved.changed, 1);
  assert.match(saved.summary, /Since the last build: 1 new game\(s\)/);
  // The same list drives the next changed-only pass.
  const changed = JSON.parse(fs.readFileSync(paths.changedFile, 'utf8'));
  assert.deepEqual(changed.entries.map((entry) => entry.id), ['added']);
});

test('the cleanup flow deletes only after the dialog is accepted', async () => {
  const { paths, orphan } = orphanSetup();
  const { ctx, dialogs } = cleanupCtx(paths, { choice: 0 });

  await cleanupFlow(ctx);

  assert.equal(dialogs.length, 2);
  assert.match(dialogs[0].message, /Games no longer in Flashpoint: 1 file\(s\)/);
  assert.deepEqual(dialogs[0].buttons, ['Delete', 'Cancel']);
  assert.match(dialogs[1].message, /Deleted 1 file\(s\)/);
  assert.equal(fs.existsSync(orphan), false);
});

test('cancelling the cleanup deletes nothing', async () => {
  const { paths, orphan } = orphanSetup();
  const { ctx, dialogs } = cleanupCtx(paths, { choice: 1 });

  await cleanupFlow(ctx);

  assert.equal(dialogs.length, 1);
  assert.equal(fs.existsSync(orphan), true);
});

test('the cleanup refuses to run while a job is downloading', async () => {
  const { paths, orphan } = orphanSetup();
  const { ctx, dialogs } = cleanupCtx(paths, { running: true });

  await cleanupFlow(ctx);

  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0].message, /Pause or stop the current download/);
  assert.equal(fs.existsSync(orphan), true);
});

test('reports how the next rebuild will run', () => {
  const fast = makeCtx({ fast: meta('database') }).ctx;
  assert.match(describeCatalogSource(fast), /Fast build: on/);

  const off = makeCtx({ fast: meta('database'), fastEnabled: false }).ctx;
  assert.match(describeCatalogSource(off), /switched off/);

  const missing = makeCtx({ fastEnabled: true }).ctx;
  assert.match(describeCatalogSource(missing), /unavailable/);
});
