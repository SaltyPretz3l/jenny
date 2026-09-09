'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createRemoteRuntimeWiring } = require('../services/main/remote-runtime-wiring');
const { MainLifecycleController } = require('../services/main-lifecycle');

function pluginState(effectiveState = 'active') {
  return { ok: true, plugins: [{
    publisher_id: 'jenny-official',
    plugin_id: 'remote-control',
    effective_state: effectiveState,
  }] };
}

function harness(options = {}) {
  const order = [];
  const denials = [];
  const shellConfigService = new EventEmitter();
  let config = { featureOverrides: { remote_control: true } };
  shellConfigService.getState = () => config;
  const pluginListeners = new Set();
  let latestPluginState = pluginState();
  let readPluginState = () => latestPluginState;
  const pluginStateSource = {
    getState: () => readPluginState(),
    subscribe(listener) {
      order.push('plugin_subscribe');
      pluginListeners.add(listener);
      return () => pluginListeners.delete(listener);
    },
    publish(state) {
      latestPluginState = state;
      for (const listener of pluginListeners) listener(state);
    },
    notify() { for (const listener of pluginListeners) listener(); },
    setReader(reader) { readPluginState = reader; },
    listenerCount: () => pluginListeners.size,
  };
  const shutdownTasks = [];
  const shutdownFences = [];
  const mainLifecycle = options.mainLifecycle || {
    registerShutdownFence(fence) {
      order.push('shutdown_fence_registered');
      shutdownFences.push(fence);
      return () => shutdownFences.splice(shutdownFences.indexOf(fence), 1);
    },
    registerShutdownTask(task) {
      order.push('shutdown_registered');
      shutdownTasks.push(task);
      return () => shutdownTasks.splice(shutdownTasks.indexOf(task), 1);
    },
  };
  const window = new EventEmitter();
  let destroyed = false;
  window.isDestroyed = () => destroyed;
  let serviceDeps = null;
  const methods = ['status', 'getState', 'enable', 'disable', 'openPairing', 'revokeDevice',
    'forgetAll', 'setRelay', 'shareSession', 'unshareSession', 'onChanged', 'takeControl'];
  const service = Object.fromEntries(methods.map((name) => [name, (...args) => (
    ['status', 'getState'].includes(name) ? { state: 'off' }
      : (name === 'onChanged' ? () => {} : Promise.resolve({ ok: true, name, args }))
  )]));
  service.denyAdmission = (reason) => { denials.push(reason); return Promise.resolve(); };
  const createService = (deps) => {
    order.push('service_created');
    serviceDeps = deps;
    return service;
  };
  const wiring = createRemoteRuntimeWiring({
    backendService: {},
    secureStore: {},
    shellConfigService,
    env: {},
    mainLifecycle,
    getMainWindow: () => window,
    pluginStateSource,
    createService,
  });
  return {
    wiring, serviceDeps, order, denials, shellConfigService, pluginStateSource,
    shutdownFences, shutdownTasks, window,
    setConfig(next) { config = next; shellConfigService.emit('changed', next); },
    setDestroyed(next) { destroyed = next; },
  };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('shutdown admission task is registered before subscriptions and denies app quit', async (t) => {
  const value = harness();
  t.after(() => value.wiring.dispose());
  assert.deepEqual(value.order, [
    'service_created', 'shutdown_fence_registered', 'shutdown_registered', 'plugin_subscribe',
  ]);
  assert.equal(value.shutdownFences.length, 1);
  assert.equal(value.shutdownTasks.length, 1);
  await value.shutdownTasks[0]();
  assert.deepEqual(value.denials, ['app_quit']);
});

test('app-quit fence denies synchronously even when an earlier shutdown task never resolves', async () => {
  let releaseFirst;
  const lifecycle = new MainLifecycleController({});
  lifecycle.registerShutdownTask(() => new Promise((resolve) => { releaseFirst = resolve; }));
  const value = harness({ mainLifecycle: lifecycle });
  const pending = lifecycle._beginShutdown();
  assert.deepEqual(value.denials, ['app_quit']);
  await Promise.resolve();
  releaseFirst();
  await pending;
  await value.wiring.dispose();
});

test('feature and plugin transitions synchronously start bounded admission denial', async (t) => {
  const value = harness();
  t.after(() => value.wiring.dispose());
  await settle();
  value.setConfig({ featureOverrides: { remote_control: false } });
  assert.deepEqual(value.denials, ['feature_disabled']);
  value.pluginStateSource.publish(pluginState('disabled'));
  assert.deepEqual(value.denials, ['feature_disabled', 'plugin_disabled']);
});

test('plugin reads fail closed, recover when active, and ignore stale resolutions', async (t) => {
  const value = harness();
  t.after(() => value.wiring.dispose());
  await settle();
  assert.equal(value.serviceDeps.isPluginActive(), true);

  let resolveOlder;
  value.pluginStateSource.setReader(() => new Promise((resolve) => { resolveOlder = resolve; }));
  value.pluginStateSource.notify();
  assert.equal(value.serviceDeps.isPluginActive(), false);
  let resolveLatest;
  value.pluginStateSource.setReader(() => new Promise((resolve) => { resolveLatest = resolve; }));
  value.pluginStateSource.notify();
  resolveLatest(pluginState('active'));
  await settle();
  assert.equal(value.serviceDeps.isPluginActive(), true);
  resolveOlder(pluginState('disabled'));
  await settle();
  assert.equal(value.serviceDeps.isPluginActive(), true);
  assert.deepEqual(value.denials, []);

  value.pluginStateSource.setReader(() => Promise.reject(new Error('unavailable')));
  value.pluginStateSource.notify();
  assert.equal(value.serviceDeps.isPluginActive(), false);
  await settle();
  assert.deepEqual(value.denials, ['plugin_state_unavailable']);
});

test('window liveness is dynamic and its close listener is attached on first enable', async (t) => {
  const value = harness();
  t.after(() => value.wiring.dispose());
  assert.equal(value.window.listenerCount('closed'), 0);
  value.setDestroyed(true);
  assert.equal(value.serviceDeps.isWindowAlive(), false);
  value.setDestroyed(false);
  assert.equal(value.serviceDeps.isWindowAlive(), true);
  await value.wiring.facade.enable();
  assert.equal(value.window.listenerCount('closed'), 1);
  value.window.emit('closed');
  assert.deepEqual(value.denials, ['window_closed']);
});

test('dispose removes every owned listener and denies admission once', async () => {
  const value = harness();
  await value.wiring.facade.enable();
  assert.equal(value.shellConfigService.listenerCount('changed'), 1);
  assert.equal(value.pluginStateSource.listenerCount(), 1);
  assert.equal(value.window.listenerCount('closed'), 1);
  await value.wiring.dispose();
  assert.equal(value.shellConfigService.listenerCount('changed'), 0);
  assert.equal(value.pluginStateSource.listenerCount(), 0);
  assert.equal(value.window.listenerCount('closed'), 0);
  assert.equal(value.shutdownFences.length, 0);
  assert.equal(value.shutdownTasks.length, 0);
  assert.deepEqual(value.denials, ['dispose']);
  await value.wiring.dispose();
  assert.deepEqual(value.denials, ['dispose']);
});

test('facade exposes exactly the Remote Control IPC methods', async (t) => {
  const value = harness();
  t.after(() => value.wiring.dispose());
  assert.deepEqual(Object.keys(value.wiring.facade).sort(), [
    'disable', 'enable', 'forgetAll', 'getState', 'onChanged', 'openPairing',
    'revokeDevice', 'setRelay', 'shareSession', 'status', 'takeControl', 'unshareSession',
  ]);
});
