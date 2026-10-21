const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { HttpStatusError } = require('../dist/core/download.js');
const {
  MAX_RETRY_ATTEMPTS,
  RetryStore,
  isPermanentFailure,
  retryDelayMs,
} = require('../dist/core/retry.js');

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-retry-'));
  return path.join(dir, 'retries.json');
}

function input(overrides = {}) {
  return {
    kind: 'pack',
    gameId: 'game-1',
    title: 'Game One',
    target: 'game-1-1700000000000.zip',
    packId: 7,
    sha256: 'a'.repeat(64),
    size: 100,
    ...overrides,
  };
}

test('backs off on the same ladder every time', () => {
  assert.equal(retryDelayMs(1), 60_000);
  assert.equal(retryDelayMs(2), 5 * 60_000);
  assert.equal(retryDelayMs(3), 15 * 60_000);
  assert.equal(retryDelayMs(4), 60 * 60_000);
  assert.equal(retryDelayMs(5), 6 * 60 * 60_000);
  assert.equal(retryDelayMs(6), 24 * 60 * 60_000);
  assert.equal(retryDelayMs(50), 24 * 60 * 60_000);
  assert.equal(retryDelayMs(0), 60_000);
});

test('treats missing files and bad hashes as permanent, server errors as transient', () => {
  assert.equal(isPermanentFailure(new HttpStatusError(404, 'https://example/game.zip')), true);
  assert.equal(isPermanentFailure(new HttpStatusError(410, 'https://example/game.zip')), true);
  assert.equal(isPermanentFailure(new HttpStatusError(403, 'https://example/game.zip')), true);
  assert.equal(isPermanentFailure(new HttpStatusError(408, 'https://example/game.zip')), false);
  assert.equal(isPermanentFailure(new HttpStatusError(429, 'https://example/game.zip')), false);
  assert.equal(isPermanentFailure(new HttpStatusError(500, 'https://example/game.zip')), false);
  assert.equal(isPermanentFailure(new Error('Hash of download does not match (expected a..., got b...)')), true);
  assert.equal(isPermanentFailure(new Error('database is locked')), false);
  assert.equal(isPermanentFailure(new Error('socket hang up')), false);
});

test('schedules a retry and persists it across a reload', async () => {
  const file = tempFile();
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const store = new RetryStore(file, () => now);

  const entry = await store.recordFailure(input(), new Error('socket hang up'));

  assert.ok(entry);
  assert.equal(entry.attempts, 1);
  assert.equal(entry.nextAttemptAt, '2026-01-01T00:01:00.000Z');
  assert.equal(store.due().length, 0);
  assert.equal(store.due(now + 60_000).length, 1);
  assert.equal(store.nextDueIn(), 60_000);

  const reloaded = new RetryStore(file, () => now);
  await reloaded.load();
  assert.equal(reloaded.count(), 1);
  assert.equal(reloaded.all()[0].title, 'Game One');
  assert.equal(reloaded.all()[0].lastError, 'socket hang up');
});

test('a second failure moves the entry further out', async () => {
  const file = tempFile();
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const store = new RetryStore(file, () => now);

  await store.recordFailure(input(), new Error('socket hang up'));
  now += 60_000;
  const second = await store.recordFailure(input(), new Error('socket hang up'));

  assert.equal(second.attempts, 2);
  assert.equal(second.firstFailedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(second.nextAttemptAt, '2026-01-01T00:06:00.000Z');
  assert.equal(store.count(), 1);
});

test('success and forget remove the entry from disk', async () => {
  const file = tempFile();
  const store = new RetryStore(file);
  await store.recordFailure(input(), new Error('timeout'));
  await store.recordFailure(input({ kind: 'image', target: 'Logos/aa/game-1.png' }), new Error('timeout'));
  assert.equal(store.count(), 2);

  await store.recordSuccess('pack', 'game-1', input().target);
  assert.equal(store.count(), 1);
  await store.forget('image|game-1|Logos/aa/game-1.png');
  assert.equal(store.count(), 0);

  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved.entries, []);
});

test('a server Retry-After pushes the next attempt later than our own backoff', async () => {
  const file = tempFile();
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  const store = new RetryStore(file, () => now);

  const entry = await store.recordFailure(
    input(),
    new HttpStatusError(503, 'https://example/game.zip', 10 * 60_000),
    { minDelayMs: 600_000 },
  );

  assert.equal(entry.nextAttemptAt, '2026-01-01T00:10:00.000Z');
});

test('does not queue a permanent failure', async () => {
  const file = tempFile();
  const store = new RetryStore(file);

  const kept = await store.recordFailure(input(), new HttpStatusError(404, 'https://example/game.zip'));

  assert.equal(kept, null);
  assert.equal(store.count(), 0);
});

test('drops an entry after the attempt limit', async () => {
  const file = tempFile();
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const store = new RetryStore(file, () => now);

  let last = null;
  for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt += 1) {
    last = await store.recordFailure(input(), new Error('socket hang up'));
    now += 60_000;
  }

  assert.equal(last, null);
  assert.equal(store.count(), 0);
});

test('serialises concurrent saves without losing entries', async () => {
  const file = tempFile();
  const store = new RetryStore(file);

  await Promise.all([
    store.recordFailure(input({ gameId: 'game-a', target: 'a.zip' }), new Error('timeout')),
    store.recordFailure(input({ gameId: 'game-b', target: 'b.zip' }), new Error('timeout')),
    store.recordFailure(input({ gameId: 'game-c', target: 'c.zip' }), new Error('timeout')),
  ]);

  assert.equal(store.count(), 3);
  const reloaded = new RetryStore(file);
  await reloaded.load();
  assert.equal(reloaded.count(), 3);
  assert.deepEqual(reloaded.all().map((entry) => entry.gameId).sort(), ['game-a', 'game-b', 'game-c']);
});

test('starts empty when the file is missing or corrupt', async () => {
  const file = tempFile();
  const missing = new RetryStore(file);
  await missing.load();
  assert.equal(missing.count(), 0);

  fs.writeFileSync(file, '{not json');
  const corrupt = new RetryStore(file);
  await corrupt.load();
  assert.equal(corrupt.count(), 0);
});
