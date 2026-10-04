'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appearanceUtils = require('../renderer/shared/appearance-utils');

const BOOTSTRAP_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'shared', 'theme-bootstrap.js'), 'utf8');
const STORAGE_KEY = 'jenny.appearance.v2';

function createStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

// One page load: the window URL carries the launch-time portable projection.
function bootPage(storage, projection) {
  const documentElement = { dataset: {}, style: { setProperty() {}, removeProperty() {} } };
  const search = projection ? `?jennyAppearance=${encodeURIComponent(JSON.stringify(projection))}` : '';
  const scope = {
    appearanceUtils,
    localStorage: storage,
    location: { search },
    document: { documentElement },
    URLSearchParams,
  };
  vm.runInNewContext(`(function () { var globalThis = this; ${BOOTSTRAP_SOURCE} }).call(scope)`, { scope, URLSearchParams });
  return documentElement.dataset;
}

function savedAppearance(storage) {
  return JSON.parse(storage.getItem(STORAGE_KEY));
}

test('a launch projection is applied once, so a reload keeps in-session appearance changes', () => {
  const storage = createStorage();
  const launchProjection = { paletteId: 'obsidian', startupAnimation: true };

  let dataset = bootPage(storage, launchProjection);
  assert.equal(dataset.startupAnimation, 'on', 'first load takes the portable projection');

  // In session: the user switches the startup animation off (Settings saves to storage).
  appearanceUtils.saveAppearancePreferences(storage, { ...savedAppearance(storage), startupAnimation: false, titlebarLoad: true });

  // Ctrl+Shift+R reloads the same URL, still carrying the launch-time projection.
  dataset = bootPage(storage, launchProjection);
  assert.equal(dataset.startupAnimation, 'off', 'the reload keeps the in-session choice');
  assert.equal(dataset.titlebarLoad, 'on');
  assert.equal(savedAppearance(storage).startupAnimation, false, 'storage is not overwritten by the stale projection');
});

test('a new launch projection (a restored or synced portable record) still wins', () => {
  const storage = createStorage();
  bootPage(storage, { paletteId: 'obsidian', startupAnimation: true });
  appearanceUtils.saveAppearancePreferences(storage, { ...savedAppearance(storage), startupAnimation: true });

  const dataset = bootPage(storage, { paletteId: 'obsidian', startupAnimation: false });
  assert.equal(dataset.startupAnimation, 'off');
  assert.equal(savedAppearance(storage).startupAnimation, false);
});

test('cleared storage takes the same projection again', () => {
  const storage = createStorage();
  const projection = { paletteId: 'obsidian', startupAnimation: false };
  bootPage(storage, projection);
  storage.removeItem(STORAGE_KEY);
  const dataset = bootPage(storage, projection);
  assert.equal(dataset.startupAnimation, 'off');
  assert.equal(savedAppearance(storage).startupAnimation, false);
});
