'use strict';

// Coverage for services/main/chatgpt-plan-usage-ipc.js: descriptor shape,
// registration wiring (invoke handler + push forwarding), and the flag-off /
// missing-backendService no-op paths. See docs/plans "ChatGPT plan-usage
// meter" W2.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { getBridgeDescriptor } = require('../services/ipc-contract');
const { registerChatGptPlanUsageIpc } = require('../services/main/chatgpt-plan-usage-ipc');
const { createTrackedTempDir, cleanupTrackedResources } = require('./helpers/resource-cleanup');

test.afterEach(cleanupTrackedResources);

function createFakeIpcMain() {
  const invoke = new Map();
  return {
    handle(channel, handler) {
      invoke.set(channel, handler);
    },
    invoke,
  };
}

// A minimal EventEmitter-shaped double: enough for backendService.on/off/emit
// (the registrar's cheap "backend-status" push hook) without pulling in a
// full recorder harness.
function createFakeBackendServiceEmitter() {
  const listeners = new Map();
  return {
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
    },
    off(event, handler) {
      listeners.get(event)?.delete(handler);
    },
    emit(event, payload) {
      for (const handler of listeners.get(event) || []) {
        handler(payload);
      }
    },
  };
}

function buildBackendService(overrides = {}) {
  const emitter = createFakeBackendServiceEmitter();
  let statusCallback = null;
  return {
    featureFlags: { chatgpt_plan_meter: true },
    currentEngineType: 'chatgpt',
    chatgptAuthService: {
      getAccountId: () => 'acct-1',
      getStatus: () => ({ state: 'signed_in', email: 'person@example.com', planType: 'plus' }),
      onStatusChange(cb) {
        statusCallback = cb;
        return () => { statusCallback = null; };
      },
      _fireStatus: (status) => statusCallback?.(status),
    },
    on: emitter.on,
    off: emitter.off,
    emit: emitter.emit,
    ...overrides,
  };
}

function baseDeps(overrides = {}) {
  const dir = createTrackedTempDir('jenny-chatgpt-plan-usage-ipc-');
  const pushed = [];
  return {
    deps: {
      backendService: buildBackendService(),
      shellConfigService: { getState: () => ({ preferredEngineType: 'chatgpt' }) },
      sendBridgeEvent: (methodPath, payload) => pushed.push({ methodPath, payload }),
      app: { getPath: () => dir, once: () => {} },
      log: () => {},
      ...overrides,
    },
    pushed,
    dir,
  };
}

test('chatgptPlanUsage.getSnapshot and chatgptPlanUsage.onSnapshot descriptors are correctly shaped', () => {
  const getSnapshot = getBridgeDescriptor('chatgptPlanUsage.getSnapshot');
  assert.ok(getSnapshot);
  assert.equal(getSnapshot.kind, 'invoke');
  assert.equal(getSnapshot.channel, 'chatgpt-plan-usage:get-snapshot');

  const onSnapshot = getBridgeDescriptor('chatgptPlanUsage.onSnapshot');
  assert.ok(onSnapshot);
  assert.equal(onSnapshot.kind, 'subscribe');
  assert.equal(onSnapshot.channel, 'chatgpt-plan-usage:snapshot');
});

test('registrar registers the invoke handler and returns the first-paint payload', async () => {
  const ipc = createFakeIpcMain();
  const { deps } = baseDeps();
  const teardown = registerChatGptPlanUsageIpc(ipc, deps);
  assert.equal(typeof teardown, 'function');

  const handler = ipc.invoke.get('chatgpt-plan-usage:get-snapshot');
  assert.ok(handler, 'the invoke handler must be registered');
  const payload = await handler();
  assert.equal(payload.ok, true);
  assert.equal(payload.provider_id, 'chatgpt');
  assert.equal(payload.engine_active, true);
  assert.deepEqual(payload.account, { email: 'person@example.com', plan_type: 'plus' });
  assert.equal(payload.snapshot, null, 'nothing has been ingested yet');
});

test('a store change is forwarded as chatgptPlanUsage.onSnapshot with a fresh payload', async () => {
  const ipc = createFakeIpcMain();
  const { deps, pushed } = baseDeps();
  registerChatGptPlanUsageIpc(ipc, deps);

  deps.backendService.chatgptPlanUsageStore.ingest({
    schema_version: 1,
    primary: { used_percent: 40, reset_at: 1_900_000_000 },
  }, { source: 'chat_done' });

  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].methodPath, 'chatgptPlanUsage.onSnapshot');
  assert.equal(pushed[0].payload.snapshot.primary.used_percent, 40);
  assert.equal(pushed[0].payload.snapshot.source, 'chat_done');
});

test('an auth status change pushes a fresh payload (e.g. sign-out clears the account)', async () => {
  const ipc = createFakeIpcMain();
  const { deps, pushed } = baseDeps();
  registerChatGptPlanUsageIpc(ipc, deps);

  deps.backendService.chatgptAuthService._fireStatus({ state: 'signed_out' });
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].methodPath, 'chatgptPlanUsage.onSnapshot');
});

test('a backend-status emission pushes only when the payload actually changed (engine-change proxy)', () => {
  const ipc = createFakeIpcMain();
  const { deps, pushed } = baseDeps();
  registerChatGptPlanUsageIpc(ipc, deps);

  deps.backendService.emit('backend-status', { phase: 'ready' });
  assert.equal(pushed.length, 1, 'first tick establishes the baseline payload');
  assert.equal(pushed[0].methodPath, 'chatgptPlanUsage.onSnapshot');
  deps.backendService.emit('backend-status', { phase: 'ready' });
  deps.backendService.emit('backend-status', { phase: 'ready' });
  assert.equal(pushed.length, 1, 'identical payloads are not re-pushed (no renderer repaint per lifecycle tick)');

  deps.backendService.currentEngineType = 'ollama';
  deps.shellConfigService.getState = () => ({ preferredEngineType: 'ollama' });
  deps.backendService.emit('backend-status', { phase: 'ready' });
  assert.equal(pushed.length, 2, 'an engine change produces a different payload and pushes');
  assert.equal(pushed[1].payload.engine_active, false);
});

test('currentEngineType is compared case-insensitively like the rest of the engine plumbing', async () => {
  const ipc = createFakeIpcMain();
  const { deps } = baseDeps();
  deps.backendService.currentEngineType = 'ChatGPT';
  registerChatGptPlanUsageIpc(ipc, deps);
  const payload = await ipc.invoke.get('chatgpt-plan-usage:get-snapshot')();
  assert.equal(payload.engine_active, true);
});

test('flag off registers zero channels and returns a no-op teardown, without throwing', () => {
  const ipc = createFakeIpcMain();
  const { deps } = baseDeps({
    backendService: buildBackendService({ featureFlags: { chatgpt_plan_meter: false } }),
  });
  let teardown;
  assert.doesNotThrow(() => {
    teardown = registerChatGptPlanUsageIpc(ipc, deps);
  });
  assert.equal(ipc.invoke.size, 0);
  assert.equal(typeof teardown, 'function');
  assert.doesNotThrow(() => teardown());
});

test('a missing backendService registers zero channels and does not throw', () => {
  const ipc = createFakeIpcMain();
  const { deps } = baseDeps({ backendService: undefined });
  let teardown;
  assert.doesNotThrow(() => {
    teardown = registerChatGptPlanUsageIpc(ipc, deps);
  });
  assert.equal(ipc.invoke.size, 0);
  assert.doesNotThrow(() => teardown());
});

test('engine_active is false when neither currentEngineType nor preferredEngineType is chatgpt', async () => {
  const ipc = createFakeIpcMain();
  const { deps } = baseDeps({
    backendService: buildBackendService({ currentEngineType: 'ollama' }),
    shellConfigService: { getState: () => ({ preferredEngineType: 'ollama' }) },
  });
  registerChatGptPlanUsageIpc(ipc, deps);
  const handler = ipc.invoke.get('chatgpt-plan-usage:get-snapshot');
  const payload = await handler();
  assert.equal(payload.engine_active, false);
});

test('account is null when the auth service is signed out', async () => {
  const ipc = createFakeIpcMain();
  const backendService = buildBackendService();
  backendService.chatgptAuthService.getStatus = () => ({ state: 'signed_out' });
  const { deps } = baseDeps({ backendService });
  registerChatGptPlanUsageIpc(ipc, deps);
  const handler = ipc.invoke.get('chatgpt-plan-usage:get-snapshot');
  const payload = await handler();
  assert.equal(payload.account, null);
});

test('teardown unsubscribes every listener so a later store/auth/backend change no longer pushes', () => {
  const ipc = createFakeIpcMain();
  const { deps, pushed } = baseDeps();
  const teardown = registerChatGptPlanUsageIpc(ipc, deps);
  teardown();

  deps.backendService.chatgptPlanUsageStore.ingest({
    schema_version: 1,
    primary: { used_percent: 10, reset_at: 1_900_000_000 },
  }, { source: 'chat_done' });
  deps.backendService.chatgptAuthService._fireStatus({ state: 'signed_out' });
  deps.backendService.emit('backend-status', { phase: 'ready' });

  assert.equal(pushed.length, 0);
});

test('the file at userData/chatgpt-plan-usage.json is only created after an ingest, never at registration', () => {
  const fs = require('node:fs');
  const ipc = createFakeIpcMain();
  const { deps, dir } = baseDeps();
  registerChatGptPlanUsageIpc(ipc, deps);
  assert.equal(fs.existsSync(path.join(dir, 'chatgpt-plan-usage.json')), false);
});
