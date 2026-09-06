'use strict';

// Bundled Engine Onboarding v1 slot B, Steps 4-6 — Settings > Models >
// "Model library" group (model_management_ui). RED-FIRST: covers flag-off
// parity, listing, in-use guard, remove-confirm-delete-refresh, pull wiring
// (progress + cancel + completion refresh), and structured delete-error
// surfacing on the status line.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createModelLibraryController } = require('../renderer/shell/renderer-model-library');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function makeDom() {
  // The nav button precedes the card and carries the SAME
  // data-settings-section attribute (as in the real app, where the
  // registry-driven nav renders one item per section) — the group must mount
  // into the CARD, never the nav.
  return new JSDOM(`
    <!doctype html>
    <html>
      <body>
        <nav id="settingsNav">
          <button type="button" data-settings-section="models">Models</button>
        </nav>
        <section class="settings-card" data-settings-section="models">
          <div class="settings-group" role="group" aria-labelledby="modelsRuntimeHeading">
            <h4 class="settings-group-heading" id="modelsRuntimeHeading">Runtime model</h4>
          </div>
        </section>
      </body>
    </html>
  `, { pretendToBeVisual: true, url: 'http://localhost/' });
}

function makeState(overrides) {
  return {
    features: { featureFlags: { model_management_ui: true } },
    status: { model: '' },
    modelList: { data: [] },
    offline: { preferredLocalModel: '' },
    ...overrides,
  };
}

function makeSetupServiceStub(overrides) {
  return {
    startOllamaPull: async () => ({ requestId: 'req-1', status: 'running' }),
    cancelOllamaPull: async () => ({ cancelled: true }),
    subscribePullProgress: () => () => {},
    ...overrides,
  };
}

function createHarness(t, { state, setupService, windowExtras, controllerExtras } = {}) {
  const dom = makeDom();
  const windowRef = Object.assign(dom.window, windowExtras || {});
  const controller = createModelLibraryController({
    state: state || makeState(),
    windowRef,
    documentRef: dom.window.document,
    appendClientLog: () => {},
    refreshModelPickers: () => {},
    setupService: setupService || makeSetupServiceStub(),
    ...(controllerExtras || {}),
  });
  // House rule: dispose the controller, never dom.window.close() (kills
  // pending jsdom timers mid-flight and masks disposal bugs).
  t.after(() => controller.dispose());
  return { dom, controller, windowRef };
}

test('flag OFF renders nothing (parity with today\'s Settings > Models)', (t) => {
  const state = makeState({ features: { featureFlags: { model_management_ui: false } } });
  const { dom, controller } = createHarness(t, { state });
  controller.render();
  assert.equal(dom.window.document.getElementById('modelLibraryGroup'), null);
});

test('post-hydration feature activation mounts and populates the library', async (t) => {
  const state = makeState({ features: { featureFlags: { model_management_ui: false } }, modelList: null });
  const { dom, controller } = createHarness(t, {
    state,
    windowExtras: {
      jennyShell: { models: { list: async () => ({ data: [{ id: 'hydrated-model' }] }) } },
    },
  });
  controller.bind();
  assert.equal(dom.window.document.getElementById('modelLibraryGroup'), null);
  state.features.featureFlags.model_management_ui = true;
  await controller.syncFeatureState();
  assert.ok(dom.window.document.querySelector('[data-model-id="hydrated-model"]'));
});

test('flag ON renders the group with listed models', (t) => {
  const state = makeState({
    modelList: { data: [{ id: 'qwen2.5:3b', size: 2_000_000_000 }, { id: 'llama3.2:3b' }] },
  });
  const { dom, controller } = createHarness(t, { state });
  controller._view.models = require('../renderer/shell/renderer-model-library').normalizeModelEntries(state.modelList);
  controller.render();
  const group = dom.window.document.getElementById('modelLibraryGroup');
  assert.ok(group, 'group should render when flag is on');
  assert.match(group.textContent, /Model library/);
  assert.match(group.textContent, /qwen2\.5:3b/);
  assert.match(group.textContent, /llama3\.2:3b/);
  assert.match(group.textContent, /1\.9 GB/);
  assert.equal(group.querySelector('[data-model-library-action="load"]').getAttribute('title'), 'Load this model into the runtime');
});

test('model rows hide tuning for engines that own provider generation controls', (t) => {
  const state = makeState({
    modelList: { data: [
      { id: 'local-model', engine_type: 'ollama' },
      { id: 'provider-model', engine_type: 'codex-cli' },
    ] },
  });
  const { dom, controller } = createHarness(t, { state });
  controller._view.models = require('../renderer/shell/renderer-model-library').normalizeModelEntries(state.modelList);
  controller.render();
  assert.ok(dom.window.document.querySelector('[data-model-id="local-model"] [data-model-library-action="tune"]'));
  assert.equal(dom.window.document.querySelector('[data-model-id="local-model"] [data-model-library-action="tune"]').getAttribute('title'), 'Open per-model tuning parameters');
  assert.equal(dom.window.document.querySelector('[data-model-id="provider-model"] [data-model-library-action="tune"]'), null);
  assert.ok(dom.window.document.querySelector('[data-model-id="local-model"] [data-model-library-action="select-local-inference"]'));
  assert.equal(dom.window.document.querySelector('[data-model-id="local-model"] [data-model-library-action="select-local-inference"]').getAttribute('title'), 'Set as the model used for local inference');
  assert.equal(dom.window.document.querySelector('[data-model-id="provider-model"] [data-model-library-action="select-local-inference"]'), null);
});

test('Model Library acknowledges local inference role selection before projecting it', async (t) => {
  const state = makeState({ modelList: { data: [{ id: 'qwen2.5:3b', engine_type: 'ollama' }] } });
  const writes = [];
  const { dom, controller } = createHarness(t, {
    state,
    windowExtras: {
      jennyShell: {
        offline: { updateSettings: async (patch) => { writes.push(patch); return { ...state.offline, ...patch }; } },
      },
    },
  });
  controller._view.models = require('../renderer/shell/renderer-model-library').normalizeModelEntries(state.modelList);
  controller.bind(); controller.render();
  dom.window.document.querySelector('[data-model-library-action="select-local-inference"]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(state.offline.preferredLocalModel, '', 'selection stays unchanged before acknowledgement');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(writes, [{ preferredLocalModel: 'qwen2.5:3b' }]);
  assert.equal(state.offline.preferredLocalModel, 'qwen2.5:3b');
  assert.match(dom.window.document.getElementById('modelLibraryGroup').textContent, /Local inference/);
});

test('failed local inference role selection keeps the previous model and reports the failure', async (t) => {
  const state = makeState({
    modelList: { data: [
      { id: 'old:1', engine_type: 'ollama' },
      { id: 'new:1', engine_type: 'ollama' },
    ] },
    offline: { preferredLocalModel: 'old:1' },
  });
  const { dom, controller } = createHarness(t, {
    state,
    windowExtras: { jennyShell: { offline: { updateSettings: async () => { throw new Error('write blocked'); } } } },
  });
  controller._view.models = require('../renderer/shell/renderer-model-library').normalizeModelEntries(state.modelList);
  controller.bind(); controller.render();
  dom.window.document.querySelector('[data-model-id="new:1"] [data-model-library-action="select-local-inference"]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.offline.preferredLocalModel, 'old:1');
  assert.match(dom.window.document.querySelector('.model-library-status').textContent, /write blocked/i);
});

test('Model Library hides local inference selection without verified Ollama or vLLM provenance', (t) => {
  const state = makeState({
    modelList: { data: [
      { id: 'gpt-5.5' },
      { id: 'remote-gguf', engine_type: 'openai-compatible' },
      { id: 'catalog-local', engine_type: 'ollama' },
    ] },
  });
  const { dom, controller } = createHarness(t, { state });
  controller._view.models = require('../renderer/shell/renderer-model-library').normalizeModelEntries(state.modelList);
  controller.render();
  assert.equal(dom.window.document.querySelector('[data-model-id="gpt-5.5"] [data-model-library-action="select-local-inference"]'), null);
  assert.equal(dom.window.document.querySelector('[data-model-id="remote-gguf"] [data-model-library-action="select-local-inference"]'), null);
  assert.ok(dom.window.document.querySelector('[data-model-id="catalog-local"] [data-model-library-action="select-local-inference"]'));
});

test('state-or-action: the designated model shows only the tag, other eligible models only the action', (t) => {
  const state = makeState({
    modelList: { data: [
      { id: 'chosen:1', engine_type: 'ollama' },
      { id: 'other:1', engine_type: 'ollama' },
    ] },
    offline: { preferredLocalModel: 'chosen:1' },
  });
  const { dom, controller } = createHarness(t, { state });
  controller._view.models = require('../renderer/shell/renderer-model-library').normalizeModelEntries(state.modelList);
  controller.render();
  const doc = dom.window.document;
  assert.equal(
    doc.querySelector('[data-model-id="chosen:1"] [data-model-library-action="select-local-inference"]'),
    null,
    'designated model must not render the select action alongside its tag',
  );
  const tags = doc.querySelector('[data-model-id="chosen:1"] .model-library-row-tags');
  assert.ok(tags, 'designated model carries the status-tag cluster');
  assert.match(tags.textContent, /Local inference/);
  const otherAction = doc.querySelector('[data-model-id="other:1"] [data-model-library-action="select-local-inference"]');
  assert.ok(otherAction, 'non-designated eligible model keeps the select action');
  assert.equal(otherAction.disabled, false, 'action is enabled when nothing is pending');
  assert.equal(
    doc.querySelector('[data-model-id="other:1"] .model-library-row-tags'),
    null,
    'non-designated, non-loaded model renders no tag cluster',
  );
});

test('each model row exposes accessible Advanced timeout controls and persists Automatic reset', async (t) => {
  const state = makeState({ modelList: { data: [{ id: 'qwen2.5:3b' }] } });
  const updates = [];
  const updateRequest = deferred();
  const { dom, controller } = createHarness(t, {
    state,
    windowExtras: {
      jennyShell: {
        modelTuning: {
          getState: async () => ({ streamInactivitySecondsByModel: { 'qwen2.5:3b': 180 } }),
          update: (payload) => {
            updates.push(payload);
            return updateRequest.promise;
          },
        },
      },
    },
  });
  controller._view.models = require('../renderer/shell/renderer-model-library').normalizeModelEntries(state.modelList);
  controller._view.modelTuning = { streamInactivitySecondsByModel: { 'qwen2.5:3b': 180 } };
  controller.bind();
  controller.render();
  const details = dom.window.document.querySelector('.model-library-advanced');
  details.open = true;
  assert.equal(details.querySelector('summary').getAttribute('aria-label'), 'Advanced settings for qwen2.5:3b');
  const select = details.querySelector('[data-model-library-action="stream-timeout"]');
  assert.equal(select.getAttribute('aria-label'), 'Stream inactivity timeout for qwen2.5:3b');
  assert.equal(select.value, '180');
  select.focus();
  select.value = '';
  select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  const pendingDetails = dom.window.document.querySelector('.model-library-advanced');
  const pendingSelect = pendingDetails.querySelector('[data-model-library-action="stream-timeout"]');
  assert.equal(pendingDetails.open, true);
  assert.equal(pendingSelect.value, '');
  assert.equal(dom.window.document.activeElement, pendingSelect);
  assert.match(pendingDetails.querySelector('.model-library-apply-note').textContent, /Saving/);
  updateRequest.resolve({
    status: 'applied', reason: 'saved_for_next_runtime', runtimeAcknowledged: false,
    state: { streamInactivitySecondsByModel: {} },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(updates, [{ modelId: 'qwen2.5:3b', streamInactivitySeconds: null }]);
  assert.match(controller._view.statusMessage, /next runtime initialization/i);
});

test('Advanced timeout control displays an override stored under an Ollama alias', (t) => {
  const state = makeState({ modelList: { data: [{ id: 'Gemma3:latest' }] } });
  const { dom, controller } = createHarness(t, { state });
  controller._view.models = require('../renderer/shell/renderer-model-library').normalizeModelEntries(state.modelList);
  controller._view.modelTuning = { streamInactivitySecondsByModel: { gemma3: 60 } };
  controller.render();

  assert.equal(
    dom.window.document.querySelector('[data-model-library-action="stream-timeout"]').value,
    '60'
  );
});

test('stream timeout failure restores the prior value and redacts local paths', async (t) => {
  const state = makeState({ modelList: { data: [{ id: 'qwen2.5:3b' }] } });
  const { dom, controller } = createHarness(t, {
    state,
    windowExtras: { jennyShell: { modelTuning: {
      getState: async () => ({ streamInactivitySecondsByModel: { 'qwen2.5:3b': 180 } }),
      update: () => { throw new Error('C:\\private\\model-config.json failed'); },
    } } },
  });
  controller._view.models = require('../renderer/shell/renderer-model-library').normalizeModelEntries(state.modelList);
  controller._view.modelTuning = { streamInactivitySecondsByModel: { 'qwen2.5:3b': 180 } };
  controller.bind();
  controller.render();
  const select = dom.window.document.querySelector('[data-model-library-action="stream-timeout"]');
  select.value = '60';
  select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(controller._view.modelTuning.streamInactivitySecondsByModel['qwen2.5:3b'], 180);
  assert.doesNotMatch(controller._view.statusMessage, /private|model-config/);
  assert.match(controller._view.statusMessage, /local path/);
});

test('loaded row exposes Unload while other installed rows expose Switch and Remove', (t) => {
  const state = makeState({
    status: { model: 'qwen2.5:3b' },
    modelList: { data: [{ id: 'qwen2.5:3b' }, { id: 'llama3.2:3b' }] },
  });
  const { dom, controller } = createHarness(t, { state });
  controller._view.models = require('../renderer/shell/renderer-model-library').normalizeModelEntries(state.modelList);
  controller.render();
  const activeRow = dom.window.document.querySelector('[data-model-id="qwen2.5:3b"]');
  const otherRow = dom.window.document.querySelector('[data-model-id="llama3.2:3b"]');
  assert.equal(activeRow.querySelector('[data-model-library-action="remove"]'), null);
  assert.ok(activeRow.querySelector('[data-model-library-action="unload"]'));
  assert.equal(activeRow.querySelector('[data-model-library-action="unload"]').getAttribute('aria-label'), 'Unload qwen2.5:3b');
  assert.equal(activeRow.querySelector('[data-model-library-action="unload"]').getAttribute('title'), 'Unload this model from the runtime');
  assert.match(activeRow.textContent, /Loaded/);
  assert.equal(otherRow.querySelector('[data-model-library-action="load"]').textContent, 'Switch');
  assert.equal(otherRow.querySelector('[data-model-library-action="load"]').getAttribute('aria-label'), 'Switch to llama3.2:3b');
  assert.equal(otherRow.querySelector('[data-model-library-action="load"]').getAttribute('title'), 'Switch the active model to this one');
  assert.ok(otherRow.querySelector('[data-model-library-action="remove"]'));
  assert.equal(otherRow.querySelector('[data-model-library-action="remove"]').getAttribute('title'), 'Delete this model from disk (cannot be undone)');
});

test('row lifecycle actions preserve engine provenance and refresh truthful loaded state', async (t) => {
  const state = makeState({
    status: { model: 'old-model' },
    modelList: {
      active_model: 'old-model',
      data: [{ id: 'old-model', engine_type: 'ollama' }, { id: 'new-model', engine_type: 'vllm' }],
    },
  });
  const loadRequest = deferred();
  const loadCalls = [];
  let unloadCalls = 0;
  const windowExtras = {
    jennyShell: {
      models: {
        load(payload) {
          loadCalls.push(payload);
          return loadRequest.promise.then(() => {
            state.status.model = 'new-model';
            return { status: 'ok', model: 'new-model' };
          });
        },
        unload: async () => {
          unloadCalls += 1;
          state.status.model = '';
          return { status: 'ok', model: '' };
        },
        list: async () => ({ active_model: state.status.model, data: state.modelList.data }),
      },
    },
  };
  const { dom, controller } = createHarness(t, { state, windowExtras });
  controller._view.models = require('../renderer/shell/renderer-model-library').normalizeModelEntries(state.modelList);
  controller.bind();
  controller.render();

  dom.window.document.querySelector('[data-model-id="new-model"] [data-model-library-action="load"]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await Promise.resolve();
  assert.deepEqual(loadCalls, [{ model: 'new-model', engine_type: 'vllm' }]);
  assert.match(dom.window.document.querySelector('.model-library-status').textContent, /Switching/);
  loadRequest.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(dom.window.document.querySelector('.model-library-status').textContent, /Switched/);
  assert.ok(dom.window.document.querySelector('[data-model-id="new-model"] [data-model-library-action="unload"]'));

  dom.window.document.querySelector('[data-model-id="new-model"] [data-model-library-action="unload"]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(unloadCalls, 1);
  assert.match(dom.window.document.querySelector('.model-library-status').textContent, /unloaded/i);
});

test('failed row switch clears pending state and keeps the prior loaded model truthful', async (t) => {
  const state = makeState({
    status: { model: 'old-model' },
    modelList: { active_model: 'old-model', data: [{ id: 'old-model' }, { id: 'new-model' }] },
  });
  const { dom, controller } = createHarness(t, {
    state,
    windowExtras: {
      jennyShell: {
        models: {
          load: async () => { throw new Error('Engine refused the requested model.'); },
          list: async () => state.modelList,
        },
      },
    },
  });
  controller._view.models = require('../renderer/shell/renderer-model-library').normalizeModelEntries(state.modelList);
  controller.bind();
  controller.render();
  dom.window.document.querySelector('[data-model-id="new-model"] [data-model-library-action="load"]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller._view.pendingRuntimeAction, '');
  assert.match(controller._view.statusMessage, /Engine refused/);
  assert.ok(dom.window.document.querySelector('[data-model-id="old-model"] [data-model-library-action="unload"]'));
});

test('hung row load is UI-bounded and reports an indeterminate timeout without changing loaded state', async (t) => {
  const state = makeState({
    status: { model: 'old-model' },
    modelList: { active_model: 'old-model', data: [{ id: 'old-model' }, { id: 'new-model' }] },
  });
  const pendingLoad = deferred();
  const { dom, controller } = createHarness(t, {
    state,
    controllerExtras: { runtimeActionTimeoutMs: 5 },
    windowExtras: {
      jennyShell: {
        models: { load: () => pendingLoad.promise, list: async () => state.modelList },
      },
    },
  });
  controller._view.models = require('../renderer/shell/renderer-model-library').normalizeModelEntries(state.modelList);
  controller.bind();
  controller.render();
  dom.window.document.querySelector('[data-model-id="new-model"] [data-model-library-action="load"]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(controller._view.pendingRuntimeAction, '');
  assert.match(controller._view.statusMessage, /timed out/i);
  assert.ok(dom.window.document.querySelector('[data-model-id="old-model"] [data-model-library-action="unload"]'));
});

test('Remove flows through confirm -> models.delete -> list refresh', async (t) => {
  const state = makeState({
    modelList: { data: [{ id: 'llama3.2:3b' }] },
  });
  let deleteCalledWith = null;
  let listCalls = 0;
  const windowExtras = {
    jennyShell: {
      models: {
        delete: async (payload) => {
          deleteCalledWith = payload;
          return { status: 'deleted', model: payload.model };
        },
        list: async () => {
          listCalls += 1;
          return { data: [] };
        },
      },
    },
  };
  const { dom, controller } = createHarness(t, { state, windowExtras });
  controller._view.models = require('../renderer/shell/renderer-model-library').normalizeModelEntries(state.modelList);
  controller.bind();
  controller.render();

  const removeBtn = dom.window.document.querySelector('[data-model-library-action="remove"]');
  removeBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

  // Confirm modal should now be present.
  const confirmBtn = dom.window.document.querySelector('[data-step-modal="model-library-confirm-delete"] [data-step-modal-action="confirm"]');
  assert.ok(confirmBtn, 'confirm dialog should render before delete');
  confirmBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(deleteCalledWith, { model: 'llama3.2:3b' });
  // Two list calls: the bind()-time initial population + the post-delete refresh.
  assert.equal(listCalls, 2);
});

test('bind() populates the library list at startup without a manual refresh', async (t) => {
  const state = makeState({ modelList: null });
  let listCalls = 0;
  const windowExtras = {
    jennyShell: {
      models: {
        list: async () => {
          listCalls += 1;
          return { data: [{ id: 'qwen2.5:3b', size: 2147483648 }] };
        },
      },
    },
  };
  const { dom, controller } = createHarness(t, { state, windowExtras });
  controller.bind();
  controller.render();

  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(listCalls, 1);
  const row = dom.window.document.querySelector('.model-library-row[data-model-id="qwen2.5:3b"]');
  assert.ok(row, 'installed model should render from the bind()-time load');
  assert.match(row.textContent, /2 GB/);
});

test('pull wires progress events and cancel', async (t) => {
  const state = makeState({ modelList: { data: [] } });
  let capturedListener = null;
  let cancelCalledWith = null;
  const setupService = makeSetupServiceStub({
    startOllamaPull: async (payload) => ({ requestId: payload.requestId, status: 'running' }),
    subscribePullProgress: (listener) => {
      capturedListener = listener;
      return () => { capturedListener = null; };
    },
    cancelOllamaPull: async (payload) => {
      cancelCalledWith = payload;
      return { cancelled: true };
    },
  });
  const { dom, controller } = createHarness(t, { state, setupService });
  controller.bind();
  controller.render();

  const input = dom.window.document.getElementById('modelLibraryPullInput');
  input.value = 'qwen2.5:3b';
  const pullBtn = dom.window.document.querySelector('[data-model-library-action="pull"]');
  pullBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(typeof capturedListener === 'function', 'controller should subscribe to pull progress');
  capturedListener({ requestId: controller._view.pullRequestId, status: 'running', percent: 42, bytes: 100, totalBytes: 200 });
  assert.equal(controller._view.pullPercent, 42);

  const cancelBtn = dom.window.document.querySelector('[data-model-library-action="cancel-pull"]');
  assert.ok(cancelBtn, 'cancel button should render while pulling');
  cancelBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(cancelCalledWith, 'cancelOllamaPull should be called');
});

test('pull completion triggers picker refresh', async (t) => {
  const state = makeState({ modelList: { data: [] } });
  let refreshCalls = 0;
  let capturedListener = null;
  const setupService = makeSetupServiceStub({
    startOllamaPull: async (payload) => ({ requestId: payload.requestId, status: 'running' }),
    subscribePullProgress: (listener) => {
      capturedListener = listener;
      return () => {};
    },
  });
  const windowExtras = {
    jennyShell: { models: { list: async () => ({ data: [{ id: 'qwen2.5:3b' }] }) } },
  };
  const dom = makeDom();
  t.after(() => dom.window.close());
  const windowRef = Object.assign(dom.window, windowExtras);
  const controller = createModelLibraryController({
    state,
    windowRef,
    documentRef: dom.window.document,
    appendClientLog: () => {},
    refreshModelPickers: () => { refreshCalls += 1; },
    setupService,
  });
  controller.bind();
  controller.render();

  const input = dom.window.document.getElementById('modelLibraryPullInput');
  input.value = 'qwen2.5:3b';
  const pullBtn = dom.window.document.querySelector('[data-model-library-action="pull"]');
  pullBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setImmediate(resolve));

  capturedListener({ requestId: controller._view.pullRequestId, status: 'completed', percent: 100 });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(refreshCalls >= 1, 'refreshModelPickers should be called on pull completion');
});

test('structured error results surface on the status line (model_in_use)', async (t) => {
  const state = makeState({ modelList: { data: [{ id: 'qwen2.5:3b' }] } });
  const windowExtras = {
    jennyShell: {
      models: {
        delete: async () => ({ status: 'failed', code: 'model_in_use', message: 'in use' }),
        list: async () => ({ data: [{ id: 'qwen2.5:3b' }] }),
      },
    },
  };
  const { dom, controller } = createHarness(t, { state, windowExtras });
  controller._view.models = require('../renderer/shell/renderer-model-library').normalizeModelEntries(state.modelList);
  controller.bind();
  controller.render();

  const removeBtn = dom.window.document.querySelector('[data-model-library-action="remove"]');
  removeBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  const confirmBtn = dom.window.document.querySelector('[data-step-modal="model-library-confirm-delete"] [data-step-modal-action="confirm"]');
  confirmBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const status = dom.window.document.querySelector('.model-library-status');
  assert.match(status.textContent, /currently loaded/i);
});

test('pull-already-in-progress structured result surfaces on the status line', async (t) => {
  const state = makeState({ modelList: { data: [] } });
  const setupService = makeSetupServiceStub({
    startOllamaPull: async () => ({ status: 'failed', error: 'A pull for "x" is already in progress.' }),
  });
  const { dom, controller } = createHarness(t, { state, setupService });
  controller.bind();
  controller.render();

  const input = dom.window.document.getElementById('modelLibraryPullInput');
  input.value = 'qwen2.5:3b';
  const pullBtn = dom.window.document.querySelector('[data-model-library-action="pull"]');
  pullBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const status = dom.window.document.querySelector('.model-library-status');
  assert.match(status.textContent, /already in progress/i);
});

test('in-use detection canonicalizes :latest suffix and case (review fix)', (t) => {
  const state = makeState({
    status: { model: 'gemma3' },
    modelList: { data: [{ id: 'Gemma3:latest' }, { id: 'gemma3:27b' }] },
  });
  const { dom, controller } = createHarness(t, { state });
  controller._view.models = require('../renderer/shell/renderer-model-library').normalizeModelEntries(state.modelList);
  controller.render();
  const divergentRow = dom.window.document.querySelector('[data-model-id="Gemma3:latest"]');
  assert.equal(divergentRow.querySelector('[data-model-library-action="remove"]'), null);
  assert.ok(divergentRow.querySelector('[data-model-library-action="unload"]'));
  const otherTagRow = dom.window.document.querySelector('[data-model-id="gemma3:27b"]');
  assert.ok(otherTagRow.querySelector('[data-model-library-action="remove"]'));
});

test('Escape and backdrop click dismiss the confirm modal (review fix)', (t) => {
  const state = makeState({ modelList: { data: [{ id: 'llama3.2:3b' }] } });
  const { dom, controller } = createHarness(t, { state });
  controller._view.models = require('../renderer/shell/renderer-model-library').normalizeModelEntries(state.modelList);
  controller.bind();
  controller.render();
  const doc = dom.window.document;
  const modalSelector = '[data-step-modal="model-library-confirm-delete"]';

  // Escape
  doc.querySelector('[data-model-library-action="remove"]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.ok(doc.querySelector(modalSelector), 'modal opens');
  doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(doc.querySelector(modalSelector), null, 'Escape dismisses');

  // Backdrop click (outside the dialog panel)
  doc.querySelector('[data-model-library-action="remove"]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  const backdrop = doc.querySelector(modalSelector);
  assert.ok(backdrop, 'modal re-opens');
  backdrop.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(doc.querySelector(modalSelector), null, 'backdrop click dismisses');

  // Clicking inside the dialog panel does NOT dismiss
  doc.querySelector('[data-model-library-action="remove"]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  doc.querySelector(modalSelector + ' .inv-step-modal-title')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.ok(doc.querySelector(modalSelector), 'panel click keeps the modal');
});

test('group mounts into the settings CARD, never the nav item with the same section attribute (regression)', (t) => {
  const state = makeState({ modelList: { data: [{ id: 'llama3.2:3b' }] } });
  const { dom, controller } = createHarness(t, { state });
  controller._view.models = require('../renderer/shell/renderer-model-library').normalizeModelEntries(state.modelList);
  controller.render();
  const doc = dom.window.document;
  const group = doc.getElementById('modelLibraryGroup');
  assert.ok(group, 'group renders');
  assert.equal(group.closest('#settingsNav'), null, 'group must not land in the nav');
  assert.ok(group.closest('.settings-card[data-settings-section="models"]'), 'group lands in the Models card');
});

test('syncFromState re-renders when state.modelList changes and no-ops when unchanged (review fix)', (t) => {
  const state = makeState({ modelList: { data: [{ id: 'llama3.2:3b' }] } });
  const { dom, controller } = createHarness(t, { state });
  controller._view.models = require('../renderer/shell/renderer-model-library').normalizeModelEntries(state.modelList);
  controller.render();
  const doc = dom.window.document;
  assert.ok(doc.querySelector('[data-model-id="llama3.2:3b"]'));

  // Unchanged state → same DOM node (no re-render churn / focus loss).
  const groupBefore = doc.getElementById('modelLibraryGroup');
  controller.syncFromState();
  assert.equal(doc.getElementById('modelLibraryGroup'), groupBefore, 'no-op when unchanged');

  // A background snapshot refresh replaced state.modelList → rows update.
  state.modelList = { data: [{ id: 'llama3.2:3b' }, { id: 'qwen2.5:3b' }] };
  controller.syncFromState();
  assert.ok(doc.querySelector('[data-model-id="qwen2.5:3b"]'), 'new model appears');
});

test('dedicated-section flag hands rendering between the new section and legacy group', (t) => {
  const sectionOnState = makeState({
    features: { featureFlags: { model_management_ui: true, model_library_section: true } },
    modelList: { data: [{ id: 'section-owned:1b' }] },
  });
  const sectionOn = createHarness(t, { state: sectionOnState });
  const modelsCard = sectionOn.dom.window.document.querySelector(
    '.settings-card[data-settings-section="models"]'
  );
  const untouchedMarkup = modelsCard.innerHTML;
  sectionOn.controller._view.models = require('../renderer/shell/renderer-model-library')
    .normalizeModelEntries(sectionOnState.modelList);
  sectionOn.controller.render();
  assert.equal(sectionOn.controller.isFeatureEnabled(), false);
  assert.equal(sectionOn.dom.window.document.getElementById('modelLibraryGroup'), null);
  assert.equal(modelsCard.innerHTML, untouchedMarkup);

  const sectionOffState = makeState({
    features: { featureFlags: { model_management_ui: true, model_library_section: false } },
    modelList: { data: [{ id: 'legacy-owned:1b' }] },
  });
  const sectionOff = createHarness(t, { state: sectionOffState });
  sectionOff.controller._view.models = require('../renderer/shell/renderer-model-library')
    .normalizeModelEntries(sectionOffState.modelList);
  sectionOff.controller.render();
  assert.equal(sectionOff.controller.isFeatureEnabled(), true);
  assert.ok(sectionOff.dom.window.document.getElementById('modelLibraryGroup'));
});
