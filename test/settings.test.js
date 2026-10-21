const { test } = require('node:test');
const assert = require('node:assert/strict');

const { readConfiguredMode, readSettings } = require('../dist/settings.js');

function reader(values = {}) {
  return (key) => values[key];
}

test('reads the playlist priority switch and defaults it to off', () => {
  assert.equal(readSettings('active', reader()).prioritizePlaylists, false);
  assert.equal(readSettings('active', reader({ 'continuum.prioritizePlaylists': true })).prioritizePlaylists, true);
  assert.equal(readSettings('active', reader({ 'continuum.prioritizePlaylists': false })).prioritizePlaylists, false);
  // A non-boolean value falls back to the default instead of being truthy.
  assert.equal(readSettings('active', reader({ 'continuum.prioritizePlaylists': 'yes' })).prioritizePlaylists, false);
});

test('the manager mode reads the configured mode and defaults to passive', () => {
  assert.equal(readConfiguredMode(reader()), 'passive');
  assert.equal(readConfiguredMode(reader({ 'continuum.mode': 'active' })), 'active');
  assert.equal(readConfiguredMode(reader({ 'continuum.mode': 'passive' })), 'passive');
  assert.equal(readConfiguredMode(reader({ 'continuum.mode': 'nonsense' })), 'passive');
});

test('reads the automatic mirror switch and ignores the removed resume key', () => {
  assert.equal(readSettings('passive', reader()).autoMirror, false);
  assert.equal(readSettings('passive', reader({ 'continuum.autoMirror': true })).autoMirror, true);
  assert.equal(readSettings('passive', reader({ 'continuum.autoMirror': 'yes' })).autoMirror, false);
  // 0.3.0 replaced continuum.autoResume; an old true does not switch it on.
  const migrated = readSettings('passive', reader({ 'continuum.autoResume': true }));
  assert.equal(migrated.autoMirror, false);
  assert.equal('autoResume' in migrated, false);
});

test('keeps the existing defaults and clamps', () => {
  const settings = readSettings('passive', reader({
    'continuum.reserveGB': '12',
    'continuum.activeWorkers': '99',
    'continuum.passiveWorkers': '0',
    'continuum.scope': 'tag',
    'continuum.scopeValue': 'Puzzle',
  }));

  assert.equal(settings.mode, 'passive');
  assert.deepEqual(settings.scope, { kind: 'tag', value: 'Puzzle' });
  assert.equal(settings.reserveBytes, 12 * 1024 * 1024 * 1024);
  // The schedule's ceiling is 20; the enum still defaults to 4.
  assert.equal(settings.activeWorkers, 20);
  assert.equal(settings.passiveWorkers, 1);
  // Images follow the launcher's image caching preference; the removed
  // continuum.includeImages key must not have any effect.
  assert.equal(settings.includeImages, true);
  assert.equal(readSettings('passive', reader({ 'continuum.includeImages': false })).includeImages, true);
  assert.equal(settings.respectFlashpointSettings, true);
});

test('reads the respect switch and ignores the removed extreme-filter key', () => {
  assert.equal(readSettings('active', reader()).respectFlashpointSettings, true);
  assert.equal(readSettings('active', reader({ 'continuum.respectFlashpointSettings': false })).respectFlashpointSettings, false);
  // 0.2.0 replaced continuum.respectExtremeFilter; an old value does not carry over.
  const migrated = readSettings('active', reader({ 'continuum.respectExtremeFilter': false }));
  assert.equal(migrated.respectFlashpointSettings, true);
  assert.equal('respectExtremeFilter' in migrated, false);
});
