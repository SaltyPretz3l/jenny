'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  flush, deferred, diagnostics, state, click, harness, contextMenuOptions, contextMenuItem, rowKeys,
} = require('./helpers/model-library-section-harness');

test('section publishes the first recommended fit and exposes the shared pull actions', async (t) => {
  const h = harness(t);
  let events = 0;
  h.windowRef.addEventListener('jenny:model-state-changed', () => { events += 1; });
  await h.controller.refresh({ force: true });
  assert.deepEqual(h.state.modelRecommendation, { tag: 'recommended:3b', downloadSizeMb: 0 });
  assert.equal(events, 1);
  h.controller.render();
  assert.equal(events, 1, 'unchanged tag does not publish an event');
  h.controller.startPull('recommended:3b');
  await flush();
  assert.equal(Object.values(h.state.modelPulls)[0].tag, 'recommended:3b');
  await h.controller.cancelPull('recommended:3b');
  assert.deepEqual(h.state.modelPulls, {});
  h.windowRef.jennyShell.models.list = async () => ({ data: [{ id: 'recommended:3b', engine_type: 'ollama' }] });
  const before = events;
  await h.controller.refresh({ force: true });
  assert.equal(h.state.modelRecommendation, null, 'an installed recommendation is not a download recommendation');
  assert.equal(events, before + 1);
});

test('the catalog note is the one place a catalog failure and its reason show', async (t) => {
  const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
  for (const [model, available, reason, expected] of [
    ['installed:1b', true, '', ''],
    ['installed:1b', false, 'Engine unreachable', 'Model catalog unavailable: Engine unreachable Using the backend default; load actions may not work until the local engine is reachable.'],
    ['', false, '', 'Model catalog unavailable. Using the backend default; load actions may not work until the local engine is reachable.'],
  ]) {
    const app = await loadRendererApp({ shell: {
      status: { async get() { return { model, model_loaded: Boolean(model) }; } },
      models: { async list() { return { data: [], active_model: model, available, reason }; } },
    } });
    t.after(() => app.dispose());
    // The Settings page paints on activation (renderAll no longer paints it on the chat view).
    app.window.document.querySelector('[data-tab-id="settings"]').click();
    await waitForUi(app.window, 20);
    const note = app.window.document.getElementById('modelCatalogEmpty');
    assert.equal(note.textContent, expected);
    assert.equal(note.hidden, !expected);
    assert.equal(app.window.document.getElementById('modelStatus'), null);
    await app.dispose();
  }
});

test('controller exposes state and engine-settings sync methods', (t) => {
  const h = harness(t);
  assert.equal(typeof h.controller.syncFromState, 'function');
  assert.equal(typeof h.controller.syncEngineSettings, 'function');
});

test('renders the installed rows, switches scope through counted chips, and refreshes all isolated sources', async (t) => {
  const h = harness(t);
  h.controller.bind();
  await flush();

  assert.equal(h.card.hidden, false);
  assert.deepEqual(rowKeys(h), ['installed:1b']);
  assert.match(h.card.textContent, /Installed model/);
  assert.equal(h.card.querySelectorAll('.model-library-filter-chips').length, 1);

  click(h.windowRef, h.card.querySelector('[data-inv-chip="scope-get"]'));
  assert.deepEqual(rowKeys(h), ['recommended:3b']);
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

test('the boot seed defers the first source load: startup reads the sources once', async (t) => {
  const seeded = state();
  seeded.features.availabilityResolved = false;
  const h = harness(t, { state: seeded });
  h.controller.bind();
  await flush();
  assert.equal(h.calls.filter((entry) => entry[0] === 'list').length, 0, 'no read on the seed');
  assert.equal(h.calls.filter((entry) => entry[0] === 'getDiagnostics').length, 0);

  seeded.features.availabilityResolved = true;
  h.featureChanged()();
  await flush();
  assert.equal(h.calls.filter((entry) => entry[0] === 'list').length, 1, 'one read after hydration');
  assert.equal(h.calls.filter((entry) => entry[0] === 'getDiagnostics').length, 1);
});

test('the folder, NInfer and Image engine hosts are no longer written into the Models page', async (t) => {
  const flagged = state();
  Object.assign(flagged.features.featureFlags, { llama_server_acceleration: true, tools_image_generate_enabled: true, ninfer: true });
  flagged.localEngines = { openaiCompatible: { managed: { libraryRoots: ['D:\\models\\gguf'] } } };
  const h = harness(t, { state: flagged });
  h.controller.bind();
  await flush();
  for (const id of ['modelLibraryFoldersHost', 'modelLibraryNinferHost', 'modelLibraryImageEngineHost', 'modelLibrarySectionExtrasHost']) {
    assert.equal(h.document.getElementById(id), null, `${id} belongs to the engine drawers now`);
  }
  assert.ok(h.card.querySelector('.mlib-searchline'), 'the library itself still renders');
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

  const row = [...h.document.querySelectorAll('.mrow')]
    .find((el) => el.textContent.includes('private/estimated:q4'));
  assert.ok(row);
  const fit = row.querySelector('.mrow-fit');
  assert.doesNotMatch(fit.textContent, /estimated/);
  assert.match(fit.textContent, /^~/, 'an estimate carries the ~');
  assert.match(fit.title, /estimated/);
});

test('pull action starts one pull and patches only that row, leaving siblings and toolbar intact', async (t) => {
  const h = harness(t);
  h.controller.bind();
  await flush();
  click(h.windowRef, h.card.querySelector('[data-model-library-section-action="show-catalog"]'));

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

test('a rerender keeps unchanged rows and puts focus back on the same action of a repainted row', async (t) => {
  const h = harness(t);
  h.controller.bind();
  await flush();

  const tuneBefore = h.card.querySelector(
    '[data-model-key="installed:1b"] [data-model-card-action="tune"]'
  );
  tuneBefore.focus();
  // A scope-chip click re-renders the rows; an unchanged row keeps its node and its focus.
  click(h.windowRef, h.card.querySelector('[data-inv-chip="scope-all"]'));
  assert.equal(h.card.querySelector('[data-model-key="installed:1b"] [data-model-card-action="tune"]'), tuneBefore);
  assert.equal(h.document.activeElement, tuneBefore);

  // A changed row is repainted; the focused action must land on its new twin.
  h.state.offline.preferredLocalModel = 'installed:1b';
  h.controller.syncFromState();
  const tuneAfter = h.card.querySelector(
    '[data-model-key="installed:1b"] [data-model-card-action="tune"]'
  );
  assert.notEqual(tuneAfter, tuneBefore);
  assert.match(h.card.querySelector('[data-model-key="installed:1b"]').textContent, /Local default/);
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
  const modal = h.document.querySelector('[data-step-modal="model-library-section-confirm-delete"]');
  assert.ok(modal);
  click(h.windowRef, modal.querySelector('[data-step-modal-action="confirm"]'));
  await flush();

  assert.deepEqual(
    h.calls.find((entry) => entry[0] === 'delete'),
    ['delete', { model: 'installed:1b' }]
  );
  assert.ok(h.calls.some((entry) => entry[0] === 'refreshModelPickers'));
  assert.equal(h.card.querySelector('.model-library-section-status').textContent, '"installed:1b" removed.', 'the refresh keeps the result');
});

test('the loaded model is not a library row, so the library offers no way to remove it', async (t) => {
  // Running now shows the loaded model. The overflow menu is the only Remove
  // path and models.delete rejects the loaded model with model_in_use.
  const activeState = state();
  activeState.status.model = 'installed:1b';
  const h = harness(t, { state: activeState });
  h.controller.bind();
  await flush();

  assert.equal(h.card.querySelector('[data-model-key="installed:1b"]'), null);
  assert.equal(h.card.querySelector('[data-model-card-action="menu"]'), null);
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

  h.state.offline.preferredLocalModel = 'recommended:3b';
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
  assert.equal(h.card.querySelector('[data-model-key="installed:1b"]'), null, 'the loaded model leaves the library for Running now');
});

test('use renders its pending card synchronously before the load settles', async (t) => {
  const loadRequest = deferred();
  const currentState = state();
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

  assert.equal(h.card.querySelector('[data-model-key="installed:1b"]'), null, 'the loaded model is no library row');
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

  assert.equal(h.card.querySelector('[data-model-key="installed:1b"]'), null, 'the loaded model is no library row');
  assert.notEqual(h.state.offline.preferredLocalModel, 'installed:1b');
  assert.ok(h.calls.some((entry) => entry[0] === 'log'
    && entry[2] === 'model_library.preferred_local_update_failed'));
  assert.match(
    h.card.querySelector('.model-library-section-status').textContent,
    /local preference could not be saved/
  );
});

// Running now owns Unload.
function runningNowUnload(h) {
  return h.document.querySelector('#modelRunningHost [data-model-card-action="unload"]');
}

test('unload succeeds for the canonical active model and refreshes on a stale active card', async (t) => {
  const activeState = state();
  activeState.status.model = 'installed:1b';
  const active = harness(t, { state: activeState });
  active.controller.bind();
  await flush();

  click(active.windowRef, runningNowUnload(active));
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

  const staleState = state();
  staleState.status.model = 'installed:1b';
  const stale = harness(t, { state: staleState });
  stale.controller.bind();
  await flush();
  const staleUnload = runningNowUnload(stale);
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

test('split hosts populate while full renders preserve the live region and search focus', async (t) => {
  const h = harness(t);
  h.controller.bind();
  await flush();

  const toolbarHost = h.document.getElementById('modelLibrarySectionToolbarHost');
  const rowsHost = h.document.getElementById('modelLibrarySectionHost');
  const statusBefore = h.card.querySelector('.model-library-section-status');
  assert.match(toolbarHost.textContent, /All/);
  assert.equal(rowsHost.querySelectorAll('.mrow').length, 1);
  statusBefore.textContent = 'Persistent status';
  const inputBefore = h.card.querySelector('[data-model-library-section-input="search"]');
  inputBefore.value = 'recommended:3b';
  inputBefore.focus();
  inputBefore.setSelectionRange(2, 9, 'forward');
  h.controller.render();

  const inputAfter = h.card.querySelector('[data-model-library-section-input="search"]');
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
  assert.ok(h.document.querySelector('[data-step-modal="model-library-section-confirm-delete"]'));
  h.document.dispatchEvent(new h.windowRef.KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
  }));
  assert.equal(h.document.querySelector('[data-step-modal="model-library-section-confirm-delete"]'), null);
});

test('a backdrop click dismisses the section delete modal; a click inside the panel keeps it', async (t) => {
  const h = harness(t);
  h.controller.bind();
  await flush();
  const modalSelector = '[data-step-modal="model-library-section-confirm-delete"]';
  const openModal = () => {
    click(h.windowRef, h.card.querySelector('[data-model-key="installed:1b"] [data-model-card-action="menu"]'));
    contextMenuItem(h, 'Remove…').action();
    const modal = h.document.querySelector(modalSelector);
    assert.ok(modal, 'modal opens');
    return modal;
  };
  click(h.windowRef, openModal());
  assert.equal(h.document.querySelector(modalSelector), null, 'backdrop click dismisses');
  click(h.windowRef, openModal().querySelector('.inv-step-modal'));
  assert.ok(h.document.querySelector(modalSelector), 'panel click keeps the modal');
});

test('a row re-render keeps the open delete modal and the focus inside it', async (t) => {
  const h = harness(t);
  h.controller.bind();
  await flush();
  const modalSelector = '[data-step-modal="model-library-section-confirm-delete"]';
  const menu = () => h.card.querySelector('[data-model-key="installed:1b"] [data-model-card-action="menu"]');
  const openRemove = () => { click(h.windowRef, menu()); contextMenuItem(h, 'Remove…').action(); };
  openRemove();
  const modal = h.document.querySelector(modalSelector);
  assert.equal(modal.parentNode, h.document.body, 'mounted on the body, so the backdrop covers the window');
  await flush();
  assert.equal(h.document.activeElement, modal.querySelector('[data-step-modal-action="cancel"]'), 'Cancel takes focus first');
  const confirm = modal.querySelector('[data-step-modal-action="confirm"]');
  confirm.focus();
  h.controller.render(); // a full render (toolbar + rows)
  assert.equal(h.document.querySelectorAll(modalSelector).length, 1);
  assert.equal(h.document.querySelector(modalSelector), modal, 'the same dialog node stays');
  assert.equal(h.document.activeElement, confirm);
  click(h.windowRef, modal.querySelector('[data-step-modal-action="cancel"]'));
  assert.equal(h.document.querySelector(modalSelector), null);
  assert.equal(h.document.activeElement, menu(), 'Cancel returns focus to the row ⋯ that opened it');
  openRemove();
  assert.ok(h.document.querySelector(modalSelector), 'a cancelled dialog opens again');
});

test('pull completion performs no stale-card repaint before the terminal refresh', async (t) => {
  const h = harness(t);
  h.controller.bind();
  await flush();
  click(h.windowRef, h.card.querySelector('[data-inv-chip="scope-get"]'));

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
  // The Composer's model pickers learn about the new tag through the terminal refresh.
  assert.ok(h.calls.some((entry) => entry[0] === 'refreshModelPickers'), 'pull completion refreshes the model pickers');
});

test('unthrottled pull progress for an off-list tag never rebuilds the whole row list', async (t) => {
  const h = harness(t);
  h.controller.bind();
  await flush();

  const input = h.card.querySelector('[data-model-library-section-input="search"]');
  input.value = 'ghost:7b';
  input.dispatchEvent(new h.windowRef.Event('input', { bubbles: true }));
  click(h.windowRef, h.card.querySelector('[data-model-library-section-action="pull-tag"]'));

  // 'ghost:7b' is neither installed nor in the catalog, so no row carries its
  // key and replaceRow always misses. Only the start transition may repaint.
  const listAfterStart = h.card.querySelector('.mrow-list');
  const pullRowAfterStart = h.card.querySelector('.mrow--pull');
  const startCall = h.calls.find((entry) => entry[0] === 'startOllamaPull');
  for (const percent of [10, 45, 90]) {
    h.progressListener()({ requestId: startCall[1].requestId, status: 'pulling', percent });
  }

  assert.equal(h.card.querySelector('.mrow-list'), listAfterStart);
  assert.equal(h.card.querySelector('.mrow--pull'), pullRowAfterStart);
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
  click(deletion.windowRef, deletion.document.querySelector('[data-step-modal-action="confirm"]'));
  click(deletion.windowRef, deletion.card.querySelector(menuSelector));
  contextMenuItem(deletion, 'Remove…').action();
  click(deletion.windowRef, deletion.document.querySelector('[data-step-modal-action="confirm"]'));
  assert.equal(deletion.card.querySelector('.model-library-section-status').textContent, 'Still removing the previous model.');
});

test('a feature broadcast with unchanged flags does not reload the sources', async (t) => {
  const h = harness(t);
  h.controller.bind();
  await flush();
  const before = h.calls.length;
  assert.ok(before > 0, 'the bind refresh loaded the sources');

  // shell-config re-broadcasts feature state on every config change (root
  // probe, workspace state); none of the flags this section reads moved.
  await h.featureChanged()();
  await h.featureChanged()();
  assert.equal(h.calls.length, before, 'no bridge call for an unchanged-flag broadcast');

  h.state.features.featureFlags.llama_server_acceleration = !h.state.features.featureFlags.llama_server_acceleration;
  await h.featureChanged()();
  assert.ok(h.calls.length > before, 'a flag this section reads flipping reloads the sources');
});


test('failed row routes recovery and repaints when the failure changes or clears', async (t) => {
  const failure = { cause: 'out_of_memory', context: 40960, message: 'memory exhausted', at: '2026-10-07T12:00:00Z', engine: 'ollama', model: 'qwen3:8b' };
  const current = state();
  current.backend = { phase: 'model_unavailable', model_lifecycle: { state: 'unavailable', requested_model: 'qwen3:8b', engine: 'ollama', failure } };
  const h = harness(t, { state: current, models: { async list() { return { data: [{ id: 'qwen3:8b', engine_type: 'ollama' }] }; } } });
  h.windowRef.jennyShell.modelTuning = { async update(payload) { h.calls.push(['persist', payload]); return { status: 'applied' }; } };
  h.controller.bind();
  await flush();
  const row = () => [...h.card.querySelectorAll('.mrow')].find((el) => el.querySelector('[data-model-tag="qwen3:8b"]'));
  assert.equal(row().dataset.loadFailed, 'true');
  assert.match(row().textContent, /Didn't load/);
  click(h.windowRef, row().querySelector('[data-model-card-action="showFits"]'));
  assert.equal(h.card.querySelector('[data-inv-chip="scope-get"]').getAttribute('aria-pressed'), 'true', 'Show models that fit opens the downloadable scope');
  click(h.windowRef, h.card.querySelector('[data-inv-chip="scope-all"]'));
  click(h.windowRef, row().querySelector('[data-model-card-action="loadSmaller"]'));
  await flush();
  const persistIndex = h.calls.findIndex(([action]) => action === 'persist');
  const loadIndex = h.calls.findIndex(([action]) => action === 'load');
  assert.deepEqual(h.calls[persistIndex], ['persist', { modelId: 'qwen3:8b', contextLength: 32768 }]);
  assert.ok(loadIndex > persistIndex);
  assert.equal(h.calls[loadIndex][1].model || h.calls[loadIndex][1], 'qwen3:8b');
  // The model loaded, so Running now owns it; unload it to see the library row again.
  assert.equal(row(), undefined);
  current.status.model = '';
  h.engine.loadedModel = '';
  h.controller.syncFromState();
  current.backend.model_lifecycle.failure = { ...failure, cause: 'timeout', at: '2026-10-07T12:01:00Z' };
  h.controller.syncFromState();
  assert.ok(row().querySelector('[data-model-card-action="retry"]'));
  assert.equal(row().querySelector('[data-model-card-action="loadSmaller"]'), null);
  current.backend.model_lifecycle.failure = { ...failure, cause: 'engine_unreachable' };
  h.controller.syncFromState();
  click(h.windowRef, row().querySelector('[data-model-card-action="diagnostics"]'));
  assert.ok(h.calls.some(([action]) => action === 'diagnostics'));
  current.backend = { phase: 'ready' };
  h.controller.syncFromState();
  assert.equal(row().dataset.loadFailed, 'false');
  assert.doesNotMatch(row().textContent, /Didn't load/);
});

// --- Settings > Models > Library: one search line, scope chips, sort, keyed rows ---
