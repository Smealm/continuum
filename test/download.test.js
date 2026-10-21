const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CONTINUUM_USER_AGENT,
  HttpStatusError,
  closeDownloadConnections,
  fetchToFile,
  isNotFound,
  isPermissionDenied,
  parseRetryAfter,
  retryAfterMsOf,
} = require('../dist/core/download.js');
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

test('identifies itself as Continuum so a host can block it', async () => {
  let seen = null;
  const server = await startServer({
    '/ok': (request, response) => {
      seen = request.headers['user-agent'];
      response.writeHead(200, { 'content-length': payload.length });
      response.end(payload);
    },
  });
  try {
    await fetchToFile(`http://127.0.0.1:${server.port}/ok`, tempDest('ua.bin'));
    assert.equal(seen, CONTINUUM_USER_AGENT);
    assert.match(seen, /^Continuum\/\d+\.\d+\.\d+ /);
    assert.match(seen, /Flashpoint/);
    assert.match(seen, /github\.com\/Smealm\/continuum/);
  } finally {
    await server.close();
  }
});

test('reuses connections instead of a handshake per file', async () => {
  let connections = 0;
  const server = await startServer({
    '/small': (request, response) => {
      response.writeHead(200, { 'content-length': 4 });
      response.end('tiny');
    },
  });
  server.server.on('connection', () => { connections += 1; });
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-keepalive-'));
    for (let index = 0; index < 4; index += 1) {
      await fetchToFile(`http://127.0.0.1:${server.port}/small`, path.join(dir, `file-${index}.bin`));
    }
    assert.equal(connections, 1);
  } finally {
    closeDownloadConnections();
    await server.close();
  }
});

test('surfaces Retry-After so a busy server is not hit again immediately', async () => {
  const server = await startServer({
    '/busy': (request, response) => {
      response.writeHead(429, { 'retry-after': '120' });
      response.end();
    },
    '/full': (request, response) => {
      response.writeHead(503, { 'retry-after': new Date(Date.now() + 60_000).toUTCString() });
      response.end();
    },
  });
  try {
    await assert.rejects(
      fetchToFile(`http://127.0.0.1:${server.port}/busy`, tempDest('busy.bin')),
      (error) => error instanceof HttpStatusError
        && error.status === 429
        && retryAfterMsOf(error) === 120_000,
    );
    await assert.rejects(
      fetchToFile(`http://127.0.0.1:${server.port}/full`, tempDest('full.bin')),
      (error) => error instanceof HttpStatusError
        && error.status === 503
        && retryAfterMsOf(error) >= 55_000
        && retryAfterMsOf(error) <= 65_000,
    );
  } finally {
    await server.close();
  }
});

test('parses both Retry-After forms and ignores nonsense', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  assert.equal(parseRetryAfter('30', now), 30_000);
  assert.equal(parseRetryAfter('0', now), 0);
  assert.equal(parseRetryAfter('soon', now), undefined);
  assert.equal(parseRetryAfter(undefined, now), undefined);
  assert.equal(parseRetryAfter('', now), undefined);
  assert.equal(parseRetryAfter('-5', now), undefined);
  assert.equal(parseRetryAfter(['45'], now), 45_000);
  assert.equal(parseRetryAfter('999999999', now), 24 * 60 * 60 * 1000);
  assert.equal(parseRetryAfter(new Date(now + 10_000).toUTCString(), now), 10_000);
});

test('a refusal is not just another failure', () => {
  assert.equal(isPermissionDenied(new HttpStatusError(401, 'https://example/a.zip')), true);
  assert.equal(isPermissionDenied(new HttpStatusError(403, 'https://example/a.zip')), true);
  assert.equal(isPermissionDenied(new HttpStatusError(404, 'https://example/a.zip')), false);
  assert.equal(isPermissionDenied(new HttpStatusError(500, 'https://example/a.zip')), false);
  assert.equal(isPermissionDenied(new Error('socket hang up')), false);
});

/**
 * Measures the assumption behind the adaptive controller: when each request is
 * dominated by latency rather than bandwidth, more connections really do finish
 * more files per second.
 */
test('parallel downloads beat a single connection when latency dominates', async () => {
  const body = Buffer.alloc(2048);
  const server = await startServer({
    '/latency': (request, response) => {
      setTimeout(() => {
        response.writeHead(200, { 'content-length': body.length });
        response.end(body);
      }, 100);
    },
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-latency-'));
  const fetchOne = (name) => fetchToFile(
    `http://127.0.0.1:${server.port}/latency`,
    path.join(dir, name),
  );
  const run = async (width) => {
    const started = Date.now();
    if (width === 1) {
      for (let index = 0; index < 8; index += 1) {
        await fetchOne(`serial-${index}.bin`);
      }
    } else {
      await Promise.all(Array.from({ length: 8 }, (_, index) => fetchOne(`parallel-${index}.bin`)));
    }
    return Date.now() - started;
  };
  try {
    // Warm the pooled connection so the second run measures downloads, not a
    // handshake.
    await fetchOne('warmup.bin');
    const serial = await run(1);
    const parallel = await run(8);
    assert.ok(parallel < serial / 2, `expected 8 connections (${parallel}ms) to finish well under half of 1 (${serial}ms)`);
  } finally {
    closeDownloadConnections();
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
