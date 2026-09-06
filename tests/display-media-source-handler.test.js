'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDisplayMediaSourceHandler } = require('../services/main/display-media-source-handler');

// A minimal Electron-Session stand-in that captures the installed handler so
// tests can drive it directly (mirrors createFakeSession() in
// tests/default-session-permission-guard.test.js).
function createFakeSession() {
  return {
    displayMediaRequestHandler: null,
    setDisplayMediaRequestHandler(handler) {
      this.displayMediaRequestHandler = handler || null;
    },
  };
}

function makeThumbnail(dataUrl = 'data:image/png;base64,AAAA') {
  return {
    toDataURL: () => dataUrl,
    isEmpty: () => false,
  };
}

function makeSource(overrides = {}) {
  return {
    id: 'screen:0:0',
    name: 'Entire screen',
    display_id: '1',
    thumbnail: makeThumbnail(),
    ...overrides,
  };
}

// A minimal desktopCapturer stand-in. `sourcesOrFn` is either a static array
// returned on every call, or a function(options) -> array | throws, for
// tests that need to reject or vary behavior per call.
function createFakeDesktopCapturer(sourcesOrFn) {
  return {
    calls: [],
    async getSources(options) {
      this.calls.push(options);
      if (typeof sourcesOrFn === 'function') {
        return sourcesOrFn(options);
      }
      return sourcesOrFn;
    },
  };
}

function createRendererSpies() {
  return {
    pushed: [],
    cancelled: [],
    sendToRenderer(payload) {
      this.pushed.push(payload);
    },
    sendCancel(payload) {
      this.cancelled.push(payload);
    },
  };
}

// Fires the installed handler and flushes both the async continuation and a
// pending microtask/macrotask boundary, so any synchronous work the handler
// does after its single await (e.g. sendToRenderer / callback({})) is
// guaranteed to have run before assertions.
async function fireRequest(session, request = {}) {
  const calls = [];
  const callback = (streams) => calls.push(streams);
  await session.displayMediaRequestHandler(request, callback);
  await new Promise((resolve) => setImmediate(resolve));
  return calls;
}

test('installHandler: succeeds with a usable session + capturer + sender, fails closed otherwise', () => {
  const capturer = createFakeDesktopCapturer([]);
  const renderer = createRendererSpies();

  const good = createDisplayMediaSourceHandler({
    desktopCapturer: capturer,
    sendToRenderer: renderer.sendToRenderer.bind(renderer),
  });
  assert.equal(good.installHandler(createFakeSession()), true);

  const badSessions = [null, {}, { setDisplayMediaRequestHandler: 'nope' }, undefined];
  for (const session of badSessions) {
    const handler = createDisplayMediaSourceHandler({
      desktopCapturer: capturer,
      sendToRenderer: renderer.sendToRenderer.bind(renderer),
    });
    assert.equal(handler.installHandler(session), false);
  }

  const missingCapturer = createDisplayMediaSourceHandler({
    sendToRenderer: renderer.sendToRenderer.bind(renderer),
  });
  assert.equal(missingCapturer.installHandler(createFakeSession()), false);

  const missingSender = createDisplayMediaSourceHandler({ desktopCapturer: capturer });
  assert.equal(missingSender.installHandler(createFakeSession()), false);
});

test('happy path: getSources call shape, one sendToRenderer push, serialized source shape, resolvePick grants the chosen source', async () => {
  const screenSource = makeSource({
    id: 'screen:0:0',
    name: 'Entire screen',
    display_id: '1',
    thumbnail: makeThumbnail('data:image/png;base64,SCREEN'),
  });
  const windowSource = makeSource({
    id: 'window:123:0',
    name: 'My App Window',
    display_id: '',
    thumbnail: makeThumbnail('data:image/png;base64,WINDOW'),
  });
  const capturer = createFakeDesktopCapturer([screenSource, windowSource]);
  const renderer = createRendererSpies();

  const handler = createDisplayMediaSourceHandler({
    desktopCapturer: capturer,
    sendToRenderer: renderer.sendToRenderer.bind(renderer),
    sendCancel: renderer.sendCancel.bind(renderer),
  });
  const session = createFakeSession();
  assert.equal(handler.installHandler(session), true);

  const calls = await fireRequest(session);

  assert.equal(capturer.calls.length, 1);
  assert.deepEqual(capturer.calls[0], { types: ['screen', 'window'], thumbnailSize: { width: 192, height: 108 } });

  assert.equal(renderer.pushed.length, 1);
  const { requestId, sources } = renderer.pushed[0];
  assert.equal(typeof requestId, 'number');
  assert.equal(sources.length, 2);

  assert.deepEqual(sources[0], {
    id: 'screen:0:0',
    name: 'Entire screen',
    displayId: '1',
    kind: 'screen',
    thumbnailDataUrl: 'data:image/png;base64,SCREEN',
  });
  assert.deepEqual(sources[1], {
    id: 'window:123:0',
    name: 'My App Window',
    displayId: '',
    kind: 'window',
    thumbnailDataUrl: 'data:image/png;base64,WINDOW',
  });

  // Nothing has been resolved yet.
  assert.equal(calls.length, 0);

  const resolved = handler.resolvePick(requestId, 'window:123:0');
  assert.equal(resolved, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { video: { id: 'window:123:0', name: 'My App Window' } });
});

test('cancel: resolvePick(requestId, null) invokes callback({}) exactly once', async () => {
  const capturer = createFakeDesktopCapturer([makeSource()]);
  const renderer = createRendererSpies();
  const handler = createDisplayMediaSourceHandler({
    desktopCapturer: capturer,
    sendToRenderer: renderer.sendToRenderer.bind(renderer),
  });
  const session = createFakeSession();
  handler.installHandler(session);

  const calls = await fireRequest(session);
  const { requestId } = renderer.pushed[0];

  assert.equal(handler.resolvePick(requestId, null), true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {});
});

test('idempotent resolve: a second resolvePick is a no-op; resolvePick for an unknown requestId returns false', async () => {
  const capturer = createFakeDesktopCapturer([makeSource()]);
  const renderer = createRendererSpies();
  const handler = createDisplayMediaSourceHandler({
    desktopCapturer: capturer,
    sendToRenderer: renderer.sendToRenderer.bind(renderer),
  });
  const session = createFakeSession();
  handler.installHandler(session);

  const calls = await fireRequest(session);
  const { requestId } = renderer.pushed[0];

  assert.equal(handler.resolvePick(requestId, 'screen:0:0'), true);
  assert.equal(calls.length, 1);

  // Second resolve for the same (now-gone) request is a no-op.
  assert.equal(handler.resolvePick(requestId, 'screen:0:0'), false);
  assert.equal(calls.length, 1, 'callback must not be invoked a second time');

  // An id that was never pending.
  assert.equal(handler.resolvePick(999999, 'screen:0:0'), false);
  assert.equal(calls.length, 1);
});

test('timeout backstop: no response within timeoutMs resolves callback({}) once and sends cancel', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const capturer = createFakeDesktopCapturer([makeSource()]);
  const renderer = createRendererSpies();
  const handler = createDisplayMediaSourceHandler({
    desktopCapturer: capturer,
    sendToRenderer: renderer.sendToRenderer.bind(renderer),
    sendCancel: renderer.sendCancel.bind(renderer),
    timeoutMs: 5000,
  });
  const session = createFakeSession();
  handler.installHandler(session);

  const calls = await fireRequest(session);
  const { requestId } = renderer.pushed[0];

  assert.equal(calls.length, 0);
  t.mock.timers.tick(5000);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {});
  assert.equal(renderer.cancelled.length, 1);
  assert.deepEqual(renderer.cancelled[0], { requestId });

  // A later resolvePick for the timed-out request does nothing further.
  assert.equal(handler.resolvePick(requestId, 'screen:0:0'), false);
  assert.equal(calls.length, 1);
});

test('timeout-then-pick race: a pick arriving after the timeout fired does not double-invoke or throw', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const capturer = createFakeDesktopCapturer([makeSource()]);
  const renderer = createRendererSpies();
  const handler = createDisplayMediaSourceHandler({
    desktopCapturer: capturer,
    sendToRenderer: renderer.sendToRenderer.bind(renderer),
    sendCancel: renderer.sendCancel.bind(renderer),
    timeoutMs: 5000,
  });
  const session = createFakeSession();
  handler.installHandler(session);

  const calls = await fireRequest(session);
  const { requestId } = renderer.pushed[0];

  t.mock.timers.tick(5000);
  assert.equal(calls.length, 1);

  assert.doesNotThrow(() => {
    const resolved = handler.resolvePick(requestId, 'screen:0:0');
    assert.equal(resolved, false);
  });
  assert.equal(calls.length, 1, 'the race must not produce a second callback invocation');
});

test('concurrent requests: distinct requestIds, resolving one leaves the other pending', async () => {
  const capturer = createFakeDesktopCapturer(() => [makeSource({ id: 'screen:0:0' })]);
  const renderer = createRendererSpies();
  const handler = createDisplayMediaSourceHandler({
    desktopCapturer: capturer,
    sendToRenderer: renderer.sendToRenderer.bind(renderer),
  });
  const session = createFakeSession();
  handler.installHandler(session);

  const callsA = await fireRequest(session, { frameId: 'a' });
  const callsB = await fireRequest(session, { frameId: 'b' });

  assert.equal(renderer.pushed.length, 2);
  const requestIdA = renderer.pushed[0].requestId;
  const requestIdB = renderer.pushed[1].requestId;
  assert.notEqual(requestIdA, requestIdB);

  assert.equal(handler.resolvePick(requestIdA, 'screen:0:0'), true);
  assert.equal(callsA.length, 1);
  assert.equal(callsB.length, 0, 'the second request must remain pending');

  assert.equal(handler.resolvePick(requestIdB, null), true);
  assert.equal(callsB.length, 1);
});

test('zero sources: immediate callback({}), no sendToRenderer push, no pending timer left armed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const capturer = createFakeDesktopCapturer([]);
  const renderer = createRendererSpies();
  const handler = createDisplayMediaSourceHandler({
    desktopCapturer: capturer,
    sendToRenderer: renderer.sendToRenderer.bind(renderer),
    sendCancel: renderer.sendCancel.bind(renderer),
    timeoutMs: 5000,
  });
  const session = createFakeSession();
  handler.installHandler(session);

  const calls = await fireRequest(session);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {});
  assert.equal(renderer.pushed.length, 0);

  // If a timer had been armed, ticking past it would fire a cancel push.
  t.mock.timers.tick(5000);
  assert.equal(renderer.cancelled.length, 0, 'no timer should have been armed for a zero-source request');
});

test('empty thumbnail guard: thumbnailDataUrl is "" and toDataURL is never called', async () => {
  let toDataURLCalled = false;
  const source = makeSource({
    thumbnail: {
      isEmpty: () => true,
      toDataURL: () => {
        toDataURLCalled = true;
        return 'data:image/png;base64,SHOULD_NOT_HAPPEN';
      },
    },
  });
  const capturer = createFakeDesktopCapturer([source]);
  const renderer = createRendererSpies();
  const handler = createDisplayMediaSourceHandler({
    desktopCapturer: capturer,
    sendToRenderer: renderer.sendToRenderer.bind(renderer),
  });
  const session = createFakeSession();
  handler.installHandler(session);

  await fireRequest(session);

  assert.equal(renderer.pushed[0].sources[0].thumbnailDataUrl, '');
  assert.equal(toDataURLCalled, false);

  // Clean up: dispose so the request's real (unmocked) timeoutMs timer
  // doesn't keep the process alive until it fires.
  handler.dispose();
});

test('bad id round-trip: resolvePick with a sourceId not in the source list resolves as cancel, not a bad grant', async () => {
  const capturer = createFakeDesktopCapturer([makeSource({ id: 'screen:0:0' })]);
  const renderer = createRendererSpies();
  const handler = createDisplayMediaSourceHandler({
    desktopCapturer: capturer,
    sendToRenderer: renderer.sendToRenderer.bind(renderer),
  });
  const session = createFakeSession();
  handler.installHandler(session);

  const calls = await fireRequest(session);
  const { requestId } = renderer.pushed[0];

  assert.equal(handler.resolvePick(requestId, 'not-a-real-source-id'), true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {});
});

test('getSources rejects: the handler swallows the error, logs ERROR, calls back once, leaves no dangling timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const capturer = createFakeDesktopCapturer(() => {
    throw new Error('boom');
  });
  const renderer = createRendererSpies();
  const logs = [];
  const handler = createDisplayMediaSourceHandler({
    desktopCapturer: capturer,
    sendToRenderer: renderer.sendToRenderer.bind(renderer),
    sendCancel: renderer.sendCancel.bind(renderer),
    log: (level, event, details) => logs.push({ level, event, details }),
    timeoutMs: 5000,
  });
  const session = createFakeSession();
  handler.installHandler(session);

  const calls = await fireRequest(session);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {});
  assert.equal(renderer.pushed.length, 0);
  assert.ok(logs.some((entry) => entry.level === 'ERROR' && entry.event === 'display_media.get_sources_failed'));

  t.mock.timers.tick(5000);
  assert.equal(renderer.cancelled.length, 0, 'no timer should have been armed after a getSources rejection');
});

test('dispose(): unregisters the handler, cancels all in-flight requests once each, is idempotent', async () => {
  const capturer = createFakeDesktopCapturer(() => [makeSource({ id: 'screen:0:0' })]);
  const renderer = createRendererSpies();
  const handler = createDisplayMediaSourceHandler({
    desktopCapturer: capturer,
    sendToRenderer: renderer.sendToRenderer.bind(renderer),
  });
  const session = createFakeSession();
  handler.installHandler(session);

  const callsA = await fireRequest(session, { frameId: 'a' });
  const callsB = await fireRequest(session, { frameId: 'b' });
  assert.equal(renderer.pushed.length, 2);

  assert.doesNotThrow(() => handler.dispose());

  assert.equal(session.displayMediaRequestHandler, null);
  assert.equal(callsA.length, 1);
  assert.deepEqual(callsA[0], {});
  assert.equal(callsB.length, 1);
  assert.deepEqual(callsB[0], {});

  // Safe to call twice: nothing left to cancel, no throw, unregister no-ops.
  assert.doesNotThrow(() => handler.dispose());
  assert.equal(callsA.length, 1);
  assert.equal(callsB.length, 1);
});

test('dispose(): cancels a request whose source enumeration settles after teardown', async () => {
  let releaseSources;
  const capturer = createFakeDesktopCapturer(() => new Promise((resolve) => {
    releaseSources = resolve;
  }));
  const renderer = createRendererSpies();
  const handler = createDisplayMediaSourceHandler({
    desktopCapturer: capturer,
    sendToRenderer: renderer.sendToRenderer.bind(renderer),
    sendCancel: renderer.sendCancel.bind(renderer),
    timeoutMs: 1000,
  });
  const session = createFakeSession();
  handler.installHandler(session);
  const calls = [];
  const inFlight = session.displayMediaRequestHandler({}, (streams) => calls.push(streams));

  handler.dispose();
  releaseSources([makeSource()]);
  await inFlight;

  try {
    assert.deepEqual(calls, [{}]);
    assert.equal(renderer.pushed.length, 0);
    assert.equal(renderer.cancelled.length, 0);
  } finally {
    handler.dispose();
  }
});

test('redacted logging: no log detail ever contains a source name or a data: URL', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const secretName = 'TopSecret Confidential Window Title';
  const secretThumb = 'data:image/png;base64,VERY_SENSITIVE_PIXELS';
  const source = makeSource({
    id: 'window:999:0',
    name: secretName,
    display_id: '',
    thumbnail: makeThumbnail(secretThumb),
  });
  const capturer = createFakeDesktopCapturer([source]);
  const renderer = createRendererSpies();
  const logs = [];
  const handler = createDisplayMediaSourceHandler({
    desktopCapturer: capturer,
    sendToRenderer: renderer.sendToRenderer.bind(renderer),
    sendCancel: renderer.sendCancel.bind(renderer),
    log: (level, event, details) => logs.push({ level, event, details }),
    timeoutMs: 1000,
  });
  const session = createFakeSession();
  handler.installHandler(session);

  await fireRequest(session);
  const { requestId } = renderer.pushed[0];
  handler.resolvePick(requestId, 'window:999:0');
  handler.dispose();
  t.mock.timers.tick(1000);

  assert.ok(logs.length > 0, 'sanity: the handler should have logged something');
  for (const entry of logs) {
    const serialized = JSON.stringify(entry.details || {});
    assert.ok(!serialized.includes(secretName), `log ${entry.event} must not include the source name`);
    assert.ok(!serialized.includes('data:image'), `log ${entry.event} must not include a data: URL`);
  }
});
