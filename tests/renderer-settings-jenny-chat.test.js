/* global window */
'use strict';

// Row 86 (owner picks S1 + Q1): Settings > App > Jenny chat. The "While you were away" switch is the
// primary_digests feature flag (default off); the Quiet hours row holds the chatUi digestQuietStart /
// digestQuietEnd selects (48 half-hour steps) in its own group, editable while the switch is off (row 89
// pick Q1: quiet hours also silence the Jenny chat's desktop notifications). Rendered by the real
// renderer helper and bound by the real event bindings behind bridge fakes. Row 133: the switch is the
// "While you are away" group of Settings > Chat (#jennyChatSettingsSection wrapper) and the Quiet hours
// row is the last group of the Notifications card, which binds it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const fieldCopy = require('../renderer/shell/renderer-settings-field-copy.js');
const fieldDescriptors = require('../renderer/shell/renderer-settings-field-descriptors.js');
const { renderJennyChatDigests } = require('../renderer/shell/renderer-settings-utils.js');
const { createSettingsEventBindings } = require('../renderer/shell/renderer-settings-event-utils.js');

const HALF_HOURS = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('the Jenny chat descriptors: a default-off flag switch and two half-hour chatUi selects', () => {
  const toggle = fieldDescriptors.getSettingDescriptor('primaryDigestsToggle');
  assert.deepEqual([toggle.sectionId, toggle.kind, toggle.control, toggle.adapterId, toggle.key, toggle.default],
    ['jennyChat', 'boolean', 'toggle', 'features', 'featureFlags.primary_digests', false]);
  for (const [id, key, dflt] of [['digestQuietStartSelect', 'digestQuietStart', '22:00'], ['digestQuietEndSelect', 'digestQuietEnd', '07:00']]) {
    const descriptor = fieldDescriptors.getSettingDescriptor(id);
    assert.deepEqual([descriptor.sectionId, descriptor.kind, descriptor.control, descriptor.adapterId, descriptor.key, descriptor.default],
      ['notifications', 'enum', 'select', 'chatUi', key, dflt], id);
    assert.deepEqual(descriptor.options.map((option) => option.value), HALF_HOURS, id);
    assert.equal(fieldDescriptors.normalizeSettingValue(descriptor, '23:30'), '23:30');
    assert.equal(fieldDescriptors.normalizeSettingValue(descriptor, '23:45'), dflt);
    assert.equal(fieldDescriptors.validateSettingValue(descriptor, '07:15').ok, false);
  }
  assert.deepEqual(fieldDescriptors.listSettingDescriptors({ sectionId: 'jennyChat' }).map((d) => d.id), ['primaryDigestsToggle']);
  for (const id of ['digestQuietStartSelect', 'digestQuietEndSelect']) {
    assert.ok(fieldDescriptors.listSettingDescriptors({ sectionId: 'notifications' }).some((d) => d.id === id), id);
  }
});

test('the Jenny chat rows carry copy in their section, and search finds them by their words', () => {
  const toggle = fieldCopy.getSettingsFieldCopy('primaryDigestsToggle');
  assert.equal(toggle.label, 'While you were away');
  assert.match(toggle.description, /^When you come back after 4 hours or more, Jenny posts one short summary/);
  assert.equal(fieldCopy.getSettingsFieldCopy('digestQuietStartSelect').label, 'Quiet hours start');
  assert.equal(fieldCopy.getSettingsFieldCopy('digestQuietEndSelect').label, 'Quiet hours end');
  const all = fieldCopy.listSettingsSearchEntries();
  const entries = all.filter((entry) => entry.sectionId === 'jennyChat');
  assert.deepEqual(entries.map((entry) => entry.id), ['primaryDigestsToggle']);
  const quiet = all.filter((entry) => entry.id === 'digestQuietStartSelect' || entry.id === 'digestQuietEndSelect');
  assert.deepEqual(quiet.map((entry) => entry.sectionId), ['notifications', 'notifications']);
  const hit = (list, word) => list.some((entry) => entry.keywords.includes(word) || entry.label.toLowerCase().includes(word));
  for (const word of ['digest', 'away', 'summary']) assert.ok(hit(entries, word), word);
  assert.ok(hit(quiet, 'quiet hours'));
});

function createHarness({ digests = false, quiet = {} } = {}) {
  // The row 133 markup: the digests wrapper in the Chat card, Quiet hours in the Notifications card.
  const dom = new JSDOM('<!doctype html><body><div id="settingsView">'
    + '<section class="settings-card" data-settings-section="chat"><div class="settings-flow" id="jennyChatSettingsSection">'
    + '<div class="settings-toggle-list" id="jennyChatDigestsList"></div></div></section>'
    + '<section class="settings-card" data-settings-section="notifications" id="notificationsSettingsSection">'
    + '<div class="settings-toggle-list" id="jennyChatQuietList"></div></section>'
    + '</div></body>', { url: 'http://localhost/' });
  const previous = { window: global.window, document: global.document, AbortController: global.AbortController };
  global.window = dom.window;
  global.document = dom.window.document;
  global.AbortController = dom.window.AbortController;
  const patches = [];
  const featurePatches = [];
  const errors = [];
  window.jennyShell = { chatUi: { async updateSettings(patch) { patches.push(patch); return patch; } } };
  const state = {
    defaultRunMode: 'ask', uiLanguage: 'en', safetyMode: 'normal', unattendedGuardMinutes: 0, autoApproveStreakCap: 50,
    use24HourTime: false, transcriptViewDefault: 'thinking', digestQuietStart: '22:00', digestQuietEnd: '07:00', ...quiet,
    currentSessionId: '', runtimeDraft: { runMode: 'ask' },
    features: { tools: {}, featureFlags: { primary_digests: digests }, featureOverrides: {}, availability: { tools: {} } },
    localEngines: {}, ui: {},
  };
  const list = dom.window.document.getElementById('jennyChatDigestsList');
  const quietList = dom.window.document.getElementById('jennyChatQuietList');
  const render = () => renderJennyChatDigests(list, state, quietList);
  render();
  const controller = createSettingsEventBindings({
    state,
    constants: { TOAST_SOURCE: { settings: 'settings' }, ACTIVITY_SCOPE: { settingsContextPreferences: 'settings-context-preferences' } },
    dom: {
      settingsView: dom.window.document.getElementById('settingsView'),
      notificationsSettingsSection: dom.window.document.getElementById('notificationsSettingsSection'),
      getSectionDom() { return {}; },
    },
    callbacks: {
      renderSettings: render,
      renderAll() {},
      showSessionActionError(error, title) { errors.push({ error, title }); },
      showToastMessage() {},
      async refreshFeatureState(patch) {
        featurePatches.push(patch);
        Object.assign(state.features.featureOverrides, patch.featureOverrides);
        Object.assign(state.features.featureFlags, patch.featureOverrides);
        return state.features;
      },
      openSettingsSection() {},
      getCurrentRuntimePreferences() { return { contextPreferences: {} }; },
      getRuntimePreferenceSnapshot() { return { contextPreferences: {} }; },
      async runRuntimePreferenceActivity() {},
    },
  });
  controller.bind();
  const byId = (id) => dom.window.document.getElementById(id);
  return {
    window: dom.window, document: dom.window.document, state, list, quietList, render, byId, patches, featurePatches, errors,
    row: () => dom.window.document.querySelector('[data-settings-field="digestQuietHoursRow"]'),
    cleanup() {
      controller.dispose();
      global.window = previous.window;
      global.document = previous.document;
      global.AbortController = previous.AbortController;
      dom.window.close();
    },
  };
}

test('the Digests group renders the switch; the Quiet hours group one row: From select, "to", To select', (t) => {
  const h = createHarness({ quiet: { digestQuietStart: '23:30', digestQuietEnd: 'bogus' } });
  t.after(() => h.cleanup());
  const rows = h.list.querySelectorAll('.settings-field');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].querySelector('.settings-field-title').textContent, 'While you were away');
  assert.equal(h.document.querySelector('[data-inv-toggle="primaryDigestsToggle"]').getAttribute('aria-checked'), 'false');
  const row = h.row();
  assert.ok(h.quietList.contains(row));
  assert.equal(row.querySelector('.settings-field-title').textContent, 'Quiet hours');
  assert.equal(row.querySelector('.settings-field-help').textContent, 'Between these times the Jenny chat sends no desktop notifications and no digest. Anything that needs you waits in Needs you.');
  const start = h.byId('digestQuietStartSelect');
  const end = h.byId('digestQuietEndSelect');
  assert.deepEqual(Array.from(start.options, (option) => option.value), HALF_HOURS);
  assert.equal(start.value, '23:30');
  assert.equal(end.value, '07:00', 'a stored value off the list shows the default');
  assert.equal(start.getAttribute('aria-label'), 'Quiet hours start');
  assert.equal(end.getAttribute('aria-label'), 'Quiet hours end');
  assert.equal(start.getAttribute('aria-describedby'), 'digestQuietHoursHelp');
  const line = row.querySelector('.settings-field-control > .settings-field-stack-line');
  const to = line.querySelector('.settings-field-side');
  assert.equal(to.textContent, 'to');
  assert.ok(line.contains(start) && line.contains(end));
  const FOLLOWING = h.window.Node.DOCUMENT_POSITION_FOLLOWING;
  assert.ok(start.compareDocumentPosition(to) & FOLLOWING, 'From comes first');
  assert.ok(to.compareDocumentPosition(end) & FOLLOWING, 'then "to", then To');
});

test('the quiet-hours selects stay editable whether digests are on or off (row 89 Q1)', async (t) => {
  const h = createHarness();
  t.after(() => h.cleanup());
  const start = h.byId('digestQuietStartSelect');
  assert.equal(start.disabled, false);
  assert.equal(h.byId('digestQuietEndSelect').disabled, false);
  assert.equal(h.row().hasAttribute('data-setting-parent-off'), false);

  const track = h.document.querySelector('[data-inv-toggle="primaryDigestsToggle"]');
  track.dispatchEvent(new h.window.CustomEvent('inv-toggle-change', { bubbles: true, detail: { id: 'primaryDigestsToggle', checked: true } }));
  await settle();
  assert.deepEqual(h.featurePatches, [{ featureOverrides: { primary_digests: true } }]);
  assert.equal(h.byId('digestQuietStartSelect'), start, 'patched in place, not rebuilt');
  assert.equal(start.disabled, false);
  assert.equal(h.byId('digestQuietEndSelect').disabled, false);
  assert.equal(h.row().hasAttribute('data-setting-parent-off'), false);
  assert.equal(h.document.querySelector('[data-inv-toggle="primaryDigestsToggle"]').getAttribute('aria-checked'), 'true');

  h.state.features.featureFlags.primary_digests = false;
  h.render();
  assert.equal(h.byId('digestQuietStartSelect'), start, 'patched in place, not rebuilt');
  assert.equal(start.disabled, false);
  assert.equal(h.row().hasAttribute('data-setting-parent-off'), false);
});

test('without a separate quiet list both rows render into the digests list (legacy markup)', () => {
  const h = createHarness();
  try {
    const list = h.document.createElement('div');
    renderJennyChatDigests(list, h.state);
    assert.equal(list.querySelectorAll('.settings-field').length, 2);
  } finally {
    h.cleanup();
  }
});

test('choosing a quiet-hours time on the Notifications card writes that chatUi scalar and nothing else', async (t) => {
  const h = createHarness({ digests: true });
  t.after(() => h.cleanup());
  const start = h.byId('digestQuietStartSelect');
  assert.equal(start.closest('.settings-card').id, 'notificationsSettingsSection');
  assert.equal(h.byId('jennyChatSettingsSection').contains(start), false, 'the digests wrapper does not hold it');
  start.value = '21:30';
  start.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  await settle();
  assert.deepEqual(h.patches, [{ digestQuietStart: '21:30' }]);
  assert.equal(h.state.digestQuietStart, '21:30');
  const end = h.byId('digestQuietEndSelect');
  end.value = '06:00';
  end.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  await settle();
  assert.deepEqual(h.patches.pop(), { digestQuietEnd: '06:00' });
  assert.equal(h.state.digestQuietEnd, '06:00');
  assert.equal(h.byId('digestQuietEndSelect').value, '06:00');
  assert.deepEqual(h.errors, []);
});

// Row 144: the "Jenny chat" group's two model rows (Jenny's model, Scheduled checks run on).
const { renderJennyChatModels } = require('../renderer/shell/renderer-settings-lazy-renderers.js');

const MODEL_LIST = [
  { id: 'qwen3:27b', engine_type: 'ollama', parameterSize: '27.8B' },
  { id: 'qwen3:8b', engine_type: 'ollama', parameter_size: '8.2B' },
  { id: 'lfm3:2b', engine_type: 'ollama', parameterSize: '2.6B' },
  { id: 'gemma4-e4b', engine_type: 'ollama' },
  { id: 'gpt-6', engine_type: 'chatgpt' },
];

function modelsHarness({ snapshot = {}, models = MODEL_LIST, status = {}, sessions = [] } = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="jennyChatModelList"></div></body>', { url: 'http://localhost/' });
  const snap = { status: 'ready', session_id: 'p', model: '', check_model: '', ...snapshot };
  let listener = null;
  const calls = [];
  const store = {
    answer: { ok: true },
    getSnapshot: () => ({ ...snap }),
    subscribe: (fn) => { listener = fn; return () => { listener = null; }; },
    async setModels(patch) { calls.push(patch); return store.answer; },
  };
  const state = { modelList: { data: models, active_model: 'lfm3:2b' }, status: { model: 'lfm3:2b' }, sessions, ...status };
  const list = dom.window.document.getElementById('jennyChatModelList');
  const previous = { window: global.window, document: global.document };
  global.window = dom.window;
  global.document = dom.window.document;
  const render = () => renderJennyChatModels(list, state, { store });
  render();
  const q = (selector) => list.querySelector(selector);
  return {
    dom, list, snap, state, store, calls, render, q,
    emit: () => listener && listener(),
    jenny: () => q('#primaryModelSelect'),
    check: () => q('#checkModelSelect'),
    line: (id) => q(`[data-settings-field="${id}"] .settings-field-effective`),
    async change(select, value) {
      select.value = value;
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      await settle();
    },
    cleanup() {
      global.window = previous.window;
      global.document = previous.document;
      dom.window.close();
    },
  };
}
const optionValues = (select) => Array.from(select.options, (option) => option.value);
const optionLabel = (select, value) => Array.from(select.options).find((option) => option.value === value);

test('row 144: both model rows render with their first options and help', (t) => {
  const h = modelsHarness();
  t.after(() => h.cleanup());
  assert.deepEqual(Array.from(h.list.querySelectorAll('.settings-field--row .settings-field-title'), (el) => el.textContent),
    ["Jenny's model", 'Scheduled checks run on']);
  assert.equal(h.jenny().options[0].textContent, "Follow the chat's picker");
  assert.equal(h.check().options[0].textContent, "Same as Jenny's model");
  assert.equal(h.jenny().options[0].value, '');
  assert.deepEqual(optionValues(h.jenny()), ['', 'qwen3:27b', 'qwen3:8b', 'lfm3:2b', 'gemma4-e4b', 'gpt-6']);
  assert.match(h.q('#primaryModelHelp').textContent, /always uses, whatever you load in other chats or the Model Library/);
  assert.match(h.q('#checkModelHelp').textContent, /Models under 7B can't run checks/);
  assert.equal(h.jenny().getAttribute('aria-describedby'), 'primaryModelHelp');
});

test('row 144: the check row disables models under 7B and of unknown size; cloud stays enabled; Jenny\'s row disables none', (t) => {
  const h = modelsHarness();
  t.after(() => h.cleanup());
  const disabled = (select) => Array.from(select.options).filter((option) => option.disabled).map((option) => option.value);
  assert.deepEqual(disabled(h.check()), ['lfm3:2b', 'gemma4-e4b']);
  assert.deepEqual(disabled(h.jenny()), []);
  assert.equal(optionLabel(h.check(), 'lfm3:2b').textContent, 'lfm3:2b · under 7B, too small for checks');
  assert.equal(optionLabel(h.check(), 'gpt-6').disabled, false);
  assert.equal(optionLabel(h.check(), 'qwen3:8b').textContent, 'qwen3:8b');
});

test('row 144: the effective lines name what runs; an unpinned Jenny shows the Library default', (t) => {
  const h = modelsHarness();
  t.after(() => h.cleanup());
  assert.equal(h.line('primaryModelRow').textContent, 'Now: lfm3:2b, from the Model Library default.');
  assert.equal(h.line('primaryModelRow').querySelector('strong').textContent, 'lfm3:2b');
  const pinned = modelsHarness({ snapshot: { model: 'qwen3:27b' } });
  t.after(() => pinned.cleanup());
  assert.equal(pinned.line('primaryModelRow').textContent,
    'Every Jenny chat turn runs on qwen3:27b. The picker in the Jenny chat is locked while this is set.');
  assert.equal(pinned.line('checkModelRow').textContent, 'Checks run on qwen3:27b.');
  assert.equal(pinned.line('checkModelRow').classList.contains('settings-field-effective--warn'), false);
  const separate = modelsHarness({ snapshot: { model: 'gpt-6', check_model: 'qwen3:8b' } });
  t.after(() => separate.cleanup());
  assert.equal(separate.line('checkModelRow').textContent, 'Checks run on qwen3:8b.');
});

test('row 144: the check line turns amber when the model checks would use is under 7B', (t) => {
  const small = modelsHarness({ snapshot: { model: 'lfm3:2b' } });
  t.after(() => small.cleanup());
  const line = small.line('checkModelRow');
  assert.equal(line.textContent, 'Checks will wait: lfm3:2b is under 7B. Pick a bigger model here or above.');
  assert.ok(line.classList.contains('settings-field-effective--warn'));
  assert.equal(line.querySelector('strong').textContent, 'lfm3:2b is under 7B');
  // Nothing pinned: the Library default (lfm3:2b here) is what checks would run on.
  const unpinned = modelsHarness();
  t.after(() => unpinned.cleanup());
  assert.ok(unpinned.line('checkModelRow').classList.contains('settings-field-effective--warn'));
  // The Jenny chat's own saved model counts before the Library default, as on the backend.
  const saved = modelsHarness({ sessions: [{ id: 'p', preferred_model: 'qwen3:27b' }] });
  t.after(() => saved.cleanup());
  assert.equal(saved.line('checkModelRow').textContent, 'Checks run on qwen3:27b.');
  const cloud = modelsHarness({ snapshot: { check_model: 'gpt-6' } });
  t.after(() => cloud.cleanup());
  assert.equal(cloud.line('checkModelRow').classList.contains('settings-field-effective--warn'), false);
});

test('row 144: choosing a model writes only that key through the store', async (t) => {
  const h = modelsHarness();
  t.after(() => h.cleanup());
  await h.change(h.check(), 'qwen3:8b');
  assert.deepEqual(h.calls, [{ check_model: 'qwen3:8b' }]);
  await h.change(h.jenny(), 'qwen3:27b');
  assert.deepEqual(h.calls, [{ check_model: 'qwen3:8b' }, { model: 'qwen3:27b' }]);
  await h.change(h.check(), '');
  assert.deepEqual(h.calls.at(-1), { check_model: '' }, 'the first option clears the key');
  assert.equal(h.q('.settings-field-error[hidden]') !== null, true);
});

test('row 144: a refused write restores the previous value and shows the row error, never the reason token', async (t) => {
  const h = modelsHarness({ snapshot: { check_model: 'qwen3:8b' } });
  t.after(() => h.cleanup());
  h.store.answer = { ok: false, reason: 'invalid_request' };
  await h.change(h.check(), 'qwen3:27b');
  assert.equal(h.check().value, 'qwen3:8b');
  const row = h.q('[data-settings-field="checkModelRow"]');
  const error = row.querySelector('.settings-field-error');
  assert.equal(error.hidden, false);
  assert.equal(error.textContent, 'Could not save this choice. Try again.');
  assert.doesNotMatch(error.textContent, /invalid_request/);
  assert.equal(h.q('[data-settings-field="primaryModelRow"] .settings-field-error').hidden, true);
  h.store.answer = { ok: true };
  await h.change(h.check(), 'qwen3:27b');
  assert.equal(row.querySelector('.settings-field-error').hidden, true, 'a good write clears it');
});

test('row 144: the rows repaint in place when the store changes, keeping their nodes', (t) => {
  const h = modelsHarness();
  t.after(() => h.cleanup());
  const jenny = h.jenny();
  h.snap.model = 'qwen3:27b';
  h.emit();
  assert.equal(h.jenny(), jenny);
  assert.equal(jenny.value, 'qwen3:27b');
  assert.match(h.line('primaryModelRow').textContent, /^Every Jenny chat turn runs on qwen3:27b/);
  assert.equal(h.list.querySelectorAll('.settings-field--row').length, 2);
});

test('row 144: a saved model missing from the list is kept as an option so the row never shows the wrong value', (t) => {
  const h = modelsHarness({ snapshot: { model: 'old:70b', check_model: 'old:70b' } });
  t.after(() => h.cleanup());
  assert.equal(h.jenny().value, 'old:70b');
  assert.equal(h.check().value, 'old:70b');
  assert.equal(optionLabel(h.check(), 'old:70b').disabled, false);
});

test('row 144: with the Jenny chat unavailable the rows stay, greyed out, with a reason', (t) => {
  const h = modelsHarness({ snapshot: { status: 'unavailable' } });
  t.after(() => h.cleanup());
  assert.equal(h.jenny().disabled, true);
  assert.equal(h.check().disabled, true);
  const row = h.q('[data-settings-field="primaryModelRow"]');
  assert.ok(row.classList.contains('settings-field--unavailable'));
  assert.match(row.textContent, /Available when the Jenny chat is on/);
});

test('row 144: with no store at all the rows still render, greyed out', (t) => {
  const dom = new JSDOM('<!doctype html><body><div id="l"></div></body>', { url: 'http://localhost/' });
  t.after(() => dom.window.close());
  const list = dom.window.document.getElementById('l');
  assert.doesNotThrow(() => renderJennyChatModels(list, { modelList: { data: [] } }, { store: null }));
  assert.equal(list.querySelector('#primaryModelSelect').disabled, true);
});
