const test = require('node:test');
const assert = require('node:assert/strict');

const { createSettingsShellController } = require('../renderer/shell/renderer-settings-shell-controller.js');

function createLocalStorage(options = {}) {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      if (options.throwOnSet) {
        throw new Error('storage blocked');
      }
      values.set(String(key), String(value));
    },
  };
}

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
}

test('settings shell controller binds child controllers once and owns settings section activation', () => {
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
    const controller = createSettingsShellController({
      state,
      composerLayoutRuntime: {},
      dom: {
        settingsView,
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
        renderAll() {},
        renderSessions() {},
        appendClientLog() {},
        showToastMessage() {},
        showShellErrorToast() {},
        toErrorMessage(error, fallback) {
          return error?.message || fallback;
        },
        getCurrentRuntimePreferences() { return {}; },
        getRuntimePreferenceSnapshot() { return {}; },
        runRuntimePreferenceActivity: async () => {},
        listSlashCommands() { return ['/context', '/compact']; },
      },
      factories: {
        settingsRendererUtils: {
          createSettingsRenderer() {
            calls.push('createSettingsRenderer');
            return {
              renderSettings() { calls.push('renderSettings'); },
              renderComposerPopover() { calls.push('renderComposerPopover'); },
              renderCommandPopover() { calls.push('renderCommandPopover'); },
              syncComposerInputHeight() { calls.push('syncComposerInputHeight'); },
              syncComposerModelSelectWidth() { calls.push('syncComposerModelSelectWidth'); },
            };
          },
        },
        settingsEventUtils: {
          createSettingsEventBindings() {
            calls.push('createSettingsEventBindings');
            return {
              bind() { calls.push('settingsEvents.bind'); },
              dispose() { calls.push('settingsEvents.dispose'); },
            };
          },
        },
        settingsNavUtils: {
          createSettingsNavController(args) {
            calls.push('createSettingsNavController');
            assert.equal(args.settingsNav, settingsNav);
            assert.equal(args.settingsContentScroll, settingsContentScroll);
            return {
              bind() { calls.push('settingsNav.bind'); },
              dispose() { calls.push('settingsNav.dispose'); },
              restoreActiveSection() { calls.push('settingsNav.restore'); },
            };
          },
        },
      },
    });

    controller.bind();
    controller.bind();
    controller.openSettingsSection('tools');
    controller.restoreSettingsNavSection();
    controller.renderSettings();
    controller.renderComposerPopover();
    controller.renderCommandPopover();
    controller.syncComposerInputHeight();
    controller.syncComposerModelSelectWidth();
    controller.dispose();
    controller.dispose();

    assert.equal(state.ui.activeView, 'settings');
    assert.equal(state.ui.activeSettingsSection, 'tools');
    assert.equal(localStorage.getItem('jenny.settings.activeSection'), 'tools');
    assert.deepEqual(calls, [
      'createSettingsRenderer',
      'createSettingsEventBindings',
      'createSettingsNavController',
      'settingsNav.bind',
      'settingsEvents.bind',
      // bind() renders before mounting the per-field reset affordances:
      // mountFieldEntry() resolves each select by id and mount() latches after
      // its first pass, so a control that renderSettings() mounts (Chat width,
      // via the inventory selectField) must exist before that pass runs.
      'renderSettings',
      'setActiveView:settings',
      'settingsNav.restore',
      'renderSettings',
      'renderComposerPopover',
      'renderCommandPopover',
      'syncComposerInputHeight',
      'syncComposerModelSelectWidth',
      'settingsEvents.dispose',
      'settingsNav.dispose',
    ]);
  } finally {
    global.window = previousWindow;
    global.document = previousDocument;
  }
});

test('settings shell controller initializes retained lazy sections once and readies Skills with its host', async () => {
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

  const sectionDomCalls = { proactive: 0, skills: 0, tips: 0, offline: 0 };
  const bindingCalls = { proactive: 0, skills: 0, tips: 0, offline: 0 };
  const lazyBinderCalls = { skills: 0, tips: 0, offline: 0 };
  const refreshCalls = { proactive: 0, offline: 0, skills: 0, tips: 0, personality: 0, memories: 0 };
  let navArgs = null;

  global.window = { localStorage };
  global.document = { getElementById() { return null; } };

  try {
    const state = {
      currentSessionId: 'session-42',
      ui: {
        activeView: 'settings',
        activeSettingsSection: 'models',
      },
    };
    const controller = createSettingsShellController({
      state,
      composerLayoutRuntime: {},
      dom: {
        settingsView,
        getSectionDom(sectionId) {
          if (Object.prototype.hasOwnProperty.call(sectionDomCalls, sectionId)) {
            sectionDomCalls[sectionId] += 1;
          }
          return {};
        },
      },
      constants: {
        ACTIVITY_SCOPE: {},
        TOAST_SOURCE: {},
      },
      callbacks: {
        appendClientLog() {},
        renderAll() {},
        renderSessions() {},
        toErrorMessage(error, fallback) {
          return error?.message || fallback;
        },
        getCurrentRuntimePreferences() { return {}; },
        getRuntimePreferenceSnapshot() { return {}; },
        runRuntimePreferenceActivity: async () => {},
        listSlashCommands() { return []; },
        refreshProactiveState: async () => { refreshCalls.proactive += 1; },
        refreshSkillsState: async () => { refreshCalls.skills += 1; },
        bindSkillsShellEvents: () => { lazyBinderCalls.skills += 1; },
        refreshTipsState: async () => { refreshCalls.tips += 1; },
        bindTipsShellEvents: () => { lazyBinderCalls.tips += 1; },
        refreshOfflineState: async () => { refreshCalls.offline += 1; },
        bindOfflineShellEvents: () => { lazyBinderCalls.offline += 1; },
        refreshPersonalityWorkspace: async () => { refreshCalls.personality += 1; },
        refreshApprovedMemories: async () => { refreshCalls.memories += 1; },
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
              ensureSectionBindings(sectionId) {
                if (Object.prototype.hasOwnProperty.call(bindingCalls, sectionId)) {
                  bindingCalls[sectionId] += 1;
                }
              },
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
            };
          },
        },
      },
    });

    controller.bind();
    assert.ok(navArgs, 'expected nav controller args');

    // Skills is merged under Plugins & Extensions. Offline remains direct.
    // Retired Proactive/Tips Settings owners are never readied or refreshed.
    navArgs.onSectionChange('plugins', 'models');
    await flushAsyncWork();
    navArgs.onSectionChange('offline', 'plugins');
    await flushAsyncWork();
    navArgs.onSectionChange('plugins', 'offline');
    await flushAsyncWork();

    // Each lazy section (including the merged companions) binds exactly once.
    assert.deepEqual(sectionDomCalls, {
      proactive: 0,
      skills: 1,
      tips: 0,
      offline: 1,
    });
    assert.deepEqual(bindingCalls, {
      proactive: 0,
      skills: 1,
      tips: 0,
      offline: 1,
    });
    assert.deepEqual(lazyBinderCalls, {
      skills: 1,
      tips: 0,
      offline: 1,
    });
    assert.deepEqual(refreshCalls, {
      proactive: 0,
      offline: 1,
      skills: 2,
      tips: 0,
      personality: 0,
      memories: 0,
    });
    assert.equal(controller.isSectionInitialized('proactive'), false);
    assert.equal(controller.isSectionInitialized('skills'), true);
    assert.equal(controller.isSectionInitialized('tips'), false);
    assert.equal(controller.isSectionInitialized('offline'), true);
  } finally {
    global.window = previousWindow;
    global.document = previousDocument;
  }
});

test('settings shell controller retries lazy section initialization when bindings are deferred', () => {
  const previousWindow = global.window;
  const previousDocument = global.document;

  global.window = { localStorage: createLocalStorage() };
  global.document = { getElementById() { return null; } };

  const settingsView = {
    querySelector() {
      return null;
    },
  };
  let ensureAttempts = 0;
  let sectionDomCalls = 0;

  try {
    const controller = createSettingsShellController({
      state: {
        ui: {
          activeView: 'settings',
          activeSettingsSection: 'models',
        },
      },
      composerLayoutRuntime: {},
      dom: {
        settingsView,
        getSectionDom(sectionId) {
          if (sectionId === 'offline') {
            sectionDomCalls += 1;
          }
          return {};
        },
      },
      constants: {
        ACTIVITY_SCOPE: {},
        TOAST_SOURCE: {},
      },
      callbacks: {
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
              renderSettings() {},
            };
          },
        },
        settingsEventUtils: {
          createSettingsEventBindings() {
            return {
              bind() {},
              dispose() {},
              ensureSectionBindings(sectionId) {
                if (sectionId === 'offline') {
                  ensureAttempts += 1;
                  return ensureAttempts > 1;
                }
                return true;
              },
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

    controller.ensureSettingsSectionReady('offline');
    assert.equal(controller.isSectionInitialized('offline'), false);

    controller.ensureSettingsSectionReady('offline');
    assert.equal(controller.isSectionInitialized('offline'), true);
    assert.equal(ensureAttempts, 2);
    assert.equal(sectionDomCalls, 2);
  } finally {
    global.window = previousWindow;
    global.document = previousDocument;
  }
});

// Regression: the settings event bindings receive their callbacks through a
// hand-copied forwarding object here, and the runSetupAgain click delegation
// no-ops silently when its callback is missing (typeof guard) -- exactly how
// the "Run setup again" button shipped dead while its siblings worked.
test('settings shell controller forwards the setup action callbacks into the event bindings', () => {
  const previousWindow = global.window;
  const previousDocument = global.document;

  global.window = { localStorage: createLocalStorage() };
  global.document = { getElementById() { return null; } };

  const invoked = [];
  let forwardedCallbacks = null;

  try {
    const controller = createSettingsShellController({
      state: { ui: { activeView: 'chat', activeSettingsSection: 'models' } },
      composerLayoutRuntime: {},
      dom: { settingsView: { querySelector() { return null; } } },
      constants: { ACTIVITY_SCOPE: {}, TOAST_SOURCE: {} },
      callbacks: {
        setActiveView() {},
        renderAll() {},
        renderSessions() {},
        appendClientLog() {},
        showToastMessage() {},
        showShellErrorToast() {},
        toErrorMessage(error, fallback) { return error?.message || fallback; },
        getCurrentRuntimePreferences() { return {}; },
        getRuntimePreferenceSnapshot() { return {}; },
        runRuntimePreferenceActivity: async () => {},
        listSlashCommands() { return []; },
        handleRunSetupAgain() { invoked.push('handleRunSetupAgain'); },
        showSetupHelp() { invoked.push('showSetupHelp'); },
        showFactoryReset() { invoked.push('showFactoryReset'); },
      },
      factories: {
        settingsRendererUtils: {
          createSettingsRenderer() {
            return {
              renderSettings() {},
              renderComposerPopover() {},
              renderCommandPopover() {},
              syncComposerInputHeight() {},
              syncComposerModelSelectWidth() {},
            };
          },
        },
        settingsEventUtils: {
          createSettingsEventBindings(deps) {
            forwardedCallbacks = deps.callbacks;
            return { bind() {}, dispose() {} };
          },
        },
        settingsNavUtils: {
          createSettingsNavController() {
            return { bind() {}, dispose() {}, restoreActiveSection() {} };
          },
        },
      },
    });

    assert.ok(controller);
    assert.ok(forwardedCallbacks, 'createSettingsEventBindings received deps.callbacks');
    for (const name of ['handleRunSetupAgain', 'showSetupHelp', 'showFactoryReset']) {
      assert.equal(typeof forwardedCallbacks[name], 'function', `${name} is forwarded`);
      forwardedCallbacks[name]();
    }
    assert.deepEqual(invoked, ['handleRunSetupAgain', 'showSetupHelp', 'showFactoryReset']);
  } finally {
    global.window = previousWindow;
    global.document = previousDocument;
  }
});
