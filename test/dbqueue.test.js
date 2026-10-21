const { test } = require('node:test');
const assert = require('node:assert/strict');

const { DbWriteQueue, isSqliteLockError } = require('../dist/core/dbqueue.js');

const silent = { debug() {}, info() {}, warn() {}, error() {} };

test('runs writes one at a time in queue order', async () => {
  const queue = new DbWriteQueue({ log: silent });
  const events = [];
  const writes = [0, 1, 2].map((index) => queue.run(`write ${index}`, async () => {
    events.push(`start ${index}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    events.push(`end ${index}`);
    return index;
  }));

  assert.deepEqual(await Promise.all(writes), [0, 1, 2]);
  assert.deepEqual(events, ['start 0', 'end 0', 'start 1', 'end 1', 'start 2', 'end 2']);
});

test('retries a locked write with a doubling delay', async () => {
  const delays = [];
  const queue = new DbWriteQueue({ log: silent, sleep: async (ms) => delays.push(ms) });
  let calls = 0;

  const value = await queue.run('flag', async () => {
    calls += 1;
    if (calls < 3) {
      throw new Error('SQLite error: database is locked');
    }
    return 'saved';
  });

  assert.equal(value, 'saved');
  assert.equal(calls, 3);
  assert.deepEqual(delays, [200, 400]);
});

test('gives up after the attempt limit and keeps accepting work', async () => {
  const queue = new DbWriteQueue({ log: silent, attempts: 3, sleep: async () => {} });
  let calls = 0;

  await assert.rejects(
    queue.run('flag', async () => {
      calls += 1;
      throw new Error('database is locked');
    }),
    /locked/,
  );
  assert.equal(calls, 3);
  assert.equal(await queue.run('next', async () => 'ok'), 'ok');
});

test('does not retry an unrelated database error', async () => {
  const queue = new DbWriteQueue({ log: silent, sleep: async () => {} });
  let calls = 0;

  await assert.rejects(
    queue.run('flag', async () => {
      calls += 1;
      throw new Error('SQLite error: no such table: game_data');
    }),
    /no such table/,
  );
  assert.equal(calls, 1);
});

test('recognises the launcher lock errors', () => {
  assert.equal(isSqliteLockError(new Error('SQLite error: database is locked')), true);
  assert.equal(isSqliteLockError(new Error('database table is locked')), true);
  assert.equal(isSqliteLockError(new Error('SQLITE_BUSY: cannot write')), true);
  assert.equal(isSqliteLockError(new Error('SQLITE_CONSTRAINT')), false);
  assert.equal(isSqliteLockError('database is locked'), true);
});
