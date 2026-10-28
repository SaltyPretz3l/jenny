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

function createFlashHarness(options = {}) {
  const dom = new JSDOM(`
    <nav class="settings-nav"><div class="settings-nav-header"></div></nav>
    <section class="settings-card" data-settings-section="context">
      <div data-settings-field="contextHistoryScopeSelect"></div>
    </section>
    <section class="settings-card" data-settings-section="extensions">
      <div data-settings-merged-section="skills"></div>
    </section>
  `, { pretendToBeVisual: true });
  const documentRef = dom.window.document;
  dom.window.requestAnimationFrame = options.requestAnimationFrame || ((callback) => { callback(); return 1; });
  documentRef.querySelector('.settings-nav-header').insertAdjacentHTML('beforeend', buildSettingsSearchBoxMarkup());
  const controller = createSettingsSearchController({
    documentRef,
    settingsNav: documentRef.querySelector('.settings-nav'),
    navigateToSection: options.navigateToSection || (() => true),
    getSectionRefreshPromise: options.getSectionRefreshPromise,
  });
  controller.bind();
  // Picks the first hit of `query` that satisfies `match`, as a click on its result row.
  function pick(query, match) {
    controller.runQuery(query);
    const index = controller.getActiveHits().findIndex(match);
    assert.ok(index >= 0, `a hit for ${query}`);
    documentRef.querySelector(`[data-search-result-index="${index}"]`).click();
  }
  return { dom, documentRef, controller, pick };
}

test('re-picking the flashing row restarts its flash, and a new pick clears the previous row', (t) => {
  const h = createFlashHarness();
  t.after(() => { h.controller.dispose(); h.dom.window.close(); });
  const historyRow = h.documentRef.querySelector('[data-settings-field="contextHistoryScopeSelect"]');
  const isHistory = (hit) => hit.id === 'contextHistoryScopeSelect';
  h.pick('history scope', isHistory);
  assert.equal(historyRow.getAttribute('data-search-hit'), 'true');
  const ops = [];
  const remove = historyRow.removeAttribute.bind(historyRow);
  const set = historyRow.setAttribute.bind(historyRow);
  historyRow.removeAttribute = (name) => { ops.push('remove:' + name); remove(name); };
  historyRow.setAttribute = (name, value) => { ops.push('set:' + name); set(name, value); };
  h.pick('history scope', isHistory);
  assert.deepEqual(ops.filter((op) => op.endsWith('data-search-hit')), ['remove:data-search-hit', 'set:data-search-hit']);
  assert.equal(historyRow.getAttribute('data-search-hit'), 'true');
  h.pick('skills', (hit) => hit.kind === 'section' && hit.rawSectionId === 'skills');
  assert.equal(historyRow.hasAttribute('data-search-hit'), false, 'the earlier row no longer flashes');
  assert.equal(h.documentRef.querySelector('[data-settings-merged-section="skills"]').getAttribute('data-search-hit'), 'true');
});

test('a vetoed navigation (unsaved personality changes) flashes nothing', (t) => {
  let rafCalls = 0;
  const h = createFlashHarness({
    navigateToSection: () => false,
    requestAnimationFrame: (callback) => { rafCalls += 1; callback(); return rafCalls; },
  });
  t.after(() => { h.controller.dispose(); h.dom.window.close(); });
  h.pick('history scope', (hit) => hit.id === 'contextHistoryScopeSelect');
  assert.equal(rafCalls, 0);
  assert.equal(h.documentRef.querySelector('[data-settings-field="contextHistoryScopeSelect"]').hasAttribute('data-search-hit'), false);
});

test('a hit on a merged page waits for its companion refresh (Skills under Extensions)', async (t) => {
  const skills = deferred();
  const asked = [];
  const h = createFlashHarness({
    getSectionRefreshPromise: (sectionId) => { asked.push(sectionId); return sectionId === 'skills' ? skills.promise : null; },
  });
  t.after(() => { h.controller.dispose(); h.dom.window.close(); });
  h.pick('skills', (hit) => hit.kind === 'section' && hit.rawSectionId === 'skills');
  assert.deepEqual(asked, ['extensions', 'skills']);
  const group = h.documentRef.querySelector('[data-settings-merged-section="skills"]');
  assert.equal(group.hasAttribute('data-search-hit'), false, 'no flash while Skills still refreshes');
  skills.resolve();
  await skills.promise;
  await Promise.resolve();
  assert.equal(group.getAttribute('data-search-hit'), 'true');
});
