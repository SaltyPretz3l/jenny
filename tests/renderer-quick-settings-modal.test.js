'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const { createQuickSettingsModal } = require('../renderer/shell/renderer-quick-settings-modal.js');
const selectFieldRaw = require('../renderer/inventory/select-field.js');
const toggleSwitchModule = require('../renderer/inventory/toggle-switch.js');
const segmentedControlRaw = require('../renderer/inventory/segmented-control.js');
const actionButtonRaw = require('../renderer/inventory/action-button.js');
const appearanceUtils = require('../renderer/shared/appearance-utils.js');
const chatZoomUtils = require('../renderer/chat/chat-zoom-utils.js');
const statusChipUtils = require('../renderer/shell/renderer-status-chip-utils.js');

// Mirrors renderer/inventory/index.js's barrel behavior: toggleSwitch's UMD
// exports { toggleSwitch, toggle, setChecked, initToggleHandlers } -- the
// render function gets the imperative helpers attached onto it.
const toggleSwitchFn = toggleSwitchModule.toggleSwitch;
toggleSwitchFn.setChecked = toggleSwitchModule.setChecked;
toggleSwitchFn.toggle = toggleSwitchModule.toggle;
toggleSwitchFn.initToggleHandlers = toggleSwitchModule.initToggleHandlers;

const inventory = {
  selectField: selectFieldRaw,
  toggleSwitch: toggleSwitchFn,
  segmentedControl: segmentedControlRaw,
  actionButton: actionButtonRaw,
};

function buildDom() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  const documentRef = dom.window.document;
  // Mirror production exactly: renderer/inventory/index.js installs the
  // delegated toggle + segmented handlers ONCE on `document`. The modal must
  // NOT install its own container-level copies -- the toggle handler flips
  // relatively, so a duplicate install double-fires every click (this test
  // setup is what keeps that regression visible).
  toggleSwitchModule.initToggleHandlers(documentRef);
  segmentedControlRaw.initSegmentedHandlers(documentRef);
  return documentRef;
}

function makeFakeAdapter(initialValue) {
  const writeCalls = [];
  let current = initialValue;
  let rejectNext = null;
  return {
    read: () => current,
    write: (value) => {
      writeCalls.push(value);
      if (rejectNext) {
        const error = rejectNext;
        rejectNext = null;
        return Promise.reject(error);
      }
      current = value;
      return Promise.resolve(value);
    },
    _writeCalls: writeCalls,
    _rejectNext: (error) => { rejectNext = error; },
    _current: () => current,
  };
}

function buildState(overrides) {
  return Object.assign({
    features: { featureFlags: { quick_settings: true } },
    modelList: { data: [{ id: 'modelA', available: true }, { id: 'modelB', available: true }, { id: 'modelC', available: true }] },
    offline: { resolved: false, mode: 'disabled', localChatReady: false, summary: '', unavailableReason: '' },
    ui: { activeSettingsSection: 'models' },
  }, overrides || {});
}

function buildDeps(documentRef, overrides) {
  const appearanceAdapter = makeFakeAdapter({ paletteId: 'midnight', fontScaleId: 'default' });
  const zoomAdapter = makeFakeAdapter(100);
  const offlineAdapter = makeFakeAdapter({ mode: 'disabled', preferredLocalModel: '' });
  const appendClientLogCalls = [];
  const openSettingsSectionCalls = [];
  const openModelTuningCalls = [];
  const contextTuningCalls = [];
  let currentPrefs = { preferredModel: 'modelA' };
  let contextTuning = {
    ratioByModel: {},
    contextLengthByModel: { modelA: 32768 },
    contextLengthSteps: [4096, 8192, 16384, 32768, 65536, 131072, 262144],
    customPrompt: '',
  };

  const deps = {
    documentRef,
    windowRef: documentRef.defaultView,
    state: buildState(overrides && overrides.stateOverrides),
    adapters: { appearance: appearanceAdapter, zoom: zoomAdapter, offline: offlineAdapter },
    runtimePrefs: {
      getCurrent: () => currentPrefs,
    },
    openSettingsSection: (...args) => openSettingsSectionCalls.push(args),
    openModelTuning: (...args) => openModelTuningCalls.push(args),
    appendClientLog: (...args) => appendClientLogCalls.push(args),
    inventory,
    appearanceUtils,
    chatZoomUtils,
    statusChipUtils,
  };
  deps.windowRef.jennyShell = {
    compaction: {
      getTuning: async () => contextTuning,
      setTuning: async (payload) => {
        contextTuningCalls.push(payload);
        const next = { ...contextTuning.contextLengthByModel };
        if (payload.contextLength == null) delete next[payload.modelId];
        else next[payload.modelId] = payload.contextLength;
        contextTuning = { ...contextTuning, contextLengthByModel: next };
        return contextTuning;
      },
    },
  };

  return {
    deps,
    appearanceAdapter,
    zoomAdapter,
    offlineAdapter,
    appendClientLogCalls,
    openSettingsSectionCalls,
    openModelTuningCalls,
    contextTuningCalls,
    getCurrentPrefs: () => currentPrefs,
  };
}

// ── DOM contract + overlay integration ──────────────────────────────────

test('open() builds DOM per the CSS contract and unhides it', () => {
  const documentRef = buildDom();
  const { deps } = buildDeps(documentRef);
  const controller = createQuickSettingsModal(deps);

  assert.equal(controller.open(), true);
  const overlay = documentRef.querySelector('.quick-settings-overlay');
  assert.ok(overlay, 'overlay root exists');
  assert.equal(overlay.hidden, false);
  assert.equal(overlay.getAttribute('role'), 'dialog');
  assert.equal(overlay.getAttribute('aria-modal'), 'true');
  assert.equal(overlay.getAttribute('aria-labelledby'), 'quickSettingsTitle');
  assert.ok(overlay.querySelector('.quick-settings-scrim'));
  assert.ok(overlay.querySelector('.quick-settings-dialog'));
  assert.ok(overlay.querySelector('.quick-settings-header'));
  assert.ok(overlay.querySelector('#quickSettingsTitle'));
  assert.ok(overlay.querySelector('.quick-settings-close'));
  assert.equal(overlay.querySelector('.quick-settings-close').getAttribute('title'), 'Close quick settings');
  assert.ok(overlay.querySelector('.quick-settings-body'));
  assert.equal(overlay.querySelectorAll('.quick-settings-slot').length, 3);
  assert.ok(overlay.querySelector('.quick-settings-row'));
  assert.ok(overlay.querySelector('.quick-settings-row-label'));
  assert.ok(overlay.querySelector('.quick-settings-row-control'));
  assert.ok(overlay.querySelector('.quick-settings-row-note'));
  assert.ok(overlay.querySelector('.quick-settings-footer'));
  assert.ok(overlay.querySelector('.quick-settings-all'));

  controller.close();
  assert.equal(overlay.hidden, true);
});

test('open() appends the overlay to documentRef.body once and reuses it on reopen', () => {
  const documentRef = buildDom();
  const { deps } = buildDeps(documentRef);
  const controller = createQuickSettingsModal(deps);

  controller.open();
  controller.close();
  controller.open();
  assert.equal(documentRef.querySelectorAll('.quick-settings-overlay').length, 1);
});

test('open() registers with the injected overlay manager; close() deregisters', () => {
  const documentRef = buildDom();
  const openCalls = [];
  const closeCalls = [];
  const overlayManager = {
    open: (entry) => { openCalls.push(entry); return true; },
    close: (id) => { closeCalls.push(id); return true; },
  };
  const { deps } = buildDeps(documentRef);
  const appShell = documentRef.createElement('div');
  documentRef.body.appendChild(appShell);
  deps.overlayManager = overlayManager;
  deps.inertTargets = [appShell];
  const controller = createQuickSettingsModal(deps);

  controller.open();
  assert.equal(openCalls.length, 1);
  assert.equal(openCalls[0].id, 'quick-settings');
  assert.equal(typeof openCalls[0].onRequestClose, 'function');
  assert.ok(openCalls[0].root, 'root passed to overlay manager');
  assert.deepEqual(openCalls[0].inertTargets, [appShell]);

  controller.close();
  assert.deepEqual(closeCalls, ['quick-settings']);
});

test('overlayManager.onRequestClose triggers the same close() path', () => {
  const documentRef = buildDom();
  let requestClose = null;
  const overlayManager = {
    open: (entry) => { requestClose = entry.onRequestClose; return true; },
    close: () => true,
  };
  const { deps } = buildDeps(documentRef);
  deps.overlayManager = overlayManager;
  const controller = createQuickSettingsModal(deps);

  controller.open();
  assert.equal(controller.isOpen(), true);
  requestClose('escape');
  assert.equal(controller.isOpen(), false);
});

test('scrim click and close-button click both close the modal', () => {
  const documentRef = buildDom();
  const { deps } = buildDeps(documentRef);
  const controller = createQuickSettingsModal(deps);

  controller.open();
  documentRef.querySelector('.quick-settings-scrim').dispatchEvent(
    new documentRef.defaultView.MouseEvent('click', { bubbles: true })
  );
  assert.equal(controller.isOpen(), false);

  controller.open();
  documentRef.querySelector('.quick-settings-close').dispatchEvent(
    new documentRef.defaultView.MouseEvent('click', { bubbles: true })
  );
  assert.equal(controller.isOpen(), false);
});

test('feature flag quick_settings === false blocks open()', () => {
  const documentRef = buildDom();
  const { deps } = buildDeps(documentRef, { stateOverrides: { features: { featureFlags: { quick_settings: false } } } });
  const controller = createQuickSettingsModal(deps);

  assert.equal(controller.open(), false);
  assert.equal(controller.isOpen(), false);
  assert.equal(documentRef.querySelector('.quick-settings-overlay'), null);
});

test('absent quick_settings flag defaults to enabled', () => {
  const documentRef = buildDom();
  const { deps } = buildDeps(documentRef, { stateOverrides: { features: { featureFlags: {} } } });
  const controller = createQuickSettingsModal(deps);

  assert.equal(controller.open(), true);
});

test('no overlayManager injected: local Escape fallback closes the modal', () => {
  const documentRef = buildDom();
  const { deps } = buildDeps(documentRef);
  const appShell = documentRef.createElement('div');
  documentRef.body.appendChild(appShell);
  deps.inertTargets = [appShell];
  const controller = createQuickSettingsModal(deps);

  controller.open();
  assert.equal(controller.isOpen(), true);
  assert.equal(appShell.hasAttribute('inert'), true, 'fallback removes the background from interaction');
  documentRef.dispatchEvent(new documentRef.defaultView.KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, cancelable: true,
  }));
  assert.equal(controller.isOpen(), false);
  assert.equal(appShell.hasAttribute('inert'), false, 'fallback restores the prior background state');
});

test('model slot exposes only a shortcut to the authoritative model profile', async () => {
  const documentRef = buildDom();
  const harness = buildDeps(documentRef);
  const controller = createQuickSettingsModal(harness.deps);

  controller.open();
  await Promise.resolve();
  await Promise.resolve();

  const shortcut = documentRef.querySelector('[data-action="open-model-tuning"]');
  assert.ok(shortcut, 'model tuning shortcut renders inside the model slot');
  assert.equal(shortcut.getAttribute('title'), 'Open per-model tuning for the current model');
  assert.equal(documentRef.getElementById('quickSettingsContextWindow'), null);
  shortcut.click();
  assert.equal(harness.openModelTuningCalls.length, 1);
  assert.equal(harness.openModelTuningCalls[0][0], 'modelA');
  assert.equal(harness.openModelTuningCalls[0][1]?.isConnected, true);
  assert.notEqual(harness.openModelTuningCalls[0][1], shortcut);
  assert.deepEqual(harness.contextTuningCalls, []);
});

test('model shortcut follows the selected catalog model without duplicating capability policy', async () => {
  const documentRef = buildDom();
  const harness = buildDeps(documentRef, {
    stateOverrides: {
      preferredEngineType: 'vllm',
      modelList: { data: [{ id: 'modelA', available: true, engine_type: 'ollama' }] },
    },
  });
  const controller = createQuickSettingsModal(harness.deps);

  controller.open();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(documentRef.querySelector('[data-action="open-model-tuning"]').disabled, false);
});

test('model shortcut is hidden for provider-owned generation controls', async () => {
  const documentRef = buildDom();
  const harness = buildDeps(documentRef, {
    stateOverrides: {
      modelList: { data: [{ id: 'modelA', available: true, engine_type: 'codex-cli' }] },
    },
  });
  const controller = createQuickSettingsModal(harness.deps);

  controller.open();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(documentRef.querySelector('[data-action="open-model-tuning"]'), null);
  assert.match(documentRef.querySelector('.quick-settings-overlay').textContent,
    /engine owns its generation controls/i);
});

test('fallback Escape is ignored when defaultPrevented or isComposing', () => {
  const documentRef = buildDom();
  const { deps } = buildDeps(documentRef);
  const controller = createQuickSettingsModal(deps);

  controller.open();
  const prevented = new documentRef.defaultView.KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, cancelable: true,
  });
  prevented.preventDefault();
  documentRef.dispatchEvent(prevented);
  assert.equal(controller.isOpen(), true, 'defaultPrevented Escape must not close');

  documentRef.dispatchEvent(new documentRef.defaultView.KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, cancelable: true, isComposing: true,
  }));
  assert.equal(controller.isOpen(), true, 'isComposing Escape must not close');
});

// ── Composer-only model ownership ────────────────────────────────────────

test('quick settings has no session model selector or duplicated tuning controls', () => {
  const documentRef = buildDom();
  const harness = buildDeps(documentRef);
  const controller = createQuickSettingsModal(harness.deps);

  controller.open();
  assert.equal(documentRef.getElementById('quickSettingsModel'), null);
  assert.equal(documentRef.getElementById('quickSettingsContextWindow'), null);
  assert.ok(documentRef.querySelector('[data-action="open-model-tuning"]'));
  assert.match(documentRef.querySelector('[data-slot="model"] .quick-settings-slot-title').textContent, /Model runtime/);
});

// ── local-only readiness chip ─────────────────────────────────────────────

test('local-only readiness chip: loading -> live -> error', () => {
  const documentRef = buildDom();
  const harness = buildDeps(documentRef, {
    stateOverrides: { offline: { resolved: false, mode: 'disabled', localChatReady: false, summary: '', unavailableReason: '' } },
  });
  const controller = createQuickSettingsModal(harness.deps);

  controller.open();
  let chip = documentRef.querySelector('.quick-settings-row-note [data-state]');
  assert.equal(chip.getAttribute('data-state'), 'loading');

  harness.deps.state.offline = { resolved: true, mode: 'local_only', localChatReady: true, summary: '', unavailableReason: '' };
  controller.close();
  controller.open();
  chip = documentRef.querySelector('.quick-settings-row-note [data-state]');
  assert.equal(chip.getAttribute('data-state'), 'live');

  harness.deps.state.offline = {
    resolved: true, mode: 'local_only', localChatReady: false, summary: 'Local model missing.', unavailableReason: 'no model',
  };
  controller.close();
  controller.open();
  chip = documentRef.querySelector('.quick-settings-row-note [data-state]');
  assert.equal(chip.getAttribute('data-state'), 'error');
  assert.equal(chip.getAttribute('title'), 'Local model missing.');
});

// Regression lock (audit finding, 2026-07-09): the modal must NOT install its
// own initToggleHandlers on the local-only host. Production already delegates
// on `document` (renderer/inventory/index.js), and the toggle handler flips
// RELATIVELY, so a duplicate install turns one click into checked:true THEN
// checked:false -- two conflicting offline writes and a visually dead switch.
// buildDom() installs the document-level handlers exactly like production, so
// a reintroduced container-level install makes this fire twice and fail.
test('one local-only click fires exactly ONE offline write (no double-fire from duplicate toggle handlers)', () => {
  const documentRef = buildDom();
  const harness = buildDeps(documentRef);
  const controller = createQuickSettingsModal(harness.deps);

  controller.open();
  const toggleTrack = documentRef.querySelector('[data-slot="model"] [data-inv-toggle]');
  toggleTrack.dispatchEvent(new documentRef.defaultView.MouseEvent('click', { bubbles: true }));

  return Promise.resolve().then(() => Promise.resolve()).then(() => {
    assert.equal(harness.offlineAdapter._writeCalls.length, 1);
    assert.deepEqual(harness.offlineAdapter._writeCalls[0], { mode: 'local_only', preferredLocalModel: '' });
    assert.equal(toggleTrack.getAttribute('aria-checked'), 'true');
  });
});

// ── separate-contracts lock (font-scale vs chat-zoom) ────────────────────

test('font-scale writes ONLY through the appearance adapter; zoom is untouched', () => {
  const documentRef = buildDom();
  const harness = buildDeps(documentRef);
  const controller = createQuickSettingsModal(harness.deps);

  controller.open();
  const zoomSlot = documentRef.querySelector('[data-slot="zoom"]');
  const fontScaleControl = zoomSlot.querySelector('.quick-settings-row-control');
  // Presets: small/default/large/xlarge = 4 entries -> rendered as a SegmentedControl.
  const segmented = fontScaleControl.querySelector('[role="radiogroup"]');
  assert.ok(segmented, 'font-scale renders as a segmented control for a 2-4 preset catalog');
  const largeOption = segmented.querySelector('[data-value="large"]');
  largeOption.dispatchEvent(new documentRef.defaultView.MouseEvent('click', { bubbles: true }));

  assert.equal(harness.appearanceAdapter._writeCalls.length, 1);
  assert.equal(harness.appearanceAdapter._writeCalls[0].fontScaleId, 'large');
  assert.equal(harness.zoomAdapter._writeCalls.length, 0, 'zoom adapter must never see a font-scale write');
});

test('chat-zoom writes ONLY through the zoom adapter; appearance is untouched', () => {
  const documentRef = buildDom();
  const harness = buildDeps(documentRef);
  const controller = createQuickSettingsModal(harness.deps);

  controller.open();
  const zoomSelect = documentRef.querySelector('[data-slot="zoom"] select');
  zoomSelect.value = '110';
  zoomSelect.dispatchEvent(new documentRef.defaultView.Event('change', { bubbles: true }));

  assert.equal(harness.zoomAdapter._writeCalls.length, 1);
  assert.equal(harness.zoomAdapter._writeCalls[0], 110);
  assert.equal(harness.appearanceAdapter._writeCalls.length, 0, 'appearance adapter must never see a chat-zoom write');
});

test('palette select writes through the appearance adapter, preserving the other appearance fields', () => {
  const documentRef = buildDom();
  const harness = buildDeps(documentRef);
  const controller = createQuickSettingsModal(harness.deps);

  controller.open();
  const paletteSelect = documentRef.querySelector('[data-slot="appearance"] select');
  paletteSelect.value = 'obsidian';
  paletteSelect.dispatchEvent(new documentRef.defaultView.Event('change', { bubbles: true }));

  assert.equal(harness.appearanceAdapter._writeCalls.length, 1);
  const written = harness.appearanceAdapter._writeCalls[0];
  assert.equal(written.paletteId, 'obsidian');
  assert.equal(written.fontScaleId, 'default', 'other appearance fields are preserved, not clobbered');
});

// ── "All settings" footer button ──────────────────────────────────────────

test('"All settings" closes the modal and invokes openSettingsSection', () => {
  const documentRef = buildDom();
  const harness = buildDeps(documentRef);
  const controller = createQuickSettingsModal(harness.deps);

  controller.open();
  documentRef.querySelector('.quick-settings-all').dispatchEvent(
    new documentRef.defaultView.MouseEvent('click', { bubbles: true })
  );

  assert.equal(controller.isOpen(), false);
  assert.equal(harness.openSettingsSectionCalls.length, 1);
  assert.deepEqual(harness.openSettingsSectionCalls[0], ['models']);
});

// ── write failure: log + reflect reverted value ───────────────────────────

test('a failed write logs via appendClientLog and re-renders the reverted value', () => {
  const documentRef = buildDom();
  const harness = buildDeps(documentRef);
  const controller = createQuickSettingsModal(harness.deps);

  controller.open();
  const paletteSelect = documentRef.querySelector('[data-slot="appearance"] select');
  harness.appearanceAdapter._rejectNext(new Error('disk full'));
  paletteSelect.value = 'obsidian';
  paletteSelect.dispatchEvent(new documentRef.defaultView.Event('change', { bubbles: true }));

  return Promise.resolve().then(() => Promise.resolve()).then(() => {
    assert.ok(harness.appendClientLogCalls.some((call) => call[1] === 'quick_settings.write_failed'));
    const reRendered = documentRef.querySelector('[data-slot="appearance"] select');
    assert.equal(reRendered.value, 'midnight', 'control reflects the adapter-reverted value, not the failed write');
  });
});

test('a failed local-only toggle write logs and reflects the reverted checked state', () => {
  const documentRef = buildDom();
  const harness = buildDeps(documentRef);
  const controller = createQuickSettingsModal(harness.deps);

  controller.open();
  const toggleTrack = documentRef.querySelector('[data-slot="model"] [data-inv-toggle]');
  harness.offlineAdapter._rejectNext(new Error('ipc unreachable'));
  toggleTrack.dispatchEvent(new documentRef.defaultView.MouseEvent('click', { bubbles: true }));

  return Promise.resolve().then(() => Promise.resolve()).then(() => {
    assert.ok(harness.appendClientLogCalls.some((call) => call[1] === 'quick_settings.write_failed'));
    // state.offline (the readiness/toggle source of truth) was never mutated
    // by the rejected write -- re-render still reflects the pre-write mode.
    const track = documentRef.querySelector('[data-slot="model"] [data-inv-toggle]');
    assert.equal(track.getAttribute('aria-checked'), 'false');
  });
});

// ── palette command seam ──────────────────────────────────────────────────

test('command palette Actions item appears and runs when the seam is present, absent-safe otherwise', () => {
  const modulePath = require.resolve('../renderer/shell/renderer-command-palette.js');
  delete require.cache[modulePath];
  const { createCommandPaletteController } = require('../renderer/shell/renderer-command-palette.js');

  const documentRef = buildDom();
  const commandPaletteOverlay = documentRef.createElement('div');
  const commandPaletteInput = documentRef.createElement('input');
  const commandPaletteList = documentRef.createElement('div');
  documentRef.body.append(commandPaletteOverlay, commandPaletteInput, commandPaletteList);
  const state = { ui: {}, auth: { authenticated: true }, sessions: [], features: { featureFlags: { command_palette: true } } };

  // Absent-safe: no seam stashed on globalThis.
  delete global.rendererQuickSettingsModalController;
  const controllerAbsent = createCommandPaletteController({
    state,
    dom: { commandPaletteOverlay, commandPaletteInput, commandPaletteList },
  });
  controllerAbsent.bind();
  controllerAbsent.open();
  assert.equal(commandPaletteList.innerHTML.includes('Open quick settings'), false);
  controllerAbsent.close();
  controllerAbsent.dispose();

  // Present: the seam is stashed (mirrors what the binder does on windowRef).
  let toggleCalls = 0;
  global.rendererQuickSettingsModalController = { toggle: () => { toggleCalls += 1; } };
  const controllerPresent = createCommandPaletteController({
    state,
    dom: { commandPaletteOverlay, commandPaletteInput, commandPaletteList },
  });
  controllerPresent.bind();
  controllerPresent.open();
  assert.equal(commandPaletteList.innerHTML.includes('Open quick settings'), true);
  const item = Array.from(commandPaletteList.querySelectorAll('.command-palette-item'))
    .find((el) => el.getAttribute('data-palette-id') === 'action:quick-settings');
  assert.ok(item, 'quick-settings item is rendered with a stable id');
  item.click();
  return Promise.resolve().then(() => {
    assert.equal(toggleCalls, 1);
    delete global.rendererQuickSettingsModalController;
  });
});

// ── chord: Ctrl/Cmd+, in the app-shell binder ─────────────────────────────

function loadChordBinder(fakeWindow) {
  const previousWindow = global.window;
  global.window = fakeWindow;
  fakeWindow.rendererQuickSettingsModalUtils = { createQuickSettingsModal };
  try {
    const modulePath = require.resolve('../renderer/app/renderer-app-shell-bindings-quick-settings.js');
    delete require.cache[modulePath];
    require('../renderer/app/renderer-app-shell-bindings-quick-settings.js');
  } finally {
    global.window = previousWindow;
  }
  return fakeWindow.rendererAppShellBindingsQuickSettings.bindQuickSettings;
}

function buildChordCtx(documentRef) {
  const cleanups = [];
  return {
    ctx: {
      state: buildState(),
      windowRef: documentRef.defaultView,
      documentRef,
      controllers: {},
      callbacks: {
        getCurrentRuntimePreferences: () => ({ preferredModel: '' }),
        persistRuntimePreferences: () => Promise.resolve(),
        openSettingsSection: () => {},
        appendClientLog: () => {},
        registerCleanup: (fn) => cleanups.push(fn),
      },
    },
    cleanups,
  };
}

function dispatchChord(win, doc, overrides) {
  const event = new win.KeyboardEvent('keydown', Object.assign({
    key: ',', bubbles: true, cancelable: true,
  }, overrides));
  doc.dispatchEvent(event);
  return event;
}

test('chord fires on ctrlKey+comma and toggles the modal', () => {
  const documentRef = buildDom();
  const win = documentRef.defaultView;
  const bindQuickSettings = loadChordBinder(win);
  const { ctx } = buildChordCtx(documentRef);
  const controller = bindQuickSettings(ctx);
  assert.ok(controller, 'binder builds a controller');
  assert.equal(controller.isOpen(), false);

  const event = dispatchChord(win, documentRef, { ctrlKey: true });
  assert.equal(controller.isOpen(), true);
  assert.equal(event.defaultPrevented, true);
});

test('chord fires on metaKey+comma too (no platform detection)', () => {
  const documentRef = buildDom();
  const win = documentRef.defaultView;
  const bindQuickSettings = loadChordBinder(win);
  const { ctx } = buildChordCtx(documentRef);
  const controller = bindQuickSettings(ctx);

  dispatchChord(win, documentRef, { metaKey: true });
  assert.equal(controller.isOpen(), true);
});

test('chord ignores alt/shift combos', () => {
  const documentRef = buildDom();
  const win = documentRef.defaultView;
  const bindQuickSettings = loadChordBinder(win);
  const { ctx } = buildChordCtx(documentRef);
  const controller = bindQuickSettings(ctx);

  dispatchChord(win, documentRef, { ctrlKey: true, altKey: true });
  assert.equal(controller.isOpen(), false);
  dispatchChord(win, documentRef, { ctrlKey: true, shiftKey: true });
  assert.equal(controller.isOpen(), false);
});

test('chord ignores isComposing', () => {
  const documentRef = buildDom();
  const win = documentRef.defaultView;
  const bindQuickSettings = loadChordBinder(win);
  const { ctx } = buildChordCtx(documentRef);
  const controller = bindQuickSettings(ctx);

  const event = dispatchChord(win, documentRef, { ctrlKey: true, isComposing: true });
  assert.equal(controller.isOpen(), false);
  assert.equal(event.defaultPrevented, false);
});

test('chord opens even when a text input is focused', () => {
  const documentRef = buildDom();
  const win = documentRef.defaultView;
  const textarea = documentRef.createElement('textarea');
  documentRef.body.appendChild(textarea);
  textarea.focus();
  const bindQuickSettings = loadChordBinder(win);
  const { ctx } = buildChordCtx(documentRef);
  const controller = bindQuickSettings(ctx);

  dispatchChord(win, documentRef, { ctrlKey: true });
  assert.equal(controller.isOpen(), true);
});

test('chord no-ops when the quick_settings flag is off', () => {
  const documentRef = buildDom();
  const win = documentRef.defaultView;
  const bindQuickSettings = loadChordBinder(win);
  const { ctx } = buildChordCtx(documentRef);
  ctx.state.features.featureFlags.quick_settings = false;
  const controller = bindQuickSettings(ctx);

  dispatchChord(win, documentRef, { ctrlKey: true });
  assert.equal(controller.isOpen(), false);
});

test('chord registers cleanup that removes the keydown listener', () => {
  const documentRef = buildDom();
  const win = documentRef.defaultView;
  const bindQuickSettings = loadChordBinder(win);
  const { ctx, cleanups } = buildChordCtx(documentRef);
  const controller = bindQuickSettings(ctx);
  assert.equal(cleanups.length, 1);

  cleanups[0]();
  dispatchChord(win, documentRef, { ctrlKey: true });
  assert.equal(controller.isOpen(), false, 'listener removed -- chord no longer fires');
  assert.equal(documentRef.querySelector('.quick-settings-overlay'), null, 'controller-owned DOM is removed');
  assert.equal(win.rendererQuickSettingsModalController, null, 'global controller seam is cleared');
});

test('dispose is idempotent and fences the deferred initial-focus continuation', async () => {
  const documentRef = buildDom();
  const harness = buildDeps(documentRef);
  const controller = createQuickSettingsModal(harness.deps);

  controller.open();
  controller.dispose();
  controller.dispose();
  await Promise.resolve();

  assert.equal(controller.isOpen(), false);
  assert.equal(documentRef.querySelector('.quick-settings-overlay'), null);
  assert.equal(controller.open(), false, 'a disposed controller cannot be reopened');
  assert.equal(documentRef.activeElement, documentRef.body, 'deferred focus did not enter removed modal DOM');
});

// ── review finding (2026-07-09): degenerate-input edges ───────────────────

test('open() with an empty model list keeps the context shortcut safely disabled', () => {
  const documentRef = buildDom();
  const harness = buildDeps(documentRef, { stateOverrides: { modelList: { data: [] } } });
  const controller = createQuickSettingsModal(harness.deps);

  assert.equal(controller.open(), true);
  assert.equal(documentRef.getElementById('quickSettingsModel'), null);
  assert.equal(documentRef.querySelector('[data-action="open-model-tuning"]').disabled, true);
});

test('open() with an appearanceUtils that exposes no preset getters renders empty controls without throwing', () => {
  const documentRef = buildDom();
  const harness = buildDeps(documentRef);
  harness.deps.appearanceUtils = {}; // no getPalettePresets / getFontScalePresets
  const controller = createQuickSettingsModal(harness.deps);

  assert.equal(controller.open(), true);
  // Palette select renders (empty options), font-scale falls back to a select
  // (presets.length 0 -> not segmented) -- both present, neither threw.
  assert.ok(documentRef.querySelector('[data-slot="appearance"] .quick-settings-row-control'));
  assert.ok(documentRef.querySelector('[data-slot="zoom"] .quick-settings-row-control'));
  assert.equal(documentRef.querySelector('.quick-settings-overlay').hidden, false);
});

test('open() with state.offline absent treats the toggle as unchecked and the readiness chip as loading', () => {
  const documentRef = buildDom();
  const harness = buildDeps(documentRef);
  delete harness.deps.state.offline;
  const controller = createQuickSettingsModal(harness.deps);

  assert.equal(controller.open(), true);
  const track = documentRef.querySelector('[data-slot="model"] [data-inv-toggle]');
  assert.equal(track.getAttribute('aria-checked'), 'false');
  const chip = documentRef.querySelector('.quick-settings-row-note [data-state]');
  assert.equal(chip.getAttribute('data-state'), 'loading');
});
