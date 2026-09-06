'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createSettingsEventBindings } = require('../renderer/chat/renderer-chat-event-settings-bindings.js');

function buildHarness(t, { currentEffort, modelListData = [] }) {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="toastViewport"></div>
    <select id="composerModelSelect">
      <option value="qwen3.8:27b-ud-iq3-s" data-engine-type="ollama">Qwen 3.8</option>
      <option value="ornith15:9b-q6-256k" data-engine-type="ollama">Ornith 1.5</option>
      <option value="gpt-5.5" data-engine-type="chatgpt">GPT-5.5</option>
    </select>
    <select id="composerEffortSelect"><option value="default">Use default</option></select>
    <button id="composerSettingsButton"></button>
    <button id="openComposerSettingsViewButton"></button>
    <div id="composerRunModeSlot"></div>
  </body>`);
  const previousDocument = global.document;
  global.document = dom.window.document;
  t.after(() => {
    global.document = previousDocument;
    dom.window.close();
  });
  const doc = dom.window.document;
  const patches = [];
  const bindings = createSettingsEventBindings({
    toastViewport: doc.getElementById('toastViewport'),
    composerModelSelect: doc.getElementById('composerModelSelect'),
    composerEffortSelect: doc.getElementById('composerEffortSelect'),
    composerSettingsButton: doc.getElementById('composerSettingsButton'),
    openComposerSettingsViewButton: doc.getElementById('openComposerSettingsViewButton'),
    state: { ui: {}, modelList: { data: modelListData } },
    TOAST_SOURCE: { memory: 'memory', composerAction: 'composer' },
    ACTIVITY_SCOPE: { composerPreferredModel: 'model', composerReasoningEffort: 'effort', composerRunMode: 'run' },
    dismissToast() {},
    showShellErrorToast() {},
    showToastMessage() {},
    toErrorMessage(error) { return String(error); },
    getRuntimePreferenceSnapshot: () => ({}),
    runRuntimePreferenceActivity(activity) {
      patches.push(activity);
      return Promise.resolve({});
    },
    getCurrentRuntimePreferences: () => ({ reasoningEffort: currentEffort }),
    showComposerActionError() {},
    closeComposerPopover() {},
    openComposerPopover() {},
    setActiveView() {},
    setComposerStatusNotice() {},
    clearComposerStatusNotice() {},
    toastActionHandlers: new Map(),
  });
  bindings.bindSettingsEvents((element, type, handler) => {
    element?.addEventListener?.(type, handler);
  }, {});
  return {
    patches,
    switchModel(value, { omitEngineType = false } = {}) {
      const select = doc.getElementById('composerModelSelect');
      select.value = value;
      if (omitEngineType) delete select.selectedOptions[0].dataset.engineType;
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    },
  };
}

test('model swap to a non-graded Ollama model clamps the stale effort in the same patch', (t) => {
  // Regression for the CMP-AI-0005 leak (owner-hit 2026-08-31): a graded level
  // chosen while qwen3.8 was active must be re-normalized inside the SAME
  // preference patch as the model change — the reasoning-effort-controls
  // reconcile persists via a synthetic change event that is dropped while the
  // effort control is aria-disabled mid-save.
  const harness = buildHarness(t, { currentEffort: 'medium' });
  harness.switchModel('ornith15:9b-q6-256k');
  assert.equal(harness.patches.length, 1);
  assert.deepEqual(harness.patches[0].patch, {
    preferredModel: 'ornith15:9b-q6-256k',
    reasoningEffort: 'default',
  });
  assert.deepEqual(harness.patches[0].scopes, ['model', 'effort']);
});

test('model swap keeps a graded effort when the target model supports it', (t) => {
  const harness = buildHarness(t, { currentEffort: 'medium' });
  harness.switchModel('qwen3.8:27b-ud-iq3-s');
  assert.deepEqual(harness.patches[0].patch, { preferredModel: 'qwen3.8:27b-ud-iq3-s' });
  assert.deepEqual(harness.patches[0].scopes, ['model']);
  harness.switchModel('gpt-5.5');
  assert.deepEqual(harness.patches[1].patch, { preferredModel: 'gpt-5.5' });
});

test('model swap with a default effort patches only the model', (t) => {
  const harness = buildHarness(t, { currentEffort: 'default' });
  harness.switchModel('ornith15:9b-q6-256k');
  assert.deepEqual(harness.patches[0].patch, { preferredModel: 'ornith15:9b-q6-256k' });
});

test('model swap resolves a missing option engine type from the model catalog', (t) => {
  const harness = buildHarness(t, {
    currentEffort: 'high',
    modelListData: [{ id: 'ornith15:9b-q6-256k', engine_type: 'ollama' }],
  });
  harness.switchModel('ornith15:9b-q6-256k', { omitEngineType: true });
  assert.deepEqual(harness.patches[0].patch, {
    preferredModel: 'ornith15:9b-q6-256k',
    reasoningEffort: 'default',
  });
  assert.deepEqual(harness.patches[0].scopes, ['model', 'effort']);
});
