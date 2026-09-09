'use strict';

/*
Relay wire protocol v1 (JSON text messages on the WebSocket; all ids match `/^[A-Za-z0-9_-]{8,64}$/`)
Endpoints: desktop `wss://<host>/r/<route_id>?role=desktop`, phone `wss://<host>/r/<route_id>?role=phone`.
- Desktop → relay first message: `{ v:1, kind:'claim', route_id, route_token, epoch }` (`route_token`/`route_id` from `crypto.deriveRouteCredentials(desktopSecret)`). Relay answers `{ v:1, kind:'claimed', route_id }` or `{ v:1, kind:'relay_error', code }` then closes. A later claim with a valid token for the same route displaces the previous desktop connection (the relay closes it with `relay_error code:'displaced'`).
- Phone → relay first message: `{ v:1, kind:'join', route_id }`; relay answers `{ v:1, kind:'joined', connection_id }` or closes (no desktop online → `relay_error code:'no_desktop'`).
- Relay → desktop: `{ v:1, kind:'peer_open', connection_id }`, `{ v:1, kind:'peer_close', connection_id }`, `{ v:1, kind:'hs1', connection_id, eph_pub, credential }` (forwarded from the phone; the relay STAMPS `connection_id`), frames `{ v:1, route_id, connection_id, epoch, seq, ciphertext }` (relay stamps `connection_id`; the desktop rejects frames whose `epoch` ≠ current epoch), `{ v:1, kind:'pong', t }`.
- Desktop → relay: `{ v:1, kind:'hs2', connection_id, eph_pub, epoch }` (relayed to that phone), frames (relayed to `connection_id`), `{ v:1, kind:'close_peer', connection_id }`, `{ v:1, kind:'ping', t }` every `HEARTBEAT_MS`.
- Relay-level messages carry no secrets except `route_token` (TLS only; grants room ownership, never message plaintext). Everything else the phone and desktop exchange after `hs2` is inside `ciphertext`.
*/

const defaultLimits = require('./remote-limits');

const IDENTIFIER_RE = /^[A-Za-z0-9_-]{8,64}$/;
const RELAY_ERROR_CODES = Object.freeze([
  'claim_rejected', 'displaced', 'no_desktop', 'rate_limited',
  'storage_unavailable', 'lease_expired', 'idle_timeout',
]);
const RELAY_ERROR_CODE_SET = new Set(RELAY_ERROR_CODES);

function relayErrorCode(value) {
  return RELAY_ERROR_CODE_SET.has(value) ? value : 'relay_error';
}

function createRelayClient(options = {}) {
  const {
    url,
    routeId,
    routeToken,
    epoch,
    now,
    setTimer,
    clearTimer,
    limits = defaultLimits,
    onMessage = () => {},
    onStateChange = () => {},
    log = () => {},
    random = Math.random,
  } = options;
  if (typeof now !== 'function' || typeof setTimer !== 'function'
    || typeof clearTimer !== 'function' || typeof random !== 'function'
    || !IDENTIFIER_RE.test(routeId || '') || !IDENTIFIER_RE.test(epoch || '')
    || typeof routeToken !== 'string' || !routeToken) {
    throw new TypeError('Invalid relay client configuration.');
  }

  let configuredUrl;
  try {
    configuredUrl = new URL(url);
  } catch (_error) {
    configuredUrl = null;
  }
  let state = 'idle';
  let socket = null;
  let listeners = null;
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let deadlineTimer = null;
  let stableClaimTimer = null;
  let reconnectAttempt = 0;
  let missedPongs = 0;
  let outstandingPing = null;
  let claimed = false;
  let allowReconnect = true;

  function notify(next, reason) {
    state = next;
    try {
      onStateChange(next, reason);
    } catch (_error) {
      // Lifecycle observers cannot break transport cleanup.
    }
  }

  function boundedLog(level, event, fields = {}) {
    try {
      log(level, event, fields);
    } catch (_error) {
      // Logging is optional and never authoritative.
    }
  }

  function clearTimers() {
    if (heartbeatTimer != null) clearTimer(heartbeatTimer);
    if (reconnectTimer != null) clearTimer(reconnectTimer);
    if (deadlineTimer != null) clearTimer(deadlineTimer);
    if (stableClaimTimer != null) clearTimer(stableClaimTimer);
    heartbeatTimer = null;
    reconnectTimer = null;
    deadlineTimer = null;
    stableClaimTimer = null;
  }

  function detach(target = socket) {
    if (!target || !listeners) return;
    for (const [name, listener] of Object.entries(listeners)) {
      target.removeEventListener?.(name, listener);
      if (target[`on${name}`] === listener) target[`on${name}`] = null;
    }
    listeners = null;
  }

  function wireBytes(obj) {
    try {
      const text = JSON.stringify(obj);
      return { text, bytes: Buffer.byteLength(text, 'utf8') };
    } catch (_error) {
      return null;
    }
  }

  function send(obj) {
    if (state !== 'claimed' || !socket) return false;
    const encoded = wireBytes(obj);
    if (!encoded || encoded.bytes > limits.FRAME_MAX_BYTES) return false;
    const buffered = Number(socket.bufferedAmount) || 0;
    if (buffered + encoded.bytes > limits.OUTBOUND_QUEUE_MAX_BYTES) return false;
    try {
      socket.send(encoded.text);
      return true;
    } catch (_error) {
      return false;
    }
  }

  function sendControl(obj) {
    if (!socket) return false;
    const encoded = wireBytes(obj);
    if (!encoded || encoded.bytes > limits.FRAME_MAX_BYTES) return false;
    try {
      socket.send(encoded.text);
      return true;
    } catch (_error) {
      return false;
    }
  }

  function scheduleHeartbeat() {
    if (heartbeatTimer != null || state !== 'claimed') return;
    heartbeatTimer = setTimer(function tick() {
      heartbeatTimer = null;
      if (state !== 'claimed') return;
      if (outstandingPing !== null) {
        missedPongs += 1;
        outstandingPing = null;
      }
      if (missedPongs >= 2) {
        const target = socket;
        detach(target);
        socket = null;
        try { target?.close?.(); } catch (_error) { /* best effort */ }
        scheduleReconnect('heartbeat_timeout');
        return;
      }
      const ping = Number(now());
      if (send({ v: 1, kind: 'ping', t: ping })) {
        outstandingPing = ping;
      } else {
        missedPongs += 1;
      }
      if (missedPongs >= 2) {
        const target = socket;
        detach(target);
        socket = null;
        try { target?.close?.(); } catch (_error) { /* best effort */ }
        scheduleReconnect('heartbeat_timeout');
        return;
      }
      heartbeatTimer = setTimer(tick, limits.HEARTBEAT_MS);
    }, limits.HEARTBEAT_MS);
  }

  function scheduleReconnect(reason) {
    if (!allowReconnect || state === 'closed' || reconnectTimer != null) return;
    claimed = false;
    outstandingPing = null;
    if (heartbeatTimer != null) clearTimer(heartbeatTimer);
    if (deadlineTimer != null) clearTimer(deadlineTimer);
    if (stableClaimTimer != null) clearTimer(stableClaimTimer);
    heartbeatTimer = null;
    deadlineTimer = null;
    stableClaimTimer = null;
    notify('reconnecting', reason);
    const base = Math.min(limits.RECONNECT_BACKOFF_MAX_MS, 1000 * (2 ** reconnectAttempt));
    reconnectAttempt += 1;
    const jitter = 0.5 + (Math.max(0, Math.min(1, Number(random()) || 0)) * 0.5);
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      if (allowReconnect && state !== 'closed') openSocket();
    }, Math.floor(base * jitter));
  }

  function rejectClaim(reason) {
    allowReconnect = false;
    disconnect(reason || 'claim_rejected');
  }

  function rawText(data) {
    if (typeof data === 'string') return data;
    if (Buffer.isBuffer(data)) return data.toString('utf8');
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
    return null;
  }

  function rawByteLength(data) {
    if (typeof data === 'string') return Buffer.byteLength(data, 'utf8');
    if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) return data.byteLength;
    if (ArrayBuffer.isView(data)) return data.byteLength;
    return null;
  }

  function handleMessage(event) {
    const bytes = rawByteLength(event?.data);
    if (bytes == null || bytes > limits.FRAME_MAX_BYTES) {
      boundedLog('WARN', 'remote.relay_message_dropped', { reason: 'invalid_size' });
      return;
    }
    const raw = rawText(event?.data);
    if (raw == null) {
      boundedLog('WARN', 'remote.relay_message_dropped', { reason: 'invalid_encoding' });
      return;
    }
    let message;
    try {
      message = JSON.parse(raw);
    } catch (_error) {
      boundedLog('WARN', 'remote.relay_message_dropped', { reason: 'invalid_json' });
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      if (!claimed) rejectClaim('claim_rejected');
      return;
    }
    if (message.kind === 'relay_error') {
      message = { ...message, code: relayErrorCode(message.code) };
    }
    if (!claimed) {
      if (message.v === 1 && message.kind === 'claimed' && message.route_id === routeId) {
        claimed = true;
        missedPongs = 0;
        outstandingPing = null;
        if (deadlineTimer != null) clearTimer(deadlineTimer);
        deadlineTimer = null;
        if (stableClaimTimer != null) clearTimer(stableClaimTimer);
        const claimedSocket = socket;
        stableClaimTimer = setTimer(() => {
          stableClaimTimer = null;
          if (socket === claimedSocket && state === 'claimed') reconnectAttempt = 0;
        }, limits.HEARTBEAT_MS);
        notify('claimed');
        scheduleHeartbeat();
        return;
      }
      rejectClaim(message.kind === 'relay_error' ? message.code : 'claim_rejected');
      return;
    }
    if (message.v === 1 && message.kind === 'pong'
      && outstandingPing !== null && message.t === outstandingPing) {
      outstandingPing = null;
      missedPongs = 0;
      return;
    }
    if (message.v === 1 && message.kind === 'relay_error' && message.code === 'displaced') {
      rejectClaim('displaced');
      return;
    }
    try {
      onMessage(message);
    } catch (_error) {
      boundedLog('WARN', 'remote.relay_callback_failed', { kind: String(message.kind || 'frame').slice(0, 32) });
    }
  }

  function openSocket() {
    if (state === 'closed') return false;
    if (!configuredUrl || configuredUrl.protocol !== 'wss:' || !configuredUrl.hostname
      || configuredUrl.username || configuredUrl.password) {
      rejectClaim('relay_url_invalid');
      return false;
    }
    const Ctor = options.WebSocketCtor || globalThis.WebSocket;
    if (typeof Ctor !== 'function') {
      rejectClaim('websocket_unavailable');
      return false;
    }
    claimed = false;
    outstandingPing = null;
    notify('connecting');
    const endpoint = `${configuredUrl.href.replace(/\/+$/g, '')}/r/${routeId}?role=desktop`;
    let target;
    try {
      target = new Ctor(endpoint);
    } catch (_error) {
      scheduleReconnect('connect_failed');
      return false;
    }
    socket = target;
    listeners = {
      open: () => {
        let finalUrl;
        try { finalUrl = target.url ? new URL(target.url) : null; } catch (_error) { finalUrl = null; }
        if (finalUrl && finalUrl.origin !== configuredUrl.origin) {
          rejectClaim('relay_host_changed');
          return;
        }
        if (!sendControl({ v: 1, kind: 'claim', route_id: routeId, route_token: routeToken, epoch })) {
          const current = socket;
          detach(current);
          socket = null;
          try { current?.close?.(); } catch (_error) { /* best effort */ }
          scheduleReconnect('claim_send_failed');
        }
      },
      message: handleMessage,
      close: () => {
        detach(target);
        if (socket === target) socket = null;
        if (allowReconnect && state !== 'closed') scheduleReconnect('socket_closed');
      },
      error: () => boundedLog('WARN', 'remote.relay_socket_error', { state }),
    };
    for (const [name, listener] of Object.entries(listeners)) {
      if (target.addEventListener) target.addEventListener(name, listener);
      else target[`on${name}`] = listener;
    }
    deadlineTimer = setTimer(() => {
      deadlineTimer = null;
      if (socket !== target || claimed || state === 'closed') return;
      detach(target);
      socket = null;
      try { target.close?.(); } catch (_error) { /* best effort */ }
      scheduleReconnect('claim_timeout');
    }, limits.RELAY_ONLINE_LEASE_MS);
    return true;
  }

  function connect() {
    if (state === 'closed') return false;
    allowReconnect = true;
    return openSocket();
  }

  function closePeer(connectionId) {
    if (!IDENTIFIER_RE.test(connectionId || '')) return false;
    return send({ v: 1, kind: 'close_peer', connection_id: connectionId });
  }

  function disconnect(reason = 'disabled') {
    if (state === 'closed') return false;
    allowReconnect = false;
    clearTimers();
    const target = socket;
    detach(target);
    socket = null;
    claimed = false;
    try { target?.close?.(); } catch (_error) { /* best effort */ }
    notify('closed', String(reason).slice(0, 64));
    return true;
  }

  function getState() {
    return state;
  }

  function bufferedAmount() {
    return Number(socket?.bufferedAmount) || 0;
  }

  return Object.freeze({ connect, send, closePeer, disconnect, getState, bufferedAmount });
}

module.exports = { createRelayClient };
