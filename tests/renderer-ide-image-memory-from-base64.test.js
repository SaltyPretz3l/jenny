'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createImageMemory } = require('../renderer/features/renderer-ide-image-memory');

function apis() {
  const blobs = [];
  class FakeBlob {
    constructor(parts, opts) { this.parts = parts; this.type = opts?.type || ''; blobs.push(this); }
  }
  return {
    blobs,
    urlApi: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    BlobCtor: FakeBlob,
  };
}

test('decodes with the native fromBase64 when available (no atob byte loop)', () => {
  const env = apis();
  const decoded = [];
  const memory = createImageMemory({
    urlApi: env.urlApi,
    BlobCtor: env.BlobCtor,
    atobFn: () => { throw new Error('atob path must not run'); },
    fromBase64Fn: (value) => { decoded.push(value); return Uint8Array.from(Buffer.from(value, 'base64')); },
  });
  const doc = { kind: 'image' };
  memory.applyPayload(doc, { base64: 'UE5H', mime: 'image/png', size: 3 });
  assert.deepEqual(decoded, ['UE5H']);
  assert.equal(doc.blobUrl, 'blob:x');
  assert.deepEqual([...env.blobs[0].parts[0]], [...Buffer.from('PNG')]);
});

test('falls back to atob when fromBase64 is unavailable', () => {
  const env = apis();
  const memory = createImageMemory({
    urlApi: env.urlApi,
    BlobCtor: env.BlobCtor,
    atobFn: (b) => Buffer.from(b, 'base64').toString('binary'),
    fromBase64Fn: null,
  });
  const doc = { kind: 'image' };
  memory.applyPayload(doc, { base64: 'UE5H', mime: 'image/png', size: 3 });
  assert.deepEqual([...env.blobs[0].parts[0]], [...Buffer.from('PNG')]);
});
