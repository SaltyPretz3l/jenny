'use strict';

const remoteCrypto = require('./remote-crypto');
const remoteContracts = require('./remote-contracts');
const remoteLimits = require('./remote-limits');
const remotePolicy = require('./remote-policy');
const { createDeviceStore } = require('./remote-device-store');
const { createPairingService } = require('./remote-pairing-service');
const { createRelayClient } = require('./remote-relay-client');
const { createLiveRuntime } = require('./remote-live-runtime');

const SNAPSHOT_SESSION_MAX = 64;
const FAILURE_REASON_RE = /^[a-z_]{1,48}$/;
const KNOWN_FAILURE_REASONS = new Set([
  'app_quit', 'claim_rejected', 'claim_send_failed', 'claim_timeout', 'connect_failed',
  'disabled', 'displaced', 'dispose', 'disposed', 'enable_cancelled', 'enable_failed',
  'feature_disabled', 'forget_all', 'forget_not_deleted', 'heartbeat_timeout',
  'idle_timeout', 'lease_expired', 'load_failed', 'no_desktop', 'not_reachable',
  'plugin_disabled', 'plugin_state_unavailable', 'rate_limited', 'ready',
  'relay_claim_timeout', 'relay_error', 'relay_host_changed', 'relay_reconnecting',
  'record_malformed', 'record_version_unsupported', 'relay_not_set', 'relay_url_invalid',
  'remote_disabled', 'revocation_not_saved', 'secure_store_error', 'socket_closed',
  'starting', 'storage_unavailable', 'websocket_unavailable', 'window_closed',
]);

function knownFailureReason(value) {
  return typeof value === 'string' && FAILURE_REASON_RE.test(value)
    && KNOWN_FAILURE_REASONS.has(value) ? value : 'relay_error';
}

function createRemoteControlService(deps = {}) {
  const {
    backendService,
    secureStore,
    featureFlags,
    isPluginActive,
    isWindowAlive,
    now,
    WebSocketCtor,
    portalOriginFor,
    factories = {},
    log = () => {},
    random = Math.random,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = deps;
  if (!backendService || !secureStore || typeof featureFlags !== 'function'
    || typeof isPluginActive !== 'function' || typeof isWindowAlive !== 'function'
    || typeof now !== 'function' || typeof portalOriginFor !== 'function'
    || typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
    throw new TypeError('Invalid remote control service configuration.');
  }

  const crypto = factories.crypto || remoteCrypto;
  const contracts = factories.contracts || remoteContracts;
  const limits = factories.limits || remoteLimits;
  const policy = factories.policy || remotePolicy;
  const buildStore = factories.createDeviceStore || createDeviceStore;
  const buildPairing = factories.createPairingService || createPairingService;
  const buildRelay = factories.createRelayClient || createRelayClient;
  const buildRuntime = factories.createLiveRuntime || createLiveRuntime;
  const deviceStore = buildStore({ secureStore, now, limits });
  const subscribers = new Set();
  const reconcilePending = new Set();
  let state = 'off';
  let reason = 'disabled';
  let lastError = null;
  let loaded = false;
  let generation = 0;
  let activeAttempt = null;
  let liveRuntime = null;
  let cleanupPromise = null;
  let cleanupTarget = 'off';
  let disposed = false;
  let forgetBlocked = false;
  let hydrationSuppressed = false;
  let loadFailureReason = '';
  let loadPromise = null;

  function at() {
    const value = Number(now());
    return Number.isFinite(value) ? value : 0;
  }

  function safe(callback, fallback = false) {
    try {
      return callback();
    } catch (_error) {
      return fallback;
    }
  }

  function report(level, event, fields = {}) {
    try {
      log(level, event, fields);
    } catch (_error) {
      // Logging is optional.
    }
  }

  function setFailure(code) {
    reason = knownFailureReason(code);
    lastError = { code: reason, at: at() };
  }

  function currentRecord() {
    return deviceStore.getRecord?.() || null;
  }

  function currentFlags() {
    return safe(() => featureFlags() || {}, {});
  }

  function sessionFor(sessionId) {
    return safe(() => backendService.sessionStore?.getSession?.(sessionId) || null, null);
  }

  function relayHostFor(record) {
    try {
      return record?.relay_url ? new URL(record.relay_url).host : '';
    } catch (_error) {
      return '';
    }
  }

  function reconcileShared() {
    const runtime = liveRuntime;
    if (!runtime?.isAdmitted()) return;
    for (const sessionId of currentRecord()?.shared_sessions || []) {
      const session = sessionFor(sessionId);
      if (session && policy.canListSession(session, currentFlags())) continue;
      if (reconcilePending.has(sessionId)) continue;
      reconcilePending.add(sessionId);
      runtime.suppressGrant(sessionId);
      Promise.resolve(deviceStore.unshareSession(sessionId)).then((result) => {
        if (!result?.ok) {
          report('WARN', 'remote.session_reconcile_failed', { reason: 'persist_failed' });
        }
      }, () => {
        report('WARN', 'remote.session_reconcile_failed', { reason: 'persist_failed' });
      }).finally(() => reconcilePending.delete(sessionId));
    }
  }

  function status() {
    reconcileShared();
    const record = currentRecord();
    const flags = currentFlags();
    const runtime = liveRuntime;
    const relayHost = relayHostFor(record);
    const setupLoaded = loaded && !!record;
    const pluginActive = safe(isPluginActive) === true;
    const windowAlive = safe(isWindowAlive) === true;
    let canConfigure = false;
    let canEnable = false;
    let setupReason = '';
    if (flags.remote_control !== true) setupReason = 'feature_disabled';
    else if (!pluginActive) setupReason = 'plugin_inactive';
    else if (forgetBlocked) setupReason = 'forget_not_deleted';
    else if (state !== 'off') setupReason = 'not_off';
    else if (!setupLoaded && loadFailureReason) setupReason = loadFailureReason;
    else if (!setupLoaded) setupReason = 'store_not_loaded';
    else if (!record.relay_url) {
      canConfigure = true;
      setupReason = 'relay_not_set';
    } else if (typeof WebSocketCtor !== 'function') {
      canConfigure = true;
      setupReason = 'websocket_unavailable';
    } else if (!windowAlive) {
      canConfigure = true;
      setupReason = 'window_unavailable';
    } else {
      canConfigure = true;
      canEnable = true;
    }
    const connected = new Set([...(runtime?.peers.values?.() || [])]
      .filter((peer) => peer.state === 'ready')
      .map((peer) => peer.deviceId));
    const devices = (record?.devices || []).slice(0, limits.MAX_DEVICES).map((device) => ({
      device_id: device.device_id,
      label: String(device.label || '').slice(0, 64),
      paired_at: device.paired_at,
      last_seen_at: device.last_seen_at,
      connected: connected.has(device.device_id),
    }));
    const sharedSessions = (record?.shared_sessions || [])
      .filter((sessionId) => !runtime || runtime.hasGrant(sessionId))
      .map(sessionFor)
      .filter((session) => policy.canListSession(session, flags))
      .slice(0, SNAPSHOT_SESSION_MAX)
      .map((session) => ({
        id: session.id,
        title: String(session.title || '').slice(0, 200),
        controlled_by: runtime?.leases.controllerOf(session.id) || null,
      }));
    const pairState = activeAttempt?.pairingService?.status?.();
    const pairing = pairState?.open && activeAttempt?.pairingView ? {
      pairing_id: activeAttempt.pairingView.pairing_id,
      url: activeAttempt.pairingView.url,
      expires_at: activeAttempt.pairingView.expires_at,
    } : null;
    const reachable = state === 'ready' && runtime?.isAdmitted() === true
      && activeAttempt?.relay?.getState?.() === 'claimed' && loaded
      && !forgetBlocked
      && flags.remote_control === true && pluginActive && windowAlive;
    return {
      state,
      reachable,
      reason,
      relay_host: relayHost,
      epoch_active: runtime?.isAdmitted() === true,
      pairing,
      devices,
      shared_sessions: sharedSessions,
      last_error: lastError ? { ...lastError } : null,
      setup: { loaded: setupLoaded, can_configure: canConfigure, can_enable: canEnable, reason: setupReason },
    };
  }

  function notify() {
    const snapshot = status();
    for (const callback of [...subscribers]) {
      try {
        callback(snapshot);
      } catch (_error) {
        // Subscriber failures are isolated.
      }
    }
  }

  function onChanged(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('Remote change listener must be a function.');
    }
    subscribers.add(callback);
    return () => subscribers.delete(callback);
  }

  function attemptIsCurrent(attempt) {
    return activeAttempt === attempt && generation === attempt.generation;
  }

  function settleClaim(attempt, value) {
    if (!attempt.claimResolve) return;
    const resolve = attempt.claimResolve;
    attempt.claimResolve = null;
    if (attempt.claimTimer != null) clearTimer(attempt.claimTimer);
    attempt.claimTimer = null;
    resolve(value === true && attemptIsCurrent(attempt));
  }

  function waitForClaim(attempt) {
    return new Promise((resolve) => {
      attempt.claimResolve = resolve;
      attempt.claimTimer = setTimer(
        () => settleClaim(attempt, false),
        limits.RELAY_ONLINE_LEASE_MS
      );
    });
  }

  function onRelayState(attempt, next, relayReason) {
    if (!attemptIsCurrent(attempt)) return;
    if (state === 'starting') {
      if (next === 'claimed') settleClaim(attempt, true);
      if (next === 'closed') {
        attempt.claimFailure = knownFailureReason(relayReason || 'claim_rejected');
        settleClaim(attempt, false);
      }
      return;
    }
    if (next === 'reconnecting' && attempt.runtime?.isAdmitted()) {
      state = 'reconnecting';
      reason = knownFailureReason(relayReason || 'relay_reconnecting');
      for (const peer of [...attempt.runtime.peers.values()]) peer.close('relay_disconnected');
      notify();
    } else if (next === 'claimed' && attempt.runtime?.isAdmitted()) {
      state = 'ready';
      reason = 'ready';
      notify();
    } else if (next === 'closed' && attempt.runtime?.isAdmitted()
      && ['displaced', 'claim_rejected', 'relay_host_changed'].includes(relayReason)) {
      beginDenial(relayReason, 'unavailable');
    }
  }

  async function cleanupAttempt(attempt, cleanupReason = 'remote_disabled') {
    if (!attempt || attempt.cleaned) return;
    attempt.cleaned = true;
    settleClaim(attempt, false);
    attempt.runtime?.denyAdmission(cleanupReason);
    try {
      await attempt.runtime?.dispose?.();
    } catch (_error) {
      report('WARN', 'runtime_dispose_failed', { reason: 'dispose_failed' });
    } finally {
      safe(() => attempt.pairingService?.close?.());
      attempt.pairingView = null;
      safe(() => attempt.relay?.disconnect?.(cleanupReason));
    }
  }

  async function finishCleanup(attempt, promise) {
    await cleanupAttempt(attempt);
    if (cleanupPromise !== promise) return;
    state = forgetBlocked ? 'unavailable' : cleanupTarget;
    if (state === 'off') reason = 'disabled';
    cleanupPromise = null;
    notify();
  }

  function beginDenial(denyReason = 'remote_disabled', finalState = 'off') {
    const boundedReason = knownFailureReason(denyReason);
    if (cleanupPromise) {
      if (finalState === 'unavailable') cleanupTarget = 'unavailable';
      return cleanupPromise;
    }
    generation += 1;
    const attempt = activeAttempt;
    activeAttempt = null;
    liveRuntime = null;
    safe(() => attempt?.pairingService?.close?.());
    if (attempt) attempt.pairingView = null;
    attempt?.runtime?.denyAdmission(boundedReason);
    state = 'stopping';
    reason = boundedReason;
    cleanupTarget = finalState;
    if (finalState === 'unavailable') setFailure(boundedReason);
    notify();
    let promise;
    promise = Promise.resolve().then(() => finishCleanup(attempt, promise));
    cleanupPromise = promise;
    return promise;
  }

  function denyAdmission(denyReason) {
    return beginDenial(denyReason, 'off');
  }

  function disable() {
    return beginDenial('remote_disabled', 'off');
  }

  async function enable() {
    if (forgetBlocked) return { ok: false, reason: 'forget_not_deleted' };
    if (disposed || state !== 'off') return { ok: false, reason: 'not_off' };
    if (currentFlags().remote_control !== true) return { ok: false, reason: 'feature_disabled' };
    if (safe(isPluginActive) !== true) return { ok: false, reason: 'plugin_inactive' };
    if (safe(isWindowAlive) !== true) return { ok: false, reason: 'window_unavailable' };
    state = 'starting';
    reason = 'starting';
    lastError = null;
    const attempt = { generation: ++generation, cleaned: false };
    activeAttempt = attempt;
    notify();
    try {
      const loadedResult = await ensureLoaded(true);
      if (!attemptIsCurrent(attempt)) throw new Error('enable_cancelled');
      if (!loadedResult?.ok) throw new Error(loadedResult?.reason || 'load_failed');
      const record = currentRecord();
      if (!record?.relay_url) throw new Error('relay_not_set');
      const desktopSecret = deviceStore.desktopSecret();
      try {
        attempt.route = await crypto.deriveRouteCredentials(desktopSecret);
      } finally {
        desktopSecret?.fill?.(0);
      }
      if (!attemptIsCurrent(attempt)) throw new Error('enable_cancelled');
      attempt.epoch = crypto.randomId();
      attempt.pairingService = buildPairing({ now, limits, deviceStore, crypto });
      attempt.pairing = {
        status: (...args) => attempt.pairingService.status(...args),
        consume: (...args) => attempt.pairingService.consume(...args),
        view: () => attempt.pairingView,
      };
      attempt.relay = buildRelay({
        url: record.relay_url,
        routeId: attempt.route.routeId,
        routeToken: attempt.route.routeToken,
        epoch: attempt.epoch,
        WebSocketCtor,
        now,
        setTimer,
        clearTimer,
        random,
        limits,
        onMessage: (message) => attempt.runtime?.onRelayMessage(message),
        onStateChange: (next, relayReason) => onRelayState(attempt, next, relayReason),
        log,
      });
      const claimed = waitForClaim(attempt);
      attempt.relay.connect();
      if (!await claimed || !attemptIsCurrent(attempt)) {
        throw new Error(attempt.claimFailure || 'relay_claim_timeout');
      }
      attempt.runtime = buildRuntime({
        epoch: attempt.epoch,
        route: attempt.route,
        relayUrl: record.relay_url,
        backendService,
        deviceStore,
        pairing: attempt.pairing,
        relay: attempt.relay,
        crypto,
        contracts,
        limits,
        policy,
        featureFlags: currentFlags,
        isPluginActive,
        now,
        setTimer,
        clearTimer,
        log,
        notify: () => {
          if (attemptIsCurrent(attempt) && liveRuntime === attempt.runtime) notify();
        },
        factories,
      });
      if (!attemptIsCurrent(attempt)) throw new Error('enable_cancelled');
      liveRuntime = attempt.runtime;
      reconcileShared();
      state = 'ready';
      reason = 'ready';
      notify();
      return { ok: true };
    } catch (error) {
      const failure = knownFailureReason(error?.message || 'enable_failed');
      const stale = !attemptIsCurrent(attempt);
      await cleanupAttempt(attempt, failure);
      if (stale) return { ok: false, reason: failure };
      activeAttempt = null;
      liveRuntime = null;
      setFailure(failure);
      state = attempt.claimFailure ? 'unavailable' : 'off';
      reason = failure;
      notify();
      return { ok: false, reason: failure };
    }
  }

  function openPairing() {
    const attempt = activeAttempt;
    if (state !== 'ready' || !liveRuntime?.isAdmitted() || !attempt?.pairingService) {
      return { ok: false, reason: 'not_reachable' };
    }
    try {
      attempt.pairingView = attempt.pairingService.openWindow({
        epoch: attempt.epoch,
        routeId: attempt.route.routeId,
        portalOrigin: portalOriginFor(currentRecord().relay_url),
      });
      notify();
      return {
        ok: true,
        pairing: {
          pairing_id: attempt.pairingView.pairing_id,
          url: attempt.pairingView.url,
          expires_at: attempt.pairingView.expires_at,
        },
      };
    } catch (_error) {
      return { ok: false, reason: 'pairing_unavailable' };
    }
  }

  function ensureLoaded(ownerOperation = false) {
    if (ownerOperation) hydrationSuppressed = false;
    if (loaded && currentRecord()) return Promise.resolve({ ok: true });
    if (!loadPromise) {
      loadPromise = Promise.resolve().then(() => deviceStore.load()).then((result) => {
        loaded = result?.ok === true;
        if (loaded) loadFailureReason = '';
        else {
          loadFailureReason = [
            'secure_store_error', 'record_malformed', 'record_version_unsupported',
          ].includes(result?.reason) ? result.reason : 'load_failed';
        }
        return loaded ? result : { ok: false, reason: loadFailureReason };
      }, () => {
        loaded = false;
        loadFailureReason = 'load_failed';
        return { ok: false, reason: loadFailureReason };
      }).finally(() => { loadPromise = null; });
    }
    return loadPromise;
  }

  async function getState() {
    if (loaded && currentRecord()) return status();
    if (disposed || forgetBlocked || state !== 'off' || hydrationSuppressed) return status();
    await ensureLoaded();
    return status();
  }

  async function revokeDevice(deviceId) {
    liveRuntime?.revokeDevice(deviceId);
    const ready = await ensureLoaded(true);
    if (!ready?.ok) return ready;
    const result = await deviceStore.revokeDevice(deviceId);
    if (result?.reason === 'revocation_not_saved') {
      setFailure('revocation_not_saved');
      await beginDenial('revocation_not_saved', 'unavailable');
    }
    notify();
    return result;
  }

  async function forgetAll() {
    forgetBlocked = true;
    hydrationSuppressed = true;
    await beginDenial('forget_all', 'off');
    const result = await deviceStore.forgetAll();
    loaded = false;
    if (!result?.ok) {
      forgetBlocked = true;
      setFailure('forget_not_deleted');
      state = 'unavailable';
    } else {
      forgetBlocked = false;
      lastError = null;
      state = 'off';
      reason = 'disabled';
    }
    notify();
    return result;
  }

  async function setRelay(url) {
    if (state !== 'off') return { ok: false, reason: 'not_off' };
    const ready = await ensureLoaded(true);
    if (!ready?.ok) return ready;
    if (state !== 'off') return { ok: false, reason: 'not_off' };
    const result = await deviceStore.setRelayUrl(url);
    notify();
    return result;
  }

  async function shareSession(sessionId) {
    const runtime = liveRuntime;
    const ready = await ensureLoaded(true);
    if (!ready?.ok) return ready;
    if (!policy.canListSession(sessionFor(sessionId), currentFlags())) {
      return { ok: false, reason: 'session_not_shareable' };
    }
    if (runtime && !runtime.isAdmitted()) return { ok: false, reason: 'epoch_invalid' };
    const result = runtime
      ? await runtime.shareSession(sessionId)
      : await deviceStore.shareSession(sessionId);
    notify();
    return result;
  }

  async function unshareSession(sessionId) {
    const result = liveRuntime?.isAdmitted()
      ? await liveRuntime.unshare(sessionId)
      : await deviceStore.unshareSession(sessionId);
    notify();
    return result;
  }

  function takeControl(sessionId) {
    const result = liveRuntime?.takeControl(sessionId) || { ok: true };
    notify();
    return result;
  }

  async function dispose() {
    if (disposed && !cleanupPromise) return;
    disposed = true;
    await beginDenial('disposed', 'off');
    subscribers.clear();
  }

  return Object.freeze({
    status,
    getState,
    enable,
    disable,
    openPairing,
    revokeDevice,
    forgetAll,
    setRelay,
    shareSession,
    unshareSession,
    takeControl,
    denyAdmission,
    onChanged,
    dispose,
  });
}

module.exports = { createRemoteControlService };
