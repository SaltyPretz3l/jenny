'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const drawerFactory = require('../renderer/inventory/drawer');
const selectField = require('../renderer/inventory/select-field');
const textField = require('../renderer/inventory/text-field');
const actionButton = require('../renderer/inventory/action-button');
const segmentedControl = require('../renderer/inventory/segmented-control');
const toggleSwitch = require('../renderer/inventory/toggle-switch');
const { createModelTuningDrawerController } = require('../renderer/shell/renderer-model-tuning-drawer');

function tuningState(contextLength = 4096) {
  return {
    contextLengthSteps: [4096, 8192],
    contextLengthByModel: { 'gemma3:latest': contextLength },
    ratioByModel: { 'gemma3:latest': 0.8 },
    generationProfilesByModel: { 'gemma3:latest': { temperature: 0.6 } },
  };
}

function managedSettings() {
  return {
    localEngines: { openaiCompatible: { managed: { enabled: true, perModel: {
      'gemma3-latest': {
        engine: 'llama-server', tag: 'gemma3:latest', modelPath: 'G:\\models\\gemma3.gguf', mtp: { mode: 'off' },
      },
    } } } },
    accelerationCatalog: { defaults: { vramHeadroomMb: 2048 }, families: [] },
  };
}

function createHarness(options = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  const restartCalls = [];
  const confirmCalls = [];
  const tuningCalls = [];
  const engineType = options.engineType || 'openai-compatible';
  const status = options.status || { ok: true, state: 'ready', alias: 'gemma3', port: 8033 };
  const restart = options.restart || (async (...args) => {
    restartCalls.push(args);
    return { ok: true, state: 'ready', alias: 'gemma3', port: 8033 };
  });
  dom.window.jennyShell = {
    modelTuning: {
      async getState() { return tuningState(); },
      async update(payload) {
        tuningCalls.push(payload);
        return options.updateResult || { status: 'applied', state: tuningState(8192) };
      },
    },
    engines: {
      async getSettings() { return managedSettings(); },
      async updateSettings() { return { ok: true, localEngines: managedSettings().localEngines }; },
    },
    llamaServer: {
      async listLocalGgufs() { return { ok: true, entries: [] }; },
      async getStatus() { return status; },
      restart: async (...args) => restart(...args),
    },
  };
  const controller = createModelTuningDrawerController({
    state: {
      features: { featureFlags: { llama_server_acceleration: options.engineSection !== false } },
      modelList: { data: [{ id: 'gemma3:latest', engine_type: engineType }] },
    },
    windowRef: dom.window,
    documentRef: dom.window.document,
    drawerFactory,
    inventory: { selectField, textField, actionButton, segmentedControl, toggleSwitch },
    getStreamingSessionIds: () => options.streamingSessionIds || [],
    confirmDialog: {
      async confirm(spec) {
        confirmCalls.push(spec);
        return options.confirmResult === true;
      },
    },
  });
  return { dom, controller, restartCalls, confirmCalls, tuningCalls };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail('condition was not reached');
}

async function applyContext(harness) {
  await harness.controller.open('gemma3:latest');
  const host = harness.dom.window.document.getElementById('modelTuningDrawer');
  const context = host.querySelector('#modelTuningContextLength');
  context.value = '8192';
  context.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
  host.querySelector('[data-action="save-model-tuning"]').click();
  await waitFor(() => harness.tuningCalls.length === 1
    && !/Applying|Restarting/.test(host.querySelector('.model-tuning-drawer-status').textContent));
  return host;
}

test('context window renders for openai-compatible and Ollama, but not unsupported engines', async () => {
  for (const [engineType, expected] of [['openai-compatible', true], ['ollama', true], ['vllm', false]]) {
    const harness = createHarness({ engineType, engineSection: false });
    await harness.controller.open('gemma3:latest');
    assert.equal(Boolean(harness.dom.window.document.querySelector('#modelTuningContextLength')), expected, engineType);
    harness.controller.dispose();
  }
});

test('a serving managed model restarts once without arguments and reports the live context', async () => {
  const harness = createHarness();
  const host = await applyContext(harness);

  assert.equal(harness.restartCalls.length, 1);
  assert.deepEqual(harness.restartCalls[0], []);
  assert.match(host.querySelector('.model-tuning-drawer-status').textContent, /new context window is live/i);
  harness.controller.dispose();
});

test('a live stream requires confirmation and Not now defers the saved context', async () => {
  const harness = createHarness({ streamingSessionIds: ['session-1'], confirmResult: false });
  const host = await applyContext(harness);

  assert.equal(harness.confirmCalls.length, 1);
  assert.deepEqual(harness.confirmCalls[0], {
    title: 'Restart llama-server?',
    message: 'A chat is still streaming. Restarting llama-server will end that response. The new context window only takes effect after a restart.',
    confirmLabel: 'Restart anyway',
    cancelLabel: 'Not now',
    variant: 'danger',
  });
  assert.equal(harness.restartCalls.length, 0);
  assert.match(host.querySelector('.model-tuning-drawer-status').textContent, /take effect on the next llama-server restart/i);
  harness.controller.dispose();
});

test('Restart anyway confirms the plural warning and restarts the server', async () => {
  const harness = createHarness({ streamingSessionIds: ['session-1', 'session-2'], confirmResult: true });
  await applyContext(harness);

  assert.match(harness.confirmCalls[0].message, /^2 chats are still streaming\./);
  assert.match(harness.confirmCalls[0].message, /end those responses\./);
  assert.equal(harness.restartCalls.length, 1);
  assert.deepEqual(harness.restartCalls[0], []);
  harness.controller.dispose();
});

test('a context change does not restart a server that is not serving this model', async () => {
  const harness = createHarness({ status: { ok: true, state: 'ready', alias: 'other:model', port: 8033 } });
  const host = await applyContext(harness);

  assert.equal(harness.restartCalls.length, 0);
  assert.equal(harness.confirmCalls.length, 0);
  assert.match(host.querySelector('.model-tuning-drawer-status').textContent, /next time llama-server starts/i);
  harness.controller.dispose();
});

// update() resolves with an object for every outcome; only 'applied' wrote the
// setting, so anything else must neither restart the server nor claim success.
test('a rejected context update never restarts and keeps the rejection message', async () => {
  for (const reason of ['unsupported_context_control', 'active_stream']) {
    const harness = createHarness({ updateResult: { status: 'rejected', reason } });
    const host = await applyContext(harness);

    assert.equal(harness.restartCalls.length, 0, reason);
    assert.equal(harness.confirmCalls.length, 0, reason);
    const status = host.querySelector('.model-tuning-drawer-status').textContent;
    assert.doesNotMatch(status, /is live|next time llama-server starts/i, reason);
    assert.match(status, reason === 'active_stream'
      ? /^Finish the current reply first, then Apply again\.$/ : /^Not applied/, reason);
    harness.controller.dispose();
  }
});

// F31: an Apply refused while an image render holds the GPU must say why and
// keep the pending change in the open drawer, so Apply can simply be pressed
// again after the render (never a silent re-render back to the saved value).
test('an Apply refused while an image holds the GPU names the reason and keeps the draft', async () => {
  const harness = createHarness({
    status: { ok: false, state: 'stopped', lastError: 'gpu_lease_held' },
    streamingSessionIds: ['session-1'],
    updateResult: { status: 'rejected', reason: 'gpu_lease_held', state: tuningState() },
  });
  const host = await applyContext(harness);

  assert.equal(harness.restartCalls.length, 0);
  assert.equal(harness.confirmCalls.length, 0);
  assert.ok(host.querySelector('.inv-drawer-panel'), 'the drawer stays open');
  assert.equal(host.querySelector('.model-tuning-drawer-status').textContent,
    'An image is being drawn. Apply again when it finishes.');
  assert.equal(host.querySelector('#modelTuningContextLength').value, '8192', 'the pending change survives the refusal');
  const save = host.querySelector('[data-action="save-model-tuning"]');
  assert.equal(save.textContent, 'Apply 1 change');
  assert.equal(save.disabled, false);
  harness.controller.dispose();
});

// Gate re-run 2026-10-02: "Finish the current reply first, then Apply again"
// must leave the change to apply again, like the image-render refusal.
test('an Apply refused during a streaming reply keeps the draft', async () => {
  const harness = createHarness({
    streamingSessionIds: ['session-1'],
    updateResult: { status: 'rejected', reason: 'active_stream', state: tuningState() },
  });
  const host = await applyContext(harness);

  assert.equal(harness.restartCalls.length, 0);
  assert.equal(host.querySelector('.model-tuning-drawer-status').textContent,
    'Finish the current reply first, then Apply again.');
  assert.equal(host.querySelector('#modelTuningContextLength').value, '8192', 'the pending change survives the refusal');
  assert.equal(host.querySelector('[data-action="save-model-tuning"]').textContent, 'Apply 1 change');
  harness.controller.dispose();
});

test('a rejected restart reports failure and releases the pending latch', async () => {
  const harness = createHarness({
    restart: async (...args) => {
      harness.restartCalls.push(args);
      throw new Error('launch failed');
    },
  });
  const host = await applyContext(harness);
  const statusText = host.querySelector('.model-tuning-drawer-status').textContent;

  assert.match(statusText, /llama-server restart failed/i);
  assert.doesNotMatch(statusText, /context window is live/i);
  const temperature = host.querySelector('#modelTuningTemperature');
  temperature.value = '0.7';
  temperature.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
  assert.equal(host.querySelector('[data-action="save-model-tuning"]').disabled, false);
  harness.controller.dispose();
});
