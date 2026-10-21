const { test } = require('node:test');
const assert = require('node:assert/strict');

const { gameDataFilename, formatBytes, formatDuration, joinUrl, parseNonNegativeInt } = require('../dist/core/format.js');

test('gameDataFilename matches the launcher for ISO timestamps', () => {
  const filename = gameDataFilename({
    gameId: '0cf31e4d-111a-3311-269c-c911c1f5200c',
    dateAdded: '2023-12-03T03:29:12.313641Z',
  });
  assert.equal(filename, '0cf31e4d-111a-3311-269c-c911c1f5200c-1701574152313.zip');
});

test('gameDataFilename handles the legacy date format', () => {
  const filename = gameDataFilename({
    gameId: 'abc',
    dateAdded: '2022-01-16 06:39:02.13',
  });
  assert.equal(filename, `abc-${Date.parse('2022-01-16 06:39:02.13 +0000 UTC')}.zip`);
});

test('gameDataFilename rejects unparseable dates', () => {
  assert.throws(() => gameDataFilename({ gameId: 'x', dateAdded: '2024-99-99T99:99:99Z' }), /Invalid dateAdded/);
});

test('formatBytes uses sensible units', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(1024), '1.00 KB');
  assert.equal(formatBytes(2262.8 * 1024 * 1024 * 1024), '2.21 TB');
});

test('formatDuration uses readable units', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(90_000), '1m 30s');
  assert.equal(formatDuration(3_661_000), '1h 01m');
  assert.equal(formatDuration(90_000_000), '1d 1h');
  assert.equal(formatDuration(-1), 'unknown');
});

test('joinUrl does not double slashes', () => {
  assert.equal(joinUrl('https://example.com/games/', 'a.zip'), 'https://example.com/games/a.zip');
  assert.equal(joinUrl('https://example.com/games', '/a.zip'), 'https://example.com/games/a.zip');
});

test('parseNonNegativeInt falls back and clamps', () => {
  assert.equal(parseNonNegativeInt('12', 5), 12);
  assert.equal(parseNonNegativeInt('-3', 5), 0);
  assert.equal(parseNonNegativeInt('nope', 5), 5);
  assert.equal(parseNonNegativeInt(undefined, 5), 5);
});
