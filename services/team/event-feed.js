'use strict';

// The member client's event feed for one team (TEAM_CHAT_SPEC "2a-4a as built").
// Owned by the connection manager and outliving its links: it validates each
// frame the event stream delivers, remembers the last delivered id
// (`<boot_epoch>:<cursor>`) so a reconnect can resume, and hands each event to
// the listeners in order, exactly once.
//
// - A valid frame: a JSON object with an `event_type` the host's pattern allows, a
//   safe non-negative integer `cursor`, a `boot_epoch` id, `event: jenny`, and a
//   frame id equal to `<boot_epoch>:<cursor>`, nested at most 32 object levels deep.
// - A frame at or below the remembered cursor of the same boot epoch was already
//   delivered (a replay overlap) and is dropped. A new boot epoch is accepted.
// - `resync_required` is an event like any other; the feed continues from its cursor.
// - An invalid frame clears the remembered id and answers its reason; the caller
//   drops the stream, so the host answers the next one with `resync_required`.
//   A cursor is never guessed or repaired.
// - A listener that throws is logged by reason only and never stops the others.
// The remembered id lives in memory only. Nothing here logs a payload or an id.

const EVENT_TYPE = /^[a-z][a-z_]{0,63}$/u;
const BOOT_EPOCH = /^[A-Za-z0-9_-]{1,128}$/u;
const EVENT_NAME = 'jenny';
// Object and array levels, the event object itself being level 1. Host events are a few levels deep.
const MAX_DEPTH = 32;

// True when no object or array inside `root` sits deeper than MAX_DEPTH. Iterative: host JSON can be deep.
function withinDepth(root) {
  const pending = [[root, 1]];
  while (pending.length) {
    const [value, depth] = pending.pop();
    if (depth > MAX_DEPTH) return false;
    for (const key of Object.keys(value)) {
      const child = value[key];
      if (child && typeof child === 'object') pending.push([child, depth + 1]);
    }
  }
  return true;
}

// Listeners share one event object; freezing it keeps one listener from changing what the next one sees.
// Only called on an event withinDepth accepted, so the recursion is bounded.
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

// The event a frame carries, or { reason } when the frame is not one the host could have sent.
function readFrame(frame) {
  if (!frame || frame.event !== EVENT_NAME || typeof frame.id !== 'string' || typeof frame.data !== 'string') {
    return { reason: 'event_frame_invalid' };
  }
  let event;
  try { event = JSON.parse(frame.data); } catch { return { reason: 'event_frame_not_json' }; }
  if (!event || typeof event !== 'object' || Array.isArray(event)) return { reason: 'event_frame_not_object' };
  if (typeof event.event_type !== 'string' || !EVENT_TYPE.test(event.event_type)) return { reason: 'event_frame_type_invalid' };
  if (!Number.isSafeInteger(event.cursor) || event.cursor < 0) return { reason: 'event_frame_cursor_invalid' };
  if (typeof event.boot_epoch !== 'string' || !BOOT_EPOCH.test(event.boot_epoch)) return { reason: 'event_frame_epoch_invalid' };
  if (frame.id !== `${event.boot_epoch}:${event.cursor}`) return { reason: 'event_frame_id_mismatch' };
  if (!withinDepth(event)) return { reason: 'event_frame_too_deep' };
  return { event };
}

function createEventFeed({ log = () => {} } = {}) {
  const listeners = new Set();
  let position = null;

  function deliver(event) {
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try { listener(event); } catch {
        try { log('WARN', 'team.events.listener_failed', { reason: 'listener_threw' }); } catch { /* best effort */ }
      }
    }
  }

  /** Validates and delivers one frame: { ok: true, delivered, eventType? } or { ok: false, reason }. */
  function accept(frame) {
    const read = readFrame(frame);
    if (!read.event) { position = null; return { ok: false, reason: read.reason }; }
    const { event } = read;
    if (position && position.bootEpoch === event.boot_epoch && event.cursor <= position.cursor) {
      return { ok: true, delivered: false };
    }
    // Frozen before the position moves, so nothing can fail between remembering an event and delivering it.
    deepFreeze(event);
    position = { bootEpoch: event.boot_epoch, cursor: event.cursor };
    deliver(event);
    return { ok: true, delivered: true, eventType: event.event_type };
  }

  return {
    accept,
    /** Adds a listener for every delivered event; returns its unsubscribe function. */
    onEvent(listener) {
      if (typeof listener !== 'function') throw new TypeError('listener must be a function');
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    /** The id a reconnect sends as Last-Event-ID, or null. */
    lastEventId: () => (position ? `${position.bootEpoch}:${position.cursor}` : null),
    cursor: () => (position ? position.cursor : null),
    /** Forgets the remembered id (stop, leave, removal, revoke, an invalid frame). */
    clear() { position = null; },
    /** Forgets the id and every listener; nothing is delivered after this. */
    close() { position = null; listeners.clear(); },
  };
}

module.exports = { createEventFeed };
