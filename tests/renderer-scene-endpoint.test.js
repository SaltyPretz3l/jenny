'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createScene } = require('../renderer/features/setup-scenes/scene-endpoint');

function mount(t, setupService, overrides = {}) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const rootEl = dom.window.document.getElementById('root');
  const snapshots = [];
  const scene = createScene({
    setupService,
    state: { steps: {}, readiness: {} },
    applySnapshot: (snapshot) => snapshots.push(snapshot),
    markStep: async () => {},
    closeModal: () => {},
    ...overrides,
  });
  scene.mount(rootEl);
  t.after(() => { scene.dispose(); dom.window.close(); });
  return { rootEl, scene, snapshots };
}

function click(rootEl, action) {
  const button = rootEl.querySelector(`[data-action="${action}"], [data-step-modal-action="${action}"]`);
  assert.ok(button, `missing ${action} action`);
  button.click();
}

test('endpoint scene saves through setup.saveEndpoint and applies the returned snapshot', async (t) => {
  const calls = [];
  const snapshot = { setupComplete: false, steps: { endpoint: 'done' } };
  const { rootEl, snapshots } = mount(t, {
    validateEndpoint: async (payload) => ({ ok: true, code: 'ok', message: 'ready', ...payload }),
    saveEndpoint: async (payload) => {
      calls.push(payload);
      return { result: { ok: true, code: 'ok', message: 'saved' }, snapshot };
    },
  });

  click(rootEl, 'validate');
  await new Promise((resolve) => setImmediate(resolve));
  click(rootEl, 'save');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, [{ engineType: 'ollama', apiUrl: 'http://127.0.0.1:11434' }]);
  assert.deepEqual(snapshots, [snapshot]);
});

test('endpoint scene ignores a stale validation response after disposal', async (t) => {
  let resolveValidation;
  const validation = new Promise((resolve) => { resolveValidation = resolve; });
  const { rootEl, scene } = mount(t, {
    validateEndpoint: async () => validation,
    saveEndpoint: async () => { throw new Error('must not save'); },
  });

  click(rootEl, 'validate');
  scene.dispose();
  resolveValidation({ ok: true, code: 'ok', message: 'late' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(rootEl.innerHTML.includes('Endpoint reachable'), false);
});

test('endpoint scene preserves the entered URL when saving fails', async (t) => {
  const { rootEl } = mount(t, {
    validateEndpoint: async () => ({ ok: true, code: 'ok', message: 'ready' }),
    saveEndpoint: async () => ({
      result: { ok: false, code: 'config_refresh_failed', message: 'Runtime refresh failed.', retryable: true },
      snapshot: null,
    }),
  });
  const url = rootEl.querySelector('#setup-endpoint-url');
  url.value = 'http://10.0.0.8:8033/v1';
  click(rootEl, 'validate');
  await new Promise((resolve) => setImmediate(resolve));
  click(rootEl, 'save');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(rootEl.querySelector('#setup-endpoint-url').value, 'http://10.0.0.8:8033/v1');
  assert.match(rootEl.textContent, /Runtime refresh failed/);
});

test('endpoint scene does not present a historical done step as current validation', (t) => {
  const { rootEl } = mount(t, {}, {
    state: { steps: { endpoint: 'done' }, readiness: { endpoint: { ready: false } } },
  });

  assert.equal(rootEl.textContent.includes('already detected'), false);
  assert.equal(rootEl.querySelector('[data-action="save"]').disabled, true);
});

test('editing a validated URL immediately invalidates the stale save authorization', async (t) => {
  const { rootEl } = mount(t, {
    validateEndpoint: async () => ({ ok: true, code: 'ok', message: 'ready' }),
  });
  click(rootEl, 'validate');
  await new Promise((resolve) => setImmediate(resolve));

  const url = rootEl.querySelector('#setup-endpoint-url');
  url.value = 'http://127.0.0.1:8000/v1';
  url.dispatchEvent(new url.ownerDocument.defaultView.Event('input', { bubbles: true }));

  assert.equal(rootEl.querySelector('[data-action="save"]').disabled, true);
  assert.equal(rootEl.querySelector('.setup-scene-result').hidden, true);
});

function heldSave() {
  const calls = [];
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  return {
    calls,
    release,
    service: {
      validateEndpoint: async () => ({ ok: true, code: 'ok', message: 'ready' }),
      saveEndpoint: async (payload) => {
        calls.push(payload);
        return held;
      },
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('a second Save click while a save is in flight does not start another save', async (t) => {
  const held = heldSave();
  const { rootEl } = mount(t, held.service);
  click(rootEl, 'validate');
  await flush();
  click(rootEl, 'save');
  click(rootEl, 'save');
  await flush();

  assert.equal(held.calls.length, 1);
  held.release({ result: { ok: true, code: 'ok', message: 'saved' }, snapshot: null });
  await flush();
});

test('Cancel and Skip do nothing while a save is in flight', async (t) => {
  const held = heldSave();
  const closes = [];
  const skips = [];
  const { rootEl } = mount(t, held.service, {
    closeModal: () => closes.push('close'),
    markStep: async (...args) => { skips.push(args); },
  });
  click(rootEl, 'validate');
  await flush();
  click(rootEl, 'save');
  click(rootEl, 'cancel');
  click(rootEl, 'skip');
  await flush();

  assert.deepEqual(closes, []);
  assert.deepEqual(skips, []);
  held.release({ result: { ok: true, code: 'ok', message: 'saved' }, snapshot: null });
  await flush();
  assert.deepEqual(closes, ['close'], 'the successful save closes the scene itself');
});

test('every control renders disabled while a save is in flight without the Validating spinner', async (t) => {
  const held = heldSave();
  const { rootEl } = mount(t, held.service);
  click(rootEl, 'validate');
  await flush();
  click(rootEl, 'save');

  for (const selector of [
    '#setup-endpoint-engine',
    '#setup-endpoint-url',
    '[data-action="validate"]',
    '[data-action="save"]',
    '[data-step-modal-action="cancel"]',
    '[data-step-modal-action="skip"]',
  ]) {
    const el = rootEl.querySelector(selector);
    assert.ok(el, `missing ${selector}`);
    assert.equal(el.disabled, true, `${selector} must be disabled while saving`);
  }
  assert.equal(rootEl.textContent.includes('Validating'), false);
  held.release({ result: { ok: false, code: 'x', message: 'nope' }, snapshot: null });
  await flush();
  assert.equal(rootEl.querySelector('[data-step-modal-action="cancel"]').disabled, false);
});

test('a save that resolves ok after the scene is disposed still applies the snapshot and toasts', async (t) => {
  const held = heldSave();
  const toasts = [];
  const closes = [];
  const { rootEl, scene, snapshots } = mount(t, held.service, {
    showToastMessage: (message) => toasts.push(message),
    closeModal: () => closes.push('close'),
  });
  click(rootEl, 'validate');
  await flush();
  click(rootEl, 'save');
  scene.dispose();
  const snapshot = { setupComplete: false, steps: { endpoint: 'done' } };
  held.release({ result: { ok: true, code: 'ok', message: 'saved' }, snapshot });
  await flush();

  assert.deepEqual(snapshots, [snapshot]);
  assert.deepEqual(toasts, ['Endpoint saved.']);
  assert.deepEqual(closes, []);
});
