'use strict';

const fs = require('node:fs');

const GGUF_KV_TYPES = Object.freeze({
  UINT8: 0, INT8: 1, UINT16: 2, INT16: 3, UINT32: 4, INT32: 5,
  FLOAT32: 6, BOOL: 7, STRING: 8, ARRAY: 9, UINT64: 10, INT64: 11, FLOAT64: 12,
});
const SCALARS = {
  0: [1, 'readUInt8'], 1: [1, 'readInt8'],
  2: [2, 'readUInt16LE'], 3: [2, 'readInt16LE'],
  4: [4, 'readUInt32LE'], 5: [4, 'readInt32LE'],
  6: [4, 'readFloatLE'], 7: [1, 'readUInt8'],
  10: [8, 'readBigUInt64LE'], 11: [8, 'readBigInt64LE'], 12: [8, 'readDoubleLE'],
};
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const defaultCache = new Map();
// Private mode keeps architecture lookup on the same bounded reader/parser.
const ARCHITECTURE_ONLY = Symbol('architectureOnly');

class GgufHeaderError extends Error {
  constructor(reason, message = reason.replaceAll('_', ' ')) {
    super(message);
    this.name = 'GgufHeaderError';
    this.reason = reason;
  }
}

function readPrefix(filePath, maxBytes, fsImpl) {
  try {
    const fd = fsImpl.openSync(filePath, 'r');
    try {
      const { size } = fsImpl.fstatSync(fd);
      const buffer = Buffer.alloc(Math.min(size, maxBytes));
      let offset = 0;
      while (offset < buffer.length) {
        const count = fsImpl.readSync(fd, buffer, offset, buffer.length - offset, offset);
        if (count === 0) break;
        offset += count;
      }
      return buffer.subarray(0, offset);
    } finally {
      fsImpl.closeSync(fd);
    }
  } catch (_error) {
    throw new GgufHeaderError('unreadable', 'Cannot read GGUF header');
  }
}

function parseHeader(buffer, { maxKv, maxString, architectureOnly }) {
  let offset = 0;
  function requireBytes(count) {
    if (count > buffer.length - offset) throw new GgufHeaderError('truncated', 'Incomplete GGUF header');
  }
  function readNumber(bytes, method) {
    requireBytes(bytes);
    const result = buffer[method](offset);
    offset += bytes;
    return result;
  }
  function string(decode = true) {
    const length = readNumber(8, 'readBigUInt64LE');
    if (length > BigInt(maxString)) throw new GgufHeaderError('string_too_long');
    const bytes = Number(length);
    requireBytes(bytes);
    const result = decode ? buffer.toString('utf8', offset, offset + bytes) : null;
    offset += bytes;
    return result;
  }
  function skipArray() {
    const type = readNumber(4, 'readUInt32LE');
    const count = readNumber(8, 'readBigUInt64LE');
    if (type === GGUF_KV_TYPES.ARRAY) throw new GgufHeaderError('unsupported_nested_array');
    if (type === GGUF_KV_TYPES.STRING) {
      for (let index = 0n; index < count; index += 1n) string(false);
    } else {
      const scalar = SCALARS[type];
      if (!scalar) throw new GgufHeaderError('unknown_type');
      const bytes = count * BigInt(scalar[0]);
      if (bytes > BigInt(buffer.length - offset)) throw new GgufHeaderError('truncated');
      offset += Number(bytes);
    }
  }
  function scalar(type) {
    if (type === GGUF_KV_TYPES.STRING) return string();
    const spec = SCALARS[type];
    if (!spec) throw new GgufHeaderError('unknown_type');
    const result = readNumber(...spec);
    if (typeof result === 'bigint') {
      return result > MAX_SAFE || result < -MAX_SAFE ? result.toString() : Number(result);
    }
    return type === GGUF_KV_TYPES.BOOL ? result !== 0 : result;
  }

  requireBytes(4);
  if (!buffer.subarray(0, 4).equals(Buffer.from('GGUF'))) throw new GgufHeaderError('bad_magic');
  offset = 4;
  const version = readNumber(4, 'readUInt32LE');
  if (version !== 2 && version !== 3) throw new GgufHeaderError('unsupported_version');
  readNumber(8, 'readBigUInt64LE'); // Tensor metadata is outside this reader's scope.
  const count = readNumber(8, 'readBigUInt64LE');
  if (count > BigInt(maxKv)) throw new GgufHeaderError('too_many_kv');
  const kv = {};
  for (let index = 0; index < Number(count); index += 1) {
    const key = string();
    const type = readNumber(4, 'readUInt32LE');
    if (type === GGUF_KV_TYPES.ARRAY) skipArray();
    else Object.defineProperty(kv, key, { value: scalar(type), enumerable: true, writable: true, configurable: true });
    if (architectureOnly && key === 'general.architecture') break;
  }
  return { version, architecture: typeof kv['general.architecture'] === 'string' ? kv['general.architecture'] : null, kv };
}

function readGgufHeader(filePath, options = {}) {
  const { maxBytes = 4 * 1024 * 1024, maxKv = 4096, maxString = 65536, fsImpl = fs } = options;
  if (![maxBytes, maxKv, maxString].every((limit) => Number.isSafeInteger(limit) && limit >= 0)) {
    throw new GgufHeaderError('invalid_limits');
  }
  return parseHeader(readPrefix(filePath, maxBytes, fsImpl), {
    maxKv, maxString, architectureOnly: options[ARCHITECTURE_ONLY] === true,
  });
}

function readGgufArchitecture(filePath, { fsImpl = fs, cache = defaultCache } = {}) {
  try {
    const { size, mtimeMs } = fsImpl.statSync(filePath);
    const previous = cache.get(filePath);
    if (previous && previous.size === size && previous.mtimeMs === mtimeMs) return previous.architecture;
    let architecture = null;
    try {
      architecture = readGgufHeader(filePath, {
        maxBytes: 1024 * 1024, fsImpl, [ARCHITECTURE_ONLY]: true,
      }).architecture;
    } catch (_error) { /* Unreadable or unsupported headers have no architecture. */ }
    cache.set(filePath, { size, mtimeMs, architecture });
    while (cache.size > 512) cache.delete(cache.keys().next().value);
    return architecture;
  } catch (_error) {
    return null;
  }
}

module.exports = { GgufHeaderError, readGgufHeader, readGgufArchitecture, GGUF_KV_TYPES };
