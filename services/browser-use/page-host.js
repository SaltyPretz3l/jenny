'use strict';

/**
 * One hardened browser page for one chat (roadmap row 114): a WebContentsView in
 * its own in-memory session, the request and navigation rules that hold in every
 * mode, and a disposal that proves the page is really gone.
 *
 * Nothing here requires Electron; the view and session factories are injected.
 * Logs carry event names and generic reasons only, never an address or page text.
 */

const crypto = require('node:crypto');
const path = require('node:path');
const { createInputWatch } = require('./input-watch');
const { createPageExtras } = require('./page-extras');
const { READER_WORLD_ID } = require('./page-reader-script');

const OFFSCREEN_X = -32000;
const DEFAULT_SIZE = Object.freeze({ width: 1280, height: 800 });
const DISPOSE_CAP_MS = 2000;
const DESTROY_POLL_MS = 50;
const ARM_HOLD_MS = 16;
const KICK_CAP_MS = 250;
const ALL_URLS = Object.freeze({ urls: ['<all_urls>'] });
const REQUEST_HOOKS = Object.freeze(['onBeforeRequest', 'onCompleted', 'onBeforeRedirect']);
const JPEG_QUALITY = 70;
const FALLBACK_CHROME_MAJOR = 130;
// A load that was replaced or stopped, or that the request filter refused, is not a page that could not be reached.
const NOT_A_FAILURE = new Set([-3, -20]);
const ZOOM_LEVELS = Object.freeze([0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]);
const MAX_FIND_CHARS = 256;
// The only page permissions a person can use, and only while they are the one on the page.
const BY_HAND_PERMISSIONS = new Set(['clipboard-sanitized-write']);
const NOTED_PERMISSIONS = Object.freeze({ geolocation: 'location', media: 'camera', notifications: 'notifications' });
const SECRET_FIELD_QUERY = "document.activeElement?.matches?.('input[type=\"password\"]') === true";
const PDF_VIEWER_ORIGIN = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/';
const PDF_VIEWER_RESOURCES = 'chrome://resources/';
const NETWORK_REFUSALS = new Set([
  'private_address', 'internal_name', 'resolves_to_private_address', 'landed_on_private_address',
]);

const USER_AGENT_PLATFORMS = Object.freeze({
  win32: 'Windows NT 10.0; Win64; x64',
  darwin: 'Macintosh; Intel Mac OS X 10_15_7',
  linux: 'X11; Linux x86_64',
});

/** A Chrome-shaped user agent. Sites that gate on "Electron" or an unknown app name break otherwise. */
function chromeUserAgent(versions = process.versions, platform = process.platform) {
  const major = Number.parseInt(String(versions?.chrome || '').split('.')[0], 10);
  const token = USER_AGENT_PLATFORMS[platform] || USER_AGENT_PLATFORMS.linux;
  const version = Number.isInteger(major) && major > 0 ? major : FALLBACK_CHROME_MAJOR;
  return `Mozilla/5.0 (${token}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Safari/537.36`;
}

function hostOf(rawUrl) {
  try {
    return new URL(String(rawUrl)).hostname;
  } catch (_error) {
    return '';
  }
}

const noop = () => {};
const defaultToken = () => crypto.randomBytes(8).toString('hex');

function refusalNote(reason, host) {
  if (reason === 'new_site') return { kind: 'blocked_site', host: String(host || '') };
  return { kind: NETWORK_REFUSALS.has(reason) ? 'blocked_network' : 'blocked_link', host: '' };
}

function offscreenRect(size) {
  return { x: OFFSCREEN_X, y: 0, width: size?.width || DEFAULT_SIZE.width, height: size?.height || DEFAULT_SIZE.height };
}

function buildWebPreferences(partition) {
  return {
    partition,
    devTools: false,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
    // Chromium's PDF viewer is the only plugin there is. No page can reach a native dialog.
    plugins: true,
    disableDialogs: true,
  };
}

// The browser's own PDF viewer needs its files and the shared scripts it imports, and only it may have those scripts.
function isPdfViewerRequest(details) {
  const url = String(details?.url);
  if (url.startsWith(PDF_VIEWER_ORIGIN)) return true;
  return url.startsWith(PDF_VIEWER_RESOURCES) && String(details?.frame?.url || '').startsWith(PDF_VIEWER_ORIGIN);
}

function createPageHost({
  createView, sessionFromPartition, getMainWindow, randomToken = defaultToken, urlGuard, consent,
  isUserHolding = () => false, isModelActing = () => false, onUserInput, onActivity, onCrash, onChanged, forwardChord,
  onBrowserChord, onContextMenu, logger, adBlocker = null, isAppMuted = () => false, keptSettings = null,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, disposeCapMs = DISPOSE_CAP_MS,
}) {
  const window = getMainWindow?.();
  if (!window || window.isDestroyed?.()) throw new Error('browser_use_no_window');

  const log = (level, event, fields = {}) => { try { logger?.(level, event, fields); } catch (_error) { /* logging never breaks the page */ } };
  const attempt = (fn) => { try { return fn(); } catch (_error) { return undefined; } };

  const partition = `jenny-browser-use-${randomToken()}`;
  const view = createView({ webPreferences: buildWebPreferences(partition) });
  const webContents = view.webContents;
  const browserSession = sessionFromPartition(partition);
  const watch = createInputWatch({
    now, onTakeOver: onUserInput, onActivity, forwardChord, onBrowserChord, onUserKey: () => checkForSecretField(),
  });
  const attached = [];
  let generation = 1;
  let blankedGeneration = 0;
  let disposing = false;
  let disposal = null;
  let failedUrl = '';
  let note = null;
  let pendingUrl = '';
  let zoomFactor = 1;
  let findResult = null;
  let signedIn = false;
  let checkingForSecret = false;
  let saving = false;
  let savedPath = '';

  const isDestroyed = () => Boolean(attempt(() => webContents.isDestroyed?.()));
  const changed = () => { if (!disposing) attempt(() => onChanged?.()); };

  function listen(event, handler) {
    const wrapped = (...args) => { if (!disposing) attempt(() => handler(...args)); };
    webContents.on(event, wrapped);
    attached.push([event, wrapped]);
  }

  function setNote(next) {
    note = next;
    changed();
  }

  // The Ask tier belongs to the model. While the user holds the browser only the Refuse tier applies.
  function pageNavigationAllowed(url) {
    try {
      const review = isUserHolding() ? null : consent.reviewPageNavigation(url);
      const verdict = review ? { allowed: review.allow, reason: review.reason, host: review.host } : urlGuard.classify(url, { kind: 'navigation' });
      if (verdict.allowed === true) return true;
      setNote(refusalNote(verdict.reason, verdict.host));
      return false;
    } catch (_error) {
      return false;
    }
  }

  // A sign-in replaces the document, so this is asked as each key goes in and remembered here. A page that merely has a
  // password field somewhere has not been signed in to.
  function checkForSecretField() {
    if (signedIn || checkingForSecret) return;
    checkingForSecret = true;
    Promise.resolve(attempt(() => webContents.executeJavaScriptInIsolatedWorld(READER_WORLD_ID, [{ code: SECRET_FIELD_QUERY }])))
      .then((found) => {
        if (found !== true || signedIn) return;
        signedIn = true;
        changed();
      })
      .catch(noop)
      .finally(() => { checkingForSecret = false; });
  }

  // By hand only, through the normal Save dialog. Anything else is cancelled, and only the model is told about its own.
  function handleDownload(event, item) {
    if (!isUserHolding() || saving) {
      event.preventDefault();
      if (isModelActing()) consent.noteBlockedDownload(hostOf(attempt(() => item.getURL())));
      if (!saving) setNote({ kind: 'download_off', host: '' });
      return;
    }
    saving = true;
    item.once('done', (_event, state) => {
      saving = false;
      if (state !== 'completed' || disposing) return;
      savedPath = String(attempt(() => item.getSavePath()) || '');
      if (!savedPath) return;
      setNote({ kind: 'saved', file: path.basename(savedPath) });
    });
  }

  function requestPermission(permission) {
    if (isUserHolding() && BY_HAND_PERMISSIONS.has(permission)) return true;
    if (Object.hasOwn(NOTED_PERMISSIONS, permission)) setNote({ kind: 'permission', what: NOTED_PERMISSIONS[permission] });
    return false;
  }

  function applyZoom(factor) {
    zoomFactor = factor;
    attempt(() => webContents.setZoomFactor(factor));
    changed();
  }

  function zoom(change) {
    if (disposing || isDestroyed()) return;
    if (change === 'reset') {
      applyZoom(1);
      return;
    }
    const index = ZOOM_LEVELS.findIndex((level) => level >= zoomFactor);
    const at = index === -1 ? ZOOM_LEVELS.length - 1 : index;
    applyZoom(ZOOM_LEVELS[Math.max(0, Math.min(ZOOM_LEVELS.length - 1, at + (change === 'in' ? 1 : -1)))]);
  }

  function findText(text, { forward = true, next = false } = {}) {
    if (disposing || isDestroyed()) return;
    const needle = String(text ?? '').slice(0, MAX_FIND_CHARS);
    if (!needle) {
      stopFind();
      return;
    }
    attempt(() => webContents.findInPage(needle, { forward, findNext: next === true }));
  }

  function stopFind() {
    findResult = null;
    if (!disposing && !isDestroyed()) attempt(() => webContents.stopFindInPage('clearSelection'));
    changed();
  }

  function withhold(reason) {
    consent.noteWithheld(reason);
    if (blankedGeneration === generation) return;
    blankedGeneration = generation;
    log('WARN', 'browser_use.withheld', { reason });
    attempt(() => webContents.stop());
    attempt(() => Promise.resolve(webContents.loadURL('about:blank')).catch(noop));
  }

  function observeAddress(details) {
    let verdict;
    try {
      verdict = urlGuard.checkObservedIp(details?.url, details?.ip);
    } catch (_error) {
      return;
    }
    if (verdict?.withhold) withhold(verdict.reason);
  }

  const pageIsLoopback = () => attempt(() => urlGuard.classify(webContents.getURL()).isLoopback) === true;

  function installSession() {
    browserSession.setUserAgent(chromeUserAgent());
    browserSession.setPermissionRequestHandler((_contents, permission, callback) => callback(requestPermission(permission)));
    browserSession.setPermissionCheckHandler((_contents, permission) => isUserHolding() && BY_HAND_PERMISSIONS.has(permission));
    browserSession.setDevicePermissionHandler(() => false);
    const onDownload = (event, item) => handleDownload(event, item);
    browserSession.on('will-download', onDownload);
    attached.push(['session:will-download', onDownload]);
    browserSession.webRequest.onBeforeRequest(ALL_URLS, (details, callback) => {
      let allowed = false;
      try {
        const kind = details?.resourceType === 'mainFrame' ? 'navigation' : 'subresource';
        const verdict = urlGuard.classify(details?.url, { kind });
        // Only a localhost page the user allowed may talk to this machine. A public page never asks, so it never may.
        allowed = (verdict.allowed === true && (kind === 'navigation' || !verdict.isLoopback || pageIsLoopback()))
          || (kind === 'subresource' && isPdfViewerRequest(details));
        if (allowed && extras.blocksAd(details)) allowed = false;
      } catch (_error) { /* fail closed */ }
      callback(allowed ? {} : { cancel: true });
    });
    browserSession.webRequest.onCompleted(ALL_URLS, observeAddress);
    browserSession.webRequest.onBeforeRedirect(ALL_URLS, observeAddress);
  }

  function installContents() {
    attempt(() => webContents.setIgnoreMenuShortcuts(true)); // the app's menu keys are not for the page
    if (typeof webContents.setWebRTCIPHandlingPolicy === 'function') {
      attempt(() => webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp'));
    }
    webContents.setWindowOpenHandler((details) => {
      const url = String(details?.url || '');
      // The popup itself is always refused; an allowed address is loaded in this page instead.
      if (pageNavigationAllowed(url)) attempt(() => Promise.resolve(webContents.loadURL(url)).catch(noop));
      return { action: 'deny' };
    });
    const guardNavigation = (event, ...rest) => {
      const url = String(event?.url ?? rest[0] ?? '');
      if ((event?.isMainFrame ?? rest[2]) === false) return;
      if (!pageNavigationAllowed(url)) event.preventDefault?.();
    };
    // These two must stay synchronous and fail closed, so they bypass listen()'s swallow.
    for (const name of ['will-navigate', 'will-redirect']) {
      const handler = (event, ...rest) => {
        if (disposing) return;
        try {
          guardNavigation(event, ...rest);
        } catch (_error) {
          attempt(() => event.preventDefault());
        }
      };
      webContents.on(name, handler);
      attached.push([name, handler]);
    }
    listen('dom-ready', () => extras.hideAds());
    listen('did-navigate', () => {
      generation += 1;
      extras.navigated();
      if (zoomFactor !== 1) attempt(() => webContents.setZoomFactor(zoomFactor)); // Chromium keeps zoom per site
      changed();
    });
    listen('did-start-navigation', (event, ...rest) => {
      if ((event?.isMainFrame ?? rest[2]) === false || (event?.isSameDocument ?? rest[1]) === true) return;
      failedUrl = '';
      note = null;
      findResult = null;
      changed();
    });
    listen('did-fail-load', (_event, code, _description, url, isMainFrame) => {
      if (isMainFrame === false || NOT_A_FAILURE.has(code)) return;
      failedUrl = String(url || pendingUrl);
      pendingUrl = '';
      changed();
    });
    listen('did-stop-loading', () => {
      pendingUrl = '';
      changed();
    });
    for (const name of ['did-navigate-in-page', 'page-title-updated', 'did-start-loading']) {
      listen(name, changed);
    }
    listen('found-in-page', (_event, result) => {
      findResult = { ordinal: Number(result?.activeMatchOrdinal) || 0, total: Number(result?.matches) || 0 };
      changed();
    });
    listen('zoom-changed', (_event, direction) => zoom(direction === 'in' ? 'in' : 'out'));
    listen('context-menu', (_event, params) => onContextMenu?.(params));
    listen('render-process-gone', () => onCrash?.());
    listen('before-input-event', (event, input) => watch.onKey(event, input));
    listen('before-mouse-event', (event, mouse) => watch.onMouse(event, mouse));
  }

  function setBounds(rect) {
    if (disposing) return;
    view.setBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
  }

  const extras = createPageExtras({
    webContents, getActionContents: () => actionContents, worldId: READER_WORLD_ID, armView: (options) => armView(options),
    adBlocker, isAppMuted, isModelActing, pageIsLoopback, isExemptRequest: isPdfViewerRequest, onChanged: changed, setTimer, clearTimer, keptSettings,
  });

  // A view always has bounds: a page with a zero-size viewport reads as nothing visible.
  let homeRect = offscreenRect(DEFAULT_SIZE);
  let parked = true;
  setBounds(homeRect);
  window.contentView.addChildView(view);
  try {
    installSession();
    installContents();
  } catch (error) {
    disposing = true;
    attempt(() => window.contentView.removeChildView(view));
    attempt(() => webContents.close({ waitForBeforeUnload: false }));
    throw error;
  }

  // Our own input must not look like the user's. Everything else passes straight through.
  const actionContents = new Proxy(webContents, {
    get(target, property) {
      if (property === 'sendInputEvent') {
        return (...args) => {
          watch.noteOwnInput();
          // Positions are measured in the page's CSS pixels; a zoomed page is larger than that on screen.
          const [input] = args;
          if (zoomFactor === 1 || !Number.isFinite(input?.x)) return target.sendInputEvent(...args);
          return target.sendInputEvent({ ...input, x: Math.round(input.x * zoomFactor), y: Math.round(input.y * zoomFactor) });
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  function waitForDestruction() {
    if (isDestroyed()) return Promise.resolve(true);
    return new Promise((resolve) => {
      let capTimer = null;
      let pollTimer = null;
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimer(capTimer);
        clearTimer(pollTimer);
        attempt(() => webContents.removeListener('destroyed', onDestroyed));
        resolve(value);
      };
      const onDestroyed = () => finish(true);
      // The event is the fast path; polling covers a build that never emits it.
      const poll = () => {
        if (isDestroyed()) {
          finish(true);
          return;
        }
        pollTimer = setTimer(poll, DESTROY_POLL_MS);
        pollTimer?.unref?.();
      };
      webContents.once('destroyed', onDestroyed);
      capTimer = setTimer(() => finish(isDestroyed()), disposeCapMs);
      capTimer?.unref?.();
      poll();
    });
  }

  function detach() {
    attempt(() => extras.dispose());
    for (const hook of REQUEST_HOOKS) attempt(() => browserSession.webRequest[hook](null));
    attempt(() => browserSession.setPermissionRequestHandler(null));
    attempt(() => browserSession.setPermissionCheckHandler(null));
    attempt(() => browserSession.setDevicePermissionHandler(null));
    for (const [event, handler] of attached) {
      attempt(() => (event.startsWith('session:')
        ? browserSession.removeListener(event.slice('session:'.length), handler)
        : webContents.removeListener(event, handler)));
    }
    attached.length = 0;
    attempt(() => webContents.setWindowOpenHandler(() => ({ action: 'deny' })));
  }

  async function runDispose() {
    detach();
    if (!window.isDestroyed?.()) attempt(() => window.contentView.removeChildView(view));
    attempt(() => webContents.close({ waitForBeforeUnload: false }));
    const destroyedProven = await waitForDestruction();
    try {
      await browserSession.clearStorageData();
    } catch (_error) { /* an in-memory partition leaves nothing behind either way */ }
    if (typeof browserSession.clearCache === 'function') await Promise.resolve(attempt(() => browserSession.clearCache())).catch(noop);
    if (!destroyedProven) log('WARN', 'browser_use.dispose_unproven');
    return destroyedProven;
  }

  function dispose() {
    if (!disposal) {
      disposing = true;
      disposal = runDispose();
    }
    return disposal;
  }

  // Bounded, because with the display asleep a capture can hang as easily as fail.
  function kickFrame() {
    if (disposing || isDestroyed()) return Promise.resolve();
    let timer;
    const capped = new Promise((resolve) => { timer = setTimeout(resolve, KICK_CAP_MS); });
    const kicked = Promise.resolve(attempt(() => webContents.capturePage())).catch(noop);
    return Promise.race([kicked, capped]).finally(() => clearTimeout(timer));
  }

  // Chromium drops clicks and keys, without an error, sent to a view with no frame: one that has never
  // overlapped its window, has just changed site, or sits in a window that stopped painting because the
  // display went to sleep. Moving it onto the window and taking one plain capture there brings it back;
  // nothing synchronous does, and neither does a stayHidden capture. Usually one round, so a click still
  // checks that it arrived. False means this window cannot show the page at all.
  async function armView({ paints } = {}) {
    if (disposing || attempt(() => window.isDestroyed?.())) return false;
    if (attempt(() => window.isMinimized?.()) || attempt(() => window.isVisible?.()) === false) return false;
    if (!parked && await paints?.()) return true;
    const content = attempt(() => window.getContentBounds());
    if (!(content?.width > 0 && content?.height > 0)) return false;
    setBounds(parked ? { ...homeRect, x: content.width - 1, y: content.height - 1 } : { ...homeRect, x: homeRect.x + 1 });
    await new Promise((resolve) => setTimeout(resolve, ARM_HOLD_MS));
    await kickFrame();
    // The panel may have opened or moved meanwhile, and then the page stays where the panel put it.
    // Stop can leave this running with nobody waiting on it, so it must not throw.
    attempt(() => setBounds(homeRect));
    return true;
  }

  async function capture() {
    if (disposing || isDestroyed()) return { ok: false };
    try {
      const image = await webContents.capturePage();
      if (!image || image.isEmpty?.()) return { ok: false };
      const size = image.getSize();
      const jpeg = image.toJPEG(JPEG_QUALITY);
      return { ok: true, data_url: `data:image/jpeg;base64,${jpeg.toString('base64')}`, width: size.width, height: size.height };
    } catch (_error) {
      return { ok: false };
    }
  }

  return {
    view,
    webContents,
    actionContents,
    browserSession,
    getGeneration: () => generation,
    resolveHost: (host) => browserSession.resolveHost(host),
    currentUrl: () => (isDestroyed() ? '' : String(attempt(() => webContents.getURL()) || '')),
    info: () => (isDestroyed()
      ? { url: '', title: '', loading: false }
      : {
        url: String(attempt(() => webContents.getURL()) || ''),
        title: String(attempt(() => webContents.getTitle()) || ''),
        loading: Boolean(attempt(() => webContents.isLoading())),
        failed: failedUrl,
        note,
        pending_url: pendingUrl,
        can_back: Boolean(attempt(() => webContents.navigationHistory.canGoBack())),
        can_forward: Boolean(attempt(() => webContents.navigationHistory.canGoForward())),
        zoom: zoomFactor,
        find: findResult,
        signed_in: signedIn,
        ...extras.info(),
      }),
    place: (bounds) => {
      extras.place();
      parked = false;
      homeRect = { ...bounds };
      setBounds(homeRect);
    },
    offscreen: (size) => {
      // A hidden page must not keep the keyboard: whatever the user types next is for the app.
      if (attempt(() => webContents.isFocused?.())) attempt(() => window.webContents?.focus?.());
      extras.park();
      parked = true;
      homeRect = offscreenRect(size);
      setBounds(homeRect);
    },
    stopLoading: () => { if (!isDestroyed()) attempt(() => webContents.stop()); },
    // Timers only run at full speed for the length of a step, so a parked page is not left working beside the model.
    setStepActive: (active) => { if (!isDestroyed()) attempt(() => webContents.setBackgroundThrottling(active !== true)); },
    setBackground: (color) => { attempt(() => view.setBackgroundColor(color)); },
    loadUrl: (url) => {
      if (disposing || isDestroyed()) return;
      failedUrl = '';
      note = null;
      pendingUrl = url;
      attempt(() => Promise.resolve(webContents.loadURL(url)).catch(noop));
      changed();
    },
    goBack: () => { if (!isDestroyed()) attempt(() => webContents.navigationHistory.goBack()); },
    goForward: () => { if (!isDestroyed()) attempt(() => webContents.navigationHistory.goForward()); },
    reload: () => { if (!isDestroyed()) attempt(() => webContents.reload()); },
    savedPath: () => savedPath,
    zoom,
    findText,
    stopFind,
    armView,
    capture,
    sound: extras.sound,
    toggleSound: extras.toggleSound,
    applyMute: extras.applyMute,
    keepsPageAlive: extras.keepsPageAlive,
    keptSettings: extras.keptSettings,
    setAdBlock: extras.setAdBlock,
    dispose,
    isDisposed: () => disposing,
  };
}

module.exports = { chromeUserAgent, createPageHost };
