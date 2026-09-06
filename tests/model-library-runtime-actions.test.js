'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createModelLibraryRuntimeActions,
} = require('../renderer/shell/model-library/model-library-runtime-actions');

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function harness(t, model) {
  const loads = [];
  const statuses = [];
  const windowRef = {
    setTimeout,
    clearTimeout,
    jennyShell: {
      models: {
        load: async (payload) => {
          loads.push(payload);
          return { status: 'ok' };
        },
      },
      offline: {
        updateSettings: async (payload) => payload,
      },
    },
  };
  const actions = createModelLibraryRuntimeActions({
    windowRef,
    state: { offline: {} },
    findModel: () => model,
    activeModel: () => '',
    refresh: async () => null,
    refreshModelPickers: async () => null,
    render: () => {},
    setStatusMessage: (message) => statuses.push(message),
    showToastMessage: () => {},
    appendClientLog: () => {},
  });
  t.after(() => actions.dispose());
  return { actions, loads, statuses };
}

test('Use starts a selected llama-server model through openai-compatible', async (t) => {
  const h = harness(t, {
    key: 'gemma4:12b',
    tag: 'gemma4:12b',
    engineType: 'ollama',
    selectedEngine: 'llama-server',
  });

  h.actions.handleUse('gemma4:12b');
  assert.equal(h.statuses[0], 'Starting llama-server for "gemma4:12b"…');
  await flush();

  assert.deepEqual(h.loads, [{ model: 'gemma4:12b', engine_type: 'openai-compatible' }]);
});

test('Use sends an explicit Ollama hint for an available selected Ollama engine', async (t) => {
  const h = harness(t, {
    key: 'gemma4:12b',
    tag: 'gemma4:12b',
    engineType: 'openai-compatible',
    selectedEngine: 'ollama',
    engines: { ollama: { available: true } },
  });

  h.actions.handleUse('gemma4:12b');
  await flush();

  assert.deepEqual(h.loads, [{ model: 'gemma4:12b', engine_type: 'ollama' }]);
});

test('Use preserves the legacy engineType payload when selectedEngine is absent', async (t) => {
  const h = harness(t, {
    key: 'hosted:model',
    tag: 'hosted:model',
    engineType: 'plugin_host',
  });

  h.actions.handleUse('hosted:model');
  await flush();

  assert.deepEqual(h.loads, [{ model: 'hosted:model', engine_type: 'plugin_host' }]);
});
