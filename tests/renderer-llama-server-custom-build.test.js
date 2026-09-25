'use strict';

// A per-model llama-server build, outside the Tune drawer (W4c): the health
// popover's ready line names a custom build, and the launch-failure codes map
// to copy that names the fix (card status line after a failed Use).

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPopoverMarkup } = require('../renderer/shell/renderer-health-pill-markup-utils');
const formatUtils = require('../renderer/shell/renderer-model-library-format-utils');
const {
  createModelLibraryRuntimeActions,
} = require('../renderer/shell/model-library/model-library-runtime-actions');

const TAG = 'ternary-bonsai-2-27b-pq2_0';
// Main's token names the build tag it derived from the folder (b\d{3,9}), or 'runtime'.
const MISSING = `Could not start ${TAG}: its llama-server build (b10683) is missing. Choose a build in Tune.`;
const MISSING_UNNAMED = `Could not start ${TAG}: its llama-server build is missing. Choose a build in Tune.`;
const BUNDLED_CANT_READ = `Could not start ${TAG}: the bundled llama-server can't read this file's format. Choose a build that can in Tune.`;
const BUILD_CANT_READ = `Could not start ${TAG}: its llama-server build can't read this file's format. Choose a build that can in Tune.`;

function llamaServerLine(facet) {
  const html = buildPopoverMarkup(
    { error: '', toneLabel: { tone: 'success', label: 'Healthy' } },
    { runtime: { lifecycle: { available: true, state: 'ready', phase: 'ready' }, llama_server: facet } },
    {}
  );
  const match = /llama-server · <em>([^<]*)<\/em>/.exec(html);
  return match ? match[1] : null;
}

test('the popover ready line gains the build suffix only for a build label', () => {
  const ready = { state: 'ready', alias: TAG, port: 8093, acceleration_mode: 'off' };
  assert.equal(llamaServerLine({ ...ready, runtime_label: 'build 10683' }), `serving ${TAG} on :8093 · build 10683`);
  assert.equal(llamaServerLine({ ...ready, acceleration_mode: 'mtp', runtime_label: 'build 10683' }),
    `serving ${TAG} on :8093 · mtp · build 10683`, 'the suffix follows the mode');
  for (const build of ['1', '999999999']) {
    assert.equal(llamaServerLine({ ...ready, runtime_label: `build ${build}` }), `serving ${TAG} on :8093 · build ${build}`);
  }
  // A build number is 1-9 digits with no leading zero: "build 0" or a zero-padded echo is not one.
  const labels = ['bundled', 'env', 'custom', 'unknown', '', undefined, null, 'build', 'build x', 'build 1234567890',
    'rebuild 10683', 'build 10683 ', ['build 10683'], 'build 0', 'build 00', 'build 010683'];
  for (const runtimeLabel of labels) {
    assert.equal(llamaServerLine({ ...ready, runtime_label: runtimeLabel }), `serving ${TAG} on :8093`, String(runtimeLabel));
  }
  // Only the ready line: failures keep today's raw code (Do not change).
  assert.equal(llamaServerLine({
    state: 'stopped', alias: TAG, port: 8093, last_error: 'llama_server_model_unsupported:custom', runtime_label: 'build 10683',
  }), `failed to start (${TAG}): llama_server_model_unsupported:custom`);
  assert.equal(llamaServerLine({ state: 'crashed', alias: TAG, port: 8093, runtime_label: 'build 10683' }),
    `stopped unexpectedly (${TAG})`);
});

test('llamaServerFailureText maps the three launch codes and passes everything else through', () => {
  const { llamaServerFailureText } = formatUtils;
  assert.equal(typeof llamaServerFailureText, 'function');
  assert.equal(llamaServerFailureText('llama_server_runtime_missing:b10683', TAG), MISSING);
  assert.equal(llamaServerFailureText('llama_server_runtime_missing:runtime', TAG), MISSING_UNNAMED, 'no build tag, no folder');
  assert.equal(llamaServerFailureText('llama_server_model_unsupported:bundled', TAG), BUNDLED_CANT_READ);
  assert.equal(llamaServerFailureText('llama_server_model_unsupported:custom', TAG), BUILD_CANT_READ);
  assert.equal(llamaServerFailureText('llama_server_runtime_missing:b123456789', 'gemma4:12b'),
    'Could not start gemma4:12b: its llama-server build (b123456789) is missing. Choose a build in Tune.');
  assert.equal(llamaServerFailureText('llama_server_runtime_missing:b10683', '{folder}'),
    'Could not start {folder}: its llama-server build (b10683) is missing. Choose a build in Tune.', 'never re-interpolated');
  // The raw message as a failed Use delivers it: wrapped by the backend, then by IPC.
  const wrapped = `Error invoking remote method 'models:load': Error: Could not start llama-server for "${TAG}": `;
  assert.equal(llamaServerFailureText(wrapped + 'llama_server_model_unsupported:bundled', TAG), BUNDLED_CANT_READ);
  assert.equal(llamaServerFailureText(wrapped + 'llama_server_runtime_missing:b10683', TAG), MISSING);
  // Whatever trails the token never reaches the copy.
  for (const trailer of ['. Retry later', ' (C:\\Users\\me\\x)', '<img src=x>', '"; drop', '\nstack', '-cuda13.3']) {
    assert.equal(llamaServerFailureText('llama_server_runtime_missing:b10683' + trailer, TAG), MISSING, trailer);
    assert.equal(llamaServerFailureText('llama_server_runtime_missing:runtime' + trailer, TAG), MISSING_UNNAMED, trailer);
  }
  assert.equal(llamaServerFailureText('llama_server_runtime_missing:runtime llama_server_model_unsupported:bundled', TAG),
    MISSING_UNNAMED, 'a second code is not a folder');
  const others = [
    'child_exited_before_ready', wrapped + 'child_exited_before_ready', 'llama_server_exited:1',
    'llama_server_binary_not_found', 'llama_server_runtime_missing:', 'llama_server_runtime_missing:   ',
    // Only main's tokens: folder text (the old token), short/long/foreign tags and glued suffixes are not.
    'llama_server_runtime_missing:llama-prism-b10683-cuda13.3', 'llama_server_runtime_missing:llama-b10683',
    'llama_server_runtime_missing:b12', 'llama_server_runtime_missing:b1234567890', 'llama_server_runtime_missing:B10683',
    'llama_server_runtime_missing:b10683x', 'llama_server_runtime_missing:b10683_x', 'llama_server_runtime_missing:runtimes',
    'llama_server_runtime_missing:runtime_x', 'llama_server_runtime_missing:.', 'llama_server_runtime_missing:...',
    'llama_server_runtime_missing: b10683', 'xllama_server_runtime_missing:b10683',
    'llama_server_model_unsupported:',
    'llama_server_model_unsupported:other', 'llama_server_model_unsupported:bundledx',
    'xllama_server_model_unsupported:bundled', '', null, undefined, 42, {},
  ];
  for (const message of others) {
    assert.equal(llamaServerFailureText(message, TAG), null, String(message));
  }
});

function runtimeHarness(t, loadError) {
  const statuses = [];
  const logs = [];
  const windowRef = {
    setTimeout,
    clearTimeout,
    jennyShell: {
      models: { load: async () => { throw loadError; } },
      offline: { updateSettings: async (payload) => payload },
    },
  };
  const actions = createModelLibraryRuntimeActions({
    windowRef,
    state: { offline: {} },
    findModel: () => ({ key: TAG, tag: TAG, engineType: 'openai-compatible', selectedEngine: 'llama-server' }),
    activeModel: () => '',
    refresh: async () => null,
    refreshModelPickers: async () => null,
    render: () => {},
    setStatusMessage: (message) => statuses.push(message),
    showToastMessage: () => {},
    appendClientLog: (level, event, details) => logs.push({ level, event, details }),
  });
  t.after(() => actions.dispose());
  return { actions, statuses, logs };
}

async function flush() {
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('a failed Use leads with the fix-it copy for a launch code and keeps the bounded message otherwise', async (t) => {
  const coded = runtimeHarness(t, new Error(
    `Error invoking remote method 'models:load': Error: Could not start llama-server for "${TAG}": llama_server_runtime_missing:b10683`
  ));
  coded.actions.handleUse(TAG);
  await flush();
  assert.equal(coded.actions.activationState().message, MISSING, 'the card note');
  assert.equal(coded.statuses.at(-1), MISSING, 'the section status line');
  assert.equal(coded.logs.find((entry) => entry.event === 'model_library.activate_failed')?.details.message, MISSING);

  const plain = runtimeHarness(t, new Error('Engine refused C:\\Users\\me\\model.gguf token=abc123'));
  plain.actions.handleUse(TAG);
  await flush();
  assert.equal(plain.actions.activationState().message, 'Engine refused [local path] token=[redacted]');
});
