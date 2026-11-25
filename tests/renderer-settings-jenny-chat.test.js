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

// Row 194 (C6): Chat keeps one read-only row that points at Settings > Models > Model roles.
const { renderJennyChatModels } = require('../renderer/shell/renderer-settings-lazy-renderers.js');

const MODEL_LIST = [
  { id: 'qwen3:27b', engine_type: 'ollama', parameterSize: '27.8B' },
  { id: 'lfm3:2b', engine_type: 'ollama', parameterSize: '2.6B' },
  { id: 'gpt-6', engine_type: 'chatgpt' },
];

function modelsHarness({ snapshot = {}, models = MODEL_LIST, sessions = [] } = {}) {
  const dom = new JSDOM('<!doctype html><body><button id="settingsNav-models"></button><h4 id="modelRolesHeading" tabindex="-1"></h4>'
    + '<div id="jennyChatModelList"></div></body>', { url: 'http://localhost/' });
  const snap = { status: 'ready', session_id: 'p', model: '', check_model: '', ...snapshot };
  let listener = null;
  const store = { getSnapshot: () => ({ ...snap }), subscribe: (fn) => { listener = fn; return () => { listener = null; }; } };
  const state = { modelList: { data: models, active_model: 'lfm3:2b' }, status: { model: 'lfm3:2b' }, sessions };
  const list = dom.window.document.getElementById('jennyChatModelList');
  const previous = { window: global.window, document: global.document };
  global.window = dom.window;
  global.document = dom.window.document;
  const render = () => renderJennyChatModels(list, state, { store });
  render();
  return {
    dom, list, snap, state, render,
    text: () => list.querySelector('.settings-field-help').textContent,
    emit: () => listener && listener(),
    cleanup() {
      global.window = previous.window;
      global.document = previous.document;
      dom.window.close();
    },
  };
}

test('row 194: Chat holds one read-only row, with no model select, that follows the picker', (t) => {
  const h = modelsHarness();
  t.after(() => h.cleanup());
  assert.equal(h.list.querySelectorAll('.settings-field').length, 1);
  assert.equal(h.list.querySelectorAll('select').length, 0);
  const row = h.list.querySelector('.roles-pointer');
  assert.equal(row.querySelector('.settings-field-title').textContent, "Jenny's model");
  assert.equal(h.text(), "Follows the chat's picker, now lfm3:2b. Scheduled checks run on lfm3:2b.");
  assert.equal(row.querySelector('[data-open-model-roles]').textContent, 'Change in Models');
});

test('row 194: a pinned model and a separate checks model are named in the line', (t) => {
  const pinned = modelsHarness({ snapshot: { model: 'qwen3:27b' } });
  t.after(() => pinned.cleanup());
  assert.equal(pinned.text(), 'qwen3:27b. Scheduled checks run on qwen3:27b.');
  const separate = modelsHarness({ snapshot: { model: 'gpt-6', check_model: 'qwen3:27b' } });
  t.after(() => separate.cleanup());
  assert.equal(separate.text(), 'gpt-6. Scheduled checks run on qwen3:27b.');
  const own = modelsHarness({ sessions: [{ id: 'p', preferred_model: 'qwen3:27b' }] });
  t.after(() => own.cleanup());
  assert.equal(own.text(), "Follows the chat's picker, now qwen3:27b. Scheduled checks run on qwen3:27b.");
});

test('row 194: the line repaints in place when the store changes', (t) => {
  const h = modelsHarness();
  t.after(() => h.cleanup());
  const row = h.list.querySelector('.roles-pointer');
  h.snap.model = 'qwen3:27b';
  h.emit();
  assert.match(h.text(), /^qwen3:27b\. /);
  h.emit();
  assert.equal(h.list.querySelectorAll('.roles-pointer').length, 1);
  assert.notEqual(h.list.querySelector('.roles-pointer'), row, 'a changed line is redrawn');
});

test('row 194: with the Jenny chat unavailable the row says why', (t) => {
  const h = modelsHarness({ snapshot: { status: 'unavailable' } });
  t.after(() => h.cleanup());
  assert.equal(h.text(), 'Available when the Jenny chat is on.');
});

test('row 194: Change in Models opens Settings > Models and moves focus to the Model roles heading', async (t) => {
  const h = modelsHarness();
  t.after(() => h.cleanup());
  const nav = h.dom.window.document.getElementById('settingsNav-models');
  let opened = 0;
  nav.addEventListener('click', () => { opened += 1; });
  h.dom.window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
  h.list.querySelector('[data-open-model-roles]').click();
  await settle();
  assert.equal(opened, 1);
  assert.equal(h.dom.window.document.activeElement.id, 'modelRolesHeading');
});

test('row 194: on the first visit the link waits for the Model roles block to mount, then focuses its heading', async (t) => {
  // Live-app check 2026-11-23: the block mounts after its module loads, so the heading is not there at once.
  const h = modelsHarness();
  t.after(() => h.cleanup());
  const doc = h.dom.window.document;
  doc.getElementById('modelRolesHeading').remove();
  h.dom.window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
  h.list.querySelector('[data-open-model-roles]').click();
  await new Promise((resolve) => setTimeout(resolve, 120));
  doc.body.insertAdjacentHTML('beforeend', '<h4 id="modelRolesHeading" tabindex="-1">Model roles</h4>');
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(doc.activeElement.id, 'modelRolesHeading');
});

test('row 194: with no store at all the row still renders', (t) => {
  const dom = new JSDOM('<!doctype html><body><div id="l"></div></body>', { url: 'http://localhost/' });
  t.after(() => dom.window.close());
  const list = dom.window.document.getElementById('l');
  assert.doesNotThrow(() => renderJennyChatModels(list, { modelList: { data: [] } }, { store: null }));
  assert.equal(list.querySelectorAll('select').length, 0);
  assert.equal(list.querySelectorAll('.roles-pointer').length, 1);
});
