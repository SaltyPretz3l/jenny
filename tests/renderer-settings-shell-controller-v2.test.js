const test = require('node:test');
const assert = require('node:assert/strict');

const { createSettingsShellController } = require('../renderer/shell/renderer-settings-shell-controller.js');

function createLocalStorage(options = {}) {
  const values = new Map();
  const storage = {
    setCalls: [],
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      if (options.throwOnSet) {
        throw new Error('storage blocked');
      }
      const normalizedKey = String(key);
      const normalizedValue = String(value);
      storage.setCalls.push({ key: normalizedKey, value: normalizedValue });
      values.set(normalizedKey, normalizedValue);
    },
  };
  return storage;
}

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
}

test('settings shell controller centralizes programmatic navigation through the nav controller', () => {
  const previousWindow = global.window;
  const previousDocument = global.document;

  const localStorage = createLocalStorage();
  const settingsNav = { nodeName: 'NAV' };
  const settingsContentScroll = { nodeName: 'DIV' };
  const settingsView = {
    querySelector(selector) {
      if (selector === '.settings-nav') {
        return settingsNav;
      }
      if (selector === '.settings-content-scroll') {
        return settingsContentScroll;
      }
      return null;
    },
  };
  const calls = [];
  global.window = { localStorage };
  global.document = { getElementById() { return null; } };

  try {
    const state = {
      ui: {
        activeView: 'chat',
        activeSettingsSection: 'models',
      },
    };
    let navArgs = null;
    const controller = createSettingsShellController({
      state,
      composerLayoutRuntime: {},
      dom: {
        settingsView,
        getSectionDom() { return {}; },
      },
      constants: {
        ACTIVITY_SCOPE: {},
        TOAST_SOURCE: {},
      },
      callbacks: {
        setActiveView(nextView) {
          calls.push(`setActiveView:${nextView}`);
          state.ui.activeView = nextView;
        },
        appendClientLog() {},
        renderAll() {},
        renderSessions() {},
        getCurrentRuntimePreferences() { return {}; },
        getRuntimePreferenceSnapshot() { return {}; },
        runRuntimePreferenceActivity: async () => {},
        listSlashCommands() { return []; },
      },
      factories: {
        settingsRendererUtils: {
          createSettingsRenderer() {
            return {
              renderSettings() { calls.push('renderSettings'); },
            };
          },
        },
        settingsEventUtils: {
          createSettingsEventBindings() {
            return {
              bind() {},
              dispose() {},
              ensureSectionBindings() {},
            };
          },
        },
        settingsNavUtils: {
          createSettingsNavController(args) {
            navArgs = args;
            return {
              bind() {},
              dispose() {},
              restoreActiveSection() {},
              setActiveSection(sectionId) {
                calls.push(`settingsNav.setActiveSection:${sectionId}`);
                localStorage.setItem('jenny.settings.activeSection', sectionId);
                const previous = state.ui.activeSettingsSection;
                state.ui.activeSettingsSection = sectionId;
                args.onSectionChange(sectionId, previous);
              },
            };
          },
        },
      },
    });

    controller.bind();
    assert.ok(navArgs);
    controller.navigateSettingsSection('tools');

    assert.equal(state.ui.activeView, 'settings');
    assert.equal(state.ui.activeSettingsSection, 'tools');
    assert.equal(localStorage.getItem('jenny.settings.activeSection'), 'tools');
    assert.deepEqual(localStorage.setCalls, [
      { key: 'jenny.settings.activeSection', value: 'tools' },
    ]);
    assert.deepEqual(calls, [
      // bind() renders first so per-field reset affordances can resolve the
      // controls renderSettings() mounts (see the shell-controller comment).
      'renderSettings',
      'setActiveView:settings',
      'settingsNav.setActiveSection:tools',
      'renderSettings',
    ]);
  } finally {
    global.window = previousWindow;
    global.document = previousDocument;
  }
});
test('settings shell controller logs storage failure without blocking navigation', () => {
  const previousWindow = global.window;
  const previousDocument = global.document;

  global.window = { localStorage: createLocalStorage({ throwOnSet: true }) };
  global.document = { getElementById() { return null; } };
  const logs = [];
  const state = {
    ui: {
      activeView: 'chat',
      activeSettingsSection: 'models',
    },
  };

  try {
    const controller = createSettingsShellController({
      state,
      composerLayoutRuntime: {},
      dom: {
        settingsView: { querySelector() { return null; } },
        getSectionDom() { return {}; },
      },
      constants: {
        ACTIVITY_SCOPE: {},
        TOAST_SOURCE: {},
      },
      callbacks: {
        setActiveView(nextView) { state.ui.activeView = nextView; },
        appendClientLog(level, event, payload) {
          logs.push({ level, event, payload });
        },
        renderAll() {},
        renderSessions() {},
        getCurrentRuntimePreferences() { return {}; },
        getRuntimePreferenceSnapshot() { return {}; },
        runRuntimePreferenceActivity: async () => {},
        listSlashCommands() { return []; },
      },
      factories: {
        settingsRendererUtils: {
          createSettingsRenderer() {
            return {
              renderSettings() {},
            };
          },
        },
        settingsEventUtils: {
          createSettingsEventBindings() {
            return {
              bind() {},
              dispose() {},
              ensureSectionBindings() {},
            };
          },
        },
        settingsNavUtils: {
          createSettingsNavController() {
            return {
              bind() {},
              dispose() {},
              restoreActiveSection() {},
            };
          },
        },
      },
    });

    controller.bind();
    controller.navigateSettingsSection('tools');

    assert.equal(state.ui.activeView, 'settings');
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
    global.window = previousWindow;
    global.document = previousDocument;
  }
});

test('bind-dispose-bind reinitializes lazy section bindings and init hooks', () => {
  const previousWindow = global.window;
  const previousDocument = global.document;
  global.window = { localStorage: createLocalStorage() };
  global.document = { getElementById() { return null; } };
  let ensureCalls = 0;
  let offlineInitCalls = 0;

  try {
    const controller = createSettingsShellController({
      state: { ui: { activeView: 'settings', activeSettingsSection: 'models' } },
      composerLayoutRuntime: {},
      dom: {
        settingsView: { querySelector() { return null; } },
        getSectionDom() { return {}; },
      },
      constants: { ACTIVITY_SCOPE: {}, TOAST_SOURCE: {} },
      callbacks: {
        appendClientLog() {},
        renderAll() {},
        renderSessions() {},
        getCurrentRuntimePreferences() { return {}; },
        getRuntimePreferenceSnapshot() { return {}; },
        runRuntimePreferenceActivity: async () => {},
        listSlashCommands() { return []; },
        bindOfflineShellEvents() { offlineInitCalls += 1; },
      },
      factories: {
        settingsRendererUtils: {
          createSettingsRenderer() { return { renderSettings() {} }; },
        },
        settingsEventUtils: {
          createSettingsEventBindings() {
            return {
              bind() {},
              dispose() {},
              ensureSectionBindings(sectionId) {
                if (sectionId === 'offline') ensureCalls += 1;
              },
            };
          },
        },
        settingsNavUtils: {
          createSettingsNavController() {
            return { bind() {}, dispose() {}, restoreActiveSection() {} };
          },
        },
      },
    });

    controller.bind();
    controller.ensureSettingsSectionReady('offline');
    controller.dispose();
    controller.bind();
    controller.ensureSettingsSectionReady('offline');

    assert.equal(ensureCalls, 2);
    assert.equal(offlineInitCalls, 2);
    assert.equal(controller.isSectionInitialized('offline'), true);
    controller.dispose();
  } finally {
    global.window = previousWindow;
    global.document = previousDocument;
  }
});

test('showing Runtime limits (view switch or section pick) tells the section, and its Limits & budgets host, it is shown; a stored Runs section opens the default', () => {
  const previousWindow = global.window;
  const previousDocument = global.document;
  global.window = { localStorage: createLocalStorage() };
  global.document = { getElementById() { return null; } };
  const shown = [];
  let navArgs = null;
  const state = { ui: { activeView: 'settings', activeSettingsSection: 'advanced' } };
  try {
    const controller = createSettingsShellController({
      state,
      composerLayoutRuntime: {},
      dom: { settingsView: { querySelector() { return null; } }, getSectionDom() { return {}; } },
      constants: { ACTIVITY_SCOPE: {}, TOAST_SOURCE: {} },
      callbacks: {
        appendClientLog() {}, renderAll() {}, renderSessions() {},
        getCurrentRuntimePreferences() { return {}; }, getRuntimePreferenceSnapshot() { return {}; },
        runRuntimePreferenceActivity: async () => {}, listSlashCommands() { return []; },
      },
      factories: {
        settingsRendererUtils: { createSettingsRenderer() { return { renderSettings() {} }; } },
        settingsEventUtils: {
          createSettingsEventBindings() {
            return { bind() {}, dispose() {}, ensureSectionBindings() { return true; }, sectionShown(id) { shown.push(id); } };
          },
        },
        settingsNavUtils: {
          createSettingsNavController(args) {
            navArgs = args;
            return { bind() {}, dispose() {}, restoreActiveSection() {} };
          },
        },
      },
    });
    controller.bind();
    // setActiveView('settings') refreshes the active section: the return from Chat.
    // Runs moved to Diagnostics (2026-10-03): its old id resolves to the
    // default section and tells nobody it is shown.
    void controller.refreshSettingsSection('runs');
    assert.deepEqual(shown, []);
    void controller.refreshSettingsSection('runtimeLimits');
    navArgs.onSectionChange('models', 'runtimeLimits');
    // Runtime limits is merged into Limits & budgets ('advanced'), whose engine
    // lines re-read their state when shown (SW1-2 / F14).
    assert.deepEqual(shown, ['runtimeLimits', 'advanced']);
    controller.dispose();
  } finally {
    global.window = previousWindow;
    global.document = previousDocument;
  }
});
