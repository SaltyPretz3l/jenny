'use strict';

/**
 * Electron-direct browser session service.
 *
 * The service owns hidden BrowserWindow handles and exposes a small lifecycle
 * surface for browser_open / browser_screenshot / browser_close. Tests inject a
 * BrowserWindow-compatible factory so this module stays runnable in plain Node.
 */

const { parsePngDimensions } = require('./png-metadata-utils');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { classifyBrowserUrlWithRealpathSync } = require('./browser-url-policy');
const {
  DEFAULT_BROWSER_ACTION_TIMEOUT_MS,
  MAX_BROWSER_ACTION_TIMEOUT_MS,
  MAX_EVAL_SCRIPT_LENGTH,
  MAX_TYPE_TEXT_LENGTH,
  boundedPositiveInt,
  buildEvalScript,
  buildSelectorProbeScript,
  normalizeClickButton,
  normalizeSelector,
  safeBrowserReason,
  sanitizePageResult,
} = require('./browser-interaction-utils');

const DEFAULT_MAX_ACTIVE_SESSIONS = 4;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
const MAX_RETAINED_CONSOLE_MESSAGES = 50;
const MAX_RETAINED_PAGE_ERRORS = 50;
const MAX_BROWSER_SESSION_ID_LENGTH = 128;

function _runDependencyProbe() {
  return { available: true, driver: 'electron', version: null };
}

let _cachedDependencyProbe = null;

function _defaultDependencyProbe() {
  if (_cachedDependencyProbe === null) {
    _cachedDependencyProbe = _runDependencyProbe();
  }
  return _cachedDependencyProbe;
}

function _positiveInt(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function _normalizeSessionId(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > MAX_BROWSER_SESSION_ID_LENGTH || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    return '';
  }
  return raw;
}

function _toPngBuffer(captureResult) {
  if (Buffer.isBuffer(captureResult)) {
    return Buffer.from(captureResult);
  }
  if (captureResult && typeof captureResult.toPNG === 'function') {
    const png = captureResult.toPNG();
    return Buffer.isBuffer(png) ? Buffer.from(png) : Buffer.from(png || []);
  }
  return Buffer.from([]);
}

function _abortError() {
  const error = new Error('Browser operation aborted.');
  error.name = 'AbortError';
  return error;
}

function _throwIfAborted(signal) {
  if (signal?.aborted) {
    throw _abortError();
  }
}

function _waitForAbortable(promise, signal) {
  if (!signal || typeof signal.addEventListener !== 'function') {
    return promise;
  }
  _throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(_abortError());
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
  });
}

class BrowserSessionService {
  /**
   * @param {object} options
   * @param {function(object=): object} [options.browserWindowFactory]
   * @param {function(string, string, object=): void} [options.logger]
   * @param {number} [options.maxActiveSessions]
   * @param {number} [options.idleTimeoutMs]
   * @param {number} [options.navigationTimeoutMs]
   */
  constructor(options = {}) {
    this._logger = typeof options.logger === 'function' ? options.logger : () => {};
    this._maxActiveSessions = _positiveInt(
      options.maxActiveSessions,
      DEFAULT_MAX_ACTIVE_SESSIONS
    );
    this._idleTimeoutMs = _positiveInt(options.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS);
    this._navigationTimeoutMs = _positiveInt(
      options.navigationTimeoutMs,
      DEFAULT_NAVIGATION_TIMEOUT_MS
    );
    this._dependencyProbe =
      typeof options.dependencyProbe === 'function'
        ? options.dependencyProbe
        : _defaultDependencyProbe;
    this._browserWindowFactory = typeof options.browserWindowFactory === 'function'
      ? options.browserWindowFactory
      : null;
    this._setTimeout = typeof options.setTimeoutImpl === 'function'
      ? options.setTimeoutImpl
      : setTimeout;
    this._clearTimeout = typeof options.clearTimeoutImpl === 'function'
      ? options.clearTimeoutImpl
      : clearTimeout;
    this._fs = options.fsImpl || fs;
    this._path = options.pathImpl || path;
    this._sessions = new Map();
    this._disposed = false;
  }

  _probe() {
    const probe = { ...this._dependencyProbe() };
    if (this._browserWindowFactory && probe.driver === 'electron') {
      probe.available = true;
    }
    return probe;
  }

  init() {
    if (this._disposed) {
      throw new Error('BrowserSessionService has been disposed');
    }
    const probe = this._probe();
    this._logger('INFO', probe.available ? 'browser.dependency_available' : 'browser.dependency_unavailable', {
      driver: probe.driver || null,
      reason: probe.reason || null,
    });
    return probe;
  }

  describeStatus() {
    const probe = this._probe();
    return {
      kind: 'browser',
      available: probe.available,
      driver: probe.driver,
      active_sessions: this._sessions.size,
      max_active_sessions: this._maxActiveSessions,
      disposed: this._disposed,
    };
  }

  reserveSlot(sessionId) {
    const safeSessionId = _normalizeSessionId(sessionId);
    if (this._disposed) {
      return { ok: false, reason: 'service_disposed' };
    }
    if (!safeSessionId) {
      return { ok: false, reason: 'invalid_session_id' };
    }
    if (this._sessions.size >= this._maxActiveSessions) {
      return { ok: false, reason: 'max_active_sessions' };
    }
    if (this._sessions.has(safeSessionId)) {
      return { ok: false, reason: 'duplicate_session_id' };
    }
    this._sessions.set(safeSessionId, { reservedAt: Date.now(), reserved: true });
    return { ok: true };
  }

  releaseSlot(sessionId) {
    const safeSessionId = _normalizeSessionId(sessionId);
    const session = this._sessions.get(safeSessionId);
    if (session?.idleTimer) {
      this._clearTimeout(session.idleTimer);
    }
    this._sessions.delete(safeSessionId);
  }

  async open({
    sessionId,
    streamId,
    url,
    bounds,
    allowedFileRoots,
    strictWorkspaceOnly = false,
    abortSignal = null,
  } = {}) {
    _throwIfAborted(abortSignal);
    const safeSessionId = _normalizeSessionId(sessionId);
    if (this._disposed) {
      throw new Error('BrowserSessionService has been disposed');
    }
    if (!safeSessionId) {
      throw new Error('A valid browser session id is required.');
    }
    if (!this._browserWindowFactory) {
      throw new Error('Electron BrowserWindow factory is unavailable.');
    }
    if (this._sessions.has(safeSessionId) && !this._sessions.get(safeSessionId)?.reserved) {
      throw new Error(`Browser session "${safeSessionId}" already exists.`);
    }
    if (!this._sessions.has(safeSessionId) && this._sessions.size >= this._maxActiveSessions) {
      throw new Error('Maximum active browser sessions reached.');
    }

    this.releaseSlot(safeSessionId);
    const normalizedAllowedFileRoots = (Array.isArray(allowedFileRoots) ? allowedFileRoots : [])
      .map((root) => String(root || '').trim())
      .filter(Boolean);
    const window = this._browserWindowFactory(this._buildWindowOptions(bounds, safeSessionId));
    const webContents = window?.webContents;
    const session = {
      sessionId: safeSessionId,
      streamId: String(streamId || '').trim(),
      url: String(url || ''),
      allowedFileRoots: normalizedAllowedFileRoots,
      strictWorkspaceOnly: strictWorkspaceOnly === true,
      window,
      webContents,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      consoleMessages: [],
      pageErrors: [],
      idleTimer: null,
      operationTail: Promise.resolve(),
      closing: false,
    };
    this._configureWebContentsSecurity(session);
    this._attachWebContentsObservers(session);
    this._sessions.set(safeSessionId, session);

    try {
      if (session.strictWorkspaceOnly) {
        const policyResult = this._classifyAllowedUrl(session.url, session);
        if (!policyResult.allowed) {
          throw new Error('Strict browser sessions require a contained workspace file URL.');
        }
      }
      await this._loadUrl(session, String(url || ''));
      _throwIfAborted(abortSignal);
      this._touch(session);
      this._logger('INFO', 'browser.session_opened', {
        sessionId: safeSessionId,
        streamId: session.streamId,
      });
      return this._describeSession(session, 'open');
    } catch (error) {
      await this.close(safeSessionId);
      throw error;
    }
  }

  async screenshot(sessionId, options = {}) {
    return this._runSessionOperation(sessionId, options, async (session, signal) => {
      const capturePage = session.webContents?.capturePage || session.window?.capturePage;
      if (typeof capturePage !== 'function') {
        throw new Error('Browser screenshot capture is unavailable.');
      }
      const captureResult = await capturePage.call(session.webContents || session.window, undefined, {
        stayHidden: true,
      });
      _throwIfAborted(signal);
      const buffer = _toPngBuffer(captureResult);
      const dimensions = parsePngDimensions(buffer);
      if (!buffer.length || dimensions.width <= 0 || dimensions.height <= 0) {
        throw new Error('Browser screenshot capture did not return a valid PNG image.');
      }
      let thumbnail = null;
      try {
        if (typeof captureResult?.resize === 'function' && typeof captureResult?.toBitmap === 'function') {
          const resized = captureResult.resize({ width: Math.min(160, dimensions.width) });
          const resizedSize = resized.getSize();
          thumbnail = {
            bitmap: resized.toBitmap(),
            width: resizedSize.width,
            height: resizedSize.height,
          };
        }
      } catch (_error) {
        thumbnail = null;
      }
      return {
        session_id: session.sessionId,
        url: this._currentUrl(session),
        buffer,
        mime_type: 'image/png',
        width: dimensions.width,
        height: dimensions.height,
        thumbnail,
        console_messages: session.consoleMessages.slice(-20),
        page_errors: session.pageErrors.slice(-20),
      };
    });
  }

  async inspect(sessionId) {
    return this._runSessionOperation(sessionId, {}, async (session) => ({
      ...this._describeSession(session, 'inspect'),
      console_messages: session.consoleMessages.slice(-50),
      page_errors: session.pageErrors.slice(-50),
    }));
  }

  async click(sessionId, options = {}) {
    return this._runSessionOperation(sessionId, options, async (session, signal) => {
      const selector = normalizeSelector(options.selector);
    const timeoutMs = boundedPositiveInt(
      options.timeout_ms,
      DEFAULT_BROWSER_ACTION_TIMEOUT_MS,
      MAX_BROWSER_ACTION_TIMEOUT_MS
    );
      const inspected = await this._inspectSelector(session, selector, timeoutMs);
      _throwIfAborted(signal);
    if (inspected.status !== 'ready') {
      return this._browserActionResult(session, inspected.status || 'selector_miss', {
        selector,
        reason: inspected.reason || inspected.status || 'selector_not_ready',
      });
    }
    const sendInputEvent = session.webContents?.sendInputEvent;
    if (typeof sendInputEvent !== 'function') {
      throw new Error('Browser mouse input is unavailable.');
    }
    const centerX = Number(inspected.rect?.center_x);
    const centerY = Number(inspected.rect?.center_y);
    if (!Number.isFinite(centerX) || !Number.isFinite(centerY)) {
      return this._browserActionResult(session, 'selector_hidden', {
        selector,
        reason: 'selector_has_no_clickable_center',
      });
    }
    const button = normalizeClickButton(options.button);
    const clickCount = Math.min(_positiveInt(Number(options.click_count), 1), 3);
    sendInputEvent.call(session.webContents, {
      type: 'mouseMove',
      x: centerX,
      y: centerY,
      button,
    });
    sendInputEvent.call(session.webContents, {
      type: 'mouseDown',
      x: centerX,
      y: centerY,
      button,
      clickCount,
    });
    sendInputEvent.call(session.webContents, {
      type: 'mouseUp',
      x: centerX,
      y: centerY,
      button,
      clickCount,
    });
      return this._browserActionResult(session, 'clicked', { selector });
    });
  }

  async type(sessionId, options = {}) {
    return this._runSessionOperation(sessionId, options, async (session, signal) => {
      const selector = normalizeSelector(options.selector);
    const text = String(options.text ?? '');
    if (text.length > MAX_TYPE_TEXT_LENGTH) {
      throw new Error(`Browser text input exceeds ${MAX_TYPE_TEXT_LENGTH} characters.`);
    }
    const timeoutMs = boundedPositiveInt(
      options.timeout_ms,
      DEFAULT_BROWSER_ACTION_TIMEOUT_MS,
      MAX_BROWSER_ACTION_TIMEOUT_MS
    );
      const focused = await this._focusSelector(session, selector, {
      clear: options.clear === true,
      timeoutMs,
    });
      _throwIfAborted(signal);
      if (focused.status !== 'ready') {
      return this._browserActionResult(session, focused.status || 'selector_miss', {
        selector,
        reason: focused.reason || focused.status || 'selector_not_ready',
      });
    }
    if (typeof session.webContents?.insertText !== 'function') {
      throw new Error('Browser text input is unavailable.');
    }
      await Promise.resolve(session.webContents.insertText(text));
      _throwIfAborted(signal);
    if (options.press_enter === true) {
      const sendInputEvent = session.webContents?.sendInputEvent;
      if (typeof sendInputEvent !== 'function') {
        throw new Error('Browser keyboard input is unavailable.');
      }
      sendInputEvent.call(session.webContents, { type: 'keyDown', keyCode: 'Enter' });
      sendInputEvent.call(session.webContents, { type: 'keyUp', keyCode: 'Enter' });
    }
      return this._browserActionResult(session, 'typed', {
      selector,
      text_length: text.length,
    });
    });
  }

  async eval(sessionId, options = {}) {
    return this._runSessionOperation(sessionId, options, async (session, signal) => {
      const script = String(options.script || '').trim();
    if (!script) {
      throw new Error('A browser eval script is required.');
    }
    if (script.length > MAX_EVAL_SCRIPT_LENGTH) {
      throw new Error(`Browser eval script exceeds ${MAX_EVAL_SCRIPT_LENGTH} characters.`);
    }
    const timeoutMs = boundedPositiveInt(
      options.timeout_ms,
      DEFAULT_BROWSER_ACTION_TIMEOUT_MS,
      MAX_BROWSER_ACTION_TIMEOUT_MS
    );
    const wrappedScript = buildEvalScript(script);
    try {
      const rawResult = await this._executePageScript(
        session,
        wrappedScript,
        timeoutMs,
        'Browser eval timed out.'
      );
      _throwIfAborted(signal);
      const sanitized = sanitizePageResult(rawResult);
      return this._browserActionResult(session, 'evaluated', {
        result: sanitized.value,
        truncated: sanitized.truncated,
      });
    } catch (error) {
      this._logger('WARN', 'browser.eval_failed', {
        sessionId: session.sessionId,
        reason: safeBrowserReason(error && error.message || error, 'eval_failed'),
      });
      return this._browserActionResult(session, 'eval_error', {
        reason: safeBrowserReason(error && error.message || error, 'eval_failed'),
      });
    }
    });
  }

  async close(sessionId) {
    const safeSessionId = _normalizeSessionId(sessionId);
    const session = this._sessions.get(safeSessionId);
    if (!session) {
      return {
        session_id: safeSessionId,
        closed: false,
        reason: safeSessionId ? 'not_found' : 'invalid_session_id',
      };
    }
    if (session.idleTimer) {
      this._clearTimeout(session.idleTimer);
    }
    session.closing = true;
    await Promise.resolve(session.operationTail).catch(() => null);
    try {
      this._clearWebContentsSecurity(session);
      session.webContents?.removeAllListeners?.('console-message');
      session.webContents?.removeAllListeners?.('will-navigate');
      session.webContents?.removeAllListeners?.('will-redirect');
      session.webContents?.removeAllListeners?.('render-process-gone');
      session.webContents?.removeAllListeners?.('did-fail-load');
      if (session.window && typeof session.window.isDestroyed === 'function') {
        if (!session.window.isDestroyed()) {
          this._destroyWindow(session.window);
        }
      } else {
        this._destroyWindow(session.window);
      }
    } catch (error) {
      let fallbackCloseAttempted = false;
      let fallbackCloseFailed = false;
      // A stranded slot is worse than a possibly leaked window.
      // Best-effort close the window, then always return the slot.
      if (session.window && typeof session.window.close === 'function') {
        fallbackCloseAttempted = true;
        try {
          session.window.close();
        } catch {
          fallbackCloseFailed = true;
        }
      }
      this._sessions.delete(safeSessionId);
      this._logger('WARN', 'browser.session_close_cleanup_failed', {
        sessionId: safeSessionId,
        message: String(error && error.message || error),
        slot_released: true,
        fallback_close_attempted: fallbackCloseAttempted,
        ...(fallbackCloseFailed ? { fallback_close_failed: true } : {}),
      });
      return {
        session_id: safeSessionId,
        closed: false,
        reason: 'cleanup_failed',
        slot_released: true,
      };
    }
    this._sessions.delete(safeSessionId);
    this._logger('INFO', 'browser.session_closed', { sessionId: safeSessionId });
    return { session_id: safeSessionId, closed: true };
  }

  async cancelForStream(streamId) {
    const targetStreamId = String(streamId || '').trim();
    if (!targetStreamId) {
      return { closed: 0 };
    }
    const sessionIds = [];
    for (const session of this._sessions.values()) {
      if (session.streamId === targetStreamId) {
        sessionIds.push(session.sessionId);
      }
    }
    await this._closeSessionIds(sessionIds);
    return { closed: sessionIds.length };
  }

  async closeAll(reason = 'close_all') {
    const sessionIds = Array.from(this._sessions.keys());
    await this._closeSessionIds(sessionIds);
    if (sessionIds.length) {
      this._logger('INFO', 'browser.sessions_closed', {
        reason: String(reason || 'close_all'),
        closed: sessionIds.length,
      });
    }
    return { closed: sessionIds.length };
  }

  async dispose() {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    const sessionIds = Array.from(this._sessions.keys());
    await this._closeSessionIds(sessionIds);
    this._sessions.clear();
    this._logger('INFO', 'browser.disposed', {});
  }

  disposeSync() {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    for (const session of this._sessions.values()) {
      if (session.idleTimer) {
        this._clearTimeout(session.idleTimer);
      }
      try {
        this._destroyWindow(session.window);
      } catch (error) {
        this._logger('WARN', 'browser.session_close_cleanup_failed', {
          sessionId: session.sessionId,
          message: String(error && error.message || error),
          sync: true,
        });
      }
    }
    this._sessions.clear();
    this._logger('INFO', 'browser.disposed', { sync: true });
  }

  _buildWindowOptions(bounds = {}, sessionId = '') {
    const width = _positiveInt(Number(bounds.width), 1280);
    const height = _positiveInt(Number(bounds.height), 800);
    const partitionToken = _normalizeSessionId(sessionId).toLowerCase() || 'session';
    const partitionNonce = crypto.randomBytes(4).toString('hex');
    return {
      show: false,
      width,
      height,
      webPreferences: {
        partition: `jenny-browser-tool-${partitionToken}-${partitionNonce}`,
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
        plugins: false,
      },
    };
  }

  _configureWebContentsSecurity(session) {
    const webContents = session.webContents;
    if (!webContents) {
      return;
    }
    if (typeof webContents.setWindowOpenHandler === 'function') {
      webContents.setWindowOpenHandler((details = {}) => {
        const policyResult = this._classifyAllowedUrl(details.url, session);
        this._logger('WARN', 'browser.window_open_denied', {
          sessionId: session.sessionId,
          reason: 'window_open_disabled',
          host: policyResult.policy.host,
          scheme: policyResult.policy.scheme,
        });
        return { action: 'deny' };
      });
    }
    const browserSession = webContents.session;
    if (browserSession && typeof browserSession.setPermissionRequestHandler === 'function') {
      browserSession.setPermissionRequestHandler((_webContents, permission, callback) => {
        this._logger('WARN', 'browser.permission_denied', {
          sessionId: session.sessionId,
          permission: String(permission || '').slice(0, 80),
        });
        callback(false);
      });
    }
    if (browserSession && typeof browserSession.setPermissionCheckHandler === 'function') {
      browserSession.setPermissionCheckHandler(() => false);
    }
    if (browserSession && typeof browserSession.setDevicePermissionHandler === 'function') {
      browserSession.setDevicePermissionHandler(() => false);
    }
    if (browserSession?.webRequest && typeof browserSession.webRequest.onBeforeRequest === 'function') {
      browserSession.webRequest.onBeforeRequest((details, callback) => {
        const policyResult = this._classifyAllowedUrl(details?.url, session);
        if (!policyResult.allowed) {
          this._logger('WARN', 'browser.request_blocked', {
            sessionId: session.sessionId,
            reason: policyResult.policy.reason,
            host: policyResult.policy.host,
            scheme: policyResult.policy.scheme,
            resourceType: String(details?.resourceType || '').slice(0, 80),
          });
          callback({ cancel: true });
          return;
        }
        callback({});
      });
    }
    webContents.on?.('will-navigate', (event, nextUrl) => {
      this._preventDisallowedNavigation(event, nextUrl, session, 'will_navigate');
    });
    webContents.on?.('will-redirect', (event, nextUrl) => {
      this._preventDisallowedNavigation(event, nextUrl, session, 'will_redirect');
    });
  }

  _clearWebContentsSecurity(session) {
    const browserSession = session.webContents?.session;
    try {
      browserSession?.webRequest?.onBeforeRequest?.(null);
    } catch (_) {
      // Best-effort cleanup; the owning in-memory partition is session-scoped.
    }
    try {
      browserSession?.setPermissionRequestHandler?.(null);
      browserSession?.setPermissionCheckHandler?.(null);
      browserSession?.setDevicePermissionHandler?.(null);
    } catch (_) {
      // Best-effort cleanup.
    }
  }

  _preventDisallowedNavigation(event, nextUrl, session, source) {
    const policyResult = this._classifyAllowedUrl(nextUrl, session);
    if (policyResult.allowed) {
      return;
    }
    event?.preventDefault?.();
    this._logger('WARN', 'browser.navigation_blocked', {
      sessionId: session.sessionId,
      source,
      reason: policyResult.policy.reason,
      host: policyResult.policy.host,
      scheme: policyResult.policy.scheme,
    });
  }

  _classifyAllowedUrl(rawUrl, session) {
    const policy = classifyBrowserUrlWithRealpathSync(rawUrl, {
      allowedFileRoots: session.allowedFileRoots,
      fsImpl: this._fs,
      pathImpl: this._path,
    });
    const allowed = policy.decision === 'allow'
      && (!session.strictWorkspaceOnly || policy.reason === 'workspace_file_url');
    return { allowed, policy };
  }

  _attachWebContentsObservers(session) {
    const webContents = session.webContents;
    if (!webContents || typeof webContents.on !== 'function') {
      return;
    }
    webContents.on('console-message', (_event, level, message, line, sourceId) => {
      session.consoleMessages.push({
        level: Number(level || 0) || 0,
        message: String(message || '').slice(0, 500),
        line: Number(line || 0) || 0,
        source_id: String(sourceId || '').slice(0, 200),
      });
      if (session.consoleMessages.length > MAX_RETAINED_CONSOLE_MESSAGES) {
        session.consoleMessages.splice(0, session.consoleMessages.length - MAX_RETAINED_CONSOLE_MESSAGES);
      }
    });
    webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      this._pushPageError(session, {
        code: Number(errorCode || 0) || 0,
        message: String(errorDescription || '').slice(0, 500),
      });
    });
    webContents.on('render-process-gone', (_event, details) => {
      this._pushPageError(session, {
        code: 0,
        message: `render_process_gone:${String(details?.reason || 'unknown')}`,
      });
    });
  }

  _pushPageError(session, entry) {
    session.pageErrors.push(entry);
    if (session.pageErrors.length > MAX_RETAINED_PAGE_ERRORS) {
      session.pageErrors.splice(0, session.pageErrors.length - MAX_RETAINED_PAGE_ERRORS);
    }
  }

  async _inspectSelector(session, selector, timeoutMs) {
    try {
      return await this._executePageScript(
        session,
        buildSelectorProbeScript(selector, { focus: false, clear: false }),
        timeoutMs,
        'Browser selector lookup timed out.'
      );
    } catch (error) {
      this._logger('WARN', 'browser.selector_probe_failed', {
        sessionId: session.sessionId,
        reason: safeBrowserReason(error && error.message || error, 'selector_probe_failed'),
      });
      return {
        status: 'selector_timeout',
        selector,
        reason: 'selector_probe_failed',
      };
    }
  }

  async _focusSelector(session, selector, { clear = false, timeoutMs } = {}) {
    try {
      return await this._executePageScript(
        session,
        buildSelectorProbeScript(selector, { focus: true, clear }),
        timeoutMs,
        'Browser selector focus timed out.'
      );
    } catch (error) {
      this._logger('WARN', 'browser.selector_focus_failed', {
        sessionId: session.sessionId,
        reason: safeBrowserReason(error && error.message || error, 'selector_focus_failed'),
      });
      return {
        status: 'selector_timeout',
        selector,
        reason: 'selector_focus_failed',
      };
    }
  }

  async _executePageScript(session, script, timeoutMs, timeoutMessage) {
    const executeJavaScript = session.webContents?.executeJavaScript;
    if (typeof executeJavaScript !== 'function') {
      throw new Error('Browser page JavaScript execution is unavailable.');
    }
    return this._withTimeout(
      Promise.resolve(executeJavaScript.call(session.webContents, script, false)),
      timeoutMs,
      timeoutMessage
    );
  }

  _browserActionResult(session, status, extra = {}) {
    return {
      session_id: session.sessionId,
      url: this._currentUrl(session),
      status,
      ...extra,
      console_messages: session.consoleMessages.slice(-20),
      page_errors: session.pageErrors.slice(-20),
    };
  }

  async _loadUrl(session, url) {
    const loadTarget = session.webContents?.loadURL || session.window?.loadURL;
    if (typeof loadTarget !== 'function') {
      throw new Error('Browser navigation is unavailable.');
    }
    const navigation = Promise.resolve(loadTarget.call(session.webContents || session.window, url));
    await this._withTimeout(navigation, this._navigationTimeoutMs, 'Browser navigation timed out.');
  }

  _withTimeout(promise, timeoutMs, message) {
    let timer = null;
    return Promise.race([
      promise.finally(() => {
        if (timer) {
          this._clearTimeout(timer);
        }
      }),
      new Promise((_, reject) => {
        timer = this._setTimeout(() => reject(new Error(message)), timeoutMs);
        if (timer && typeof timer.unref === 'function') {
          timer.unref();
        }
      }),
    ]);
  }

  _requireSession(sessionId) {
    const safeSessionId = _normalizeSessionId(sessionId);
    const session = this._sessions.get(safeSessionId);
    if (!session || session.reserved || session.closing) {
      throw new Error(`Browser session "${safeSessionId}" is not open.`);
    }
    return session;
  }

  async _runSessionOperation(sessionId, options, operation) {
    const session = this._requireSession(sessionId);
    const signal = options?.abortSignal || options?.signal || null;
    _throwIfAborted(signal);
    const previous = Promise.resolve(session.operationTail).catch(() => null);
    let releaseCurrent;
    const current = new Promise((resolve) => {
      releaseCurrent = resolve;
    });
    session.operationTail = previous.then(() => current);
    try {
      await _waitForAbortable(previous, signal);
    } catch (error) {
      releaseCurrent();
      throw error;
    }
    if (session.closing || this._sessions.get(session.sessionId) !== session) {
      releaseCurrent();
      throw new Error(`Browser session "${session.sessionId}" is not open.`);
    }
    if (session.idleTimer) {
      this._clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    try {
      _throwIfAborted(signal);
      const result = await operation(session, signal);
      _throwIfAborted(signal);
      return result;
    } finally {
      releaseCurrent();
      if (!session.closing && this._sessions.get(session.sessionId) === session) {
        this._touch(session);
      }
    }
  }

  _touch(session) {
    session.lastUsedAt = Date.now();
    if (session.idleTimer) {
      this._clearTimeout(session.idleTimer);
    }
    session.idleTimer = this._setTimeout(
      () => this.close(session.sessionId).catch(() => null),
      this._idleTimeoutMs
    );
    if (session.idleTimer && typeof session.idleTimer.unref === 'function') {
      session.idleTimer.unref();
    }
  }

  _currentUrl(session) {
    const current = typeof session.webContents?.getURL === 'function'
      ? session.webContents.getURL()
      : '';
    return String(current || session.url || '').trim();
  }

  _describeSession(session, status) {
    return {
      session_id: session.sessionId,
      stream_id: session.streamId,
      url: this._currentUrl(session),
      status,
      created_at: new Date(session.createdAt).toISOString(),
      last_used_at: new Date(session.lastUsedAt).toISOString(),
    };
  }

  async _closeSessionIds(sessionIds) {
    await Promise.all(sessionIds.map((id) => this.close(id).catch(() => null)));
  }

  _destroyWindow(window) {
    if (!window) {
      return;
    }
    if (typeof window.destroy === 'function') {
      window.destroy();
      return;
    }
    if (typeof window.close === 'function') {
      window.close();
    }
  }
}

module.exports = {
  BrowserSessionService,
};
