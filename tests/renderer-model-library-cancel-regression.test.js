'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createModelLibraryController } = require('../renderer/shell/renderer-model-library');

test('structured pull-cancellation failure keeps progress subscribed and reports failure', async (t) => {
  const dom = new JSDOM('<!doctype html><body><section class="settings-card" data-settings-section="models"></section></body>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
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
  const state = {
    features: { featureFlags: { model_management_ui: true } },
    status: { model: '' },
    modelList: { data: [] },
    offline: { preferredLocalModel: '' },
  };
  const controller = createModelLibraryController({
    state,
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
  controller.render();
  const input = dom.window.document.getElementById('modelLibraryPullInput');
  input.value = 'qwen2.5:3b';
  dom.window.document.querySelector('[data-model-library-action="pull"]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof progressListener, 'function');

  dom.window.document.querySelector('[data-model-library-action="cancel-pull"]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(controller._view.pullStatus, 'running', 'failed cancellation must not claim the pull stopped');
  assert.match(controller._view.statusMessage, /could not cancel/i);
  assert.doesNotMatch(controller._view.statusMessage, /termination_failed/);
  assert.equal(unsubscribeCalls, 0, 'progress monitoring remains active while the pull continues');
  assert.equal(typeof progressListener, 'function');
});
