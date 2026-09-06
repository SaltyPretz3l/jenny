'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createScene } = require('../renderer/features/setup-scenes/scene-local-model');

function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('failed pull cancellation stays subscribed and reports an honest retry state', async (t) => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  const rootEl = dom.window.document.getElementById('root');
  let progressHandler = null;
  let unsubscribeCalls = 0;
  let startPayload = null;
  let cancelCalls = 0;
  const scene = createScene({
    state: { steps: {}, readiness: {} },
    setupService: {
      subscribePullProgress(handler) {
        progressHandler = handler;
        return () => { unsubscribeCalls += 1; };
      },
      async startOllamaPull(payload) { startPayload = payload; return { requestId: payload.requestId }; },
      async cancelOllamaPull() { cancelCalls += 1; return { cancelled: false }; },
    },
    markStep: async () => {},
    showToastMessage: () => {},
    showShellErrorToast: () => {},
    appendClientLog: () => {},
  });
  t.after(() => scene.dispose());
  scene.mount(rootEl);

  rootEl.querySelector('#setup-local-model-name').value = 'qwen2.5:3b';
  rootEl.querySelector('#setup-local-model-name').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  const startButton = rootEl.querySelector('[data-action="startPull"]');
  startButton.click();
  await settle();
  rootEl.querySelector('[data-action="cancelPull"]').click();
  await settle();

  assert.equal(cancelCalls, 1);
  assert.equal(unsubscribeCalls, 0, 'failed cancellation keeps progress ownership alive');
  assert.match(rootEl.textContent, /Cancel was not confirmed/);
  assert.match(rootEl.querySelector('[data-action="cancelPull"]').textContent, /Retry cancel/);

  progressHandler({ requestId: startPayload.requestId, status: 'completed', percent: 100, summary: 'Complete' });
  assert.equal(unsubscribeCalls, 1, 'a later terminal event releases the subscription');
  assert.match(rootEl.textContent, /Pull complete/);
});

test('confirmed pull cancellation becomes terminal only after the service acknowledgement', async (t) => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  const rootEl = dom.window.document.getElementById('root');
  let resolveCancel;
  const cancelGate = new Promise((resolve) => { resolveCancel = resolve; });
  let unsubscribeCalls = 0;
  const scene = createScene({
    state: { steps: {}, readiness: {} },
    setupService: {
      subscribePullProgress() { return () => { unsubscribeCalls += 1; }; },
      async startOllamaPull(payload) { return { requestId: payload.requestId }; },
      cancelOllamaPull() { return cancelGate; },
    },
    markStep: async () => {},
    showToastMessage: () => {},
    showShellErrorToast: () => {},
    appendClientLog: () => {},
  });
  t.after(() => scene.dispose());
  scene.mount(rootEl);

  rootEl.querySelector('#setup-local-model-name').value = 'qwen2.5:3b';
  rootEl.querySelector('#setup-local-model-name').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  const startButton = rootEl.querySelector('[data-action="startPull"]');
  startButton.click();
  await settle();
  rootEl.querySelector('[data-action="cancelPull"]').click();
  assert.match(rootEl.textContent, /Cancelling/);
  assert.equal(unsubscribeCalls, 0);

  resolveCancel({ cancelled: true, summary: 'Ollama pull cancelled.' });
  await settle();
  assert.equal(unsubscribeCalls, 1);
  assert.match(rootEl.textContent, /Cancelled/);
});

test('running pulls hide exit actions and failed exit cancellation retains the modal subscription', async (t) => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  const rootEl = dom.window.document.getElementById('root');
  let cancelCalls = 0;
  let closeCalls = 0;
  let unsubscribeCalls = 0;
  const scene = createScene({
    state: { steps: {}, readiness: {} },
    setupService: {
      subscribePullProgress() { return () => { unsubscribeCalls += 1; }; },
      async startOllamaPull(payload) { return { requestId: payload.requestId }; },
      async cancelOllamaPull() { cancelCalls += 1; return { cancelled: false }; },
    },
    closeModal: () => { closeCalls += 1; },
    markStep: async () => {},
    showToastMessage: () => {},
    showShellErrorToast: () => {},
    appendClientLog: () => {},
  });
  t.after(() => scene.dispose());
  scene.mount(rootEl);

  rootEl.querySelector('#setup-local-model-name').value = 'qwen2.5:3b';
  rootEl.querySelector('#setup-local-model-name').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  rootEl.querySelector('[data-action="startPull"]').click();
  await settle();

  assert.equal(rootEl.querySelector('[data-step-modal-action="close"]'), null);
  assert.equal(rootEl.querySelector('[data-step-modal-action="skip"]'), null);

  const syntheticExit = dom.window.document.createElement('button');
  syntheticExit.setAttribute('data-step-modal-action', 'close');
  rootEl.appendChild(syntheticExit);
  syntheticExit.click();
  await settle();

  assert.equal(cancelCalls, 1);
  assert.equal(closeCalls, 0);
  assert.equal(unsubscribeCalls, 0);
  assert.match(rootEl.textContent, /Cancel was not confirmed/);
});
