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
          <section class="settings-card" data-settings-section="permissions"></section>
          <section class="settings-card" data-settings-section="chat"></section>
          <section class="settings-card" data-settings-section="tools"></section>
          <section class="settings-card" data-settings-section="proactive"></section>
          <section class="settings-card" data-settings-section="usage"></section>
          <section class="settings-card" data-settings-section="extensions"></section>
          <section class="settings-card" data-settings-section="account"></section>
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

  renderSettingsNav(dom.window.document);
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
      ['models', 'ArrowUp', 'readiness'], ['models', 'ArrowDown', 'permissions'], ['account', 'ArrowDown', 'aboutUpdates'], ['aboutUpdates', 'ArrowDown', 'advanced'],
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

test('settings nav resolves a hidden feature-flagged section to the default one, and says so before any switch', () => {
  const harness = setupDom();
  try {
    const state = { ui: { activeSettingsSection: 'usage' } };
    const settingsNav = document.querySelector('.settings-nav');
    const settingsContentScroll = document.querySelector('.settings-content-scroll');
    const controller = createSettingsNavController({ state, settingsNav, settingsContentScroll });
    controller.bind();
    const team = document.querySelector('.settings-nav-item[data-settings-section="team"]');
    assert.ok(team.hasAttribute('data-feature-flag') && team.hidden, 'the rendered Team item is flagged and hidden');
    assert.equal(controller.resolveSectionId('team'), 'models');
    assert.equal(controller.resolveSectionId('usage'), 'usage');
    assert.equal(state.ui.activeSettingsSection, 'usage', 'asking does not move the section');
    assert.equal(controller.setActiveSection('team'), 'models', 'a switch answers the section it showed');
    assert.equal(state.ui.activeSettingsSection, 'models');
    team.hidden = false;
    assert.equal(controller.resolveSectionId('team'), 'team', 'shown once the flag is on');
  } finally {
    harness.cleanup();
  }
});

/* The retired Plugins & Extensions page left persisted ids behind on old
 * profiles. The old id opens its successor, Extensions, not an empty pane. */
test('settings nav opens Extensions when the persisted section is the retired plugins page', () => {
  const harness = setupDom();
  try {
    const state = { ui: { activeSettingsSection: 'models' } };
    const settingsNav = document.querySelector('.settings-nav');
    const settingsContentScroll = document.querySelector('.settings-content-scroll');
    localStorage.setItem('jenny.settings.activeSection', 'plugins');

    const controller = createSettingsNavController({ state, settingsNav, settingsContentScroll });
    controller.bind();
    controller.restoreActiveSection();

    assert.equal(state.ui.activeSettingsSection, 'extensions');
    assert.equal(
      document.querySelector('.settings-card[data-settings-section="extensions"]').classList.contains('settings-section-active'),
      true
    );
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

test('production rail renders five groups, the first unlabelled, without disclosure or dividers', () => {
  const dom = new JSDOM(buildSettingsNavMarkup(getSettingsGroups(), 'models'));
  const doc = dom.window.document;
  assert.deepEqual([...doc.querySelectorAll('.settings-nav-group')].map(group => group.dataset.settingsNavGroup), ['overview', 'jenny', 'app', 'work', 'system']);
  assert.deepEqual([...doc.querySelectorAll('.settings-nav-group > .settings-nav-label')].map(label => label.textContent), ['Jenny', 'App', 'Work', 'System']);
  // The overview group (Readiness) has no heading, so its tab has nothing to be described by.
  const overview = doc.querySelector('[data-settings-nav-group="overview"]');
  assert.equal(overview.querySelector('.settings-nav-label'), null);
  assert.equal(overview.querySelector('[data-settings-section="readiness"]').hasAttribute('aria-describedby'), false);
  for (const item of doc.querySelectorAll('[data-settings-nav-group]:not([data-settings-nav-group="overview"]) .settings-nav-item')) {
    assert.equal(doc.getElementById(item.getAttribute('aria-describedby')).textContent.trim().length > 0, true, item.dataset.settingsSection);
  }
  assert.equal(doc.querySelector('#settingsAdvancedToggle, #settingsAdvancedItems, .settings-nav-divider, .settings-nav-item-child'), null);
  dom.window.close();
});

test('picker groups visible sections and follows every navigation route and runtime gates', () => {
  const harness = setupDom();
  try {
    const picker = document.getElementById('settingsNavPicker');
    assert.ok(picker);
    assert.equal(picker.getAttribute('aria-label'), 'Settings section');
    assert.deepEqual([...picker.querySelectorAll('optgroup')].map(group => [group.label, [...group.children].map(option => option.value)]), getSettingsGroups().filter(group => group.label).map(group => [group.label, group.sections.map(section => section.id)]));
    // Readiness has no group heading: it is a plain option ahead of the optgroups, never an empty optgroup.
    assert.equal(picker.querySelector('optgroup[label=""]'), null);
    assert.equal(picker.firstElementChild.tagName, 'OPTION');
    assert.equal(picker.firstElementChild.value, 'readiness');
    assert.equal(picker.firstElementChild.textContent, 'Readiness');
    for (const id of ['skills', 'dataPrivacy', 'runtimeLimits', 'offline', 'home', 'dictation', 'context', 'jennyChat']) assert.equal(picker.querySelector('option[value="' + id + '"]'), null);
    const state = { ui: { activeSettingsSection: 'models' } };
    const controller = createSettingsNavController({ state, settingsNav: document.querySelector('.settings-nav'), settingsContentScroll: document.querySelector('.settings-content-scroll') });
    controller.bind();
    const extensionsOption = picker.querySelector('option[value="extensions"]');
    const extensions = document.querySelector('.settings-nav [data-settings-section="extensions"]');
    extensions.hidden = true;
    controller.setActiveSection('models');
    assert.equal(extensionsOption.hidden, true);
    assert.equal(extensionsOption.disabled, true);
    picker.value = 'tools';
    picker.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.equal(state.ui.activeSettingsSection, 'tools');
    document.querySelector('.settings-nav [data-settings-section="chat"]').click();
    assert.equal(picker.value, 'chat');
    document.querySelector('.settings-nav [data-settings-section="models"]').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    assert.equal(picker.value, 'readiness');
    controller.setActiveSection('dataPrivacy');
    assert.equal(picker.value, 'account');
    controller.setActiveSection('runtimeLimits');
    assert.equal(picker.value, 'advanced');
    for (const [id, host] of [['dataPrivacy', 'account'], ['aboutUpdates', 'aboutUpdates'], ['permissions', 'permissions'], ['runtimeLimits', 'advanced'], ['context', 'chat'], ['jennyChat', 'chat'], ['dictation', 'chat'], ['offline', 'models']]) {
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
    extensions.hidden = false;
    controller.setActiveSection('extensions');
    assert.equal(extensionsOption.hidden, false);
    assert.equal(extensionsOption.disabled, false);
    assert.equal(picker.value, 'extensions');
    picker.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    assert.equal(state.ui.activeSettingsSection, 'extensions');
    // A page hidden while Settings is open leaves the picker as soon as it is opened.
    controller.setActiveSection('models');
    extensions.hidden = true;
    picker.dispatchEvent(new window.Event('focus'));
    assert.equal(extensionsOption.hidden, true);
    assert.equal(extensionsOption.disabled, true);
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

test('the nav count badge is a plain toned number and no dirty dot can stack with it', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'settings-nav.css'), 'utf8');
  assert.doesNotMatch(css, /\[data-dirty="true"\]::after/, 'no dirty-dot rule (nothing marks a nav item dirty)');
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

test('host navigation reveals the Data & privacy companion, opens About as its own page and readies lazy Limits companions', async () => {
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
    assert.equal(document.getElementById('settingsNavPicker').value, 'aboutUpdates');
    assert.deepEqual([...document.querySelectorAll('.settings-card.settings-section-active')].map(card => card.dataset.settingsSection), ['aboutUpdates']);
    controller.navigateSettingsSection('runtimeLimits');
    assert.equal(state.ui.activeSettingsSection, 'advanced');
    // Settings is the view at bind, so the boot page (Models) readies its Local only companion first.
    assert.deepEqual(readied, ['offline', 'advanced', 'runtimeLimits']);
    // F14: the Limits page (advanced) refreshes on reveal too, so a lock taken
    // while a reply ran is re-read.
    assert.deepEqual(shown, ['runtimeLimits', 'advanced']);
    assert.equal(controller.isSectionInitialized('advanced'), true);
    assert.equal(controller.isSectionInitialized('runtimeLimits'), true);
    controller.navigateSettingsSection('models');
    controller.navigateSettingsSection('advanced');
    assert.deepEqual(readied, ['offline', 'advanced', 'runtimeLimits'], 'lazy bindings run once');
    assert.deepEqual(shown, ['runtimeLimits', 'advanced', 'runtimeLimits', 'advanced'], 'companion refreshes on every reveal');
    controller.dispose();
  } finally { harness.cleanup(); }
});

test('keyboard stepping and the picker skip rail items the search box filtered out', () => {
  const harness = setupDom();
  try {
    document.querySelector('[data-settings-section="dev_diagnostics"]').remove();
    const state = { ui: { activeSettingsSection: 'models' } };
    const controller = createSettingsNavController({ state, settingsNav: document.querySelector('.settings-nav'), settingsContentScroll: document.querySelector('.settings-content-scroll') });
    controller.bind();
    const navItem = (id) => document.querySelector('.settings-nav [data-settings-section="' + id + '"]');
    const kept = new Set(['models', 'tools', 'account']);
    for (const item of document.querySelectorAll('.settings-nav [data-settings-section]')) {
      item.classList.toggle('settings-nav-item-search-hidden', !kept.has(item.dataset.settingsSection));
    }
    for (const [from, key, to] of [
      ['models', 'ArrowDown', 'tools'], ['tools', 'ArrowDown', 'account'], ['account', 'ArrowDown', 'models'],
      ['models', 'ArrowUp', 'account'], ['tools', 'Home', 'models'], ['models', 'End', 'account'],
    ]) {
      navItem(from).dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }));
      assert.equal(state.ui.activeSettingsSection, to, `${key} from ${from}`);
    }
    // A filtered item still loses the active state when another page is picked.
    navItem('chat').classList.add('active');
    controller.setActiveSection('tools');
    assert.equal(navItem('chat').classList.contains('active'), false);
    const picker = document.getElementById('settingsNavPicker');
    picker.dispatchEvent(new window.Event('focus'));
    assert.equal(picker.querySelector('option[value="chat"]').hidden, true);
    assert.equal(picker.querySelector('option[value="account"]').hidden, false);
  } finally { harness.cleanup(); }
});

// The rail item sets its own display, which outranks the hidden attribute unless the sheet says otherwise:
// a page whose feature flag is off (Team) must not show in the rail.
test('a rail item carrying the hidden attribute is not displayed', () => {
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'styles', 'settings-nav.css'), 'utf8');
  const rule = css.match(/\.settings-nav-item\[hidden\][^{]*\{([^}]*)\}/);
  assert.ok(rule && /display:\s*none/.test(rule[1]), 'styles/settings-nav.css hides .settings-nav-item[hidden]');
});
