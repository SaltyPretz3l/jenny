'use strict';

const { buildFeatureFlags } = require('../feature-flags');
const { createRemoteControlService } = require('../remote/remote-control-service');

const REMOTE_PLUGIN_IDENTITY = Object.freeze({
  publisher_id: 'jenny-official',
  plugin_id: 'remote-control',
});

function pluginIsActive(state) {
  return Array.isArray(state?.plugins) && state.plugins.some((plugin) => (
    plugin?.publisher_id === REMOTE_PLUGIN_IDENTITY.publisher_id
    && plugin?.plugin_id === REMOTE_PLUGIN_IDENTITY.plugin_id
    && plugin?.effective_state === 'active'
  ));
}

function createRemoteRuntimeWiring({
  backendService,
  secureStore,
  shellConfigService,
  env = process.env,
  mainLifecycle,
  getMainWindow = () => null,
  pluginStateSource,
  log = () => {},
  createService = createRemoteControlService,
} = {}) {
  if (!backendService || !secureStore || !shellConfigService
    || typeof shellConfigService.getState !== 'function'
    || typeof shellConfigService.on !== 'function'
    || typeof mainLifecycle?.registerShutdownFence !== 'function'
    || typeof mainLifecycle?.registerShutdownTask !== 'function'
    || typeof pluginStateSource?.subscribe !== 'function'
    || typeof createService !== 'function') {
    throw new TypeError('Invalid remote runtime wiring configuration.');
  }

  let disposed = false;
  let pluginAuthority = 'inactive';
  let readVersion = 0;
  let windowBinding = null;
  const featureFlags = () => buildFeatureFlags(
    env,
    shellConfigService.getState().featureOverrides || {},
  );
  const service = createService({
    backendService,
    secureStore,
    featureFlags,
    isPluginActive: () => pluginAuthority === 'active',
    isWindowAlive: () => {
      const window = getMainWindow();
      return !!window && !window.isDestroyed();
    },
    portalOriginFor: (wss) => `https://${new URL(wss).host}`,
    now: Date.now,
    setTimer: setTimeout,
    clearTimer: clearTimeout,
    WebSocketCtor: globalThis.WebSocket,
    log,
  });

  const unregisterFence = mainLifecycle.registerShutdownFence(
    () => service.denyAdmission('app_quit'),
  );
  const unregisterShutdown = mainLifecycle.registerShutdownTask(
    () => service.denyAdmission('app_quit'),
  );

  function denyAdmission(reason) {
    return service.denyAdmission(reason);
  }

  function reportStateReadFailure() {
    try { log('WARN', 'remote.plugin_state_unavailable', { reason: 'state_read_failed' }); }
    catch (_error) { /* logging is optional */ }
  }

  function applyPluginState(nextState, version) {
    if (disposed || version !== readVersion) return;
    if (!Array.isArray(nextState?.plugins)) {
      rejectPluginRead(version);
      return;
    }
    pluginAuthority = pluginIsActive(nextState) ? 'active' : 'inactive';
    if (pluginAuthority === 'inactive') void denyAdmission('plugin_disabled');
  }

  function rejectPluginRead(version) {
    if (disposed || version !== readVersion) return;
    pluginAuthority = 'inactive';
    reportStateReadFailure();
    void denyAdmission('plugin_state_unavailable');
  }

  function refreshPluginState(candidate) {
    const version = ++readVersion;
    if (candidate && Array.isArray(candidate.plugins)) {
      applyPluginState(candidate, version);
      return;
    }
    pluginAuthority = 'uncertain';
    let pending;
    try { pending = pluginStateSource.getState?.(); }
    catch (_error) { rejectPluginRead(version); return; }
    if (!pending) {
      pluginAuthority = 'inactive';
      return;
    }
    Promise.resolve(pending).then(
      (state) => applyPluginState(state, version),
      () => rejectPluginRead(version),
    );
  }

  let remoteFlagEnabled = featureFlags().remote_control === true;
  const onConfigChanged = () => {
    const nextEnabled = featureFlags().remote_control === true;
    if (remoteFlagEnabled && !nextEnabled) void denyAdmission('feature_disabled');
    remoteFlagEnabled = nextEnabled;
  };
  shellConfigService.on('changed', onConfigChanged);
  const unsubscribePluginState = pluginStateSource.subscribe(refreshPluginState);
  refreshPluginState();

  function detachWindow() {
    if (!windowBinding) return;
    windowBinding.window.removeListener?.('closed', windowBinding.listener);
    windowBinding = null;
  }

  function attachWindow() {
    const window = getMainWindow();
    if (!window || window.isDestroyed() || windowBinding?.window === window) return;
    detachWindow();
    const listener = () => {
      windowBinding = null;
      void denyAdmission('window_closed');
    };
    window.once?.('closed', listener);
    windowBinding = { window, listener };
  }

  const facade = Object.freeze({
    status: service.status.bind(service),
    getState: service.getState.bind(service),
    enable: (...args) => { attachWindow(); return service.enable(...args); },
    disable: service.disable.bind(service),
    openPairing: service.openPairing.bind(service),
    revokeDevice: service.revokeDevice.bind(service),
    forgetAll: service.forgetAll.bind(service),
    setRelay: service.setRelay.bind(service),
    shareSession: service.shareSession.bind(service),
    unshareSession: service.unshareSession.bind(service),
    onChanged: service.onChanged.bind(service),
    takeControl: service.takeControl.bind(service),
  });

  async function dispose() {
    if (disposed) return;
    disposed = true;
    unregisterFence?.();
    unregisterShutdown?.();
    shellConfigService.removeListener?.('changed', onConfigChanged);
    try { unsubscribePluginState?.(); } catch (_error) { /* teardown is best effort */ }
    detachWindow();
    await denyAdmission('dispose');
  }

  return Object.freeze({ facade, denyAdmission, dispose });
}

module.exports = {
  REMOTE_PLUGIN_IDENTITY,
  createRemoteRuntimeWiring,
  pluginIsActive,
};
