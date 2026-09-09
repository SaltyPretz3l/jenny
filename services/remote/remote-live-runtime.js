'use strict';
const { createRemoteChatAdapter } = require('./remote-chat-adapter');
const { createRemoteDecisionAdapter } = require('./remote-decision-adapter');
const { createRemoteEventProjector } = require('./remote-event-projector');
const { createPeerSession } = require('./remote-peer-session');
const { createCommandRouter } = require('./remote-command-router');
const { createControlLeases } = require('./remote-control-leases');
const { createEventBuffer } = require('./remote-event-buffer');
const { createRuntimePeerLifecycle, createRuntimeSnapshots } = require('./remote-runtime-snapshots');
const { createChatStartCancellation } = require('../backend/chat-start-cancellation');
function createLiveRuntime(options = {}) {
  const {
    epoch,
    route,
    relayUrl,
    backendService,
    deviceStore,
    pairing,
    relay,
    crypto,
    contracts,
    limits,
    policy,
    featureFlags,
    isPluginActive,
    now,
    setTimer,
    clearTimer,
    log = () => {},
    notify = () => {},
    factories = {},
  } = options;
  if (!epoch || !route?.routeId || !relayUrl || !backendService || !deviceStore
    || !pairing || !relay || !crypto || !contracts || !limits || !policy
    || typeof featureFlags !== 'function' || typeof isPluginActive !== 'function'
    || typeof now !== 'function'
    || typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
    throw new TypeError('Invalid remote live runtime configuration.');
  }
  const build = {
    chat: factories.createRemoteChatAdapter || createRemoteChatAdapter,
    decisions: factories.createRemoteDecisionAdapter || createRemoteDecisionAdapter,
    projector: factories.createRemoteEventProjector || createRemoteEventProjector,
    peer: factories.createPeerSession || createPeerSession,
    router: factories.createCommandRouter || createCommandRouter,
    leases: factories.createControlLeases || createControlLeases,
    buffer: factories.createEventBuffer || createEventBuffer,
    cancellation: factories.createChatStartCancellation || createChatStartCancellation,
  };
  const peerMap = new Map();
  const cancellationScopes = new Map();
  const resyncRequired = new Set();
  const suppressedGrants = new Set();
  const leases = build.leases({ now, randomId: () => crypto.randomId() });
  const buffer = build.buffer({ limits, now });
  let admitted = true;
  let grantsSuppressed = false;
  let grantRevision = 0;
  let disposePromise = null;
  let snapshotFor = async () => null;
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
      // Optional diagnostics cannot affect remote authority.
    }
  }
  const currentRecord = () => deviceStore.getRecord?.() || null;
  const getSession = (sessionId) => safe(
    () => backendService.sessionStore?.getSession?.(sessionId) || null,
    null
  );
  const isAdmitted = () => admitted;
  function hasGrant(sessionId) {
    const granted = admitted && !grantsSuppressed && typeof sessionId === 'string'
      && !suppressedGrants.has(sessionId)
      && (currentRecord()?.shared_sessions || []).includes(sessionId);
    if (!granted) return false;
    if (sessionAllowed(sessionId)) return true;
    suppressGrant(sessionId);
    return false;
  }
  function sessionAllowed(sessionId) {
    const session = getSession(sessionId);
    return Boolean(session && policy.canListSession(session, featureFlags() || {}));
  }
  function peerHasGrant(peer, sessionId) {
    return peer?.state === 'ready' && Boolean(peer.deviceId) && hasGrant(sessionId);
  }
  function peerAuthority(peer) {
    return admitted && peer?.state === 'ready' && peerMap.get(peer.connectionId) === peer
      && safe(() => deviceStore.isDeviceTrusted(peer.deviceId)) === true;
  }
  function cancelRemoteStream(streamId) {
    try {
      Promise.resolve(backendService.cancelChatStream(streamId, 'user_cancel')).catch(() => {
        report('WARN', 'remote.cancel_failed', { reason: 'backend_rejected' });
      });
    } catch (_error) {
      report('WARN', 'remote.cancel_failed', { reason: 'backend_unavailable' });
    }
  }
  const removeCancellation = (token) => cancellationScopes.delete(token);
  function cancellationRegistry() {
    return {
      create({ sessionId, deviceId } = {}) {
        const base = build.cancellation({ onCancelStream: cancelRemoteStream });
        let wrapper;
        wrapper = Object.freeze({
          signal: base.signal,
          cancel(reason) {
            const cancelled = base.cancel(reason);
            removeCancellation(wrapper);
            return cancelled;
          },
          bindStream(streamId) {
            return base.bindStream(streamId);
          },
          get boundStreamId() {
            return base.boundStreamId;
          },
        });
        cancellationScopes.set(wrapper, { epoch, sessionId, deviceId });
        if (!admitted) wrapper.cancel('remote_disabled');
        return wrapper;
      },
    };
  }
  function cancelMatching(predicate, reason = 'remote_disabled') {
    for (const [token, scope] of [...cancellationScopes]) {
      if (predicate(scope, token)) safe(() => token.cancel(reason));
    }
  }
  function cancelRemoteSession(sessionId) {
    cancelMatching((scope) => scope.sessionId === sessionId);
  }
  function settleCancellation(streamId) {
    for (const token of [...cancellationScopes.keys()]) {
      if (token.boundStreamId === streamId) cancellationScopes.delete(token);
    }
  }
  function onTerminalStream(source) {
    if (!source || !['complete', 'error', 'question_batch'].includes(source.type)) return;
    const streamId = String(source.streamId || source.stream_id || '');
    if (streamId) settleCancellation(streamId);
  }
  const signalLeaseChange = () => safe(notify);
  function revokeDeviceLeases(deviceId) {
    if (leases.revokeDevice(deviceId) > 0) signalLeaseChange();
  }
  function markBackpressure(peer) {
    if (peer.deviceId) resyncRequired.add(peer.deviceId);
    safe(() => relay.closePeer?.(peer.connectionId));
    safe(() => peer.close('backpressure'));
  }
  async function sendAuthorized(peer, value, authorized) {
    let sent;
    try {
      sent = await peer.sendPlaintext(value, { authorized });
    } catch (_error) {
      sent = false;
    }
    if (sent !== true && authorized()) markBackpressure(peer);
    return sent;
  }
  function eventAuthorization(peer, sessionId, revision) {
    return () => admitted && grantRevision === revision && peerHasGrant(peer, sessionId);
  }
  function emitProjected(source) {
    try {
      if (!source || !hasGrant(source.session_id) || !sessionAllowed(source.session_id)) return false;
      const revision = grantRevision;
      const event = { ...source, event_seq: buffer.head() + 1 };
      buffer.push(event);
      for (const peer of peerMap.values()) {
        if (!peerHasGrant(peer, event.session_id)) continue;
        const authorized = eventAuthorization(peer, event.session_id, revision);
        Promise.resolve().then(() => sendAuthorized(peer, event, authorized));
      }
      return true;
    } catch (_error) {
      report('WARN', 'remote.event_dropped', { reason: 'projection_failed' });
      return false;
    }
  }
  function emitUnshared(sessionId) {
    let event;
    try {
      event = contracts.buildEvent({
        eventSeq: buffer.head() + 1, type: 'session_unshared', sessionId, payload: {},
      });
      buffer.push(event);
    } catch (_error) {
      return false;
    }
    for (const peer of peerMap.values()) {
      if (peerAuthority(peer)) Promise.resolve().then(() => (
        sendAuthorized(peer, event, () => peerAuthority(peer))
      ));
    }
    return true;
  }
  function emitLifecycleEvent({ type, session_id: sessionId, payload = {} }) {
    if (!contracts.EVENT_TYPES.includes(type) || !hasGrant(sessionId)) return false;
    let event;
    try {
      event = contracts.buildEvent({
        eventSeq: buffer.head() + 1,
        type,
        sessionId,
        payload,
      });
    } catch (_error) {
      return false;
    }
    const emitted = emitProjected(event);
    if (type === 'control_changed') signalLeaseChange();
    return emitted;
  }
  function closePeer(connectionId, reason = 'peer_closed') {
    const peer = peerMap.get(connectionId);
    if (!peer) return false;
    peerMap.delete(connectionId);
    const deviceId = peer.deviceId;
    safe(() => peer.close(reason));
    safe(() => relay.closePeer?.(connectionId));
    if (deviceId && ![...peerMap.values()].some((candidate) => (
      candidate.deviceId === deviceId && candidate.state === 'ready'
    ))) {
      revokeDeviceLeases(deviceId);
    }
    return true;
  }
  function verifyDevice(deviceId, transcriptHash, proof) {
    if (transcriptHash === undefined) return deviceStore.isDeviceTrusted(deviceId);
    return (async () => {
      const secret = deviceStore.deviceSecret(deviceId);
      if (!secret) return false;
      let verified;
      try {
        verified = await crypto.verifyHandshake(secret, transcriptHash, proof);
      } catch (_error) {
        return false;
      } finally {
        secret.fill(0);
      }
      if (!verified || !admitted || !deviceStore.isDeviceTrusted(deviceId)) return false;
      const touched = await deviceStore.touchDevice(deviceId);
      return touched?.ok === true && admitted && deviceStore.isDeviceTrusted(deviceId);
    })();
  }
  function resolveSecret(credential) {
    if (!admitted) return null;
    if (credential.kind === 'pairing') {
      const active = pairing.status?.();
      const view = pairing.view?.();
      if (!active?.open || active.pairing_id !== credential.id || active.epoch !== epoch
        || !(view?.secret instanceof Uint8Array)) return null;
      return { secret: new Uint8Array(view.secret) };
    }
    if (credential.kind === 'device' && deviceStore.isDeviceTrusted(credential.id)) {
      return { secret: deviceStore.deviceSecret(credential.id) };
    }
    return null;
  }
  function commandAuthority(peer, command) {
    const sessionId = command?.session_id;
    const leaseId = sessionId ? leases.leaseFor(sessionId, peer.deviceId)?.lease_id : null;
    return () => safe(isPluginActive) === true && peerAuthority(peer)
      && (!sessionId || hasGrant(sessionId))
      && (!leaseId || leases.leaseFor(sessionId, peer.deviceId)?.lease_id === leaseId);
  }
  function filterSessionList(command, result) {
    if (command?.operation !== 'session.list' || result?.ok !== true
      || !Array.isArray(result.data?.sessions)) return result;
    return {
      ...result,
      data: {
        ...result.data,
        sessions: result.data.sessions.filter((session) => hasGrant(session?.id)),
      },
    };
  }
  function responseSessionIds(command, result) {
    const ids = new Set();
    if (command?.session_id) ids.add(command.session_id);
    if (command?.operation === 'session.create' && result?.data?.id) ids.add(result.data.id);
    for (const session of result?.data?.sessions || []) {
      if (session?.id) ids.add(session.id);
      if (session?.session_id) ids.add(session.session_id);
    }
    for (const event of result?.data?.events || []) {
      if (event?.session_id) ids.add(event.session_id);
    }
    return [...ids];
  }
  function responseAuthorization(peer, result, sessionIds) {
    return () => safe(isPluginActive) === true && peerAuthority(peer)
      && (result?.ok !== true || sessionIds.every((sessionId) => hasGrant(sessionId)));
  }
  function resyncError(requestId) {
    return contracts.buildError(requestId, 'resync_required', 'resync_required', true);
  }
  async function handleResync(peer, sentinel) {
    if (resyncRequired.has(peer.deviceId)) {
      resyncRequired.delete(peer.deviceId);
      return resyncError(sentinel.request_id);
    }
    const replayHead = buffer.head();
    const replay = buffer.since(sentinel.last_event_seq);
    if (!replay.ok || !peer.setLastAcked(sentinel.last_event_seq, replayHead)) {
      return resyncError(sentinel.request_id);
    }
    const snapshot = await snapshotFor(peer);
    if (!snapshot || !admitted || peer.state !== 'ready') return null;
    const result = contracts.buildResult(sentinel.request_id, {
      event_seq_head: snapshot.eventSeqHead,
      events: replay.events.filter((event) => hasGrant(event.session_id)),
      sessions: snapshot.sessions,
    });
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') <= limits.FRAME_PLAINTEXT_MAX_BYTES) {
      return result;
    }
    const fallbackResult = contracts.buildResult(sentinel.request_id, {
      event_seq_head: snapshot.eventSeqHead,
      events: [],
      sessions: snapshot.fallbackSessions,
      replay_truncated: true,
    });
    if (Buffer.byteLength(JSON.stringify(fallbackResult), 'utf8')
      > limits.FRAME_PLAINTEXT_MAX_BYTES) {
      return resyncError(sentinel.request_id);
    }
    return fallbackResult;
  }
  async function dispatchFrame(peer, frame) {
    const opened = await peer.handleFrame(frame);
    if (!opened?.command || !admitted || peer.state !== 'ready') return;
    const command = router.normalizeCommand?.(opened.command) || opened.command;
    const isAuthorized = commandAuthority(peer, command);
    try {
      if (safe(isPluginActive) !== true) {
        const fenced = contracts.buildError(
          command.request_id, 'not_reachable', 'not_reachable', true,
        );
        await sendAuthorized(peer, fenced, () => peerAuthority(peer));
        return;
      }
      let result = await router.handle({ peer, command, isAuthorized });
      if (!result || !peerAuthority(peer)) return;
      if (result?.resync) result = await handleResync(peer, result);
      if (!result) return;
      result = filterSessionList(command, result);
      let sessionIds = responseSessionIds(command, result);
      if (result.ok === true && !sessionIds.every((sessionId) => hasGrant(sessionId))) {
        result = contracts.buildError(command.request_id, 'session_not_shared', 'session_not_shared');
        sessionIds = [];
      }
      const authorized = responseAuthorization(peer, result, sessionIds);
      if (!authorized()) return;
      let sent = await peer.sendPlaintext(result, { authorized });
      if (sent?.reason === 'payload_too_large' && peerAuthority(peer)) {
        const error = contracts.buildError(
          command.request_id,
          'payload_too_large',
          'payload_too_large',
          false
        );
        sent = await peer.sendPlaintext(error, {
          authorized: responseAuthorization(peer, error, []),
        });
      }
      if (sent !== true && authorized()) markBackpressure(peer);
    } finally {
      peer.settleCommand?.();
    }
  }
  function onRelayMessage(message) {
    if (!admitted || !message || message.v !== 1) return;
    const connectionId = message.connection_id;
    if (message.kind === 'peer_open') {
      createPeer(connectionId);
      return;
    }
    if (message.kind === 'peer_close') {
      closePeer(connectionId, 'relay_peer_closed');
      return;
    }
    const peer = peerMap.get(connectionId);
    if (message.kind === 'hs1') {
      return Promise.resolve(peer?.handleHs1(message));
    } else if (!message.kind && peer) {
      return Promise.resolve(dispatchFrame(peer, message)).catch(() => {
        closePeer(connectionId, 'dispatch_failed');
      });
    }
    return undefined;
  }
  function suppressGrant(sessionId) {
    grantRevision += 1;
    const changed = !suppressedGrants.has(sessionId);
    suppressedGrants.add(sessionId);
    cancelRemoteSession(sessionId);
    leases.revokeSession(sessionId);
    safe(notify);
    return changed;
  }
  async function shareSession(sessionId, { allowRestore = true } = {}) {
    if (!admitted) return { ok: false, reason: 'epoch_invalid' };
    if (!allowRestore && suppressedGrants.has(sessionId)) {
      return { ok: false, reason: 'grant_suppressed' };
    }
    const revision = grantRevision;
    const result = await deviceStore.shareSession(sessionId);
    if (!admitted) return { ok: false, reason: 'epoch_invalid' };
    if (grantRevision !== revision || (!allowRestore && suppressedGrants.has(sessionId))) {
      return { ok: false, reason: 'grant_suppressed' };
    }
    if (result?.ok) {
      suppressedGrants.delete(sessionId);
      emitLifecycleEvent({ type: 'session_shared', session_id: sessionId, payload: {} });
      safe(notify);
    }
    return result;
  }

  async function unshare(sessionId) {
    suppressGrant(sessionId);
    emitUnshared(sessionId);
    const result = await deviceStore.unshareSession(sessionId);
    safe(notify);
    return result;
  }
  function takeControl(sessionId) {
    const revoked = leases.revokeSession(sessionId);
    emitLifecycleEvent({
      type: 'control_changed',
      session_id: sessionId,
      payload: { controlled_by: 'desktop' },
    });
    if (revoked) signalLeaseChange();
    return { ok: true };
  }
  function revokeDevice(deviceId) {
    grantRevision += 1;
    for (const peer of [...peerMap.values()]) {
      if (peer.deviceId === deviceId) closePeer(peer.connectionId, 'device_revoked');
    }
    cancelMatching((scope) => scope.deviceId === deviceId);
    revokeDeviceLeases(deviceId);
  }
  function denyAdmission(reason = 'remote_disabled') {
    if (!admitted) return false;
    admitted = false;
    grantsSuppressed = true;
    grantRevision += 1;
    leases.revokeAll();
    for (const peer of [...peerMap.values()]) {
      peerMap.delete(peer.connectionId);
      safe(() => peer.close(reason));
    }
    cancelMatching(() => true);
    safe(notify);
    return true;
  }
  function dispose() {
    if (disposePromise) return disposePromise;
    denyAdmission('remote_disabled');
    disposePromise = Promise.resolve().then(() => {
      safe(() => projector.dispose?.());
      safe(() => backendService.off?.('chat-stream', onTerminalStream)
        || backendService.removeListener?.('chat-stream', onTerminalStream));
      for (const peer of [...peerMap.values()]) closePeer(peer.connectionId, 'remote_disabled');
      cancellationScopes.clear();
      resyncRequired.clear();
      safe(() => buffer.clear());
    });
    return disposePromise;
  }
  const decisions = build.decisions({ backendService, featureFlags, policy });
  const chat = build.chat({
    backendService,
    featureFlags,
    now,
    limits,
    policy,
    contracts,
    leases,
    cancellations: cancellationRegistry(),
    currentEpoch: () => (admitted ? epoch : ''),
    shareSession: (sessionId) => shareSession(sessionId, { allowRestore: false }),
  });
  const router = build.router({
    contracts,
    limits,
    policy,
    chatAdapter: chat,
    decisionAdapter: decisions,
    leases,
    getSession,
    hasGrant,
    featureFlags,
    now,
    currentEpoch: () => (admitted ? epoch : null),
    emitEvent: emitLifecycleEvent,
    log,
  });
  snapshotFor = createRuntimeSnapshots({
    backendService,
    chat,
    decisions,
    limits,
    buffer,
    currentRecord,
    sessionAllowed,
    eventAuthorization,
    currentRevision: () => grantRevision,
  }).snapshotFor;
  const { createPeer } = createRuntimePeerLifecycle({
    peerMap,
    buildPeer: build.peer,
    epoch,
    route,
    relayUrl,
    relay,
    now,
    limits,
    crypto,
    contracts,
    setTimer,
    clearTimer,
    isAdmitted,
    peerAuthority,
    resolveSecret,
    pairingConsume: (input) => pairing.consume(input),
    verifyDevice,
    eventSeqHead: () => buffer.head(),
    snapshotFor: (peer) => snapshotFor(peer),
    currentRevision: () => grantRevision,
    hasGrant,
    sendAuthorized,
    closePeer,
    revokeDeviceLeases,
    resyncRequired,
    safe,
    notify,
    log,
  });
  backendService.on?.('chat-stream', onTerminalStream);
  let projector;
  try {
    projector = build.projector({
      backendService,
      isSessionShared: (sessionId) => hasGrant(sessionId) && sessionAllowed(sessionId),
      limits,
      emit: emitProjected,
      contracts,
      decisions,
      setTimer,
      clearTimer,
    });
  } catch (error) {
    safe(() => backendService.off?.('chat-stream', onTerminalStream)
      || backendService.removeListener?.('chat-stream', onTerminalStream));
    safe(() => leases.revokeAll());
    safe(() => buffer.clear());
    throw error;
  }
  const peers = Object.freeze({
    get size() {
      return peerMap.size;
    },
    get(connectionId) {
      return peerMap.get(connectionId);
    },
    values() {
      return peerMap.values();
    },
    [Symbol.iterator]() {
      return peerMap[Symbol.iterator]();
    },
  });

  return Object.freeze({
    epoch, denyAdmission, dispose, isAdmitted, hasGrant, suppressGrant, leases, buffer,
    peers, onRelayMessage, revokeDevice, unshare, takeControl, shareSession,
  });
}
module.exports = { createLiveRuntime };
