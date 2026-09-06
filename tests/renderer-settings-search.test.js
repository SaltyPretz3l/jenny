'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  buildSettingsSearchIndex,
  searchSettingsIndex,
  searchSettingsSectionIds,
  buildSettingsSearchBoxMarkup,
  createSettingsSearchController,
} = require('../renderer/shell/renderer-settings-search.js');
const { createSettingsNavController } = require('../renderer/shell/renderer-settings-nav-utils.js');
const registry = require('../renderer/shell/renderer-settings-section-registry.js');
const fieldCopy = require('../renderer/shell/renderer-settings-field-copy.js');
const searchInputDomId = 'settingsSearchInput';
const searchResultsDomId = 'settingsSearchResults';
const searchStatusDomId = 'settingsSearchStatus';

// ── Pure index / matching logic ───────────────────────────────────────────

test('buildSettingsSearchIndex includes every registry section and every field-copy entry', () => {
  const index = buildSettingsSearchIndex();
  const sectionIds = registry.getSettingsSections().map((section) => section.id);
  const sectionEntries = index.filter((entry) => entry.kind === 'section');
  assert.equal(sectionEntries.length, sectionIds.length);

  const fieldEntries = index.filter((entry) => entry.kind === 'field');
  const copyEntries = fieldCopy.listSettingsFieldCopyEntries();
  assert.equal(fieldEntries.length, copyEntries.length);
  assert.ok(fieldEntries.length > 0);
});

test('merged Skills section routes search hits to its Plugins & Extensions host', () => {
  const index = buildSettingsSearchIndex();
  const skillsSectionEntry = index.find((entry) => entry.kind === 'section' && entry.rawSectionId === 'skills');
  assert.ok(skillsSectionEntry, 'skills section entry present');
  assert.equal(skillsSectionEntry.sectionId, 'plugins');
  assert.equal(index.some((entry) => entry.rawSectionId === 'tips'), false);
  assert.equal(index.some((entry) => entry.rawSectionId === 'proactive'), false);
});

test('searchSettingsIndex is a case-insensitive substring match over label + description + section label', () => {
  const index = buildSettingsSearchIndex();

  const byLabel = searchSettingsIndex(index, 'HISTORY SCOPE');
  assert.ok(byLabel.some((hit) => hit.id === 'contextHistoryScopeSelect'));

  const byDescription = searchSettingsIndex(index, 'second after you stop typing');
  assert.ok(byDescription.some((hit) => hit.id === 'editorAutoSaveToggle'));

  const bySectionLabel = searchSettingsIndex(index, 'usage');
  assert.ok(bySectionLabel.some((hit) => hit.kind === 'section' && hit.sectionId === 'usage'));
});

test('searchSettingsIndex exposes the local profile editor and retires sign-out search', () => {
  const index = buildSettingsSearchIndex();

  const byKeyword = searchSettingsIndex(index, 'display name');
  assert.ok(byKeyword.some((hit) => hit.id === 'saveLocalProfileButton'));
  assert.equal(searchSettingsIndex(index, 'logout').some((hit) => hit.id === 'settingsLogoutButton'), false);
  assert.equal(fieldCopy.SETTINGS_FIELD_COPY.settingsLogoutButton, undefined);
});

test('field-copy index has entries for retained account and editor sections', () => {
  const index = buildSettingsSearchIndex();
  const fieldEntries = index.filter((entry) => entry.kind === 'field');

  const accountFields = fieldEntries.filter((entry) => entry.sectionId === 'account');
  assert.ok(accountFields.length >= 1, 'account section has at least one searchable field');

  const editorFields = fieldEntries.filter((entry) => entry.sectionId === 'editor');
  assert.ok(editorFields.length >= 1, 'editor section has at least one searchable field');
  assert.equal(fieldEntries.some((entry) => entry.sectionId === 'harness'), false);
});

test('searchSettingsIndex orders field hits before section hits and returns [] for empty query', () => {
  const index = buildSettingsSearchIndex();
  const hits = searchSettingsIndex(index, 'tools');
  assert.ok(hits.length > 1);
  const firstSectionIndex = hits.findIndex((hit) => hit.kind === 'section');
  const lastFieldIndex = hits.map((hit) => hit.kind).lastIndexOf('field');
  if (firstSectionIndex !== -1 && lastFieldIndex !== -1) {
    assert.ok(lastFieldIndex < firstSectionIndex, 'field hits precede section hits');
  }
  assert.deepEqual(searchSettingsIndex(index, ''), []);
  assert.deepEqual(searchSettingsIndex(index, '   '), []);
  assert.deepEqual(searchSettingsIndex(index, 'no-such-setting-xyz'), []);
});

test('searchSettingsSectionIds returns distinct, host-resolved section ids', () => {
  const index = buildSettingsSearchIndex();
  const ids = searchSettingsSectionIds(index, 'contextual tips');
  assert.ok(ids.includes('home'));
  assert.ok(!ids.includes('tips'), 'retired Settings section must not appear');
  assert.ok(!ids.includes('proactive'), 'retired Settings section must not appear');
  assert.equal(new Set(ids).size, ids.length, 'ids are distinct');
});

// ── DOM wiring ─────────────────────────────────────────────────────────────

function buildNavDom() {
  const dom = new JSDOM(`
    <!doctype html>
    <html>
      <body>
        <nav class="settings-nav">
          <div class="settings-nav-header"></div>
          <div class="settings-nav-scroll">
            <button class="settings-nav-item" data-settings-section="models" role="tab" tabindex="0" aria-selected="true">Models</button>
            <button class="settings-nav-item" data-settings-section="context" role="tab" tabindex="-1" aria-selected="false">Context</button>
            <button class="settings-nav-item" data-settings-section="tools" role="tab" tabindex="-1" aria-selected="false">Tools</button>
            <button class="settings-nav-item" data-settings-section="account" role="tab" tabindex="-1" aria-selected="false">Account</button>
          </div>
        </nav>
        <div class="settings-content-scroll">
          <section class="settings-card" data-settings-section="models"></section>
          <section class="settings-card" data-settings-section="context">
            <div data-settings-field="contextHistoryScopeSelect"></div>
          </section>
          <section class="settings-card" data-settings-section="tools"></section>
          <section class="settings-card" data-settings-section="account"></section>
        </div>
      </body>
    </html>
  `, { pretendToBeVisual: true, url: 'http://localhost/' });

  const app = {
    dom,
    dispose() {
      dom.window.close();
    },
  };
  return app;
}

test('createSettingsSearchController renders results and filters the nav rail', (t) => {
  const app = buildNavDom();
  t.after(() => app.dispose());
  const { window } = app.dom;
  const documentRef = window.document;
  const header = documentRef.querySelector('.settings-nav-header');
  header.insertAdjacentHTML('beforeend', buildSettingsSearchBoxMarkup());

  const settingsNav = documentRef.querySelector('.settings-nav');
  const activated = [];
  const controller = createSettingsSearchController({
    documentRef,
    settingsNav,
    navigateToSection: (sectionId) => activated.push(sectionId),
  });
  controller.bind();

  const input = documentRef.getElementById(searchInputDomId);
  const results = documentRef.getElementById(searchResultsDomId);
  assert.ok(input);
  assert.ok(results);
  const searchField = input.closest('.settings-search-input');
  assert.ok(searchField?.classList.contains('rail-search-field'), 'Settings consumes the shared rail search visual contract');
  assert.ok(input.classList.contains('inv-text-field-control'), 'the inventory text-field control contract remains intact');
  assert.equal(results.hidden, true);
  assert.equal(input.getAttribute('role'), 'combobox');
  assert.equal(input.getAttribute('aria-autocomplete'), 'list');
  assert.equal(input.getAttribute('aria-controls'), searchResultsDomId);
  assert.equal(input.getAttribute('aria-describedby'), searchStatusDomId);
  assert.equal(input.getAttribute('aria-expanded'), 'false');

  controller.runQuery('history scope');
  assert.equal(results.hidden, false);
  assert.equal(input.getAttribute('aria-expanded'), 'true');
  const hits = controller.getActiveHits();
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].id, 'contextHistoryScopeSelect');

  const contextItem = settingsNav.querySelector('[data-settings-section="context"]');
  const modelsItem = settingsNav.querySelector('[data-settings-section="models"]');
  assert.equal(contextItem.classList.contains('settings-nav-item-search-hidden'), false);
  assert.equal(modelsItem.classList.contains('settings-nav-item-search-hidden'), true);

  controller.runQuery('');
  assert.equal(results.hidden, true);
  assert.equal(input.getAttribute('aria-expanded'), 'false');
  assert.equal(modelsItem.classList.contains('settings-nav-item-search-hidden'), false);

  controller.dispose();
});

test('UIUX-038: a nonblank query with zero matches announces no-results and filters the nav to nothing', (t) => {
  const app = buildNavDom();
  t.after(() => app.dispose());
  const { window } = app.dom;
  const documentRef = window.document;
  const header = documentRef.querySelector('.settings-nav-header');
  header.insertAdjacentHTML('beforeend', buildSettingsSearchBoxMarkup());

  const settingsNav = documentRef.querySelector('.settings-nav');
  const controller = createSettingsSearchController({
    documentRef,
    settingsNav,
    navigateToSection: () => {},
  });
  controller.bind();

  const status = documentRef.getElementById(searchStatusDomId);
  assert.ok(status, 'status region exists in the search box markup');
  assert.equal(status.getAttribute('role'), 'status');
  assert.equal(status.getAttribute('aria-live'), 'polite');
  assert.equal(status.textContent, '', 'nothing announced before any query runs');

  controller.runQuery('zzz-definitely-not-a-real-setting-zzz');

  const results = documentRef.getElementById(searchResultsDomId);
  assert.equal(results.hidden, true, 'the (empty) results listbox stays hidden');
  assert.equal(controller.getActiveHits().length, 0);
  assert.match(status.textContent, /no settings match/i, 'the miss is announced via the status region');

  // The nav rail must filter to NOTHING for a real zero-hit query -- not
  // silently restore the full, unfiltered nav (the UIUX-038 defect).
  for (const item of settingsNav.querySelectorAll('[data-settings-section]')) {
    assert.equal(item.classList.contains('settings-nav-item-search-hidden'), true,
      `"${item.getAttribute('data-settings-section')}" must be hidden -- the query matched nothing`);
  }

  // A real match afterwards clears the no-results announcement and restores
  // that section's nav visibility.
  controller.runQuery('history scope');
  assert.equal(status.textContent, '', 'a real match clears the no-results announcement');
  const contextItem = settingsNav.querySelector('[data-settings-section="context"]');
  assert.equal(contextItem.classList.contains('settings-nav-item-search-hidden'), false);

  // Clearing the query (not just a miss) also clears the announcement and
  // restores the full nav.
  controller.runQuery('');
  assert.equal(status.textContent, '', 'a cleared query has nothing to announce');
  const modelsItem = settingsNav.querySelector('[data-settings-section="models"]');
  assert.equal(modelsItem.classList.contains('settings-nav-item-search-hidden'), false);

  controller.dispose();
});

test('activating a result navigates to the host section and flashes the hit row', (t) => {
  const app = buildNavDom();
  t.after(() => app.dispose());
  const { window } = app.dom;
  const documentRef = window.document;
  window.requestAnimationFrame = (cb) => { cb(); return 0; };
  const header = documentRef.querySelector('.settings-nav-header');
  header.insertAdjacentHTML('beforeend', buildSettingsSearchBoxMarkup());

  const settingsNav = documentRef.querySelector('.settings-nav');
  const activated = [];
  const controller = createSettingsSearchController({
    documentRef,
    settingsNav,
    navigateToSection: (sectionId) => activated.push(sectionId),
  });
  controller.bind();

  controller.runQuery('history scope');
  const input = documentRef.getElementById(searchInputDomId);
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

  assert.deepEqual(activated, ['context']);
  const toggleWrapper = documentRef.querySelector('[data-settings-field="contextHistoryScopeSelect"]');
  assert.equal(toggleWrapper.getAttribute('data-search-hit'), 'true');

  controller.dispose();
});

test('activating a result with no data-inv-toggle/id falls back to [data-settings-field]', (t) => {
  const app = buildNavDom();
  t.after(() => app.dispose());
  const { window } = app.dom;
  const documentRef = window.document;
  window.requestAnimationFrame = (cb) => { cb(); return 0; };
  const header = documentRef.querySelector('.settings-nav-header');
  header.insertAdjacentHTML('beforeend', buildSettingsSearchBoxMarkup());

  const settingsNav = documentRef.querySelector('.settings-nav');
  const activated = [];
  const controller = createSettingsSearchController({
    documentRef,
    settingsNav,
    navigateToSection: (sectionId) => activated.push(sectionId),
  });
  controller.bind();

  controller.runQuery('history scope');
  const hits = controller.getActiveHits();
  assert.ok(hits.some((hit) => hit.id === 'contextHistoryScopeSelect'));

  const input = documentRef.getElementById(searchInputDomId);
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

  assert.deepEqual(activated, ['context']);
  const target = documentRef.querySelector('[data-settings-field="contextHistoryScopeSelect"]');
  assert.equal(target.getAttribute('data-search-hit'), 'true');

  controller.dispose();
});

test('Escape clears the query and restores the full nav rail', (t) => {
  const app = buildNavDom();
  t.after(() => app.dispose());
  const { window } = app.dom;
  const documentRef = window.document;
  const header = documentRef.querySelector('.settings-nav-header');
  header.insertAdjacentHTML('beforeend', buildSettingsSearchBoxMarkup());

  const settingsNav = documentRef.querySelector('.settings-nav');
  const controller = createSettingsSearchController({
    documentRef,
    settingsNav,
    navigateToSection: () => {},
  });
  controller.bind();

  controller.runQuery('history scope');
  const input = documentRef.getElementById(searchInputDomId);
  input.value = 'history scope';
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

  assert.equal(input.value, '');
  const results = documentRef.getElementById(searchResultsDomId);
  assert.equal(results.hidden, true);
  const modelsItem = settingsNav.querySelector('[data-settings-section="models"]');
  assert.equal(modelsItem.classList.contains('settings-nav-item-search-hidden'), false);

  controller.dispose();
});

test('ArrowDown/ArrowUp move the active result without changing section yet', (t) => {
  const app = buildNavDom();
  t.after(() => app.dispose());
  const { window } = app.dom;
  const documentRef = window.document;
  const header = documentRef.querySelector('.settings-nav-header');
  header.insertAdjacentHTML('beforeend', buildSettingsSearchBoxMarkup());

  const settingsNav = documentRef.querySelector('.settings-nav');
  const activated = [];
  const controller = createSettingsSearchController({
    documentRef,
    settingsNav,
    navigateToSection: (sectionId) => activated.push(sectionId),
  });
  controller.bind();

  controller.runQuery('personality');
  const before = controller.getActiveHits();
  assert.ok(before.length > 1, 'need at least two hits to exercise arrow nav');

  const input = documentRef.getElementById(searchInputDomId);
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  const results = documentRef.getElementById(searchResultsDomId);
  const activeItem = results.querySelector('.settings-search-result.active');
  assert.ok(activeItem);
  assert.equal(activeItem.getAttribute('data-search-result-index'), '1');
  assert.equal(activated.length, 0, 'arrow keys must not activate a section');

  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
  const activeAfterUp = results.querySelector('.settings-search-result.active');
  assert.equal(activeAfterUp.getAttribute('data-search-result-index'), '0');

  controller.dispose();
});

// ── Queued flash for lazy sections ──────────────────────────────────────────

test('activating a hit whose section refresh is pending flashes only after the refresh settles', async (t) => {
  const app = buildNavDom();
  t.after(() => app.dispose());
  const { window } = app.dom;
  const documentRef = window.document;
  window.requestAnimationFrame = (cb) => { cb(); return 0; };
  const header = documentRef.querySelector('.settings-nav-header');
  header.insertAdjacentHTML('beforeend', buildSettingsSearchBoxMarkup());

  const settingsNav = documentRef.querySelector('.settings-nav');
  const activated = [];
  let resolveRefresh;
  const pending = new Promise((resolve) => { resolveRefresh = resolve; });
  const controller = createSettingsSearchController({
    documentRef,
    settingsNav,
    navigateToSection: (sectionId) => activated.push(sectionId),
    getSectionRefreshPromise: (sectionId) => (sectionId === 'context' ? pending : null),
  });
  controller.bind();

  controller.runQuery('history scope');
  const input = documentRef.getElementById(searchInputDomId);
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

  assert.deepEqual(activated, ['context']);
  const toggleWrapper = documentRef.querySelector('[data-settings-field="contextHistoryScopeSelect"]');
  assert.equal(toggleWrapper.getAttribute('data-search-hit'), null, 'must not flash while the section refresh is still pending');

  resolveRefresh();
  await pending;
  assert.equal(toggleWrapper.getAttribute('data-search-hit'), 'true', 'flashes once the pending refresh settles');

  controller.dispose();
});

test('activating a hit into an already-ready section still flashes on the single-rAF path (no getSectionRefreshPromise pending value)', (t) => {
  const app = buildNavDom();
  t.after(() => app.dispose());
  const { window } = app.dom;
  const documentRef = window.document;
  let rafCalls = 0;
  window.requestAnimationFrame = (cb) => { rafCalls += 1; cb(); return rafCalls; };
  const header = documentRef.querySelector('.settings-nav-header');
  header.insertAdjacentHTML('beforeend', buildSettingsSearchBoxMarkup());

  const settingsNav = documentRef.querySelector('.settings-nav');
  const activated = [];
  const controller = createSettingsSearchController({
    documentRef,
    settingsNav,
    navigateToSection: (sectionId) => activated.push(sectionId),
    // Accessor present, but returns null for every section — mirrors an
    // already-initialized (non-lazy or already-refreshed) host section.
    getSectionRefreshPromise: () => null,
  });
  controller.bind();

  controller.runQuery('history scope');
  const input = documentRef.getElementById(searchInputDomId);
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

  assert.deepEqual(activated, ['context']);
  const toggleWrapper = documentRef.querySelector('[data-settings-field="contextHistoryScopeSelect"]');
  assert.equal(toggleWrapper.getAttribute('data-search-hit'), 'true', 'flashes immediately on the rAF path');
  assert.equal(rafCalls, 1, 'exactly one rAF hop — no double-flash');

  controller.dispose();
});

test('activateHit falls back to the single-rAF path when getSectionRefreshPromise is absent from deps', (t) => {
  const app = buildNavDom();
  t.after(() => app.dispose());
  const { window } = app.dom;
  const documentRef = window.document;
  window.requestAnimationFrame = (cb) => { cb(); return 0; };
  const header = documentRef.querySelector('.settings-nav-header');
  header.insertAdjacentHTML('beforeend', buildSettingsSearchBoxMarkup());

  const settingsNav = documentRef.querySelector('.settings-nav');
  const activated = [];
  const controller = createSettingsSearchController({
    documentRef,
    settingsNav,
    navigateToSection: (sectionId) => activated.push(sectionId),
    // No getSectionRefreshPromise at all — older-deps compatibility path.
  });
  controller.bind();

  controller.runQuery('history scope');
  const input = documentRef.getElementById(searchInputDomId);
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

  assert.deepEqual(activated, ['context']);
  const toggleWrapper = documentRef.querySelector('[data-settings-field="contextHistoryScopeSelect"]');
  assert.equal(toggleWrapper.getAttribute('data-search-hit'), 'true');

  controller.dispose();
});

// ── Nav-controller integration (feature-flag gate) ─────────────────────────

test('createSettingsNavController wires the search input only when settings_search is true', (t) => {
  const app = buildNavDom();
  t.after(() => app.dispose());
  const { window } = app.dom;
  const documentRef = window.document;
  global.window = window;
  global.document = documentRef;
  global.localStorage = window.localStorage;
  t.after(() => {
    delete global.window;
    delete global.document;
    delete global.localStorage;
  });

  const header = documentRef.querySelector('.settings-nav-header');
  header.insertAdjacentHTML('beforeend', buildSettingsSearchBoxMarkup());
  const settingsNav = documentRef.querySelector('.settings-nav');
  const settingsContentScroll = documentRef.querySelector('.settings-content-scroll');
  const input = documentRef.getElementById(searchInputDomId);
  const results = documentRef.getElementById(searchResultsDomId);
  assert.ok(input && results, 'search markup present regardless of the flag');

  // Flag OFF: typing must not populate the results list — the controller never bound.
  const stateOff = { ui: { activeSettingsSection: 'models' }, features: { featureFlags: { settings_search: false } } };
  const controllerOff = createSettingsNavController({ state: stateOff, settingsNav, settingsContentScroll });
  controllerOff.bind();
  input.value = 'history scope';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(results.hidden, true, 'flag off: results list stays hidden, no query ran');
  assert.equal(results.children.length, 0, 'flag off: no result rows rendered');
  controllerOff.dispose();

  // Flag ON: the same keystroke now filters the nav and populates results.
  const stateOn = { ui: { activeSettingsSection: 'models' }, features: { featureFlags: { settings_search: true } } };
  const controllerOn = createSettingsNavController({ state: stateOn, settingsNav, settingsContentScroll });
  controllerOn.bind();
  input.value = 'history scope';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(results.hidden, false, 'flag on: results list opens for a matching query');
  assert.ok(results.children.length >= 1, 'flag on: at least one result row rendered');
  assert.equal(
    results.querySelector('.settings-search-result-label').textContent,
    'History scope'
  );
  controllerOn.dispose();
});
