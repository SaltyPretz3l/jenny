'use strict';
// new-test-file: the strata.* IPC surface is a new surface (row 200 S2 step 8); the NInfer IPC file is its template.

const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { getBridgeChannel, listBridgeMethodPaths } = require('../services/ipc-contract');
const { registerStrataIpc, splitReason } = require('../services/main/strata-ipc-registration');
const { registerToolsSettingsIpc } = require('../services/main/tools-settings-ipc-registration');
const { createStrataRuntime } = require('../services/main/strata-runtime-wiring');

const methods = ['getState', 'start', 'stop', 'restart', 'updateSettings', 'reverify'];
const actions = methods.filter((name) => name !== 'getState');
const validPayloads = { updateSettings: { slots: 2 } };
const SECRET = 'a'.repeat(32);

function fixture({ enabled = true, manager = true, state = 'stopped' } = {}) {
  const calls = [];
  const authorizations = [];
  const handlers = new Map();
  const record = (name, result) => (...args) => { calls.push([name, ...args]); return result(...args); };
  const results = { reverify: { ok: true, reason: '' } };
  let status = {
    state, pid: 4242, port: 8035, alias: 'inkling-2-mini-sq-20', displayName: 'Inkling 2 Mini', phase: '', slots: 4,
    kv: 'k8v8', contextSize: 114432, contextFit: 114432, fitSource: 'measured', vision: true, drafting: 'off',
    runtimeLabel: '0.1.67', lastError: '', stoppedBy: '', watchdogWatts: 0, watchdogTempC: 0, changedAt: 1,
    apiKey: SECRET, configPath: 'Z:\\secret\\strata.json', readyFile: 'Z:\\secret\\ready.json',
  };
  const fits = { '4:k8v8': { tokens: 114432, source: 'measured' } };
  const runtime = {
    enabled,
    getState: record('runtime.getState', () => ({ enabled: true, install: { found: true, reason: '', version: '0.1.67', warnings: [] },
      setup: { found: true, reason: '' }, packs: { native: 'verified', vision: 'verified' }, progress: { native: null, vision: null },
      model: { id: 'inkling-2-mini-sq-20', displayName: 'Inkling 2 Mini', aliases: ['inkling-2-mini'], paramsB: 26.4 } })),
    uiFacts: record('runtime.uiFacts', async () => ({ pins: { release: '0.2.21', terminal: '0.1.67', engine: '0.1.67' }, fits })),
    reverify: record('runtime.reverify', async () => results.reverify),
  };
  const strataManager = {
    getStatus: record('manager.getStatus', () => ({ ...status })),
    ensureRunning: record('manager.ensureRunning', async () => { status = { ...status, state: 'ready' }; return { ...status }; }),
    stop: record('manager.stop', async () => { status = { ...status, state: 'stopped' }; return { ...status }; }),
    restart: record('manager.restart', async () => ({ ...status, state: 'ready' })),
  };
  const settings = { slots: 4, kv: 'k8v8', context: null, vision: true, drafting: 'off', lastUsed: true,
    learnedFits: { '1:k8v4': 300000 }, watchdog: { enabled: false, maxWatts: 460, maxTempC: 83 } };
  const configService = {
    getLocalEngines: record('config.getLocalEngines', () => ({ strata: settings })),
    updateStrataSettings: record('config.updateStrataSettings', (patch) => ({ ...settings, ...patch })),
  };
  const backendService = { strataRuntime: runtime, configService,
    options: { getStrataManager: () => (manager ? strataManager : null) } };
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
  const authorization = { authorize: (event, metadata) => { authorizations.push(metadata); return event.trusted === true; } };
  registerStrataIpc(ipcMain, { backendService, authorization });
  const invoke = (method, payload, trusted = true) => handlers.get(getBridgeChannel(`strata.${method}`))({ trusted }, payload);
  return { calls, authorizations, handlers, results, runtime, strataManager, configService, invoke,
    setStatus: (next) => { status = { ...status, ...next }; } };
}

const leaks = (value) => {
  const json = JSON.stringify(value);
  return json.includes(SECRET) || json.includes('secret') || /"(apiKey|pid|configPath|readyFile)"/u.test(json);
};

test('contract descriptors exist, are unique and every invoke goes through the authorizer', async () => {
  assert.deepEqual(listBridgeMethodPaths({ kind: 'invoke' }).filter((name) => name.startsWith('strata.')),
    methods.map((name) => `strata.${name}`).sort());
  assert.equal(getBridgeChannel('strata.onChanged', 'subscribe'), 'strata:changed');
  const channels = methods.map((name) => getBridgeChannel(`strata.${name}`));
  assert.equal(new Set(channels).size, channels.length);
  assert.ok(channels.every((channel) => /^strata:[a-z-]+$/u.test(channel)));
  const f = fixture();
  assert.equal(f.handlers.size, methods.length);
  for (const method of methods) {
    const channel = getBridgeChannel(`strata.${method}`);
    assert.deepEqual(await f.invoke(method, validPayloads[method], false),
      { ok: false, authorized: false, code: 'ipc_sender_unauthorized' });
    assert.deepEqual(f.authorizations.at(-1), { methodPath: `strata.${method}`, channel });
  }
  assert.deepEqual(f.calls, []);
});

test('the tools-settings registration registers the strata channels', () => {
  const handlers = new Map();
  registerToolsSettingsIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    backendService: { commandSandbox: {}, pdfAddon: {}, imageEngine: null },
    authorization: { authorize: () => false },
  });
  for (const method of methods) assert.ok(handlers.has(getBridgeChannel(`strata.${method}`)), method);
});

test('flag off or no manager answers only the refusal and touches no service', async () => {
  for (const [options, reason] of [[{ enabled: false }, 'strata_flag_off'], [{ manager: false }, 'strata_unavailable']]) {
    const f = fixture(options);
    assert.deepEqual(await f.invoke('getState'), { eligible: false, reason });
    for (const method of actions) {
      assert.deepEqual(await f.invoke(method, validPayloads[method]), { ok: false, reason, detail: '' }, method);
    }
    assert.deepEqual(f.calls, []);
  }
  // The flag-off runtime stub (strata-runtime-wiring.js) reads as flag off.
  const stub = createStrataRuntime({ flags: { strata: false }, platform: 'win32' });
  const handlers = new Map();
  registerStrataIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    backendService: { strataRuntime: stub, options: { getStrataManager: () => null } },
    authorization: { authorize: () => true },
  });
  assert.deepEqual(await handlers.get(getBridgeChannel('strata.getState'))({}), { eligible: false, reason: 'strata_flag_off' });
});

test('getState carries runtime, pins, an allowlisted manager status, public settings and fits; no key, pid or path', async () => {
  const f = fixture({ state: 'ready' });
  const state = await f.invoke('getState');
  assert.equal(state.eligible, true);
  assert.equal(state.runtime.packs.native, 'verified');
  assert.deepEqual(state.pins, { release: '0.2.21', terminal: '0.1.67', engine: '0.1.67' });
  assert.equal(state.manager.state, 'ready');
  assert.equal(state.manager.port, 8035);
  assert.equal(state.manager.contextSize, 114432);
  assert.equal(state.manager.lastError, '');
  assert.deepEqual(state.settings, { slots: 4, kv: 'k8v8', context: null, vision: true, drafting: 'off',
    watchdog: { enabled: false, maxWatts: 460, maxTempC: 83 } });
  assert.deepEqual(state.fits['4:k8v8'], { tokens: 114432, source: 'measured' });
  assert.equal(leaks(state), false, JSON.stringify(state));
  // A failing uiFacts leaves pins and fits unknown, never the whole answer.
  f.runtime.uiFacts = async () => { throw new Error('Z:\\secret\\manifest'); };
  const degraded = await f.invoke('getState');
  assert.equal(degraded.eligible, true);
  assert.deepEqual([degraded.pins, degraded.fits], [null, {}]);
});

test('payloadless methods refuse a payload; malformed and private settings are invalid_payload and reach nothing', async () => {
  for (const method of ['getState', 'stop', 'reverify']) {
    for (const payload of [{}, null, false]) {
      const f = fixture();
      const result = await f.invoke(method, payload);
      assert.equal(result.ok, false, method);
      assert.equal(result.reason, 'unexpected_payload', method);
      assert.deepEqual(f.calls, []);
    }
  }
  const bad = [null, [], 'x', { slots: 3 }, { slots: '4' }, { kv: 'fp16' }, { drafting: 'auto' }, { context: 512 },
    { context: 2_000_000 }, { context: 65536.5 }, { context: '65536' }, { vision: 'yes' }, { lastUsed: true },
    { learnedFits: { '4:k8v8': 1 } }, { watchdog: [] }, { watchdog: { enabled: 'on' } }, { watchdog: { maxWatts: 99 } },
    { watchdog: { maxWatts: 1001 } }, { watchdog: { maxTempC: 39 } }, { watchdog: { maxTempC: 110.5 } },
    { watchdog: { maxWatts: Number.NaN } }, { watchdog: { maxTempC: Infinity } }];
  for (const payload of bad) {
    const f = fixture();
    assert.deepEqual(await f.invoke('updateSettings', payload), { ok: false, reason: 'invalid_payload', detail: '' }, JSON.stringify(payload));
    assert.deepEqual(f.calls, []);
  }
  for (const method of ['start', 'restart']) {
    const f = fixture();
    assert.equal((await f.invoke(method, { kv: 'fp16' })).reason, 'invalid_payload');
    assert.equal((await f.invoke(method, { learnedFits: {} })).reason, 'invalid_payload');
    assert.deepEqual(f.calls, []);
  }
});

test('updateSettings writes only the whitelisted keys and never returns the private ones', async () => {
  const f = fixture();
  const result = await f.invoke('updateSettings', { slots: 1, kv: 'k8v4', context: null, vision: false, drafting: 'dspark',
    args: '--evil', watchdog: { enabled: true, maxWatts: 100, maxTempC: 110, extra: 1 } });
  assert.equal(result.ok, true);
  assert.deepEqual(f.calls.at(-1), ['config.updateStrataSettings', { slots: 1, kv: 'k8v4', context: null, vision: false,
    drafting: 'dspark', watchdog: { enabled: true, maxWatts: 100, maxTempC: 110 } }]);
  assert.equal('learnedFits' in result.settings || 'lastUsed' in result.settings, false);
  await f.invoke('updateSettings', { context: 1024 });
  assert.deepEqual(f.calls.at(-1), ['config.updateStrataSettings', { context: 1024 }]);
  await f.invoke('updateSettings', { context: 1048576 });
  assert.deepEqual(f.calls.at(-1), ['config.updateStrataSettings', { context: 1048576 }]);
});

test('start, stop and restart forward only the steerable keys and return a safe status', async () => {
  const f = fixture();
  const started = await f.invoke('start', { slots: 2, kv: 'auto', drafting: 'off', vision: true, context: 65536, args: '--host 0.0.0.0' });
  assert.equal(started.ok, true);
  assert.deepEqual(f.calls.find(([name]) => name === 'manager.ensureRunning'),
    ['manager.ensureRunning', { slots: 2, kv: 'auto', drafting: 'off', vision: true, context: 65536 }]);
  assert.equal(started.status.state, 'ready');
  assert.equal(leaks(started), false);
  const noSpec = fixture();
  await noSpec.invoke('start');
  assert.deepEqual(noSpec.calls.find(([name]) => name === 'manager.ensureRunning'), ['manager.ensureRunning', undefined]);
  const stopped = await f.invoke('stop');
  assert.deepEqual([stopped.ok, stopped.status.state, leaks(stopped)], [true, 'stopped', false]);
  const restarted = await f.invoke('restart', { slots: 4 });
  assert.deepEqual([restarted.ok, restarted.status.state, leaks(restarted)], [true, 'ready', false]);
});

test('colon reasons cross as { reason, detail }; anything unsafe falls back', async () => {
  assert.deepEqual(splitReason('strata_exited:1'), { reason: 'strata_exited', detail: '1' });
  assert.deepEqual(splitReason('strata_pack:sha256_mismatch'), { reason: 'strata_pack', detail: 'sha256_mismatch' });
  assert.deepEqual(splitReason('strata_blocked_by_windows'), { reason: 'strata_blocked_by_windows', detail: '' });
  assert.deepEqual(splitReason('strata_exited:SIGTERM'), { reason: 'strata_exited', detail: '' });
  assert.deepEqual(splitReason('Z:\\secret\\x'), { reason: 'strata_operation_failed', detail: '' });
  assert.deepEqual(splitReason(':x'), { reason: 'strata_operation_failed', detail: '' });
  assert.deepEqual(splitReason(undefined, 'strata_start_failed'), { reason: 'strata_start_failed', detail: '' });

  const f = fixture();
  f.strataManager.ensureRunning = async () => ({ state: 'stopped', lastError: 'strata_pack:sha256_mismatch', apiKey: SECRET });
  const refused = await f.invoke('start');
  assert.deepEqual([refused.ok, refused.reason, refused.detail], [false, 'strata_pack', 'sha256_mismatch']);
  assert.deepEqual([refused.status.lastError, refused.status.lastErrorDetail], ['strata_pack', 'sha256_mismatch']);
  assert.equal(leaks(refused), false);
  f.strataManager.restart = async () => { throw Object.assign(new Error('Z:\\secret\\boom'), { reason: 'Z:\\secret' }); };
  assert.deepEqual(await f.invoke('restart'), { ok: false, reason: 'strata_operation_failed', detail: '' });
  f.setStatus({ state: 'crashed', lastError: 'strata_exited:3221225477' });
  const state = await f.invoke('getState');
  assert.deepEqual([state.manager.lastError, state.manager.lastErrorDetail], ['strata_exited', '3221225477']);
});

test('reverify forces the runtime check and splits its failure', async () => {
  const f = fixture();
  assert.deepEqual(await f.invoke('reverify'), { ok: true });
  assert.ok(f.calls.some(([name]) => name === 'runtime.reverify'));
  f.results.reverify = { ok: false, reason: 'strata_not_installed:link_refused' };
  assert.deepEqual(await f.invoke('reverify'), { ok: false, reason: 'strata_not_installed', detail: 'link_refused' });
});

test('fits come from main for all nine pairings: the 5090 table, learned windows, null where unknown', async () => {
  // A found install with no Setup config under a missing root: locate stops there, before any pack is touched.
  const discoverStrataInstall = async () => ({ ok: true, version: '0.1.67', warnings: [], root: path.join(os.tmpdir(), 'jenny-no-strata-install') });
  const located = async (rt) => { await rt.reverify().catch(() => {}); return rt; };
  let probes = 0;
  const runtime = createStrataRuntime({
    platform: 'win32', deps: { discoverStrataInstall }, getGpu: async () => { probes += 1; return { name: 'NVIDIA GeForce RTX 5090', vram_total_mb: 32607 }; },
    getShellConfigService: () => ({ getLocalEngines: () => ({ strata: { learnedFits: { '2:k8v4': 200000 } } }) }),
  });
  const before = await runtime.uiFacts();
  assert.deepEqual(before.fits, {}, 'no install found yet: no fits');
  assert.equal(before.pins.release, '0.2.21', 'the pins still show for the install steps');
  assert.equal(probes, 0, 'and no GPU probe for a user without Strata');
  await located(runtime);
  const { pins, fits } = await runtime.uiFacts();
  assert.deepEqual(pins, { release: '0.2.21', terminal: '0.1.67', engine: '0.1.67' });
  assert.deepEqual(fits, {
    '1:auto': { tokens: 228352, source: 'measured' }, '1:k8v8': { tokens: 405504, source: 'measured' },
    '1:k8v4': { tokens: null, source: 'default' }, '2:auto': { tokens: 118016, source: 'measured' },
    '2:k8v8': { tokens: 221952, source: 'measured' }, '2:k8v4': { tokens: 200000, source: 'learned' },
    '4:auto': { tokens: 57856, source: 'measured' }, '4:k8v8': { tokens: 114432, source: 'measured' },
    '4:k8v4': { tokens: 150016, source: 'measured' },
  });
  const unknownCard = await located(createStrataRuntime({ platform: 'win32', deps: { discoverStrataInstall }, getGpu: async () => null }));
  const unknown = await unknownCard.uiFacts();
  assert.equal(Object.keys(unknown.fits).length, 9);
  assert.ok(Object.values(unknown.fits).every((fit) => fit.tokens === null && fit.source === 'default'));
  runtime.dispose();
  unknownCard.dispose();
});
