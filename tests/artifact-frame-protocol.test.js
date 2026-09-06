'use strict';

// services/artifact-frame-protocol.js — one-shot jenny-artifact:// document
// host for the sandboxed HTML preview frame. Pins: single-use serving, TTL +
// capacity eviction, the strict CSP response header (single-sourced from the
// renderer factory constant), size-cap rejection, and 404 on anything that is
// not a freshly staged id.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  ARTIFACT_FRAME_SCHEME,
  createArtifactFrameProtocol,
  registerArtifactFramePrivilegedScheme,
} = require('../services/artifact-frame-protocol.js');
const { HTML_ARTIFACT_FRAME_CSP } = require('../renderer/features/renderer-html-artifact-frame-utils.js');

function makeProtocol(overrides = {}) {
  let currentTime = 1_000;
  const instance = createArtifactFrameProtocol({
    now: () => currentTime,
    ...overrides,
  });
  return { instance, advance: (ms) => { currentTime += ms; } };
}

test('stageDocument returns a jenny-artifact URL and the entry serves exactly once', async () => {
  const { instance } = makeProtocol();
  const staged = instance.stageDocument('<!DOCTYPE html><p>doc</p>');
  assert.equal(staged.ok, true);
  assert.match(staged.url, new RegExp(`^${ARTIFACT_FRAME_SCHEME}://frame/[a-f0-9-]+$`));

  const first = instance.handleRequest({ url: staged.url });
  assert.equal(first.status, 200);
  assert.equal(await first.text(), '<!DOCTYPE html><p>doc</p>');
  assert.equal(first.headers.get('Content-Type'), 'text/html; charset=utf-8');

  const second = instance.handleRequest({ url: staged.url });
  assert.equal(second.status, 404, 'entries are one-shot: a second fetch must 404');
});

test('every served document carries the strict frame CSP header (single-sourced)', () => {
  const { instance } = makeProtocol();
  const staged = instance.stageDocument('<p>x</p>');
  const response = instance.handleRequest({ url: staged.url });
  assert.equal(response.headers.get('Content-Security-Policy'), HTML_ARTIFACT_FRAME_CSP);
  assert.ok(HTML_ARTIFACT_FRAME_CSP.includes("connect-src 'none'"), 'no-network contract must hold');
});

test('unknown ids, wrong hosts, and malformed URLs all 404', () => {
  const { instance } = makeProtocol();
  instance.stageDocument('<p>x</p>');
  assert.equal(instance.handleRequest({ url: 'jenny-artifact://frame/nope' }).status, 404);
  assert.equal(instance.handleRequest({ url: 'jenny-artifact://other/nope' }).status, 404);
  assert.equal(instance.handleRequest({ url: 'not a url' }).status, 404);
  assert.equal(instance.handleRequest({}).status, 404);
});

test('expired entries are not served and are evicted', () => {
  const { instance, advance } = makeProtocol({ entryTtlMs: 500 });
  const staged = instance.stageDocument('<p>x</p>');
  advance(501);
  assert.equal(instance.handleRequest({ url: staged.url }).status, 404);
  assert.equal(instance.entryCount(), 0);
});

test('capacity cap evicts the oldest entry, never grows unbounded', () => {
  const { instance } = makeProtocol({ maxEntries: 2 });
  const first = instance.stageDocument('<p>1</p>');
  instance.stageDocument('<p>2</p>');
  instance.stageDocument('<p>3</p>');
  assert.equal(instance.entryCount(), 2);
  assert.equal(instance.handleRequest({ url: first.url }).status, 404, 'oldest entry must be evicted');
});

test('non-string, empty, and oversized documents are refused', () => {
  const { instance } = makeProtocol({ maxDocumentBytes: 16 });
  assert.equal(instance.stageDocument(null).ok, false);
  assert.equal(instance.stageDocument('   ').ok, false);
  assert.equal(instance.stageDocument('x'.repeat(17)).ok, false);
  assert.equal(instance.entryCount(), 0, 'refused documents must not be stored');
});

test('install registers the protocol handler and the artifactFrame.stage invoke channel', () => {
  const { instance } = makeProtocol();
  const handled = [];
  const invokeHandlers = new Map();
  instance.install({
    sessionRef: { protocol: { handle: (scheme, handler) => handled.push({ scheme, handler }) } },
    ipcMainLike: { handle: (channel, handler) => invokeHandlers.set(channel, handler) },
  });
  assert.equal(handled.length, 1);
  assert.equal(handled[0].scheme, ARTIFACT_FRAME_SCHEME);
  assert.equal(typeof handled[0].handler, 'function');
  // Channel name comes from the ipc-contract descriptor, keeping the bridge
  // method path and the main-side registration in lockstep.
  assert.ok(invokeHandlers.has('artifact-frame:stage'), `channels registered: ${[...invokeHandlers.keys()]}`);
  const staged = invokeHandlers.get('artifact-frame:stage')({}, '<p>via ipc</p>');
  assert.equal(staged.ok, true);
});

test('dispose clears all staged entries', () => {
  const { instance } = makeProtocol();
  const staged = instance.stageDocument('<p>x</p>');
  instance.dispose();
  assert.equal(instance.entryCount(), 0);
  assert.equal(instance.handleRequest({ url: staged.url }).status, 404);
});

test('registerArtifactFramePrivilegedScheme registers standard+secure and nothing dangerous', () => {
  const calls = [];
  const registered = registerArtifactFramePrivilegedScheme({
    registerSchemesAsPrivileged: (schemes) => calls.push(schemes),
  });
  assert.equal(registered, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [
    { scheme: ARTIFACT_FRAME_SCHEME, privileges: { standard: true, secure: true } },
  ]);
  const privileges = calls[0][0].privileges;
  assert.ok(!('bypassCSP' in privileges), 'bypassCSP must never be granted');
  assert.ok(!('allowServiceWorkers' in privileges));
  assert.equal(registerArtifactFramePrivilegedScheme(null), false, 'fail-soft without a protocol module');
});

test('privileged scheme registration batches additional schemes into Electron single registration', () => {
  const calls = [];
  const additional = { scheme: 'jenny-plugin-view', privileges: { standard: true, secure: true } };
  assert.equal(registerArtifactFramePrivilegedScheme({
    registerSchemesAsPrivileged: (schemes) => calls.push(schemes),
  }, [additional]), true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].map((entry) => entry.scheme), ['jenny-artifact', 'jenny-plugin-view']);
});
