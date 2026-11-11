'use strict';

// Sandbox invariants (HTML Artifact Preview): staged jenny-artifact:// src
// transport (srcdoc is FORBIDDEN — srcdoc documents inherit the parent CSP,
// whose script-src 'self' kills the frame handshake; 2026-07-10 RCA), exactly
// sandbox="allow-scripts" (allow-same-origin ABSENT), the strict frame CSP
// verbatim in the assembled document, the
// opaque-origin '*' postMessage target, and dispose/teardown behavior.
// NOTE: jsdom does not enforce CSP, which is exactly how the srcdoc transport
// shipped green while dead in the real app — these tests pin the transport
// shape; only the owner GUI smoke proves scripts actually execute.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  HTML_ARTIFACT_FRAME_CSP,
  HTML_ARTIFACT_FRAME_FILL_CLASS,
  buildHtmlArtifactDocument,
  createHtmlArtifactFrame,
} = require('../renderer/features/renderer-html-artifact-frame-utils.js');

function makeHost(t) {
  const dom = new JSDOM('<body><div id="host"></div></body>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  return { dom, host: dom.window.document.getElementById('host') };
}

/* Staging resolves through a two-step promise chain; drain the microtask
 * queue (plus one macrotask for rejection paths) before asserting on src. */
function settleStaging() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/* Default happy-path stager: records every staged document and hands back a
 * unique single-use-looking URL, standing in for the preload bridge +
 * services/artifact-frame-protocol.js. */
function makeStageStub() {
  const staged = [];
  return {
    staged,
    stageDocument: (html) => {
      staged.push(html);
      return Promise.resolve({ ok: true, url: `jenny-artifact://frame/id-${staged.length}` });
    },
  };
}

function frameMessage(dom, iframe, data) {
  const event = new dom.window.MessageEvent('message', { data, source: iframe.contentWindow });
  dom.window.dispatchEvent(event);
}

/* ── CSP profile ── */

test('the frame CSP constant is the strict verbatim profile', () => {
  assert.equal(
    HTML_ARTIFACT_FRAME_CSP,
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
    + "img-src data: blob:; connect-src 'none'; font-src data:; base-uri 'none'; form-action 'none'"
  );
  assert.ok(HTML_ARTIFACT_FRAME_CSP.includes("connect-src 'none'"));
  assert.ok(HTML_ARTIFACT_FRAME_CSP.includes("default-src 'none'"));
  assert.ok(!HTML_ARTIFACT_FRAME_CSP.includes('http'), 'no network origin may be allowlisted');
});

test('the canonical builder emits the strict CSP meta exactly once', () => {
  const doc = buildHtmlArtifactDocument('<p>artifact</p>', 'csp-parity');
  const matches = [...doc.matchAll(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/g)];
  assert.equal(matches.length, 1, 'assembled document must carry one authoritative CSP meta');
  assert.equal(matches[0][1], HTML_ARTIFACT_FRAME_CSP);
});

/* ── document assembly ── */

test('buildHtmlArtifactDocument embeds the CSP, the inlined init, and the artifact body', () => {
  const doc = buildHtmlArtifactDocument('<h1>chart</h1><script>draw()</script>', 'req-9');
  assert.ok(doc.includes(`content="${HTML_ARTIFACT_FRAME_CSP}"`), 'CSP meta missing from the document');
  assert.ok(doc.includes('<h1>chart</h1><script>draw()</script>'), 'artifact body missing');
  assert.ok(doc.includes('"req-9"'), 'requestId not embedded for the init call');
  assert.ok(/function initHtmlArtifactFrame/.test(doc), 'frame-init source not inlined');
  const cspIndex = doc.indexOf('Content-Security-Policy');
  const bodyIndex = doc.indexOf('<h1>chart</h1>');
  assert.ok(cspIndex >= 0 && cspIndex < bodyIndex, 'CSP must be parsed before any artifact markup');
});

test('buildHtmlArtifactDocument self-defends against a script-breaking requestId', () => {
  const doc = buildHtmlArtifactDocument('<p>x</p>', 'req</script><script>PWNED()//');
  // The hostile id must be reduced to an inert token: exactly one script tag
  // pair may exist in the head (the inlined init), and no tag-closing
  // sequence from the id may survive inside it.
  assert.equal((doc.match(/<script/gi) || []).length, 1, `extra script tag injected: ${doc}`);
  assert.equal((doc.match(/<\/script>/gi) || []).length, 1);
  assert.ok(doc.includes('"req-script-script-PWNED-"'), 'id must be sanitized to an inert token');
});

/* ── sandbox + transport invariants ── */

test('factory stages the assembled document and loads it via jenny-artifact:// src (never srcdoc)', async (t) => {
  const { host } = makeHost(t);
  const stub = makeStageStub();
  const handle = createHtmlArtifactFrame(host, '<p>body</p>', { stageDocument: stub.stageDocument });
  const iframe = host.querySelector('iframe');
  assert.ok(iframe, 'iframe not created');
  t.after(() => handle.dispose());

  await settleStaging();
  assert.equal(stub.staged.length, 1, 'document must be staged exactly once');
  assert.ok(stub.staged[0].includes('<p>body</p>'), 'staged document must contain the artifact body');
  assert.ok(stub.staged[0].includes(HTML_ARTIFACT_FRAME_CSP), 'staged document must carry the strict CSP');
  assert.equal(iframe.getAttribute('srcdoc'), null,
    'srcdoc must never be set — srcdoc documents inherit the parent CSP and the handshake dies');
  assert.equal(iframe.getAttribute('src'), 'jenny-artifact://frame/id-1');

  const sandbox = String(iframe.getAttribute('sandbox') || '');
  assert.equal(sandbox, 'allow-scripts', `sandbox tokens must be exactly allow-scripts, got "${sandbox}"`);
  assert.ok(!sandbox.includes('allow-same-origin'),
    'allow-same-origin would re-grant the parent origin and defeat the opaque-origin isolation');
});

test('factory refuses a staged URL outside the jenny-artifact scheme', async (t) => {
  const { host } = makeHost(t);
  const failures = [];
  createHtmlArtifactFrame(host, '<p>x</p>', {
    stageDocument: () => Promise.resolve({ ok: true, url: 'file:///C:/evil.html' }),
    onFailure: (payload) => failures.push(payload),
  });
  await settleStaging();
  assert.equal(failures.length, 1, 'a non-artifact URL must fail the frame');
  assert.equal(host.querySelector('iframe'), null, 'refused frame must be removed');
});

test('staging failure and staging rejection both land the bounded failure state', async (t) => {
  const { host } = makeHost(t);
  const failures = [];
  createHtmlArtifactFrame(host, '<p>x</p>', {
    stageDocument: () => Promise.resolve({ ok: false, error: 'stage refused' }),
    onFailure: (payload) => failures.push(payload),
  });
  await settleStaging();
  assert.equal(failures.length, 1);
  assert.match(String(failures[0].error), /stage refused/);
  assert.equal(host.querySelector('iframe'), null);

  const rejections = [];
  createHtmlArtifactFrame(host, '<p>y</p>', {
    stageDocument: () => Promise.reject(new Error('ipc down')),
    onFailure: (payload) => rejections.push(payload),
  });
  await settleStaging();
  assert.equal(rejections.length, 1);
  assert.match(String(rejections[0].error), /ipc down/);
  assert.equal(host.querySelector('iframe'), null);
});

test('factory fails soft (no iframe) when no staging transport exists', (t) => {
  const { host } = makeHost(t);
  const failures = [];
  // No options.stageDocument and the jsdom window has no jennyShell bridge.
  const handle = createHtmlArtifactFrame(host, '<p>x</p>', { onFailure: (payload) => failures.push(payload) });
  assert.equal(typeof handle.dispose, 'function');
  assert.equal(failures.length, 1);
  assert.equal(host.querySelector('iframe'), null);
});

test('factory returns a noop handle and reports failure for a blank body', (t) => {
  const { host } = makeHost(t);
  const failures = [];
  const handle = createHtmlArtifactFrame(host, '   ', { onFailure: (payload) => failures.push(payload) });
  assert.equal(typeof handle.dispose, 'function');
  assert.equal(host.querySelector('iframe'), null, 'no iframe for a blank body');
  assert.equal(failures.length, 1);
});

/* ── message contract (opaque-origin '*') ── */

test('height messages from the frame resize the iframe; rendered settles success', (t) => {
  const { dom, host } = makeHost(t);
  const successes = [];
  const handle = createHtmlArtifactFrame(host, '<p>x</p>', {
    timeoutMs: 5000,
    stageDocument: makeStageStub().stageDocument,
    onSuccess: (payload) => successes.push(payload),
  });
  t.after(() => handle.dispose());
  const iframe = host.querySelector('iframe');

  frameMessage(dom, iframe, { type: 'height', requestId: handle.requestId, height: 480 });
  assert.equal(iframe.style.height, '480px');

  // The child is untrusted: absurd reported heights are clamped, not honored.
  frameMessage(dom, iframe, { type: 'height', requestId: handle.requestId, height: 10_000_000 });
  assert.equal(iframe.style.height, '10000px');

  frameMessage(dom, iframe, { type: 'rendered', requestId: handle.requestId, ok: true, height: 512 });
  assert.equal(successes.length, 1);
  assert.equal(iframe.style.height, '512px');
});

test('fill sizing stretches the iframe and stamps the host marker class', (t) => {
  const { host } = makeHost(t);
  const handle = createHtmlArtifactFrame(host, '<p>x</p>', {
    sizing: 'fill',
    stageDocument: makeStageStub().stageDocument,
  });
  t.after(() => handle.dispose());
  const iframe = host.querySelector('iframe');

  assert.equal(iframe.style.height, '100%');
  assert.equal(iframe.getAttribute('scrolling'), 'auto');
  assert.ok(host.classList.contains(HTML_ARTIFACT_FRAME_FILL_CLASS));
});

test('remounting a fill frame into the same host re-stamps the marker class', (t) => {
  const { host } = makeHost(t);
  createHtmlArtifactFrame(host, '<p>one</p>', {
    sizing: 'fill',
    stageDocument: makeStageStub().stageDocument,
  });
  // Second mount runs the previousDispose path (teardown removes the class),
  // then must stamp it again for the new frame.
  const second = createHtmlArtifactFrame(host, '<p>two</p>', {
    sizing: 'fill',
    stageDocument: makeStageStub().stageDocument,
  });
  t.after(() => second.dispose());

  assert.ok(host.classList.contains(HTML_ARTIFACT_FRAME_FILL_CLASS));
  second.dispose();
  assert.ok(!host.classList.contains(HTML_ARTIFACT_FRAME_FILL_CLASS));
});

test('fill sizing ignores frame-reported heights', (t) => {
  const { dom, host } = makeHost(t);
  const successes = [];
  const handle = createHtmlArtifactFrame(host, '<p>x</p>', {
    sizing: 'fill',
    timeoutMs: 5000,
    stageDocument: makeStageStub().stageDocument,
    onSuccess: (payload) => successes.push(payload),
  });
  t.after(() => handle.dispose());
  const iframe = host.querySelector('iframe');

  frameMessage(dom, iframe, { type: 'height', requestId: handle.requestId, height: 480 });
  frameMessage(dom, iframe, { type: 'rendered', requestId: handle.requestId, ok: true, height: 512 });
  assert.equal(iframe.style.height, '100%');
  assert.equal(successes.length, 1);
});

test('content sizing is unchanged by the fill option', (t) => {
  const { host } = makeHost(t);
  const handle = createHtmlArtifactFrame(host, '<p>x</p>', {
    stageDocument: makeStageStub().stageDocument,
  });
  t.after(() => handle.dispose());
  const iframe = host.querySelector('iframe');

  assert.equal(iframe.getAttribute('scrolling'), 'no');
  assert.equal(iframe.style.height, '160px');
  assert.ok(!host.classList.contains(HTML_ARTIFACT_FRAME_FILL_CLASS));
});

test('tearing down a fill frame removes the host marker class', async (t) => {
  const { host: disposeHost } = makeHost(t);
  const handle = createHtmlArtifactFrame(disposeHost, '<p>x</p>', {
    sizing: 'fill',
    stageDocument: makeStageStub().stageDocument,
  });
  assert.ok(disposeHost.classList.contains(HTML_ARTIFACT_FRAME_FILL_CLASS));
  handle.dispose();
  assert.ok(!disposeHost.classList.contains(HTML_ARTIFACT_FRAME_FILL_CLASS));

  const { host: timeoutHost } = makeHost(t);
  let failureCalled = false;
  createHtmlArtifactFrame(timeoutHost, '<p>x</p>', {
    sizing: 'fill',
    timeoutMs: 20,
    stageDocument: makeStageStub().stageDocument,
    onFailure: () => {
      assert.ok(!timeoutHost.classList.contains(HTML_ARTIFACT_FRAME_FILL_CLASS));
      failureCalled = true;
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(failureCalled, true);
});

test('messages with a foreign source or wrong requestId are ignored', (t) => {
  const { dom, host } = makeHost(t);
  const successes = [];
  const handle = createHtmlArtifactFrame(host, '<p>x</p>', {
    timeoutMs: 5000,
    stageDocument: makeStageStub().stageDocument,
    onSuccess: (payload) => successes.push(payload),
  });
  t.after(() => handle.dispose());
  const iframe = host.querySelector('iframe');

  // Wrong source (the parent window itself, not the frame).
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    data: { type: 'rendered', requestId: handle.requestId, ok: true },
    source: dom.window,
  }));
  // Right source, wrong requestId.
  frameMessage(dom, iframe, { type: 'rendered', requestId: 'someone-else', ok: true });
  assert.equal(successes.length, 0);
});

test('a frame error message tears the frame down and reports failure', (t) => {
  const { dom, host } = makeHost(t);
  const failures = [];
  const handle = createHtmlArtifactFrame(host, '<p>x</p>', {
    timeoutMs: 5000,
    stageDocument: makeStageStub().stageDocument,
    onFailure: (payload) => failures.push(payload),
  });
  t.after(() => handle.dispose());
  const iframe = host.querySelector('iframe');

  frameMessage(dom, iframe, { type: 'error', requestId: handle.requestId, ok: false, error: 'boom' });
  assert.equal(failures.length, 1);
  assert.match(String(failures[0].error), /boom/);
  assert.equal(host.querySelector('iframe'), null, 'failed frame must be removed');
});

test('boot timeout reports failure and removes the frame', async (t) => {
  const { host } = makeHost(t);
  const failures = [];
  createHtmlArtifactFrame(host, '<p>x</p>', {
    timeoutMs: 20,
    // Staging succeeds but the frame never posts rendered (the real-app
    // symptom this transport replaced): the timeout must still fire.
    stageDocument: makeStageStub().stageDocument,
    onFailure: (payload) => failures.push(payload),
  });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(failures.length, 1);
  assert.equal(host.querySelector('iframe'), null);
});

/* ── dispose ── */

test('dispose removes the iframe and disconnects the message listener', (t) => {
  const { dom, host } = makeHost(t);
  const successes = [];
  const handle = createHtmlArtifactFrame(host, '<p>x</p>', {
    timeoutMs: 5000,
    stageDocument: makeStageStub().stageDocument,
    onSuccess: (payload) => successes.push(payload),
  });
  const iframe = host.querySelector('iframe');
  handle.dispose();
  assert.equal(host.querySelector('iframe'), null, 'dispose must remove the iframe');
  frameMessage(dom, iframe, { type: 'rendered', requestId: handle.requestId, ok: true });
  assert.equal(successes.length, 0, 'disposed frame must not settle');
});

test('a staged URL arriving after dispose is never applied', async (t) => {
  const { host } = makeHost(t);
  let resolveStage;
  const handle = createHtmlArtifactFrame(host, '<p>x</p>', {
    stageDocument: () => new Promise((resolve) => { resolveStage = resolve; }),
  });
  const iframe = host.querySelector('iframe');
  // Let the factory invoke the stager (it runs on a microtask) so resolveStage
  // is captured, THEN dispose, THEN let the staged URL arrive late.
  await settleStaging();
  handle.dispose();
  resolveStage({ ok: true, url: 'jenny-artifact://frame/late' });
  await settleStaging();
  assert.equal(iframe.getAttribute('src'), null, 'late staging must not load into a disposed frame');
});

test('creating a second frame on the same host disposes the first', async (t) => {
  const { host } = makeHost(t);
  const stub = makeStageStub();
  const first = createHtmlArtifactFrame(host, '<p>one</p>', { timeoutMs: 5000, stageDocument: stub.stageDocument });
  const second = createHtmlArtifactFrame(host, '<p>two</p>', { timeoutMs: 5000, stageDocument: stub.stageDocument });
  t.after(() => second.dispose());
  await settleStaging();
  const iframes = host.querySelectorAll('iframe');
  assert.equal(iframes.length, 1, 'host replacement must not stack frames');
  assert.ok(stub.staged.some((doc) => doc.includes('<p>two</p>')), 'second document must be staged');
  assert.match(String(iframes[0].getAttribute('src')), /^jenny-artifact:\/\/frame\//,
    'replacement frame must carry a staged artifact src');
  assert.notEqual(first.requestId, second.requestId);
});


test('HTML frames, Mermaid frames and controls share one observer and dispose independently', async (t) => {
  const { dom, host } = makeHost(t);
  const Mermaid = require('../renderer/features/renderer-mermaid-utils');
  const Observer = dom.window.MutationObserver;
  let observerCount = 0;
  let disconnectCount = 0;
  dom.window.MutationObserver = class extends Observer {
    constructor(callback) { super(callback); observerCount += 1; }
    disconnect() { super.disconnect(); disconnectCount += 1; }
  };
  const mermaidHost = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(mermaidHost);
  const html = createHtmlArtifactFrame(host, '<p>preview</p>', makeStageStub());
  const mermaid = Mermaid.createMermaidFrame(mermaidHost, 'graph TD; A-->B');
  const preview = dom.window.document.createElement('div');
  preview.innerHTML = '<svg viewBox="0 0 100 100"><rect width="100" height="100"></rect></svg>';
  dom.window.document.body.appendChild(preview);
  Mermaid.attachMermaidControls(preview);
  t.after(() => { html.dispose(); mermaid(); });
  assert.equal(observerCount, 1);
  html.dispose();
  assert.ok(mermaidHost.querySelector('iframe'));
  mermaidHost.remove();
  await settleStaging();
  assert.equal(disconnectCount, 0);
  preview.remove();
  await settleStaging();
  assert.ok(disconnectCount > 0);
});

/* ── live preview: restore, link-blocked, scroll, navigation ── */

const { initHtmlArtifactFrame } = require('../renderer/frames/html-artifact-frame-init.js');

function initCall(doc) {
  const marker = `(${initHtmlArtifactFrame.toString()})`;
  const start = doc.indexOf(marker);
  assert.ok(start >= 0, 'inlined init not found');
  return doc.slice(start + marker.length, doc.indexOf(';</script>', start));
}

test('document bytes are unchanged when no restore scroll is given', () => {
  const expected = `(${initHtmlArtifactFrame.toString()})("req-b");`;
  for (const documentOptions of [undefined, {}, { restoreScrollY: 0 }, { restoreScrollY: -3 }, { restoreScrollY: Number.NaN }, { restoreScrollY: '40' }]) {
    const doc = buildHtmlArtifactDocument('<p>x</p>', 'req-b', documentOptions);
    assert.ok(doc.includes(`<script>${expected}</script>`), JSON.stringify(documentOptions));
  }
});

test('restoreScrollY is floored, clamped and emitted as the init options argument', () => {
  assert.equal(initCall(buildHtmlArtifactDocument('<p>x</p>', 'req-r', { restoreScrollY: 340.9 })),
    '("req-r", {"restoreScrollY":340})');
  assert.equal(initCall(buildHtmlArtifactDocument('<p>x</p>', 'req-r', { restoreScrollY: 1e12 })),
    '("req-r", {"restoreScrollY":10000000})');
});

test('createHtmlArtifactFrame passes restoreScrollY into the staged document', async (t) => {
  const { host } = makeHost(t);
  const stub = makeStageStub();
  const handle = createHtmlArtifactFrame(host, '<p>x</p>', { stageDocument: stub.stageDocument, restoreScrollY: 250 });
  t.after(() => handle.dispose());
  await settleStaging();
  assert.ok(stub.staged[0].includes('{"restoreScrollY":250}'));
});

test('link-blocked messages call onLinkBlocked with no arguments; bad source or id is ignored', (t) => {
  const { dom, host } = makeHost(t);
  const calls = [];
  const handle = createHtmlArtifactFrame(host, '<p>x</p>', {
    timeoutMs: 5000,
    stageDocument: makeStageStub().stageDocument,
    onLinkBlocked: (...args) => calls.push(args),
  });
  t.after(() => handle.dispose());
  const iframe = host.querySelector('iframe');
  frameMessage(dom, iframe, { type: 'link-blocked', requestId: handle.requestId, href: 'https://evil' });
  frameMessage(dom, iframe, { type: 'link-blocked', requestId: 'someone-else' });
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    data: { type: 'link-blocked', requestId: handle.requestId },
    source: dom.window,
  }));
  assert.deepEqual(calls, [[]]);
});

test('link-blocked and scroll never tear the frame down or count as failure', (t) => {
  const { dom, host } = makeHost(t);
  const failures = [];
  const handle = createHtmlArtifactFrame(host, '<p>x</p>', {
    timeoutMs: 5000,
    stageDocument: makeStageStub().stageDocument,
    onFailure: (payload) => failures.push(payload),
  });
  t.after(() => handle.dispose());
  const iframe = host.querySelector('iframe');
  frameMessage(dom, iframe, { type: 'link-blocked', requestId: handle.requestId });
  frameMessage(dom, iframe, { type: 'scroll', requestId: handle.requestId, y: 10 });
  assert.equal(failures.length, 0);
  assert.ok(host.querySelector('iframe'));
});

test('scroll messages are sanitised: coerced, floored, clamped, non-finite ignored', (t) => {
  const { dom, host } = makeHost(t);
  const ys = [];
  const handle = createHtmlArtifactFrame(host, '<p>x</p>', {
    timeoutMs: 5000,
    stageDocument: makeStageStub().stageDocument,
    onScroll: (y) => ys.push(y),
  });
  t.after(() => handle.dispose());
  const iframe = host.querySelector('iframe');
  for (const y of [42.9, '120', -50, 1e15, Number.NaN, Infinity, 'abc', null, undefined, {}]) {
    frameMessage(dom, iframe, { type: 'scroll', requestId: handle.requestId, y });
  }
  assert.deepEqual(ys, [42, 120, 0, 10_000_000, 0]);
});

function makeNavFrame(t, extra = {}) {
  const { dom, host } = makeHost(t);
  const away = [];
  const failures = [];
  const handle = createHtmlArtifactFrame(host, '<p>x</p>', {
    timeoutMs: 40,
    stageDocument: makeStageStub().stageDocument,
    onNavigatedAway: () => away.push(true),
    onFailure: (payload) => failures.push(payload),
    ...extra,
  });
  t.after(() => handle.dispose());
  const iframe = host.querySelector('iframe');
  const load = () => iframe.dispatchEvent(new dom.window.Event('load'));
  return { dom, host, iframe, handle, away, failures, load };
}

test('onNavigatedAway ignores the initial blank load and the first staged load, fires once on the next', async (t) => {
  const { iframe, away, failures, load } = makeNavFrame(t);
  load(); // initial about:blank load, before src is assigned
  await settleStaging();
  assert.ok(iframe.getAttribute('src'), 'src should be assigned by now');
  load(); // the staged document
  assert.equal(away.length, 0);
  load(); // the frame left its document
  load();
  assert.equal(away.length, 1, 'must fire exactly once');
  assert.ok(iframe.isConnected, 'the frame is not torn down; its owner disposes it');
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(failures.length, 0, 'navigating away must stop the boot timeout from failing');
});

test('after navigating away a late error message cannot fire onFailure', async (t) => {
  const { dom, iframe, handle, away, failures, load } = makeNavFrame(t, { timeoutMs: 5000 });
  await settleStaging();
  load();
  load();
  assert.equal(away.length, 1);
  frameMessage(dom, iframe, { type: 'error', requestId: handle.requestId, ok: false, error: 'late' });
  assert.equal(failures.length, 0);
});

test('without onNavigatedAway no load listener is registered', async (t) => {
  const { dom, host } = makeHost(t);
  const realCreate = dom.window.document.createElement.bind(dom.window.document);
  const listened = [];
  dom.window.document.createElement = (tag) => {
    const el = realCreate(tag);
    if (tag === 'iframe') {
      const realAdd = el.addEventListener.bind(el);
      el.addEventListener = (type, ...rest) => { listened.push(type); return realAdd(type, ...rest); };
    }
    return el;
  };
  const handle = createHtmlArtifactFrame(host, '<p>x</p>', {
    timeoutMs: 5000,
    stageDocument: makeStageStub().stageDocument,
  });
  t.after(() => handle.dispose());
  await settleStaging();
  assert.ok(!listened.includes('load'), `unexpected listeners: ${listened.join(',')}`);
});

test('dispose removes the load listener', async (t) => {
  const { dom, iframe, handle, away, load } = makeNavFrame(t, { timeoutMs: 5000 });
  await settleStaging();
  handle.dispose();
  iframe.dispatchEvent(new dom.window.Event('load'));
  iframe.dispatchEvent(new dom.window.Event('load'));
  assert.equal(away.length, 0);
  assert.equal(typeof load, 'function');
});
