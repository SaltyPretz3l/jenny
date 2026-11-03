'use strict';

/* services/main/appearance-relay.js - row 88 D8 (docs/plans/PRIMARY_SETTINGS_WRITES_2026-10-27.md).
 * Palette, typography, text size and chat width live in the renderer's localStorage, so main reads
 * and applies them only through a one-shot request pushed on `appearance.onRelayRequest` and the
 * renderer's reply on `appearance.respondRelay`, on the window-exit-guard.js request/reply pattern.
 * Wire shape: services/primary-settings-contract.js.
 *
 * read() / apply(values) resolve `{ ok: true, values, options }` or `{ ok: false, reason }` and
 * NEVER reject; this is the `appearanceRelay` of the primary-settings-allowlist ctx. FAIL CLOSED,
 * never a guess: no window, a destroyed webContents, a send that throws, a 3 s timeout, a reply
 * from another sender, a malformed reply or dispose() all resolve `unavailable`. Replies are
 * validated strictly (tokens only, capped option lists, clipped labels); exception text never
 * leaves this module.
 */

const { getBridgeChannel } = require('../ipc-contract');
const { isPlainObject } = require('../value-utils');
const {
  APPEARANCE_RELAY_FIELDS,
  PRIMARY_SETTINGS_LIMITS,
  RELAY_REQUEST_ID,
  VALUE_TOKEN,
} = require('../primary-settings-contract');

const RELAY_FIELDS = Object.freeze(Object.values(APPEARANCE_RELAY_FIELDS));
const UNAVAILABLE = Object.freeze({ ok: false, reason: 'unavailable' });

const isToken = (value) => typeof value === 'string' && VALUE_TOKEN.test(value);
const hasExactly = (source, keys) => {
  const own = Object.keys(source);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(source, key));
};

// Strict reply validation. Returns the clean `{ ok: true, values, options }` or null (malformed).
function cleanSuccessReply(payload) {
  if (!isPlainObject(payload.values) || !hasExactly(payload.values, RELAY_FIELDS)) return null;
  if (!RELAY_FIELDS.every((field) => isToken(payload.values[field]))) return null;
  if (!isPlainObject(payload.options)) return null;
  const values = {};
  const options = {};
  for (const field of RELAY_FIELDS) {
    values[field] = payload.values[field];
    const list = payload.options[field];
    if (!Array.isArray(list)) return null;
    options[field] = list
      .filter((item) => isPlainObject(item) && isToken(item.value) && typeof item.label === 'string')
      .slice(0, PRIMARY_SETTINGS_LIMITS.options_max)
      .map((item) => ({ value: item.value, label: item.label.slice(0, PRIMARY_SETTINGS_LIMITS.label_chars) }));
  }
  return { ok: true, values, options };
}

function createAppearanceRelay({
  getWindow = () => null,
  log = () => {},
  timeoutMs = PRIMARY_SETTINGS_LIMITS.relay_timeout_ms,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  const requestChannel = getBridgeChannel('appearance.onRelayRequest', 'subscribe');
  const pending = new Map(); // request_id -> { resolve, timer }
  let seq = 0;

  const logEvent = (level, event, details) => {
    try { log(level, event, details || {}); } catch (_error) { /* logging never changes the outcome */ }
  };

  function currentWebContents() {
    try {
      const win = getWindow();
      const contents = win && win.webContents;
      if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return null;
      if (!contents || typeof contents.send !== 'function') return null;
      if (typeof contents.isDestroyed === 'function' && contents.isDestroyed()) return null;
      return contents;
    } catch (_error) {
      return null;
    }
  }

  function settle(requestId, result) {
    const entry = pending.get(requestId);
    if (!entry) return false;
    pending.delete(requestId);
    clearTimeoutFn(entry.timer);
    entry.resolve(result);
    return true;
  }

  function request(op, values) {
    const contents = currentWebContents();
    if (!contents) return Promise.resolve(UNAVAILABLE);
    seq += 1;
    const requestId = `ar_${seq}`;
    return new Promise((resolve) => {
      const timer = setTimeoutFn(() => {
        if (settle(requestId, UNAVAILABLE)) logEvent('WARN', 'appearance_relay.timeout', { op, timeoutMs });
      }, timeoutMs);
      pending.set(requestId, { resolve, timer });
      try {
        contents.send(requestChannel, values === undefined ? { request_id: requestId, op } : { request_id: requestId, op, values });
      } catch (_error) {
        settle(requestId, UNAVAILABLE);
        logEvent('WARN', 'appearance_relay.send_failed', { op });
      }
    });
  }

  const read = () => request('read');

  function apply(values) {
    const keys = isPlainObject(values) ? Object.keys(values) : [];
    if (!keys.length || !keys.every((key) => RELAY_FIELDS.includes(key) && isToken(values[key]))) {
      return Promise.resolve({ ok: false, reason: 'invalid_value' });
    }
    return request('apply', Object.fromEntries(keys.map((key) => [key, values[key]])));
  }

  // The `appearance.respondRelay` invoke handler body. `{ ok: true }` only when a pending request
  // was resolved (even to `unavailable` for a malformed reply); anything else is ignored.
  function handleResponse(event, payload) {
    const contents = currentWebContents();
    if (!contents || !event || event.sender !== contents) {
      logEvent('WARN', 'appearance_relay.reply_unauthorized', {});
      return { ok: false };
    }
    const requestId = isPlainObject(payload) && typeof payload.request_id === 'string' ? payload.request_id : '';
    if (!RELAY_REQUEST_ID.test(requestId) || !pending.has(requestId)) return { ok: false };
    let result = UNAVAILABLE;
    if (payload.ok === true) {
      result = cleanSuccessReply(payload) || UNAVAILABLE;
      if (result === UNAVAILABLE) logEvent('WARN', 'appearance_relay.reply_malformed', {});
    } else if (payload.ok === false) {
      result = { ok: false, reason: payload.reason === 'invalid_value' ? 'invalid_value' : 'unavailable' };
    } else {
      logEvent('WARN', 'appearance_relay.reply_malformed', {});
    }
    return { ok: settle(requestId, result) };
  }

  function dispose() {
    for (const requestId of [...pending.keys()]) settle(requestId, UNAVAILABLE);
  }

  return { read, apply, handleResponse, dispose };
}

module.exports = { createAppearanceRelay };
