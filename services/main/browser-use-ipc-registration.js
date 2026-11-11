'use strict';
// `browserUse.*` IPC namespace (row 114): the browser panel beside a chat. The
// renderer asks for a page's state, shows and moves it, takes it over, hands it
// back, snapshots it and closes it; it never drives the page. Every channel goes
// through the trusted-sender authorizer. Payloads are closed: { session_id } or,
// for show and setBounds, { session_id, bounds }; the by-hand controls below add
// their own fixed keys. Flag off or no service answers
// browser_unavailable before anything is validated or touched. Answers are
// { ok, ... } or { ok: false, reason }; a thrown error never crosses the bridge.
const { validSessionId } = require('../chat-messaging-contract');
const { registerIpcInvokeHandlers } = require('../ipc-contract');
const { isPlainObject } = require('../value-utils');

const REASON = /^[a-z][a-z0-9_]{0,63}$/u;
const MAX_OFFSET = 32767;
const MIN_OFFSET = -32768;
const MAX_SIZE = 16384;

const hasExactKeys = (value, keys) => {
  const found = Object.keys(value);
  return found.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
};
const isInteger = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

function parseBounds(bounds) {
  if (!isPlainObject(bounds) || !hasExactKeys(bounds, ['x', 'y', 'width', 'height'])) return null;
  const { x, y, width, height } = bounds;
  if (!isInteger(x, MIN_OFFSET, MAX_OFFSET) || !isInteger(y, MIN_OFFSET, MAX_OFFSET)
    || !isInteger(width, 1, MAX_SIZE) || !isInteger(height, 1, MAX_SIZE)) return null;
  return { x, y, width, height };
}

function parsePayload(payload, withBounds) {
  if (!isPlainObject(payload) || !hasExactKeys(payload, withBounds ? ['session_id', 'bounds'] : ['session_id'])) return null;
  if (!validSessionId(payload.session_id)) return null;
  if (!withBounds) return { sessionId: payload.session_id };
  const bounds = parseBounds(payload.bounds);
  return bounds ? { sessionId: payload.session_id, bounds } : null;
}

const MAX_ADDRESS_CHARS = 4096;
const MAX_FIND_CHARS = 256;
const MAX_SITE_CHARS = 253;
const MAX_LABEL_CHARS = 60;
const COLOR = /^#[0-9a-f]{6}$/iu;
const NAVIGATION_OPS = new Set(['back', 'forward', 'reload', 'stop']);
const ZOOM_CHANGES = new Set(['in', 'out', 'reset']);
const MENU_LABELS = ['back', 'reload', 'cut', 'copy', 'paste', 'selectAll', 'copyLink', 'copyImage'];
const isShortText = (value, max) => typeof value === 'string' && value.length <= max;

// Each answers the validated fields, or null for anything else.
const REQUEST_PARSERS = Object.freeze({
  navigate(rest) {
    if (hasExactKeys(rest, ['op'])) return NAVIGATION_OPS.has(rest.op) ? { op: rest.op } : null;
    return hasExactKeys(rest, ['url']) && isShortText(rest.url, MAX_ADDRESS_CHARS) ? { url: rest.url } : null;
  },
  zoom: (rest) => (hasExactKeys(rest, ['change']) && ZOOM_CHANGES.has(rest.change) ? { change: rest.change } : null),
  find: (rest) => (hasExactKeys(rest, ['text', 'forward', 'next']) && isShortText(rest.text, MAX_FIND_CHARS)
    && typeof rest.forward === 'boolean' && typeof rest.next === 'boolean' ? { text: rest.text, forward: rest.forward, next: rest.next } : null),
  removeSite: (rest) => (hasExactKeys(rest, ['site']) && isShortText(rest.site, MAX_SITE_CHARS) ? { site: rest.site } : null),
  setAdBlock: (rest) => (hasExactKeys(rest, ['enabled']) && typeof rest.enabled === 'boolean' ? { enabled: rest.enabled } : null),
  configure(rest) {
    if (!hasExactKeys(rest, ['background', 'labels']) || typeof rest.background !== 'string' || !COLOR.test(rest.background)) return null;
    if (!isPlainObject(rest.labels) || !hasExactKeys(rest.labels, MENU_LABELS)) return null;
    return MENU_LABELS.every((key) => isShortText(rest.labels[key], MAX_LABEL_CHARS)) ? { background: rest.background, labels: rest.labels } : null;
  },
});

function parseRequest(name, payload) {
  if (!isPlainObject(payload) || !validSessionId(payload.session_id)) return null;
  const { session_id: sessionId, ...rest } = payload;
  const fields = REQUEST_PARSERS[name](rest);
  return fields ? { sessionId, fields } : null;
}

const UNAVAILABLE = Object.freeze({ ok: false, reason: 'browser_unavailable' });
const INVALID = Object.freeze({ ok: false, reason: 'invalid_payload' });
const FAILED = Object.freeze({ ok: false, reason: 'browser_error' });

function shape(result) {
  if (result?.ok === true) return { ...result };
  return { ok: false, reason: typeof result?.reason === 'string' && REASON.test(result.reason) ? result.reason : FAILED.reason };
}

function registerBrowserUseIpc(ipcMain, { getService, authorization, isEnabled = () => true }) {
  const available = () => {
    try {
      return isEnabled() === true ? getService() || null : null;
    } catch (_error) {
      return null;
    }
  };
  const handler = (parse, run) => async (_event, payload) => {
    const service = available();
    if (!service) return { ...UNAVAILABLE };
    const parsed = parse(payload);
    if (!parsed) return { ...INVALID };
    try {
      return shape(await run(service, parsed));
    } catch (_error) {
      return { ...FAILED };
    }
  };
  const plain = (payload) => parsePayload(payload, false);
  const bounded = (payload) => parsePayload(payload, true);
  const simple = (method) => handler(plain, (service, { sessionId }) => service[method](sessionId));
  const withBounds = (method) => handler(bounded, (service, { sessionId, bounds }) => service[method](sessionId, bounds));
  const request = (name, call) => handler((payload) => parseRequest(name, payload), (service, { sessionId, fields }) => call(service, sessionId, fields));

  return registerIpcInvokeHandlers(ipcMain, {
    'browserUse.getState': handler(plain, async (service, { sessionId }) => ({ ok: true, ...(await service.getState(sessionId)) })),
    'browserUse.show': withBounds('show'),
    'browserUse.setBounds': withBounds('setBounds'),
    'browserUse.hide': simple('hide'),
    'browserUse.capture': simple('capture'),
    'browserUse.takeOver': simple('takeOver'),
    'browserUse.handBack': simple('handBack'),
    'browserUse.close': simple('close'),
    'browserUse.navigate': request('navigate', (service, sessionId, fields) => service.navigate(sessionId, fields)),
    'browserUse.zoom': request('zoom', (service, sessionId, { change }) => service.zoom(sessionId, change)),
    'browserUse.find': request('find', (service, sessionId, fields) => service.find(sessionId, fields)),
    'browserUse.stopFind': simple('stopFind'),
    'browserUse.siteInfo': simple('siteInfo'),
    'browserUse.removeSite': request('removeSite', (service, sessionId, { site }) => service.removeSite(sessionId, site)),
    'browserUse.revealDownload': simple('revealDownload'),
    'browserUse.configure': request('configure', (service, sessionId, fields) => service.configure(sessionId, fields)),
    'browserUse.toggleSound': simple('toggleSound'),
    'browserUse.setAdBlock': request('setAdBlock', (service, sessionId, { enabled }) => service.setAdBlock(sessionId, enabled)),
  }, authorization);
}

// The window's mute works with the browser off, so it does not go through available().
function registerAppSoundIpc(ipcMain, { getHolder, authorization }) {
  const withHolder = (run) => async (_event, payload) => {
    const holder = getHolder();
    if (!holder) return { ...UNAVAILABLE };
    try {
      return { ok: true, ...run(holder, payload) };
    } catch (_error) {
      return { ...FAILED };
    }
  };
  return registerIpcInvokeHandlers(ipcMain, {
    'appSound.getState': withHolder((holder) => holder.soundState()),
    'appSound.setMuted': async (event, payload) => {
      if (!isPlainObject(payload) || !hasExactKeys(payload, ['muted']) || typeof payload.muted !== 'boolean') return { ...INVALID };
      return withHolder((holder) => holder.setAppMuted(payload.muted))(event, payload);
    },
  }, authorization);
}

module.exports = { registerAppSoundIpc, registerBrowserUseIpc };
