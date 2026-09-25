'use strict';

// Tune drawer: an engine Apply (build, GGUF file, MTP) on the model llama-server
// is serving restarts it once, right away, like a context-window change (W4c).
// Runs the real drawer over the real main write path, with a stubbed restart.

const fs = require('fs');
const os = require('os');
const path = require('path');
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
const { ShellConfigService } = require('../services/shell-config-service');
const { createRuntimePickRegistry, writeManagedPatch } = require('../services/main/llama-server-runtime');

const WIN32 = process.platform === 'win32';
const SEP = WIN32 ? '\\' : '/';
const FORK = (WIN32 ? 'G:\\llmmodels\\runtimes' : '/opt/llmmodels/runtimes')
  + SEP + 'llama-prism-b10683-cuda13.3' + SEP + (WIN32 ? 'llama-server.exe' : 'llama-server');
const GGUF_DIR = WIN32 ? 'G:\\llmmodels\\gguf\\ternary-bonsai-2-27b' : '/models/ternary-bonsai-2-27b';
const MODEL_PATH = GGUF_DIR + SEP + 'Ternary-Bonsai-2-27B-PQ2_0.gguf';
const TAG = 'ternary-bonsai-2-27b-pq2_0';
const KEY = 'ternary-bonsai-2-27b-pq2-0';
const FORK_PICK = Object.freeze({ ok: true, picked: true, path: FORK, build: 10683, supportsMtp: false });
const BONSAI = Object.freeze({ engine: 'llama-server', tag: TAG, modelPath: MODEL_PATH, mtp: { mode: 'off' } });
const ON_FORK = Object.freeze({ ...BONSAI, runtimePath: FORK, runtimeBuild: 10683 });
const SERVING = Object.freeze({ ok: true, state: 'ready', alias: TAG, port: 8093, runtimeLabel: 'bundled' });
// Two launches of the served model: main's status carries the launch's pid and ready time.
const LAUNCH_A = Object.freeze({ ...SERVING, pid: 100, changedAt: 1000 });
const LAUNCH_B = Object.freeze({ ...SERVING, pid: 200, changedAt: 2000, runtimeLabel: 'build 10683' });
const STOPPED = Object.freeze({ ok: true, state: 'stopped', alias: '', port: 0 });
const OTHER_TAG = 'gemma4:12b';
const RESTARTED_BUILD = 'Restarted llama-server. It now runs build 10683.';
const RESTARTED_ENGINE = 'Restarted llama-server. The new engine settings are live.';
const ENGINE_SAVED = 'Setting saved. The new engine settings will take effect on the next llama-server restart.';
const APPLIED_PRESS_USE = 'Applied. Press Use on this model to run it with these settings.';

function tuningState() {
  return {
    contextLengthSteps: [4096, 8192],
    contextLengthByModel: { [TAG]: 4096 },
    ratioByModel: { [TAG]: 0.8 },
    generationProfilesByModel: { [TAG]: { temperature: 0.6 } },
  };
}

function stopped(lastError) {
  return { ok: true, state: 'stopped', alias: TAG, port: 0, lastError, runtimeLabel: '' };
}

function gate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

// options: entry, picks, restarts, status (a function: what is served right now)
// or statuses (then SERVING), tuningResults, gguf, streaming (array or function),
// confirm, modelList, engineGate / tuningGate (functions returning a promise the
// write waits on).
function createHarness(t, options = {}) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-runtime-restart-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const service = new ShellConfigService({ userDataPath, env: {} });
  service.updateManagedLlamaServer({ enabled: true, perModel: { [KEY]: options.entry || BONSAI } });
  const runtimePicks = createRuntimePickRegistry();
  const queue = (list) => (list || []).slice();
  const picks = queue(options.picks);
  const restarts = queue(options.restarts);
  const statuses = queue(options.statuses);
  const tuningResults = queue(options.tuningResults);
  const calls = { order: [], engine: [], tuning: [], restart: [], confirm: [] };
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  dom.window.jennyShell = {
    modelTuning: {
      async getState() { return tuningState(); },
      async update(payload) {
        calls.order.push('tuning');
        calls.tuning.push(payload);
        await options.tuningGate?.();
        return tuningResults.shift() || { status: 'applied', state: tuningState() };
      },
    },
    engines: {
      async getSettings() {
        return { localEngines: service.getLocalEngines(), accelerationCatalog: { defaults: { vramHeadroomMb: 2048 }, families: [] } };
      },
      async updateSettings(payload) {
        calls.order.push('engine');
        calls.engine.push(JSON.parse(JSON.stringify(payload)));
        await options.engineGate?.();
        writeManagedPatch({ shellConfigService: service, patch: payload.managed, picks: runtimePicks });
        return { localEngines: service.getLocalEngines(), preferredEngineType: '' };
      },
    },
    llamaServer: {
      async listLocalGgufs() { return { ok: true, entries: [] }; },
      async getStatus() { return options.status?.() || statuses.shift() || SERVING; },
      async chooseGguf() { return options.gguf || { ok: true, path: '' }; },
      async chooseRuntime() {
        const result = picks.shift() || { ok: true, picked: false, path: '' };
        if (result.picked) runtimePicks.record(result.path, { build: result.build, supportsMtp: result.supportsMtp });
        return result;
      },
      async restart(...args) {
        calls.order.push('restart');
        calls.restart.push(args);
        const next = restarts.shift();
        if (next instanceof Error) throw next;
        return next || { ...SERVING, runtimeLabel: 'build 10683' };
      },
    },
  };
  const controller = createModelTuningDrawerController({
    state: {
      features: { featureFlags: { llama_server_acceleration: true } },
      modelList: { data: options.modelList || [{ id: TAG, engine_type: 'openai-compatible' }] },
    },
    windowRef: dom.window, documentRef: dom.window.document, drawerFactory,
    inventory: { selectField, textField, actionButton, segmentedControl, toggleSwitch },
    getStreamingSessionIds: () => (typeof options.streaming === 'function' ? options.streaming() : options.streaming || []),
    confirmDialog: { async confirm(spec) { calls.confirm.push(spec); return options.confirm === true; } },
  });
  t.after(() => controller.dispose());
  const saved = () => service.getLocalEngines().openaiCompatible.managed.perModel[KEY];
  return { dom, controller, calls, saved };
}

async function openServed(h, extra = {}) {
  await h.controller.open(TAG, null, {
    engineTypeHint: 'openai-compatible', engines: { ollama: { available: false } }, ...extra,
  });
  return h.dom.window.document.getElementById('modelTuningDrawer');
}

function button(host, action) {
  const found = host.querySelector(`[data-action="${action}"]`);
  assert.ok(found, `${action} is rendered`);
  return found;
}

const statusText = (host) => host.querySelector('.model-tuning-drawer-status').textContent;
const applyLabel = (host) => button(host, 'save-model-tuning').textContent;

function setField(host, selector, value) {
  const field = host.querySelector(selector);
  field.value = value;
  field.dispatchEvent(new field.ownerDocument.defaultView.Event('input', { bubbles: true }));
}

async function flush() {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function click(host, action) {
  button(host, action).click();
  await flush();
}

async function apply(host) {
  button(host, 'save-model-tuning').click();
  for (let attempt = 0; attempt < 100 && /Applying|Restarting/.test(statusText(host)); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await flush();
}

// Owes the served model's build restart: the Apply's drawer closes mid-write
// while a chat streams (the harness's streaming option).
async function oweBuildRestart(h, write) {
  const host = await openServed(h);
  await click(host, 'choose-llama-server-runtime');
  button(host, 'save-model-tuning').click();
  await flush();
  h.controller.close();
  write.release();
  await flush();
  assert.deepEqual(h.calls.order, ['engine'], 'owed: no restart while a chat streams');
}

test('a build Apply while serving restarts llama-server exactly once, confirming only while streaming', async (t) => {
  const quiet = createHarness(t, { picks: [FORK_PICK] });
  let host = await openServed(quiet);
  await click(host, 'choose-llama-server-runtime');
  await apply(host);
  assert.deepEqual(quiet.calls.order, ['engine', 'restart']);
  assert.deepEqual(quiet.calls.restart, [[]], 'the renderer never names a binary: restart() takes no spec');
  assert.equal(quiet.calls.confirm.length, 0);
  assert.equal(statusText(host), RESTARTED_BUILD);
  assert.equal(button(host, 'save-model-tuning').textContent, 'Apply 0 changes');

  const one = createHarness(t, { picks: [FORK_PICK], streaming: ['session-1'], confirm: true });
  host = await openServed(one);
  await click(host, 'choose-llama-server-runtime');
  await apply(host);
  assert.deepEqual(one.calls.confirm, [{
    title: 'Restart llama-server?',
    message: 'A chat is still streaming. Restarting llama-server will end that response. The new engine settings only take effect after a restart.',
    confirmLabel: 'Restart anyway',
    cancelLabel: 'Not now',
    variant: 'danger',
  }]);
  assert.equal(one.calls.restart.length, 1);
  assert.equal(statusText(host), RESTARTED_BUILD);

  const declined = createHarness(t, { picks: [FORK_PICK], streaming: ['session-1', 'session-2'], confirm: false });
  host = await openServed(declined);
  await click(host, 'choose-llama-server-runtime');
  await apply(host);
  assert.equal(declined.calls.confirm[0].message,
    '2 chats are still streaming. Restarting llama-server will end those responses. The new engine settings only take effect after a restart.');
  assert.equal(declined.calls.restart.length, 0);
  assert.equal(statusText(host), 'Setting saved. The new engine settings will take effect on the next llama-server restart.');
  assert.equal(declined.saved().runtimePath, FORK, 'the build is saved either way');
});

test('the restart success copy follows runtimeLabel', async (t) => {
  const repick = GGUF_DIR + SEP + 'Ternary-Bonsai-2-27B-Q4_K_M.gguf';
  const cases = [
    ['a pick onto a numbered build', { picks: [FORK_PICK] }, 'choose-llama-server-runtime', 'build 10683', RESTARTED_BUILD],
    ['Use bundled', { entry: ON_FORK }, 'use-bundled-llama-server', 'bundled',
      'Restarted llama-server. It now runs the bundled build.'],
    ['a pick the env override shadows', { picks: [FORK_PICK] }, 'choose-llama-server-runtime', 'env', RESTARTED_ENGINE],
    ['a pick whose build is unknown', { picks: [FORK_PICK] }, 'choose-llama-server-runtime', 'custom', RESTARTED_ENGINE],
    ['a GGUF change on a custom build', { entry: ON_FORK, gguf: { ok: true, path: repick, dir: GGUF_DIR, drafterGguf: '' } },
      'choose-model-gguf', 'build 10683', RESTARTED_ENGINE],
    // A reused server Jenny did not launch ('unknown') was not relaunched: nothing is live yet.
    ['a pick onto a reused server', { picks: [FORK_PICK] }, 'choose-llama-server-runtime', 'unknown', ENGINE_SAVED],
    ['a GGUF change on a reused server', { entry: ON_FORK, gguf: { ok: true, path: repick, dir: GGUF_DIR, drafterGguf: '' } },
      'choose-model-gguf', 'unknown', ENGINE_SAVED],
    // Only 1-9 digits with no leading zero name a build.
    ['a "build 0" label', { picks: [FORK_PICK] }, 'choose-llama-server-runtime', 'build 0', RESTARTED_ENGINE],
    ['a zero-padded label', { picks: [FORK_PICK] }, 'choose-llama-server-runtime', 'build 010683', RESTARTED_ENGINE],
  ];
  for (const [label, options, action, runtimeLabel, expected] of cases) {
    const h = createHarness(t, { ...options, restarts: [{ ...SERVING, runtimeLabel }] });
    const host = await openServed(h);
    await click(host, action);
    await apply(host);
    assert.equal(h.calls.restart.length, 1, label);
    assert.equal(statusText(host), expected, label);
  }
});

test('a context restart onto a reused server says the new window is not live yet', async (t) => {
  const h = createHarness(t, { entry: ON_FORK, restarts: [{ ...SERVING, runtimeLabel: 'unknown', reused: true, contextSize: 0 }] });
  const host = await openServed(h);
  setField(host, '#modelTuningContextLength', '8192');
  await apply(host);
  assert.deepEqual(h.calls.order, ['tuning', 'restart']);
  assert.equal(statusText(host), 'Setting saved. The new context window will take effect on the next llama-server restart.',
    'a reused server never took the new -c');
});

test('an engine Apply that also changes the context window restarts once, after the tuning write', async (t) => {
  const h = createHarness(t, { picks: [FORK_PICK] });
  const host = await openServed(h);
  setField(host, '#modelTuningContextLength', '8192');
  await click(host, 'choose-llama-server-runtime');
  assert.equal(button(host, 'save-model-tuning').textContent, 'Apply 2 changes');
  await apply(host);
  assert.deepEqual(h.calls.order, ['engine', 'tuning', 'restart'], 'one restart makes both live');
  assert.equal(h.calls.tuning[0].contextLength, 8192);
  assert.equal(statusText(host), RESTARTED_BUILD);
});

test('a failed tuning follow-up keeps its message and leaves one restart for the next successful Apply', async (t) => {
  const h = createHarness(t, { picks: [FORK_PICK], tuningResults: [{ status: 'rejected', reason: 'active_stream' }] });
  const host = await openServed(h);
  setField(host, '#modelTuningTemperature', '0.4');
  await click(host, 'choose-llama-server-runtime');
  await apply(host);
  assert.deepEqual(h.calls.order, ['engine', 'tuning']);
  assert.equal(statusText(host), 'Not applied: active stream.');
  assert.equal(h.saved().runtimePath, FORK, 'the engine half landed');

  setField(host, '#modelTuningTemperature', '0.4');
  await apply(host);
  assert.deepEqual(h.calls.order, ['engine', 'tuning', 'tuning', 'restart']);
  assert.equal(statusText(host), RESTARTED_BUILD, 'the pending restart keeps its build copy');

  setField(host, '#modelTuningTemperature', '0.5');
  await apply(host);
  assert.equal(h.calls.restart.length, 1, 'once, not on every later Apply');
});

test('a later engine write settles an owed restart: once with its build copy, or dropped off llama-server', async (t) => {
  const repick = GGUF_DIR + SEP + 'Ternary-Bonsai-2-27B-Q4_K_M.gguf';
  const owe = async (h) => {
    const host = await openServed(h, { engines: { ollama: { available: true } } });
    setField(host, '#modelTuningTemperature', '0.4');
    await click(host, 'choose-llama-server-runtime');
    await apply(host);
    assert.deepEqual(h.calls.order, ['engine', 'tuning']);
    return host;
  };
  const rejected = [{ status: 'rejected', reason: 'active_stream' }];
  const superseded = createHarness(t, {
    picks: [FORK_PICK], tuningResults: rejected, gguf: { ok: true, path: repick, dir: GGUF_DIR, drafterGguf: '' },
  });
  let host = await owe(superseded);
  await click(host, 'choose-model-gguf');
  await apply(host);
  assert.deepEqual(superseded.calls.order, ['engine', 'tuning', 'engine', 'restart']);
  assert.equal(statusText(host), RESTARTED_BUILD, 'the owed build change still names its build');

  const dropped = createHarness(t, { picks: [FORK_PICK], tuningResults: rejected });
  host = await owe(dropped);
  segmentedControl.select(host.querySelector('[data-inv-segmented="modelTuningEngine"]'), 'ollama');
  await apply(host);
  setField(host, '#modelTuningTemperature', '0.5');
  await apply(host);
  assert.deepEqual(dropped.calls.order, ['engine', 'tuning', 'engine', 'tuning'], 'no llama-server restart for an Ollama model');
});

// A restart owed on the served model survives a closed drawer (R2-B).
test('a restart owed by a failed follow-up survives close and reopen, and runs on the next Apply', async (t) => {
  const h = createHarness(t, { picks: [FORK_PICK], tuningResults: [{ status: 'rejected', reason: 'active_stream' }] });
  let host = await openServed(h);
  setField(host, '#modelTuningTemperature', '0.4');
  await click(host, 'choose-llama-server-runtime');
  await apply(host);
  assert.equal(statusText(host), 'Not applied: active stream.');
  h.controller.close();
  host = await openServed(h);
  assert.equal(applyLabel(host), 'Apply 0 changes', 'the build is saved: the restart is owed, not a draft change');
  setField(host, '#modelTuningTemperature', '0.4');
  await apply(host);
  assert.deepEqual(h.calls.order, ['engine', 'tuning', 'tuning', 'restart']);
  assert.equal(statusText(host), RESTARTED_BUILD, 'with the build copy it was owed');
});

test('an engine Apply whose follow-up fails keeps a restart owed by key through the next reopen', async (t) => {
  const repick = GGUF_DIR + SEP + 'Ternary-Bonsai-2-27B-Q4_K_M.gguf';
  let streaming = ['session-1'];
  let writes = 0;
  const write = gate();
  const h = createHarness(t, {
    picks: [FORK_PICK], engineGate: () => (writes++ ? undefined : write.promise), streaming: () => streaming,
    gguf: { ok: true, path: repick, dir: GGUF_DIR, drafterGguf: '' }, tuningResults: [{ status: 'rejected', reason: 'active_stream' }],
  });
  await oweBuildRestart(h, write);
  let host = await openServed(h);
  await click(host, 'choose-model-gguf');
  setField(host, '#modelTuningTemperature', '0.4');
  await apply(host);
  assert.deepEqual(h.calls.order, ['engine', 'engine', 'tuning'], 'still streaming: the engine half lands, the follow-up is refused');
  assert.equal(statusText(host), 'Not applied: active stream.');
  streaming = [];
  h.controller.close();
  host = await openServed(h);
  setField(host, '#modelTuningTemperature', '0.4');
  await apply(host);
  assert.deepEqual(h.calls.order, ['engine', 'engine', 'tuning', 'tuning', 'restart']);
  assert.equal(statusText(host), RESTARTED_BUILD, 'with the build copy first owed');
});

test('a failed restart names the fix when lastError carries a launch code', async (t) => {
  const cases = [
    ['bundled', { entry: ON_FORK, restarts: [stopped('llama_server_model_unsupported:bundled')] }, 'use-bundled-llama-server',
      `Could not start ${TAG}: the bundled llama-server can't read this file's format. Choose a build that can in Tune.`],
    ['custom', { picks: [FORK_PICK], restarts: [stopped('llama_server_model_unsupported:custom')] }, 'choose-llama-server-runtime',
      `Could not start ${TAG}: its llama-server build can't read this file's format. Choose a build that can in Tune.`],
    ['missing', { picks: [FORK_PICK], restarts: [stopped('llama_server_runtime_missing:b10683')] },
      'choose-llama-server-runtime',
      `Could not start ${TAG}: its llama-server build (b10683) is missing. Choose a build in Tune.`],
    ['missing, no build tag', { picks: [FORK_PICK], restarts: [stopped('llama_server_runtime_missing:runtime')] },
      'choose-llama-server-runtime',
      `Could not start ${TAG}: its llama-server build is missing. Choose a build in Tune.`],
    // Statuses: open, the Apply's fresh check, then the read after the rejected restart.
    ['rejected restart', { picks: [FORK_PICK], restarts: [new Error('launch failed')],
      statuses: [SERVING, SERVING, stopped('llama_server_model_unsupported:custom')] }, 'choose-llama-server-runtime',
    `Could not start ${TAG}: its llama-server build can't read this file's format. Choose a build that can in Tune.`],
    ['any other code', { picks: [FORK_PICK], restarts: [stopped('child_exited_before_ready')] }, 'choose-llama-server-runtime',
      'llama-server restart failed. The setting was saved and is not live yet.'],
  ];
  for (const [label, options, action, expected] of cases) {
    const h = createHarness(t, options);
    const host = await openServed(h);
    await click(host, action);
    await apply(host);
    assert.equal(h.calls.restart.length, 1, label);
    assert.equal(statusText(host), expected, label);
  }

  // A context-only restart keeps its own flow and strings, and names the same fixes.
  const context = createHarness(t, { entry: ON_FORK, restarts: [stopped('llama_server_runtime_missing:b10683')] });
  const host = await openServed(context);
  setField(host, '#modelTuningContextLength', '8192');
  await apply(host);
  assert.deepEqual(context.calls.order, ['tuning', 'restart']);
  assert.equal(statusText(host), `Could not start ${TAG}: its llama-server build (b10683) is missing. Choose a build in Tune.`);
});

test('an engine Apply that moves the served model off llama-server never restarts it, context change included', async (t) => {
  const h = createHarness(t);
  let host = await openServed(h, { engines: { ollama: { available: true } } });
  segmentedControl.select(host.querySelector('[data-inv-segmented="modelTuningEngine"]'), 'ollama');
  await apply(host);
  assert.equal(h.calls.engine[0].managed.perModel[KEY].engine, 'ollama');
  assert.deepEqual(h.calls.order, ['engine']);
  assert.equal(statusText(host), APPLIED_PRESS_USE);

  // The context change rides the follow-up; it goes live with the next Use, on Ollama.
  const withContext = createHarness(t);
  host = await openServed(withContext, { engines: { ollama: { available: true } } });
  segmentedControl.select(host.querySelector('[data-inv-segmented="modelTuningEngine"]'), 'ollama');
  setField(host, '#modelTuningContextLength', '8192');
  assert.equal(applyLabel(host), 'Apply 2 changes');
  await apply(host);
  assert.equal(withContext.saved().engine, 'ollama');
  assert.equal(withContext.calls.tuning[0].contextLength, 8192);
  assert.deepEqual(withContext.calls.order, ['engine', 'tuning'], 'no llama-server restart for a model leaving it');
  assert.equal(statusText(host), APPLIED_PRESS_USE);
});

// A reflected engine write on the served model owes one restart even when its
// drawer closed or re-opened before the reply: it runs at once with no drawer UI,
// or, while a chat streams, waits on that model's next Apply while it is served.
test('an Apply whose drawer closes or re-opens mid-write still restarts the served model once, with no drawer UI', async (t) => {
  const write = gate();
  const midWrite = createHarness(t, { picks: [FORK_PICK], engineGate: () => write.promise });
  let host = await openServed(midWrite);
  await click(host, 'choose-llama-server-runtime');
  button(host, 'save-model-tuning').click();
  await flush();
  midWrite.controller.close();
  write.release();
  await flush();
  assert.equal(midWrite.saved().runtimePath, FORK);
  assert.deepEqual(midWrite.calls.order, ['engine', 'restart']);
  assert.deepEqual([midWrite.calls.restart, midWrite.calls.confirm], [[[]], []]);

  const followUp = gate();
  const midFollowUp = createHarness(t, { picks: [FORK_PICK], tuningGate: () => followUp.promise });
  host = await openServed(midFollowUp);
  setField(host, '#modelTuningTemperature', '0.4');
  await click(host, 'choose-llama-server-runtime');
  button(host, 'save-model-tuning').click();
  await flush();
  assert.deepEqual(midFollowUp.calls.order, ['engine', 'tuning'], 'closed with the follow-up in flight');
  midFollowUp.controller.close();
  followUp.release();
  await flush();
  assert.deepEqual(midFollowUp.calls.order, ['engine', 'tuning', 'restart']);
  host = await openServed(midFollowUp);
  assert.equal(applyLabel(host), 'Apply 0 changes');
  setField(host, '#modelTuningTemperature', '0.5');
  await apply(host);
  assert.equal(midFollowUp.calls.restart.length, 1, 'nothing is owed after the detached restart');
  assert.equal(statusText(host), 'Applied. The runtime acknowledged this model profile.');

  const rewrite = gate();
  const reopened = createHarness(t, { picks: [FORK_PICK], engineGate: () => rewrite.promise });
  host = await openServed(reopened);
  await click(host, 'choose-llama-server-runtime');
  button(host, 'save-model-tuning').click();
  await flush();
  host = await openServed(reopened);
  rewrite.release();
  await flush();
  assert.deepEqual(reopened.calls.order, ['engine', 'restart'], 're-opened on the same model');
  assert.equal(statusText(host), '', 'the re-opened drawer shows nothing for it');
});

test('while a chat streams, the restart is owed to that model, survives open() and runs once on its next Apply', async (t) => {
  let streaming = ['session-1'];
  const write = gate();
  const h = createHarness(t, { picks: [FORK_PICK], engineGate: () => write.promise, streaming: () => streaming });
  let host = await openServed(h);
  await click(host, 'choose-llama-server-runtime');
  button(host, 'save-model-tuning').click();
  await flush();
  h.controller.close();
  write.release();
  await flush();
  assert.deepEqual(h.calls.order, ['engine'], 'no restart while a chat streams');
  assert.equal(h.calls.confirm.length, 0, 'and no dialog from a closed drawer');

  streaming = [];
  host = await openServed(h);
  setField(host, '#modelTuningTemperature', '0.4');
  await apply(host);
  assert.deepEqual(h.calls.order, ['engine', 'tuning', 'restart'], 'a tuning-only Apply honours it');
  assert.equal(statusText(host), RESTARTED_BUILD, 'with the build copy it was owed');
  setField(host, '#modelTuningTemperature', '0.5');
  await apply(host);
  assert.equal(h.calls.restart.length, 1, 'once');
});

test('a detached or owed restart never restarts another model', async (t) => {
  const write = gate();
  const movedOn = createHarness(t, {
    picks: [FORK_PICK], engineGate: () => write.promise, statuses: [SERVING, { ...SERVING, alias: OTHER_TAG }],
  });
  const host = await openServed(movedOn);
  await click(host, 'choose-llama-server-runtime');
  button(host, 'save-model-tuning').click();
  await flush();
  movedOn.controller.close();
  write.release();
  await flush();
  assert.deepEqual(movedOn.calls.order, ['engine'], 'llama-server serves another model by now: no restart');

  let streaming = ['session-1'];
  let serving = LAUNCH_A;
  const owedWrite = gate();
  const h = createHarness(t, {
    picks: [FORK_PICK], engineGate: () => owedWrite.promise, streaming: () => streaming, status: () => serving,
    modelList: [{ id: TAG, engine_type: 'openai-compatible' }, { id: OTHER_TAG, engine_type: 'openai-compatible' }],
  });
  await oweBuildRestart(h, owedWrite);
  streaming = [];
  serving = { ...SERVING, alias: OTHER_TAG, pid: 300, changedAt: 3000 };
  await h.controller.open(OTHER_TAG, null);
  let owedHost = h.dom.window.document.getElementById('modelTuningDrawer');
  setField(owedHost, '#modelTuningTemperature', '0.4');
  await apply(owedHost);
  assert.deepEqual(h.calls.order, ['engine', 'tuning'], 'the served other model does not run it');
  serving = STOPPED;
  owedHost = await openServed(h);
  setField(owedHost, '#modelTuningTemperature', '0.4');
  await apply(owedHost);
  assert.deepEqual(h.calls.order, ['engine', 'tuning', 'tuning'], 'not while its model is not served');
  serving = LAUNCH_B;
  owedHost = await openServed(h);
  setField(owedHost, '#modelTuningTemperature', '0.5');
  await apply(owedHost);
  assert.deepEqual(h.calls.order, ['engine', 'tuning', 'tuning', 'tuning'],
    'its own model served again by a new launch owes nothing: that launch read the saved build');
});

// Owed restarts live per window: they survive the drawer's close and reopen,
// never another window's fresh controller and config (R2-C).
test('an owed restart stays in its window: a fresh window never inherits it', async (t) => {
  let streaming = ['session-1'];
  const write = gate();
  const owing = createHarness(t, { picks: [FORK_PICK], engineGate: () => write.promise, streaming: () => streaming });
  await oweBuildRestart(owing, write);
  streaming = [];
  const fresh = createHarness(t);
  let host = await openServed(fresh);
  setField(host, '#modelTuningTemperature', '0.4');
  await apply(host);
  assert.deepEqual(fresh.calls.order, ['tuning'], 'the model runs the bundled build there, never written');
  assert.equal(statusText(host), 'Applied. The runtime acknowledged this model profile.');
  host = await openServed(owing);
  setField(host, '#modelTuningTemperature', '0.4');
  await apply(host);
  assert.deepEqual(owing.calls.order, ['engine', 'tuning', 'restart'], 'its own window still owes it');
});
