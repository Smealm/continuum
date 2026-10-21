const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseDfAvailableKb, parsePowerShellFree } = require('../dist/core/disk.js');

test('parses PowerShell free bytes', () => {
  assert.equal(parsePowerShellFree('  123456789\r\n'), 123456789);
  assert.equal(parsePowerShellFree(''), null);
  assert.equal(parsePowerShellFree('oops'), null);
});

test('parses df available kilobytes', () => {
  const output = [
    'Filesystem     1024-blocks      Used Available Capacity Mounted on',
    '/dev/sda1        100000000  40000000  60000000      40% /',
  ].join('\n');
  assert.equal(parseDfAvailableKb(output), 60000000 * 1024);
  assert.equal(parseDfAvailableKb('garbage'), null);
});
