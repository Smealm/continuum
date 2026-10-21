const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { JsonlCursor } = require('../dist/core/jsonl.js');
const { GameWindow } = require('../dist/core/window.js');

/** Write one JSON object per line and return the byte offset each record starts at. */
function writeRecords(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-window-'));
  const file = path.join(dir, 'catalog.jsonl');
  let text = '';
  const offsets = [];
  for (const record of records) {
    offsets.push(Buffer.byteLength(text, 'utf8'));
    text += `${JSON.stringify(record)}\n`;
  }
  fs.writeFileSync(file, text);
  return { file, offsets, total: Buffer.byteLength(text, 'utf8') };
}

function windowOver(file, size) {
  const cursor = new JsonlCursor(file);
  return {
    window: new GameWindow(cursor, size, (record) => record.size),
    close: () => cursor.close(),
  };
}

test('hands out the cheapest record in a bounded look-ahead, not the global cheapest', async () => {
  const { file } = writeRecords([
    { id: 'a', size: 5 },
    { id: 'b', size: 1 },
    { id: 'c', size: 9 },
    { id: 'd', size: 2 },
  ]);
  const { window, close } = windowOver(file, 2);

  const order = [];
  for (;;) {
    await window.fill();
    const item = window.take();
    if (!item) {
      break;
    }
    order.push(item.value.id);
  }

  // A two-record window sees [5,1], then [5,9], then [9,2]: the last record is
  // cheaper than the first but is not visible yet, which is the memory/safety
  // trade the window makes.
  assert.deepEqual(order, ['b', 'a', 'd', 'c']);
  assert.equal(window.finished, true);
  await close();
});

test('ties keep catalogue order', async () => {
  const { file } = writeRecords([
    { id: 'first', size: 4 },
    { id: 'second', size: 4 },
    { id: 'third', size: 4 },
  ]);
  const { window, close } = windowOver(file, 3);
  await window.fill();

  assert.deepEqual(
    [window.take().value.id, window.take().value.id, window.take().value.id],
    ['first', 'second', 'third'],
  );
  await close();
});

test('the earliest waiting record is reported for a safe resume cursor', async () => {
  const { file, offsets, total } = writeRecords([
    { id: 'a', size: 9 },
    { id: 'b', size: 1 },
    { id: 'c', size: 5 },
    { id: 'd', size: 2 },
  ]);
  const { window, close } = windowOver(file, 3);

  await window.fill();
  assert.equal(window.length, 3);
  assert.equal(window.earliestStartOffset, offsets[0], 'nothing has been handed out yet');
  assert.equal(window.endOffset, offsets[3], 'read exactly three records');

  const cheapest = window.take();
  assert.equal(cheapest.value.id, 'b');
  assert.equal(window.earliestStartOffset, offsets[0], 'a is still waiting, so the cursor stays at it');

  assert.equal(window.take().value.id, 'c');
  assert.equal(window.earliestStartOffset, offsets[0]);

  assert.equal(window.take().value.id, 'a');
  assert.equal(window.earliestStartOffset, null, 'the window is empty');

  await window.fill();
  assert.equal(window.endOffset, total, 'the fourth record was read');
  assert.equal(window.take().value.id, 'd');
  assert.equal(window.finished, true);
  await close();
});

test('an empty catalogue yields nothing and finishes', async () => {
  const { file } = writeRecords([]);
  const { window, close } = windowOver(file, 10);
  await window.fill();
  assert.equal(window.length, 0);
  assert.equal(window.take(), null);
  assert.equal(window.earliestStartOffset, null);
  assert.equal(window.finished, true);
  await close();
});

test('resuming from the earliest waiting offset re-reads only the window', async () => {
  const { file, offsets } = writeRecords([
    { id: 'a', size: 1 },
    { id: 'b', size: 2 },
    { id: 'c', size: 3 },
    { id: 'd', size: 4 },
  ]);
  const { window, close } = windowOver(file, 3);
  await window.fill();
  assert.equal(window.take().value.id, 'a');
  const resumeAt = window.earliestStartOffset;
  assert.equal(resumeAt, offsets[1], 'the cursor stays at the first game not yet handed out');

  // A crash here would resume from `resumeAt`; the records the window already
  // read are re-read, which a real run makes cheap because their files are on
  // disk, instead of the window being skipped.
  const resumedCursor = new JsonlCursor(file, resumeAt);
  const resumed = new GameWindow(resumedCursor, 3, (record) => record.size);
  await resumed.fill();
  assert.deepEqual(
    [resumed.take().value.id, resumed.take().value.id, resumed.take().value.id],
    ['b', 'c', 'd'],
  );
  await close();
  await resumedCursor.close();
});
