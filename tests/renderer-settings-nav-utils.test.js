/* global document, window */
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const {
  buildSettingsNavMarkup,
  createSettingsNavController,
  setNavItemBadge,
} = require('../renderer/shell/renderer-settings-nav-utils.js');
const fs = require('node:fs');
const path = require('node:path');
const { getSettingsGroups } = require('../renderer/shell/renderer-settings-section-registry');

function setupDom() {
  const dom = new JSDOM(`
    <!doctype html>
    <html>
      <body>
        <nav class="settings-nav">
          <button class="settings-nav-item" data-settings-section="models" role="tab" tabindex="0" aria-selected="true">Models</button>
          <button class="settings-nav-item" data-settings-section="context" role="tab" tabindex="-1" aria-selected="false">Context</button>
          <button class="settings-nav-item" data-settings-section="tools" role="tab" tabindex="-1" aria-selected="false">Tools</button>
          <button class="settings-nav-item" data-settings-section="proactive" role="tab" tabindex="-1" aria-selected="false">Proactive</button>
          <button class="settings-nav-item" id="usageSettingsNavItem" data-settings-section="usage" role="tab" tabindex="-1" aria-selected="false">Usage</button>
          <button class="settings-nav-item hidden" data-settings-section="plugins" data-feature-gated="plugins" role="tab" tabindex="-1" aria-selected="false" hidden>Plugins</button>
          <button class="settings-nav-item" data-settings-section="account" role="tab" tabindex="-1" aria-selected="false">Account</button>
          <button class="settings-nav-item" data-settings-section="dataPrivacy" role="tab" tabindex="-1" aria-selected="false">Data &amp; Privacy</button>
          <button class="settings-nav-item" data-settings-section="aboutUpdates" role="tab" tabindex="-1" aria-selected="false">About &amp; Updates</button>
          <button id="settingsAdvancedToggle" type="button" aria-expanded="false">Advanced</button>
          <div id="settingsAdvancedItems" hidden>
            <button class="settings-nav-item settings-nav-item-child" data-settings-section="harness" role="tab" tabindex="-1" aria-selected="false">Harness</button>
            <button class="settings-nav-item settings-nav-item-child" data-settings-section="diagnostics" role="tab" tabindex="-1" aria-selected="false">Runtime Health</button>
            <button class="settings-nav-item settings-nav-item-child" data-settings-section="dev_diagnostics" role="tab" tabindex="-1" aria-selected="false">Dev Diagnostics</button>
          </div>
        </nav>
        <div id="settingsContentPanel" role="tabpanel" aria-labelledby="settingsNav-models">
        <div class="settings-content-scroll">
          <section class="settings-card" data-settings-section="models"></section>
          <section class="settings-card" data-settings-section="context"></section>
          <section class="settings-card" data-settings-section="tools"></section>
          <section class="settings-card" data-settings-section="proactive"></section>
          <section class="settings-card" data-settings-section="usage"></section>
          <section class="settings-card" data-settings-section="plugins" hidden></section>
          <section class="settings-card" data-settings-section="account"></section>
          <section class="settings-card" data-settings-section="dataPrivacy"></section>
          <section class="settings-card" data-settings-section="aboutUpdates"></section>
          <section class="settings-card" data-settings-section="harness"></section>
          <section class="settings-card" data-settings-section="diagnostics"></section>
          <section class="settings-card" data-settings-section="dev_diagnostics"></section>
        </div>
        </div>
      </body>
    </html>
  `, {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });

  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousLocalStorage = global.localStorage;
  global.window = dom.window;
  global.document = dom.window.document;
  global.localStorage = dom.window.localStorage;
  dom.window.requestAnimationFrame = (callback) => callback();

  return {
    dom,
    cleanup() {
      global.window = previousWindow;
      global.document = previousDocument;
      global.localStorage = previousLocalStorage;
      dom.window.close();
    },
  };
}

test('settings nav restores the cost compatibility alias as Usage and persists the canonical id', () => {
  const harness = setupDom();
  try {
    const state = { ui: { activeSettingsSection: 'models' } };
    const settingsNav = document.querySelector('.settings-nav');
    const settingsContentScroll = document.querySelector('.settings-content-scroll');
    localStorage.setItem('jenny.settings.activeSection', 'cost');

    const controller = createSettingsNavController({ state, settingsNav, settingsContentScroll });
    controller.bind();
    controller.restoreActiveSection();

    assert.equal(state.ui.activeSettingsSection, 'usage');
    assert.equal(document.getElementById('settingsAdvancedToggle').getAttribute('aria-expanded'), 'false');
    assert.equal(document.getElementById('settingsAdvancedItems').hidden, true);
    assert.equal(
      document.querySelector('[data-settings-section="usage"]').getAttribute('aria-selected'),
      'true'
    );
    assert.equal(
      document.querySelector('.settings-card[data-settings-section="usage"]').classList.contains('settings-section-active'),
      true
    );
    assert.equal(document.getElementById('settingsContentPanel').getAttribute('aria-labelledby'), 'usageSettingsNavItem');
    assert.equal(localStorage.getItem('jenny.settings.activeSection'), 'usage');
  } finally {
    harness.cleanup();
  }
});

test('registry nav markup gives tabs stable ownership of the settings panel', () => {
  const markup = buildSettingsNavMarkup([
    { label: 'General', sections: [{ id: 'models', label: 'Models' }] },
    { label: 'Advanced', disclosure: true, sections: [{ id: 'diagnostics', label: 'Diagnostics', navItemId: 'diagnosticsSettingsNavItem' }] },
  ], 'models');

  assert.match(markup, /id="settingsNav-models"[^>]+role="tab"[^>]+aria-controls="settingsContentPanel"/);
  assert.match(markup, /id="diagnosticsSettingsNavItem"[^>]+aria-controls="settingsContentPanel"/);
});

test('settings nav falls back for a retired section with no host card', () => {
  const harness = setupDom();
  try {
    const state = { ui: { activeSettingsSection: 'models' } };
    const settingsNav = document.querySelector('.settings-nav');
    const settingsContentScroll = document.querySelector('.settings-content-scroll');
    // Tips and Proactive no longer own Settings sections. A returning user with
    // the retired Tips id must land on the registry default instead of a blank card.
    localStorage.setItem('jenny.settings.activeSection', 'tips');

    const controller = createSettingsNavController({ state, settingsNav, settingsContentScroll });
    controller.bind();
    controller.restoreActiveSection();

    assert.equal(state.ui.activeSettingsSection, 'models');
    assert.equal(
      document.querySelector('[data-settings-section="models"]').getAttribute('aria-selected'),
      'true'
    );
    assert.equal(
      document.querySelector('.settings-card[data-settings-section="models"]').classList.contains('settings-section-active'),
      true
    );
  } finally {
    harness.cleanup();
  }
});

test('settings nav falls back to Models for removed Harness and Dev Tools sections', () => {
  const harness = setupDom();
  try {
    const state = { ui: { activeSettingsSection: 'models' } };
    const settingsNav = document.querySelector('.settings-nav');
    const settingsContentScroll = document.querySelector('.settings-content-scroll');
    const controller = createSettingsNavController({ state, settingsNav, settingsContentScroll });
    controller.bind();

    controller.setActiveSection('dev_diagnostics');
    assert.equal(state.ui.activeSettingsSection, 'models');
    controller.setActiveSection('harness');
    assert.equal(state.ui.activeSettingsSection, 'models');
  } finally {
    harness.cleanup();
  }
});

test('settings nav keyboard navigation skips collapsed advanced items', () => {
  const harness = setupDom();
  try {
    const state = { ui: { activeSettingsSection: 'models' } };
    const settingsNav = document.querySelector('.settings-nav');
    const settingsContentScroll = document.querySelector('.settings-content-scroll');
    const controller = createSettingsNavController({ state, settingsNav, settingsContentScroll });
    controller.bind();
    controller.restoreActiveSection();

    const aboutButton = document.querySelector('[data-settings-section="aboutUpdates"]');
    aboutButton.focus();
    aboutButton.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));

    assert.equal(state.ui.activeSettingsSection, 'models');
    assert.equal(document.getElementById('settingsAdvancedToggle').getAttribute('aria-expanded'), 'false');
    assert.equal(document.activeElement.id, 'settingsAdvancedToggle');
  } finally {
    harness.cleanup();
  }
});

test('settings nav falls back to the default section when asked to activate an unknown section', () => {
  const harness = setupDom();
  try {
    const state = { ui: { activeSettingsSection: 'models' } };
    const settingsNav = document.querySelector('.settings-nav');
    const settingsContentScroll = document.querySelector('.settings-content-scroll');
    const controller = createSettingsNavController({ state, settingsNav, settingsContentScroll });
    controller.bind();

    controller.setActiveSection('not-a-real-section');

    assert.equal(state.ui.activeSettingsSection, 'models');
    assert.equal(document.querySelector('[data-settings-section="models"]').getAttribute('aria-selected'), 'true');
    assert.equal(
      document.querySelector('.settings-card[data-settings-section="models"]').classList.contains('settings-section-active'),
      true
    );
  } finally {
    harness.cleanup();
  }
});

test('settings nav falls back when a hidden dev-only advanced section is requested', () => {
  const harness = setupDom();
  try {
    const state = { ui: { activeSettingsSection: 'models' } };
    const settingsNav = document.querySelector('.settings-nav');
    const settingsContentScroll = document.querySelector('.settings-content-scroll');
    const controller = createSettingsNavController({ state, settingsNav, settingsContentScroll });
    controller.bind();

    const devDiagnostics = document.querySelector('[data-settings-section="dev_diagnostics"]');
    devDiagnostics.setAttribute('data-dev-only', 'true');
    devDiagnostics.hidden = true;
    devDiagnostics.classList.add('hidden');

    controller.setActiveSection('dev_diagnostics');

    assert.equal(state.ui.activeSettingsSection, 'models');
    assert.equal(document.querySelector('[data-settings-section="models"]').getAttribute('aria-selected'), 'true');
  } finally {
    harness.cleanup();
  }
});

/* A feature-gated section (Plugins behind featureFlags.plugins, default-off) is
 * stamped data-feature-gated + hidden by its sibling controller while the flag
 * is off. Both entry points below must honour that stamp: getAllCards() filters
 * the hidden card out, so activating the id anyway leaves Settings with NO card
 * active at all — an empty content pane, not a wrong one. */
test('settings nav falls back when a persisted feature-gated section is hidden', () => {
  const harness = setupDom();
  try {
    const state = { ui: { activeSettingsSection: 'models' } };
    const settingsNav = document.querySelector('.settings-nav');
    const settingsContentScroll = document.querySelector('.settings-content-scroll');
    // A returning user whose last-open section was Plugins, now flag-off.
    localStorage.setItem('jenny.settings.activeSection', 'plugins');

    const controller = createSettingsNavController({ state, settingsNav, settingsContentScroll });
    controller.bind();
    controller.restoreActiveSection();

    assert.equal(state.ui.activeSettingsSection, 'models');
    assert.equal(
      document.querySelector('.settings-card[data-settings-section="models"]').classList.contains('settings-section-active'),
      true
    );
    assert.equal(
      document.querySelector('.settings-card[data-settings-section="plugins"]').classList.contains('settings-section-active'),
      false
    );
  } finally {
    harness.cleanup();
  }
});

test('settings nav falls back when a hidden feature-gated section is deep-linked, but not once it is revealed', () => {
  const harness = setupDom();
  try {
    const state = { ui: { activeSettingsSection: 'models' } };
    const settingsNav = document.querySelector('.settings-nav');
    const settingsContentScroll = document.querySelector('.settings-content-scroll');
    const controller = createSettingsNavController({ state, settingsNav, settingsContentScroll });
    controller.bind();

    const navItem = document.querySelector('.settings-nav [data-settings-section="plugins"]');
    const card = document.querySelector('.settings-card[data-settings-section="plugins"]');

    controller.setActiveSection('plugins');

    assert.equal(state.ui.activeSettingsSection, 'models', 'a hidden feature-gated section is not activatable');
    assert.equal(card.classList.contains('settings-section-active'), false);

    // The negative control: the fallback is conditional on the item being
    // hidden, not a blanket refusal of the id — flag-on reveals the nav item
    // and the section activates normally.
    navItem.hidden = false;
    navItem.classList.remove('hidden');
    card.hidden = false;

    controller.setActiveSection('plugins');

    assert.equal(state.ui.activeSettingsSection, 'plugins');
    assert.equal(card.classList.contains('settings-section-active'), true);
    assert.equal(navItem.getAttribute('aria-selected'), 'true');
  } finally {
    harness.cleanup();
  }
});

test('settings nav logs storage failures without blocking section activation', () => {
  const harness = setupDom();
  try {
    const state = { ui: { activeSettingsSection: 'models' } };
    const logs = [];
    const settingsNav = document.querySelector('.settings-nav');
    const settingsContentScroll = document.querySelector('.settings-content-scroll');
    global.localStorage = {
      setItem() {
        throw new Error('storage blocked');
      },
      getItem() {
        return null;
      },
    };

    const controller = createSettingsNavController({
      state,
      settingsNav,
      settingsContentScroll,
      appendClientLog(level, event, payload) {
        logs.push({ level, event, payload });
      },
    });
    controller.bind();
    controller.setActiveSection('tools');

    assert.equal(state.ui.activeSettingsSection, 'tools');
    assert.deepEqual(logs, [
      {
        level: 'WARN',
        event: 'settings.active_section_persist_failed',
        payload: {
          section: 'tools',
          message: 'storage blocked',
        },
      },
    ]);
  } finally {
    harness.cleanup();
  }
});

test('production nav markup renders the Developer disclosure around Advanced', () => {
  // The group existed but was empty for a long time, and getGroups() drops
  // groups with no visible sections - registering Advanced is what makes the
  // disclosure appear at all.
  const markup = buildSettingsNavMarkup(getSettingsGroups(), 'models');
  assert.match(markup, /settingsAdvancedToggle/);
  assert.match(markup, />Developer</);
  assert.match(markup, /data-settings-section="usage"/);
  assert.match(markup, /data-settings-section="advanced"/);
  // Advanced is a CHILD of the disclosure, not a peer of the ordinary items.
  assert.match(markup, /id="settingsAdvancedItems"[^>]*hidden>[^]*data-settings-section="advanced"/);
  assert.match(markup, /aria-expanded="false"/, 'the disclosure starts collapsed');
});

test('every nav item renders a label span and an empty, fixed badge slot', () => {
  const markup = buildSettingsNavMarkup(getSettingsGroups(), 'models');
  const doc = new JSDOM(`<!doctype html><body><nav class="settings-nav">${markup}</nav></body>`).window.document;
  const items = [...doc.querySelectorAll('.settings-nav-item')];
  assert.ok(items.length >= 10);
  for (const item of items) {
    const label = item.querySelector('.settings-nav-item-label');
    const slot = item.querySelector('.settings-nav-item-badge');
    assert.ok(label, `${item.getAttribute('data-settings-section')} has a label span`);
    assert.ok(slot, `${item.getAttribute('data-settings-section')} has a badge slot`);
    assert.equal(slot.textContent, '', 'slot is empty at zero');
    assert.equal(slot.getAttribute('data-tone'), '');
  }
  assert.equal(items[0].getAttribute('data-settings-section'), 'readiness', 'Readiness is first in the rail');
  assert.equal(items[0].querySelector('.settings-nav-item-label').textContent, 'Readiness');
});

test('setNavItemBadge paints a count with a tone, clears back to the empty slot, and ignores unknown tones', () => {
  const markup = buildSettingsNavMarkup(getSettingsGroups(), 'models');
  const doc = new JSDOM(`<!doctype html><body><nav class="settings-nav">${markup}</nav></body>`).window.document;
  const slot = setNavItemBadge(doc, 'readiness', '3', 'warning');
  assert.ok(slot);
  assert.equal(slot.textContent, '3');
  assert.equal(slot.getAttribute('data-tone'), 'warning');
  setNavItemBadge(doc, 'readiness', 2, 'pending');
  assert.equal(slot.textContent, '2');
  assert.equal(slot.getAttribute('data-tone'), 'pending');
  setNavItemBadge(doc, 'readiness', '1', 'neon');
  assert.equal(slot.getAttribute('data-tone'), '', 'unknown tone renders untoned rather than inventing one');
  setNavItemBadge(doc, 'readiness', '', 'warning');
  assert.equal(slot.textContent, '');
  assert.equal(slot.getAttribute('data-tone'), '', 'clearing drops the tone too');
  assert.ok(doc.querySelector('[data-settings-section="readiness"] .settings-nav-item-badge'), 'slot stays in the DOM');
  assert.equal(setNavItemBadge(doc, 'no-such-section', '1', 'warning'), null);
  assert.equal(setNavItemBadge(null, 'readiness', '1', 'warning'), null);
});

test('the dirty dot is scoped away from Readiness so it never stacks with the count badge', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'settings-nav.css'), 'utf8');
  assert.match(css, /\.settings-nav-item:not\(\[data-settings-section="readiness"\]\)\[data-dirty="true"\]::after/);
  assert.doesNotMatch(css, /\n\.settings-nav-item\[data-dirty="true"\]::after/, 'no unscoped dirty-dot rule remains');
  assert.match(css, /\.settings-nav-item-badge\s*\{/, 'badge slot has a rule');
  // The count is a plain toned number, not a pill: the tone rules set color only.
  const toneRules = css.match(/\.settings-nav-item-badge\[data-tone="[a-z]+"\]\s*\{[^}]*\}/g) || [];
  assert.ok(toneRules.length >= 3, 'tone rules present');
  for (const rule of toneRules) {
    assert.doesNotMatch(rule, /background|border/, `no pill chrome: ${rule}`);
    assert.match(rule, /color:/);
  }
});

test('the Advanced child is not reachable as an ordinary nav item while collapsed', () => {
  // A collapsed disclosure must not leave a focusable tab stop behind it.
  const markup = buildSettingsNavMarkup(getSettingsGroups(), 'models');
  const advancedItem = markup.slice(markup.indexOf('data-settings-section="advanced"') - 260);
  assert.match(advancedItem, /tabindex="-1"/);
});

test('settings nav leaves the current section active when a dirty-state guard refuses navigation', () => {
  const harness = setupDom();
  try {
    const state = { ui: { activeSettingsSection: 'models' } };
    const controller = createSettingsNavController({
      state,
      settingsNav: document.querySelector('.settings-nav'),
      settingsContentScroll: document.querySelector('.settings-content-scroll'),
      beforeSectionChange(next, previous) {
        assert.equal(next, 'tools');
        assert.equal(previous, 'models');
        return false;
      },
    });
    controller.bind();

    assert.equal(controller.setActiveSection('tools'), false);
    assert.equal(state.ui.activeSettingsSection, 'models');
    assert.equal(document.querySelector('[data-settings-section="models"]').getAttribute('aria-selected'), 'true');
  } finally {
    harness.cleanup();
  }
});
