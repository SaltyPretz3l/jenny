/* global window */
'use strict';

// Row 86 (owner picks S1 + Q1): Settings > App > Jenny chat. The "While you were away" switch is the
// primary_digests feature flag (default off); the Quiet hours row holds the chatUi digestQuietStart /
// digestQuietEnd selects (48 half-hour steps) in its own group, editable while the switch is off (row 89
// pick Q1: quiet hours also silence the Jenny chat's desktop notifications). Rendered by the real
// renderer helper and bound by the real event bindings behind bridge fakes.

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
      ['jennyChat', 'enum', 'select', 'chatUi', key, dflt], id);
    assert.deepEqual(descriptor.options.map((option) => option.value), HALF_HOURS, id);
    assert.equal(fieldDescriptors.normalizeSettingValue(descriptor, '23:30'), '23:30');
    assert.equal(fieldDescriptors.normalizeSettingValue(descriptor, '23:45'), dflt);
    assert.equal(fieldDescriptors.validateSettingValue(descriptor, '07:15').ok, false);
  }
  assert.deepEqual(fieldDescriptors.listSettingDescriptors({ sectionId: 'jennyChat' }).map((d) => d.id),
    ['primaryDigestsToggle', 'digestQuietStartSelect', 'digestQuietEndSelect']);
});

test('the Jenny chat rows carry copy in their section, and search finds them by their words', () => {
  const toggle = fieldCopy.getSettingsFieldCopy('primaryDigestsToggle');
  assert.equal(toggle.label, 'While you were away');
  assert.match(toggle.description, /^When you come back after 4 hours or more, Jenny posts one short summary/);
  assert.equal(fieldCopy.getSettingsFieldCopy('digestQuietStartSelect').label, 'Quiet hours start');
  assert.equal(fieldCopy.getSettingsFieldCopy('digestQuietEndSelect').label, 'Quiet hours end');
  const entries = fieldCopy.listSettingsSearchEntries().filter((entry) => entry.sectionId === 'jennyChat');
  assert.deepEqual(entries.map((entry) => entry.id).sort(), ['digestQuietEndSelect', 'digestQuietStartSelect', 'primaryDigestsToggle']);
  const hit = (word) => entries.some((entry) => entry.keywords.includes(word) || entry.label.toLowerCase().includes(word));
  for (const word of ['digest', 'quiet hours', 'away', 'summary']) assert.ok(hit(word), word);
});

function createHarness({ digests = false, quiet = {} } = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="settingsView">'
    + '<section id="jennyChatSettingsSection"><div class="settings-toggle-list" id="jennyChatDigestsList"></div>'
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
    dom: { settingsView: dom.window.document.getElementById('settingsView'), getSectionDom() { return {}; } },
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

test('choosing a quiet-hours time writes that chatUi scalar and nothing else', async (t) => {
  const h = createHarness({ digests: true });
  t.after(() => h.cleanup());
  const start = h.byId('digestQuietStartSelect');
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
