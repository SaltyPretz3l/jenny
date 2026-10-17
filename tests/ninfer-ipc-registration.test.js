'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getBridgeChannel, listBridgeMethodPaths } = require('../services/ipc-contract');
const { registerNinferIpc } = require('../services/main/ninfer-ipc-registration');
const { registerToolsSettingsIpc } = require('../services/main/tools-settings-ipc-registration');

const methods = ['getState', 'setup', 'cancelSetup', 'remove', 'start', 'stop', 'restart',
  'dismissSuggestion', 'updateSettings'];
const actions = methods.filter((name) => name !== 'getState');
const payloadless = ['getState', 'setup', 'cancelSetup', 'stop', 'dismissSuggestion'];
const validPayloads = { remove: { confirmed: true }, updateSettings: { mtp: true } };
const pin = { id: 'qwen3.8-27b-nvfp4', display_name: 'Qwen3.8 27B', model_id: 'qwen3.8-27b-nvfp4',
  size_bytes: 23719715844, supports_mtp: true, context_windows: [16384, 65536], fp8_kv_windows: [], default_context_window: 65536,
  repo: 'neroued/x', revision: 'abc', file: 'model.ninfer', sha256: 'f'.repeat(64) };

function fixture({ enabled = true, eligible = true, manager = true, state = 'stopped' } = {}) {
  const calls = [];
  const authorizations = [];
  const handlers = new Map();
  const record = (name, result) => (...args) => { calls.push([name, ...args]); return result(...args); };
  const results = { install: { ok: true }, download: { ok: true }, removeInstall: { ok: true }, removeArtifact: { ok: true } };
  let status = { state, pid: 0, port: 0, lastError: '' };
  const runtime = {
    enabled,
    install: {
      getState: record('install.getState', () => ({ status: 'installed' })),
      install: record('install.install', async () => results.install),
      cancel: record('install.cancel', () => ({ ok: true })),
      remove: record('install.remove', async () => results.removeInstall),
    },
    artifacts: {
      artifacts: [pin],
      getState: record('artifacts.getState', () => ({ status: 'idle' })),
      download: record('artifacts.download', async () => results.download),
      cancel: record('artifacts.cancel', async () => ({ ok: true })),
      remove: record('artifacts.remove', async () => results.removeArtifact),
      resolveArtifactPath: record('artifacts.resolveArtifactPath', async () => ({ ok: true, path: 'Z:\\secret\\model.ninfer' })),
    },
    eligibility: record('eligibility', async () => (eligible
      ? { eligible: true, reason: '', device: { name: 'RTX 5090' }, probed: true }
      : { eligible: false, reason: 'gpu_unsupported', device: null, probed: true })),
  };
  const ninferManager = {
    getStatus: record('manager.getStatus', () => ({ ...status })),
    ensureRunning: record('manager.ensureRunning', async () => { status = { ...status, state: 'ready' }; return { ...status }; }),
    stop: record('manager.stop', async () => { status = { ...status, state: 'stopped' }; return { ...status }; }),
    restart: record('manager.restart', async () => ({ ...status, state: 'ready' })),
  };
  const settings = { lastUsedArtifactId: 'qwen3.8-27b-nvfp4', suggestionDismissed: false, contextSize: 65536,
    mtp: false, watchdog: { enabled: false, maxWatts: 575, maxTempC: 90 } };
  const configService = {
    getLocalEngines: record('config.getLocalEngines', () => ({ ninfer: settings })),
    updateNinferSettings: record('config.updateNinferSettings', (patch) => ({ ...settings, ...patch })),
  };
  const backendService = { ninferRuntime: runtime, configService,
    options: { getNinferManager: () => (manager ? ninferManager : null) } };
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
  const authorization = { authorize: (event, metadata) => { authorizations.push(metadata); return event.trusted === true; } };
  registerNinferIpc(ipcMain, { backendService, authorization });
  const invoke = (method, payload, trusted = true) => handlers.get(getBridgeChannel(`ninfer.${method}`))({ trusted }, payload);
  return { calls, authorizations, handlers, results, runtime, ninferManager, configService, invoke,
    setStatus: (next) => { status = { ...status, ...next }; } };
}

const serviceCalls = (calls) => calls.filter(([name]) => name !== 'eligibility');

test('contract descriptors exist, are unique and every invoke goes through the authorizer', async () => {
  assert.deepEqual(listBridgeMethodPaths({ kind: 'invoke' }).filter((name) => name.startsWith('ninfer.')),
    methods.map((name) => `ninfer.${name}`).sort());
  assert.equal(getBridgeChannel('ninfer.onChanged', 'subscribe'), 'ninfer:changed');
  const channels = methods.map((name) => getBridgeChannel(`ninfer.${name}`));
  assert.equal(new Set(channels).size, channels.length);
  assert.ok(channels.every((channel) => /^ninfer:[a-z-]+$/u.test(channel)));
  const f = fixture();
  assert.equal(f.handlers.size, methods.length);
  for (const method of methods) {
    const channel = getBridgeChannel(`ninfer.${method}`);
    assert.deepEqual(await f.invoke(method, validPayloads[method], false),
      { ok: false, authorized: false, code: 'ipc_sender_unauthorized' });
    assert.deepEqual(f.authorizations.at(-1), { methodPath: `ninfer.${method}`, channel });
  }
  assert.deepEqual(f.calls, []);
});

test('the tools-settings registration registers the ninfer channels', () => {
  const handlers = new Map();
  registerToolsSettingsIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    backendService: { commandSandbox: {}, pdfAddon: {}, imageEngine: null },
    authorization: { authorize: () => false },
  });
  for (const method of methods) assert.ok(handlers.has(getBridgeChannel(`ninfer.${method}`)), method);
});

test('flag off, no manager or an ineligible GPU answers only the refusal and touches no service', async () => {
  for (const [options, reason] of [[{ enabled: false }, 'ninfer_flag_off'], [{ manager: false }, 'ninfer_unavailable'],
    [{ eligible: false }, 'gpu_unsupported']]) {
    const f = fixture(options);
    assert.deepEqual(await f.invoke('getState'), { eligible: false, reason });
    for (const method of actions) {
      assert.deepEqual(await f.invoke(method, validPayloads[method]), { ok: false, reason: 'ninfer_unavailable' }, method);
    }
    assert.deepEqual(serviceCalls(f.calls), []);
  }
  const noRuntime = fixture();
  delete noRuntime.runtime.install;
  assert.deepEqual(await noRuntime.invoke('getState'), { eligible: false, reason: 'ninfer_unavailable' });
});

test('getState reports runtime, pins, presence, manager status and settings without paths', async () => {
  const f = fixture();
  const state = await f.invoke('getState');
  assert.equal(state.eligible, true);
  assert.deepEqual(state.runtime.pins, [{ id: pin.id, display_name: pin.display_name, model_id: pin.model_id,
    size_bytes: pin.size_bytes, supports_mtp: true, context_windows: [16384, 65536], fp8_kv_windows: [], default_context_window: 65536 }]);
  assert.deepEqual(state.installed, [{ id: pin.id, present: true }]);
  assert.deepEqual(state.runtime.install, { status: 'installed' });
  assert.equal(state.manager.state, 'stopped');
  assert.equal(state.settings.contextSize, 65536);
  assert.ok(!JSON.stringify(state).includes('secret'));
});

test('payloadless methods reject every supplied payload and shape errors are invalid_payload', async () => {
  const f = fixture();
  for (const method of payloadless) {
    for (const payload of [{}, null, false]) {
      assert.deepEqual(await f.invoke(method, payload), { ok: false, reason: 'unexpected_payload' }, method);
    }
  }
  for (const [method, payload] of [['remove', null], ['remove', { confirmed: true, deleteModel: 'yes' }],
    ['start', 'x'], ['start', { vision: 'yes' }], ['restart', { vision: 1 }], ['updateSettings', { vision: null }], ['start', { contextSize: '65536' }], ['restart', []], ['updateSettings', undefined],
    ['updateSettings', { watchdog: 5 }], ['updateSettings', { watchdog: { maxWatts: '500' } }]]) {
    assert.deepEqual(await f.invoke(method, payload), { ok: false, reason: 'invalid_payload' }, method);
  }
  assert.deepEqual(serviceCalls(f.calls), []);
});

test('setup installs then downloads the pinned artifact, and the first failure short-circuits', async () => {
  const f = fixture();
  assert.deepEqual(await f.invoke('setup'), { ok: true });
  assert.deepEqual(serviceCalls(f.calls), [['install.install', { confirmed: true }],
    ['artifacts.download', { id: pin.id, confirmed: true }]]);
  f.calls.length = 0;
  f.results.install = { ok: false, reason: 'busy' };
  assert.deepEqual(await f.invoke('setup'), { ok: false, reason: 'busy' });
  assert.deepEqual(serviceCalls(f.calls), [['install.install', { confirmed: true }]]);
  f.results.install = { ok: true, already: true };
  f.results.download = { ok: false, reason: 'Disk full at Z:\\x' };
  assert.deepEqual(await f.invoke('setup'), { ok: false, reason: 'ninfer_download_failed' });
});

test('a second setup while one runs answers busy', async () => {
  const f = fixture();
  let release;
  f.runtime.install.install = () => new Promise((resolve) => { release = resolve; });
  const first = f.invoke('setup');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await f.invoke('setup'), { ok: false, reason: 'busy' });
  release({ ok: true });
  assert.deepEqual(await first, { ok: true });
});

test('cancelSetup cancels both services', async () => {
  const f = fixture();
  assert.deepEqual(await f.invoke('cancelSetup'), { ok: true });
  assert.deepEqual(serviceCalls(f.calls), [['install.cancel'], ['artifacts.cancel']]);
});

test('remove needs confirmation, stops a running manager first and aborts on an unconfirmed stop', async () => {
  const f = fixture({ state: 'ready' });
  assert.deepEqual(await f.invoke('remove', { confirmed: false }), { ok: false, reason: 'opt_in_required' });
  assert.deepEqual(serviceCalls(f.calls), []);
  assert.deepEqual(await f.invoke('remove', { confirmed: true, deleteModel: true }), { ok: true });
  assert.deepEqual(serviceCalls(f.calls).map(([name]) => name), ['manager.getStatus', 'manager.stop', 'install.remove',
    'config.updateNinferSettings', 'artifacts.remove']);
  assert.deepEqual(f.calls.find(([name]) => name === 'config.updateNinferSettings')[1], { lastUsedArtifactId: '' });
  assert.deepEqual(f.calls.find(([name]) => name === 'artifacts.remove')[1], { id: pin.id, confirmed: true });

  const unconfirmed = fixture({ state: 'ready' });
  unconfirmed.ninferManager.stop = async () => ({ state: 'stopped', lastError: 'stop_unconfirmed' });
  assert.deepEqual(await unconfirmed.invoke('remove', { confirmed: true, deleteModel: true }),
    { ok: false, reason: 'ninfer_stop_unconfirmed' });
  assert.ok(!unconfirmed.calls.some(([name]) => name === 'install.remove' || name === 'artifacts.remove'));

  const stopped = fixture({ state: 'crashed' });
  assert.deepEqual(await stopped.invoke('remove', { confirmed: true }), { ok: true });
  assert.deepEqual(serviceCalls(stopped.calls).map(([name]) => name), ['manager.getStatus', 'install.remove',
    'config.updateNinferSettings']);
  stopped.results.removeInstall = { ok: false, reason: 'busy' };
  assert.deepEqual(await stopped.invoke('remove', { confirmed: true }), { ok: false, reason: 'busy' });

  // Astra b2b F3: a stopped manager whose pid cleanup is unconfirmed retries the stop and refuses
  // every deletion until it settles; once it settles the removal proceeds.
  const unsettled = fixture({ state: 'stopped' });
  let settled = false;
  unsettled.ninferManager.cleanupUnconfirmed = () => !settled;
  unsettled.ninferManager.stop = async () => ({ state: 'stopped', lastError: settled ? '' : 'stop_unconfirmed' });
  assert.deepEqual(await unsettled.invoke('remove', { confirmed: true, deleteModel: true }),
    { ok: false, reason: 'ninfer_stop_unconfirmed' });
  assert.ok(!unsettled.calls.some(([name]) => name === 'install.remove' || name === 'artifacts.remove'));
  settled = true;
  assert.deepEqual(await unsettled.invoke('remove', { confirmed: true, deleteModel: true }), { ok: true });
  assert.ok(unsettled.calls.some(([name]) => name === 'install.remove'));
});

test('start, stop and restart forward to the manager with only the steerable spec keys', async () => {
  const f = fixture();
  const started = await f.invoke('start', { artifactId: pin.id, contextSize: 65536, mtp: true, args: '--evil' });
  assert.equal(started.ok, true);
  assert.equal(started.status.state, 'ready');
  assert.deepEqual(f.calls.find(([name]) => name === 'manager.ensureRunning')[1],
    { artifactId: pin.id, contextSize: 65536, mtp: true });
  const stopped = await f.invoke('stop');
  assert.deepEqual([stopped.ok, stopped.status.state], [true, 'stopped']);
  assert.deepEqual(f.calls.find(([name]) => name === 'manager.stop').slice(1), []);
  const restarted = await f.invoke('restart');
  assert.deepEqual([restarted.ok, restarted.status.state], [true, 'ready']);
  assert.deepEqual(f.calls.find(([name]) => name === 'manager.restart')[1], undefined);
  f.ninferManager.ensureRunning = async () => ({ state: 'stopped', lastError: 'ninfer_artifact_missing' });
  const refused = await f.invoke('start');
  assert.deepEqual([refused.ok, refused.reason, refused.status.state], [false, 'ninfer_artifact_missing', 'stopped']);
  f.ninferManager.restart = async () => { throw new Error('boom at C:\\Users\\x'); };
  assert.deepEqual(await f.invoke('restart', {}), { ok: false, reason: 'ninfer_operation_failed' });
});

test('dismissSuggestion persists and updateSettings whitelists keys', async () => {
  const f = fixture();
  assert.deepEqual(await f.invoke('dismissSuggestion'), { ok: true });
  assert.deepEqual(f.calls.at(-1), ['config.updateNinferSettings', { suggestionDismissed: true }]);
  const result = await f.invoke('updateSettings', { contextSize: 16384, mtp: true, lastUsedArtifactId: 'x',
    suggestionDismissed: false, watchdog: { enabled: true, maxWatts: 500, extra: 1 } });
  assert.equal(result.ok, true);
  assert.deepEqual(f.calls.at(-1), ['config.updateNinferSettings',
    { contextSize: 16384, mtp: true, watchdog: { enabled: true, maxWatts: 500 } }]);
  assert.equal(result.settings.contextSize, 16384);
});

test('numeric payloads are validated before delegation: bounds, the pin windows and the artifact id (Astra b2b F1)', async () => {
  const f = fixture();
  const before = f.calls.length;
  const invalid = [
    ['updateSettings', { contextSize: 1 }], ['updateSettings', { contextSize: Number.NaN }], ['updateSettings', { contextSize: 32768 }],
    ['updateSettings', { watchdog: { maxWatts: Number.POSITIVE_INFINITY } }], ['updateSettings', { watchdog: { maxWatts: 99 } }],
    ['updateSettings', { watchdog: { maxWatts: 1001 } }], ['updateSettings', { watchdog: { maxTempC: -1 } }],
    ['updateSettings', { watchdog: { maxTempC: 111 } }], ['updateSettings', { watchdog: { maxTempC: 80.5 } }],
    ['start', { artifactId: '../evil' }], ['start', { artifactId: 'UPPER' }], ['start', { contextSize: 4096 }],
    ['restart', { artifactId: pin.id, contextSize: Number.NaN }], ['restart', { contextSize: 32768 }],
  ];
  for (const [method, payload] of invalid) {
    assert.deepEqual(await f.invoke(method, payload), { ok: false, reason: 'invalid_payload' }, `${method} ${JSON.stringify(payload)}`);
  }
  assert.equal(f.calls.slice(before).filter(([name]) => name.startsWith('manager.') || name.startsWith('config.update')).length, 0,
    'nothing reached the manager or the settings writer');
  assert.equal((await f.invoke('updateSettings', { contextSize: 16384, watchdog: { enabled: true, maxWatts: 100, maxTempC: 110 } })).ok, true);
  assert.equal((await f.invoke('start', { artifactId: pin.id, contextSize: 16384 })).ok, true);
});


test('vision boolean crosses the existing settings and launch IPC methods', async () => {
  const f = fixture();
  for (const method of ['start', 'restart', 'updateSettings']) {
    const result = await f.invoke(method, { vision: false });
    assert.equal(result.ok, true, method);
  }
  const delegated = serviceCalls(f.calls);
  for (const name of ['manager.ensureRunning', 'manager.restart', 'config.updateNinferSettings']) {
    assert.ok(delegated.some(([method, payload]) => method === name && payload.vision === false), name);
  }
});
