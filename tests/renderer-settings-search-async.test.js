'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  buildSettingsSearchBoxMarkup,
  createSettingsSearchController,
} = require('../renderer/shell/renderer-settings-search.js');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function createHarness(getSectionRefreshPromise) {
  const dom = new JSDOM(`
    <nav class="settings-nav"><div class="settings-nav-header"></div></nav>
    <section class="settings-card" data-settings-section="context">
      <div data-settings-field="contextHistoryScopeSelect"></div>
    </section>
  `, { pretendToBeVisual: true });
  const documentRef = dom.window.document;
  documentRef.querySelector('.settings-nav-header').insertAdjacentHTML('beforeend', buildSettingsSearchBoxMarkup());
  const controller = createSettingsSearchController({
    documentRef,
    settingsNav: documentRef.querySelector('.settings-nav'),
    navigateToSection() {},
    getSectionRefreshPromise,
  });
  controller.bind();
  controller.runQuery('history scope');
  return { dom, documentRef, controller };
}

function activateFirstHit(harness) {
  const input = harness.documentRef.getElementById('settingsSearchInput');
  input.dispatchEvent(new harness.dom.window.KeyboardEvent('keydown', {
    key: 'Enter', bubbles: true, cancelable: true,
  }));
}

test('rejected lazy refresh uses a handled continuation and still flashes the hit', async (t) => {
  const failure = new Error('lazy refresh failed');
  const pending = Promise.reject(failure);
  pending.catch(() => {});
  let finallyCalls = 0;
  pending.finally = (callback) => {
    finallyCalls += 1;
    callback();
    const derived = Promise.reject(failure);
    derived.catch(() => {});
    return derived;
  };
  const harness = createHarness(() => pending);
  t.after(() => harness.dom.window.close());
  harness.dom.window.requestAnimationFrame = (callback) => { callback(); return 1; };

  activateFirstHit(harness);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(finallyCalls, 0);
  assert.equal(
    harness.documentRef.querySelector('[data-settings-field="contextHistoryScopeSelect"]')
      .getAttribute('data-search-hit'),
    'true',
  );
  harness.controller.dispose();
});

test('disposing before a lazy refresh settles prevents a queued flash', async (t) => {
  const refresh = deferred();
  const harness = createHarness(() => refresh.promise);
  t.after(() => harness.dom.window.close());
  let rafCalls = 0;
  harness.dom.window.requestAnimationFrame = () => { rafCalls += 1; return rafCalls; };

  activateFirstHit(harness);
  harness.controller.dispose();
  refresh.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(rafCalls, 0);
  assert.equal(
    harness.documentRef.querySelector('[data-settings-field="contextHistoryScopeSelect"]')
      .getAttribute('data-search-hit'),
    null,
  );
});

test('dispose cancels an animation frame already queued for a search hit', (t) => {
  const harness = createHarness(() => null);
  t.after(() => harness.dom.window.close());
  const queued = new Map();
  const cancelled = [];
  harness.dom.window.requestAnimationFrame = (callback) => {
    const handle = queued.size + 1;
    queued.set(handle, callback);
    return handle;
  };
  harness.dom.window.cancelAnimationFrame = (handle) => cancelled.push(handle);

  activateFirstHit(harness);
  harness.controller.dispose();
  queued.get(1)();

  assert.deepEqual(cancelled, [1]);
  assert.equal(
    harness.documentRef.querySelector('[data-settings-field="contextHistoryScopeSelect"]')
      .getAttribute('data-search-hit'),
    null,
  );
});
