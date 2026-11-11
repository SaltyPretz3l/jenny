'use strict';

/**
 * Plain-Node stand-ins for the Electron objects the browser-use service touches:
 * WebContentsView, its webContents and Session, and the main BrowserWindow.
 *
 * The fake webContents answers the isolated-world reader calls the real
 * page-actions layer makes, so service tests run the real action, consent and
 * guard code against it.
 */

const { EventEmitter } = require('node:events');
const { createFakeWebContents, createFakeNativeImage } = require('./fake-web-contents-view');
const { createFakeTimers } = require('./fake-timers');

const PUBLIC_ANSWER = Object.freeze({ endpoints: [{ address: '93.184.216.34', family: 'ipv4' }] });

function createJpegImage(width = 800, height = 600) {
  return {
    ...createFakeNativeImage(width, height),
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    toJPEG: (quality) => Buffer.from(`jpeg-${quality}`),
  };
}

function createFakeSession(partition, options = {}) {
  const session = new EventEmitter();
  const listeners = { onBeforeRequest: null, onCompleted: null, onBeforeRedirect: null };
  const webRequest = {};
  for (const name of Object.keys(listeners)) {
    webRequest[name] = (filter, listener) => { listeners[name] = listener ? { filter, listener } : null; };
  }
  Object.assign(session, {
    partition,
    userAgent: '',
    webRequest,
    listeners,
    permissionRequestHandler: undefined,
    permissionCheckHandler: undefined,
    devicePermissionHandler: undefined,
    clearedStorage: 0,
    resolved: [],
    resolveAnswer: options.resolveAnswer || (() => PUBLIC_ANSWER),
    setUserAgent(value) { session.userAgent = value; },
    setPermissionRequestHandler(fn) { session.permissionRequestHandler = fn; },
    setPermissionCheckHandler(fn) { session.permissionCheckHandler = fn; },
    setDevicePermissionHandler(fn) { session.devicePermissionHandler = fn; },
    async resolveHost(host) {
      session.resolved.push(host);
      return session.resolveAnswer(host);
    },
    async clearStorageData() {
      session.clearedStorage += 1;
      if (options.clearStorageFails) throw new Error('storage failed');
    },
    /** Runs the registered onBeforeRequest listener and returns what it answered. */
    request(details) {
      const entry = listeners.onBeforeRequest;
      if (!entry) return Promise.resolve({ cancel: false, unfiltered: true });
      return new Promise((resolve) => entry.listener(details, resolve));
    },
    completed(details) { listeners.onCompleted?.listener(details); },
    redirected(details) { listeners.onBeforeRedirect?.listener(details); },
    /** Emits will-download and reports whether the handler cancelled it. */
    download(url) {
      let prevented = false;
      const event = { preventDefault() { prevented = true; } };
      session.emit('will-download', event, { getURL: () => url });
      return prevented;
    },
  });
  return session;
}

const OP_PATTERN = /return readerEntry\(("[A-Za-z]+"), /;

function parseReaderCall(code) {
  const text = String(code);
  const found = OP_PATTERN.exec(text);
  if (!found) return { op: '', args: {} };
  const argsStart = found.index + found[0].length;
  const argsEnd = text.indexOf(', [installReaderCore', argsStart);
  let args = {};
  try {
    args = JSON.parse(text.slice(argsStart, argsEnd));
  } catch (_error) { /* an unparseable call just carries no args */ }
  return { op: JSON.parse(found[1]), args };
}

function defaultReaderOps(contents) {
  return {
    status: () => ({ msSinceMutation: 5000 }),
    read: () => ({
      status: 'ok', url: contents.state.url, title: contents.state.title || 'Page', text: 'Outline text', refs: 0,
    }),
    find: () => ({ matches: [], total: 0 }),
  };
}

function createFakeBrowserWebContents(session, options = {}) {
  const contents = createFakeWebContents({ ...options, executeJavaScriptInIsolatedWorld: undefined });
  const emitter = new EventEmitter();
  let destroyed = false;
  const readerCalls = [];
  const ops = { ...defaultReaderOps(contents), ...(options.readerOps || {}) };
  const note = (name, args = []) => contents.log.push({ who: 'wc', name, args });

  Object.assign(contents, {
    session,
    readerCalls,
    readerOps: ops,
    closeCalls: [],
    stopCalls: 0,
    webrtcPolicy: '',
    windowOpenHandler: null,
    on(event, listener) { emitter.on(event, listener); return contents; },
    once(event, listener) { emitter.once(event, listener); return contents; },
    removeListener(event, listener) { emitter.removeListener(event, listener); return contents; },
    removeAllListeners(event) { emitter.removeAllListeners(event); return contents; },
    emit(event, ...args) { return emitter.emit(event, ...args); },
    listenerCount(event) { return emitter.listenerCount(event); },
    setWebRTCIPHandlingPolicy(policy) { contents.webrtcPolicy = policy; },
    setWindowOpenHandler(handler) { contents.windowOpenHandler = handler; },
    setAudioMuted(muted) { contents.audioMuted = muted; },
    stop() { contents.stopCalls += 1; note('stop'); },
    getTitle() { return contents.state.title || ''; },
    close(closeOptions) {
      contents.closeCalls.push(closeOptions);
      note('close', [closeOptions]);
      if (options.autoDestroy !== false) setImmediate(() => contents.destroy());
    },
    isDestroyed() { return destroyed; },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      emitter.emit('destroyed');
    },
    async capturePage(...args) {
      note('capturePage', args);
      if (options.capturePage) return options.capturePage(...args);
      return createJpegImage();
    },
    async executeJavaScriptInIsolatedWorld(worldId, scripts) {
      const { op, args } = parseReaderCall(scripts?.[0]?.code);
      readerCalls.push({ worldId, op, args });
      note('reader', [op]);
      const handler = ops[op];
      if (typeof handler === 'function') return handler(args);
      return handler;
    },
  });
  contents.state.title = options.title || '';
  return contents;
}

function createFakeView(options, session, webContentsOptions) {
  const view = {
    options,
    bounds: null,
    boundsHistory: [],
    webContents: createFakeBrowserWebContents(session, webContentsOptions),
    setBounds(bounds) {
      view.bounds = { ...bounds };
      view.boundsHistory.push({ ...bounds });
    },
    getBounds() { return view.bounds; },
  };
  return view;
}

function createFakeMainWindow() {
  const contentView = {
    children: [],
    addChildView(view) { contentView.children.push(view); },
    removeChildView(view) {
      const at = contentView.children.indexOf(view);
      if (at >= 0) contentView.children.splice(at, 1);
    },
  };
  const webContents = createFakeBrowserWebContents(createFakeSession('main'), {});
  webContents.focusCalls = 0;
  webContents.focus = () => { webContents.focusCalls += 1; };
  let destroyed = false;
  const fake = {
    contentView,
    webContents,
    minimized: false,
    visible: true,
    contentBounds: { x: 0, y: 0, width: 1600, height: 900 },
    getContentBounds: () => ({ ...fake.contentBounds }),
    isMinimized: () => fake.minimized,
    isVisible: () => fake.visible,
    isDestroyed: () => destroyed,
    destroy() { destroyed = true; },
  };
  return fake;
}

/**
 * options:
 *   noWindow           getMainWindow() answers null
 *   createViewFails    createView throws
 *   webContents        options for each fake webContents (loadURL, readerOps, autoDestroy, ...)
 *   session            options for each fake session (resolveAnswer, ...)
 */
function createFakeElectron(options = {}) {
  const window = createFakeMainWindow();
  const sessions = new Map();
  const views = [];
  const viewOptions = [];

  function sessionFromPartition(partition) {
    if (!sessions.has(partition)) sessions.set(partition, createFakeSession(partition, options.session));
    return sessions.get(partition);
  }

  function createView(viewConfig) {
    if (options.createViewFails) throw new Error('view failed at C:\\secret\\path');
    viewOptions.push(viewConfig);
    const session = sessionFromPartition(viewConfig?.webPreferences?.partition);
    const view = createFakeView(viewConfig, session, options.webContents);
    views.push(view);
    return view;
  }

  return {
    window,
    sessions,
    views,
    viewOptions,
    createView,
    sessionFromPartition,
    getMainWindow: () => (options.noWindow ? null : window),
    lastView: () => views[views.length - 1],
    crash(view) { view.webContents.emit('render-process-gone', {}, { reason: 'crashed' }); },
  };
}

/**
 * A service wired to the fakes, with a virtual clock for its timers.
 * Pass overrides for any createBrowserUseService dependency.
 */
function createBrowserUseHarness(overrides = {}, electronOptions = {}) {
  const { createBrowserUseService } = require('../../services/browser-use/browser-use-service');
  const electron = createFakeElectron(electronOptions);
  const timers = createFakeTimers();
  const events = [];
  const logs = [];
  let tokenCount = 0;
  const turn = { id: 'turn-1' }; // the turn running in every chat; '' is between turns
  const service = createBrowserUseService({
    createView: electron.createView,
    sessionFromPartition: electron.sessionFromPartition,
    getMainWindow: electron.getMainWindow,
    getReservedPorts: () => [11434],
    getRunningTurnId: () => turn.id,
    sendBridgeEvent: (methodPath, payload) => events.push({ methodPath, payload }),
    logger: (level, event, fields) => logs.push({ level, event, fields }),
    now: timers.now,
    setTimer: timers.setTimeout,
    clearTimer: timers.clearTimeout,
    randomToken: () => { tokenCount += 1; return `tok${tokenCount}`; },
    ...overrides,
  });
  return { service, electron, timers, events, logs, turn };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/**
 * The settle wait uses unref'd timers (right for the app), so a test awaiting a
 * step would let the event loop drain. Call once at the top of a test file.
 */
function holdEventLoop(test) {
  const keepAlive = setInterval(() => {}, 1000);
  test.after(() => clearInterval(keepAlive));
}

async function waitFor(predicate, { timeoutMs = 3000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

module.exports = {
  PUBLIC_ANSWER,
  createBrowserUseHarness,
  createFakeBrowserWebContents,
  createFakeElectron,
  createFakeMainWindow,
  createFakeSession,
  createJpegImage,
  deferred,
  holdEventLoop,
  parseReaderCall,
  waitFor,
};
