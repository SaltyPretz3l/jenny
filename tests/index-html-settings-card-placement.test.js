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
  assert.equal(doc.querySelector('#settingsView .settings-content-header'), null);
  assert.equal(doc.querySelector('.settings-nav-kicker, .settings-nav-copy'), null);
  for (const id of ['editorBadge', 'homeBadge', 'accountBadge', 'appearanceBadge', 'contextBadge', 'offlineBadge', 'appearanceStatus']) assert.equal(doc.getElementById(id), null);
  assert.ok(doc.getElementById('modelBadge'));
  assert.ok(doc.getElementById('memoryBadge'));
  assert.equal(doc.querySelector('[data-settings-section="tools"] .settings-badge'), null);

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

// Rows are rendered by script, so the static markup shows only their hosts.
const ROW_HOSTS = '[data-setting-mount], .settings-toggle-list, .settings-editor-field-list, .settings-field-row, .settings-field';

test('a list of rows always sits inside a group or a fold, so it never spans the whole page', () => {
  const doc = loadIndexDocument();
  const loose = [];
  const check = (parent, section) => {
    for (const child of parent.children) {
      if (!child.matches(ROW_HOSTS) && !child.querySelector(ROW_HOSTS)) continue;
      if (child.matches('.settings-flow')) check(child, section);
      else if (!child.matches('.settings-group, .settings-fold')) loose.push(`${section}: ${child.id || child.className}`);
    }
  };
  for (const card of doc.querySelectorAll('.settings-card[data-settings-section]')) check(card, card.getAttribute('data-settings-section'));
  assert.deepEqual(loose, []);
});

test('the rail tablist owns tabs only, and the Settings view has its page heading', () => {
  const doc = loadIndexDocument();
  assert.equal(require('../renderer/shell/renderer-settings-nav-utils').renderSettingsNav(doc, {}), true);
  const tablists = doc.querySelectorAll('#settingsView [role="tablist"]');
  assert.equal(tablists.length, 1);
  const tabs = [...tablists[0].querySelectorAll('[role="tab"]')];
  assert.ok(tabs.length >= 10, 'the rail carries the section tabs');
  const strays = [...tablists[0].querySelectorAll('*')]
    .filter((el) => !el.closest('[role="tab"]') && el.getAttribute('role') !== 'presentation' && el.getAttribute('aria-hidden') !== 'true')
    .map((el) => el.outerHTML.slice(0, 80));
  assert.deepEqual(strays, [], 'the picker, the search field and group names are not children of the tablist');
  for (const tab of tabs) {
    assert.ok(doc.getElementById(tab.getAttribute('aria-describedby'))?.textContent.trim(), `${tab.id} is read with its group name`);
  }
  assert.equal(doc.querySelector('#settingsView nav.settings-nav').hasAttribute('role'), false, 'the rail stays a navigation landmark');
  assert.deepEqual([...doc.querySelectorAll('#settingsView h2')].map((heading) => heading.textContent), ['Settings']);
});

test('the PDF add-on block is a named group', () => {
  const host = loadIndexDocument().getElementById('toolsPdfAddonHost');
  assert.equal(host.getAttribute('role'), 'group');
  assert.equal(host.getAttribute('aria-labelledby'), 'toolsPdfAddonHeading');
});
