'use strict';

// new-test-file: renderer-quick-settings-modal.test.js is over 600 lines

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const { createQuickSettingsModal } = require('../renderer/shell/renderer-quick-settings-modal.js');
const toggleSwitchModule = require('../renderer/inventory/toggle-switch.js');
const segmentedControlRaw = require('../renderer/inventory/segmented-control.js');
const actionButtonRaw = require('../renderer/inventory/action-button.js');
const appearanceUtils = require('../renderer/shared/appearance-utils.js');
const statusChipUtils = require('../renderer/shell/renderer-status-chip-utils.js');

const toggleSwitchFn = toggleSwitchModule.toggleSwitch;
toggleSwitchFn.setChecked = toggleSwitchModule.setChecked;
toggleSwitchFn.toggle = toggleSwitchModule.toggle;
toggleSwitchFn.initToggleHandlers = toggleSwitchModule.initToggleHandlers;

const inventory = {
  toggleSwitch: toggleSwitchFn,
  segmentedControl: segmentedControlRaw,
  actionButton: actionButtonRaw,
};

function buildDom() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  const documentRef = dom.window.document;
  // Production installs the delegated handlers once on `document`; the modal never installs its own.
  toggleSwitchModule.initToggleHandlers(documentRef);
  segmentedControlRaw.initSegmentedHandlers(documentRef);
  return documentRef;
}

function makeFakeAdapter(initialValue) {
  const writeCalls = [];
  let current = initialValue;
  return {
    read: () => current,
    write: (value) => {
      writeCalls.push(value);
      current = value;
      return Promise.resolve(value);
    },
    _writeCalls: writeCalls,
  };
}

function buildHarness(options) {
  const opts = options || {};
  const documentRef = buildDom();
  const appearance = makeFakeAdapter({ paletteId: 'midnight', fontScaleId: 'default' });
  const offline = makeFakeAdapter({ mode: 'disabled', preferredLocalModel: '' });
  const sessionOpen = makeFakeAdapter(false);
  const openSettingsSectionCalls = [];
  const openModelTuningCalls = [];
  const state = Object.assign({
    modelList: { data: [{ id: 'modelA', available: true }] },
    offline: { resolved: false, mode: 'disabled', localChatReady: false, summary: '', unavailableReason: '' },
    ui: { activeSettingsSection: 'models' },
  }, opts.state || {});
  const deps = Object.assign({
    documentRef,
    windowRef: documentRef.defaultView,
    overlayManager: { open: () => true, close: () => true },
    state,
    adapters: { appearance, offline, sessionOpen },
    runtimePrefs: { getCurrent: () => (opts.prefs || { preferredModel: 'modelA' }) },
    openSettingsSection: (...args) => openSettingsSectionCalls.push(args),
    openModelTuning: (...args) => openModelTuningCalls.push(args),
    appendClientLog: () => {},
    inventory,
    appearanceUtils,
    statusChipUtils,
  }, opts.deps || {});
  return { documentRef, deps, state, appearance, offline, sessionOpen, openSettingsSectionCalls, openModelTuningCalls };
}

function click(documentRef, el) {
  el.dispatchEvent(new documentRef.defaultView.MouseEvent('click', { bubbles: true }));
}

function text(el) { return String(el && el.textContent || '').replace(/\s+/g, ' ').trim(); }

// ── Theme swatches ──────────────────────────────────────────────────────

test('Theme row: one swatch per palette, dark before light, one group start, value label follows the selection', () => {
  const h = buildHarness();
  const controller = createQuickSettingsModal(h.deps);
  controller.open();
  const slot = h.documentRef.querySelector('[data-slot="appearance"]');
  assert.equal(text(slot.querySelector('.quick-settings-slot-title')), 'Appearance');
  const group = slot.querySelector('[data-inv-segmented="quickSettingsPalette"]');
  assert.ok(group.classList.contains('inv-segmented--swatch'));
  const radios = [...group.querySelectorAll('[role="radio"]')];
  const presets = appearanceUtils.getPalettePresets();
  assert.equal(radios.length, presets.length);
  const schemes = radios.map((r) => presets.find((p) => p.id === r.getAttribute('data-value')).scheme);
  const firstLight = schemes.indexOf('light');
  assert.ok(firstLight > 0);
  assert.ok(schemes.slice(0, firstLight).every((s) => s === 'dark'));
  assert.ok(schemes.slice(firstLight).every((s) => s === 'light'));
  assert.deepEqual(radios.map((r) => r.hasAttribute('data-group-start')), radios.map((_, i) => i === firstLight));
  assert.ok(radios.every((r) => r.querySelector('.inv-segmented-swatch')));
  assert.equal(text(slot.querySelector('.quick-settings-row-value')), 'Midnight');
  assert.equal(slot.querySelector('select'), null);

  click(h.documentRef, group.querySelector('[data-value="obsidian"]'));
  assert.equal(h.appearance._writeCalls.length, 1);
  assert.equal(h.appearance._writeCalls[0].paletteId, 'obsidian');
  assert.equal(h.appearance._writeCalls[0].fontScaleId, 'default');
  assert.equal(text(slot.querySelector('.quick-settings-row-value')), 'Obsidian');
});

test('Text size and Wide transcript rows live in the Appearance group', () => {
  const h = buildHarness();
  createQuickSettingsModal(h.deps).open();
  const slot = h.documentRef.querySelector('[data-slot="appearance"]');
  assert.ok(slot.querySelector('[data-inv-segmented="quickSettingsFontScale"]'));
  assert.ok(slot.querySelector('[data-inv-toggle="quickSettingsWideTranscript"]'));
  assert.deepEqual(
    [...h.documentRef.querySelectorAll('.quick-settings-slot')].map((s) => s.dataset.slot),
    ['appearance', 'model', 'chats'],
  );
});

// ── Wide transcript ─────────────────────────────────────────────────────

test('Wide transcript reflects chatWidth.read() and one click toggles once', () => {
  let wide = false;
  const calls = [];
  const h = buildHarness({ deps: { chatWidth: { read: () => wide, toggle: () => { calls.push('toggle'); wide = !wide; } } } });
  createQuickSettingsModal(h.deps).open();
  const track = () => h.documentRef.querySelector('[data-inv-toggle="quickSettingsWideTranscript"]');
  assert.equal(track().getAttribute('aria-checked'), 'false');
  const labelId = track().getAttribute('aria-labelledby');
  assert.equal(text(h.documentRef.getElementById(labelId)), 'Wide transcript');
  click(h.documentRef, track());
  assert.deepEqual(calls, ['toggle']);
  assert.equal(track().getAttribute('aria-checked'), 'true');
  click(h.documentRef, track());
  assert.equal(calls.length, 2);
  assert.equal(track().getAttribute('aria-checked'), 'false');
});

test('Wide transcript follows read() when the toggle does not apply the change', () => {
  const h = buildHarness({ deps: { chatWidth: { read: () => false, toggle: () => {} } } });
  createQuickSettingsModal(h.deps).open();
  const track = h.documentRef.querySelector('[data-inv-toggle="quickSettingsWideTranscript"]');
  click(h.documentRef, track);
  assert.equal(h.documentRef.querySelector('[data-inv-toggle="quickSettingsWideTranscript"]').getAttribute('aria-checked'), 'false');
});

test('Wide transcript without a toggle is disabled with the reason, not hidden', () => {
  const h = buildHarness();
  createQuickSettingsModal(h.deps).open();
  const track = h.documentRef.querySelector('[data-inv-toggle="quickSettingsWideTranscript"]');
  assert.ok(track);
  assert.equal(track.disabled, true);
  assert.equal(track.closest('label').getAttribute('title'), 'Open a chat to use this');
});

// ── Model row ───────────────────────────────────────────────────────────

test('Model row: a known tunable model shows its id and an enabled Tune that opens tuning', () => {
  const h = buildHarness();
  const controller = createQuickSettingsModal(h.deps);
  controller.open();
  const slot = h.documentRef.querySelector('[data-slot="model"]');
  assert.equal(text(slot.querySelector('.quick-settings-slot-title')), 'Model');
  assert.equal(text(slot.querySelector('.quick-settings-model-name')), 'modelA');
  assert.equal(slot.querySelector('.quick-settings-model-name').getAttribute('title'), 'modelA');
  const tune = slot.querySelector('[data-action="open-model-tuning"]');
  assert.equal(text(tune), 'Tune');
  assert.equal(tune.disabled, false);
  assert.equal(tune.getAttribute('title'), 'Open per-model tuning for the current model');
  click(h.documentRef, tune);
  assert.equal(controller.isOpen(), false);
  assert.equal(h.openModelTuningCalls.length, 1);
  assert.equal(h.openModelTuningCalls[0][0], 'modelA');
});

test('Model row: no model shows the muted line and a disabled Tune with the reason', () => {
  const h = buildHarness({ prefs: { preferredModel: '' } });
  createQuickSettingsModal(h.deps).open();
  const slot = h.documentRef.querySelector('[data-slot="model"]');
  assert.equal(text(slot.querySelector('.quick-settings-model-name')), 'No model selected');
  const tune = slot.querySelector('[data-action="open-model-tuning"]');
  assert.equal(tune.disabled, true);
  assert.equal(tune.getAttribute('title'), 'Pick a model in the composer first');
});

test('Model row: an engine that owns its controls disables Tune with that reason', () => {
  const h = buildHarness({ state: { modelList: { data: [{ id: 'modelA', available: true, engine_type: 'codex-cli' }] } } });
  createQuickSettingsModal(h.deps).open();
  const tune = h.documentRef.querySelector('[data-slot="model"] [data-action="open-model-tuning"]');
  assert.equal(tune.disabled, true);
  assert.equal(tune.getAttribute('title'), 'This engine owns its generation controls.');
  assert.equal(text(h.documentRef.querySelector('[data-slot="model"] .quick-settings-model-name')), 'modelA');
});

// ── Force local status line ─────────────────────────────────────────────

test('Status line: checking, then ready, then blocking with Open Models, repainted live', () => {
  const h = buildHarness();
  const controller = createQuickSettingsModal(h.deps);
  controller.open();
  const slot = h.documentRef.querySelector('[data-slot="model"]');
  const chip = () => slot.querySelector('.quick-settings-row-note [data-state]');
  assert.equal(chip().getAttribute('data-state'), 'loading');
  assert.equal(text(chip()), 'Checking the local engine…');

  h.state.offline = { resolved: true, localChatReady: true, mode: 'disabled' };
  assert.equal(controller.refreshOffline(), undefined);
  assert.equal(chip().getAttribute('data-state'), 'live');
  assert.equal(text(chip()), 'Local engine ready');
  assert.equal(slot.querySelector('[data-action="quick-settings-open-models"]'), null);

  h.state.offline = { resolved: true, localChatReady: false, mode: 'disabled', summary: 'No local model.' };
  controller.refreshOffline();
  assert.equal(chip().getAttribute('data-state'), 'error');
  assert.equal(text(chip()), 'Local engine not reachable');
  assert.equal(chip().getAttribute('title'), 'No local model.');
  assert.equal(slot.querySelector('[data-action="quick-settings-open-models"]'), null);

  h.state.offline = { resolved: true, localChatReady: false, mode: 'local_only', unavailableReason: 'engine down' };
  controller.refreshOffline();
  assert.equal(text(chip()), 'The local engine is not reachable, so chats will not send while this is on.');
  assert.equal(chip().getAttribute('title'), 'engine down');
  assert.equal(slot.querySelector('[data-inv-toggle="quickSettingsLocalOnly"]').getAttribute('aria-checked'), 'true');
  const link = slot.querySelector('[data-action="quick-settings-open-models"]');
  assert.equal(text(link), 'Open Models');
  click(h.documentRef, link);
  assert.equal(controller.isOpen(), false);
  assert.deepEqual(h.openSettingsSectionCalls, [['models']]);
});

test('a successful Force local write repaints the status line and asks for a fresh offline state', async () => {
  const h = buildHarness({ state: { offline: { resolved: true, localChatReady: false, mode: 'disabled', summary: '', unavailableReason: '' } } });
  // Like production's offline adapter: the write applies the new mode to state.offline.
  h.deps.adapters.offline = {
    read: () => h.state.offline,
    write: (value) => { h.state.offline = Object.assign({}, h.state.offline, value); return Promise.resolve(value); },
  };
  let refreshes = 0;
  h.deps.onOfflineWritten = () => { refreshes += 1; };
  const controller = createQuickSettingsModal(h.deps);
  controller.open();
  const slot = h.documentRef.querySelector('[data-slot="model"]');
  const chip = () => slot.querySelector('.quick-settings-row-note [data-state]');
  assert.equal(text(chip()), 'Local engine not reachable');
  click(h.documentRef, slot.querySelector('[data-inv-toggle="quickSettingsLocalOnly"]'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(h.state.offline.mode, 'local_only');
  assert.equal(text(chip()), 'The local engine is not reachable, so chats will not send while this is on.');
  assert.ok(slot.querySelector('[data-action="quick-settings-open-models"]'));
  assert.equal(refreshes, 1);
});

test('refreshOffline repaints the toggle in place and does nothing while closed', () => {
  const h = buildHarness();
  const controller = createQuickSettingsModal(h.deps);
  assert.doesNotThrow(() => controller.refreshOffline());
  controller.open();
  const track = h.documentRef.querySelector('[data-inv-toggle="quickSettingsLocalOnly"]');
  h.state.offline = { resolved: true, localChatReady: true, mode: 'local_only' };
  controller.refreshOffline();
  assert.equal(h.documentRef.querySelector('[data-inv-toggle="quickSettingsLocalOnly"]'), track, 'same node, so focus is kept');
  assert.equal(track.getAttribute('aria-checked'), 'true');
  controller.close();
  const before = text(h.documentRef.querySelector('[data-slot="model"]'));
  h.state.offline = { resolved: true, localChatReady: false, mode: 'disabled' };
  assert.doesNotThrow(() => controller.refreshOffline());
  assert.equal(text(h.documentRef.querySelector('[data-slot="model"]')), before);
});

// ── Chats + footer ──────────────────────────────────────────────────────

test('Chats group: one label, the switch is named by it', () => {
  const h = buildHarness();
  createQuickSettingsModal(h.deps).open();
  const slot = h.documentRef.querySelector('[data-slot="chats"]');
  assert.equal(text(slot.querySelector('.quick-settings-slot-title')), 'Chats');
  assert.equal(slot.querySelector('.inv-toggle-label'), null);
  const track = slot.querySelector('[data-inv-toggle="quickSettingsSessionsOpenInNewTab"]');
  assert.equal(text(h.documentRef.getElementById(track.getAttribute('aria-labelledby'))), 'Open chats in a new tab');
  click(h.documentRef, track);
  assert.deepEqual(h.sessionOpen._writeCalls, [true]);
});

test('Footer: All settings still opens settings and closes; the chord hint is shown', () => {
  const h = buildHarness();
  const controller = createQuickSettingsModal(h.deps);
  controller.open();
  const footer = h.documentRef.querySelector('.quick-settings-footer');
  click(h.documentRef, footer.querySelector('[data-action="quick-settings-all"]'));
  assert.equal(controller.isOpen(), false);
  assert.deepEqual(h.openSettingsSectionCalls, [['models']]);
  const chord = footer.querySelector('.quick-settings-chord');
  assert.ok(chord);
  assert.equal(chord.querySelectorAll('kbd').length, 2);
  assert.match(text(chord), /opens and closes this/);
});

// ── Offline utils seam ──────────────────────────────────────────────────

test('renderOfflineManager asks the open Quick settings modal to repaint', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'features', 'renderer-offline-utils.js'), 'utf8');
  const dom = new JSDOM('<!doctype html><body><div id="offlineLocalOnlyList"></div><span id="composerChatPostureDot"></span></body>');
  const sandbox = {
    document: dom.window.document,
    console,
    require: () => { throw new Error('no require'); },
    stringUtils: require('../renderer/shared/string-utils'),
    rendererAsyncFence: require('../renderer/shared/async-fence'),
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'renderer-offline-utils.js' });
  const manager = sandbox.rendererOfflineUtils.createOfflineManager({
    state: {},
    callbacks: { appendClientLog() {}, renderSettings() {} },
    dom: { offlineLocalOnlyList: dom.window.document.getElementById('offlineLocalOnlyList') },
  });
  assert.doesNotThrow(() => manager.renderOfflineManager(), 'absent controller is fine');
  let repaints = 0;
  sandbox.rendererQuickSettingsModalController = { refreshOffline: () => { repaints += 1; } };
  manager.renderOfflineManager();
  assert.equal(repaints, 1);
  sandbox.rendererQuickSettingsModalController = { refreshOffline: () => { throw new Error('boom'); } };
  assert.doesNotThrow(() => manager.renderOfflineManager(), 'a failing repaint never breaks the offline render');
});
