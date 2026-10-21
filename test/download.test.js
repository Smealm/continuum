const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { fetchToFile, isNotFound } = require('../dist/core/download.js');
const { sha256, startServer } = require('./helpers.js');

const payload = Buffer.from('continuum test payload '.repeat(100));
const payloadHash = sha256(payload);

function tempDest(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-dl-'));
  return path.join(dir, name);
}

test('downloads a file and verifies its hash', async () => {
  const server = await startServer({
    '/ok': (request, response) => {
      response.writeHead(200, { 'content-length': payload.length });
      response.end(payload);
    },
  });
  try {
    const dest = tempDest('file.bin');
    const progress = [];
    const result = await fetchToFile(`http://127.0.0.1:${server.port}/ok`, dest, {
      expectedSha256: payloadHash,
      onProgress: (received, total) => progress.push([received, total]),
    });
    assert.equal(result.bytes, payload.length);
    assert.equal(result.sha256, payloadHash);
    assert.deepEqual(fs.readFileSync(dest), payload);
    assert.equal(fs.existsSync(`${dest}.part`), false);
    assert.ok(progress.length > 0);
    assert.equal(progress[progress.length - 1][1], payload.length);
  } finally {
    await server.close();
  }
});

test('rejects a hash mismatch and removes the partial file', async () => {
  const server = await startServer({
    '/ok': (request, response) => {
      response.writeHead(200, { 'content-length': payload.length });
      response.end(payload);
    },
  });
  try {
    const dest = tempDest('bad.bin');
    await assert.rejects(
      fetchToFile(`http://127.0.0.1:${server.port}/ok`, dest, { expectedSha256: '0'.repeat(64) }),
      /does not match/,
    );
    assert.equal(fs.existsSync(dest), false);
    assert.equal(fs.existsSync(`${dest}.part`), false);
  } finally {
    await server.close();
  }
});

test('follows redirects', async () => {
  const server = await startServer({
    '/redirect': (request, response) => {
      response.writeHead(302, { location: '/ok' });
      response.end();
    },
    '/ok': (request, response) => {
      response.writeHead(200, { 'content-length': payload.length });
      response.end(payload);
    },
  });
  try {
    const dest = tempDest('redirect.bin');
    await fetchToFile(`http://127.0.0.1:${server.port}/redirect`, dest, { expectedSha256: payloadHash });
    assert.deepEqual(fs.readFileSync(dest), payload);
  } finally {
    await server.close();
  }
});

test('surfaces 404 as a not-found error', async () => {
  const server = await startServer({});
  try {
    const dest = tempDest('missing.bin');
    await assert.rejects(
      fetchToFile(`http://127.0.0.1:${server.port}/missing`, dest),
      (error) => isNotFound(error),
    );
    assert.equal(fs.existsSync(dest), false);
  } finally {
    await server.close();
  }
});

test('can be aborted before completing', async () => {
  const server = await startServer({
    '/slow': (request, response) => {
      response.writeHead(200, { 'content-length': 10_000 });
      response.write(Buffer.alloc(100));
      // Never end: the abort should tear it down.
    },
  });
  try {
    const dest = tempDest('slow.bin');
    const controller = new AbortController();
    const pending = fetchToFile(`http://127.0.0.1:${server.port}/slow`, dest, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(pending, /aborted/i);
    assert.equal(fs.existsSync(dest), false);
  } finally {
    await server.close();
  }
});
