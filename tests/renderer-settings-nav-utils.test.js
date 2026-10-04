/* global document, window */
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const {
  buildSettingsNavMarkup,
  createSettingsNavController,
  setNavItemBadge,
  renderSettingsNav,
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
          <div class="settings-nav-header"></div>
          <div class="settings-nav-scroll"></div>
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

  renderSettingsNav(dom.window.document);
  const plugins = dom.window.document.querySelector('.settings-nav [data-settings-section="plugins"]');
  plugins.hidden = true;
  plugins.setAttribute('data-feature-gated', 'plugins');
  dom.window.document.querySelector('.settings-nav-scroll').insertAdjacentHTML('beforeend', '<button data-settings-section="dev_diagnostics">Retired</button>');
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
    { label: 'Advanced', sections: [{ id: 'diagnostics', label: 'Diagnostics', navItemId: 'diagnosticsSettingsNavItem' }] },
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

test('keyboard traverses every visible group and wraps', () => {
  const harness = setupDom();
  try {
    document.querySelector('[data-settings-section="dev_diagnostics"]').remove();
    const state = { ui: { activeSettingsSection: 'models' } };
    const controller = createSettingsNavController({ state, settingsNav: document.querySelector('.settings-nav'), settingsContentScroll: document.querySelector('.settings-content-scroll') });
    controller.bind();
    for (const [from, key, to] of [
      ['advanced', 'ArrowDown', 'readiness'], ['readiness', 'ArrowUp', 'advanced'],
      ['models', 'ArrowUp', 'readiness'], ['account', 'ArrowDown', 'advanced'],
      ['models', 'Home', 'readiness'], ['models', 'End', 'advanced'],
    ]) {
      const item = document.querySelector('.settings-nav [data-settings-section="' + from + '"]');
      item.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }));
      assert.equal(state.ui.activeSettingsSection, to);
      assert.equal(document.activeElement.dataset.settingsSection, to);
    }
  } finally { harness.cleanup(); }
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

test('production rail renders six uniform groups without disclosure or dividers', () => {
  const dom = new JSDOM(buildSettingsNavMarkup(getSettingsGroups(), 'models'));
  const doc = dom.window.document;
  assert.deepEqual([...doc.querySelectorAll('.settings-nav-group')].map(group => group.dataset.settingsNavGroup), ['modelTools', 'work', 'context', 'app', 'system', 'developer']);
  assert.equal(doc.querySelectorAll('.settings-nav-group > .settings-nav-label').length, 6);
  assert.equal(doc.querySelector('#settingsAdvancedToggle, #settingsAdvancedItems, .settings-nav-divider, .settings-nav-item-child'), null);
  dom.window.close();
});

test('picker groups visible sections and follows every navigation route and runtime gates', () => {
  const harness = setupDom();
  try {
    const picker = document.getElementById('settingsNavPicker');
    assert.ok(picker);
    assert.equal(picker.getAttribute('aria-label'), 'Settings section');
    assert.deepEqual([...picker.querySelectorAll('optgroup')].map(group => [group.label, [...group.children].map(option => option.value)]), getSettingsGroups().map(group => [group.label, group.sections.map(section => section.id)]));
    for (const id of ['skills', 'dataPrivacy', 'aboutUpdates', 'runtimeLimits']) assert.equal(picker.querySelector('option[value="' + id + '"]'), null);
    const state = { ui: { activeSettingsSection: 'models' } };
    const controller = createSettingsNavController({ state, settingsNav: document.querySelector('.settings-nav'), settingsContentScroll: document.querySelector('.settings-content-scroll') });
    controller.bind();
    const pluginOption = picker.querySelector('option[value="plugins"]');
    assert.equal(pluginOption.hidden, true);
    assert.equal(pluginOption.disabled, true);
    picker.value = 'tools';
    picker.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.equal(state.ui.activeSettingsSection, 'tools');
    document.querySelector('.settings-nav [data-settings-section="context"]').click();
    assert.equal(picker.value, 'context');
    document.querySelector('.settings-nav [data-settings-section="models"]').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    assert.equal(picker.value, 'readiness');
    controller.setActiveSection('dataPrivacy');
    assert.equal(picker.value, 'account');
    controller.setActiveSection('runtimeLimits');
    assert.equal(picker.value, 'advanced');
    for (const [id, host] of [['dataPrivacy', 'account'], ['aboutUpdates', 'account'], ['runtimeLimits', 'advanced']]) {
      localStorage.setItem('jenny.settings.activeSection', id);
      controller.restoreActiveSection();
      assert.equal(state.ui.activeSettingsSection, host);
      assert.equal(picker.value, host);
    }
    const advanced = document.querySelector('.settings-nav [data-settings-section="advanced"]');
    advanced.dataset.devOnly = 'true';
    advanced.hidden = true;
    controller.setActiveSection('models');
    assert.equal(picker.querySelector('option[value="advanced"]').disabled, true);
    const plugins = document.querySelector('.settings-nav [data-settings-section="plugins"]');
    plugins.hidden = false;
    controller.setActiveSection('plugins');
    assert.equal(pluginOption.hidden, false);
    assert.equal(pluginOption.disabled, false);
    assert.equal(picker.value, 'plugins');
    picker.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    assert.equal(state.ui.activeSettingsSection, 'plugins');
    // A page gated off while Settings is open leaves the picker as soon as it is opened.
    controller.setActiveSection('models');
    plugins.hidden = true;
    picker.dispatchEvent(new window.Event('focus'));
    assert.equal(pluginOption.hidden, true);
    assert.equal(pluginOption.disabled, true);
  } finally { harness.cleanup(); }
});

test('stepping the section picker keeps focus on the picker once the page heading frame has run', () => {
  const harness = setupDom();
  try {
    const frames = [];
    window.requestAnimationFrame = (callback) => frames.push(callback);
    document.querySelector('.settings-card[data-settings-section="tools"]').innerHTML = '<h3 tabindex="-1">Tools</h3>';
    const state = { ui: { activeSettingsSection: 'models' } };
    const controller = createSettingsNavController({ state, settingsNav: document.querySelector('.settings-nav'), settingsContentScroll: document.querySelector('.settings-content-scroll') });
    controller.bind();
    const picker = document.getElementById('settingsNavPicker');
    picker.focus();
    picker.value = 'tools';
    picker.dispatchEvent(new window.Event('change', { bubbles: true }));
    while (frames.length) frames.shift()();
    assert.equal(state.ui.activeSettingsSection, 'tools');
    assert.equal(document.activeElement, picker);
  } finally { harness.cleanup(); }
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

test('host navigation reveals both Profile companions and readies lazy Developer companions', async () => {
  const harness = setupDom();
  try {
    const { createSettingsShellController } = require('../renderer/shell/renderer-settings-shell-controller');
    document.querySelector('.settings-content-scroll').insertAdjacentHTML('beforeend', '<section class="settings-card" data-settings-section="advanced"><h3>Limits</h3></section><section class="settings-card" data-settings-section="runtimeLimits"></section>');
    const state = { ui: { activeView: 'settings', activeSettingsSection: 'models' } };
    const readied = [];
    const shown = [];
    const controller = createSettingsShellController({
      state, composerLayoutRuntime: {},
      dom: { settingsView: document.body, getSectionDom() { return {}; } },
      constants: { ACTIVITY_SCOPE: {}, TOAST_SOURCE: {} },
      callbacks: {
        appendClientLog() {}, renderAll() {}, renderSessions() {},
        getCurrentRuntimePreferences() { return {}; }, getRuntimePreferenceSnapshot() { return {}; },
        runRuntimePreferenceActivity: async () => {}, listSlashCommands() { return []; },
      },
      factories: {
        settingsRendererUtils: { createSettingsRenderer() { return { renderSettings() {} }; } },
        settingsEventUtils: { createSettingsEventBindings() { return {
          bind() {}, dispose() {}, ensureSectionBindings(id) { readied.push(id); return true; }, sectionShown(id) { shown.push(id); },
        }; } },
        settingsNavUtils: { createSettingsNavController },
      },
    });
    controller.bind();
    controller.navigateSettingsSection('dataPrivacy');
    assert.equal(state.ui.activeSettingsSection, 'account');
    assert.deepEqual([...document.querySelectorAll('.settings-card.settings-section-active')].map(card => card.dataset.settingsSection), ['account'], 'a folded-in section has no card of its own; its host card is the page');
    controller.navigateSettingsSection('aboutUpdates');
    assert.equal(document.getElementById('settingsNavPicker').value, 'account');
    controller.navigateSettingsSection('runtimeLimits');
    assert.equal(state.ui.activeSettingsSection, 'advanced');
    assert.deepEqual(readied, ['advanced', 'runtimeLimits']);
    // F14: the Limits page (advanced) refreshes on reveal too, so a lock taken
    // while a reply ran is re-read.
    assert.deepEqual(shown, ['runtimeLimits', 'advanced']);
    assert.equal(controller.isSectionInitialized('advanced'), true);
    assert.equal(controller.isSectionInitialized('runtimeLimits'), true);
    controller.navigateSettingsSection('models');
    controller.navigateSettingsSection('advanced');
    assert.deepEqual(readied, ['advanced', 'runtimeLimits'], 'lazy bindings run once');
    assert.deepEqual(shown, ['runtimeLimits', 'advanced', 'runtimeLimits', 'advanced'], 'companion refreshes on every reveal');
    controller.dispose();
  } finally { harness.cleanup(); }
});
