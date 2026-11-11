'use strict';

// The channel between a team host and the process that started it (Jenny's
// desktop app). Two carriers: an Electron utility process (`parentPort`) and a
// Node child with an IPC channel (`process.send`). Inbound messages are a closed
// set, validated before anyone sees them; outbound messages are a closed set of
// shapes. The host key arrives here and is never sent back. Nothing is logged
// from this file: a dropped message is only counted.
//
// A parent that is gone cannot say stop. The Node carrier sees the disconnect.
// Electron's `parentPort` has no close event, so the desktop sends `ping` every
// few seconds and a silence of `parentSilenceMs` is the stop message, once
// (slice 1f-2). A late watchdog tick restarts the window instead of counting. `ping` is this file's own: it reaches no listener.

const { PUBLIC_KEY_BYTES, decodeBase64url } = require('./ids');

// Messages that arrive before the first listener subscribes are held (a parent
// may send `start` the moment the child spawns) and handed to that listener.
const MAX_HELD = 8;
// The desktop pings every 5 s; six missed pings mean the parent is gone.
const DEFAULT_PARENT_SILENCE_MS = 30_000;
const SYSTEM_CLOCK = Object.freeze({ now: () => Date.now(), setInterval, clearInterval });

// The host's messages to its parent. The desktop supervisor parses the same table
// (services/team/host/host-supervisor.js) with its own stricter value checks.
// `owner_exists`: --team-init found an owner already, so no invite is coming.
const OUTBOUND_FIELDS = Object.freeze({
  ready: ['type', 'boot_epoch', 'team_id', 'public_key', 'addresses'],
  owner_invite: ['type', 'invite'],
  owner_exists: ['type'],
  membership_changed: ['type', 'kind', 'member_id'],
  stopped: ['type'],
  error: ['type', 'reason'],
});

const PING = Object.freeze({ type: 'ping' });

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// Returns a frozen copy of a valid inbound message, or null.
function parseInbound(value) {
  if (!isPlainRecord(value)) return null;
  const keys = Object.keys(value);
  if (value.type === 'stop') return keys.length === 1 ? Object.freeze({ type: 'stop' }) : null;
  if (value.type === 'ping') return keys.length === 1 ? PING : null;
  if (value.type === 'start') {
    if (keys.length !== 2 || !Object.hasOwn(value, 'host_key')) return null;
    if (decodeBase64url(value.host_key, PUBLIC_KEY_BYTES) === null) return null;
    return Object.freeze({ type: 'start', host_key: value.host_key });
  }
  return null;
}

// True when `message` is a plain record with exactly the fields its type has in OUTBOUND_FIELDS.
function isOutbound(message) {
  if (!isPlainRecord(message) || typeof message.type !== 'string' || !Object.hasOwn(OUTBOUND_FIELDS, message.type)) {
    return false;
  }
  const fields = OUTBOUND_FIELDS[message.type];
  const keys = Object.keys(message);
  return keys.length === fields.length && fields.every((field) => Object.hasOwn(message, field));
}

// Adapts the two carriers to { post, listen, disconnect, watchSilence }.
function pickCarrier(processLike) {
  const port = processLike?.parentPort;
  if (port && typeof port.postMessage === 'function' && typeof port.on === 'function') {
    return {
      watchSilence: true,
      post: (message) => { port.postMessage(message); return true; },
      listen: (handler) => {
        const wrapped = (event) => handler(event?.data);
        port.on('message', wrapped);
        return () => port.removeListener?.('message', wrapped);
      },
      disconnect: () => {},
    };
  }
  if (processLike && typeof processLike.send === 'function' && typeof processLike.on === 'function') {
    return {
      post: (message) => {
        if (processLike.connected === false) return false;
        processLike.send(message, () => {});
        return true;
      },
      // A parent that is gone cannot say stop: losing the channel is the stop message.
      listen: (handler) => {
        const onDisconnect = () => handler({ type: 'stop' });
        processLike.on('message', handler);
        processLike.once('disconnect', onDisconnect);
        return () => {
          processLike.removeListener('message', handler);
          processLike.removeListener('disconnect', onDisconnect);
        };
      },
      disconnect: () => {
        if (processLike.connected === true && typeof processLike.disconnect === 'function') processLike.disconnect();
      },
    };
  }
  return null;
}

function createParentChannel(processLike = process, { parentSilenceMs = DEFAULT_PARENT_SILENCE_MS, clock = SYSTEM_CLOCK } = {}) {
  const carrier = pickCarrier(processLike);
  if (!carrier) return null;
  const listeners = new Set();
  const held = [];
  let dropped = 0;
  let closed = false;
  let lastHeard = clock.now();
  let silenceStopped = false;
  let watchdog = null;

  const deliver = (message, listener) => {
    try { listener(message); } catch { /* a listener's failure is its own */ }
  };
  const dispatch = (message) => {
    if (listeners.size === 0) {
      if (held.length < MAX_HELD) held.push(message); else dropped += 1;
      return;
    }
    for (const listener of [...listeners]) deliver(message, listener);
  };
  const detach = carrier.listen((raw) => {
    lastHeard = clock.now();
    const message = parseInbound(raw);
    if (!message) { dropped += 1; return; }
    if (message === PING) return;
    dispatch(message);
  });
  if (carrier.watchSilence) {
    const intervalMs = Math.max(250, Math.min(5_000, Math.floor(parentSilenceMs / 3)));
    let lastTick = lastHeard;
    watchdog = clock.setInterval(() => {
      if (closed || silenceStopped) return;
      const now = clock.now();
      const gap = now - lastTick;
      lastTick = now;
      // A late tick (sleep, a long stall) or a clock that went backwards is no
      // evidence: the parent's queued ping may not have been read yet. It gets a
      // full fresh window; a parent that is really gone is caught one window later.
      if (gap < 0 || gap > 2 * intervalMs) { lastHeard = now; return; }
      if (now - lastHeard < parentSilenceMs) return;
      silenceStopped = true;
      clock.clearInterval(watchdog);
      watchdog = null;
      dispatch(Object.freeze({ type: 'stop' }));
    }, intervalMs);
    watchdog.unref?.();
  }

  return {
    send(message) {
      if (closed || !isOutbound(message)) return false;
      try { return carrier.post(message) === true; } catch { return false; }
    },
    onMessage(listener) {
      if (typeof listener !== 'function') throw new TypeError('onMessage requires a function.');
      if (closed) return () => {};
      listeners.add(listener);
      for (const message of held.splice(0)) deliver(message, listener);
      return () => { listeners.delete(listener); };
    },
    droppedCount: () => dropped,
    close() {
      if (closed) return;
      closed = true;
      if (watchdog) clock.clearInterval(watchdog);
      watchdog = null;
      listeners.clear();
      held.length = 0;
      try { detach(); } catch { /* already gone */ }
      try { carrier.disconnect(); } catch { /* already gone */ }
    },
  };
}

module.exports = { createParentChannel, isOutbound };
