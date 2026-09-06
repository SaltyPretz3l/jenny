'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const { BrowserSessionService } = require('../services/browser-session-service');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function makePngBuffer(width = 2, height = 3) {
  const header = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52,
  ]);
  const dimensions = Buffer.alloc(8);
  dimensions.writeUInt32BE(width, 0);
  dimensions.writeUInt32BE(height, 4);
  return Buffer.concat([
    header,
    dimensions,
    Buffer.from([
      0x08, 0x06, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x49, 0x45, 0x4e, 0x44,
      0x00, 0x00, 0x00, 0x00,
    ]),
  ]);
}

function createFakeBrowserWindowFactory({
  screenshotBuffer = makePngBuffer(),
  captureResultFactory = null,
  scriptResults = [],
  scriptHandler = null,
} = {}) {
  const windows = [];
  const factory = (options = {}) => {
    const listeners = new Map();
    const browserSession = {
      permissionRequestHandler: undefined,
      permissionCheckHandler: undefined,
      devicePermissionHandler: undefined,
      webRequest: {
        beforeRequestListener: undefined,
        onBeforeRequest(listener) {
          this.beforeRequestListener = listener || undefined;
        },
      },
      setPermissionRequestHandler(handler) {
        this.permissionRequestHandler = handler || undefined;
      },
      setPermissionCheckHandler(handler) {
        this.permissionCheckHandler = handler || undefined;
      },
      setDevicePermissionHandler(handler) {
        this.devicePermissionHandler = handler || undefined;
      },
    };
    const window = {
      options,
      loadedUrl: '',
      destroyed: false,
      windowOpenHandler: null,
      captureArgs: null,
      executedScripts: [],
      executedScriptArgs: [],
      inputEvents: [],
      insertedText: [],
      browserSession,
      emit(eventName, ...args) {
        const handlers = listeners.get(eventName) || [];
        for (const handler of handlers) {
          handler(...args);
        }
      },
      webContents: {
        session: browserSession,
        on(eventName, handler) {
          if (!listeners.has(eventName)) listeners.set(eventName, []);
          listeners.get(eventName).push(handler);
        },
        removeAllListeners(eventName) {
          if (eventName) listeners.delete(eventName);
          else listeners.clear();
        },
        setWindowOpenHandler(handler) {
          window.windowOpenHandler = handler;
        },
        async loadURL(url) {
          window.loadedUrl = url;
        },
        getURL() {
          return window.loadedUrl;
        },
        async capturePage(...args) {
          window.captureArgs = args;
          if (typeof captureResultFactory === 'function') {
            return captureResultFactory(window);
          }
          return {
            toPNG() {
              return Buffer.from(screenshotBuffer);
            },
          };
        },
        async executeJavaScript(...args) {
          const [script] = args;
          window.executedScripts.push(script);
          window.executedScriptArgs.push(args);
          if (typeof scriptHandler === 'function') {
            return scriptHandler(script, window);
          }
          return scriptResults.shift();
        },
        sendInputEvent(event) {
          window.inputEvents.push(event);
        },
        async insertText(text) {
          window.insertedText.push(text);
        },
      },
      isDestroyed() {
        return this.destroyed;
      },
      destroy() {
        this.destroyed = true;
      },
    };
    windows.push(window);
    return window;
  };
  factory.windows = windows;
  return factory;
}

describe('BrowserSessionService / lifecycle', () => {
  test('init returns the dependency probe and does not throw', () => {
    const service = new BrowserSessionService({
      browserWindowFactory: createFakeBrowserWindowFactory(),
    });
    const probe = service.init();
    assert.equal(probe.available, true);
    assert.equal(probe.driver, 'electron');
  });

  test('describeStatus reports zero active sessions on a fresh service', () => {
    const service = new BrowserSessionService({
      browserWindowFactory: createFakeBrowserWindowFactory(),
    });
    const status = service.describeStatus();
    assert.equal(status.kind, 'browser');
    assert.equal(status.active_sessions, 0);
    assert.equal(status.disposed, false);
  });

  test('reserveSlot caps at maxActiveSessions', () => {
    const service = new BrowserSessionService({ maxActiveSessions: 2 });
    assert.equal(service.reserveSlot('a').ok, true);
    assert.equal(service.reserveSlot('b').ok, true);
    const third = service.reserveSlot('c');
    assert.equal(third.ok, false);
    assert.equal(third.reason, 'max_active_sessions');
  });

  test('reserveSlot rejects duplicate session IDs', () => {
    const service = new BrowserSessionService();
    assert.equal(service.reserveSlot('s1').ok, true);
    const dup = service.reserveSlot('s1');
    assert.equal(dup.ok, false);
    assert.equal(dup.reason, 'duplicate_session_id');
  });

  test('releaseSlot frees capacity for new reservations', () => {
    const service = new BrowserSessionService({ maxActiveSessions: 1 });
    assert.equal(service.reserveSlot('a').ok, true);
    assert.equal(service.reserveSlot('b').ok, false);
    service.releaseSlot('a');
    assert.equal(service.reserveSlot('b').ok, true);
  });

  test('dispose marks the service unusable and clears sessions', async () => {
    const service = new BrowserSessionService({
      browserWindowFactory: createFakeBrowserWindowFactory(),
    });
    service.reserveSlot('s1');
    await service.dispose();
    assert.equal(service.describeStatus().disposed, true);
    assert.equal(service.describeStatus().active_sessions, 0);
    const result = service.reserveSlot('after_dispose');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'service_disposed');
  });

  test('logger receives lifecycle events', async () => {
    const events = [];
    const service = new BrowserSessionService({
      browserWindowFactory: createFakeBrowserWindowFactory(),
      logger: (level, event, details) => events.push({ level, event, details }),
    });
    service.init();
    await service.dispose();
    const eventNames = events.map((e) => e.event);
    assert.ok(eventNames.includes('browser.dependency_available'));
    assert.ok(eventNames.includes('browser.disposed'));
  });
});

describe('BrowserSessionService / Electron-direct sessions', () => {
  test('open creates a hidden Electron session and screenshot returns a PNG buffer with dimensions', async () => {
    const factory = createFakeBrowserWindowFactory({ screenshotBuffer: makePngBuffer(4, 5) });
    const service = new BrowserSessionService({ browserWindowFactory: factory });

    const opened = await service.open({
      sessionId: 'browser_1',
      streamId: 'stream_1',
      url: 'http://localhost:3000/fixture',
    });
    assert.equal(opened.session_id, 'browser_1');
    assert.equal(opened.status, 'open');
    assert.equal(factory.windows.length, 1);
    assert.equal(factory.windows[0].options.show, false);
    assert.equal(factory.windows[0].loadedUrl, 'http://localhost:3000/fixture');

    const screenshot = await service.screenshot('browser_1');
    assert.equal(Buffer.isBuffer(screenshot.buffer), true);
    assert.equal(screenshot.mime_type, 'image/png');
    assert.equal(screenshot.width, 4);
    assert.equal(screenshot.height, 5);
    assert.equal(screenshot.thumbnail, null);
    assert.equal(screenshot.url, 'http://localhost:3000/fixture');
    assert.equal(factory.windows[0].captureArgs[1].stayHidden, true);
    assert.equal(factory.windows[0].options.webPreferences.partition.startsWith('jenny-browser-tool-browser_1-'), true);
    assert.equal(factory.windows[0].options.webPreferences.devTools, false);
    assert.equal(factory.windows[0].options.webPreferences.webviewTag, false);
    assert.equal(factory.windows[0].options.webPreferences.sandbox, true);
  });

  test('screenshot returns a bitmap thumbnail from a resizable capture result', async () => {
    const bitmap = Buffer.alloc(160 * 100 * 4, 42);
    const factory = createFakeBrowserWindowFactory({
      screenshotBuffer: makePngBuffer(320, 200),
      captureResultFactory() {
        return {
          toPNG: () => makePngBuffer(320, 200),
          toBitmap: () => Buffer.alloc(320 * 200 * 4),
          resize(options) {
            assert.deepEqual(options, { width: 160 });
            return {
              getSize: () => ({ width: 160, height: 100 }),
              toBitmap: () => bitmap,
            };
          },
        };
      },
    });
    const service = new BrowserSessionService({ browserWindowFactory: factory });
    await service.open({
      sessionId: 'browser_thumbnail',
      streamId: 'stream_thumbnail',
      url: 'http://localhost:3000/fixture',
    });

    const screenshot = await service.screenshot('browser_thumbnail');

    assert.equal(screenshot.thumbnail.bitmap, bitmap);
    assert.equal(screenshot.thumbnail.width, 160);
    assert.equal(screenshot.thumbnail.height, 100);
    assert.equal(screenshot.width, 320);
    assert.equal(screenshot.height, 200);
    assert.equal(screenshot.mime_type, 'image/png');
  });

  test('blocks external navigations, popups, and subresource requests', async () => {
    const factory = createFakeBrowserWindowFactory();
    const events = [];
    const service = new BrowserSessionService({
      browserWindowFactory: factory,
      logger: (level, event, details) => events.push({ level, event, details }),
    });
    await service.open({
      sessionId: 'browser_guard',
      streamId: 'stream_guard',
      url: 'http://localhost:3000/guard',
    });

    let prevented = false;
    factory.windows[0].emit(
      'will-navigate',
      { preventDefault() { prevented = true; } },
      'https://example.com/'
    );
    assert.equal(prevented, true);
    assert.equal(events.some((entry) => entry.event === 'browser.navigation_blocked'), true);

    const popup = factory.windows[0].windowOpenHandler({ url: 'http://localhost:3000/popup' });
    assert.deepEqual(popup, { action: 'deny' });
    assert.equal(events.some((entry) => entry.event === 'browser.window_open_denied'), true);

    let externalResponse = null;
    factory.windows[0].browserSession.webRequest.beforeRequestListener(
      { url: 'https://example.com/script.js', resourceType: 'script' },
      (response) => { externalResponse = response; }
    );
    assert.deepEqual(externalResponse, { cancel: true });

    let loopbackResponse = null;
    factory.windows[0].browserSession.webRequest.beforeRequestListener(
      { url: 'http://127.0.0.1:3000/app.css', resourceType: 'stylesheet' },
      (response) => { loopbackResponse = response; }
    );
    assert.deepEqual(loopbackResponse, {});
  });

  test('allows file requests whose real path stays inside the allowed root', async () => {
    const workspaceRoot = createTrackedTempDir('jenny-browser-session-');
    const outsideRoot = createTrackedTempDir('jenny-browser-session-link-');
    const linkPath = path.join(outsideRoot, 'linked-workspace');
    const fixturePath = path.join(workspaceRoot, 'fixture.html');
    fs.writeFileSync(fixturePath, '<h1>local</h1>', 'utf8');
    fs.symlinkSync(
      workspaceRoot,
      linkPath,
      process.platform === 'win32' ? 'junction' : 'dir'
    );

    const factory = createFakeBrowserWindowFactory();
    const service = new BrowserSessionService({ browserWindowFactory: factory });
    await service.open({
      sessionId: 'browser_file_guard',
      streamId: 'stream_file_guard',
      url: 'http://localhost:3000/guard',
      allowedFileRoots: [workspaceRoot],
    });

    let response = null;
    factory.windows[0].browserSession.webRequest.beforeRequestListener(
      { url: pathToFileURL(path.join(linkPath, 'fixture.html')).toString(), resourceType: 'image' },
      (value) => { response = value; }
    );

    assert.deepEqual(response, {});
  });

  test('rejects invalid screenshot PNG buffers before artifact creation', async () => {
    const factory = createFakeBrowserWindowFactory({ screenshotBuffer: Buffer.from('not-a-png') });
    const service = new BrowserSessionService({ browserWindowFactory: factory });
    await service.open({ sessionId: 'browser_bad_png', streamId: 'stream_png', url: 'http://localhost:3000/' });

    await assert.rejects(
      () => service.screenshot('browser_bad_png'),
      /valid PNG/i
    );
  });

  test('click waits for a visible selector and dispatches a centered mouse click', async () => {
    const factory = createFakeBrowserWindowFactory({
      scriptHandler() {
        return {
          status: 'ready',
          selector: '#submit',
          rect: { center_x: 42, center_y: 24, width: 80, height: 20 },
        };
      },
    });
    const service = new BrowserSessionService({ browserWindowFactory: factory });
    await service.open({ sessionId: 'browser_click', streamId: 'stream_click', url: 'http://localhost:3000/' });

    const result = await service.click('browser_click', {
      selector: '#submit',
      timeout_ms: 50,
      button: 'left',
      click_count: 2,
    });

    assert.equal(result.session_id, 'browser_click');
    assert.equal(result.status, 'clicked');
    assert.equal(result.selector, '#submit');
    assert.equal(result.url, 'http://localhost:3000/');
    assert.deepEqual(
      factory.windows[0].inputEvents.map((event) => event.type),
      ['mouseMove', 'mouseDown', 'mouseUp']
    );
    assert.equal(factory.windows[0].inputEvents[1].x, 42);
    assert.equal(factory.windows[0].inputEvents[1].y, 24);
    assert.equal(factory.windows[0].inputEvents[1].button, 'left');
    assert.equal(factory.windows[0].inputEvents[1].clickCount, 2);
  });

  test('click returns a structured selector miss without dispatching input', async () => {
    const factory = createFakeBrowserWindowFactory({
      scriptHandler() {
        return {
          status: 'selector_miss',
          selector: '#missing',
          reason: 'selector_not_found',
        };
      },
    });
    const service = new BrowserSessionService({ browserWindowFactory: factory });
    await service.open({ sessionId: 'browser_click_miss', streamId: 'stream_click', url: 'http://localhost:3000/' });

    const result = await service.click('browser_click_miss', {
      selector: '#missing',
      timeout_ms: 50,
    });

    assert.equal(result.status, 'selector_miss');
    assert.equal(result.selector, '#missing');
    assert.equal(result.reason, 'selector_not_found');
    assert.deepEqual(factory.windows[0].inputEvents, []);
  });

  test('type focuses a selector, redacts typed text from the result, and can press enter', async () => {
    const typedText = 'private phrase 123';
    const factory = createFakeBrowserWindowFactory({
      scriptHandler() {
        return {
          status: 'ready',
          selector: '#name',
          rect: { center_x: 10, center_y: 10, width: 40, height: 12 },
        };
      },
    });
    const service = new BrowserSessionService({ browserWindowFactory: factory });
    await service.open({ sessionId: 'browser_type', streamId: 'stream_type', url: 'http://localhost:3000/form' });

    const result = await service.type('browser_type', {
      selector: '#name',
      text: typedText,
      clear: true,
      press_enter: true,
      timeout_ms: 50,
    });

    assert.equal(result.status, 'typed');
    assert.equal(result.selector, '#name');
    assert.equal(result.text_length, typedText.length);
    assert.deepEqual(factory.windows[0].insertedText, [typedText]);
    assert.deepEqual(
      factory.windows[0].inputEvents.map((event) => `${event.type}:${event.keyCode || ''}`),
      ['keyDown:Enter', 'keyUp:Enter']
    );
    assert.match(factory.windows[0].executedScripts.at(-1), /selector_not_editable/);
    assert.match(factory.windows[0].executedScripts.at(-1), /document\.activeElement !== element/);
    assert.doesNotMatch(JSON.stringify(result), /private phrase 123/);
  });

  test('eval redacts sensitive keys and caps oversized page results', async () => {
    const factory = createFakeBrowserWindowFactory({
      scriptHandler() {
        return {
          ok: true,
          token: 'secret-token-value',
          nested: { password: 'secret-password' },
          long_value: 'x'.repeat(50_000),
        };
      },
    });
    const service = new BrowserSessionService({ browserWindowFactory: factory });
    await service.open({ sessionId: 'browser_eval', streamId: 'stream_eval', url: 'http://localhost:3000/state' });

    const result = await service.eval('browser_eval', {
      script: 'return window.__fixtureState;',
      timeout_ms: 50,
    });

    assert.equal(result.status, 'evaluated');
    assert.equal(result.session_id, 'browser_eval');
    assert.equal(result.result.ok, true);
    assert.equal(result.result.token, '[redacted]');
    assert.equal(result.result.nested.password, '[redacted]');
    assert.equal(result.truncated, true);
    assert.ok(JSON.stringify(result.result).length < 25_000);
    assert.doesNotMatch(JSON.stringify(result), /secret-token-value/);
    assert.doesNotMatch(JSON.stringify(result), /secret-password/);
  });

  test('page scripts execute without synthetic user-gesture privileges', async () => {
    const factory = createFakeBrowserWindowFactory({
      scriptHandler() {
        return { ok: true };
      },
    });
    const service = new BrowserSessionService({ browserWindowFactory: factory });
    await service.open({ sessionId: 'browser_eval_gesture', streamId: 'stream_eval', url: 'http://localhost:3000/state' });

    await service.eval('browser_eval_gesture', {
      script: 'return { ok: true };',
      timeout_ms: 50,
    });

    assert.ok(factory.windows[0].executedScriptArgs.length >= 1);
    assert.equal(factory.windows[0].executedScriptArgs.every((args) => args[1] !== true), true);
  });

  test('caps retained page errors from failing pages', async () => {
    const factory = createFakeBrowserWindowFactory();
    const service = new BrowserSessionService({ browserWindowFactory: factory });
    await service.open({ sessionId: 'browser_errors', streamId: 'stream_errors', url: 'http://localhost:3000/' });

    for (let index = 0; index < 60; index += 1) {
      factory.windows[0].emit('did-fail-load', {}, index, `failure ${index}`);
    }

    const retained = service._sessions.get('browser_errors').pageErrors;
    assert.equal(retained.length, 50);
    assert.equal(retained[0].message, 'failure 10');
  });

  test('cancelForStream closes every session owned by the stream', async () => {
    const factory = createFakeBrowserWindowFactory();
    const service = new BrowserSessionService({ browserWindowFactory: factory });
    await service.open({ sessionId: 'browser_a', streamId: 'stream_a', url: 'http://localhost:3000/a' });
    await service.open({ sessionId: 'browser_b', streamId: 'stream_b', url: 'http://localhost:3000/b' });

    const result = await service.cancelForStream('stream_a');

    assert.equal(result.closed, 1);
    assert.equal(service.describeStatus().active_sessions, 1);
    assert.equal(factory.windows[0].destroyed, true);
    assert.equal(factory.windows[1].destroyed, false);
  });

  test('closeAll closes every active browser session without disposing the service', async () => {
    const factory = createFakeBrowserWindowFactory();
    const service = new BrowserSessionService({ browserWindowFactory: factory });
    await service.open({ sessionId: 'browser_a', streamId: 'stream_a', url: 'http://localhost:3000/a' });
    await service.open({ sessionId: 'browser_b', streamId: 'stream_b', url: 'http://localhost:3000/b' });

    const result = await service.closeAll('test_cleanup');

    assert.equal(result.closed, 2);
    assert.equal(service.describeStatus().active_sessions, 0);
    assert.equal(service.describeStatus().disposed, false);
    assert.equal(factory.windows[0].destroyed, true);
    assert.equal(factory.windows[1].destroyed, true);
  });

  test('close reports failure but releases the slot when window teardown fails', async () => {
    const factory = createFakeBrowserWindowFactory();
    const events = [];
    let fallbackCloseCalls = 0;
    const service = new BrowserSessionService({
      browserWindowFactory: factory,
      maxActiveSessions: 1,
      logger: (level, event, details) => events.push({ level, event, details }),
    });
    await service.open({ sessionId: 'browser_close_error', streamId: 'stream_close_error', url: 'http://localhost:3000/' });
    factory.windows[0].destroy = () => {
      throw new Error('destroy failed');
    };
    factory.windows[0].close = () => {
      fallbackCloseCalls += 1;
    };

    const result = await service.close('browser_close_error');

    assert.equal(result.closed, false);
    assert.equal(result.reason, 'cleanup_failed');
    assert.equal(result.slot_released, true);
    assert.equal(fallbackCloseCalls, 1);
    assert.equal(service.describeStatus().active_sessions, 0);
    const warning = events.find((entry) => entry.event === 'browser.session_close_cleanup_failed');
    assert.equal(warning.level, 'WARN');
    assert.equal(warning.details.slot_released, true);

    const opened = await service.open({
      sessionId: 'browser_after_failed_close',
      streamId: 'stream_x',
      url: 'http://localhost:3000/',
    });
    assert.equal(opened.status, 'open');
  });

  test('close releases the slot when primary and fallback window teardown fail', async () => {
    const factory = createFakeBrowserWindowFactory();
    const events = [];
    const service = new BrowserSessionService({
      browserWindowFactory: factory,
      logger: (level, event, details) => events.push({ level, event, details }),
    });
    await service.open({ sessionId: 'browser_close_errors', streamId: 'stream_close_errors', url: 'http://localhost:3000/' });
    factory.windows[0].destroy = () => {
      throw new Error('destroy failed');
    };
    factory.windows[0].close = () => {
      throw new Error('close failed');
    };

    const result = await service.close('browser_close_errors');

    assert.equal(result.closed, false);
    assert.equal(result.reason, 'cleanup_failed');
    assert.equal(result.slot_released, true);
    assert.equal(service.describeStatus().active_sessions, 0);
    const warning = events.find((entry) => entry.event === 'browser.session_close_cleanup_failed');
    assert.equal(warning.level, 'WARN');
    assert.equal(warning.details.slot_released, true);
    assert.equal(warning.details.fallback_close_failed, true);
  });

  test('close rejects malformed session ids instead of reporting an idempotent miss', async () => {
    const service = new BrowserSessionService({
      browserWindowFactory: createFakeBrowserWindowFactory(),
    });

    const result = await service.close('!!!');

    assert.deepEqual(result, {
      session_id: '',
      closed: false,
      reason: 'invalid_session_id',
    });
  });

  test('idle timeout closes inactive sessions', async () => {
    const factory = createFakeBrowserWindowFactory();
    const timers = [];
    const service = new BrowserSessionService({
      browserWindowFactory: factory,
      idleTimeoutMs: 100,
      setTimeoutImpl(handler) {
        timers.push(handler);
        return handler;
      },
      clearTimeoutImpl() {},
    });
    await service.open({ sessionId: 'browser_idle', streamId: 'stream_idle', url: 'http://localhost:3000/idle' });

    await timers[timers.length - 1]();

    assert.equal(service.describeStatus().active_sessions, 0);
    assert.equal(factory.windows[0].destroyed, true);
  });

  test('serializes operations and does not arm idle close while one is active', async () => {
    let releaseFirst;
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const timers = [];
    const factory = createFakeBrowserWindowFactory({
      async scriptHandler() {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (calls === 1) {
          await new Promise((resolve) => { releaseFirst = resolve; });
        }
        active -= 1;
        return { call: calls };
      },
    });
    const service = new BrowserSessionService({
      browserWindowFactory: factory,
      idleTimeoutMs: 100,
      setTimeoutImpl(handler, timeoutMs) {
        timers.push({ handler, timeoutMs });
        return handler;
      },
      clearTimeoutImpl() {},
    });
    await service.open({ sessionId: 'browser_serial', streamId: 'stream_serial', url: 'http://localhost:3000/' });
    const first = service.eval('browser_serial', { script: 'return 1;', timeout_ms: 1000 });
    const second = service.eval('browser_serial', { script: 'return 2;', timeout_ms: 1000 });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(calls, 1);
    assert.equal(timers.filter((timer) => timer.timeoutMs === 100).length, 1);
    releaseFirst();
    await Promise.all([first, second]);

    assert.equal(maxActive, 1);
    assert.equal(calls, 2);
    assert.equal(timers.filter((timer) => timer.timeoutMs === 100).length, 3);
  });

  test('aborts a queued operation before it can mutate the page', async () => {
    let releaseFirst;
    let calls = 0;
    const factory = createFakeBrowserWindowFactory({
      async scriptHandler() {
        calls += 1;
        if (calls === 1) {
          await new Promise((resolve) => { releaseFirst = resolve; });
        }
        return { call: calls };
      },
    });
    const service = new BrowserSessionService({ browserWindowFactory: factory });
    await service.open({
      sessionId: 'browser_abort_queue',
      streamId: 'stream_abort_queue',
      url: 'http://localhost:3000/',
    });
    const first = service.eval('browser_abort_queue', { script: 'return 1;' });
    const controller = new AbortController();
    const queued = service.eval('browser_abort_queue', {
      script: 'return 2;',
      abortSignal: controller.signal,
    });
    await new Promise((resolve) => setImmediate(resolve));

    controller.abort();
    await assert.rejects(queued, /aborted/i);
    assert.equal(calls, 1);
    releaseFirst();
    await first;
    assert.equal(calls, 1);
  });

  test('releases the session queue after an aborted queued operation', { timeout: 1000 }, async () => {
    let releaseFirst;
    let calls = 0;
    const factory = createFakeBrowserWindowFactory({
      async scriptHandler() {
        calls += 1;
        if (calls === 1) {
          await new Promise((resolve) => { releaseFirst = resolve; });
        }
        return { call: calls };
      },
    });
    const service = new BrowserSessionService({ browserWindowFactory: factory });
    await service.open({
      sessionId: 'browser_abort_queue_release',
      streamId: 'stream_abort_queue_release',
      url: 'http://localhost:3000/',
    });
    const first = service.eval('browser_abort_queue_release', { script: 'return 1;' });
    const controller = new AbortController();
    const queued = service.eval('browser_abort_queue_release', {
      script: 'return 2;',
      abortSignal: controller.signal,
    });
    await new Promise((resolve) => setImmediate(resolve));

    controller.abort();
    await assert.rejects(queued, /aborted/i);
    const third = service.eval('browser_abort_queue_release', { script: 'return 3;' });
    releaseFirst();
    await first;

    const thirdResult = await third;
    assert.equal(thirdResult.status, 'evaluated');
    assert.equal(thirdResult.result.call, 2);
    assert.deepEqual(await service.close('browser_abort_queue_release'), {
      session_id: 'browser_abort_queue_release',
      closed: true,
    });
  });

  test('dispose destroys active windows and prevents new sessions', async () => {
    const factory = createFakeBrowserWindowFactory();
    const service = new BrowserSessionService({ browserWindowFactory: factory });
    await service.open({ sessionId: 'browser_dispose', streamId: 'stream_dispose', url: 'http://localhost:3000/' });

    await service.dispose();

    assert.equal(service.describeStatus().disposed, true);
    assert.equal(service.describeStatus().active_sessions, 0);
    assert.equal(factory.windows[0].destroyed, true);
    await assert.rejects(
      () => service.open({ sessionId: 'after_dispose', streamId: 'stream_dispose', url: 'http://localhost:3000/' }),
      /disposed/i
    );
  });
});


describe('BrowserSessionService / strict workspace-only posture (W8-S4 preview_test substrate)', () => {
  function makeWorkspaceRoot() {
    const root = createTrackedTempDir('jenny-browser-strict-');
    fs.writeFileSync(path.join(root, 'page.html'), '<!doctype html>', 'utf8');
    return fs.realpathSync(root);
  }

  async function openStrict(factory, workspaceRoot) {
    const service = new BrowserSessionService({ browserWindowFactory: factory });
    await service.open({
      sessionId: 'strict_1',
      streamId: 'stream_strict',
      url: pathToFileURL(path.join(workspaceRoot, 'page.html')).toString(),
      allowedFileRoots: [workspaceRoot],
      strictWorkspaceOnly: true,
    });
    return service;
  }

  function requestDecision(factory, url) {
    let response = null;
    factory.windows[0].browserSession.webRequest.beforeRequestListener(
      { url, resourceType: 'xhr' },
      (value) => { response = value; }
    );
    return response;
  }

  test('strict sessions cancel every network request, including allowed-by-default localhost http', async () => {
    const workspaceRoot = makeWorkspaceRoot();
    const factory = createFakeBrowserWindowFactory();
    await openStrict(factory, workspaceRoot);

    assert.deepEqual(requestDecision(factory, 'http://localhost:3000/api'), { cancel: true });
    assert.deepEqual(requestDecision(factory, 'https://example.com/lib.js'), { cancel: true });
    const outsideRoot = createTrackedTempDir('jenny-browser-strict-outside-');
    fs.writeFileSync(path.join(outsideRoot, 'outside.html'), '<!doctype html>', 'utf8');
    const outsideFile = pathToFileURL(path.join(outsideRoot, 'outside.html')).toString();
    assert.deepEqual(requestDecision(factory, outsideFile), { cancel: true });
  });

  test('strict sessions still allow contained workspace file subresources', async () => {
    const workspaceRoot = makeWorkspaceRoot();
    fs.writeFileSync(path.join(workspaceRoot, 'style.css'), 'body{}', 'utf8');
    const factory = createFakeBrowserWindowFactory();
    await openStrict(factory, workspaceRoot);

    const contained = pathToFileURL(path.join(workspaceRoot, 'style.css')).toString();
    assert.deepEqual(requestDecision(factory, contained), {});
  });

  test('non-strict sessions keep the browsing posture (localhost http with explicit port allowed)', async () => {
    const workspaceRoot = makeWorkspaceRoot();
    const factory = createFakeBrowserWindowFactory();
    const service = new BrowserSessionService({ browserWindowFactory: factory });
    await service.open({
      sessionId: 'lenient_1',
      streamId: 'stream_lenient',
      url: 'http://localhost:3000/fixture',
      allowedFileRoots: [workspaceRoot],
    });
    assert.deepEqual(requestDecision(factory, 'http://localhost:3000/api'), {});
  });

  test('strict open refuses a non-workspace-file top-level url outright', async () => {
    const workspaceRoot = makeWorkspaceRoot();
    const factory = createFakeBrowserWindowFactory();
    const service = new BrowserSessionService({ browserWindowFactory: factory });
    await assert.rejects(
      service.open({
        sessionId: 'strict_top',
        streamId: 'stream_strict_top',
        url: 'http://localhost:3000/fixture',
        allowedFileRoots: [workspaceRoot],
        strictWorkspaceOnly: true,
      })
    );
    assert.equal(service.describeStatus().active_sessions, 0, 'no session survives the refusal');
  });
});

describe('BrowserSessionService / inspect (W8-S4)', () => {
  test('inspect returns retained console and page state without capture and keeps the session open', async () => {
    const factory = createFakeBrowserWindowFactory();
    const service = new BrowserSessionService({ browserWindowFactory: factory });
    await service.open({
      sessionId: 'inspect_1',
      streamId: 'stream_inspect',
      url: 'http://localhost:3000/fixture',
    });
    factory.windows[0].emit('console-message', {}, 3, 'boom happened', 7, 'http://localhost:3000/fixture');

    const inspected = await service.inspect('inspect_1');
    assert.equal(inspected.session_id, 'inspect_1');
    assert.ok(Array.isArray(inspected.console_messages));
    assert.equal(inspected.console_messages.at(-1).message, 'boom happened');
    assert.equal(inspected.console_messages.at(-1).level, 3);
    assert.ok(Array.isArray(inspected.page_errors));
    assert.equal(factory.windows[0].destroyed, false, 'inspect does not close the window');
    assert.equal(factory.windows[0].captureArgs, null, 'inspect never captures the page');
  });

  test('inspect on an unknown session rejects', async () => {
    const service = new BrowserSessionService({
      browserWindowFactory: createFakeBrowserWindowFactory(),
    });
    await assert.rejects(service.inspect('ghost'));
  });
});
