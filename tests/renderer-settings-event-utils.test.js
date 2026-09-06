/* global window */
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createSettingsEventBindings } = require('../renderer/shell/renderer-settings-event-utils.js');
const { createLazyDomResolver } = require('../renderer/shell/renderer-bootstrap-dom.js');

function createHarness(markup) {
  const dom = new JSDOM(`<!doctype html><html><body>${markup}</body></html>`, {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousAbortController = global.AbortController;
  global.window = dom.window;
  global.document = dom.window.document;
  global.AbortController = dom.window.AbortController;
  global.window.jennyShell = {
    comet: {},
    models: {},
  };
  return {
    window: dom.window,
    document: dom.window.document,
    cleanup() {
      global.window = previousWindow;
      global.document = previousDocument;
      global.AbortController = previousAbortController;
      dom.window.close();
    },
  };
}

function createBaseDeps(overrides = {}) {
  const stateOverride = overrides.state || {};
  const baseState = {
    ui: {
      appearance: {
        paletteId: 'sunrise',
        typographyId: 'humanist',
        motionId: 'soft',
        surfaceEffectId: 'mist',
        composerHoloId: 'balanced',
        spriteHoloId: 'balanced',
        threadStyleId: 'subtle',
        explicitMotion: false,
      },
    },
    features: { featureFlags: {} },
    memoryManager: { filter: 'all', searchQuery: '' },
    modelList: [],
    personality: {},
  };
  return {
    state: {
      ...baseState,
      ...stateOverride,
      ui: {
        ...baseState.ui,
        ...(stateOverride.ui || {}),
      },
    },
    constants: {
      TOAST_SOURCE: { settings: 'settings', memory: 'memory' },
      ACTIVITY_SCOPE: {},
    },
    dom: {
      settingsView: null,
      getSectionDom() {
        return {};
      },
      ...overrides.dom,
    },
    callbacks: {
      renderSettings() {},
      renderSessions() {},
      setSidebarCollapsed() {},
      upsertApprovedMemoryDraft() {},
      getApprovedMemoryById() { return null; },
      hasApprovedMemoryDraftChanges() { return false; },
      clearApprovedMemoryDraft() {},
      handleApprovedMemorySave: async () => {},
      handleApprovedMemoryDelete() {},
      applyAppearancePreferences() {},
      appearanceUtils: null,
      getDefaultAppearancePreferences() {
        return {
          paletteId: 'sunrise',
          typographyId: 'humanist',
          motionId: 'soft',
          surfaceEffectId: 'mist',
          composerHoloId: 'balanced',
          spriteHoloId: 'balanced',
          threadStyleId: 'subtle',
          explicitMotion: false,
        };
      },
      applySurfaceEffect() {},
      activateSurfaceEffect() {},
      handlePersonalityTabChange: async () => {},
      getPersonalityActiveFile() { return null; },
      setPersonalityDraft() {},
      renderPersonalityEditor() {},
      handlePersonalitySave: async () => {},
      handlePersonalityReset: async () => {},
      handlePersonalityOpenFolder: async () => {},
      showToastMessage() {},
      showShellErrorToast() {},
      toErrorMessage(error, fallback) {
        return error?.message || fallback;
      },
      appendClientLog() {},
      showSessionActionError() {},
      getCurrentRuntimePreferences() {
        return {
          contextPreferences: {
            historyScope: 'session',
            includePersonality: true,
            includeMemory: true,
          },
        };
      },
      getRuntimePreferenceSnapshot() {
        return {};
      },
      runRuntimePreferenceActivity: async () => {},
      openSettingsSection() {},
      handleWorkspaceRootChoose: async () => {},
      refreshSkillsState: async () => {},
      updateSkillsSettings() {},
      openSkillsScopeFolder() {},
      handleOfflineModeChange: async () => {},
      refreshFeatureState: async () => {},
      setActiveView() {},
      ...overrides.callbacks,
    },
  };
}

function createToolConfigToggleHarness({ availabilityEnabled } = {}) {
  const harness = createHarness(
    '<div id="toolConfigList">'
      + '<button type="button" role="switch" aria-checked="false" data-inv-toggle="settings-tool-config-futureTool"></button>'
      + '</div>'
  );
  const patches = [];
  let renderSettingsCalls = 0;
  const features = {
    tools: { futureTool: false },
    featureFlags: {},
    toolConfig: {
      schemaVersion: 1,
      fields: [
        {
          key: 'futureTool',
          label: 'Future tool',
          fieldType: 'toggle',
          storage: 'config',
          default: false,
          toolIds: ['future_tool'],
        },
      ],
    },
  };
  if (typeof availabilityEnabled === 'boolean') {
    features.availability = {
      tools: {
        futureTool: { enabled: availabilityEnabled },
      },
    };
  }

  const toolConfigList = harness.document.getElementById('toolConfigList');
  const controller = createSettingsEventBindings(createBaseDeps({
    state: {
      features,
    },
    dom: {
      toolsConfigFieldList: toolConfigList,
    },
    callbacks: {
      async refreshFeatureState(patch) {
        patches.push(patch);
      },
      renderSettings() {
        renderSettingsCalls += 1;
      },
    },
  }));
  return {
    harness,
    controller,
    toolConfigList,
    toggle: toolConfigList.querySelector('[data-inv-toggle="settings-tool-config-futureTool"]'),
    patches,
    getRenderSettingsCalls() {
      return renderSettingsCalls;
    },
  };
}

test('lazy DOM resolver re-queries slices that first resolved to missing nodes', () => {
  const harness = createHarness('');

  try {
    const getSectionDom = createLazyDomResolver(harness.document, {
      proactive: {
        proactiveSection: { selector: '[data-settings-section="proactive"]' },
        proactiveMorningBriefingToggle: 'proactiveMorningBriefingToggle',
      },
    });

    const first = getSectionDom('proactive');
    assert.equal(first.proactiveSection, null);
    assert.equal(first.proactiveMorningBriefingToggle, null);

    harness.document.body.innerHTML = '<section data-settings-section="proactive">'
      + '<input id="proactiveMorningBriefingToggle" type="checkbox" />'
      + '</section>';

    const second = getSectionDom('proactive');
    assert.ok(second.proactiveSection);
    assert.ok(second.proactiveMorningBriefingToggle);
    assert.notEqual(second, first);
  } finally {
    harness.cleanup();
  }
});

test('settings event bindings route Control Tower section jumps through settings navigation', () => {
  const harness = createHarness(
    '<div id="settingsView">'
      + '<button type="button" data-settings-control-section="tools">Open Tools</button>'
      + '</div>'
  );
  const navigationCalls = [];

  try {
    const settingsView = harness.document.getElementById('settingsView');
    const controller = createSettingsEventBindings(createBaseDeps({
      dom: {
        settingsView,
      },
      callbacks: {
        openSettingsSection(sectionId, options) {
          navigationCalls.push({ sectionId, options });
        },
      },
    }));

    controller.bind();
    settingsView.querySelector('[data-settings-control-section="tools"]')
      .dispatchEvent(new harness.window.MouseEvent('click', { bubbles: true }));

    assert.deepEqual(navigationCalls, [
      { sectionId: 'tools', options: { source: 'control_tower' } },
    ]);
  } finally {
    harness.cleanup();
  }
});

test('settings event bindings let native Control Tower buttons own keyboard activation', () => {
  const harness = createHarness(
    '<div id="settingsView">'
      + '<button type="button" data-settings-control-section="tools">Open Tools</button>'
      + '</div>'
  );
  const navigationCalls = [];

  try {
    const settingsView = harness.document.getElementById('settingsView');
    const controller = createSettingsEventBindings(createBaseDeps({
      dom: {
        settingsView,
      },
      callbacks: {
        openSettingsSection(sectionId, options) {
          navigationCalls.push({ sectionId, options });
        },
      },
    }));

    controller.bind();
    settingsView.querySelector('[data-settings-control-section="tools"]')
      .dispatchEvent(new harness.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    assert.deepEqual(navigationCalls, []);
  } finally {
    harness.cleanup();
  }
});

test('settings event bindings update palette without deriving a user motion preference', () => {
  const harness = createHarness('<select id="palette"><option value="ocean">Ocean</option></select>');
  const appliedPreferences = [];

  try {
    const paletteSelect = harness.document.getElementById('palette');
    const controller = createSettingsEventBindings(createBaseDeps({
      dom: {
        appearancePaletteSelect: paletteSelect,
      },
      callbacks: {
        applyAppearancePreferences(prefs) {
          appliedPreferences.push(prefs);
        },
      },
    }));

    controller.bind();
    paletteSelect.value = 'ocean';
    paletteSelect.dispatchEvent(new harness.window.Event('change', { bubbles: true }));

    assert.equal(appliedPreferences.length, 1);
    assert.equal(appliedPreferences[0].paletteId, 'ocean');
    assert.equal(appliedPreferences[0].motionId, 'soft');
    assert.equal(appliedPreferences[0].explicitMotion, false);
  } finally {
    harness.cleanup();
  }
});

test('settings event bindings persist only the Composer typing-border preference', () => {
  const harness = createHarness('<div id="holoList"></div>');
  const appliedPreferences = [];

  try {
    const holoList = harness.document.getElementById('holoList');
    const controller = createSettingsEventBindings(createBaseDeps({
      dom: {
        appearanceHoloList: holoList,
      },
      callbacks: {
        applyAppearancePreferences(prefs) {
          appliedPreferences.push(prefs);
        },
      },
    }));

    controller.bind();
    const fireHolo = (id, checked) => holoList.dispatchEvent(new harness.window.CustomEvent('inv-toggle-change', {
      bubbles: true, detail: { id, checked },
    }));
    fireHolo('appearanceComposerHoloToggle', false);
    fireHolo('appearanceSpriteHoloToggle', false);

    assert.equal(appliedPreferences.length, 1);
    assert.equal(appliedPreferences[0].composerHoloId, 'off');
    assert.equal(appliedPreferences[0].spriteHoloId, 'balanced');

    // The handler guards ids outside HOLO_PREFERENCE_KEYS; an unknown id must
    // not write a preference (kills a guard-removal mutation).
    fireHolo('unknownHoloToggle', true);
    assert.equal(appliedPreferences.length, 1, 'retired or unknown holo ids must not write a preference');
  } finally {
    harness.cleanup();
  }
});

test('settings event bindings apply theme bundle mappings and reactivate the bundle surface effect', () => {
  const harness = createHarness('<select id="bundle"><option value="lexicon">Lexicon</option></select>');
  const appliedPreferences = [];
  const activatedEffects = [];
  let applySurfaceEffectCalls = 0;

  try {
    const bundleSelect = harness.document.getElementById('bundle');
    const controller = createSettingsEventBindings(createBaseDeps({
      dom: {
        appearanceThemeBundleSelect: bundleSelect,
      },
      callbacks: {
        appearanceUtils: {
          resolveThemeBundle(bundleId) {
            if (bundleId !== 'lexicon') {
              return null;
            }
            return {
              id: 'lexicon',
              preferences: {
                paletteId: 'lexicon',
                typographyId: 'editorial',
                surfaceEffectId: 'none',
                composerHoloId: 'on',
              },
            };
          },
        },
        applyAppearancePreferences(prefs) {
          appliedPreferences.push(prefs);
          return prefs;
        },
        applySurfaceEffect() {
          applySurfaceEffectCalls += 1;
        },
        activateSurfaceEffect(effectId) {
          activatedEffects.push(effectId);
        },
      },
    }));

    controller.bind();
    bundleSelect.value = 'lexicon';
    bundleSelect.dispatchEvent(new harness.window.Event('change', { bubbles: true }));

    assert.equal(appliedPreferences.length, 1);
    assert.equal(appliedPreferences[0].paletteId, 'lexicon');
    assert.equal(appliedPreferences[0].surfaceEffectId, 'none');
    assert.equal(applySurfaceEffectCalls, 1);
    assert.deepEqual(activatedEffects, ['none']);
  } finally {
    harness.cleanup();
  }
});

test('settings event bindings save manifest-backed tool toggles through feature settings', async () => {
  const fixture = createToolConfigToggleHarness();

  try {
    fixture.controller.bind();
    fixture.toggle.dispatchEvent(
      new fixture.harness.window.CustomEvent('inv-toggle-change', {
        bubbles: true,
        detail: {
          id: 'settings-tool-config-futureTool',
          checked: true,
        },
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(fixture.patches, [{ tools: { futureTool: true } }]);
    assert.equal(fixture.getRenderSettingsCalls(), 1);
  } finally {
    fixture.harness.cleanup();
  }
});

test('settings event bindings ignore blocked manifest-backed tool toggles', async () => {
  const fixture = createToolConfigToggleHarness({ availabilityEnabled: false });

  try {
    fixture.controller.bind();
    fixture.toggle.dispatchEvent(
      new fixture.harness.window.CustomEvent('inv-toggle-change', {
        bubbles: true,
        detail: {
          id: 'settings-tool-config-futureTool',
          checked: true,
        },
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(fixture.patches, []);
    assert.equal(fixture.getRenderSettingsCalls(), 1);
  } finally {
    fixture.harness.cleanup();
  }
});

test('settings web provider connection test reports bounded harness probe result', async () => {
  const harness = createHarness(
    '<div id="toolsConfigFieldList">'
      + '<button data-web-search-test="true">Test connection</button>'
      + '<div data-web-search-test-status></div>'
      + '</div>'
  );
  harness.window.jennyShell.harness = {
    inspect: async () => ({
      web_search_probe: { ok: false, error: 'x'.repeat(300) },
    }),
  };
  const controller = createSettingsEventBindings(createBaseDeps({
    dom: { toolsConfigFieldList: harness.document.getElementById('toolsConfigFieldList') },
  }));

  try {
    controller.bind();
    harness.document.querySelector('[data-web-search-test]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const message = harness.document.querySelector('[data-web-search-test-status]').textContent;
    assert.match(message, /^Connection failed: /);
    assert.ok(message.length <= 'Connection failed: '.length + 160);
  } finally {
    harness.cleanup();
  }
});

test('settings event bindings route context runtime feature toggles through feature settings', async () => {
  const harness = createHarness(
    '<div id="contextSourcesList"></div>'
      + '<div id="contextRuntimeList">'
      + '<button type="button" role="switch" aria-checked="false" data-inv-toggle="contextTokenBudgetToggle"></button>'
      + '</div>'
  );
  const patches = [];
  const controller = createSettingsEventBindings(createBaseDeps({
    dom: {
      contextSourcesList: harness.document.getElementById('contextSourcesList'),
      contextRuntimeList: harness.document.getElementById('contextRuntimeList'),
    },
    callbacks: {
      async refreshFeatureState(patch) {
        patches.push(patch);
      },
    },
  }));

  try {
    controller.bind();
    harness.document.getElementById('contextRuntimeList').dispatchEvent(
      new harness.window.CustomEvent('inv-toggle-change', {
        bubbles: true,
        detail: { id: 'contextTokenBudgetToggle', checked: true },
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The runtime switch routes through applyFeatureSettings -> refreshFeatureState
    // as a featureOverrides patch, identical to the pre-switch checkbox handler.
    assert.deepEqual(patches, [{ featureOverrides: { token_budget: true } }]);
  } finally {
    harness.cleanup();
  }
});
