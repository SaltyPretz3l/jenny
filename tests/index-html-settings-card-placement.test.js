'use strict';

// Settings-card placement guard.
//
// Every `.settings-card[data-settings-section]` in index.html must live inside
// `#settingsView .settings-content-scroll`. That host is load-bearing twice
// over: `.settings-content-scroll .settings-card { display:none }` is the ONLY
// rule that hides inactive cards, and renderer-settings-nav-utils getAllCards()
// queries cards under that host only. A card pasted one level too deep (the
// 2026-08-22 Advanced regression: section landed after the view's closing tag,
// directly in <main>) is therefore painted on every view, never activated by
// the nav, and invisible to settings search.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const {
  SETTINGS_SECTION_DEFINITIONS,
} = require('../renderer/shell/renderer-settings-section-registry');

function loadIndexDocument() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  return new JSDOM(html).window.document;
}

test('every settings card in index.html lives inside the settings content scroll host', () => {
  const doc = loadIndexDocument();
  const hosts = doc.querySelectorAll('#settingsView .settings-content-scroll');
  assert.equal(hosts.length, 1, 'exactly one settings content scroll host');
  const cards = [...doc.querySelectorAll('.settings-card[data-settings-section]')];
  assert.ok(cards.length >= 10, 'the index markup carries the settings cards');
  const strays = cards
    .filter((card) => card.closest('#settingsView .settings-content-scroll') !== hosts[0])
    .map((card) => card.getAttribute('data-settings-section'));
  assert.deepEqual(strays, [], 'cards outside the scroll host leak onto every view');
});

test('every visible registry section has exactly one card inside the scroll host', () => {
  const doc = loadIndexDocument();
  const host = doc.querySelector('#settingsView .settings-content-scroll');
  assert.ok(host, 'scroll host present');
  const visibleIds = SETTINGS_SECTION_DEFINITIONS
    .filter((definition) => !definition.hidden)
    .map((definition) => definition.id);
  assert.ok(visibleIds.includes('advanced'), 'the Advanced section is registered');
  const missing = visibleIds.filter(
    (id) => host.querySelectorAll(`.settings-card[data-settings-section="${id}"]`).length !== 1
  );
  assert.deepEqual(missing, [], 'registered sections without exactly one hosted card');
});

test('Readiness is the first settings card and the content header carries no control-tower host', () => {
  const doc = loadIndexDocument();
  const host = doc.querySelector('#settingsView .settings-content-scroll');
  const firstCard = host.querySelector('.settings-card[data-settings-section]');
  assert.equal(firstCard.getAttribute('data-settings-section'), 'readiness');
  assert.ok(firstCard.querySelector('#settingsControlTowerHost'), 'the list host lives inside the Readiness card');
  assert.ok(firstCard.querySelector('#readinessBadge.settings-badge'), 'static card header carries the summary badge');
  const header = doc.querySelector('#settingsView .settings-content-header');
  assert.ok(header, 'masthead still present');
  assert.equal(header.querySelector('.settings-control-tower-host, #settingsControlTowerHost'), null, 'header is static: no injected host');
  assert.ok(header.querySelector('.settings-masthead-title'), 'title stays');
  assert.ok(header.querySelector('.settings-overview-traits'), 'traits stay');
});

test('activating Advanced from the settings nav shows its card inside the settings view only', async (t) => {
  const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
  const app = await loadRendererApp({ persistedActiveView: 'chat' });
  // t.after, not test.after: the suite-level hook held the app -- and its timers
  // -- alive until every later test in this file had finished.
  t.after(() => app.dispose());
  const { window } = app;
  const doc = window.document;

  // On a non-settings view, no settings card may be a direct child of <main>.
  const strayInMain = [...doc.querySelectorAll('main.main-stage > .settings-card')];
  assert.deepEqual(strayInMain.map((n) => n.id), [], 'no settings card outside the views');

  doc.getElementById('settingsTopRailTab').click();
  await waitForUi(window, 20);
  const navItem = doc.getElementById('settingsNav-advanced');
  assert.ok(navItem, 'Advanced nav item rendered');
  navItem.click();
  await waitForUi(window, 60);

  const card = doc.getElementById('advancedSettingsSection');
  assert.ok(card.classList.contains('settings-section-active'), 'Advanced card activated by the nav');
  assert.ok(card.closest('#settingsView .settings-content-scroll'), 'Advanced card is hosted by the settings view');
  const active = [...doc.querySelectorAll('.settings-card.settings-section-active')];
  assert.deepEqual(active.map((n) => n.getAttribute('data-settings-section')), ['advanced']);
});
