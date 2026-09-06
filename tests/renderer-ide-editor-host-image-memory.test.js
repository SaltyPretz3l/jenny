'use strict';

/* UIUX-034 end-to-end: renderer-ide-editor-host.js wired to the real
 * renderer-ide-image-host.js and renderer-ide-image-memory.js modules (not
 * stubbed out, unlike the other editor-host test files - the point here is
 * to prove the actual production wiring, not just the sibling module in
 * isolation). The jsdom window is patched with fake URL.createObjectURL/
 * revokeObjectURL (jsdom itself doesn't implement them - confirmed absent -
 * but does provide real Blob/atob), which is exactly the code path
 * getWindow() resolves through in a real Electron/Chromium renderer. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeEditorHost } = require('../renderer/features/renderer-ide-editor-host');
const imageHostUtils = require('../renderer/features/renderer-ide-image-host');

function makeHost({ budgetBytes } = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="ideEditorHost"></div></body>');
  const created = [];
  const revoked = [];
  let counter = 0;
  dom.window.URL.createObjectURL = (blob) => {
    const url = `blob:fake-${counter += 1}`;
    created.push({ url, size: blob.size });
    return url;
  };
  dom.window.URL.revokeObjectURL = (url) => revoked.push(url);
  const host = createIdeEditorHost({
    getDom: () => ({ ideEditorHost: dom.window.document.getElementById('ideEditorHost') }),
    monacoUtils: { ensureMonacoEditorApi: async () => null, normalizeEditorLanguage: () => 'plaintext' },
    imageHostUtils,
    previewHostUtils: {},
    imageMemoryOptions: budgetBytes ? { budgetBytes } : undefined,
  });
  return {
    host, dom, created, revoked,
  };
}

function tenByteBase64(letter) {
  return Buffer.from(letter.repeat(10), 'utf8').toString('base64');
}

test('opening an image tab renders through a real blob: object URL, not a retained base64 data URL', async (t) => {
  const { host, dom, created } = makeHost();
  t.after(() => host.dispose());

  host.openImageDocument({
    path: 'a.png', base64: tenByteBase64('a'), mime: 'image/png', size: 10, mtimeMs: 1,
  });
  host.activateDocument('a.png');

  const img = dom.window.document.querySelector('.ide-image-el');
  assert.match(img.src, /^blob:fake-/, 'the real image pane receives a blob: URL, not data:');
  assert.equal(created.length, 1);
  assert.equal(created[0].size, 10);
});

test('closing an image tab revokes its object URL', async (t) => {
  const { host, revoked, created } = makeHost();
  t.after(() => host.dispose());

  host.openImageDocument({
    path: 'a.png', base64: tenByteBase64('a'), mime: 'image/png', size: 10, mtimeMs: 1,
  });
  host.activateDocument('a.png');
  const blobUrl = created[0].url;

  host.closeDocument('a.png');

  assert.deepEqual(revoked, [blobUrl]);
  assert.equal(host.hasDocument('a.png'), false);
});

test('a byte-budget breach evicts the least-recently-touched background image tab, revoking it, and the next activation re-reads from disk', async (t) => {
  const { host, revoked } = makeHost({ budgetBytes: 15 });
  t.after(() => host.dispose());

  host.openImageDocument({
    path: 'a.png', base64: tenByteBase64('a'), mime: 'image/png', size: 10, mtimeMs: 1,
  });
  host.activateDocument('a.png'); // touched
  host.openImageDocument({
    path: 'b.png', base64: tenByteBase64('b'), mime: 'image/png', size: 10, mtimeMs: 1,
  }); // resident now 20 > 15 -> evicts 'a' (oldest, not the tab just opened)
  host.activateDocument('b.png');

  assert.equal(host.hasDocument('a.png'), false, 'the evicted tab is fully removed, exactly like a real close');
  assert.equal(host.hasDocument('b.png'), true);
  assert.equal(revoked.length, 1, 'the evicted tab\'s object URL was revoked, not leaked');
});

test('dispose() revokes every still-open image tab\'s object URL', async (t) => {
  const { host, revoked, created } = makeHost();
  host.openImageDocument({
    path: 'a.png', base64: tenByteBase64('a'), mime: 'image/png', size: 10, mtimeMs: 1,
  });
  host.openImageDocument({
    path: 'b.png', base64: tenByteBase64('b'), mime: 'image/png', size: 10, mtimeMs: 1,
  });

  host.dispose();

  assert.equal(revoked.length, created.length);
  assert.equal(created.length, 2);
});

test('an external-change refresh (second openImageDocument on the same path) revokes the stale object URL, never doubling resident bytes', async (t) => {
  const { host, revoked, created } = makeHost({ budgetBytes: 100 });
  t.after(() => host.dispose());

  host.openImageDocument({
    path: 'a.png', base64: tenByteBase64('a'), mime: 'image/png', size: 10, mtimeMs: 1,
  });
  const firstBlobUrl = created[0].url;
  host.openImageDocument({
    path: 'a.png', base64: tenByteBase64('z'), mime: 'image/png', size: 10, mtimeMs: 2,
  });

  assert.deepEqual(revoked, [firstBlobUrl]);
  assert.equal(created.length, 2);
});
