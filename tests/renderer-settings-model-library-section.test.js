'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createModelLibrarySectionController,
} = require('../renderer/shell/renderer-settings-model-library-section');

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeDom() {
  return new JSDOM(`<!doctype html><body>
    <nav class="settings-nav">
      <button data-settings-section="models">Models</button>
      <button data-settings-section="modelLibrary">Model library</button>
    </nav>
    <section class="settings-card" data-settings-section="models">
      <div id="modelLibraryGroup">legacy rows</div>
    </section>
    <section class="settings-card settings-section-active" data-settings-section="modelLibrary">
      <div class="settings-card-header"><h3>Model library</h3></div>
      <div id="modelLibrarySectionToolbarHost"></div>
      <div class="settings-note model-library-section-status" aria-live="polite"></div>
      <div id="modelLibrarySectionHost"></div>
    </section>
  </body>`, { pretendToBeVisual: true, url: 'http://localhost/' });
}

function diagnostics() {
  return {
    hardwareProfile: {
      gpu: { type: 'cuda', name: 'Test GPU', vram_mb: 12000 },
      memory: { total_mb: 32000, available_mb: 24000 },
    },
    memory: { totalMb: 32000, availableMb: 24000 },
    modelRecommendations: [
      {
        pullTag: 'installed:1b',
        displayName: 'Installed model',
        tier: 'Fast',
        params: '1B',
        recommended: false,
        fitsInVram: true,
        vramRequiredMb: 1000,
      },
      {
        pullTag: 'recommended:3b',
        displayName: 'Recommended model',
        tier: 'Balanced',
        params: '3B',
        recommended: true,
        fitsInVram: true,
        vramRequiredMb: 3000,
      },
    ],
    catalogMeta: { version: 4 },
  };
}

function state(enabled = true) {
  return {
    features: {
      featureFlags: {
        model_management_ui: true,
        model_library_section: enabled,
      },
    },
    status: { model: '' },
    offline: { preferredLocalModel: '' },
    ui: { activeSettingsSection: enabled ? 'models' : 'modelLibrary' },
  };
}

function click(windowRef, element) {
  element.dispatchEvent(new windowRef.MouseEvent('click', { bubbles: true }));
}

function harness(t, options = {}) {
  const dom = makeDom();
  const { window: windowRef } = dom;
  const calls = [];
  const inventoryContextMenu = options.inventoryContextMenu || {
    show(config) { calls.push(['contextMenu.show', config]); },
    hide() {},
  };
  const currentState = options.state || state(true);
  const engine = { loadedModel: String(currentState.status?.model || '') };
  let featureChanged = null;
  let progressListener = null;
  const models = {
    async list() {
      calls.push(['list']);
      return { data: [{ id: 'installed:1b', size: 1024, engine_type: 'ollama' }] };
    },
    async listOllamaTags() {
      calls.push(['listOllamaTags']);
      return { data: [] };
    },
    async delete(payload) {
      calls.push(['delete', payload]);
      return { status: 'deleted' };
    },
    // The load/unload fakes mutate only engine-side state; the renderer's
    // state.status moves solely through the refreshModelPickers snapshot sync
    // below, mirroring the real seam (models.load cannot touch renderer state).
    async load(payload) {
      calls.push(['load', payload]);
      engine.loadedModel = typeof payload === 'string' ? payload : payload.model;
      return { status: 'ok', model: engine.loadedModel };
    },
    async unload() {
      calls.push(['unload']);
      engine.loadedModel = '';
      return { status: 'ok', model: '' };
    },
    ...(options.models || {}),
  };
  const offline = {
    async getDiagnostics() {
      calls.push(['getDiagnostics']);
      return diagnostics();
    },
    async updateSettings(payload) {
      calls.push(['updateSettings', payload]);
      return payload;
    },
    ...(options.offline || {}),
  };
  windowRef.jennyShell = {
    models,
    offline,
    engines: {
      async updateSettings(payload) {
        calls.push(['engineSettings', payload]);
        return { localEngines: { openaiCompatible: { managed: payload.managed } } };
      },
      ...(options.engines || {}),
    },
    llamaServer: {
      async listLocalGgufs() { return { ok: true, entries: [] }; },
      async getStatus() { return { ok: true, state: 'stopped' }; },
      async chooseLibraryFolder() { return { ok: true, picked: false, path: '' }; },
      ...(options.llamaServer || {}),
    },
    features: {
      onChanged(listener) {
        featureChanged = listener;
        return () => { featureChanged = null; };
      },
    },
  };
  const setupService = {
    subscribePullProgress(listener) {
      progressListener = listener;
      calls.push(['subscribePullProgress']);
      return () => calls.push(['unsubscribePullProgress']);
    },
    async startOllamaPull(payload) {
      calls.push(['startOllamaPull', payload]);
      return { requestId: payload.requestId, status: 'running' };
    },
    async cancelOllamaPull(payload) {
      calls.push(['cancelOllamaPull', payload]);
      return { cancelled: true };
    },
    ...(options.setupService || {}),
  };
  const controllerDeps = {
    state: currentState,
    windowRef,
    documentRef: windowRef.document,
    appendClientLog: (...entry) => calls.push(['log', ...entry]),
    refreshModelPickers: async () => {
      calls.push(['refreshModelPickers']);
      currentState.status = Object.assign({}, currentState.status, { model: engine.loadedModel });
    },
    openModelTuning: (...args) => calls.push(['tune', ...args]),
    openSettingsSection: (section) => calls.push(['section', section]),
    setupService,
    inventoryContextMenu,
  };
  if (options.showToast !== false) {
    controllerDeps.showToastMessage = (...args) => calls.push(['toast', ...args]);
  }
  const controller = createModelLibrarySectionController(controllerDeps);
  t.after(() => controller.dispose());
  return {
    controller,
    windowRef,
    document: windowRef.document,
    calls,
    engine,
    state: currentState,
    card: windowRef.document.querySelector('.settings-card[data-settings-section="modelLibrary"]'),
    nav: windowRef.document.querySelector('.settings-nav [data-settings-section="modelLibrary"]'),
    featureChanged: () => featureChanged,
    progressListener: () => progressListener,
  };
}

function contextMenuOptions(h) {
  return h.calls.slice().reverse().find((entry) => entry[0] === 'contextMenu.show')?.[1];
}

function contextMenuItem(h, label) {
  return contextMenuOptions(h)?.items.find((item) => item.label === label);
}

test('controller exposes state and engine-settings sync methods', (t) => {
  const h = harness(t);
  assert.equal(typeof h.controller.syncFromState, 'function');
  assert.equal(typeof h.controller.syncEngineSettings, 'function');
});

test('flag off hides the new section, falls back from an active section, makes no bridge calls, and leaves legacy markup untouched', async (t) => {
  const h = harness(t, { state: state(false) });
  h.controller.bind();
  await flush();

  assert.equal(h.nav.hidden, true);
  assert.equal(h.nav.getAttribute('data-feature-gated'), 'model_library_section');
  assert.equal(h.card.hidden, true);
  assert.equal(h.card.classList.contains('settings-section-active'), false);
  assert.deepEqual(h.calls, [['section', 'models']]);
  assert.equal(h.document.getElementById('modelLibraryGroup').textContent, 'legacy rows');
  assert.equal(h.document.getElementById('modelLibrarySectionHost').textContent, '');
});

test('flag on renders rows, filters through counted chips, and refreshes all isolated sources', async (t) => {
  const h = harness(t);
  h.controller.bind();
  await flush();

  assert.equal(h.card.hidden, false);
  assert.equal(h.document.querySelectorAll('.model-row').length, 2);
  assert.match(h.card.textContent, /Installed model/);
  assert.match(h.card.textContent, /Recommended model/);
  assert.equal(h.card.querySelectorAll('.model-library-filter-chips').length, 1);
  assert.equal(h.card.querySelector('[data-inv-chip="all"] .inv-chip-count').textContent, '2');
  assert.equal(h.card.querySelector('[data-inv-chip="installed"] .inv-chip-count').textContent, '1');
  assert.equal(h.card.querySelector('[data-inv-chip="recommended"] .inv-chip-count').textContent, '1');

  click(h.windowRef, h.card.querySelector('[data-inv-chip="recommended"]'));
  assert.equal(h.document.querySelectorAll('.model-row').length, 1);
  assert.match(h.card.textContent, /Recommended model/);
  assert.doesNotMatch(h.card.textContent, /Installed model/);

  const listCallsBefore = h.calls.filter((entry) => entry[0] === 'list').length;
  const refresh = h.card.querySelector('[data-model-library-section-action="refresh"]');
  assert.equal(refresh.textContent, '↻');
  assert.equal(refresh.getAttribute('aria-label'), 'Refresh catalog');
  click(h.windowRef, refresh);
  await flush();
  assert.equal(h.calls.filter((entry) => entry[0] === 'list').length, listCallsBefore + 1);
});

test('GGUF folders render only behind llama-server acceleration', async (t) => {
  const enabledState = state(true);
  enabledState.features.featureFlags.llama_server_acceleration = true;
  enabledState.localEngines = {
    openaiCompatible: { managed: { libraryRoots: ['D:\\models\\gguf'] } },
  };
  const enabledHarness = harness(t, { state: enabledState });
  enabledHarness.controller.bind();
  await flush();
  const host = enabledHarness.document.getElementById('modelLibraryFoldersHost');
  assert.ok(host);
  assert.match(host.textContent, /D:\\models\\gguf/);

  const disabledState = state(true);
  disabledState.features.featureFlags.llama_server_acceleration = false;
  disabledState.localEngines = {
    openaiCompatible: { managed: { libraryRoots: ['D:\\models\\must-not-render'] } },
  };
  const disabledHarness = harness(t, { state: disabledState });
  disabledHarness.controller.bind();
  await flush();
  assert.equal(disabledHarness.document.getElementById('modelLibraryFoldersHost'), null);
});

test('an installed non-catalog model with a fit estimate renders an estimated fit row', async (t) => {
  const h = harness(t, {
    models: {
      async list() {
        return {
          data: [
            { id: 'installed:1b', size: 1024, engine_type: 'ollama' },
            { id: 'private/estimated:q4', size: 4096, engine_type: 'ollama' },
          ],
        };
      },
    },
    offline: {
      async getDiagnostics() {
        return {
          ...diagnostics(),
          modelFitEstimates: [{
            modelId: 'private/estimated:q4',
            vramRequiredMb: 3000,
            fits: true,
            fitsInVram: true,
          }],
        };
      },
    },
  });
  h.controller.bind();
  await flush();

  const row = [...h.document.querySelectorAll('.model-row')]
    .find((el) => el.textContent.includes('private/estimated:q4'));
  assert.ok(row);
  assert.match(row.querySelector('.model-row-fit').textContent, /estimated/);
});

test('pull action starts one pull and patches only that row, leaving siblings and toolbar intact', async (t) => {
  const h = harness(t);
  h.controller.bind();
  await flush();

  const untouchedBefore = h.card.querySelector('[data-model-key="installed:1b"]');
  const targetBefore = h.card.querySelector('[data-model-key="recommended:3b"]');
  const toolbarBefore = h.document.getElementById('modelLibrarySectionToolbarHost').firstElementChild;
  const untouchedMarkup = untouchedBefore.outerHTML;
  click(h.windowRef, targetBefore.querySelector('[data-model-card-action="pull"]'));

  const untouchedAfter = h.card.querySelector('[data-model-key="installed:1b"]');
  const targetAfter = h.card.querySelector('[data-model-key="recommended:3b"]');
  assert.equal(untouchedAfter, untouchedBefore);
  assert.equal(untouchedAfter.outerHTML, untouchedMarkup);
  assert.notEqual(targetAfter, targetBefore);
  assert.equal(
    h.document.getElementById('modelLibrarySectionToolbarHost').firstElementChild,
    toolbarBefore
  );
  assert.ok(targetAfter.querySelector('[data-model-card-action="cancel"]'));
  assert.equal(h.calls.filter((entry) => entry[0] === 'startOllamaPull').length, 1);
});

test('row-only rerenders preserve focus on the same model action', async (t) => {
  const h = harness(t);
  h.controller.bind();
  await flush();

  const tuneBefore = h.card.querySelector(
    '[data-model-key="installed:1b"] [data-model-card-action="tune"]'
  );
  tuneBefore.focus();
  // A filter-chip click runs a full render (toolbar + rows), which rebuilds
  // every row; the focused action must land on its rebuilt twin.
  click(h.windowRef, h.card.querySelector('[data-inv-chip="all"]'));

  const tuneAfter = h.card.querySelector(
    '[data-model-key="installed:1b"] [data-model-card-action="tune"]'
  );
  assert.notEqual(tuneAfter, tuneBefore);
  assert.equal(h.document.activeElement, tuneAfter);
});

test('row menu enables Ollama removal, opens the existing modal, and confirms deletion', async (t) => {
  const h = harness(t);
  h.controller.bind();
  await flush();

  const menuButton = h.card.querySelector(
    '[data-model-key="installed:1b"] [data-model-card-action="menu"]'
  );
  click(h.windowRef, menuButton);
  const menu = contextMenuOptions(h);
  const remove = contextMenuItem(h, 'Remove…');
  assert.equal(menu.rootEl, h.card);
  assert.equal(menu.anchorEl, menuButton);
  assert.equal(menu.restoreFocusTo, menuButton);
  assert.equal(remove.danger, true);
  assert.equal(remove.disabled, false);
  remove.action();
  const modal = h.card.querySelector('[data-step-modal="model-library-section-confirm-delete"]');
  assert.ok(modal);
  click(h.windowRef, modal.querySelector('[data-step-modal-action="confirm"]'));
  await flush();

  assert.deepEqual(
    h.calls.find((entry) => entry[0] === 'delete'),
    ['delete', { model: 'installed:1b' }]
  );
  assert.ok(h.calls.some((entry) => entry[0] === 'refreshModelPickers'));
});

test('row menu disables removal for the loaded model', async (t) => {
  // The standalone Remove button was gated on active !== true; the overflow
  // menu is now the only Remove path, and models.delete rejects the loaded
  // model with model_in_use, so the item must not be offered as enabled.
  const activeState = state(true);
  activeState.status.model = 'installed:1b';
  const h = harness(t, { state: activeState });
  h.controller.bind();
  await flush();

  const row = h.card.querySelector('[data-model-key="installed:1b"]');
  assert.equal(row.getAttribute('data-active'), 'true');
  click(h.windowRef, row.querySelector('[data-model-card-action="menu"]'));

  assert.equal(contextMenuItem(h, 'Remove…').disabled, true);
  assert.equal(contextMenuItem(h, 'Copy tag').disabled, undefined);
});

test('row menu disables removal for a vllm model', async (t) => {
  const h = harness(t, {
    models: {
      list: async () => ({
        data: [{ id: 'installed:1b', size: 1024, engine_type: 'vllm' }],
      }),
    },
  });
  h.controller.bind();
  await flush();

  click(h.windowRef, h.card.querySelector(
    '[data-model-key="installed:1b"] [data-model-card-action="menu"]'
  ));

  assert.equal(contextMenuItem(h, 'Remove…').disabled, true);
});

test('copy tag from the row menu writes to the clipboard and updates status', async (t) => {
  const h = harness(t);
  const copied = [];
  Object.defineProperty(h.windowRef.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: (value) => copied.push(value) },
  });
  h.controller.bind();
  await flush();

  click(h.windowRef, h.card.querySelector(
    '[data-model-key="installed:1b"] [data-model-card-action="menu"]'
  ));
  await contextMenuItem(h, 'Copy tag').action();

  assert.deepEqual(copied, ['installed:1b']);
  assert.equal(
    h.card.querySelector('.model-library-section-status').textContent,
    'Copied installed:1b'
  );
});

test('copy tag reports the real outcome when the clipboard is denied or absent', async (t) => {
  const denied = harness(t);
  Object.defineProperty(denied.windowRef.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: () => Promise.reject(new Error('denied')) },
  });
  denied.controller.bind();
  await flush();
  click(denied.windowRef, denied.card.querySelector(
    '[data-model-key="installed:1b"] [data-model-card-action="menu"]'
  ));
  // The action must own its rejection (the menu wrapper only catches what the
  // action returns) and must never report a copy that did not happen.
  await contextMenuItem(denied, 'Copy tag').action();
  assert.equal(
    denied.card.querySelector('.model-library-section-status').textContent,
    'Could not copy installed:1b to the clipboard.'
  );

  const absent = harness(t);
  Object.defineProperty(absent.windowRef.navigator, 'clipboard', {
    configurable: true,
    value: undefined,
  });
  absent.controller.bind();
  await flush();
  click(absent.windowRef, absent.card.querySelector(
    '[data-model-key="installed:1b"] [data-model-card-action="menu"]'
  ));
  assert.equal(contextMenuItem(absent, 'Copy tag').action(), null);
  assert.equal(
    absent.card.querySelector('.model-library-section-status').textContent,
    'Clipboard access is unavailable right now.'
  );
});

test('a background row render never dismisses a context menu this section did not open', async (t) => {
  // inventoryContextMenu is a process-wide singleton: a snapshot-driven
  // syncFromState() must not close an Explorer or chat menu behind the user.
  const hides = [];
  const h = harness(t, {
    inventoryContextMenu: {
      show() {},
      hide() { hides.push('hide'); },
    },
  });
  h.controller.bind();
  await flush();

  h.state.status.model = 'installed:1b';
  h.controller.syncFromState();
  assert.deepEqual(hides, []);

  // A menu this controller opened is still dismissed on the next row render.
  click(h.windowRef, h.card.querySelector(
    '[data-model-key="installed:1b"] [data-model-card-action="menu"]'
  ));
  h.state.offline.preferredLocalModel = 'installed:1b';
  h.controller.syncFromState();
  assert.deepEqual(hides, ['hide']);
});

test('use activates through the model lifecycle, persists preference after success, and tune still opens', async (t) => {
  const h = harness(t);
  h.controller.bind();
  await flush();

  const installedCard = h.card.querySelector('[data-model-key="installed:1b"]');
  click(h.windowRef, installedCard.querySelector('[data-model-card-action="tune"]'));
  click(h.windowRef, installedCard.querySelector('[data-model-card-action="use"]'));
  await flush();

  assert.equal(h.calls.filter((entry) => entry[0] === 'tune').length, 1);
  assert.deepEqual(
    h.calls.find((entry) => entry[0] === 'load'),
    ['load', { model: 'installed:1b', engine_type: 'ollama' }]
  );
  assert.deepEqual(
    h.calls.find((entry) => entry[0] === 'updateSettings'),
    ['updateSettings', { preferredLocalModel: 'installed:1b' }]
  );
  assert.equal(h.state.offline.preferredLocalModel, 'installed:1b');
  assert.deepEqual(
    h.calls.find((entry) => entry[0] === 'toast'),
    ['toast', 'Now chatting with "installed:1b"', { tone: 'success' }]
  );
  const activeCard = h.card.querySelector('[data-model-key="installed:1b"]');
  assert.equal(activeCard.dataset.active, 'true');
  assert.match(activeCard.textContent, /Active/);
  assert.ok(activeCard.querySelector('[data-model-card-action="unload"]'));
});

test('use renders its pending card synchronously before the load settles', async (t) => {
  const loadRequest = deferred();
  const currentState = state(true);
  const h = harness(t, {
    state: currentState,
    models: {
      load: () => loadRequest.promise.then(() => {
        currentState.status.model = 'installed:1b';
        return { status: 'ok', model: 'installed:1b' };
      }),
    },
  });
  h.controller.bind();
  await flush();

  click(h.windowRef, h.card.querySelector(
    '[data-model-key="installed:1b"] [data-model-card-action="use"]'
  ));
  const pendingCard = h.card.querySelector('[data-model-key="installed:1b"]');
  const pendingUse = pendingCard.querySelector('[data-model-card-action="use"]');
  assert.equal(pendingCard.dataset.pending, 'true');
  assert.equal(pendingUse.textContent, 'Starting…');
  assert.equal(pendingUse.disabled, true);
  assert.equal(
    h.card.querySelector('.model-library-section-status').textContent,
    'Switching to "installed:1b"…'
  );

  loadRequest.resolve();
  await flush();
});

test('load failure renders an in-card error without preference persistence or toast', async (t) => {
  const h = harness(t, {
    models: { load: async () => { throw new Error('Engine refused <unsafe>.'); } },
  });
  h.controller.bind();
  await flush();

  click(h.windowRef, h.card.querySelector(
    '[data-model-key="installed:1b"] [data-model-card-action="use"]'
  ));
  await flush();

  const note = h.card.querySelector('[data-model-key="installed:1b"] .model-card-note--error');
  assert.equal(note.textContent, 'Engine refused <unsafe>.');
  assert.equal(note.querySelector('unsafe'), null);
  assert.equal(h.calls.some((entry) => entry[0] === 'updateSettings'), false);
  assert.equal(h.calls.some((entry) => entry[0] === 'toast'), false);
  assert.ok(h.calls.some((entry) => entry[0] === 'log'
    && entry[2] === 'model_library.activate_failed'));
});

test('preferred-model persistence failure stays a successful activation', async (t) => {
  const h = harness(t, {
    offline: { updateSettings: async () => { throw new Error('Settings store unavailable.'); } },
  });
  h.controller.bind();
  await flush();

  click(h.windowRef, h.card.querySelector(
    '[data-model-key="installed:1b"] [data-model-card-action="use"]'
  ));
  await flush();

  assert.equal(h.card.querySelector('[data-model-key="installed:1b"]').dataset.active, 'true');
  assert.ok(h.calls.some((entry) => entry[0] === 'toast'));
  assert.ok(h.calls.some((entry) => entry[0] === 'log'
    && entry[2] === 'model_library.preferred_local_update_failed'));
  assert.equal(h.calls.some((entry) => entry[0] === 'log'
    && entry[2] === 'model_library.activate_failed'), false);
  assert.match(
    h.card.querySelector('.model-library-section-status').textContent,
    /local preference could not be saved/
  );
});

test('an unacknowledged preference echo is reported as a preference failure, not merged', async (t) => {
  const h = harness(t, {
    offline: { updateSettings: async () => ({}) },
  });
  h.controller.bind();
  await flush();

  click(h.windowRef, h.card.querySelector(
    '[data-model-key="installed:1b"] [data-model-card-action="use"]'
  ));
  await flush();

  assert.equal(h.card.querySelector('[data-model-key="installed:1b"]').dataset.active, 'true');
  assert.notEqual(h.state.offline.preferredLocalModel, 'installed:1b');
  assert.ok(h.calls.some((entry) => entry[0] === 'log'
    && entry[2] === 'model_library.preferred_local_update_failed'));
  assert.match(
    h.card.querySelector('.model-library-section-status').textContent,
    /local preference could not be saved/
  );
});

test('unload succeeds for the canonical active model and refreshes on a stale active card', async (t) => {
  const activeState = state(true);
  activeState.status.model = 'installed:1b';
  const active = harness(t, { state: activeState });
  active.controller.bind();
  await flush();

  click(active.windowRef, active.card.querySelector(
    '[data-model-key="installed:1b"] [data-model-card-action="unload"]'
  ));
  await flush();
  assert.deepEqual(active.calls.find((entry) => entry[0] === 'unload'), ['unload']);
  assert.deepEqual(
    active.calls.find((entry) => entry[0] === 'toast'),
    ['toast', 'Unloaded "installed:1b"', { tone: 'success' }]
  );
  assert.equal(
    active.card.querySelector('[data-model-key="installed:1b"]').dataset.active,
    'false'
  );

  const staleState = state(true);
  staleState.status.model = 'installed:1b';
  const stale = harness(t, { state: staleState });
  stale.controller.bind();
  await flush();
  const staleUnload = stale.card.querySelector(
    '[data-model-key="installed:1b"] [data-model-card-action="unload"]'
  );
  staleState.status.model = 'changed:2b';
  stale.engine.loadedModel = 'changed:2b';
  click(stale.windowRef, staleUnload);
  assert.equal(
    stale.card.querySelector('.model-library-section-status').textContent,
    'The loaded model changed. Refreshing the model library.'
  );
  assert.equal(stale.calls.some((entry) => entry[0] === 'unload'), false);
  await flush();
  assert.equal(
    stale.card.querySelector('.model-library-section-status').textContent,
    'The loaded model changed. Refreshed the model library.'
  );
  assert.equal(
    stale.card.querySelector('[data-model-key="installed:1b"]').dataset.active,
    'false'
  );
});

test('controller without a toast dependency completes activation through the live status line', async (t) => {
  const h = harness(t, { showToast: false });
  h.controller.bind();
  await flush();

  click(h.windowRef, h.card.querySelector(
    '[data-model-key="installed:1b"] [data-model-card-action="use"]'
  ));
  await flush();

  assert.equal(
    h.card.querySelector('.model-library-section-status').textContent,
    'Now chatting with "installed:1b".'
  );
});

test('runtime feature changes flip visibility in both directions', async (t) => {
  const h = harness(t, { state: state(false) });
  h.state.ui.activeSettingsSection = 'models';
  h.controller.bind();
  await flush();

  h.state.features.featureFlags.model_library_section = true;
  await h.featureChanged()();
  assert.equal(h.nav.hidden, false);
  assert.equal(h.card.hidden, false);
  assert.equal(h.document.querySelectorAll('.model-row').length, 2);

  h.state.features.featureFlags.model_library_section = false;
  await h.featureChanged()();
  assert.equal(h.nav.hidden, true);
  assert.equal(h.card.hidden, true);
  assert.equal(h.document.getElementById('modelLibrarySectionHost').textContent, '');
});

test('split hosts populate while full renders preserve the live region and pull-tag focus', async (t) => {
  const h = harness(t);
  h.controller.bind();
  await flush();

  const toolbarHost = h.document.getElementById('modelLibrarySectionToolbarHost');
  const rowsHost = h.document.getElementById('modelLibrarySectionHost');
  const statusBefore = h.card.querySelector('.model-library-section-status');
  assert.match(toolbarHost.textContent, /All/);
  assert.match(toolbarHost.textContent, /Test GPU/);
  assert.equal(rowsHost.querySelectorAll('.model-row').length, 2);
  statusBefore.textContent = 'Persistent status';
  const inputBefore = h.card.querySelector('[data-model-library-section-input="pull-tag"]');
  inputBefore.value = 'recommended:3b';
  inputBefore.focus();
  inputBefore.setSelectionRange(2, 9, 'forward');
  h.controller.render();

  const inputAfter = h.card.querySelector('[data-model-library-section-input="pull-tag"]');
  assert.equal(h.card.querySelector('.model-library-section-status'), statusBefore);
  assert.equal(statusBefore.textContent, 'Persistent status');
  assert.equal(h.document.activeElement, inputAfter);
  assert.equal(inputAfter.value, 'recommended:3b');
  assert.equal(inputAfter.selectionStart, 2);
  assert.equal(inputAfter.selectionEnd, 9);
  assert.equal(inputAfter.selectionDirection, 'forward');
});

test('document-level Escape dismisses the section delete modal', async (t) => {
  const h = harness(t);
  h.controller.bind();
  await flush();

  click(h.windowRef, h.card.querySelector(
    '[data-model-key="installed:1b"] [data-model-card-action="menu"]'
  ));
  contextMenuItem(h, 'Remove…').action();
  assert.ok(h.card.querySelector('[data-step-modal="model-library-section-confirm-delete"]'));
  h.document.dispatchEvent(new h.windowRef.KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
  }));
  assert.equal(
    h.card.querySelector('[data-step-modal="model-library-section-confirm-delete"]'),
    null
  );
});

test('pull completion performs no stale-card repaint before the terminal refresh', async (t) => {
  const h = harness(t);
  h.controller.bind();
  await flush();

  click(h.windowRef, h.card.querySelector(
    '[data-model-key="recommended:3b"] [data-model-card-action="pull"]'
  ));
  const pulledCard = h.card.querySelector('[data-model-key="recommended:3b"]');
  const startCall = h.calls.find((entry) => entry[0] === 'startOllamaPull');
  h.progressListener()({
    requestId: startCall[1].requestId,
    status: 'completed',
    percent: 100,
  });

  assert.equal(h.card.querySelector('[data-model-key="recommended:3b"]'), pulledCard);
  assert.match(h.card.querySelector('.model-library-section-status').textContent, /Pull complete/);
  await flush();
});

test('unthrottled pull progress for an off-list tag never rebuilds the whole row list', async (t) => {
  const h = harness(t);
  h.controller.bind();
  await flush();

  const input = h.card.querySelector('[data-model-library-section-input="pull-tag"]');
  input.value = 'ghost:7b';
  input.dispatchEvent(new h.windowRef.Event('input', { bubbles: true }));
  click(h.windowRef, h.card.querySelector('[data-model-library-section-action="pull-tag"]'));

  // 'ghost:7b' is neither installed nor in the catalog, so no row carries its
  // key and replaceRow always misses. Only the start transition may repaint.
  const listAfterStart = h.document.getElementById('modelLibrarySectionHost').firstElementChild;
  const rowAfterStart = h.card.querySelector('[data-model-key="installed:1b"]');
  const startCall = h.calls.find((entry) => entry[0] === 'startOllamaPull');
  for (const percent of [10, 45, 90]) {
    h.progressListener()({ requestId: startCall[1].requestId, status: 'pulling', percent });
  }

  assert.equal(
    h.document.getElementById('modelLibrarySectionHost').firstElementChild,
    listAfterStart
  );
  assert.equal(h.card.querySelector('[data-model-key="installed:1b"]'), rowAfterStart);
});

test('in-flight activation and deletion latches surface bounded status instead of dropping clicks', async (t) => {
  const selection = harness(t, {
    models: { load: () => new Promise(() => {}) },
  });
  selection.controller.bind();
  await flush();
  const use = selection.card.querySelector(
    '[data-model-key="installed:1b"] [data-model-card-action="use"]'
  );
  click(selection.windowRef, use);
  click(selection.windowRef, selection.card.querySelector(
    '[data-model-key="installed:1b"] [data-model-card-action="use"]'
  ));
  assert.equal(
    selection.card.querySelector('.model-library-section-status').textContent,
    'Still switching models.'
  );

  const deletion = harness(t, {
    models: { delete: () => new Promise(() => {}) },
  });
  deletion.controller.bind();
  await flush();
  const menuSelector = '[data-model-key="installed:1b"] [data-model-card-action="menu"]';
  click(deletion.windowRef, deletion.card.querySelector(menuSelector));
  contextMenuItem(deletion, 'Remove…').action();
  click(deletion.windowRef, deletion.card.querySelector('[data-step-modal-action="confirm"]'));
  click(deletion.windowRef, deletion.card.querySelector(menuSelector));
  contextMenuItem(deletion, 'Remove…').action();
  click(deletion.windowRef, deletion.card.querySelector('[data-step-modal-action="confirm"]'));
  assert.equal(
    deletion.card.querySelector('.model-library-section-status').textContent,
    'Still removing the previous model.'
  );
});
