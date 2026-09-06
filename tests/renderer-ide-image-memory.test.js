'use strict';

/* UIUX-034: renderer-ide-image-memory.js owns the image-tab memory budget
 * previously missing from the Workspace IDE editor host - up to MAX_OPEN_TABS
 * (64) image tabs at the 10 MB workspace-fs read cap could retain roughly
 * 850 MB of base64 with no eviction and no revocation. These are pure unit
 * tests against the sibling module (no DOM, no controller): injected fake
 * urlApi/BlobCtor/atobFn stand in for the real browser APIs so the blob path
 * is exercised deterministically regardless of jsdom's lack of
 * URL.createObjectURL. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createImageMemory, base64ByteLength } = require('../renderer/features/renderer-ide-image-memory');

function makeFakeBrowserApis() {
  const created = [];
  const revoked = [];
  let counter = 0;
  const urlApi = {
    createObjectURL(blob) {
      const url = `blob:fake-${counter += 1}`;
      created.push({ url, size: blob.size });
      return url;
    },
    revokeObjectURL(url) {
      revoked.push(url);
    },
  };
  class FakeBlob {
    constructor(parts, opts) {
      this.size = parts.reduce((sum, part) => sum + part.length, 0);
      this.type = opts?.type || '';
    }
  }
  // Real base64 decode so byte-length math matches production behavior.
  const atobFn = (base64) => Buffer.from(base64, 'base64').toString('binary');
  return {
    urlApi, BlobCtor: FakeBlob, atobFn, created, revoked,
  };
}

function makeDoc() {
  return { kind: 'image' };
}

test('base64ByteLength matches the true decoded byte length (with and without padding)', () => {
  const raw = Buffer.from('hello world', 'utf8');
  const base64 = raw.toString('base64');
  assert.equal(base64ByteLength(base64), raw.length);
  assert.equal(base64ByteLength(''), 0);
  assert.equal(base64ByteLength(Buffer.from('a', 'utf8').toString('base64')), 1);
});

test('applyPayload decodes into a Blob/object URL and never retains the base64 string when the runtime supports it', () => {
  const apis = makeFakeBrowserApis();
  const memory = createImageMemory({ urlApi: apis.urlApi, BlobCtor: apis.BlobCtor, atobFn: apis.atobFn });
  const doc = makeDoc();
  const base64 = Buffer.from('PNGBYTES', 'utf8').toString('base64');

  memory.applyPayload(doc, { base64, mime: 'image/png' });

  assert.equal(doc.base64, '', 'base64 must not be retained once a blob URL exists');
  assert.match(doc.blobUrl, /^blob:fake-/);
  assert.equal(doc.byteLength, 8, 'PNGBYTES is 8 bytes');
  assert.equal(apis.created.length, 1);
  assert.equal(apis.created[0].size, 8);
});

test('applyPayload falls back to base64 data-URL storage when the runtime has no object-URL support', () => {
  const memory = createImageMemory({ getWindow: () => null });
  const doc = makeDoc();
  const base64 = Buffer.from('PNGBYTES', 'utf8').toString('base64');

  memory.applyPayload(doc, { base64, mime: 'image/png' });

  assert.equal(doc.blobUrl, null);
  assert.equal(doc.base64, base64, 'base64 fallback path must still render something');
  assert.equal(doc.byteLength, 8);
});

test('release revokes the object URL and clears the payload fields', () => {
  const apis = makeFakeBrowserApis();
  const memory = createImageMemory({ urlApi: apis.urlApi, BlobCtor: apis.BlobCtor, atobFn: apis.atobFn });
  const doc = makeDoc();
  memory.applyPayload(doc, { base64: Buffer.from('abc', 'utf8').toString('base64'), mime: 'image/png' });
  const blobUrl = doc.blobUrl;

  memory.release(doc);

  assert.deepEqual(apis.revoked, [blobUrl]);
  assert.equal(doc.blobUrl, null);
  assert.equal(doc.base64, '');
  assert.equal(doc.byteLength, 0);
  assert.equal(memory.getDiagnostics().residentBytes, 0);
});

test('a refresh (second applyPayload on the same doc) releases the old payload before counting the new one', () => {
  const apis = makeFakeBrowserApis();
  const memory = createImageMemory({ urlApi: apis.urlApi, BlobCtor: apis.BlobCtor, atobFn: apis.atobFn });
  const doc = makeDoc();
  memory.applyPayload(doc, { base64: Buffer.from('aaaaaaaaaa', 'utf8').toString('base64'), mime: 'image/png' }); // 10 bytes
  const firstBlobUrl = doc.blobUrl;
  memory.applyPayload(doc, { base64: Buffer.from('bb', 'utf8').toString('base64'), mime: 'image/png' }); // 2 bytes

  assert.deepEqual(apis.revoked, [firstBlobUrl], 'the stale blob URL from the first payload must be revoked');
  assert.equal(memory.getDiagnostics().residentBytes, 2, 'resident bytes reflect only the current payload, not both');
});

test('enforceBudget evicts least-recently-used image tabs once the resident budget is crossed, never the excluded (active) path', () => {
  const apis = makeFakeBrowserApis();
  const memory = createImageMemory({
    urlApi: apis.urlApi, BlobCtor: apis.BlobCtor, atobFn: apis.atobFn, budgetBytes: 15,
  });
  const docs = { a: makeDoc(), b: makeDoc(), c: makeDoc() };
  const evicted = [];
  const evict = (path) => { evicted.push(path); memory.discard(path, docs[path]); };

  memory.applyPayload(docs.a, { base64: Buffer.from('aaaaaaaaaa', 'utf8').toString('base64'), mime: 'image/png' }); // 10 bytes
  memory.registerOpen('a', evict);
  memory.applyPayload(docs.b, { base64: Buffer.from('bbbbbbbbbb', 'utf8').toString('base64'), mime: 'image/png' }); // 10 bytes, total 20 > 15
  memory.registerOpen('b', evict);

  assert.deepEqual(evicted, ['a'], 'the older, non-active tab is evicted first');
  assert.equal(docs.a.blobUrl, null, 'evicted doc payload is released');
  assert.equal(memory.getDiagnostics().residentBytes, 10, 'only b\'s bytes remain resident');

  // Opening c should evict b next (a is already gone) rather than touching c
  // itself, since c is the tab just opened (excludePath).
  memory.applyPayload(docs.c, { base64: Buffer.from('cccccccccc', 'utf8').toString('base64'), mime: 'image/png' });
  memory.registerOpen('c', evict);
  assert.deepEqual(evicted, ['a', 'b']);
  assert.equal(memory.getDiagnostics().residentBytes, 10, 'only c remains');
});

test('touch() re-orders a path to most-recently-used, changing which tab the next eviction picks', () => {
  const apis = makeFakeBrowserApis();
  const memory = createImageMemory({
    urlApi: apis.urlApi, BlobCtor: apis.BlobCtor, atobFn: apis.atobFn, budgetBytes: 35,
  });
  const docs = { a: makeDoc(), b: makeDoc(), c: makeDoc(), d: makeDoc() };
  const evicted = [];
  const evict = (path) => { evicted.push(path); memory.discard(path, docs[path]); };
  const tenBytes = (letter) => Buffer.from(letter.repeat(10), 'utf8').toString('base64');

  memory.applyPayload(docs.a, { base64: tenBytes('a'), mime: 'image/png' });
  memory.registerOpen('a', evict); // resident 10, LRU order [a]
  memory.applyPayload(docs.b, { base64: tenBytes('b'), mime: 'image/png' });
  memory.registerOpen('b', evict); // resident 20, LRU order [a, b]
  memory.applyPayload(docs.c, { base64: tenBytes('c'), mime: 'image/png' });
  memory.registerOpen('c', evict); // resident 30 (<=35, no eviction yet), LRU order [a, b, c]

  // A tab switch back to 'a' (the oldest) moves it to MRU: [b, c, a].
  memory.touch('a');

  memory.applyPayload(docs.d, { base64: tenBytes('d'), mime: 'image/png' });
  memory.registerOpen('d', evict); // resident 40 > 35, must evict someone

  // Without the touch(), 'a' (opened first) would be evicted; the touch moved
  // it to MRU, so 'b' - now the oldest untouched tab - is evicted instead.
  assert.deepEqual(evicted, ['b']);
  assert.equal(docs.a.blobUrl !== null, true, 'the touched tab survives the eviction pass');
});

test('discard() is release() + forget() together (no lingering LRU entry after eviction)', () => {
  const apis = makeFakeBrowserApis();
  const memory = createImageMemory({ urlApi: apis.urlApi, BlobCtor: apis.BlobCtor, atobFn: apis.atobFn });
  const doc = makeDoc();
  memory.applyPayload(doc, { base64: Buffer.from('abc', 'utf8').toString('base64'), mime: 'image/png' });
  memory.touch('a');

  memory.discard('a', doc);

  assert.equal(memory.getDiagnostics().trackedCount, 0);
  assert.equal(doc.blobUrl, null);
});
