'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const prefs = require('../renderer/shared/session-open-pref-utils');

function withStubbedLocalStorage(run) {
  const prev = globalThis.localStorage;
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  try {
    return run(store);
  } finally {
    globalThis.localStorage = prev;
  }
}

test('defaults to false when nothing is stored', () => {
  withStubbedLocalStorage(() => {
    assert.equal(prefs.getOpenSessionsInNewTab(), false);
  });
});

test('set(true) stores "1" and reads back true; set(false) clears it', () => {
  withStubbedLocalStorage((store) => {
    prefs.setOpenSessionsInNewTab(true);
    assert.equal(store.get(prefs.STORAGE_KEY), '1');
    assert.equal(prefs.getOpenSessionsInNewTab(), true);

    prefs.setOpenSessionsInNewTab(false);
    assert.equal(store.has(prefs.STORAGE_KEY), false);
    assert.equal(prefs.getOpenSessionsInNewTab(), false);
  });
});

test('a throwing localStorage degrades reads and exposes write failure', () => {
  const prev = globalThis.localStorage;
  globalThis.localStorage = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
    removeItem() { throw new Error('blocked'); },
  };
  try {
    assert.equal(prefs.getOpenSessionsInNewTab(), false);
    assert.throws(
      () => prefs.setOpenSessionsInNewTab(true),
      /Could not save the session-opening preference/
    );
  } finally {
    globalThis.localStorage = prev;
  }
});
