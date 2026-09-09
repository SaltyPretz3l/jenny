'use strict';

const SNAPSHOT_SESSION_MAX = 64;
const ACTIVE_TURN_LIMITS = Object.freeze({
  stream_id: 256,
  turn_id: 128,
  status: 64,
});
const SNAPSHOT_ENVELOPE_BUDGET_BYTES = 4_096;

function boundedText(value, limit) {
  if (typeof value !== 'string') return '';
  return Array.from(value.trim()).slice(0, limit).join('');
}

function projectActiveTurn(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    stream_id: boundedText(value.stream_id, ACTIVE_TURN_LIMITS.stream_id),
    turn_id: boundedText(value.turn_id, ACTIVE_TURN_LIMITS.turn_id),
    status: boundedText(value.status || value.state, ACTIVE_TURN_LIMITS.status),
  };
}

async function readActiveTurn(backendService, sessionId) {
  try {
    return await backendService.getActiveTurnState(sessionId);
  } catch (_error) {
    return null;
  }
}

function createRuntimeSnapshots(options = {}) {
  const {
    backendService,
    chat,
    decisions,
    limits,
    buffer,
    currentRecord,
    sessionAllowed,
    eventAuthorization,
    currentRevision,
  } = options;

  function fallback(sessions) {
    const result = [];
    for (const session of sessions) {
      const candidate = {
        ...session,
        transcript: null,
        transcript_truncated: true,
      };
      if (Buffer.byteLength(JSON.stringify([...result, candidate]), 'utf8')
        > limits.FRAME_PLAINTEXT_MAX_BYTES - SNAPSHOT_ENVELOPE_BUDGET_BYTES) break;
      result.push(candidate);
    }
    return result;
  }

  async function snapshotFor(peer) {
    const eventSeqHead = buffer.head();
    const revision = currentRevision();
    const sessions = [];
    const shared = (currentRecord()?.shared_sessions || []).slice(0, SNAPSHOT_SESSION_MAX);
    for (const sessionId of shared) {
      const authorized = eventAuthorization(peer, sessionId, revision);
      if (!authorized() || !sessionAllowed(sessionId)) continue;
      const transcript = await chat.transcriptPage({
        sessionId,
        limit: limits.TRANSCRIPT_PAGE_MAX_MESSAGES,
        hasGrant: () => authorized() && sessionAllowed(sessionId),
      });
      if (!authorized() || !sessionAllowed(sessionId)) return null;
      const activeTurn = await readActiveTurn(backendService, sessionId);
      if (!authorized() || !sessionAllowed(sessionId)) return null;
      sessions.push({
        session_id: sessionId,
        transcript: transcript?.ok ? transcript.data : null,
        active_turn: projectActiveTurn(activeTurn),
        pending: decisions.pendingFor(sessionId),
      });
    }
    const bytes = Buffer.byteLength(JSON.stringify(sessions), 'utf8');
    const fallbackSessions = fallback(sessions);
    return {
      eventSeqHead,
      revision,
      sessions: bytes <= limits.FRAME_PLAINTEXT_MAX_BYTES - SNAPSHOT_ENVELOPE_BUDGET_BYTES
        ? sessions : fallbackSessions,
      fallbackSessions,
    };
  }

  return Object.freeze({ snapshotFor });
}

function createRuntimePeerLifecycle(options = {}) {
  const {
    peerMap,
    buildPeer,
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
    pairingConsume,
    verifyDevice,
    eventSeqHead,
    snapshotFor,
    currentRevision,
    hasGrant,
    sendAuthorized,
    closePeer,
    revokeDeviceLeases,
    resyncRequired,
    safe,
    notify,
    log,
  } = options;

  function readyConnections(deviceId) {
    return [...peerMap.values()].filter((peer) => peer.deviceId === deviceId
      && peer.state === 'ready');
  }

  function onPeerReady(peer) {
    if (!isAdmitted() || peerMap.get(peer.connectionId) !== peer) return;
    if (readyConnections(peer.deviceId).length > 2) {
      closePeer(peer.connectionId, 'too_many_connections');
      return;
    }
    if (!peerAuthority(peer)) return;
    safe(notify);
    Promise.resolve(snapshotFor(peer)).then((snapshot) => {
      if (!snapshot || !peerAuthority(peer)) return;
      const authorized = () => peerAuthority(peer)
        && currentRevision() === snapshot.revision
        && snapshot.sessions.every((session) => hasGrant(session.session_id));
      const event = {
        v: 1,
        kind: 'event',
        event_seq: snapshot.eventSeqHead,
        type: 'session_shared',
        session_id: snapshot.sessions[0]?.session_id || 'remote_snapshot',
        payload: { event_seq_head: snapshot.eventSeqHead, sessions: snapshot.sessions },
      };
      return sendAuthorized(peer, event, authorized);
    }).catch(() => {
      if (peer.deviceId) resyncRequired.add(peer.deviceId);
    });
  }

  function createPeer(connectionId) {
    if (!isAdmitted() || peerMap.has(connectionId)) return null;
    if (peerMap.size >= (limits.MAX_DEVICES * 2) + 2) {
      safe(() => relay.closePeer?.(connectionId));
      return null;
    }
    const pending = [...peerMap.values()].filter((peer) => peer.state !== 'ready').length;
    if (pending >= limits.MAX_DEVICES + 2) {
      safe(() => relay.closePeer?.(connectionId));
      return null;
    }
    let peer;
    peer = buildPeer({
      connectionId,
      epoch,
      routeId: route.routeId,
      relayOrigin: relayUrl,
      now,
      limits,
      crypto,
      contracts,
      setTimer,
      clearTimer,
      isLive: isAdmitted,
      resolveSecret,
      pairingConsume,
      verifyDevice,
      sendRaw: (message) => relay.send?.(message) === true,
      eventSeqHead,
      onReady: () => onPeerReady(peer),
      onClose: (reason) => {
        if (reason === 'backpressure' && peer?.deviceId) resyncRequired.add(peer.deviceId);
        if (peerMap.get(connectionId) === peer) peerMap.delete(connectionId);
        if (peer?.deviceId && readyConnections(peer.deviceId).length === 0) {
          revokeDeviceLeases(peer.deviceId);
        }
        safe(() => relay.closePeer?.(connectionId));
        safe(notify);
      },
      log,
    });
    peerMap.set(connectionId, peer);
    return peer;
  }

  return Object.freeze({ createPeer });
}

module.exports = { createRuntimePeerLifecycle, createRuntimeSnapshots };
