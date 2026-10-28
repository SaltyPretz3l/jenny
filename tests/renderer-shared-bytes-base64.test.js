'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { decodeBase64, encodeBase64 } = require('../renderer/shared/bytes-base64');

function sampleBytes(length) {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = (index * 31 + 7) & 0xff;
  return bytes;
}

// Runs `body` with the native Uint8Array codecs hidden, so the atob/btoa
// fallback is exercised whatever the Node version provides.
function withoutNativeCodecs(body) {
  const fromBase64 = Object.getOwnPropertyDescriptor(Uint8Array, 'fromBase64');
  const toBase64 = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'toBase64');
  if (fromBase64) delete Uint8Array.fromBase64;
  if (toBase64) delete Uint8Array.prototype.toBase64;
  try {
    body();
  } finally {
    if (fromBase64) Object.defineProperty(Uint8Array, 'fromBase64', fromBase64);
    if (toBase64) Object.defineProperty(Uint8Array.prototype, 'toBase64', toBase64);
  }
}

test('the fallback codecs round-trip bytes across chunk boundaries', () => {
  withoutNativeCodecs(() => {
    for (const length of [0, 1, 2, 3, 0x2000 - 1, 0x2000, 0x2000 + 1, 0x2000 * 3 + 5]) {
      const bytes = sampleBytes(length);
      const encoded = encodeBase64(bytes);
      assert.equal(encoded, Buffer.from(bytes).toString('base64'), `encode ${length}`);
      assert.deepEqual(decodeBase64(encoded), bytes, `decode ${length}`);
    }
    assert.equal(decodeBase64(null).length, 0);
    assert.throws(() => decodeBase64('not*base64'));
  });
});

test('native codecs are preferred when the engine provides them', () => {
  const calls = [];
  const fromBase64 = Object.getOwnPropertyDescriptor(Uint8Array, 'fromBase64');
  Object.defineProperty(Uint8Array, 'fromBase64', {
    configurable: true, writable: true, value: (text) => { calls.push(['from', text]); return new Uint8Array([9]); },
  });
  try {
    assert.deepEqual(decodeBase64('AQ=='), new Uint8Array([9]));
    const bytes = new Uint8Array([1, 2]);
    bytes.toBase64 = () => { calls.push(['to']); return 'native'; };
    assert.equal(encodeBase64(bytes), 'native');
  } finally {
    if (fromBase64) Object.defineProperty(Uint8Array, 'fromBase64', fromBase64);
    else delete Uint8Array.fromBase64;
  }
  assert.deepEqual(calls, [['from', 'AQ=='], ['to']]);
});
