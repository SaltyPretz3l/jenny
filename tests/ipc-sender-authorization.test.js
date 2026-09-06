'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const {
  createTrustedSenderAuthorizer,
  senderReason,
  trustedMainFrameUrl,
  unauthorizedIpcResult,
} = require('../services/main/ipc-sender-authorization');
const { getBridgeChannel, registerIpcInvokeHandlers } = require('../services/ipc-contract');

const EXPECTED_DOCUMENT = path.resolve(__dirname, '..', 'index.html');
const EXPECTED_URL = pathToFileURL(EXPECTED_DOCUMENT).href;

function harness({ url = EXPECTED_URL, frameUrl = url } = {}) {
  const session = {};
  const mainFrame = { url: frameUrl };
  const webContents = {
    id: 7,
    session,
    mainFrame,
    isDestroyed: () => false,
    getURL: () => url,
  };
  const window = { isDestroyed: () => false, webContents };
  return { event: { sender: webContents, senderFrame: mainFrame }, session, webContents, window };
}

test('trusted main frame is accepted only on the local index document', () => {
  const trusted = harness();
  assert.equal(senderReason(trusted.event, trusted.window, EXPECTED_DOCUMENT), '');
  assert.equal(trustedMainFrameUrl(`${EXPECTED_URL}?agent=1#ready`, EXPECTED_DOCUMENT), true);
  assert.equal(trustedMainFrameUrl(pathToFileURL(path.join(__dirname, 'attacker', 'index.html')), EXPECTED_DOCUMENT), false);
  assert.equal(trustedMainFrameUrl('https://example.test/index.html', EXPECTED_DOCUMENT), false);
  assert.equal(trustedMainFrameUrl(pathToFileURL(path.join(path.dirname(EXPECTED_DOCUMENT), 'other.html')), EXPECTED_DOCUMENT), false);
  assert.equal(trustedMainFrameUrl('file:///%E0%A4%A', EXPECTED_DOCUMENT), false);
});

test('foreign, destroyed, auxiliary-frame, session, and navigated senders are denied', () => {
  const trusted = harness();
  assert.equal(senderReason({ ...trusted.event, sender: {} }, trusted.window, EXPECTED_DOCUMENT), 'foreign_sender');
  assert.equal(senderReason({ sender: trusted.webContents, senderFrame: {} }, trusted.window, EXPECTED_DOCUMENT), 'foreign_frame');

  trusted.webContents.getURL = () => 'https://attacker.test/index.html';
  assert.equal(senderReason(trusted.event, trusted.window, EXPECTED_DOCUMENT), 'untrusted_navigation');
  trusted.webContents.getURL = () => EXPECTED_URL;
  trusted.event.senderFrame.url = pathToFileURL(path.join(__dirname, 'attacker', 'index.html')).href;
  assert.equal(senderReason(trusted.event, trusted.window, EXPECTED_DOCUMENT), 'untrusted_navigation');
  trusted.event.senderFrame.url = EXPECTED_URL;
  trusted.webContents.isDestroyed = () => true;
  assert.equal(senderReason(trusted.event, trusted.window, EXPECTED_DOCUMENT), 'window_contents_unavailable');

  const replayed = harness();
  assert.equal(senderReason({}, replayed.window, EXPECTED_DOCUMENT), 'sender_unavailable');
});

test('throwing or mismatched URL getters fail closed', () => {
  const trusted = harness();
  trusted.webContents.getURL = () => { throw new Error('secret URL failure'); };
  assert.equal(senderReason(trusted.event, trusted.window, EXPECTED_DOCUMENT), 'untrusted_navigation');

  const throwingFrame = harness();
  Object.defineProperty(throwingFrame.event.senderFrame, 'url', {
    get() { throw new Error('secret frame failure'); },
  });
  assert.equal(senderReason(throwingFrame.event, throwingFrame.window, EXPECTED_DOCUMENT), 'untrusted_navigation');
});

test('authorizer logs bounded metadata and returns a stable refusal envelope helper', () => {
  const events = [];
  const trusted = harness({ url: 'https://attacker.test/index.html?token=secret' });
  const authorize = createTrustedSenderAuthorizer({
    getMainWindow: () => trusted.window,
    expectedDocumentPath: EXPECTED_DOCUMENT,
    log: (...args) => events.push(args),
  });
  assert.equal(authorize(trusted.event, { methodPath: 'workspaceFs.delete' }), false);
  assert.deepEqual(events, [[
    'WARN',
    'ipc.sender_rejected',
    { reason: 'untrusted_navigation', method: 'workspaceFs.delete', senderId: 7 },
  ]]);
  assert.equal(JSON.stringify(events).includes('token=secret'), false);
  assert.deepEqual(unauthorizedIpcResult(), {
    ok: false,
    authorized: false,
    code: 'ipc_sender_unauthorized',
  });
});

test('spoofed same-named document cannot reach a privileged IPC handler', async () => {
  const spoofed = harness({ url: pathToFileURL(path.join(__dirname, 'attacker', 'index.html')).href });
  const registered = new Map();
  let calls = 0;
  const sentinel = { deleted: false };
  registerIpcInvokeHandlers({
    handle(channel, handler) { registered.set(channel, handler); },
  }, {
    'workspaceFs.delete': () => { calls += 1; sentinel.deleted = true; return { deleted: true }; },
  }, {
    authorize: createTrustedSenderAuthorizer({
      getMainWindow: () => spoofed.window,
      expectedDocumentPath: EXPECTED_DOCUMENT,
    }),
    unauthorizedResult: unauthorizedIpcResult,
  });

  const handler = registered.get(getBridgeChannel('workspaceFs.delete', 'invoke'));
  assert.deepEqual(await handler(spoofed.event), {
    ok: false, authorized: false, code: 'ipc_sender_unauthorized',
  });
  assert.equal(calls, 0);
  assert.equal(sentinel.deleted, false);
});
