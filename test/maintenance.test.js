const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { sweepPartFiles } = require('../dist/core/maintenance.js');

test('removes stale part files and leaves everything else alone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-sweep-'));
  const now = Date.now();
  const stale = path.join(dir, 'game-1-123.zip.part');
  const fresh = path.join(dir, 'game-2-456.zip.part');
  const pack = path.join(dir, 'game-1-123.zip');
  fs.writeFileSync(stale, 'old');
  fs.writeFileSync(fresh, 'new');
  fs.writeFileSync(pack, 'pack');
  const old = new Date(now - 60 * 60_000);
  fs.utimesSync(stale, old, old);

  const removed = await sweepPartFiles(dir, { now });

  assert.equal(removed, 1);
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(fs.existsSync(pack), true);
});

test('treats a missing folder as nothing to clean', async () => {
  const removed = await sweepPartFiles(path.join(os.tmpdir(), 'continuum-nope-does-not-exist'), {});
  assert.equal(removed, 0);
});
