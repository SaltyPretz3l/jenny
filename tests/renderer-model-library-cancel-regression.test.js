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

test('structured pull-cancellation failure keeps progress subscribed and reports failure', async (t) => {
  const dom = new JSDOM(`<!doctype html><body>
    <nav class="settings-nav"><button data-settings-section="models">Models</button></nav>
    <section class="settings-card" data-settings-section="models">
      <div id="modelLibrarySectionToolbarHost"></div>
      <div class="settings-note model-library-section-status" aria-live="polite"></div>
      <div id="modelLibrarySectionHost"></div>
    </section>
  </body>`, { pretendToBeVisual: true, url: 'http://localhost/' });
  let progressListener = null;
  let unsubscribeCalls = 0;
  const setupService = {
    startOllamaPull: async (payload) => ({ requestId: payload.requestId, status: 'running' }),
    cancelOllamaPull: async () => ({ cancelled: false, code: 'termination_failed' }),
    subscribePullProgress(listener) {
      progressListener = listener;
      return () => { unsubscribeCalls += 1; progressListener = null; };
    },
  };
  dom.window.jennyShell = {
    models: {
      list: async () => ({ data: [] }),
      listOllamaTags: async () => ({ data: [] }),
    },
    offline: {
      getDiagnostics: async () => ({
        hardwareProfile: {},
        memory: {},
        modelRecommendations: [{
          pullTag: 'qwen2.5:3b',
          displayName: 'Qwen 2.5 3B',
          recommended: true,
          fitsInVram: true,
        }],
      }),
    },
    features: { onChanged: () => () => {} },
  };
  const controller = createModelLibrarySectionController({
    state: {
      features: { featureFlags: { model_management_ui: true } },
      status: { model: '' },
      offline: { preferredLocalModel: '' },
      ui: { activeSettingsSection: 'models' },
    },
    windowRef: dom.window,
    documentRef: dom.window.document,
    appendClientLog: () => {},
    refreshModelPickers: () => {},
    setupService,
  });
  t.after(() => {
    controller.dispose();
    dom.window.close();
  });

  controller.bind();
  await flush();
  dom.window.document.querySelector('[data-model-key="qwen2.5:3b"] [data-model-card-action="pull"]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await flush();
  assert.equal(typeof progressListener, 'function');

  dom.window.document.querySelector('[data-model-key="qwen2.5:3b"] [data-model-card-action="cancel"]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await flush();

  const status = dom.window.document.querySelector('.model-library-section-status').textContent;
  assert.match(status, /could not cancel/i);
  assert.doesNotMatch(status, /termination_failed/);
  assert.equal(unsubscribeCalls, 0, 'progress monitoring remains active while the pull continues');
  assert.equal(typeof progressListener, 'function');
  assert.ok(dom.window.document.querySelector('[data-model-card-action="cancel"]'));
});
