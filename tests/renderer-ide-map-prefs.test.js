'use strict';

/* tests/renderer-ide-map-prefs.test.js - unit coverage for the Workspace File
 * Map persistence module extracted from the controller. No DOM: the module
 * only touches an injected { getItem, setItem } store, so a plain fake storage
 * exercises every branch. Node dragging (and its positions store) is retired
 * by the Living Atlas rework, so this module now persists only
 * { hideTests, layers } — there is no positions API to cover. */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMapPrefs, PREFS_KEY_PREFIX } = require('../renderer/features/renderer-ide-map-prefs');

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  const writes = [];
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); writes.push([key, String(value)]); },
    writes,
    _map: map,
  };
}

function makePrefs(storage, wsId = 'ws-1') {
  return createMapPrefs({ storage, getWorkspaceId: () => wsId });
}

const DEFAULTS = { hideTests: false, layers: { activity: true, health: false, deps: true } };

test('restore: absent entry yields the default shape', () => {
  const prefs = makePrefs(fakeStorage());
  assert.deepEqual(prefs.restore(), DEFAULTS);
});

test('restore: corrupt JSON is ignored, not thrown, and yields defaults', () => {
  const storage = fakeStorage({ [PREFS_KEY_PREFIX + 'ws-1']: '{not json' });
  const prefs = makePrefs(storage);
  assert.deepEqual(prefs.restore(), DEFAULTS);
});

test('restore: a well-formed blob overrides every field', () => {
  const storage = fakeStorage({
    [PREFS_KEY_PREFIX + 'ws-1']: JSON.stringify({
      hideTests: true,
      layers: { activity: false, health: true, deps: false },
    }),
  });
  const prefs = makePrefs(storage);
  assert.deepEqual(prefs.restore(), {
    hideTests: true,
    layers: { activity: false, health: true, deps: false },
  });
});

test('restore: missing individual fields fall back to their own default, not the whole blob', () => {
  const storage = fakeStorage({
    [PREFS_KEY_PREFIX + 'ws-1']: JSON.stringify({ hideTests: true, layers: { health: true } }),
  });
  const prefs = makePrefs(storage);
  assert.deepEqual(prefs.restore(), {
    hideTests: true,
    layers: { activity: true, health: true, deps: true },
  });
});

test('restore: wrong-typed fields are rejected in favor of defaults', () => {
  const storage = fakeStorage({
    [PREFS_KEY_PREFIX + 'ws-1']: JSON.stringify({ hideTests: 'yes', layers: 'nope' }),
  });
  const prefs = makePrefs(storage);
  assert.deepEqual(prefs.restore(), DEFAULTS);
});

test('restore: a pre-rework blob with stale lens/clusterExpand fields reads cleanly (ignored)', () => {
  const storage = fakeStorage({
    [PREFS_KEY_PREFIX + 'ws-1']: JSON.stringify({
      lens: 'size-cap',
      hideTests: true,
      clusterExpand: ['src/foo', 'src/bar'],
    }),
  });
  const prefs = makePrefs(storage);
  const restored = prefs.restore();
  assert.deepEqual(restored, { hideTests: true, layers: DEFAULTS.layers });
  assert.equal('lens' in restored, false, 'stale lens field must not surface');
  assert.equal('clusterExpand' in restored, false, 'stale clusterExpand field must not surface');
});

test('persistPrefs: writes the canonical { hideTests, layers } shape under the per-workspace key', () => {
  const storage = fakeStorage();
  makePrefs(storage).persistPrefs({ hideTests: true, layers: { activity: false, health: true, deps: false } });
  const raw = storage.getItem(PREFS_KEY_PREFIX + 'ws-1');
  assert.deepEqual(JSON.parse(raw), { hideTests: true, layers: { activity: false, health: true, deps: false } });
});

test('persistPrefs: never writes back stale lens/clusterExpand fields', () => {
  const storage = fakeStorage();
  makePrefs(storage).persistPrefs({ hideTests: false, layers: { activity: true, health: false, deps: true }, lens: 'architecture', clusterExpand: ['x'] });
  const raw = JSON.parse(storage.getItem(PREFS_KEY_PREFIX + 'ws-1'));
  assert.deepEqual(Object.keys(raw).sort(), ['hideTests', 'layers']);
});

test('persistPrefs -> restore round-trip preserves every field', () => {
  const storage = fakeStorage();
  const prefs = makePrefs(storage);
  const shape = { hideTests: true, layers: { activity: false, health: true, deps: true } };
  prefs.persistPrefs(shape);
  assert.deepEqual(prefs.restore(), shape);
});

test('no positions API remains on the returned controller', () => {
  const prefs = makePrefs(fakeStorage());
  assert.equal(prefs.restorePositions, undefined);
  assert.equal(prefs.persistPositions, undefined);
  assert.equal(prefs.pruneStale, undefined);
});

test('storage that throws on read/write is swallowed, degrading reads to defaults', () => {
  const throwing = {
    getItem: () => { throw new Error('opaque origin'); },
    setItem: () => { throw new Error('opaque origin'); },
  };
  const prefs = makePrefs(throwing);
  // The store IS resolved (it exposes getItem/setItem), so these calls exercise
  // the real throw-and-swallow path rather than the null-store early return.
  assert.equal(prefs.hasStorage(), true);
  // Reads degrade to the same defaults an absent entry yields.
  assert.deepEqual(prefs.restore(), DEFAULTS);
  // Writes swallow the throw and return undefined (best-effort, no value).
  assert.equal(prefs.persistPrefs({ hideTests: false, layers: DEFAULTS.layers }), undefined);
});

test('no storage available: every method is a safe no-op', () => {
  // windowRef without localStorage and no injected storage -> null store.
  const prefs = createMapPrefs({ windowRef: {}, getWorkspaceId: () => 'ws-1' });
  assert.equal(prefs.hasStorage(), false);
  assert.deepEqual(prefs.restore(), DEFAULTS);
  assert.doesNotThrow(() => prefs.persistPrefs({ hideTests: true, layers: DEFAULTS.layers }));
});

test('empty workspace id: every read/write is skipped (no canonical identity)', () => {
  const storage = fakeStorage();
  const prefs = makePrefs(storage, '');
  assert.equal(prefs.hasStorage(), false);
  prefs.persistPrefs({ hideTests: true, layers: { activity: false, health: false, deps: false } });
  assert.equal(storage.writes.length, 0, 'nothing persists under an identity-less workspace');
  assert.deepEqual(prefs.restore(), DEFAULTS);
});
