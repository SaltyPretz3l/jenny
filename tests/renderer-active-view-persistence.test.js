const test = require('node:test');
const assert = require('node:assert/strict');

const activeViewPersistence = require('../renderer/shell/renderer-active-view-persistence');

function withStorage(t, initial = {}) {
  const values = new Map(Object.entries(initial));
  const previousWindow = global.window;
  global.window = {
    localStorage: {
      getItem(key) { return values.has(key) ? values.get(key) : null; },
      setItem(key, value) { values.set(String(key), String(value)); },
    },
  };
  t.after(() => { global.window = previousWindow; });
  return values;
}

test('Memory is no longer a persistable top-level view', () => {
  assert.equal(activeViewPersistence.PERSISTABLE_VIEW_IDS.includes('memory'), false);
  assert.deepEqual(activeViewPersistence.PERSISTABLE_VIEW_IDS, ['home', 'chat', 'ide', 'logs', 'settings']);
});

test('a persisted Memory view migrates to Settings > Memory', (t) => {
  const values = withStorage(t, {
    [activeViewPersistence.ACTIVE_VIEW_STORAGE_KEY]: 'memory',
  });

  assert.equal(activeViewPersistence.readPersistedActiveView(), 'settings');
  assert.equal(values.get('jenny.settings.activeSection'), 'memories');
});

test('persistActiveView ignores the removed Memory view', (t) => {
  const values = withStorage(t);
  activeViewPersistence.persistActiveView('memory');
  assert.equal(values.has(activeViewPersistence.ACTIVE_VIEW_STORAGE_KEY), false);
});
