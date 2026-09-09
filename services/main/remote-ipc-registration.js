'use strict';

const { registerIpcInvokeHandlers } = require('../ipc-contract');
const { createRemoteRuntimeWiring } = require('./remote-runtime-wiring');
const { renderQrSvg } = require('../remote/remote-qr-svg');

const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const UNAVAILABLE_STATE = Object.freeze({
  state: 'unavailable',
  reachable: false,
  reason: 'remote_unavailable',
  relay_host: '',
  epoch_active: false,
  pairing: null,
  devices: [],
  shared_sessions: [],
  last_error: null,
  setup: Object.freeze({
    loaded: false,
    can_configure: false,
    can_enable: false,
    reason: 'remote_unavailable',
  }),
});

function plainObject(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch (_error) {
    return false;
  }
}

function exactKeys(value, keys) {
  try {
    return plainObject(value) && Object.keys(value).length === keys.length
      && keys.every((key) => Object.hasOwn(value, key));
  } catch (_error) {
    return false;
  }
}

function invalid() {
  return { ok: false, reason: 'invalid_request' };
}

function unavailableState() {
  return {
    ...UNAVAILABLE_STATE,
    devices: [],
    shared_sessions: [],
    setup: { ...UNAVAILABLE_STATE.setup },
  };
}

function registerRemoteIpc(ipcMain, {
  backendService,
  secureStore,
  shellConfigService,
  env,
  mainLifecycle,
  getMainWindow,
  sendBridgeEvent = () => {},
  log = () => {},
  createWiring = createRemoteRuntimeWiring,
} = {}) {
  const pluginSubscribers = new Set();
  let pluginService = null;
  let wiring = null;
  let facade = null;
  let unsubscribeState = null;
  let teardownPromise = null;
  let unavailableLogged = false;
  let qrCache = null;

  function reportUnavailable() {
    if (unavailableLogged) return;
    unavailableLogged = true;
    try { log('WARN', 'remote.ipc_unavailable', { reason: 'remote_unavailable' }); }
    catch (_error) { /* logging is optional */ }
  }

  function reportFailure(event, reason) {
    try { log('WARN', event, { reason }); }
    catch (_error) { /* logging is optional */ }
  }

  const pluginStateSource = {
    getState() {
      if (typeof pluginService?.getState !== 'function') return null;
      return pluginService.getState();
    },
    subscribe(callback) {
      if (typeof callback !== 'function') return () => {};
      pluginSubscribers.add(callback);
      return () => pluginSubscribers.delete(callback);
    },
  };

  function notifyPluginSubscribers(state) {
    for (const callback of [...pluginSubscribers]) {
      try { callback(state); }
      catch (_error) { reportFailure('remote.plugin_state_unavailable', 'refresh_failed'); }
    }
  }

  function decoratePairing(value) {
    try {
      const pairing = value?.pairing;
      if (!pairing || typeof pairing.url !== 'string' || !pairing.url) return value;
      if (!qrCache || qrCache.pairingId !== pairing.pairing_id || qrCache.url !== pairing.url) {
        qrCache = {
          pairingId: pairing.pairing_id,
          url: pairing.url,
          svg: renderQrSvg(pairing.url),
        };
      }
      return { ...value, pairing: { ...pairing, qr_svg: qrCache.svg } };
    } catch (_error) {
      reportFailure('remote.qr_render_failed', 'render_failed');
      return value;
    }
  }

  function pushState(status) {
    try { sendBridgeEvent('remote.onStateChanged', decoratePairing(status)); }
    catch (_error) { reportFailure('remote.state_push_failed', 'bridge_failed'); }
  }

  if (secureStore && typeof mainLifecycle?.registerShutdownTask === 'function') {
    try {
      wiring = createWiring({
        backendService,
        secureStore,
        shellConfigService,
        env,
        mainLifecycle,
        getMainWindow,
        pluginStateSource,
        log,
      });
      facade = wiring?.facade || null;
      if (!facade || typeof facade.onChanged !== 'function') throw new TypeError('Remote facade unavailable.');
      unsubscribeState = facade.onChanged(pushState);
    } catch (_error) {
      const failedWiring = wiring;
      facade = null;
      reportUnavailable();
      Promise.resolve().then(() => failedWiring?.dispose?.()).catch(() => {
        reportFailure('remote.ipc_teardown_failed', 'dispose_failed');
      });
      wiring = null;
    }
  } else {
    reportUnavailable();
  }

  async function invoke(method, args = []) {
    try {
      if (!facade || typeof facade[method] !== 'function') {
        reportUnavailable();
        return ['getState', 'status'].includes(method)
          ? unavailableState() : { ok: false, reason: 'remote_unavailable' };
      }
      return await facade[method](...args);
    } catch (_error) {
      reportFailure('remote.ipc_operation_failed', 'operation_failed');
      return ['getState', 'status'].includes(method)
        ? unavailableState() : { ok: false, reason: 'remote_unavailable' };
    }
  }

  const empty = (payload) => exactKeys(payload, []);
  const session = (payload) => exactKeys(payload, ['session_id'])
    && typeof payload.session_id === 'string' && payload.session_id.length <= 128;
  function request(payload, validate, operation) {
    try { return validate(payload) ? operation() : invalid(); }
    catch (_error) { return invalid(); }
  }
  const channels = registerIpcInvokeHandlers(ipcMain, {
    'remote.getState': (_event, payload) => (
      payload === undefined ? invoke('getState').then(decoratePairing) : invalid()
    ),
    'remote.enable': (_event, payload) => request(payload, empty, () => invoke('enable')),
    'remote.disable': (_event, payload) => request(payload, empty, () => invoke('disable')),
    'remote.openPairing': (_event, payload) => request(
      payload, empty, async () => decoratePairing(await invoke('openPairing'))
    ),
    'remote.revokeDevice': (_event, payload) => request(
      payload,
      (value) => exactKeys(value, ['device_id']) && typeof value.device_id === 'string'
        && DEVICE_ID_RE.test(value.device_id),
      () => invoke('revokeDevice', [payload.device_id])
    ),
    'remote.forgetAll': (_event, payload) => request(
      payload,
      (value) => exactKeys(value, ['confirm']) && value.confirm === true,
      () => invoke('forgetAll')
    ),
    'remote.setRelay': (_event, payload) => request(
      payload,
      (value) => exactKeys(value, ['relay_url']) && typeof value.relay_url === 'string'
        && value.relay_url.length <= 512,
      () => invoke('setRelay', [payload.relay_url])
    ),
    'remote.shareSession': (_event, payload) => request(
      payload, session, () => invoke('shareSession', [payload.session_id])
    ),
    'remote.unshareSession': (_event, payload) => request(
      payload, session, () => invoke('unshareSession', [payload.session_id])
    ),
    'remote.takeControl': (_event, payload) => request(
      payload, session, () => invoke('takeControl', [payload.session_id])
    ),
  });

  function wrapBridgeEvents(send) {
    return function wrappedBridgeEvent(...args) {
      try {
        return send(...args);
      } finally {
        if (args[0] === 'plugins.onChanged') notifyPluginSubscribers(args[1]);
      }
    };
  }

  function attachPluginService(service) {
    try { pluginService = service && typeof service.getState === 'function' ? service : null; }
    catch (_error) { pluginService = null; }
    notifyPluginSubscribers();
  }

  function teardown() {
    if (teardownPromise) return teardownPromise;
    for (const channel of channels) {
      try { ipcMain.removeHandler?.(channel); } catch (_error) { /* best effort */ }
    }
    try { unsubscribeState?.(); } catch (_error) { /* best effort */ }
    unsubscribeState = null;
    pluginSubscribers.clear();
    teardownPromise = Promise.resolve().then(() => wiring?.dispose?.()).catch(() => {
      reportFailure('remote.ipc_teardown_failed', 'dispose_failed');
    });
    return teardownPromise;
  }

  return Object.freeze({
    wrapBridgeEvents,
    attachPluginService,
    getFacade: () => facade,
    teardown,
  });
}

module.exports = { registerRemoteIpc };
