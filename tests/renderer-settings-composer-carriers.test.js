'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

async function createHarness(t) {
  let settings;
  let renderPasses = 0;
  let catalog = { available: true, data: [{ id: 'gpt-test' }] };
  const { window, dispose } = await loadRendererApp({
    models: { list: async () => catalog },
    beforeRendererBoot(win) {
      const createComposition = win.rendererAppControllerComposition.createControllerComposition;
      win.rendererAppControllerComposition.createControllerComposition = (ctx) => {
        const result = createComposition(ctx);
        settings = result.settingsShellController;
        return result;
      };
      const createChrome = win.rendererRenderPipelineChromeUtils.createChromePipeline;
      win.rendererRenderPipelineChromeUtils.createChromePipeline = (deps) => {
        const chrome = createChrome(deps);
        const renderAll = chrome.renderAll;
        chrome.renderAll = (...args) => { renderPasses += 1; return renderAll(...args); };
        return chrome;
      };
    },
  });
  t.after(dispose);
  await waitForUi(window, 50);
  const state = window.__rendererState;
  catalog = state.modelList = {
    available: true,
    active_model: 'gpt-5-mini',
    data: [{ id: 'gpt-5', engine_type: 'openai' }, { id: 'gpt-5-mini', engine_type: 'openai' }],
  };
  state.status = { ...state.status, model: 'gpt-5-mini', engine: 'openai' };
  state.runtimeDraft.preferredModel = 'gpt-5';
  state.runtimeDraft.reasoningEffort = 'high';
  const modelSelect = window.document.getElementById('composerModelSelect');
  const effortSelect = window.document.getElementById('composerEffortSelect');
  modelSelect.replaceChildren(new window.Option('Stale model', 'stale'));
  modelSelect.dataset.backendModel = 'stale';
  modelSelect.dataset.backendEngineType = 'stale';
  effortSelect.dataset.requestedEffort = 'low';
  effortSelect.value = 'low';
  window.reasoningEffortControls.applyModelCatalog(catalog);
  await waitForUi(window, 0);
  effortSelect.append(new window.Option('High', 'high'));
  const settingsView = window.document.getElementById('settingsView');
  const mutations = [];
  // The outer view's visibility attributes belong to layout, not its page contents.
  const observer = new window.MutationObserver((records) => {
    mutations.push(...records.filter((record) => record.target !== settingsView));
  });
  observer.observe(settingsView, { subtree: true, childList: true, attributes: true, characterData: true });
  t.after(() => observer.disconnect());
  return {
    window, state, settings, mutations,
    async renderAll() {
      const before = renderPasses;
      await window.jennyShell.__emitBackendStatus({ ...state.backend, phase: 'starting' });
      await waitForUi(window, 0);
      assert.equal(renderPasses - before, 1, 'backend status push reaches one renderAll pass');
    },
    assertCarriers() {
      assert.deepEqual(Array.from(modelSelect.options, (option) => option.value), ['', 'gpt-5', 'gpt-5-mini']);
      assert.equal(modelSelect.value, 'gpt-5');
      assert.equal(modelSelect.dataset.backendModel, 'gpt-5-mini');
      assert.equal(modelSelect.dataset.backendEngineType, 'openai');
      assert.equal(effortSelect.dataset.requestedEffort, 'high');
      assert.equal(effortSelect.value, 'high');
    },
  };
}

test('renderAll on chat refreshes composer carriers without painting Settings', async (t) => {
  const h = await createHarness(t);
  assert.equal(h.state.ui.activeView, 'chat');
  await h.renderAll();
  h.assertCarriers();
  assert.equal(h.mutations.length, 0, 'chat renderAll must not mutate Settings page contents');
});

test('renderAll on Settings paints the page and refreshes composer carriers', async (t) => {
  const h = await createHarness(t);
  h.state.ui.activeView = 'settings';
  await h.renderAll();
  h.assertCarriers();
  assert.ok(h.mutations.length > 0, 'Settings renderAll paints page contents');
});

test('direct renderSettings on chat with the group unloaded refreshes the carriers and paints no page', async (t) => {
  const h = await createHarness(t);
  assert.equal(h.state.ui.activeView, 'chat');
  h.settings.renderSettings();
  await waitForUi(h.window, 0);
  h.assertCarriers();
  assert.equal(h.mutations.length, 0, 'no Settings page to paint until the group loads');
});

test('direct renderSettings on chat with the page loaded paints the page and refreshes carriers', async (t) => {
  const h = await createHarness(t);
  assert.equal(h.state.ui.activeView, 'chat');
  await h.settings.ensureSettingsPage();
  h.settings.renderSettings();
  await waitForUi(h.window, 0);
  h.assertCarriers();
  assert.ok(h.mutations.length > 0, 'direct renderSettings paints page contents');
});

test('a Force-local change shows on the composer posture row at the next chat render pass', async (t) => {
  const h = await createHarness(t);
  const doc = h.window.document;
  const row = doc.getElementById('composerChatPosture');
  const dot = doc.getElementById('composerChatPostureDot');
  assert.equal(h.state.ui.activeView, 'chat');
  h.state.offline = { ...h.state.offline, resolved: true, mode: 'local_only', localChatReady: true, localVisionReady: false, preferredLocalModel: 'local-coder' };
  await h.renderAll();
  assert.equal(row.hidden, false, 'Force local on: the posture row shows');
  assert.equal(dot.dataset.posture, 'local-only-ready');
  assert.match(doc.getElementById('composerChatPostureText').textContent, /local-coder/);
  h.state.offline = { ...h.state.offline, mode: 'disabled' };
  await h.renderAll();
  assert.equal(row.hidden, true, 'Force local off: the row hides on the next pass');
  assert.equal(dot.dataset.posture, 'local');
  assert.equal(h.mutations.length, 0, 'the posture lives in the composer, not the Settings page');
});

test('renderComposerCarriers alone leaves Settings untouched', async (t) => {
  const h = await createHarness(t);
  h.settings.renderComposerCarriers();
  await waitForUi(h.window, 0);
  h.assertCarriers();
  assert.equal(h.mutations.length, 0, 'carrier-only render must not mutate Settings page contents');
});
