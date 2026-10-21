const { test } = require('node:test');
const assert = require('node:assert/strict');

const { matchesScope, scopeKey, normalizeScopeKind } = require('../dist/core/scope.js');

const game = {
  id: 'g1',
  title: 'Game',
  library: 'arcade',
  platforms: ['Flash', 'HTML5'],
  tags: ['Puzzle', 'Extreme'],
  logo: '',
  screenshot: '',
  data: [],
};

test('all scope matches everything', () => {
  assert.equal(matchesScope(game, { scope: { kind: 'all', value: '' } }), true);
});

test('platform and tag scopes are case insensitive', () => {
  assert.equal(matchesScope(game, { scope: { kind: 'platform', value: 'flash' } }), true);
  assert.equal(matchesScope(game, { scope: { kind: 'platform', value: 'unity' } }), false);
  assert.equal(matchesScope(game, { scope: { kind: 'tag', value: 'puzzle' } }), true);
  assert.equal(matchesScope(game, { scope: { kind: 'tag', value: 'racing' } }), false);
});

test('library and playlist scopes', () => {
  assert.equal(matchesScope(game, { scope: { kind: 'library', value: 'Arcade' } }), true);
  assert.equal(matchesScope(game, { scope: { kind: 'playlist', value: 'Favs' }, playlistIds: new Set(['g1']) }), true);
  assert.equal(matchesScope(game, { scope: { kind: 'playlist', value: 'Favs' }, playlistIds: new Set(['g2']) }), false);
});

test('extreme filter skips matching tags', () => {
  const filter = {
    scope: { kind: 'all', value: '' },
    excludeExtreme: true,
    extremeTags: ['extreme'],
  };
  assert.equal(matchesScope(game, filter), false);
  assert.equal(matchesScope(game, { ...filter, excludeExtreme: false }), true);
});

test('scopeKey changes with scope and image setting', () => {
  const base = scopeKey({ kind: 'all', value: '' }, true);
  assert.equal(base, scopeKey({ kind: 'all', value: '' }, true));
  assert.notEqual(base, scopeKey({ kind: 'all', value: '' }, false));
  assert.notEqual(base, scopeKey({ kind: 'platform', value: 'Flash' }, true));
});

test('unknown scope kinds normalize to all', () => {
  assert.equal(normalizeScopeKind('nonsense'), 'all');
  assert.equal(normalizeScopeKind('playlist'), 'playlist');
});
