'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { BrowserApp } = require('../renderer/browser/app');
const view = require('../renderer/browser/browser-view');

function harness(t) {
  const dom = new JSDOM('<div id="root"></div>');
  const previousDocument = Object.getOwnPropertyDescriptor(global, 'document');
  global.document = dom.window.document;
  const created = [];
  const revoked = [];
  const timers = [];
  t.mock.method(URL, 'createObjectURL', () => {
    const url = `blob:preview-test-${created.length + 1}`;
    created.push(url);
    return url;
  });
  t.mock.method(URL, 'revokeObjectURL', (url) => revoked.push(url));
  t.mock.method(global, 'setTimeout', (fn, delay) => {
    const timer = { fn, delay, cleared: false };
    timers.push(timer);
    return timer;
  });
  t.mock.method(global, 'clearTimeout', (timer) => { timer.cleared = true; });
  t.mock.method(dom.window.HTMLAnchorElement.prototype, 'click', () => {});
  const artifacts = [
    { artifact_id: 'a', file_name: 'a.png', mime_type: 'image/png' },
    { artifact_id: 'b', file_name: 'b.html', mime_type: 'text/html' },
    { artifact_id: 'text', file_name: 'text.txt', mime_type: 'text/plain' },
    { artifact_id: 'large', file_name: 'large.png', mime_type: 'image/png' },
  ];
  const root = dom.window.document.getElementById('root');
  const app = new BrowserApp({
    root, view,
    state: {
      authenticated: true, selectedSessionId: 'session', control: { owned: true }, planMode: false,
      sessions: [], attachments: [],
      snapshot: { session: { session_id: 'session' }, messages: [{ tool_result: { generated_artifacts: artifacts } }] },
    },
    bridge: {
      downloadArtifact: async (_session, id) => ({
        blob: new Blob([id === 'large' ? new Uint8Array(4 * 1024 * 1024 + 1) : 'content']),
        artifactMimeType: id === 'text' ? 'text/plain' : id === 'b' ? 'html' : 'png',
      }),
      command: async () => ({ ok: true, snapshot: null }),
    },
  });
  t.after(() => {
    app.dispose();
    if (previousDocument) Object.defineProperty(global, 'document', previousDocument);
    else delete global.document;
    dom.window.close();
  });
  return { app, root, created, revoked, timers };
}

test('preview A -> B revokes A immediately and preserves the separate download lifetime', async (t) => {
  const h = harness(t);
  await h.app._downloadArtifact('a', { preview: true });
  const previewA = h.root.querySelector('[data-artifact-previews] img').src;
  await h.app._downloadArtifact('a');
  const download = h.created[1];
  await h.app._downloadArtifact('b', { preview: true });
  const previewB = h.root.querySelector('[data-artifact-previews] iframe').src;
  assert.deepEqual(h.revoked, [previewA], 'replacement immediately revokes preview A only');
  h.timers.filter((timer) => !timer.cleared && timer.delay === 60_000).forEach((timer) => timer.fn());
  assert.deepEqual(h.revoked, [previewA, download], 'fallback timer revokes downloads and keeps displayed preview B');
  await h.app.selectSession('next');
  assert.deepEqual(h.revoked, [previewA, download, previewB], 'session removal immediately revokes displayed preview B');
});

for (const replacement of ['text', 'large']) {
  test(`a ${replacement} preview retires the previous Blob URL immediately`, async (t) => {
    const h = harness(t);
    await h.app._downloadArtifact('a', { preview: true });
    const url = h.created[0];
    await h.app._downloadArtifact(replacement, { preview: true });
    assert.equal(h.root.querySelector('[data-artifact-previews] img'), null);
    assert.deepEqual(h.revoked, [url], 'a preview without a Blob URL revokes its displaced URL');
  });
}

test('disposing the browser immediately revokes its displayed preview', async (t) => {
  const h = harness(t);
  await h.app._downloadArtifact('b', { preview: true });
  h.app.dispose();
  assert.deepEqual(h.revoked, h.created);
});
