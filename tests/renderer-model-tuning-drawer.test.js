'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const drawerFactory = require('../renderer/inventory/drawer');
const selectField = require('../renderer/inventory/select-field');
const textField = require('../renderer/inventory/text-field');
const actionButton = require('../renderer/inventory/action-button');
const { createModelTuningDrawerController } = require('../renderer/shell/renderer-model-tuning-drawer');

function createState() {
  return {
    contextLengthSteps: [4096, 8192],
    contextLengthByModel: { 'gemma3:latest': 4096 },
    ratioByModel: { 'gemma3:latest': 0.8 },
    generationProfilesByModel: { 'gemma3:latest': { temperature: 0.6 } },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('drawer scopes updates to one model and reports runtime acknowledgement', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  const calls = [];
  const windowRef = dom.window;
  windowRef.jennyShell = { modelTuning: {
    async getState() { return createState(); },
    async update(payload) { calls.push(payload); return { status: 'applied', state: createState() }; },
  } };
  const controller = createModelTuningDrawerController({
    state: { modelList: { data: [{ id: 'gemma3:latest', engine_type: 'ollama' }] } },
    windowRef, documentRef: windowRef.document, drawerFactory,
    inventory: { selectField, textField, actionButton },
  });
  await controller.open('gemma3:latest');
  const host = windowRef.document.getElementById('modelTuningDrawer');
  const temperature = host.querySelector('#modelTuningTemperature');
  temperature.value = '0.4';
  temperature.dispatchEvent(new windowRef.Event('input', { bubbles: true }));
  host.querySelector('[data-action="save-model-tuning"]').click();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].modelId, 'gemma3:latest');
  assert.equal(calls[0].generationProfile.temperature, 0.4);
  assert.match(host.textContent, /runtime acknowledged/i);
  controller.dispose();
});

test('drawer warns when an applied native context has unverified hardware fit', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  dom.window.jennyShell = { modelTuning: {
    async getState() { return createState(); },
    async update() {
      return {
        status: 'applied',
        preflight: { warning: 'hardware_fit_unverified' },
        state: createState(),
      };
    },
  } };
  const controller = createModelTuningDrawerController({
    state: { modelList: { data: [{ id: 'gemma3:latest', engine_type: 'ollama' }] } },
    windowRef: dom.window, documentRef: dom.window.document, drawerFactory,
    inventory: { selectField, textField, actionButton },
  });

  await controller.open('gemma3:latest');
  const temperature = dom.window.document.querySelector('[data-model-tuning-field="temperature"]');
  temperature.value = '0.7';
  temperature.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('[data-action="save-model-tuning"]').click();
  await new Promise((resolve) => setTimeout(resolve, 10));

  const host = dom.window.document.getElementById('modelTuningDrawer');
  assert.match(host.textContent, /could not independently verify RAM or VRAM fit/i);
  controller.dispose();
});

test('drawer explains an applied estimated hardware fit', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  dom.window.jennyShell = { modelTuning: {
    async getState() { return createState(); },
    async update() {
      return {
        status: 'applied',
        preflight: { warning: 'hardware_fit_estimated' },
        state: createState(),
      };
    },
  } };
  const controller = createModelTuningDrawerController({
    state: { modelList: { data: [{ id: 'gemma3:latest', engine_type: 'ollama' }] } },
    windowRef: dom.window, documentRef: dom.window.document, drawerFactory,
    inventory: { selectField, textField, actionButton },
  });

  await controller.open('gemma3:latest');
  const temperature = dom.window.document.querySelector('[data-model-tuning-field="temperature"]');
  temperature.value = '0.7';
  temperature.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('[data-action="save-model-tuning"]').click();
  await new Promise((resolve) => setTimeout(resolve, 10));

  const host = dom.window.document.getElementById('modelTuningDrawer');
  assert.match(host.textContent, /Fit estimated from model size and your hardware; not yet measured on this machine/i);
  controller.dispose();
});

test('dispose fences a delayed hydration result and removes the host', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  let release;
  const delayed = new Promise((resolve) => { release = resolve; });
  dom.window.jennyShell = { modelTuning: { getState: () => delayed } };
  const controller = createModelTuningDrawerController({
    windowRef: dom.window, documentRef: dom.window.document, drawerFactory,
    inventory: { selectField, textField, actionButton },
  });
  const openPromise = controller.open('gemma3:latest');
  controller.dispose();
  release(createState());
  assert.equal(await openPromise, false);
  assert.equal(dom.window.document.getElementById('modelTuningDrawer'), null);
});

test('drawer hides provider-owned controls for unsupported engines', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  dom.window.jennyShell = { modelTuning: { async getState() { return createState(); } } };
  const controller = createModelTuningDrawerController({
    state: { status: { model: 'cloud-model', engine: 'codex-cli' } },
    windowRef: dom.window, documentRef: dom.window.document, drawerFactory,
    inventory: { selectField, textField, actionButton },
  });
  await controller.open('cloud-model');
  const host = dom.window.document.getElementById('modelTuningDrawer');
  assert.match(host.textContent, /engine owns its generation controls/i);
  assert.equal(host.querySelector('[data-action="save-model-tuning"]'), null);
  controller.dispose();
});

test('drawer keeps generation tuning but hides unsupported runtime context controls', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  dom.window.jennyShell = { modelTuning: { async getState() { return createState(); } } };
  const controller = createModelTuningDrawerController({
    state: { status: { model: 'gemma3:latest', engine: 'vllm' } },
    windowRef: dom.window, documentRef: dom.window.document, drawerFactory,
    inventory: { selectField, textField, actionButton },
  });
  await controller.open('gemma3:latest');
  const host = dom.window.document.getElementById('modelTuningDrawer');
  assert.equal(host.querySelector('#modelTuningContextLength'), null);
  assert.ok(host.querySelector('#modelTuningTemperature'));
  controller.dispose();
});

test('unknown engine disables tuning until Re-check resolves a late model entry', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  const state = { modelList: { data: [] } };
  dom.window.jennyShell = { modelTuning: { async getState() { return createState(); } } };
  const controller = createModelTuningDrawerController({
    state,
    windowRef: dom.window, documentRef: dom.window.document, drawerFactory,
    inventory: { selectField, textField, actionButton },
  });

  await controller.open('gemma3:latest');
  const host = dom.window.document.getElementById('modelTuningDrawer');
  assert.match(host.textContent, /Jenny can't verify this model's engine yet, so tuning is paused\./);
  assert.ok(host.querySelector('#modelTuningContextLength'));
  assert.ok(Array.from(host.querySelectorAll('input, select')).every((field) => field.disabled));
  assert.equal(host.querySelector('[data-action="save-model-tuning"]').disabled, true);
  assert.equal(host.querySelector('[data-action="reset-model-tuning"]').disabled, true);

  state.modelList.data.push({ id: 'gemma3:latest', engine_type: 'ollama' });
  host.querySelector('[data-action="recheck-model-tuning-engine"]').click();

  assert.doesNotMatch(host.textContent, /tuning is paused/);
  assert.ok(Array.from(host.querySelectorAll('input, select')).every((field) => !field.disabled));
  assert.equal(host.querySelector('[data-action="save-model-tuning"]').disabled, true);
  assert.equal(host.querySelector('[data-action="reset-model-tuning"]').disabled, false);
  const temperature = host.querySelector('[data-model-tuning-field="temperature"]');
  temperature.value = '0.7';
  temperature.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(host.querySelector('[data-action="save-model-tuning"]').disabled, false);
  controller.dispose();
});

test('generation-only save omits unchanged ratio and context length', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  const calls = [];
  dom.window.jennyShell = { modelTuning: {
    async getState() { return createState(); },
    async update(payload) { calls.push(payload); return { status: 'applied', state: createState() }; },
  } };
  const controller = createModelTuningDrawerController({
    state: { status: { model: 'gemma3:latest', engine: 'ollama' } },
    windowRef: dom.window, documentRef: dom.window.document, drawerFactory,
    inventory: { selectField, textField, actionButton },
  });

  await controller.open('gemma3:latest');
  const host = dom.window.document.getElementById('modelTuningDrawer');
  const temperature = host.querySelector('#modelTuningTemperature');
  temperature.value = '0.4';
  temperature.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  host.querySelector('[data-action="save-model-tuning"]').click();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].generationProfile.temperature, 0.4);
  assert.equal(Object.hasOwn(calls[0], 'ratio'), false);
  assert.equal(Object.hasOwn(calls[0], 'contextLength'), false);
  controller.dispose();
});

test('ratio-changed save includes ratio without unchanged context length', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  const calls = [];
  dom.window.jennyShell = { modelTuning: {
    async getState() { return createState(); },
    async update(payload) { calls.push(payload); return { status: 'applied', state: createState() }; },
  } };
  const controller = createModelTuningDrawerController({
    state: { status: { model: 'gemma3:latest', engine: 'ollama' } },
    windowRef: dom.window, documentRef: dom.window.document, drawerFactory,
    inventory: { selectField, textField, actionButton },
  });

  await controller.open('gemma3:latest');
  const host = dom.window.document.getElementById('modelTuningDrawer');
  const ratio = host.querySelector('#modelTuningRatio');
  ratio.value = '0.7';
  ratio.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  host.querySelector('[data-action="save-model-tuning"]').click();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].ratio, 0.7);
  assert.equal(Object.hasOwn(calls[0], 'contextLength'), false);
  controller.dispose();
});

test('close fences delayed hydration and preserves the original focus target', async () => {
  const dom = new JSDOM('<!doctype html><body><button id="return">Tune</button></body>', { url: 'http://localhost/' });
  const request = deferred();
  dom.window.jennyShell = { modelTuning: { getState: () => request.promise } };
  const returnButton = dom.window.document.getElementById('return');
  returnButton.focus();
  const controller = createModelTuningDrawerController({
    windowRef: dom.window, documentRef: dom.window.document, drawerFactory,
    inventory: { selectField, textField, actionButton },
  });
  const openPromise = controller.open('gemma3:latest', returnButton);
  controller.close();
  request.resolve(createState());
  assert.equal(await openPromise, false);
  assert.equal(dom.window.document.getElementById('modelTuningDrawer').hidden, true);
  assert.equal(dom.window.document.activeElement, returnButton);
  controller.dispose();
});

test('a delayed apply cannot report an old model result on a newly selected model', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  const updateRequest = deferred();
  dom.window.jennyShell = { modelTuning: {
    async getState() { return createState(); },
    update: () => updateRequest.promise,
  } };
  const controller = createModelTuningDrawerController({
    windowRef: dom.window, documentRef: dom.window.document, drawerFactory,
    inventory: { selectField, textField, actionButton },
  });
  await controller.open('gemma3:latest');
  const temperature = dom.window.document.querySelector('[data-model-tuning-field="temperature"]');
  temperature.value = '0.7';
  temperature.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('[data-action="save-model-tuning"]').click();
  await controller.open('other-model:latest');
  updateRequest.resolve({
    status: 'rejected', reason: '<img src=x onerror=alert(1)>', state: createState(),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const host = dom.window.document.getElementById('modelTuningDrawer');
  assert.match(host.textContent, /Tune other-model:latest/);
  assert.doesNotMatch(host.innerHTML, /<img/);
  assert.doesNotMatch(host.textContent, /Not applied/);
  controller.dispose();
});

test('drawer renders grouped bounded controls and tracks dirty fields without moving focus', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  const state = {
    ...createState(),
    generationProfileBounds: {
      temperature: { min: 0.2, max: 1.8, integer: false },
      topP: { min: 0, max: 1, integer: false },
      topK: { min: 1, max: 99, integer: true },
      minP: { min: 0.05, max: 0.9, integer: false },
      repetitionPenalty: { min: 0.5, max: 1.5, integer: false },
      presencePenalty: { min: -1, max: 1, integer: false },
      maxOutputTokens: { min: 32, max: 4096, integer: true },
    },
  };
  dom.window.jennyShell = { modelTuning: { async getState() { return state; } } };
  const controller = createModelTuningDrawerController({
    state: { modelList: { data: [{ id: 'gemma3:latest', engine_type: 'ollama' }] } },
    windowRef: dom.window, documentRef: dom.window.document, drawerFactory,
    inventory: { selectField, textField, actionButton },
  });

  await controller.open('gemma3:latest', null, { displayName: 'Gemma 3' });
  const host = dom.window.document.getElementById('modelTuningDrawer');
  assert.deepEqual(
    Array.from(host.querySelectorAll('.model-tuning-section-title'), (node) => node.textContent),
    ['Context and memory', 'Sampling', 'Repetition and length']
  );
  assert.equal(host.querySelector('#modelTuningDrawerTitle').textContent, 'Tune Gemma 3');
  assert.match(host.querySelector('.model-tuning-drawer-subtitle').textContent, /gemma3:latest · Ollama · applies after the runtime confirms/);

  const expectedBounds = {
    temperature: ['0.2', '1.8', '0.01'],
    topP: ['0', '1', '0.01'],
    topK: ['1', '99', '1'],
    minP: ['0.05', '0.9', '0.01'],
    repetitionPenalty: ['0.5', '1.5', '0.01'],
    presencePenalty: ['-1', '1', '0.01'],
    // Integer fields step by 1: a numeric input takes its step base from min,
    // so any wider step would make round values (4096) step-mismatched.
    maxOutputTokens: ['32', '4096', '1'],
  };
  Object.entries(expectedBounds).forEach(([field, expected]) => {
    const input = host.querySelector(`[data-model-tuning-field="${field}"]`);
    assert.deepEqual([input.min, input.max, input.step], expected);
  });
  assert.equal(host.querySelector('#modelTuningRatio').min, '0.1');
  assert.equal(host.querySelector('#modelTuningRatio').max, '0.99');
  assert.equal(host.querySelector('#modelTuningRatio').step, '0.01');
  assert.equal(
    host.querySelector('[data-model-tuning-row="temperature"] .model-tuning-row-range').textContent,
    'range 0.2–1.8'
  );

  const applyButton = host.querySelector('[data-action="save-model-tuning"]');
  assert.equal(applyButton.textContent, 'Apply 0 changes');
  assert.equal(applyButton.disabled, true);
  const temperature = host.querySelector('[data-model-tuning-field="temperature"]');
  temperature.focus();
  const focused = dom.window.document.activeElement;
  temperature.value = '0.7';
  temperature.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(applyButton.textContent, 'Apply 1 change');
  assert.equal(applyButton.disabled, false);
  assert.equal(
    host.querySelector('[data-model-tuning-row="temperature"] .model-tuning-row-range').dataset.dirty,
    'true'
  );
  assert.equal(dom.window.document.activeElement, focused);
  controller.dispose();
});

test('close fences delayed hydration and preserves the original focus target', async () => {
  const dom = new JSDOM('<!doctype html><body><button id="return">Tune</button></body>', { url: 'http://localhost/' });
  const request = deferred();
  dom.window.jennyShell = { modelTuning: { getState: () => request.promise } };
  const returnButton = dom.window.document.getElementById('return');
  returnButton.focus();
  const controller = createModelTuningDrawerController({
    windowRef: dom.window, documentRef: dom.window.document, drawerFactory,
    inventory: { selectField, textField, actionButton },
  });
  const openPromise = controller.open('gemma3:latest', returnButton);
  controller.close();
  request.resolve(createState());
  assert.equal(await openPromise, false);
  assert.equal(dom.window.document.getElementById('modelTuningDrawer').hidden, true);
  assert.equal(dom.window.document.activeElement, returnButton);
  controller.dispose();
});

test('a delayed apply cannot report an old model result on a newly selected model', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  const updateRequest = deferred();
  dom.window.jennyShell = { modelTuning: {
    async getState() { return createState(); },
    update: () => updateRequest.promise,
  } };
  const controller = createModelTuningDrawerController({
    windowRef: dom.window, documentRef: dom.window.document, drawerFactory,
    inventory: { selectField, textField, actionButton },
  });
  await controller.open('gemma3:latest');
  const temperature = dom.window.document.querySelector('[data-model-tuning-field="temperature"]');
  temperature.value = '0.7';
  temperature.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('[data-action="save-model-tuning"]').click();
  await controller.open('other-model:latest');
  updateRequest.resolve({
    status: 'rejected', reason: '<img src=x onerror=alert(1)>', state: createState(),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const host = dom.window.document.getElementById('modelTuningDrawer');
  assert.match(host.textContent, /Tune other-model:latest/);
  assert.doesNotMatch(host.innerHTML, /<img/);
  assert.doesNotMatch(host.textContent, /Not applied/);
  controller.dispose();
});
