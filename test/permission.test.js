const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { clearDenial, readDenial, recordDenial } = require('../dist/core/permission.js');

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-denied-'));
  return path.join(dir, 'denied.json');
}

test('a refusal is recorded with its status, url and time, and read back', async () => {
  const file = tempFile();
  const at = Date.parse('2026-01-02T03:04:05.000Z');

  const written = await recordDenial(file, { status: 403, url: 'https://example/game.zip', now: at });
  assert.equal(written.at, new Date(at).toISOString());

  const loaded = await readDenial(file);
  assert.equal(loaded.status, 403);
  assert.equal(loaded.url, 'https://example/game.zip');
  assert.equal(loaded.at, new Date(at).toISOString());
});

test('a missing marker reads as null and clearing is safe to repeat', async () => {
  const file = tempFile();
  assert.equal(await readDenial(file), null);
  await clearDenial(file);
  await clearDenial(file);

  await recordDenial(file, { status: 401 });
  assert.ok(fs.existsSync(file));
  await clearDenial(file);
  assert.equal(fs.existsSync(file), false);
  assert.equal(await readDenial(file), null);
});

test('junk or a future version is ignored instead of pausing everything', async () => {
  const file = tempFile();
  fs.writeFileSync(file, 'not json');
  assert.equal(await readDenial(file), null);

  fs.writeFileSync(file, JSON.stringify({ version: 2, at: new Date().toISOString(), status: 403 }));
  assert.equal(await readDenial(file), null);

  fs.writeFileSync(file, JSON.stringify({ version: 1, status: 403 }));
  assert.equal(await readDenial(file), null);
});
