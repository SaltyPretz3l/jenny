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
        features.tools = { ...features.tools, ...patch.tools };
        return features;
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

// The Appearance card delegates its mounted selects and switches to the shared
// binding; these harnesses carry the card with static controls of the same ids.
function createAppearanceHarness(markup, callbacks) {
  const harness = createHarness(`<section class="settings-card" data-settings-section="appearance">${markup}</section>`);
  const appliedPreferences = [];
  const controller = createSettingsEventBindings(createBaseDeps({
    dom: { appearanceSettingsSection: harness.document.querySelector('section') },
    callbacks: {
      applyAppearancePreferences(prefs) {
        appliedPreferences.push(prefs);
        return prefs;
      },
      ...callbacks,
    },
  }));
  return { harness, controller, appliedPreferences };
}

test('settings event bindings update palette without deriving a user motion preference', async () => {
  const { harness, controller, appliedPreferences } = createAppearanceHarness(
    '<select id="appearancePaletteSelect"><option value="midnight">Midnight</option><option value="signal">Signal</option></select>'
  );

  try {
    controller.bind();
    const paletteSelect = harness.document.getElementById('appearancePaletteSelect');
    paletteSelect.value = 'signal';
    paletteSelect.dispatchEvent(new harness.window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(appliedPreferences.length, 1);
    assert.equal(appliedPreferences[0].paletteId, 'signal');
    // Retired motion axes are never derived into the stored preferences.
    assert.equal('motionId' in appliedPreferences[0], false);
    assert.equal('explicitMotion' in appliedPreferences[0], false);
  } finally {
    controller.dispose();
    harness.cleanup();
  }
});

test('settings event bindings persist only the Composer typing-border preference', async () => {
  const { harness, controller, appliedPreferences } = createAppearanceHarness('<div id="appearanceHoloList"></div>');

  try {
    controller.bind();
    const holoList = harness.document.getElementById('appearanceHoloList');
    const fireHolo = (id, checked) => holoList.dispatchEvent(new harness.window.CustomEvent('inv-toggle-change', {
      bubbles: true, detail: { id, checked },
    }));
    fireHolo('appearanceComposerHoloToggle', false);
    fireHolo('appearanceSpriteHoloToggle', false);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(appliedPreferences.length, 1);
    assert.equal(appliedPreferences[0].composerHoloId, 'off');
    assert.equal('spriteHoloId' in appliedPreferences[0], false, 'the retired sprite holo axis is not written');

    // An id without a descriptor never writes a preference.
    fireHolo('unknownHoloToggle', true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(appliedPreferences.length, 1, 'retired or unknown holo ids must not write a preference');
  } finally {
    controller.dispose();
    harness.cleanup();
  }
});

test('settings event bindings apply theme bundle mappings and reactivate the bundle surface effect', async () => {
  const activatedEffects = [];
  let applySurfaceEffectCalls = 0;
  const { harness, controller, appliedPreferences } = createAppearanceHarness(
    '<select id="appearanceThemeBundleSelect"><option value="custom">Custom</option><option value="lexicon">Lexicon</option></select>',
    {
      applySurfaceEffect() {
        applySurfaceEffectCalls += 1;
      },
      activateSurfaceEffect(effectId) {
        activatedEffects.push(effectId);
      },
    }
  );

  try {
    controller.bind();
    const bundleSelect = harness.document.getElementById('appearanceThemeBundleSelect');
    bundleSelect.value = 'lexicon';
    bundleSelect.dispatchEvent(new harness.window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(appliedPreferences.length, 1);
    assert.equal(appliedPreferences[0].paletteId, 'lexicon');
    assert.equal(appliedPreferences[0].typographyId, 'editorial');
    assert.equal(appliedPreferences[0].surfaceEffectId, 'none');
    assert.equal(applySurfaceEffectCalls, 1);
    assert.deepEqual(activatedEffects, ['none']);
  } finally {
    controller.dispose();
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
    assert.equal(fixture.toggle.getAttribute('aria-checked'), 'true', 'a manifest field without a descriptor still saves and syncs');
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
    assert.equal(fixture.toggle.getAttribute('aria-checked'), 'false');
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

test('settings event bindings save the web search provider through the features adapter and hydrate key status', async () => {
  const harness = createHarness(
    '<div id="toolsConfigFieldList">'
      + '<select id="webSearchProviderSelect" data-web-search-field="provider"><option value="duckduckgo">DuckDuckGo</option><option value="brave">Brave</option></select>'
      + '</div>'
  );
  const patches = [];
  let statusReads = 0;
  harness.window.jennyShell.features = { async getWebSearchSecretStatus() { statusReads += 1; return { configured: {} }; } };
  const features = { featureFlags: {}, webSearch: { provider: 'duckduckgo', searxngUrl: '' } };
  const controller = createSettingsEventBindings(createBaseDeps({
    state: { features },
    dom: { toolsConfigFieldList: harness.document.getElementById('toolsConfigFieldList') },
    callbacks: {
      async refreshFeatureState(patch) {
        patches.push(patch);
        features.webSearch = { ...features.webSearch, ...patch.webSearch };
        return features;
      },
    },
  }));

  try {
    controller.bind();
    const select = harness.document.getElementById('webSearchProviderSelect');
    select.value = 'brave';
    select.dispatchEvent(new harness.window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(patches, [{ webSearch: { provider: 'brave' } }]);
    assert.equal(statusReads, 1, 'a confirmed provider change hydrates the configured-key hints once');
    // Retired private routing: a change on an unbound element never writes.
    select.removeAttribute('id');
    select.dispatchEvent(new harness.window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(patches.length, 1);
  } finally {
    controller.dispose();
    harness.cleanup();
  }
});

test('settings event bindings route context runtime feature toggles through feature settings', async () => {
  const harness = createHarness(
    '<div id="contextSourcesList"></div>'
      + '<div id="contextRuntimeList">'
      + '<button type="button" role="switch" aria-checked="false" data-inv-toggle="contextCompactionToggle"></button>'
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
        detail: { id: 'contextCompactionToggle', checked: true },
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The runtime switch routes through applyFeatureSettings -> refreshFeatureState
    // as a featureOverrides patch, identical to the pre-switch checkbox handler.
    assert.deepEqual(patches, [{ featureOverrides: { context_compaction: true } }]);
  } finally {
    harness.cleanup();
  }
});

test('settings event bindings pass "section shown" through to the Runtime limits poller', async () => {
  const harness = createHarness('<div id="settingsView"><div id="advancedTuningFields"></div></div>');
  const { snapshot } = require('./helpers/runs-orchestration-harness');
  let reads = 0;
  try {
    Object.assign(harness.window, {
      rendererRunsView: require('../renderer/shell/renderer-runs-view.js'),
      rendererRuntimeLimitsView: require('../renderer/shell/renderer-runtime-limits-view.js'),
      rendererOrchestrationController: require('../renderer/shell/renderer-orchestration-controller.js'),
    });
    harness.window.jennyShell.sessionRuntime = {
      async getSnapshot() { reads += 1; return snapshot([]); },
    };
    const controller = createSettingsEventBindings(createBaseDeps({
      state: { ui: { activeView: 'settings', activeSettingsSection: 'advanced' }, sessions: [] },
      dom: { settingsView: harness.document.getElementById('settingsView') },
    }));
    controller.bind();
    controller.ensureSectionBindings('runtimeLimits');
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reads, 1, 'the section binds and reads once');
    controller.sectionShown('runtimeLimits');
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reads, 2, 'shown again: a read now, not after the pending tick');
    controller.dispose();
  } finally {
    harness.cleanup();
  }
});

test('history scope and the context switches share one runtimePreferences write path', async () => {
  const harness = createHarness(
    '<div data-settings-section="context">'
      + '<div role="radiogroup" data-inv-segmented="contextHistoryScopeSelect"></div>'
      + '<div id="contextSourcesList">'
      + '<button type="button" role="switch" aria-checked="true" data-inv-toggle="contextIncludePersonalityToggle"></button>'
      + '</div></div>'
  );
  const preferences = { contextPreferences: { historyScope: 'session', includePersonality: true, includeMemory: true } };
  const writes = [];
  const controller = createSettingsEventBindings(createBaseDeps({
    dom: {
      contextSettingsSection: harness.document.querySelector('[data-settings-section="context"]'),
      contextSourcesList: harness.document.getElementById('contextSourcesList'),
    },
    callbacks: {
      getCurrentRuntimePreferences() { return preferences; },
      runRuntimePreferenceActivity({ patch }) {
        return new Promise((resolve) => {
          writes.push({ patch, settle: () => { preferences.contextPreferences = { ...patch.contextPreferences }; resolve(); } });
        });
      },
    },
  }));
  try {
    controller.bind();
    harness.document.getElementById('contextSourcesList').dispatchEvent(
      new harness.window.CustomEvent('inv-toggle-change', { bubbles: true, detail: { id: 'contextIncludePersonalityToggle', checked: false } })
    );
    harness.document.querySelector('[data-inv-segmented="contextHistoryScopeSelect"]').dispatchEvent(
      new harness.window.CustomEvent('inv-segmented-change', { bubbles: true, detail: { id: 'contextHistoryScopeSelect', value: 'recent' } })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(writes.length, 1, 'the scope change queues behind the switch write instead of racing it');
    writes[0].settle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(writes.length, 2);
    // The queued write composes on the acknowledged baseline: neither change is lost.
    assert.deepEqual(writes[1].patch.contextPreferences, { historyScope: 'recent', includePersonality: false, includeMemory: true });
    writes[1].settle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(preferences.contextPreferences, { historyScope: 'recent', includePersonality: false, includeMemory: true });
  } finally {
    controller.dispose();
    harness.cleanup();
  }
});
