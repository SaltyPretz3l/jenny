'use strict';

// Row 133: Offline is a hidden lazy companion of Models, the default and boot page. The nav fires
// onSectionChange only when the section id changes, so Models shown first (a Settings view switch,
// or a launch that restores the Settings view) must still ready and refresh its Local only group.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSettingsShellController } = require('../renderer/shell/renderer-settings-shell-controller.js');

function withGlobals(fn) {
  const previous = { window: global.window, document: global.document };
  const values = new Map();
  global.window = { localStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) } };
  global.document = { getElementById() { return null; } };
  try {
    return fn();
  } finally {
    global.window = previous.window;
    global.document = previous.document;
  }
}

// A host whose Settings page loads lazily (as in the app): `loadPage()` runs the ready callbacks.
function createHost(state) {
  const readied = [];
  const calls = { bindOffline: 0, refreshOffline: 0, sectionChanges: 0 };
  const readyCallbacks = [];
  let pageLoaded = false;
  const controller = createSettingsShellController({
    state,
    composerLayoutRuntime: {},
    dom: { settingsView: { querySelector() { return null; } }, getSectionDom() { return {}; } },
    constants: { ACTIVITY_SCOPE: {}, TOAST_SOURCE: {} },
    callbacks: {
      setActiveView(nextView) { state.ui.activeView = nextView; },
      appendClientLog() {}, renderAll() {}, renderSessions() {},
      getCurrentRuntimePreferences() { return {}; }, getRuntimePreferenceSnapshot() { return {}; },
      runRuntimePreferenceActivity: async () => {}, listSlashCommands() { return []; },
      bindOfflineShellEvents() { calls.bindOffline += 1; },
      refreshOfflineState: async () => { calls.refreshOffline += 1; },
    },
    factories: {
      settingsRendererUtils: {
        createSettingsRenderer() {
          return {
            renderSettings() {},
            isSettingsPageLoaded: () => pageLoaded,
            whenSettingsPageReady(fn) { if (pageLoaded) fn(); else readyCallbacks.push(fn); },
            ensureSettingsPage: () => Promise.resolve(null),
          };
        },
      },
      settingsEventUtils: {
        createSettingsEventBindings() {
          return { bind() {}, dispose() {}, ensureSectionBindings(id) { readied.push(id); return true; }, sectionShown() {} };
        },
      },
      settingsNavUtils: {
        createSettingsNavController(args) {
          return {
            bind() {}, dispose() {}, restoreActiveSection() {},
            setActiveSection(sectionId) {
              const previous = state.ui.activeSettingsSection;
              state.ui.activeSettingsSection = sectionId;
              if (sectionId !== previous) { calls.sectionChanges += 1; args.onSectionChange(sectionId, previous); }
              return true;
            },
          };
        },
      },
    },
  });
  return {
    controller, readied, calls,
    loadPage() { pageLoaded = true; readyCallbacks.splice(0).forEach((fn) => fn()); },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a link to a retired page shows its group on the host page; a link to the host itself does not scroll', () => withGlobals(() => {
  const scrolled = [];
  const asked = [];
  const group = { querySelectorAll: () => [], matches: () => false, scrollIntoView: (options) => scrolled.push(options) };
  global.document.querySelector = (selector) => { asked.push(selector); return selector === '[data-settings-merged-section="dictation"]' ? group : null; };
  global.window.requestAnimationFrame = (fn) => fn();
  const host = createHost({ ui: { activeView: 'chat', activeSettingsSection: 'models' } });
  host.controller.bind();
  host.loadPage();

  assert.equal(host.controller.navigateSettingsSection('dictation'), true);
  assert.deepEqual(scrolled, [{ block: 'start' }], 'the Dictation group is brought to the top of the Chat page');

  host.controller.navigateSettingsSection('chat');
  assert.equal(scrolled.length, 1, 'the host page opens at its top');
  assert.deepEqual(asked, ['[data-settings-merged-section="dictation"]']);
  host.controller.dispose();
}));

test('a launch that restores the Settings view readies the Local only companion once the page loads', () => withGlobals(() => {
  const host = createHost({ ui: { activeView: 'settings', activeSettingsSection: 'models' } });
  host.controller.bind();
  assert.deepEqual(host.readied, [], 'nothing binds before the lazy page exists');
  host.loadPage();
  assert.deepEqual(host.readied, ['offline'], 'Models readies its companion with no section change');
  assert.equal(host.calls.bindOffline, 1);
  assert.equal(host.calls.sectionChanges, 0);
  assert.equal(host.controller.isSectionInitialized('offline'), true);
  host.controller.dispose();
}));

test('a launch on another view leaves the companion for the first Settings visit', () => withGlobals(() => {
  const host = createHost({ ui: { activeView: 'chat', activeSettingsSection: 'models' } });
  host.controller.bind();
  host.loadPage();
  assert.deepEqual(host.readied, []);
  assert.equal(host.controller.isSectionInitialized('offline'), false);
  host.controller.dispose();
}));

test('opening Settings on Models (the view switch) readies and refreshes Local only, though the section never changed', async () => {
  await withGlobals(async () => {
    const state = { ui: { activeView: 'chat', activeSettingsSection: 'models' } };
    const host = createHost(state);
    host.controller.bind();
    host.loadPage();
    // What setActiveView('settings') runs (renderer-lifecycle-navigation.js): restore, ready, refresh the active section.
    state.ui.activeView = 'settings';
    host.controller.restoreSettingsNavSection();
    host.controller.ensureSettingsSectionReady(state.ui.activeSettingsSection);
    await host.controller.refreshSettingsSection(state.ui.activeSettingsSection);
    await settle();
    assert.equal(host.calls.sectionChanges, 0, 'the nav saw no change');
    assert.deepEqual(host.readied, ['offline']);
    assert.equal(host.calls.bindOffline, 1);
    assert.equal(host.calls.refreshOffline, 1);
    // Every later reveal refreshes it again; the bindings run once.
    await host.controller.refreshSettingsSection('models');
    await settle();
    assert.equal(host.calls.refreshOffline, 2);
    assert.deepEqual(host.readied, ['offline']);
    // Old deep links land on the host and refresh the same companion.
    host.controller.navigateSettingsSection('tools');
    host.controller.navigateSettingsSection('offline');
    await settle();
    assert.equal(state.ui.activeSettingsSection, 'models');
    assert.equal(host.calls.refreshOffline, 3);
    host.controller.dispose();
  });
});
