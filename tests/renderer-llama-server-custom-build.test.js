'use strict';

// A per-model llama-server build, outside the Tune drawer (W4c): the health
// popover's ready line names a custom build, and the launch-failure codes map
// to copy that names the fix (card status line after a failed Use).

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { buildPopoverMarkup } = require('../renderer/shell/renderer-health-pill-markup-utils');
const formatUtils = require('../renderer/shell/renderer-model-library-format-utils');
const libraryView = require('../renderer/shell/model-library/model-library-view');
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

test('boundedErrorMessage drops Electron\'s IPC wrapper; a wrapper with nothing after it is the fallback', () => {
  const { boundedErrorMessage } = formatUtils;
  assert.equal(boundedErrorMessage(new Error("Error invoking remote method 'models.use': Error: The model could not load."), 'fb'), 'The model could not load.');
  assert.equal(boundedErrorMessage(new Error("Error invoking remote method 'models.use': TypeError: bad"), 'fb'), 'bad');
  assert.equal(boundedErrorMessage(new Error("Error invoking remote method 'models.use': "), 'fb'), 'fb');
  assert.equal(boundedErrorMessage(new Error('Plain failure'), 'fb'), 'Plain failure', 'no wrapper: unchanged');
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

// ---- Row 142: "Use build N" under a failed Use ----

const UNSUPPORTED = new Error(`Error invoking remote method 'models:load': Error: Could not start llama-server for "${TAG}": llama_server_model_unsupported:bundled`);
const TWO = {
  ok: true,
  current: { source: 'bundled', build: 11513, label: 'bundled' },
  candidates: [
    { id: 'opt-a', build: 12098, label: 'llama-b12098-cuda13.4', reads: 'yes' },
    // Main never offers the build that just failed (here the bundled one).
    { id: 'opt-b', build: 11950, label: 'llama-b11950', reads: 'unknown' },
  ],
  download: null,
};
const NONE = { ...TWO, candidates: [], architecture: 'lfm3', download: { build: 12098, sizeBytes: 140e6 } };

function gate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

// answers: runtimeOptions answers in order (the last repeats). loads: what each models.load does, in order.
function rowHarness(t, { answers = [TWO], loads = [], use = async () => ({ ok: true, build: 12098 }), extraBridge = {}, engine = 'llama-server' } = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="rows"></div></body>', { url: 'http://localhost/' });
  const calls = { options: [], use: [], load: [], render: 0 };
  const timers = [];
  dom.window.setInterval = (fn) => { timers.push(fn); return timers.length; };
  dom.window.clearInterval = (id) => { timers[id - 1] = null; };
  const queue = answers.slice();
  const model = { key: TAG, tag: TAG, displayName: 'Bonsai', engineType: 'openai-compatible', selectedEngine: engine, installed: true, libraryGguf: true };
  const loadQueue = loads.slice();
  dom.window.jennyShell = {
    models: {
      load: async (payload) => {
        calls.load.push(payload);
        const next = loadQueue.shift();
        if (next instanceof Error) throw next;
        return next ? next() : {};
      },
    },
    offline: { updateSettings: async (payload) => payload },
    llamaServer: {
      async runtimeOptions(payload) {
        calls.options.push(payload);
        const answer = queue.length > 1 ? queue.shift() : queue[0];
        return typeof answer === 'function' ? answer() : answer;
      },
      async useRuntimeBuild(payload) { calls.use.push(payload); return use(payload); },
      ...extraBridge,
    },
  };
  let actions = null;
  const rows = dom.window.document.getElementById('rows');
  const render = () => {
    calls.render += 1;
    rows.innerHTML = libraryView.buildLibraryRow(model, { actions: ['use'], activation: actions.activationState() });
  };
  actions = createModelLibraryRuntimeActions({
    windowRef: dom.window,
    state: { offline: {} },
    findModel: () => model,
    activeModel: () => '',
    refresh: async () => render(), // the library re-renders its rows after a refresh
    refreshModelPickers: async () => null,
    render,
    setStatusMessage: () => {},
    showToastMessage: () => {},
    appendClientLog: () => {},
  });
  t.after(() => actions.dispose());
  const button = (action) => [...rows.querySelectorAll(`[data-runtime-build-action="${action}"]`)];
  return {
    actions, calls, rows, button, dom, timers, render,
    labels: () => [...rows.querySelectorAll('.model-card-note-actions .btn')].map((node) => node.textContent),
    note: () => rows.querySelector('.model-card-note')?.textContent || '',
    click: (node) => node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })),
  };
}

async function settle() {
  for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('a failed Use keeps its message and offers the builds main named, in order', async (t) => {
  const h = rowHarness(t, { loads: [UNSUPPORTED] });
  h.actions.handleUse(TAG);
  await settle();
  assert.equal(h.note(), BUNDLED_CANT_READ);
  assert.deepEqual(h.calls.options, [{ modelTag: TAG }]);
  assert.deepEqual(h.labels(), ['Use build 12098', 'Use build 11950']);
  assert.equal(h.rows.querySelectorAll('.model-card-note-actions').length, 1);
});

test('Use build saves it through main, then runs the same Use again with a "starting" note', async (t) => {
  const second = gate();
  const h = rowHarness(t, { loads: [UNSUPPORTED, () => second.promise] });
  h.actions.handleUse(TAG);
  await settle();
  h.click(h.button('use')[0]);
  await settle();
  assert.deepEqual(h.calls.use, [{ modelTag: TAG, id: 'opt-a' }]);
  assert.equal(h.calls.load.length, 2, 'the Use ran again');
  assert.equal(h.note(), 'Using build 12098 for this model · starting…');
  assert.deepEqual(h.labels(), []);
  second.release({});
  await settle();
  assert.equal(h.note(), '', 'a loaded model has no note');
});

test('a stale option asks main again and shows the buttons it names now', async (t) => {
  const fresh = { ...TWO, candidates: [{ id: 'opt-c', build: 12200, label: 'llama-b12200', reads: 'yes' }] };
  const h = rowHarness(t, { loads: [UNSUPPORTED], answers: [TWO, fresh], use: async () => ({ ok: false, reason: 'stale_option' }) });
  h.actions.handleUse(TAG);
  await settle();
  h.click(h.button('use')[0]);
  await settle();
  assert.equal(h.calls.options.length, 2);
  assert.deepEqual(h.labels(), ['Use build 12200']);
  assert.equal(h.calls.load.length, 1, 'nothing was started');
});

test('another refusal says so and keeps the buttons', async (t) => {
  const h = rowHarness(t, { loads: [UNSUPPORTED], use: async () => ({ ok: false, reason: 'runtime_probe_failed' }) });
  h.actions.handleUse(TAG);
  await settle();
  h.click(h.button('use')[0]);
  await settle();
  assert.equal(h.note(), `${BUNDLED_CANT_READ} Couldn't switch to build 12098.`);
  assert.deepEqual(h.labels(), ['Use build 12098', 'Use build 11950']);
  assert.ok(h.button('use').every((node) => !node.disabled));
});

test('a double click switches once', async (t) => {
  const pending = gate();
  const h = rowHarness(t, { loads: [UNSUPPORTED], use: () => pending.promise });
  h.actions.handleUse(TAG);
  await settle();
  const first = h.button('use')[0];
  h.click(first);
  h.click(h.button('use')[0]);
  h.click(first);
  await settle();
  assert.equal(h.calls.use.length, 1);
  assert.ok(h.button('use').every((node) => node.disabled), 'the buttons wait');
  pending.release({ ok: false, reason: 'not_saved' });
  await settle();
  assert.ok(h.button('use').every((node) => !node.disabled));
});

test('with no other build the message says so, and the row offers Add runtime folder and Get build', async (t) => {
  const h = rowHarness(t, { loads: [UNSUPPORTED], answers: [NONE] });
  h.actions.handleUse(TAG);
  await settle();
  assert.equal(h.note(), `${BUNDLED_CANT_READ} No other build Jenny knows may read it.`);
  assert.deepEqual(h.labels(), ['Add runtime folder…', 'Get build 12098']);
});

test('without a download on offer only Add runtime folder shows', async (t) => {
  const h = rowHarness(t, { loads: [UNSUPPORTED], answers: [{ ...NONE, download: null }] });
  h.actions.handleUse(TAG);
  await settle();
  assert.deepEqual(h.labels(), ['Add runtime folder…']);
});

test('Add runtime folder in the row saves the folder, asks again and shows the build that reads it', async (t) => {
  const saves = [];
  const h = rowHarness(t, {
    loads: [UNSUPPORTED],
    answers: [NONE, TWO],
    extraBridge: { chooseRuntimeFolder: async () => ({ ok: true, picked: true, path: 'D:\\builds' }) },
  });
  h.dom.window.jennyShell.engines = {
    getSettings: async () => ({ localEngines: { openaiCompatible: { managed: { runtimeRoots: ['E:\\old'] } } } }),
    updateSettings: async (payload) => { saves.push(payload); return { localEngines: { openaiCompatible: { managed: payload.managed } } }; },
  };
  h.actions.handleUse(TAG);
  await settle();
  h.click(h.button('add-folder')[0]);
  await settle();
  assert.deepEqual(saves, [{ managed: { runtimeRoots: ['E:\\old', 'D:\\builds'] } }]);
  assert.deepEqual(h.labels(), ['Use build 12098', 'Use build 11950']);
});

test('Get build in the row shows its progress in the note area and polls once a second', async (t) => {
  const h = rowHarness(t, {
    loads: [UNSUPPORTED],
    answers: [NONE],
    extraBridge: {
      runtimeDownloadStart: async (payload) => { h.calls.start = payload; return { ok: true, build: 12098 }; },
      runtimeDownloadStatus: async () => ({ state: 'downloading', build: 12098, receivedBytes: 50 * 1024 * 1024, totalBytes: 100 * 1024 * 1024 }),
      runtimeDownloadCancel: async () => ({ ok: true }),
    },
  });
  h.actions.handleUse(TAG);
  await settle();
  h.click(h.button('get-build')[0]);
  await settle();
  assert.deepEqual(h.calls.start, { architecture: 'lfm3' });
  assert.equal(h.rows.querySelector('[data-runtime-build-progress]').textContent, 'Getting build 12098 · 0 KB of ?');
  h.timers.filter(Boolean).forEach((tick) => tick());
  await settle();
  assert.equal(h.rows.querySelector('[data-runtime-build-progress]').textContent, 'Getting build 12098 · 50 MB of 100 MB');
  assert.deepEqual(h.labels(), ['Cancel']);
  h.actions.dispose();
  assert.equal(h.timers.filter(Boolean).length, 0, 'no poll is left running');
});

test('no answer from main (flag off, no bridge) leaves the failure exactly as it was', async (t) => {
  for (const answers of [[{ ok: false, reason: 'flag_off' }], [() => { throw new Error('ipc'); }]]) {
    const h = rowHarness(t, { loads: [UNSUPPORTED], answers });
    h.actions.handleUse(TAG);
    await settle();
    assert.equal(h.note(), BUNDLED_CANT_READ);
    assert.deepEqual(h.labels(), []);
  }
  const bare = rowHarness(t, { loads: [UNSUPPORTED] });
  delete bare.dom.window.jennyShell.llamaServer.runtimeOptions;
  bare.actions.handleUse(TAG);
  await settle();
  assert.deepEqual(bare.labels(), []);
});

test('only a build failure earns buttons: memory, port or other failures never ask main', async (t) => {
  for (const error of [new Error('llama_server_port_busy'), new Error('out of memory'), new Error('llama-server exited before ready')]) {
    const h = rowHarness(t, { loads: [error] });
    h.actions.handleUse(TAG);
    await settle();
    assert.deepEqual(h.calls.options, [], error.message);
    assert.deepEqual(h.labels(), [], error.message);
    assert.equal(h.note().includes('No other build'), false, error.message);
  }
});

test('a saved build that went missing may offer the bundled build by name', async (t) => {
  const missing = new Error(`Could not start llama-server for "${TAG}": llama_server_runtime_missing:b10683`);
  const saved = { ...TWO, current: { source: 'saved', build: 0, label: 'b10683' }, candidates: [{ id: 'opt-c', build: 11513, label: 'bundled', reads: 'unknown' }] };
  const h = rowHarness(t, { loads: [missing], answers: [saved] });
  h.actions.handleUse(TAG);
  await settle();
  assert.equal(h.note(), MISSING);
  assert.deepEqual(h.labels(), ['Use bundled']);
});

test('a model that is not on llama-server never asks, and a new Use clears the buttons', async (t) => {
  const ollama = rowHarness(t, { loads: [UNSUPPORTED], engine: 'ollama' });
  ollama.actions.handleUse(TAG);
  await settle();
  assert.deepEqual(ollama.calls.options, []);

  const h = rowHarness(t, { loads: [UNSUPPORTED, () => new Promise(() => {})] });
  h.actions.handleUse(TAG);
  await settle();
  assert.equal(h.labels().length, 2);
  h.actions.handleUse(TAG);
  await settle();
  assert.deepEqual(h.labels(), []);
});

test('an answer that arrives after the library closed changes nothing', async (t) => {
  const answer = gate();
  const h = rowHarness(t, { loads: [UNSUPPORTED], answers: [() => answer.promise] });
  h.actions.handleUse(TAG);
  await settle();
  const renders = h.calls.render;
  h.actions.dispose();
  answer.release(TWO);
  await settle();
  assert.equal(h.calls.render, renders);
  h.click(h.dom.window.document.body);
});
