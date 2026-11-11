'use strict';

// Step 1 contract (HTML Artifact Preview): the frame-init function is inlined
// into the staged frame document's head via Function.prototype.toString(),
// so these tests evaluate its stringified source inside a jsdom window — the
// same transport the factory uses. That pins BOTH the postMessage contract and
// the self-containment requirement (a closure over module scope would throw
// ReferenceError here exactly as it would inside the real frame).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const { initHtmlArtifactFrame } = require('../renderer/frames/html-artifact-frame-init.js');

// jsdom parses synchronously but fires DOMContentLoaded on a later task, so a
// fresh window still reports readyState 'loading'; tests that need the
// already-ready path override it to 'complete' explicitly.
function makeFrameWindow({ readyState = 'complete', withResizeObserver = false } = {}) {
  const dom = new JSDOM('<body><div style="height:40px">artifact</div></body>', {
    runScripts: 'outside-only',
  });
  const windowRef = dom.window;
  const posted = [];
  // The frame is a sandboxed opaque-origin child whose window.parent is the real
  // renderer window; in a top-level jsdom window, window.parent === window,
  // so spying window.postMessage captures exactly what the frame emits.
  windowRef.postMessage = (payload, targetOrigin) => {
    posted.push({ payload, targetOrigin });
  };
  if (readyState) {
    Object.defineProperty(windowRef.document, 'readyState', {
      configurable: true,
      get: () => readyState,
    });
  }
  const resizeCallbacks = [];
  if (withResizeObserver) {
    windowRef.ResizeObserver = class FakeResizeObserver {
      constructor(callback) {
        resizeCallbacks.push(callback);
        this.observed = [];
      }

      observe(target) { this.observed.push(target); }

      disconnect() { this.observed = []; }
    };
  }
  const addEventListenerCalls = [];
  const realAddEventListener = windowRef.addEventListener.bind(windowRef);
  windowRef.addEventListener = (type, handler, options) => {
    addEventListenerCalls.push(type);
    return realAddEventListener(type, handler, options);
  };
  return { dom, windowRef, posted, resizeCallbacks, addEventListenerCalls };
}

function runInitInWindow(dom, requestId, options) {
  const context = dom.getInternalVMContext();
  const optionsArg = options === undefined ? '' : `, ${JSON.stringify(options)}`;
  vm.runInContext(`(${initHtmlArtifactFrame.toString()})(${JSON.stringify(requestId)}${optionsArg});`, context);
}

test('posts rendered ok with the embedded requestId and opaque-origin target "*" when the document is ready', (t) => {
  const { dom, posted } = makeFrameWindow();
  t.after(() => dom.window.close());
  runInitInWindow(dom, 'req-1');
  const rendered = posted.find((entry) => entry.payload?.type === 'rendered');
  assert.ok(rendered, `no rendered message posted: ${JSON.stringify(posted)}`);
  assert.equal(rendered.targetOrigin, '*', 'opaque-origin frames must be addressed with *');
  assert.equal(rendered.payload.requestId, 'req-1');
  assert.equal(rendered.payload.ok, true);
  assert.ok(rendered.payload.height >= 60, `height missing/too small: ${rendered.payload.height}`);
});

test('defers rendered until DOMContentLoaded when the document is still loading', (t) => {
  const { dom, windowRef, posted } = makeFrameWindow({ readyState: 'loading' });
  t.after(() => dom.window.close());
  runInitInWindow(dom, 'req-2');
  assert.equal(posted.length, 0, 'nothing may be posted before DOMContentLoaded');
  windowRef.document.dispatchEvent(new windowRef.Event('DOMContentLoaded', { bubbles: true }));
  const rendered = posted.find((entry) => entry.payload?.type === 'rendered');
  assert.ok(rendered, `rendered not posted after DOMContentLoaded: ${JSON.stringify(posted)}`);
  assert.equal(rendered.payload.requestId, 'req-2');
});

test('an uncaught artifact error before readiness posts error (not rendered) and settles once', (t) => {
  const { dom, windowRef, posted } = makeFrameWindow({ readyState: 'loading' });
  t.after(() => dom.window.close());
  runInitInWindow(dom, 'req-3');
  windowRef.dispatchEvent(new windowRef.ErrorEvent('error', { message: 'artifact blew up' }));
  windowRef.document.dispatchEvent(new windowRef.Event('DOMContentLoaded', { bubbles: true }));
  const types = posted.map((entry) => entry.payload?.type);
  assert.deepEqual(types.filter((type) => type === 'error').length, 1);
  assert.ok(!types.includes('rendered'), `settled error must suppress rendered: ${JSON.stringify(types)}`);
  const errorMessage = posted.find((entry) => entry.payload?.type === 'error');
  assert.equal(errorMessage.targetOrigin, '*');
  assert.equal(errorMessage.payload.requestId, 'req-3');
  assert.equal(errorMessage.payload.ok, false);
  assert.match(String(errorMessage.payload.error), /artifact blew up/);
});

test('an error after rendered settles is ignored (a live chart is not torn down)', (t) => {
  const { dom, windowRef, posted } = makeFrameWindow();
  t.after(() => dom.window.close());
  runInitInWindow(dom, 'req-4');
  const before = posted.length;
  windowRef.dispatchEvent(new windowRef.ErrorEvent('error', { message: 'late async error' }));
  assert.equal(posted.length, before, 'post-settle errors must not emit messages');
});

test('streams height messages through ResizeObserver after rendering', (t) => {
  const { dom, posted, resizeCallbacks } = makeFrameWindow({ withResizeObserver: true });
  t.after(() => dom.window.close());
  runInitInWindow(dom, 'req-5');
  assert.ok(resizeCallbacks.length >= 1, 'ResizeObserver not wired');
  resizeCallbacks[0]();
  const heightMessage = posted.find((entry) => entry.payload?.type === 'height');
  assert.ok(heightMessage, `no height message: ${JSON.stringify(posted)}`);
  assert.equal(heightMessage.targetOrigin, '*');
  assert.equal(heightMessage.payload.requestId, 'req-5');
  assert.ok(heightMessage.payload.height >= 60);
});

test('init source stays inline-script-safe: no HTML-significant "<" sequences', () => {
  // The factory inlines this function into a <script> tag via toString(); a
  // "</script>", "<!--", or any "<tag" in its source would break the script
  // context of every rendered artifact. Tripwire, not assumption.
  assert.ok(!/<[a-zA-Z/!]/.test(initHtmlArtifactFrame.toString()),
    'initHtmlArtifactFrame source must contain no HTML-significant "<" sequences');
});

test('registers NO message listener — the frame has no parent->frame command surface', (t) => {
  const { dom, addEventListenerCalls } = makeFrameWindow();
  t.after(() => dom.window.close());
  runInitInWindow(dom, 'req-6');
  assert.ok(!addEventListenerCalls.includes('message'),
    `frame-init must ignore all inbound messages, listeners: ${addEventListenerCalls.join(',')}`);
});

/* ── link guard ── */

function addLink(windowRef, href, inner = 'go') {
  const anchor = windowRef.document.createElement('a');
  if (href !== null) {
    anchor.setAttribute('href', href);
  }
  anchor.innerHTML = inner;
  windowRef.document.body.appendChild(anchor);
  return anchor;
}

function click(windowRef, target) {
  const event = new windowRef.MouseEvent('click', { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

test('link guard blocks relative and absolute links and posts no href', (t) => {
  const { dom, windowRef, posted } = makeFrameWindow();
  t.after(() => dom.window.close());
  runInitInWindow(dom, 'req-l1');
  for (const href of ['page2.html', 'https://example.com/x?secret=1']) {
    const before = posted.length;
    const event = click(windowRef, addLink(windowRef, href));
    assert.equal(event.defaultPrevented, true, `${href} must be prevented`);
    const added = posted.slice(before);
    assert.equal(added.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(added[0].payload)), { type: 'link-blocked', requestId: 'req-l1' });
    assert.equal(added[0].targetOrigin, '*');
  }
});

test('link guard blocks area links and links nested inside an anchor', (t) => {
  const { dom, windowRef, posted } = makeFrameWindow();
  t.after(() => dom.window.close());
  runInitInWindow(dom, 'req-l2');
  const anchor = addLink(windowRef, 'next.html', '<span><b id="deep">deep</b></span>');
  const event = click(windowRef, anchor.querySelector('#deep'));
  assert.equal(event.defaultPrevented, true);
  const area = windowRef.document.createElement('area');
  area.setAttribute('href', 'elsewhere.html');
  windowRef.document.body.appendChild(area);
  assert.equal(click(windowRef, area).defaultPrevented, true);
  assert.equal(posted.filter((entry) => entry.payload?.type === 'link-blocked').length, 2);
});

test('link guard leaves #fragment, javascript:, hrefless and already-prevented clicks alone', (t) => {
  const { dom, windowRef, posted } = makeFrameWindow();
  t.after(() => dom.window.close());
  runInitInWindow(dom, 'req-l3');
  const before = posted.length;
  assert.equal(click(windowRef, addLink(windowRef, '#x')).defaultPrevented, false);
  assert.equal(click(windowRef, addLink(windowRef, ' #x')).defaultPrevented, false);
  assert.equal(click(windowRef, addLink(windowRef, '  JavaScript:void(0)')).defaultPrevented, false);
  assert.equal(click(windowRef, addLink(windowRef, null)).defaultPrevented, false);
  const prevented = addLink(windowRef, 'page2.html');
  prevented.addEventListener('click', (event) => event.preventDefault());
  click(windowRef, prevented);
  assert.equal(posted.length, before, 'none of these may post link-blocked');
});

/* ── scroll restore + report ── */

function stubScroll(windowRef, calls) {
  windowRef.scrollTo = (x, y) => {
    calls.push({ x, y });
    Object.defineProperty(windowRef, 'scrollY', { configurable: true, value: y });
  };
}

function setScrollY(windowRef, y) {
  Object.defineProperty(windowRef, 'scrollY', { configurable: true, value: y });
  windowRef.dispatchEvent(new windowRef.Event('scroll'));
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('restoreScrollY is applied before rendered posts, and again on load', (t) => {
  const { dom, windowRef } = makeFrameWindow();
  t.after(() => dom.window.close());
  const order = [];
  windowRef.scrollTo = (x, y) => order.push(`scrollTo:${y}`);
  windowRef.postMessage = (payload) => order.push(`post:${payload.type}`);
  runInitInWindow(dom, 'req-s1', { restoreScrollY: 340 });
  assert.deepEqual(order.slice(0, 2), ['scrollTo:340', 'post:rendered']);
  windowRef.dispatchEvent(new windowRef.Event('load'));
  assert.equal(order.filter((entry) => entry === 'scrollTo:340').length, 2);
});

test('restore is skipped on load once the user scrolled away from the target', (t) => {
  const { dom, windowRef } = makeFrameWindow();
  t.after(() => dom.window.close());
  const calls = [];
  stubScroll(windowRef, calls);
  runInitInWindow(dom, 'req-s2', { restoreScrollY: 340 });
  assert.equal(calls.length, 1);
  setScrollY(windowRef, 340); // the restore's own scroll event lands on target
  windowRef.dispatchEvent(new windowRef.Event('load'));
  assert.equal(calls.length, 2, 'landing on the target is not a user scroll');
  setScrollY(windowRef, 900);
  windowRef.dispatchEvent(new windowRef.Event('load'));
  assert.equal(calls.length, 2, 'a user scroll must suppress the load re-apply');
});

test('no restore option (or a non-positive one) never calls scrollTo', (t) => {
  for (const options of [undefined, {}, { restoreScrollY: 0 }, { restoreScrollY: -5 }, { restoreScrollY: 'x' }]) {
    const { dom, windowRef } = makeFrameWindow();
    t.after(() => dom.window.close());
    const calls = [];
    stubScroll(windowRef, calls);
    runInitInWindow(dom, 'req-s3', options);
    windowRef.dispatchEvent(new windowRef.Event('load'));
    assert.equal(calls.length, 0, JSON.stringify(options));
  }
});

test('scroll reports are trailing-throttled to the latest rounded value', async (t) => {
  const { dom, windowRef, posted } = makeFrameWindow();
  t.after(() => dom.window.close());
  runInitInWindow(dom, 'req-s4');
  setScrollY(windowRef, 10.4);
  setScrollY(windowRef, 20);
  setScrollY(windowRef, 77.6);
  assert.equal(posted.filter((entry) => entry.payload?.type === 'scroll').length, 0, 'nothing is posted synchronously');
  await wait(220);
  const reports = posted.filter((entry) => entry.payload?.type === 'scroll');
  assert.equal(reports.length, 1, JSON.stringify(reports));
  assert.deepEqual(JSON.parse(JSON.stringify(reports[0].payload)), { type: 'scroll', requestId: 'req-s4', y: 78 });
  assert.equal(reports[0].targetOrigin, '*');
});

test('beforeunload clears a pending scroll report', async (t) => {
  const { dom, windowRef, posted } = makeFrameWindow();
  t.after(() => dom.window.close());
  runInitInWindow(dom, 'req-s5');
  setScrollY(windowRef, 50);
  windowRef.dispatchEvent(new windowRef.Event('beforeunload'));
  await wait(220);
  assert.equal(posted.filter((entry) => entry.payload?.type === 'scroll').length, 0);
});
