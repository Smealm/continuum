const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { markInterruptedJob } = require('../dist/core/jobstate.js');

function writeJob(job) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-job-'));
  const file = path.join(dir, 'job.json');
  fs.writeFileSync(file, JSON.stringify(job));
  return file;
}

function baseJob(overrides = {}) {
  return {
    version: 1,
    generation: 'gen-1',
    scopeKey: 'all:|images=1',
    mode: 'active',
    cursor: 1234,
    bytes: 100,
    packsDone: 2,
    packsFailed: 0,
    gamesDone: 2,
    gamesFailed: 0,
    imagesDone: 1,
    status: 'running',
    message: 'Downloading (active)',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('rewrites a running job as interrupted', async () => {
  const file = writeJob(baseJob());

  const changed = await markInterruptedJob(file, Date.parse('2026-02-02T00:00:00.000Z'));

  assert.equal(changed, true);
  const job = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(job.status, 'stopped');
  assert.match(job.message, /Interrupted/);
  assert.equal(job.cursor, 1234);
  assert.equal(job.updatedAt, '2026-02-02T00:00:00.000Z');

  assert.equal(await markInterruptedJob(file), false);
});

test('leaves paused, stopped and finished jobs untouched', async () => {
  for (const status of ['paused', 'stopped', 'done', 'error', 'idle']) {
    const file = writeJob(baseJob({ status, message: `was ${status}` }));
    assert.equal(await markInterruptedJob(file), false);
    const job = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(job.status, status);
    assert.equal(job.message, `was ${status}`);
  }
});

test('does nothing when there is no job file', async () => {
  assert.equal(await markInterruptedJob(path.join(os.tmpdir(), 'continuum-none', 'job.json')), false);
});
