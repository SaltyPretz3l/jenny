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

test('lifecycle appearance utils persist chat zoom and roll back on failure', async () => {
  const harness = createHarness();

  assert.equal(await harness.utils.applyChatZoomPercent(120), 125);
  assert.deepEqual(harness.layoutCalls.map((entry) => entry[0]), ['offset', 'sprite', 'offset', 'sprite']);

  harness.windowObject.jennyShell.chatUi.updateSettings = async () => {
    throw new Error('storage unavailable');
  };
  await assert.rejects(() => harness.utils.applyChatZoomPercent(150), /storage unavailable/);
  assert.equal(harness.state.ui.chatZoomPercent, 125);
  assert.equal(harness.logs[0].event, 'chat.zoom_update_failed');
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

test('appearance changes refresh composer and sprite holo eligibility after CSS variables apply', () => {
  const harness = createHarness();

  const applied = harness.utils.applyAppearancePreferences({
    paletteId: 'midnight',
    spriteHoloId: 'off',
  }, { persist: false });

  assert.equal(applied.applied, true);
  assert.deepEqual(harness.layoutCalls, [
    ['composer'],
    [
      'sprite',
      undefined,
      undefined,
      { refreshHolo: true },
    ],
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
