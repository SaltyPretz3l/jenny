'use strict';

// Tune drawer > Engine guards. An engine restart owed to the served model runs
// only on the llama-server launch it was owed on, and an Apply's own restart
// only while a fresh status shows its model served: the drawer runs over the
// REAL manager (spawns stubbed), so each relaunch below is the manager's own.
// Each Choose… ignores a click while its pick is in flight in the same drawer
// session, and a successful pick clears a failed pick's copy.

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
const { managedModelKey } = require('../services/shell-config-engines');
const { createLlamaServerManager } = require('../services/main/llama-server-manager');
const { writeManagedPatch } = require('../services/main/llama-server-runtime');

const EXE = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
const TAG = 'ternary-bonsai-2-27b-pq2_0';
const OTHER_TAG = 'gemma4:12b';
const KEY = managedModelKey(TAG);
const OTHER_KEY = managedModelKey(OTHER_TAG);
const APPLIED = 'Applied. The runtime acknowledged this model profile.';
const ACCELERATION_OFF = Object.freeze({ mode: 'off', reason: 'disabled', extraArgs: [], drafter: '', vramHeadroomMb: 0 });

function tuningState() {
  return {
    contextLengthSteps: [4096, 8192],
    contextLengthByModel: { [TAG]: 4096 },
    ratioByModel: { [TAG]: 0.8 },
    generationProfilesByModel: { [TAG]: { temperature: 0.6 } },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// Real config store + real manager over stubbed spawns (every launch a new pid;
// a handle's onExit reports a crash) + the drawer over both. Tests fill
// h.picks / h.ggufs (values, or functions returning one) and steer h.streaming,
// h.confirmResult (or a function the open dialog runs), h.statusFailure (a
// getStatus stand-in) and h.engineGate / h.tuningGate (promises the writes wait on).
function createHarness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-engine-guards-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = (folder) => {
    const file = path.join(root, folder, EXE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    return file;
  };
  const fork = runtime('llama-prism-b10683-cuda13.3');
  const other = runtime('llama-b10760');
  const model = path.join(root, 'models', 'Ternary-Bonsai-2-27B-PQ2_0.gguf');
  const otherModel = path.join(root, 'models', 'gemma-4-12b.gguf');
  const service = new ShellConfigService({ userDataPath: root, env: {} });
  service.updateManagedLlamaServer({ enabled: true, perModel: {
    [KEY]: { engine: 'llama-server', tag: TAG, modelPath: model, mtp: { mode: 'off' } },
    [OTHER_KEY]: { engine: 'llama-server', tag: OTHER_TAG, modelPath: otherModel, mtp: { mode: 'off' } },
  } });
  let nextPid = 500;
  const lifecycle = {
    launches: 0,
    lastHandle: null,
    async startLlamaServer(launch) {
      lifecycle.launches += 1;
      const pid = nextPid++;
      lifecycle.lastHandle = {
        pid, baseUrl: `http://127.0.0.1:${launch.port}/v1`, reused: false, mmproj: '', apiKey: `key-${pid}`,
        onExit: launch.onExit, async stop() { return { confirmed: true }; }, stopSync() {},
      };
      return lifecycle.lastHandle;
    },
    resolveBinaryPath: () => path.join(root, 'bundled', EXE),
    resolveGgufPath: () => ({ path: '', projectorPath: '' }),
    resolveProjectorPath: () => '',
    sweepStaleApiKeyFiles() {},
  };
  const manager = createLlamaServerManager({
    processRef: { env: {}, resourcesPath: '' }, rootDir: root, userDataPath: root,
    getShellConfigService: () => service, lifecycle,
    resolveLaunchAccelerationImpl: () => ACCELERATION_OFF,
    resolveSettingsImpl: () => ({
      autostart: true, binaryOverride: '', host: '127.0.0.1', port: 8033, profileId: '', profile: null,
      profileError: '', modelPathOverride: '', modelTagOverride: '', readinessTimeoutMs: 1000,
    }),
    buildFeatureFlagsImpl: () => ({ llama_server_acceleration: true }),
  });
  const h = {
    root, model, otherModel, service, manager, lifecycle,
    forkPick: { ok: true, picked: true, path: fork, build: 10683, supportsMtp: false },
    otherPick: { ok: true, picked: true, path: other, build: 10760, supportsMtp: false },
    picks: [], ggufs: [], streaming: [], confirmResult: false, statusFailure: null, engineGate: null, tuningGate: null,
    calls: { restart: 0, confirm: 0, runtimePickers: 0, ggufPickers: 0 },
    saved: (key) => service.getLocalEngines().openaiCompatible.managed.perModel[key],
  };
  const next = async (queue, fallback) => {
    const item = queue.shift();
    return (typeof item === 'function' ? await item() : item) || fallback;
  };
  h.dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  h.dom.window.jennyShell = {
    modelTuning: {
      async getState() { return tuningState(); },
      async update() {
        await h.tuningGate;
        return { status: 'applied', state: tuningState() };
      },
    },
    engines: {
      async getSettings() {
        return { localEngines: service.getLocalEngines(), accelerationCatalog: { defaults: { vramHeadroomMb: 2048 }, families: [] } };
      },
      async updateSettings(payload) {
        await h.engineGate;
        writeManagedPatch({ shellConfigService: service, patch: payload.managed, picks: manager.runtimePicks });
        return { localEngines: service.getLocalEngines(), preferredEngineType: '' };
      },
    },
    llamaServer: {
      async listLocalGgufs() { return { ok: true, entries: [] }; },
      // The IPC shapes: { ok, ...manager status } (pid, changedAt, alias, runtimeLabel...).
      async getStatus() { return h.statusFailure ? h.statusFailure() : { ok: true, ...manager.getStatus() }; },
      async restart() {
        h.calls.restart += 1;
        const status = await manager.restart();
        return { ...status, ok: status.state === 'ready' };
      },
      async chooseGguf() {
        h.calls.ggufPickers += 1;
        return next(h.ggufs, { ok: true, path: '' });
      },
      async chooseRuntime() {
        h.calls.runtimePickers += 1;
        const result = await next(h.picks, { ok: true, picked: false, path: '' });
        if (result.picked) manager.runtimePicks.record(result.path, { build: result.build, supportsMtp: result.supportsMtp });
        return result;
      },
    },
  };
  h.state = {
    features: { featureFlags: { llama_server_acceleration: true } },
    modelList: { data: [{ id: TAG, engine_type: 'openai-compatible' }, { id: OTHER_TAG, engine_type: 'openai-compatible' }] },
  };
  h.controller = createModelTuningDrawerController({
    state: h.state, windowRef: h.dom.window, documentRef: h.dom.window.document, drawerFactory,
    inventory: { selectField, textField, actionButton, segmentedControl, toggleSwitch },
    getStreamingSessionIds: () => h.streaming,
    confirmDialog: {
      async confirm() {
        h.calls.confirm += 1;
        return typeof h.confirmResult === 'function' ? h.confirmResult() : h.confirmResult;
      },
    },
  });
  t.after(() => h.controller.dispose());
  return h;
}

async function openTune(h, modelId) {
  await h.controller.open(modelId, null, { engineTypeHint: 'openai-compatible', engines: { ollama: { available: false } } });
  return h.dom.window.document.getElementById('modelTuningDrawer');
}

function button(host, action) {
  const found = host.querySelector(`[data-action="${action}"]`);
  assert.ok(found, `${action} is rendered`);
  return found;
}

const statusText = (host) => host.querySelector('.model-tuning-drawer-status').textContent;
const applyLabel = (host) => button(host, 'save-model-tuning').textContent;
const runtimeText = (host) => host.querySelector('[data-model-tuning-runtime]').textContent;
const ggufText = (host) => host.querySelector('[data-model-tuning-gguf]').textContent;

function setField(host, selector, value) {
  const field = host.querySelector(selector);
  field.value = value;
  field.dispatchEvent(new field.ownerDocument.defaultView.Event('input', { bubbles: true }));
}

async function flush() {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
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

// The model is served; a build Apply's drawer closes mid-write while a chat
// streams, so its restart is owed. Returns the status of the launch it is owed on.
async function oweBuildRestart(h) {
  await h.manager.ensureRunning({ modelTag: TAG, modelPath: h.model });
  const write = deferred();
  h.engineGate = write.promise;
  h.streaming = ['session-1'];
  h.picks.push(h.forkPick);
  const host = await openTune(h, TAG);
  await click(host, 'choose-llama-server-runtime');
  button(host, 'save-model-tuning').click();
  await flush();
  h.controller.close();
  write.resolve();
  await flush();
  h.engineGate = null;
  h.streaming = [];
  assert.equal(h.saved(KEY).runtimePath, h.forkPick.path, 'the build is saved');
  assert.equal(h.calls.restart, 0, 'owed: a chat was streaming');
  return h.manager.getStatus();
}

async function applyTemperature(h, modelId, value) {
  const host = await openTune(h, modelId);
  setField(host, '#modelTuningTemperature', value);
  await apply(host);
  return host;
}

test('an owed restart still runs on the next Apply while the launch it was owed on serves its model', async (t) => {
  const h = createHarness(t);
  const owedOn = await oweBuildRestart(h);
  const host = await applyTemperature(h, TAG, '0.4');
  assert.equal(h.calls.restart, 1);
  assert.notEqual(h.manager.getStatus().pid, owedOn.pid, 'relaunched');
  assert.equal(statusText(host), 'Restarted llama-server. It now runs build 10683.');
  await applyTemperature(h, TAG, '0.5');
  assert.equal(h.calls.restart, 1, 'once');
});

// Any launch of the model after the write read the saved entry: the owed
// restart would only reload it (R2-A).
const RELAUNCHES = [
  ['a switch to another model and back', async (h) => {
    await h.manager.ensureRunning({ modelTag: OTHER_TAG, modelPath: h.otherModel });
    await h.manager.ensureRunning({ modelTag: TAG, modelPath: h.model });
  }],
  ['a crash, then the next chat\'s recovery', async (h) => {
    h.lifecycle.lastHandle.onExit({ pid: h.lifecycle.lastHandle.pid, code: 1 });
    assert.equal(h.manager.getStatus().state, 'crashed');
    await h.manager.ensureRunning({ modelTag: TAG, modelPath: h.model });
  }],
  ['a Use, which the saved build forces to relaunch', async (h) => {
    const launches = h.lifecycle.launches;
    await h.manager.ensureRunning({ modelTag: TAG, modelPath: h.model, mtp: { mode: 'off' } });
    assert.equal(h.lifecycle.launches, launches + 1, 'needsRelaunch: the running binary is not the saved build');
  }],
];
for (const [label, relaunch] of RELAUNCHES) {
  test(`an owed restart is dropped once the saved build went live: ${label}`, async (t) => {
    const h = createHarness(t);
    const owedOn = await oweBuildRestart(h);
    await relaunch(h);
    const served = h.manager.getStatus();
    assert.deepEqual([served.state, served.alias, served.runtimeLabel], ['ready', TAG, 'build 10683']);
    assert.notEqual(served.pid, owedOn.pid);
    const launches = h.lifecycle.launches;
    const host = await applyTemperature(h, TAG, '0.4');
    assert.equal(h.calls.restart, 0);
    assert.equal(h.lifecycle.launches, launches, 'nothing relaunched');
    assert.equal(statusText(host), APPLIED);
  });
}

// restart() without a spec relaunches main's LAST spec: deciding from the
// drawer's open() snapshot would relaunch the other model (R2-H).
test('an owed restart never runs once another model is served, whatever open() saw', async (t) => {
  const h = createHarness(t);
  await oweBuildRestart(h);
  const host = await openTune(h, TAG);
  assert.equal(host.querySelector('[data-model-tuning-row="engine"] .model-tuning-row-range').textContent, 'Serving on :8033');
  await h.manager.ensureRunning({ modelTag: OTHER_TAG, modelPath: h.otherModel }); // a scheduled run, another pane
  const launches = h.lifecycle.launches;
  setField(host, '#modelTuningTemperature', '0.4');
  await apply(host);
  assert.equal(h.calls.restart, 0);
  assert.equal(h.lifecycle.launches, launches);
  assert.equal(h.manager.getStatus().alias, OTHER_TAG);
  assert.equal(statusText(host), APPLIED);
});

test('an owed restart for a model removed from the library never runs on another model\'s Apply', async (t) => {
  const h = createHarness(t);
  await oweBuildRestart(h);
  h.service.updateManagedLlamaServer({ perModel: { [KEY]: null } });
  h.state.modelList.data = h.state.modelList.data.filter((entry) => entry.id !== TAG);
  const launches = h.lifecycle.launches;
  await applyTemperature(h, OTHER_TAG, '0.4'); // the removed model still runs
  await h.manager.ensureRunning({ modelTag: OTHER_TAG, modelPath: h.otherModel });
  const host = await applyTemperature(h, OTHER_TAG, '0.5');
  assert.equal(h.calls.restart, 0);
  assert.equal(h.lifecycle.launches, launches + 1, 'only the Use launched');
  assert.equal(statusText(host), APPLIED);
});

// An Apply's own restart decides on a fresh status, never open()'s snapshot:
// restart() relaunches main's last spec, which may be another model by now, and
// a model served only since open() needs the restart too.
const savedNextRestart = (what) => `Setting saved. The new ${what} will take effect on the next llama-server restart.`;
const pickFork = (h, host) => { h.picks.push(h.forkPick); return click(host, 'choose-llama-server-runtime'); };
const CHANGES = [
  ['a context window change', async (h, host) => setField(host, '#modelTuningContextLength', '8192'),
    'Restarted llama-server. The new context window is live.', savedNextRestart('context window')],
  ['a build change', pickFork, 'Restarted llama-server. It now runs build 10683.', savedNextRestart('engine settings')],
  ['a build change with a tuning follow-up', async (h, host) => {
    await pickFork(h, host);
    setField(host, '#modelTuningTemperature', '0.4');
  }, 'Restarted llama-server. It now runs build 10683.', savedNextRestart('engine settings')],
];
const serveTag = (h) => h.manager.ensureRunning({ modelTag: TAG, modelPath: h.model });

for (const [label, change, restarted, saved] of CHANGES) {
  test(`${label} restarts the model served at open() and still served`, async (t) => {
    const h = createHarness(t);
    await serveTag(h);
    const host = await openTune(h, TAG);
    const launches = h.lifecycle.launches;
    await change(h, host);
    await apply(host);
    assert.deepEqual([h.calls.restart, h.lifecycle.launches, statusText(host)], [1, launches + 1, restarted]);
  });

  test(`${label} never restarts another model served since open()`, async (t) => {
    const h = createHarness(t);
    await serveTag(h);
    const host = await openTune(h, TAG);
    await h.manager.ensureRunning({ modelTag: OTHER_TAG, modelPath: h.otherModel });
    const launches = h.lifecycle.launches;
    await change(h, host);
    await apply(host);
    assert.deepEqual([h.calls.restart, h.lifecycle.launches, h.manager.getStatus().alias, statusText(host)],
      [0, launches, OTHER_TAG, saved]);
  });

  test(`${label} only saves when the fresh status cannot be read`, async (t) => {
    const h = createHarness(t);
    await serveTag(h);
    const host = await openTune(h, TAG);
    h.statusFailure = () => { throw new Error('ipc down'); };
    await change(h, host);
    await apply(host);
    assert.deepEqual([h.calls.restart, statusText(host)], [0, saved]);
  });

  test(`${label} restarts its model served only since open(), behind the streaming confirm`, async (t) => {
    // [streaming, consent] -> [confirms, restarts, copy]
    for (const [streaming, consent, expected] of [
      [[], false, [0, 1, restarted]],
      [['session-1'], false, [1, 0, saved]],
      [['session-1'], true, [1, 1, restarted]],
    ]) {
      const h = createHarness(t);
      const host = await openTune(h, TAG); // nothing served yet
      await serveTag(h);
      Object.assign(h, { streaming, confirmResult: consent });
      await change(h, host);
      await apply(host);
      assert.deepEqual([h.calls.confirm, h.calls.restart, statusText(host)], expected, `streaming ${streaming.length}, consent ${consent}`);
    }
  });
}

// The streaming confirm can stay open while llama-server moves on: Restart
// anyway checks again, and an owed restart still needs its own launch.
test('Restart anyway never restarts another model served while the dialog was open', async (t) => {
  for (const [label, change, , saved] of CHANGES.slice(0, 2)) {
    const h = createHarness(t);
    await serveTag(h);
    const host = await openTune(h, TAG);
    h.streaming = ['session-1'];
    h.confirmResult = async () => {
      await h.manager.ensureRunning({ modelTag: OTHER_TAG, modelPath: h.otherModel });
      return true;
    };
    await change(h, host);
    await apply(host);
    assert.deepEqual([h.calls.confirm, h.calls.restart, h.manager.getStatus().alias, statusText(host)],
      [1, 0, OTHER_TAG, saved], label);
  }
});

test('Restart anyway drops an owed restart once its model was relaunched while the dialog was open', async (t) => {
  const h = createHarness(t);
  await oweBuildRestart(h);
  h.streaming = ['session-1'];
  h.confirmResult = async () => {
    await h.manager.ensureRunning({ modelTag: OTHER_TAG, modelPath: h.otherModel });
    await serveTag(h); // relaunched on the saved build
    return true;
  };
  const host = await applyTemperature(h, TAG, '0.4');
  assert.deepEqual([h.calls.confirm, h.calls.restart, h.manager.getStatus().runtimeLabel, statusText(host)],
    [1, 0, 'build 10683', APPLIED]);
});

// A drawer closed mid-Apply restarts with no drawer UI, on the same fresh check.
for (const [label, gateName, withFollowUp] of [['mid-write', 'engineGate', false], ['mid follow-up', 'tuningGate', true]]) {
  test(`a drawer closed ${label} still restarts its model served only since open()`, async (t) => {
    const h = createHarness(t);
    const held = deferred();
    h[gateName] = held.promise;
    const host = await openTune(h, TAG); // nothing served yet
    await serveTag(h); // on the bundled build: the write has not landed
    await pickFork(h, host);
    if (withFollowUp) setField(host, '#modelTuningTemperature', '0.4');
    button(host, 'save-model-tuning').click();
    await flush();
    h.controller.close();
    held.resolve();
    await flush();
    const served = h.manager.getStatus();
    assert.deepEqual([h.calls.restart, served.alias, served.runtimeLabel], [1, TAG, 'build 10683']);
  });
}

test('each Choose… ignores a click while its pick is in flight, and the first result still applies', async (t) => {
  const h = createHarness(t);
  const repick = path.join(path.dirname(h.model), 'Ternary-Bonsai-2-27B-Q4_K_M.gguf');
  const runtimePick = deferred();
  const ggufPick = deferred();
  h.picks.push(() => runtimePick.promise, () => { throw new Error('ipc down'); });
  h.ggufs.push(() => ggufPick.promise);
  const host = await openTune(h, TAG);
  await click(host, 'choose-llama-server-runtime');
  await click(host, 'choose-llama-server-runtime');
  await click(host, 'choose-model-gguf');
  await click(host, 'choose-model-gguf');
  assert.deepEqual([h.calls.runtimePickers, h.calls.ggufPickers], [1, 1], 'no second dialog');
  runtimePick.resolve(h.otherPick);
  ggufPick.resolve({ ok: true, path: repick, dir: path.dirname(repick), drafterGguf: '' });
  await flush();
  assert.deepEqual([runtimeText(host), ggufText(host), applyLabel(host)],
    ['llama-b10760 · build 10760', 'Ternary-Bonsai-2-27B-Q4_K_M.gguf', 'Apply 2 changes']);
  // Settled, even by a failure: the next click opens a dialog again.
  await click(host, 'choose-llama-server-runtime');
  assert.equal(statusText(host), 'Could not open the file picker.');
  await click(host, 'choose-llama-server-runtime');
  assert.equal(h.calls.runtimePickers, 3);
});

test('a successful pick or Use bundled clears a failed pick\'s copy, never a status an Apply owns', async (t) => {
  const h = createHarness(t);
  const repick = path.join(path.dirname(h.model), 'Ternary-Bonsai-2-27B-Q4_K_M.gguf');
  h.picks.push({ ok: false, reason: 'not_llama_server' }, h.otherPick, { ok: false, reason: 'runtime_missing' });
  h.ggufs.push({ ok: false, reason: 'not_gguf' }, { ok: true, path: repick, dir: path.dirname(repick), drafterGguf: '' });
  const host = await openTune(h, TAG);
  const steps = [
    ['choose-llama-server-runtime', 'That file is not a llama-server program.'],
    ['choose-llama-server-runtime', ''],
    ['choose-model-gguf', 'That file is not a GGUF model.'],
    ['choose-model-gguf', ''],
    ['choose-llama-server-runtime', 'That file is no longer there.'],
    ['use-bundled-llama-server', ''],
  ];
  for (const [action, expected] of steps) {
    await click(host, action);
    assert.equal(statusText(host), expected, action);
  }
  assert.deepEqual([runtimeText(host), ggufText(host)], ['Bundled', 'Ternary-Bonsai-2-27B-Q4_K_M.gguf']);

  // A failed pick, then a pick whose probe lands while an Apply is pending: the
  // status line is the Apply's by then, and stays so.
  const busy = createHarness(t);
  const probe = deferred();
  const tuning = deferred();
  busy.picks.push({ ok: false, reason: 'not_llama_server' }, () => probe.promise);
  const busyHost = await openTune(busy, TAG);
  await click(busyHost, 'choose-llama-server-runtime');
  assert.equal(statusText(busyHost), 'That file is not a llama-server program.');
  await click(busyHost, 'choose-llama-server-runtime');
  setField(busyHost, '#modelTuningTemperature', '0.4');
  busy.tuningGate = tuning.promise;
  button(busyHost, 'save-model-tuning').click();
  await flush();
  probe.resolve(busy.forkPick);
  await flush();
  assert.equal(statusText(busyHost), 'Applying and checking the runtime…');
  tuning.resolve();
  await flush();
  assert.equal(statusText(busyHost), APPLIED);
  assert.deepEqual([runtimeText(busyHost), applyLabel(busyHost)], ['llama-prism-b10683-cuda13.3 · build 10683', 'Apply 1 change'],
    'the pick still landed');
});

// W4-B round 3.
test('a status that cannot be read keeps an owed restart for the next Apply [R3-4]', async (t) => {
  const h = createHarness(t);
  await oweBuildRestart(h);
  const host = await openTune(h, TAG);
  h.statusFailure = () => { h.statusFailure = null; throw new Error('ipc hiccup'); };
  setField(host, '#modelTuningTemperature', '0.4');
  await apply(host);
  assert.equal(h.calls.restart, 0, 'unknown: nothing restarts yet');
  setField(host, '#modelTuningTemperature', '0.5');
  await apply(host);
  assert.equal(h.calls.restart, 1, 'the launch it was owed on still serves: it runs');
  assert.equal(statusText(host), 'Restarted llama-server. It now runs build 10683.');
});

test('a second Apply while an owed restart is being checked cannot cancel it [R3-2]', async (t) => {
  const h = createHarness(t);
  await oweBuildRestart(h);
  const host = await openTune(h, TAG);
  const shell = h.dom.window.jennyShell.llamaServer;
  const getStatus = shell.getStatus;
  const check = deferred();
  shell.getStatus = async () => { shell.getStatus = getStatus; await check.promise; return getStatus(); };
  setField(host, '#modelTuningTemperature', '0.4');
  button(host, 'save-model-tuning').click(); // applied; now checking its owed restart
  await flush();
  const secondWrite = deferred();
  h.tuningGate = secondWrite.promise;
  setField(host, '#modelTuningTopP', '0.9');
  assert.equal(button(host, 'save-model-tuning').disabled, true, 'Apply waits for the check');
  button(host, 'save-model-tuning').click();
  await flush();
  check.resolve();
  await flush();
  secondWrite.resolve();
  h.tuningGate = null;
  for (let attempt = 0; attempt < 20 && /Applying|Restarting/.test(statusText(host)); attempt += 1) await flush();
  assert.equal(h.calls.restart, 1, 'the owed restart runs once');
});

test('a pick still probing after a close never blocks the reopened drawer\'s Choose… [R3-3]', async (t) => {
  const h = createHarness(t);
  const first = deferred();
  h.picks.push(() => first.promise, h.otherPick);
  let host = await openTune(h, TAG);
  button(host, 'choose-llama-server-runtime').click();
  await flush();
  h.controller.close();
  host = await openTune(h, TAG);
  await click(host, 'choose-llama-server-runtime');
  assert.equal(h.calls.runtimePickers, 2);
  assert.equal(runtimeText(host), 'llama-b10760 · build 10760');
  first.resolve(h.forkPick);
  await flush();
  assert.equal(runtimeText(host), 'llama-b10760 · build 10760', 'the stale pick is dropped');
});
