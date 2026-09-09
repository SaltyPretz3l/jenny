/* global window */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const selectField = require('../renderer/inventory/select-field.js');
const numberInput = require('../renderer/inventory/number-input.js');
const i18nUtils = require('../renderer/shared/i18n-utils.js');
const support = require('../renderer/shell/renderer-settings-support.js');
const fieldCopy = require('../renderer/shell/renderer-settings-field-copy.js');
const { createSettingsEventBindings } = require('../renderer/shell/renderer-settings-event-utils.js');

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

test('chat UI field builders render inventory controls, current values, titles, and hints', () => {
  const cases = [
    {
      markup: support.buildUiLanguageFieldMarkup({ value: 'ja', selectField }),
      id: 'uiLanguageSelect', value: 'ja', hint: 'Applies after you restart Jenny.',
    },
    {
      markup: support.buildSafetyModeFieldMarkup({ value: 'strict', selectField }),
      id: 'safetyModeSelect', value: 'strict', hint: 'Applies from the next turn.',
    },
    {
      markup: support.buildUnattendedGuardFieldMarkup({ value: 45, numberInput }),
      id: 'unattendedGuardMinutesInput', value: '45', hint: '0 turns the guard off.',
    },
  ];
  for (const entry of cases) {
    const document = parse(entry.markup);
    const control = document.getElementById(entry.id);
    assert.ok(control, `${entry.id}: inventory control rendered`);
    assert.equal(control.value, entry.value);
    assert.ok(control.closest('label')?.getAttribute('title'), `${entry.id}: title rendered`);
    assert.match(document.body.textContent, new RegExp(entry.hint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
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

test('chat UI change resolvers accept only their own controls', () => {
  const document = parse(
    support.buildUiLanguageFieldMarkup({ value: 'ja', selectField })
      + support.buildSafetyModeFieldMarkup({ value: 'paranoid', selectField })
      + support.buildUnattendedGuardFieldMarkup({ value: 45, numberInput })
      + support.buildDefaultRunModeFieldMarkup({ value: 'auto', selectField })
  );
  const language = document.getElementById('uiLanguageSelect');
  const safety = document.getElementById('safetyModeSelect');
  const unattended = document.getElementById('unattendedGuardMinutesInput');
  assert.deepEqual(support.resolveUiLanguageChangeEvent({ target: language }), { value: 'ja' });
  assert.deepEqual(support.resolveSafetyModeChangeEvent({ target: safety }), { value: 'paranoid' });
  assert.deepEqual(support.resolveUnattendedGuardChangeEvent({ target: unattended }), { value: 45 });
  assert.equal(support.resolveUiLanguageChangeEvent({ target: safety }), null);
  assert.equal(support.resolveSafetyModeChangeEvent({ target: unattended }), null);
  assert.equal(support.resolveUnattendedGuardChangeEvent({ target: language }), null);
  document.defaultView.close();
});

function createBindingHarness() {
  const dom = new JSDOM('<!doctype html><body><div id="settingsView">'
    + '<select id="uiLanguageSelect" data-ui-language="true"><option value="ja">ja</option></select>'
    + '<select id="use24HourTimeSelect"><option value="false">Off</option><option value="true">On</option></select>'
    + '<div id="toolsConfigFieldList">'
    + '<select id="safetyModeSelect" data-safety-mode="true"><option value="paranoid">paranoid</option></select>'
    + '<input id="unattendedGuardMinutesInput" data-unattended-guard-minutes="true">'
    + '<select id="defaultRunModeSelect" data-default-run-mode="true"><option value="auto">auto</option></select>'
    + '</div></div></body>', { url: 'http://localhost/' });
  const previous = { window: global.window, document: global.document, AbortController: global.AbortController };
  global.window = dom.window;
  global.document = dom.window.document;
  global.AbortController = dom.window.AbortController;
  const patches = [];
  const errors = [];
  const toasts = [];
  let snapshotForPatch = (patch) => patch;
  window.jennyShell = { chatUi: { async updateSettings(patch) { patches.push(patch); return snapshotForPatch(patch); } } };
  const state = {
    defaultRunMode: 'ask', uiLanguage: 'en', safetyMode: 'normal', unattendedGuardMinutes: 10,
    currentSessionId: '', runtimeDraft: { runMode: 'ask' }, features: { featureFlags: {} }, ui: {},
  };
  const controller = createSettingsEventBindings({
    state,
    constants: { TOAST_SOURCE: { settings: 'settings' }, ACTIVITY_SCOPE: {} },
    dom: {
      settingsView: dom.window.document.getElementById('settingsView'),
      toolsConfigFieldList: dom.window.document.getElementById('toolsConfigFieldList'),
      getSectionDom() { return {}; },
    },
    callbacks: {
      renderSettings() {},
      renderAll() {},
      showSessionActionError(error, title) { errors.push({ error, title }); },
      showToastMessage(message, options) { toasts.push({ message, options }); },
      async refreshFeatureState() {},
      openSettingsSection() {},
      getCurrentRuntimePreferences() { return { contextPreferences: {} }; },
      getRuntimePreferenceSnapshot() { return {}; },
      async runRuntimePreferenceActivity() {},
    },
  });
  controller.bind();
  return {
    window: dom.window, document: dom.window.document, controller, state, patches, errors, toasts,
    setSnapshot(fn) { snapshotForPatch = fn; },
    cleanup() {
      controller.dispose();
      global.window = previous.window;
      global.document = previous.document;
      global.AbortController = previous.AbortController;
      dom.window.close();
    },
  };
}

async function change(harness, id, value) {
  const control = harness.document.getElementById(id);
  control.value = value;
  control.dispatchEvent(new harness.window.Event('change', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('chat UI settings bindings persist normalized values and confirm snapshots', async () => {
  const harness = createBindingHarness();
  try {
    await change(harness, 'safetyModeSelect', 'paranoid');
    assert.deepEqual(harness.patches.pop(), { safetyMode: 'paranoid' });
    assert.equal(harness.state.safetyMode, 'paranoid');

    harness.setSnapshot(() => ({ safetyMode: 'normal' }));
    await change(harness, 'safetyModeSelect', 'paranoid');
    assert.equal(harness.errors.length, 1, 'mismatched snapshot follows the error path');

    harness.setSnapshot((patch) => patch);
    await change(harness, 'unattendedGuardMinutesInput', '45');
    assert.deepEqual(harness.patches.pop(), { unattendedGuardMinutes: 45 });
    assert.equal(harness.state.unattendedGuardMinutes, 45);
    await change(harness, 'unattendedGuardMinutesInput', '999');
    assert.deepEqual(harness.patches.pop(), { unattendedGuardMinutes: 120 });
    assert.equal(harness.state.unattendedGuardMinutes, 120);

    await change(harness, 'uiLanguageSelect', 'ja');
    assert.deepEqual(harness.patches.pop(), { uiLanguage: 'ja' });
    assert.equal(harness.state.uiLanguage, 'ja');
    assert.equal(harness.window.localStorage.getItem('jenny.ui.language'), 'ja');
    assert.equal(harness.toasts.length, 1);

    await change(harness, 'defaultRunModeSelect', 'auto');
    assert.deepEqual(harness.patches.pop(), { defaultRunMode: 'auto' });
    assert.equal(harness.state.defaultRunMode, 'auto');
    assert.equal(harness.state.runtimeDraft.runMode, 'auto');
  } finally {
    harness.cleanup();
  }
});

test('chat UI field copy entries remain searchable and section-owned', () => {
  for (const [id, sectionId] of [['uiLanguageSelect', 'appearance'], ['safetyModeSelect', 'tools'], ['unattendedGuardMinutesInput', 'tools']]) {
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
    await change(harness, 'use24HourTimeSelect', 'true');
    assert.deepEqual(harness.patches.pop(), { use24HourTime: true });
    assert.equal(harness.state.use24HourTime, true);
    assert.equal(global.jennyI18n.timeOptions().hourCycle, 'h23');
    harness.setSnapshot(() => ({ use24HourTime: true }));
    await change(harness, 'use24HourTimeSelect', 'false');
    assert.equal(harness.errors.length, 1);
    assert.equal(global.jennyI18n.timeOptions().hourCycle, 'h23');
    harness.setSnapshot((patch) => patch);
    await change(harness, 'use24HourTimeSelect', 'false');
    assert.deepEqual(global.jennyI18n.timeOptions(), {});
  } finally {
    harness.cleanup();
    global.jennyI18n = previous;
  }
});
