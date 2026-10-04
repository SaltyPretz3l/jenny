/* global window */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const selectField = require('../renderer/inventory/select-field.js');
const { toggleSwitch } = require('../renderer/inventory/toggle-switch.js');
const numberInput = require('../renderer/inventory/number-input.js');
const i18nUtils = require('../renderer/shared/i18n-utils.js');
const support = require('../renderer/shell/renderer-settings-support.js');
const fieldCopy = require('../renderer/shell/renderer-settings-field-copy.js');
const fieldBinding = require('../renderer/shell/renderer-settings-field-binding.js');
const fieldDescriptors = require('../renderer/shell/renderer-settings-field-descriptors.js');
const { createSettingsEventBindings } = require('../renderer/shell/renderer-settings-event-utils.js');
const { segmentedGroup, segmentedValue, chooseSegmented } = require('./helpers/segmented-control');
const { settingRow } = require('./helpers/settings-rows');

const LANGUAGE_LABELS = [
  'English', 'Español (Spanish)', 'Français (French)', 'Deutsch (German)', 'Italiano (Italian)',
  'Português do Brasil (Brazilian Portuguese)', 'Nederlands (Dutch)', 'Polski (Polish)',
  'Русский (Russian)', 'Українська (Ukrainian)', 'Türkçe (Turkish)', 'العربية (Arabic)',
  'हिन्दी (Hindi)', 'Bahasa Indonesia (Indonesian)', 'Tiếng Việt (Vietnamese)', '日本語 (Japanese)',
  '한국어 (Korean)', '简体中文 (Simplified Chinese)', '繁體中文 (Traditional Chinese)',
];

function parse(markup) {
  return new JSDOM(`<!doctype html><body>${markup}</body>`).window.document;
}

test('chat UI field builders render descriptor rows with current values and help', () => {
  const cases = [
    {
      markup: support.buildUiLanguageFieldMarkup({ value: 'ja', selectField }),
      id: 'uiLanguageSelect', value: 'ja', hint: 'Applies after you restart Jenny.',
    },
    {
      markup: settingRow('safetyModeSelect', 'strict', { selectField }),
      id: 'safetyModeSelect', value: 'strict', hint: 'Strict removes web tools.', segmented: true,
    },
    {
      markup: settingRow('unattendedGuardMinutesInput', 45, { numberInput, selectField }),
      id: 'unattendedGuardMinutesInput', value: '45', hint: 'After this long with no keyboard or mouse activity',
    },
    {
      markup: settingRow('autoApproveStreakCapInput', 75, { numberInput }),
      id: 'autoApproveStreakCapInput', value: '75', hint: 'Empty means no limit.',
    },
  ];
  for (const entry of cases) {
    const document = parse(entry.markup);
    const control = entry.segmented ? segmentedGroup(document, entry.id) : document.getElementById(entry.id);
    assert.ok(control, `${entry.id}: inventory control rendered`);
    assert.equal(entry.segmented ? segmentedValue(document, entry.id) : control.value, entry.value);
    const row = control.closest('[data-settings-field]');
    assert.ok(row, `${entry.id}: rendered inside a settings-field row`);
    assert.ok(row.querySelector('.settings-field-meta'), `${entry.id}: the meta line is rendered`);
    assert.match(row.querySelector('.settings-field-help').textContent, new RegExp(entry.hint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    document.defaultView.close();
  }
});

test('language options exactly match supported tags and endonym labels', () => {
  assert.deepEqual(support.UI_LANGUAGE_TAGS, i18nUtils.SUPPORTED_TAGS);
  const document = parse(support.buildUiLanguageFieldMarkup({ value: 'en', selectField }));
  const options = [...document.querySelectorAll('#uiLanguageSelect option')];
  assert.deepEqual(options.map((option) => option.value), [...i18nUtils.SUPPORTED_TAGS]);
  assert.deepEqual(options.map((option) => option.textContent), LANGUAGE_LABELS);
  document.defaultView.close();
});

test('streak cap normalizer defaults, clamps, and preserves off', () => {
  assert.equal(support.normalizeAutoApproveStreakCap(undefined), 50);
  assert.equal(support.normalizeAutoApproveStreakCap('nope'), 50);
  assert.equal(support.normalizeAutoApproveStreakCap(0), 0);
  assert.equal(support.normalizeAutoApproveStreakCap(999), 500);
});

test('renderer bootstrap, hydration, and settings composition thread the streak cap', () => {
  const root = path.join(__dirname, '..', 'renderer');
  const bootstrap = fs.readFileSync(path.join(root, 'shell', 'renderer-bootstrap-utils.js'), 'utf8');
  const lifecycle = fs.readFileSync(path.join(root, 'app', 'renderer-app-lifecycle-composition.js'), 'utf8');
  const settings = fs.readFileSync(path.join(root, 'shell', 'renderer-settings-utils.js'), 'utf8');
  assert.match(bootstrap, /autoApproveStreakCap:\s*50/);
  assert.match(bootstrap, /normalizeAutoApproveStreakCap\(config\?\.autoApproveStreakCap\)/);
  assert.match(lifecycle, /normalizeAutoApproveStreakCap\?\.\(persistedChatZoomState\?\.autoApproveStreakCap\)/);
  assert.match(settings, /state\.autoApproveStreakCap/);
});

// The Settings markup the real renderer composes (support builders), bound by
// the real event bindings: chatUi, features, engines and runtimePreferences
// adapters behind stateful bridge fakes.
function createBindingHarness(options = {}) {
  const guardMinutes = options.unattendedGuardMinutes ?? 10;
  const prefs = { historyScope: 'session', includePersonality: true, includeMemory: true };
  const lists = support.buildContextToggleListsMarkup({ contextPreferences: prefs, featureFlags: { token_budget: true, context_compaction: true }, toggleSwitch });
  const dom = new JSDOM('<!doctype html><body><div id="settingsView">'
    + support.buildUiLanguageFieldMarkup({ value: 'en', use24HourTime: false })
    // Appearance mounts this row in its Chat layout group; the chatUi binding finds it anywhere in the view.
    + fieldBinding.renderSettingRow(fieldDescriptors.getSettingDescriptor('transcriptViewDefaultSelect'), 'thinking', {})
    + '<div id="toolsConfigFieldList">'
    + settingRow('safetyModeSelect', 'normal')
    + settingRow('defaultRunModeSelect', 'ask')
    + settingRow('unattendedGuardMinutesInput', guardMinutes)
    + settingRow('autoApproveStreakCapInput', 50)
    + support.buildToolConfigFieldListMarkup({ fields: options.toolFields || support.DEFAULT_TOOL_CONFIG_FIELDS, tools: {}, availability: {}, toggleSwitch })
    + '</div>'
    + `<div id="contextSourcesList">${lists.sources}</div><div id="contextRuntimeList">${lists.runtime}</div>`
    + `<div id="modelStartupLoadList">${support.buildSettingsToggleListMarkup({ fields: [{ id: 'modelStartupLoadToggle', checked: true }], toggleSwitch })}</div>`
    + '</div></body>', { url: 'http://localhost/' });
  const previous = { window: global.window, document: global.document, AbortController: global.AbortController };
  global.window = dom.window;
  global.document = dom.window.document;
  global.AbortController = dom.window.AbortController;
  const patches = [];
  const featurePatches = [];
  const enginePatches = [];
  const prefRequests = [];
  const errors = [];
  const toasts = [];
  const renderSettingsCalls = [];
  const failures = { features: null, prefs: null };
  let snapshotForPatch = (patch) => patch;
  let engineResult = (patch) => ({ localEngines: { startupModelLoad: patch.startupModelLoad } });
  window.jennyShell = {
    chatUi: { async updateSettings(patch) { patches.push(patch); return snapshotForPatch(patch); } },
    engines: { async updateSettings(patch) { enginePatches.push(patch); return engineResult(patch); } },
  };
  const state = {
    defaultRunMode: 'ask', uiLanguage: 'en', safetyMode: 'normal', unattendedGuardMinutes: guardMinutes, autoApproveStreakCap: 50,
    use24HourTime: false, transcriptViewDefault: 'thinking',
    currentSessionId: '', runtimeDraft: { runMode: 'ask' },
    features: { tools: {}, featureFlags: { token_budget: true, context_compaction: true }, featureOverrides: {}, availability: { tools: {} },
      ...(options.toolFields ? { toolConfig: { fields: options.toolFields } } : {}) },
    localEngines: { startupModelLoad: true }, ui: {},
  };
  const byId = (id) => dom.window.document.getElementById(id);
  const controller = createSettingsEventBindings({
    state,
    constants: { TOAST_SOURCE: { settings: 'settings' }, ACTIVITY_SCOPE: { settingsContextPreferences: 'settings-context-preferences' } },
    dom: {
      settingsView: byId('settingsView'),
      toolsConfigFieldList: byId('toolsConfigFieldList'),
      contextSourcesList: byId('contextSourcesList'),
      contextRuntimeList: byId('contextRuntimeList'),
      modelStartupLoadList: byId('modelStartupLoadList'),
      getSectionDom() { return {}; },
    },
    callbacks: {
      renderSettings() { renderSettingsCalls.push(1); },
      renderAll() {},
      showSessionActionError(error, title) { errors.push({ error, title }); },
      showToastMessage(message, toastOptions) { toasts.push({ message, options: toastOptions }); },
      async refreshFeatureState(patch) {
        featurePatches.push(patch);
        if (failures.features) throw failures.features;
        Object.assign(state.features.tools, patch.tools);
        Object.assign(state.features.featureOverrides, patch.featureOverrides);
        Object.assign(state.features.featureFlags, patch.featureOverrides);
        return state.features;
      },
      openSettingsSection() {},
      getCurrentRuntimePreferences() { return { contextPreferences: { ...prefs } }; },
      getRuntimePreferenceSnapshot() { return { contextPreferences: { ...prefs } }; },
      async runRuntimePreferenceActivity(request) {
        prefRequests.push(request);
        if (failures.prefs) throw failures.prefs;
        Object.assign(prefs, request.patch.contextPreferences);
      },
    },
  });
  controller.bind();
  return {
    window: dom.window, document: dom.window.document, controller, state, prefs, patches, featurePatches, enginePatches, prefRequests, errors, toasts, renderSettingsCalls, failures,
    setSnapshot(fn) { snapshotForPatch = fn; },
    setEngineResult(fn) { engineResult = fn; },
    cleanup() {
      controller.dispose();
      global.window = previous.window;
      global.document = previous.document;
      global.AbortController = previous.AbortController;
      dom.window.close();
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// The reason a failed save shows where the change was made: on the row, or under the switch.
function shownError(harness, id) {
  const slot = harness.document.querySelector(`[data-settings-field="${id}"] .settings-field-error`);
  if (slot && !slot.hidden) return slot.textContent;
  const track = harness.document.querySelector(`[data-inv-toggle="${id}"]`);
  const line = track?.closest('.settings-field')?.querySelector('.settings-field-error') || track?.closest('.inv-toggle')?.querySelector('.inv-toggle-error');
  return line ? line.textContent : '';
}

// Dispatches the inventory toggle event from the switch itself, as a click would.
async function flip(harness, id, checked) {
  const track = harness.document.querySelector(`[data-inv-toggle="${id}"]`);
  track.dispatchEvent(new harness.window.CustomEvent('inv-toggle-change', { bubbles: true, detail: { id, checked } }));
  await settle();
}

async function change(harness, id, value) {
  const control = harness.document.getElementById(id);
  control.value = value;
  control.dispatchEvent(new harness.window.Event('change', { bubbles: true }));
  await settle();
}

// A three-option preference is a segmented group: choose as a click would.
async function pick(harness, id, value) {
  chooseSegmented(harness.document, id, value);
  await settle();
}

function checkedOf(harness, id) {
  return harness.document.querySelector(`[data-inv-toggle="${id}"]`).getAttribute('aria-checked');
}

test('chat UI choices and numbers persist through the chatUi adapter and roll back unconfirmed saves', async () => {
  const harness = createBindingHarness();
  try {
    await pick(harness, 'safetyModeSelect', 'paranoid');
    assert.deepEqual(harness.patches.pop(), { safetyMode: 'paranoid' });
    assert.equal(harness.state.safetyMode, 'paranoid');

    harness.setSnapshot(() => ({ safetyMode: 'paranoid' }));
    await pick(harness, 'safetyModeSelect', 'strict');
    assert.deepEqual(harness.patches.pop(), { safetyMode: 'strict' });
    assert.match(shownError(harness, 'safetyModeSelect'), /could not be confirmed/, 'a mismatched echo follows the error path');
    assert.equal(harness.errors.length, 0, 'the reason is on the row, so there is no toast');
    assert.equal(segmentedValue(harness.document, 'safetyModeSelect'), 'paranoid', 'the choice rolls back');
    assert.equal(harness.state.safetyMode, 'paranoid');

    harness.setSnapshot((patch) => patch);
    await change(harness, 'autoApproveStreakCapInput', '75');
    assert.deepEqual(harness.patches.pop(), { autoApproveStreakCap: 75 });
    assert.equal(harness.state.autoApproveStreakCap, 75);
    for (const invalid of ['999', '75.8', '-1']) {
      await change(harness, 'autoApproveStreakCapInput', invalid);
      assert.equal(harness.patches.length, 0, `${invalid} is rejected, never clamped`);
      assert.equal(harness.document.getElementById('autoApproveStreakCapInput').value, '75');
    }
    await change(harness, 'autoApproveStreakCapInput', '0');
    assert.deepEqual(harness.patches.pop(), { autoApproveStreakCap: 0 }, '0 (cap off) is a value');
    harness.setSnapshot(() => ({ autoApproveStreakCap: 0 }));
    await change(harness, 'autoApproveStreakCapInput', '60');
    assert.deepEqual(harness.patches.pop(), { autoApproveStreakCap: 60 });
    assert.match(shownError(harness, 'autoApproveStreakCapInput'), /could not be confirmed/);
    assert.equal(harness.document.getElementById('autoApproveStreakCapInput').value, '');

    harness.setSnapshot((patch) => patch);
    await change(harness, 'uiLanguageSelect', 'ja');
    assert.deepEqual(harness.patches.pop(), { uiLanguage: 'ja' });
    assert.equal(harness.state.uiLanguage, 'ja');
    assert.equal(harness.window.localStorage.getItem('jenny.ui.language'), 'ja');
    assert.equal(harness.toasts.length, 1);
    harness.setSnapshot(() => ({ uiLanguage: 'ja' }));
    await change(harness, 'uiLanguageSelect', 'fr');
    assert.deepEqual(harness.patches.pop(), { uiLanguage: 'fr' });
    assert.equal(harness.window.localStorage.getItem('jenny.ui.language'), 'ja', 'an unconfirmed language is not stored');
    assert.equal(harness.toasts.length, 1, 'and no restart toast is shown');
    assert.equal(harness.document.getElementById('uiLanguageSelect').value, 'ja');
  } finally {
    harness.cleanup();
  }
});

test('default run mode writes defaultRunMode, seeds the draft and rolls back an unconfirmed save', async () => {
  const harness = createBindingHarness();
  try {
    await pick(harness, 'defaultRunModeSelect', 'auto');
    assert.deepEqual(harness.patches.pop(), { defaultRunMode: 'auto' });
    assert.equal(harness.state.defaultRunMode, 'auto');
    assert.equal(harness.state.runtimeDraft.runMode, 'auto');

    harness.setSnapshot(() => ({ defaultRunMode: 'auto' }));
    await pick(harness, 'defaultRunModeSelect', 'plan');
    assert.deepEqual(harness.patches.pop(), { defaultRunMode: 'plan' });
    assert.match(shownError(harness, 'defaultRunModeSelect'), /could not be confirmed/);
    assert.equal(segmentedValue(harness.document, 'defaultRunModeSelect'), 'auto', 'the choice rolls back');
    assert.equal(harness.state.runtimeDraft.runMode, 'auto', 'the draft keeps the confirmed default');
  } finally {
    harness.cleanup();
  }
});

test('unattended guard dropdown writes off and selected minutes', async () => {
  const harness = createBindingHarness({ unattendedGuardMinutes: 45 });
  try {
    assert.equal(harness.document.getElementById('unattendedGuardModeSelect'), null, 'the Off/On select is gone');
    const input = harness.document.getElementById('unattendedGuardMinutesInput');
    assert.equal(harness.document.querySelector('[data-inv-toggle="unattendedGuardToggle"]'), null);
    assert.equal(input.value, '45');

    await change(harness, 'unattendedGuardMinutesInput', '0');
    assert.deepEqual(harness.patches.pop(), { unattendedGuardMinutes: 0 });
    assert.equal(harness.state.unattendedGuardMinutes, 0);
    assert.equal(input.selectedOptions[0].textContent, 'Never');
    assert.equal(input.disabled, false, 'the dropdown stays enabled while off');
    assert.equal(input.value, '0');

    await change(harness, 'unattendedGuardMinutesInput', '45');
    assert.deepEqual(harness.patches.pop(), { unattendedGuardMinutes: 45 }, 'choosing the preserved off-list option writes its minutes');
    assert.equal(input.disabled, false);
    assert.equal(input.value, '45');

    await change(harness, 'unattendedGuardMinutesInput', '30');
    assert.deepEqual(harness.patches.pop(), { unattendedGuardMinutes: 30 });
    await change(harness, 'unattendedGuardMinutesInput', '999');
    assert.equal(harness.patches.length, 0, 'out-of-range minutes are rejected');
    assert.equal(input.value, '30');
    await change(harness, 'unattendedGuardMinutesInput', '0');
    await change(harness, 'unattendedGuardMinutesInput', '30');
    assert.deepEqual(harness.patches.slice(-2), [{ unattendedGuardMinutes: 0 }, { unattendedGuardMinutes: 30 }]);
  } finally {
    harness.cleanup();
  }
  const fresh = createBindingHarness({ unattendedGuardMinutes: 0 });
  try {
    assert.equal(fresh.document.getElementById('unattendedGuardMinutesInput').value, '0');
    await change(fresh, 'unattendedGuardMinutesInput', '10');
    assert.deepEqual(fresh.patches.pop(), { unattendedGuardMinutes: 10 }, 'choosing 10 minutes enables the guard');
  } finally {
    fresh.cleanup();
  }
});

test('tool toggles save one features patch, honor runtime availability and roll back a failed save', async () => {
  const harness = createBindingHarness();
  try {
    await flip(harness, 'settings-tool-config-web', true);
    assert.deepEqual(harness.featurePatches, [{ tools: { web: true } }]);
    assert.equal(checkedOf(harness, 'settings-tool-config-web'), 'true');
    assert.equal(harness.renderSettingsCalls.length, 1);

    harness.failures.features = new Error('disk full');
    await flip(harness, 'settings-tool-config-lsp', true);
    assert.deepEqual(harness.featurePatches.at(-1), { tools: { lsp: true } });
    assert.equal(checkedOf(harness, 'settings-tool-config-lsp'), 'false', 'the switch rolls back');
    assert.equal(shownError(harness, 'settings-tool-config-lsp'), 'disk full', 'the reason shows under the switch');
    assert.equal(harness.errors.length, 0, 'and is not toasted as well');

    harness.failures.features = null;
    harness.state.features.availability.tools.bash = { enabled: false };
    await flip(harness, 'settings-tool-config-bash', false);
    assert.equal(harness.featurePatches.length, 2, 'a blocked tool never writes');
    assert.equal(checkedOf(harness, 'settings-tool-config-bash'), 'true');
    assert.notEqual(shownError(harness, 'settings-tool-config-bash'), '', 'a blocked tool says why under its switch');

    await flip(harness, 'contextCompactionToggle', false);
    assert.deepEqual(harness.featurePatches.at(-1), { featureOverrides: { context_compaction: false } });
    assert.equal(checkedOf(harness, 'contextCompactionToggle'), 'false');
    harness.failures.features = new Error('refused');
    await flip(harness, 'contextCompactionToggle', true);
    assert.equal(checkedOf(harness, 'contextCompactionToggle'), 'false');
    assert.equal(shownError(harness, 'contextCompactionToggle'), 'refused');
    assert.equal(harness.errors.length, 0);
  } finally {
    harness.cleanup();
  }
});

test('a manifest tool whose key is not a plain token saves, and a refused save shows on its own row', async () => {
  const harness = createBindingHarness({ toolFields: [{ key: 'future/tool', label: 'Future tool', fieldType: 'toggle', storage: 'config', default: false, toolIds: ['future_tool'] }] });
  try {
    const id = 'settings-tool-config-future%2Ftool';
    harness.failures.features = new Error('disk full');
    await flip(harness, id, true);
    assert.deepEqual(harness.featurePatches, [{ tools: { 'future/tool': true } }]);
    assert.equal(checkedOf(harness, id), 'false', 'the switch rolls back');
    const error = harness.document.querySelector(`[data-inv-toggle="${id}"]`).closest('.settings-field').querySelector('.settings-field-error');
    assert.equal(error.hidden ? '' : error.textContent, 'disk full');
    assert.equal(harness.errors.length, 0, 'and is not toasted as well');
  } finally {
    harness.cleanup();
  }
});

test('clicking a row title toggles its switch and writes once', async () => {
  const harness = createBindingHarness();
  try {
    require('../renderer/inventory/toggle-switch').initToggleHandlers(harness.document);
    const title = harness.document.querySelector('[data-inv-toggle="contextCompactionToggle"]').closest('.settings-field--row').querySelector('.settings-field-title');
    assert.equal(title.tagName, 'LABEL');
    title.click();
    await settle();
    assert.deepEqual(harness.featurePatches, [{ featureOverrides: { context_compaction: false } }]);
    assert.equal(checkedOf(harness, 'contextCompactionToggle'), 'false');
  } finally {
    harness.cleanup();
  }
});

test('context source toggles hand runRuntimePreferenceActivity the merged preferences and roll back', async () => {
  const harness = createBindingHarness();
  try {
    await flip(harness, 'contextIncludeMemoryToggle', false);
    assert.equal(harness.prefRequests.length, 1);
    const request = harness.prefRequests[0];
    assert.deepEqual(request.patch, { contextPreferences: { historyScope: 'session', includePersonality: true, includeMemory: false } });
    assert.deepEqual(request.scopes, ['settings-context-preferences']);
    assert.deepEqual(request.previousValue, { contextPreferences: { historyScope: 'session', includePersonality: true, includeMemory: true } });
    assert.equal(checkedOf(harness, 'contextIncludeMemoryToggle'), 'false');

    harness.failures.prefs = new Error('session busy');
    await flip(harness, 'contextIncludePersonalityToggle', false);
    assert.equal(checkedOf(harness, 'contextIncludePersonalityToggle'), 'true', 'the switch rolls back');
    assert.equal(shownError(harness, 'contextIncludePersonalityToggle'), 'session busy');
    assert.equal(harness.prefs.includePersonality, true);
  } finally {
    harness.cleanup();
  }
});

test('startup model load toggle saves through engines and rolls back an unconfirmed save', async () => {
  const harness = createBindingHarness();
  try {
    await flip(harness, 'modelStartupLoadToggle', false);
    assert.deepEqual(harness.enginePatches, [{ startupModelLoad: false }]);
    assert.equal(harness.state.localEngines.startupModelLoad, false);
    assert.equal(checkedOf(harness, 'modelStartupLoadToggle'), 'false');

    harness.setEngineResult(() => ({ localEngines: { startupModelLoad: false } }));
    await flip(harness, 'modelStartupLoadToggle', true);
    assert.equal(harness.enginePatches.length, 2);
    assert.equal(checkedOf(harness, 'modelStartupLoadToggle'), 'false', 'the switch rolls back');
    assert.match(shownError(harness, 'modelStartupLoadToggle'), /could not be confirmed/);
  } finally {
    harness.cleanup();
  }
});

test('chat UI field copy entries remain searchable and section-owned', () => {
  for (const [id, sectionId] of [['uiLanguageSelect', 'appearance'], ['safetyModeSelect', 'tools'], ['unattendedGuardMinutesInput', 'tools'], ['autoApproveStreakCapInput', 'tools']]) {
    const copy = fieldCopy.getSettingsFieldCopy(id);
    assert.ok(copy);
    assert.ok(copy.description.length >= 10);
    assert.equal(copy.sectionId, sectionId);
  }
});

test('24-hour setting changes formatting only after a confirmed save', async () => {
  const previous = global.jennyI18n;
  global.jennyI18n = i18nUtils.createI18n();
  const harness = createBindingHarness();
  try {
    await flip(harness, 'use24HourTimeToggle', true);
    assert.deepEqual(harness.patches.pop(), { use24HourTime: true });
    assert.equal(harness.state.use24HourTime, true);
    assert.equal(global.jennyI18n.timeOptions().hourCycle, 'h23');
    assert.equal(checkedOf(harness, 'use24HourTimeToggle'), 'true');
    harness.setSnapshot(() => ({ use24HourTime: true }));
    await flip(harness, 'use24HourTimeToggle', false);
    assert.match(shownError(harness, 'use24HourTimeToggle'), /could not be confirmed/);
    assert.equal(harness.errors.length, 0);
    assert.equal(global.jennyI18n.timeOptions().hourCycle, 'h23');
    assert.equal(checkedOf(harness, 'use24HourTimeToggle'), 'true', 'the switch is restored');
    harness.setSnapshot((patch) => patch);
    await flip(harness, 'use24HourTimeToggle', false);
    assert.deepEqual(global.jennyI18n.timeOptions(), {});
    assert.equal(harness.state.use24HourTime, false);
  } finally {
    harness.cleanup();
    global.jennyI18n = previous;
  }
});

test('inactivity pause is explicitly opt-in: Never or a duration', () => {
  for (const [saved, minutes] of [[undefined, '0'], [0, '0'], [45, '45']]) {
    const document = parse(settingRow('unattendedGuardMinutesInput', saved, { numberInput, selectField }));
    assert.equal(document.getElementById('unattendedGuardModeSelect'), null);
    const toggle = document.querySelector('[data-inv-toggle="unattendedGuardToggle"]');
    const duration = document.getElementById('unattendedGuardMinutesInput');
    assert.equal(toggle, null);
    assert.equal(duration.disabled, false);
    assert.equal(duration.value, minutes);
    document.defaultView.close();
  }
});

test('a saved pause length that is not on the list is worded like the listed minutes', () => {
  // Fresh descriptor and binding modules under a translator that words minutes differently from English.
  const paths = ['../renderer/shell/renderer-settings-field-descriptors.js', '../renderer/shell/renderer-settings-field-binding.js'].map((p) => require.resolve(p));
  const cached = paths.map((p) => require.cache[p]);
  const saved = globalThis.jennyI18n;
  paths.forEach((p) => { delete require.cache[p]; });
  globalThis.jennyI18n = { t: (k, d, p) => (k === 'settings.unattendedGuard.choice.minutes' ? `${p.n} Min.` : (p ? String(d).replace(/\{(\w+)\}/g, (m, n) => String(p[n])) : d)) };
  let fresh;
  try {
    fresh = paths.map((p) => require(p));
  } finally {
    globalThis.jennyI18n = saved;
    paths.forEach((p, i) => { require.cache[p] = cached[i]; });
  }
  const [descriptorsModule, binding] = fresh;
  const guard = descriptorsModule.getSettingDescriptor('unattendedGuardMinutesInput');
  const labels = () => [...parse(binding.renderSettingControl(guard, 45, { inventory: { selectField } })).querySelectorAll('option')].map((option) => option.textContent);
  assert.deepEqual(labels().slice(1, 6), ['5 Min.', '10 Min.', '15 Min.', '30 Min.', '45 Min.']);
  // A choice list without its own wording keeps the number and unit.
  const plain = { ...guard, presentation: { ...guard.presentation, choiceLabel: undefined } };
  assert.ok([...parse(binding.renderSettingControl(plain, 45, { inventory: { selectField } })).querySelectorAll('option')].some((option) => option.textContent === '45 min'));
});

test('transcript view default saves through the controller, re-renders on success and rolls back on failure', async () => {
  const previous = globalThis.rendererTranscriptViewController;
  const harness = createBindingHarness();
  try {
    const calls = [];
    let outcome = (value) => Promise.resolve(value);
    globalThis.rendererTranscriptViewController = { setDefault(value) { calls.push(value); return outcome(value); } };

    await pick(harness, 'transcriptViewDefaultSelect', 'everything');
    assert.deepEqual(calls, ['everything']);
    assert.equal(harness.renderSettingsCalls.length, 1, 'success re-renders Settings once');
    assert.equal(harness.errors.length, 0);
    assert.equal(harness.state.transcriptViewDefault, 'everything');
    assert.deepEqual(harness.patches, [], 'the controller owns persistence; the adapter does not patch chatUi itself');

    const failure = new Error('persist refused');
    outcome = () => Promise.reject(failure);
    await pick(harness, 'transcriptViewDefaultSelect', 'answers');
    assert.deepEqual(calls, ['everything', 'answers']);
    assert.equal(shownError(harness, 'transcriptViewDefaultSelect'), 'persist refused', 'the failure shows on the row');
    assert.equal(harness.errors.length, 0);
    assert.equal(harness.renderSettingsCalls.length, 2, 'failure re-renders Settings once');
    assert.equal(segmentedValue(harness.document, 'transcriptViewDefaultSelect'), 'everything', 'the choice snaps back');
    assert.deepEqual(harness.patches, []);
  } finally {
    globalThis.rendererTranscriptViewController = previous;
    harness.cleanup();
  }
});

test('transcript view default without a controller rejects and never bypasses the controller reset', async () => {
  const previous = globalThis.rendererTranscriptViewController;
  const harness = createBindingHarness();
  try {
    globalThis.rendererTranscriptViewController = null;
    await pick(harness, 'transcriptViewDefaultSelect', 'answers');
    assert.deepEqual(harness.patches, [], 'no direct chatUi persist without the controller');
    assert.notEqual(shownError(harness, 'transcriptViewDefaultSelect'), '');
    assert.equal(segmentedValue(harness.document, 'transcriptViewDefaultSelect'), 'thinking');
    assert.equal(harness.state.transcriptViewDefault, 'thinking');
  } finally {
    globalThis.rendererTranscriptViewController = previous;
    harness.cleanup();
  }
});
