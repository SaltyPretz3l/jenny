'use strict';

// new-test-file: row 142 S2 runtime builds module. Its own pieces (the download poller, option reading, the folder add) and the Tune drawer's build row and failed-restart buttons; both Tune test files sit at the 600-line cap.
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
const builds = require('../renderer/shell/model-library/model-library-runtime-builds');

const TAG = 'ternary-bonsai-2-27b-pq2_0';
const OTHER_TAG = 'gemma4-12b-q4_k_m';
const MODEL_PATH = 'G:\\llmmodels\\gguf\\ternary-bonsai-2-27b\\Ternary-Bonsai-2-27B-PQ2_0.gguf';
const BUNDLED_ANSWER = { ok: true, current: { source: 'bundled', build: 11513, label: 'bundled' }, candidates: [], download: null };
const AUTO_ANSWER = { ok: true, architecture: 'lfm3', current: { source: 'auto', build: 12098, label: 'llama-b12098-cuda13.4' }, candidates: [], download: null };
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

function gate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

async function flush() {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

// ---- The module's own pieces ----

function pollHarness(statuses, start = async () => ({ ok: true, build: 12098 })) {
  const timers = [];
  const calls = { start: [], cancel: 0 };
  const changes = [];
  const windowRef = {
    setInterval: (fn) => { timers.push(fn); return timers.length; },
    clearInterval: (id) => { timers[id - 1] = null; },
    jennyShell: {
      llamaServer: {
        runtimeDownloadStart: async (payload) => { calls.start.push(payload); return start(); },
        runtimeDownloadStatus: async () => statuses.shift(),
        runtimeDownloadCancel: async () => { calls.cancel += 1; return { ok: true }; },
      },
    },
  };
  const download = builds.createBuildDownload({ windowRef, onChange: (dl) => changes.push(dl && dl.phase), onProgress: () => changes.push('progress') });
  return { download, calls, changes, live: () => timers.filter(Boolean).length, tick: async () => { timers.filter(Boolean).forEach((fn) => fn()); await flush(); } };
}

test('a download runs from start to ready, polling only while it runs', async () => {
  const h = pollHarness([
    { state: 'downloading', build: 12098, receivedBytes: 10, totalBytes: 100 },
    { state: 'downloading', build: 12098, receivedBytes: 20, totalBytes: 100 },
    { state: 'extracting', build: 12098 },
    { state: 'ready', build: 12098 },
  ]);
  await h.download.start('lfm3', 12098);
  assert.deepEqual(h.calls.start, [{ architecture: 'lfm3' }]);
  assert.equal(h.live(), 1);
  await h.download.start('lfm3', 12098);
  assert.equal(h.calls.start.length, 1, 'one download at a time');
  await h.tick();
  await h.tick();
  assert.equal(h.download.state().received, 20);
  await h.tick();
  assert.equal(h.download.state().step, 'extracting');
  await h.tick();
  assert.equal(h.download.state().phase, 'ready');
  assert.equal(h.live(), 0);
  assert.ok(h.changes.includes('progress'), 'a byte count alone is not a phase change');
});

test('a download that goes idle five polls in a row is taken as gone', async () => {
  const h = pollHarness(Array.from({ length: 5 }, () => ({ state: 'idle' })));
  await h.download.start('lfm3', 12098);
  for (let index = 0; index < 5; index += 1) await h.tick();
  assert.equal(h.download.state(), null);
  assert.equal(h.live(), 0);
});

test('a late answer after dispose changes nothing and no timer is left', async () => {
  const pending = gate();
  const h = pollHarness([{ state: 'ready', build: 12098 }], () => pending.promise);
  const started = h.download.start('lfm3', 12098);
  h.download.dispose();
  pending.release({ ok: true, build: 12098 });
  await started;
  assert.equal(h.live(), 0);
  const running = pollHarness([{ state: 'ready', build: 12098 }]);
  await running.download.start('lfm3', 12098);
  assert.equal(running.live(), 1);
  running.download.dispose();
  assert.equal(running.live(), 0);
});

test('a refused start ends in a sentence, and Cancel reaches main', async () => {
  const refused = pollHarness([], async () => ({ ok: false, reason: 'busy' }));
  await refused.download.start('lfm3', 12098);
  assert.equal(refused.download.state().phase, 'refused');
  assert.equal(refused.download.state().message, 'Another build is downloading.');
  assert.equal(refused.live(), 0);
  await refused.download.cancel();
  assert.equal(refused.calls.cancel, 1);
});

test('options keep at most three builds with an id, and read the offer', () => {
  const answer = {
    ok: true,
    current: { source: 'auto', build: 12098, label: 'x' },
    candidates: [{ id: 'a', build: 1 }, { id: '', build: 2 }, { id: 'c', build: 0 }, { id: 'd', build: 4 }, { id: 'e', build: 5 }, { id: 'f', build: 6 }],
    download: { build: 12098, sizeBytes: 5 },
  };
  const read = builds.readOptions(answer);
  assert.deepEqual(read.candidates.map((item) => item.id), ['a', 'd', 'e']);
  assert.deepEqual(read.download, { build: 12098, sizeBytes: 5 });
  assert.equal(builds.readOptions({ ok: false, reason: 'flag_off' }), null);
  assert.equal(builds.readOptions(null), null);
});

test('adding a runtime folder stops at eight, skips a repeat and passes a refusal on', async () => {
  const bridge = (result) => ({ jennyShell: { llamaServer: { chooseRuntimeFolder: async () => result } } });
  const kept = (list) => ({ localEngines: { openaiCompatible: { managed: { runtimeRoots: list } } } });
  const writer = (saved, drop = false) => async (mutate) => { const list = mutate(saved); return list ? kept(drop ? saved : list) : null; };
  const eight = Array.from({ length: 8 }, (_, index) => `D:\\r${index}`);
  assert.equal((await builds.addRuntimeFolder(bridge({ ok: true, picked: true, path: 'E:\\x' }), writer(eight))).state, 'full');
  assert.equal((await builds.addRuntimeFolder(bridge({ ok: true, picked: true, path: 'd:\\R1\\' }), writer(eight))).state, 'exists');
  assert.equal((await builds.addRuntimeFolder(bridge({ ok: true, picked: true, path: 'E:\\x' }), writer(['D:\\a']))).state, 'added');
  // Main dropped the folder (the pick was spent, a cap, a flag): not announced as added.
  assert.equal((await builds.addRuntimeFolder(bridge({ ok: true, picked: true, path: 'E:\\x' }), writer(['D:\\a'], true))).state, 'failed');
  assert.deepEqual(await builds.addRuntimeFolder(bridge({ ok: false, reason: 'link_folder' }), writer([])), { state: 'refused', reason: 'link_folder' });
  assert.equal((await builds.addRuntimeFolder(bridge({ ok: true, picked: false, path: '' }), writer([]))).state, 'cancelled');
  assert.equal((await builds.addRuntimeFolder({ jennyShell: {} }, writer([]))).state, 'failed');
});

// ---- Tune drawer: the build row and a failed restart ----

function tuneHarness(t, options = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  const calls = { options: [], use: [], restart: 0, settings: 0, order: [] };
  const answers = (options.answers || [BUNDLED_ANSWER]).slice();
  const entries = options.entries || { [TAG.replace('_', '-')]: { engine: 'llama-server', tag: TAG, modelPath: MODEL_PATH, mtp: { mode: 'off' }, ...(options.saved || {}) } };
  const restarts = (options.restarts || []).slice();
  const serving = { ok: true, state: 'ready', alias: TAG, port: 8093, runtimeLabel: 'bundled', pid: 1, changedAt: 1 };
  dom.window.jennyShell = {
    modelTuning: {
      async getState() { return { contextLengthSteps: [4096, 8192], contextLengthByModel: { [TAG]: 4096 }, ratioByModel: {}, generationProfilesByModel: {} }; },
      async update() { return { status: 'applied', state: { contextLengthSteps: [4096, 8192], contextLengthByModel: { [TAG]: 8192 } } }; },
    },
    engines: {
      async getSettings() {
        calls.settings += 1;
        calls.order.push('settings');
        return { localEngines: { openaiCompatible: { managed: { enabled: true, perModel: entries } } }, accelerationCatalog: { defaults: { vramHeadroomMb: 2048 }, families: [] } };
      },
    },
    llamaServer: {
      async listLocalGgufs() { return { ok: true, entries: [] }; },
      async getStatus() { return options.status ? options.status() : serving; },
      async chooseGguf() { return { ok: true, path: '' }; },
      async chooseRuntime() { return { ok: true, picked: false, path: '' }; },
      async restart() {
        calls.restart += 1;
        calls.order.push('restart');
        await options.restartGate?.();
        return restarts.shift() || { ...serving, runtimeLabel: 'build 12098', pid: 2, changedAt: 2 };
      },
      ...(options.noOptions ? {} : {
        async runtimeOptions(payload) {
          calls.options.push(payload);
          const answer = answers.length > 1 ? answers.shift() : answers[0];
          return typeof answer === 'function' ? answer() : answer;
        },
        async useRuntimeBuild(payload) { calls.use.push(payload); calls.order.push('use'); return options.use ? options.use(payload) : { ok: true, build: 12098 }; },
        async chooseRuntimeFolder() { return { ok: true, picked: true, path: 'D:\\builds' }; },
      }),
    },
  };
  const controller = createModelTuningDrawerController({
    state: {
      features: { featureFlags: { llama_server_acceleration: true } },
      modelList: { data: [{ id: TAG, engine_type: 'openai-compatible' }, { id: OTHER_TAG, engine_type: 'openai-compatible' }] },
    },
    windowRef: dom.window, documentRef: dom.window.document, drawerFactory,
    inventory: { selectField, textField, actionButton, segmentedControl, toggleSwitch },
    getStreamingSessionIds: () => [],
    confirmDialog: { async confirm() { return false; } },
  });
  t.after(() => controller.dispose());
  const host = () => dom.window.document.getElementById('modelTuningDrawer');
  return {
    dom, controller, calls, host,
    open: (tag = TAG) => controller.open(tag, null, { engineTypeHint: 'openai-compatible', engines: { ollama: { available: false } } }),
    value: () => host().querySelector('[data-model-tuning-runtime]'),
    note: () => host().querySelector('[data-model-tuning-row="runtimePath"] [data-model-tuning-note]').textContent,
    status: () => host().querySelector('.model-tuning-drawer-status').textContent,
    footerButtons: () => [...host().querySelectorAll('.model-tuning-drawer-status-actions .btn')],
  };
}

test('with no saved build and an automatic one, the row says so and why', async (t) => {
  const answer = gate();
  const h = tuneHarness(t, { answers: [() => answer.promise] });
  await h.open();
  assert.equal(h.value().textContent, 'Bundled with Jenny', 'today\'s value shows first');
  assert.equal(h.note(), '');
  answer.release(AUTO_ANSWER);
  await flush();
  assert.equal(h.value().textContent, 'Automatic · build 12098');
  assert.equal(h.value().title, 'llama-b12098-cuda13.4');
  assert.equal(h.note(), 'The bundled build can\'t read lfm3 models.');
  assert.deepEqual(h.calls.options, [{ modelTag: TAG }], 'asked once for the open');
});

test('an answer without the architecture uses the plain note', async (t) => {
  const { architecture, ...bare } = AUTO_ANSWER;
  const h = tuneHarness(t, { answers: [bare] });
  await h.open();
  await flush();
  assert.equal(architecture, 'lfm3');
  assert.equal(h.note(), 'The bundled build can\'t read this model.');
});

test('a saved build, a bundled answer and a failed call all keep today\'s value', async (t) => {
  const saved = tuneHarness(t, { saved: { runtimePath: 'G:\\llmmodels\\runtimes\\llama-prism-b10683-cuda13.3\\llama-server.exe', runtimeBuild: 10683 }, answers: [AUTO_ANSWER] });
  await saved.open();
  await flush();
  assert.equal(saved.value().textContent, 'llama-prism-b10683-cuda13.3 · build 10683');
  assert.deepEqual(saved.calls.options, [], 'a saved build is not second-guessed');

  const bundled = tuneHarness(t, { answers: [BUNDLED_ANSWER] });
  await bundled.open();
  await flush();
  assert.equal(bundled.value().textContent, 'Bundled with Jenny');

  for (const answers of [[{ ok: false, reason: 'flag_off' }], [() => { throw new Error('ipc'); }]]) {
    const refused = tuneHarness(t, { answers });
    await refused.open();
    await flush();
    assert.equal(refused.value().textContent, 'Bundled with Jenny');
  }
  const bare = tuneHarness(t, { noOptions: true });
  await bare.open();
  await flush();
  assert.equal(bare.value().textContent, 'Bundled with Jenny');
});

test('a late answer after the drawer moved to another model changes nothing', async (t) => {
  const late = gate();
  const h = tuneHarness(t, {
    entries: {
      'ternary-bonsai-2-27b-pq2-0': { engine: 'llama-server', tag: TAG, modelPath: MODEL_PATH, mtp: { mode: 'off' } },
      'gemma4-12b-q4-k-m': { engine: 'llama-server', tag: OTHER_TAG, modelPath: 'G:\\m\\gemma.gguf', mtp: { mode: 'off' } },
    },
    answers: [() => late.promise, BUNDLED_ANSWER],
  });
  await h.open(TAG);
  await h.open(OTHER_TAG);
  await flush();
  late.release(AUTO_ANSWER);
  await flush();
  assert.equal(h.value().textContent, 'Bundled with Jenny');
  assert.equal(h.note(), '');
});

// A context change applies, then restarts the served model; the restart is what fails.
async function failRestart(h, lastError = 'llama_server_model_unsupported:bundled') {
  await h.open();
  await flush();
  const field = h.host().querySelector('#modelTuningContextLength');
  field.value = '8192';
  field.dispatchEvent(new h.dom.window.Event('change', { bubbles: true }));
  h.host().querySelector('[data-action="save-model-tuning"]').click();
  for (let attempt = 0; attempt < 100 && h.calls.restart === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  await flush();
  assert.equal(h.calls.restart, 1, `the restart ran (${lastError})`);
}

const STOPPED = { ok: true, state: 'stopped', alias: TAG, port: 0, lastError: 'llama_server_model_unsupported:bundled', runtimeLabel: '' };
const BUNDLED_CANT_READ = `Could not start ${TAG}: the bundled llama-server can't read this file's format. Choose a build that can in Tune.`;

test('a failed restart gains "Use build N" buttons, and a click restarts on that build', async (t) => {
  const second = gate();
  const h = tuneHarness(t, { answers: [BUNDLED_ANSWER, TWO], restarts: [STOPPED], restartGate: () => (h.calls.restart === 2 ? second.promise : null) });
  await failRestart(h);
  assert.equal(h.status(), BUNDLED_CANT_READ + 'Use build 12098Use build 11950');
  assert.deepEqual(h.footerButtons().map((node) => node.textContent), ['Use build 12098', 'Use build 11950']);
  h.footerButtons()[0].click();
  await flush();
  assert.deepEqual(h.calls.use, [{ modelTag: TAG, id: 'opt-a' }]);
  assert.equal(h.status(), 'Using build 12098 · starting…');
  assert.deepEqual(h.footerButtons(), []);
  second.release();
  await flush();
  assert.equal(h.calls.restart, 2, 'the existing restart path ran again');
  assert.equal(h.status(), 'Restarted llama-server. It now runs build 12098.');
  assert.deepEqual(h.calls.order.slice(-3), ['use', 'settings', 'restart'], 'the saved entry is re-read before the restart');
});

test('a double click on a footer button switches once, and a stale option asks again', async (t) => {
  const pending = gate();
  const h = tuneHarness(t, { answers: [BUNDLED_ANSWER, TWO], restarts: [STOPPED], use: () => pending.promise });
  await failRestart(h);
  const [first] = h.footerButtons();
  first.click();
  h.footerButtons()[0].click();
  first.click();
  await flush();
  assert.equal(h.calls.use.length, 1);
  pending.release({ ok: false, reason: 'stale_option' });
  await flush();
  assert.equal(h.calls.options.length, 4, 'open, the re-derive after the failed restart, the buttons, then the stale option');
  assert.equal(h.footerButtons().length, 2);
});

test('with no other build the footer keeps the real failure, adds why, and offers Add runtime folder', async (t) => {
  const h = tuneHarness(t, { answers: [BUNDLED_ANSWER], restarts: [STOPPED] });
  await failRestart(h);
  assert.equal(h.status(), BUNDLED_CANT_READ + ' No other build Jenny knows may read it.Add runtime folder…');
  assert.deepEqual(h.footerButtons().map((node) => node.textContent), ['Add runtime folder…']);
});

test('a restart that failed for another reason (memory, port) keeps its text and gets no buttons', async (t) => {
  for (const lastError of ['llama_server_port_busy', 'out of memory', '']) {
    const h = tuneHarness(t, { answers: [BUNDLED_ANSWER, TWO], restarts: [{ ...STOPPED, lastError }] });
    await failRestart(h, lastError);
    assert.equal(h.status(), 'llama-server restart failed. The setting was saved and is not live yet.', lastError);
    assert.deepEqual(h.footerButtons(), [], lastError);
  }
});

test('without runtimeOptions the failed restart reads exactly as before', async (t) => {
  const h = tuneHarness(t, { noOptions: true, restarts: [STOPPED] });
  await failRestart(h);
  assert.equal(h.status(), BUNDLED_CANT_READ);
  assert.deepEqual(h.footerButtons(), []);
});
