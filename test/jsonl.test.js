const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { JsonlCursor } = require('../dist/core/jsonl.js');

function tempFile(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-jsonl-'));
  const file = path.join(dir, 'data.jsonl');
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  return file;
}

test('reads every record in order', async () => {
  const records = Array.from({ length: 50 }, (_, index) => ({ id: index, text: `record ${index}` }));
  const file = tempFile(records);
  const cursor = new JsonlCursor(file, 0, 7);
  const seen = [];
  for (;;) {
    const next = await cursor.next();
    if (!next) {
      break;
    }
    seen.push(next.value);
  }
  await cursor.close();
  assert.deepEqual(seen, records);
});

test('reports startOffset and resumes exactly there', async () => {
  const records = Array.from({ length: 10 }, (_, index) => ({ id: index }));
  const file = tempFile(records);
  const first = new JsonlCursor(file, 0, 5);
  const read = [];
  for (let index = 0; index < 4; index += 1) {
    read.push(await first.next());
  }
  await first.close();

  const thirdStart = read[2].startOffset;
  const resumed = new JsonlCursor(file, thirdStart, 3);
  const rest = [];
  for (;;) {
    const next = await resumed.next();
    if (!next) {
      break;
    }
    rest.push(next.value);
  }
  await resumed.close();
  assert.deepEqual(rest, records.slice(2));
});

test('handles a final record without trailing newline', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-jsonl-'));
  const file = path.join(dir, 'tail.jsonl');
  fs.writeFileSync(file, '{"id":1}\n{"id":2}');
  const cursor = new JsonlCursor(file, 0, 4);
  const seen = [];
  for (;;) {
    const next = await cursor.next();
    if (!next) {
      break;
    }
    seen.push(next.value.id);
  }
  await cursor.close();
  assert.deepEqual(seen, [1, 2]);
});

test('returns null on an empty file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-jsonl-'));
  const file = path.join(dir, 'empty.jsonl');
  fs.writeFileSync(file, '');
  const cursor = new JsonlCursor(file);
  assert.equal(await cursor.next(), null);
  await cursor.close();
});
