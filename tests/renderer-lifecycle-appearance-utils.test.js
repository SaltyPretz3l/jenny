const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createLifecycleAppearanceUtils,
} = require('../renderer/shell/renderer-lifecycle-appearance-utils');

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function createHarness(overrides = {}) {
  const logs = [];
  const layoutCalls = [];
  const state = {
    backend: { mode: 'managed-dev' },
    ui: {
      appearance: { paletteId: 'default' },
      activeView: '',
      chatZoomPercent: 100,
    },
  };
  const callbacks = {
    normalizeAppearancePreferences(value) {
      return value && typeof value === 'object' ? { ...value } : {};
    },
    getDefaultAppearancePreferences() {
      return { paletteId: 'default', typographyId: 'system', surfaceEffectId: 'none', composerHoloId: 'off' };
    },
    applyAppearanceToDocument(_document, value) {
      return { ...value, applied: true };
    },
    saveStoredAppearancePreferences(_storage, value) {
      return { ...value, saved: true };
    },
    normalizeChatZoomPercent(value) {
      return Number(value) || 100;
    },
    getDefaultChatZoomPercent() {
      return 100;
    },
    applyChatZoomToDocument(_document, value) {
      return Number(value) || 100;
    },
    ...overrides.callbacks,
  };
  const windowObject = {
    localStorage: {},
    requestAnimationFrame(callback) {
      callback();
    },
    jennyShell: {
      chatUi: {
        updateSettings: async () => ({ zoomPercent: 125 }),
      },
    },
    ...overrides.window,
  };
  const utils = createLifecycleAppearanceUtils({
    state,
    dom: {},
    constants: {
      APPEARANCE_STORAGE_KEY: 'appearance-key',
    },
    callbacks,
    fwd: {
      syncComposerVisualState: () => layoutCalls.push(['composer']),
      updateComposerSafeOffset: (payload) => layoutCalls.push(['offset', payload]),
      updateAssistantSpritePosition: (...args) => layoutCalls.push(['sprite', ...args]),
      renderSettings: () => layoutCalls.push(['settings']),
    },
    call: {},
    appendClientLog(level, event, details) {
      logs.push({ level, event, details });
    },
    escapeHtml,
    window: windowObject,
    document: {},
  });
  return { layoutCalls, logs, state, utils, windowObject };
}

test('chat zoom is retired: applying it never persists and keeps state at 100', async () => {
  const harness = createHarness();
  let chatUiWrites = 0;
  harness.windowObject.jennyShell.chatUi.updateSettings = async () => { chatUiWrites += 1; };
  assert.equal(await harness.utils.applyChatZoomPercent(125), 100);
  assert.equal(harness.state.ui.chatZoomPercent, 100);
  assert.equal(chatUiWrites, 0, 'the persisted chatUi.zoomPercent is left untouched');
});

test('zoom shortcuts step app zoom through the settings steps and roll back on failure', async () => {
  const harness = createHarness();
  const writes = [];
  harness.state.ui.appZoomPercent = 100;
  harness.windowObject.jennyShell.windowUi = {
    updateSettings: async (patch) => { writes.push(patch.appZoomPercent); return { appZoomPercent: patch.appZoomPercent }; },
  };
  assert.equal(await harness.utils.adjustChatZoomPercent(1), 110);
  assert.equal(await harness.utils.adjustAppZoomPercent(1), 125);
  assert.equal(await harness.utils.adjustAppZoomPercent(-1), 110);
  assert.equal(await harness.utils.adjustAppZoomPercent(1), 125);
  assert.equal(await harness.utils.resetAppZoomPercent(), 110);
  assert.equal(await harness.utils.resetChatZoomPercent(), 110);
  assert.deepEqual(writes, [110, 125, 110, 125, 110]);
  harness.state.ui.appZoomPercent = 150;
  assert.equal(await harness.utils.adjustAppZoomPercent(1), 150, 'clamps at the top step without a write');
  assert.equal(writes.length, 5);

  harness.windowObject.jennyShell.windowUi.updateSettings = async () => { throw new Error('ipc down'); };
  await assert.rejects(() => harness.utils.adjustAppZoomPercent(-1), /ipc down/);
  assert.equal(harness.state.ui.appZoomPercent, 150);
  assert.equal(harness.logs.at(-1).event, 'app.zoom_update_failed');
});

test('unknown app zoom falls back to 110 for shortcut steps and invalid requests', async () => {
  const harness = createHarness();
  assert.equal(await harness.utils.adjustAppZoomPercent(0), 110);
  assert.equal(await harness.utils.adjustAppZoomPercent(1), 125);
  harness.state.ui.appZoomPercent = 'unknown';
  assert.equal(await harness.utils.adjustAppZoomPercent(-1), 100);
  assert.equal(await harness.utils.applyAppZoomPercent('unknown'), 110);
});

test('overlapping zoom writes that both fail roll back to the persisted value', async () => {
  const harness = createHarness();
  harness.state.ui.appZoomPercent = 100;
  const pending = [];
  harness.windowObject.jennyShell.windowUi = {
    updateSettings: () => new Promise((resolve, reject) => { pending.push({ resolve, reject }); }),
  };
  const first = harness.utils.adjustAppZoomPercent(1);
  const second = harness.utils.adjustAppZoomPercent(1);
  assert.equal(harness.state.ui.appZoomPercent, 125, 'optimistic value of the newest write');
  pending[0].reject(new Error('ipc down'));
  await assert.rejects(first, /ipc down/);
  assert.equal(harness.state.ui.appZoomPercent, 125, 'a stale failure does not override the newer write');
  pending[1].reject(new Error('ipc down'));
  await assert.rejects(second, /ipc down/);
  assert.equal(harness.state.ui.appZoomPercent, 100, 'rolls back to the persisted value, not 110');
});

test('lifecycle appearance utils render escaped select options', () => {
  const { utils } = createHarness();

  const markup = utils.buildSelectOptionMarkup([
    { id: 'safe', label: 'Safe' },
    { id: 'x<y', label: 'Less < More' },
  ], 'x<y');

  assert.match(markup, /value="safe"/);
  assert.match(markup, /value="x&lt;y" selected/);
  assert.match(markup, /Less &lt; More/);
});

test('appearance changes refresh composer and sprite layout after CSS variables apply', () => {
  const harness = createHarness();

  const applied = harness.utils.applyAppearancePreferences({
    paletteId: 'midnight',
    spriteHoloId: 'off',
  }, { persist: false });

  assert.equal(applied.applied, true);
  assert.deepEqual(harness.layoutCalls, [
    ['composer'],
    ['sprite'],
  ]);
});

test('appearance projection remains unchanged when atomic persistence fails', () => {
  const harness = createHarness({
    callbacks: {
      saveStoredAppearancePreferences() {
        throw new Error('quota exceeded');
      },
    },
  });
  const previous = harness.state.ui.appearance;

  const applied = harness.utils.applyAppearancePreferences({ paletteId: 'signal' });

  assert.equal(applied, previous);
  assert.equal(harness.state.ui.appearance, previous);
  assert.deepEqual(harness.layoutCalls, []);
  assert.equal(harness.logs[0].event, 'appearance.preferences_write_failed');
});
