'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  GgufHeaderError, readGgufHeader, readGgufArchitecture, GGUF_KV_TYPES,
} = require('../services/gguf-header');

function integer(value, bytes = 4) {
  const buffer = Buffer.alloc(bytes);
  if (bytes === 8) buffer.writeBigUInt64LE(BigInt(value));
  else buffer.writeUInt32LE(value);
  return buffer;
}

function string(value) {
  const bytes = Buffer.from(value);
  return Buffer.concat([integer(bytes.length, 8), bytes]);
}

function value(type, data) {
  if (type === 8) return string(data);
  if (type === 9) {
    return Buffer.concat([
      integer(data.type), integer(data.values.length, 8),
      ...data.values.map((item) => value(data.type, item)),
    ]);
  }
  const writers = {
    0: ['writeUInt8', 1], 1: ['writeInt8', 1],
    2: ['writeUInt16LE', 2], 3: ['writeInt16LE', 2],
    4: ['writeUInt32LE', 4], 5: ['writeInt32LE', 4],
    6: ['writeFloatLE', 4], 7: ['writeUInt8', 1],
    10: ['writeBigUInt64LE', 8], 11: ['writeBigInt64LE', 8],
    12: ['writeDoubleLE', 8],
  };
  if (!writers[type]) return Buffer.alloc(0);
  const [writer, size] = writers[type];
  const bytes = Buffer.alloc(size);
  bytes[writer](type === 7 ? Number(data) : data);
  return bytes;
}

function gguf(pairs, version = 3) {
  return Buffer.concat([
    Buffer.from('GGUF'), integer(version), integer(0, 8), integer(pairs.length, 8),
    ...pairs.map(([key, type, data]) => Buffer.concat([string(key), integer(type), value(type, data)])),
  ]);
}

function fixture(t, bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-gguf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'test.gguf');
  fs.writeFileSync(file, bytes);
  return file;
}

const happyPairs = [
  ['strings', 9, { type: 8, values: ['one', 'two'] }],
  ['fixed', 9, { type: 4, values: [1, 2, 3] }],
  ['count', 4, 42], ['scale', 6, 2.5], ['enabled', 7, true],
  ['large', 10, 9007199254740993n], ['general.architecture', 8, 'qwen_image21'],
];

test('v3 scalars and skipped arrays; v2 header', (t) => {
  const file = fixture(t, gguf(happyPairs));
  assert.deepEqual(readGgufHeader(file), {
    version: 3, architecture: 'qwen_image21',
    kv: { count: 42, scale: 2.5, enabled: true, large: '9007199254740993', 'general.architecture': 'qwen_image21' },
  });
  fs.writeFileSync(file, gguf([['general.architecture', 8, 'qwen_image']], 2));
  assert.equal(readGgufHeader(file).version, 2);
  assert.equal(readGgufHeader(file).architecture, 'qwen_image');
  assert.equal(GGUF_KV_TYPES.ARRAY, 9);
});

test('every incomplete prefix throws truncated rather than RangeError', (t) => {
  const bytes = gguf(happyPairs);
  const file = fixture(t, bytes);
  for (let length = 0; length < bytes.length; length += 1) {
    fs.writeFileSync(file, bytes.subarray(0, length));
    assert.throws(() => readGgufHeader(file), (error) =>
      error instanceof GgufHeaderError && error.name === 'GgufHeaderError' && error.reason === 'truncated',
    `prefix length ${length}`);
  }
});

test('bounds, format errors, and nested arrays have machine reasons', (t) => {
  const file = fixture(t, Buffer.alloc(0));
  const cases = [
    [gguf([], 1), {}, 'unsupported_version'],
    [Buffer.concat([Buffer.from('NOPE'), gguf([]).subarray(4)]), {}, 'bad_magic'],
    [Buffer.concat([Buffer.from([0xc7, 0xc7, 0xd5, 0xc6]), gguf([]).subarray(4)]), {}, 'bad_magic'],
    [gguf([['x', 99, null]]), {}, 'unknown_type'],
    [gguf([['x', 9, { type: 9, values: [] }]]), {}, 'unsupported_nested_array'],
    [gguf([['x', 9, { type: 99, values: [] }]]), {}, 'unknown_type'],
    [gguf(happyPairs), { maxKv: 1 }, 'too_many_kv'],
    [Buffer.concat([gguf([]).subarray(0, 16), integer(4097, 8)]), {}, 'too_many_kv'],
    [Buffer.concat([gguf([]).subarray(0, 16), integer(1, 8), integer(65537, 8)]), {}, 'string_too_long'],
    [gguf([['x', 8, 'long']]), { maxString: 3 }, 'string_too_long'],
    [gguf([['x', 9, { type: 8, values: ['long'] }]]), { maxString: 3 }, 'string_too_long'],
    [gguf(happyPairs), { maxBytes: 24 }, 'truncated'],
  ];
  for (const [bytes, options, reason] of cases) {
    fs.writeFileSync(file, bytes);
    assert.throws(() => readGgufHeader(file, options), { name: 'GgufHeaderError', reason });
  }
});

test('all scalar types, safe integer boundaries, and arbitrary keys', (t) => {
  const pairs = [
    ['u8', 0, 255], ['i8', 1, -128], ['u16', 2, 65535], ['i16', 3, -32768],
    ['i32', 5, -123], ['u64', 10, 9007199254740991n], ['i64', 11, -9007199254740992n],
    ['safeNegative', 11, -123n], ['double', 12, 0.125], ['__proto__', 8, 'literal'],
    ['general.architecture', 4, 1],
  ];
  const result = readGgufHeader(fixture(t, gguf(pairs)));
  assert.equal(result.architecture, null);
  for (const [key, , data] of pairs) {
    const expected = typeof data === 'bigint'
      ? (data < -9007199254740991n || data > 9007199254740991n ? String(data) : Number(data)) : data;
    assert.equal(result.kv[key], expected);
  }
  assert.equal(Object.hasOwn(result.kv, '__proto__'), true);
});

test('bounded reads tolerate short reads and close on read failure', (t) => {
  const file = fixture(t, gguf(happyPairs));
  let total = 0;
  let closes = 0;
  const fsImpl = {
    ...fs,
    readSync(fd, buffer, offset, length, position) {
      const read = fs.readSync(fd, buffer, offset, Math.min(length, 7), position);
      total += read;
      return read;
    },
    closeSync(fd) { closes += 1; fs.closeSync(fd); },
  };
  assert.throws(() => readGgufHeader(file, { fsImpl, maxBytes: 30 }), { reason: 'truncated' });
  assert.equal(total, 30);
  assert.equal(closes, 1);
  fsImpl.readSync = () => { throw new Error('read failed'); };
  assert.throws(() => readGgufHeader(file, { fsImpl }), { reason: 'unreadable' });
  assert.equal(closes, 2);
});

test('architecture lookup caches size and mtime; unreadable files return null', (t) => {
  const file = fixture(t, gguf(happyPairs));
  const cache = new Map();
  let opens = 0;
  const fsImpl = { ...fs, openSync(...args) { opens += 1; return fs.openSync(...args); } };
  assert.equal(readGgufArchitecture(file, { fsImpl, cache }), 'qwen_image21');
  assert.equal(readGgufArchitecture(file, { fsImpl, cache }), 'qwen_image21');
  assert.equal(opens, 1);
  fs.appendFileSync(file, Buffer.alloc(1));
  assert.equal(readGgufArchitecture(file, { fsImpl, cache }), 'qwen_image21');
  assert.equal(opens, 2);
  const previous = fs.statSync(file).mtimeMs;
  fs.utimesSync(file, new Date(previous + 10000), new Date(previous + 10000));
  assert.equal(readGgufArchitecture(file, { fsImpl, cache }), 'qwen_image21');
  assert.equal(opens, 3);
  fs.writeFileSync(file, 'not a GGUF');
  assert.equal(readGgufArchitecture(file, { fsImpl, cache }), null);
  assert.equal(readGgufArchitecture(`${file}.missing`, { fsImpl, cache }), null);
  fs.writeFileSync(file, gguf([]));
  assert.equal(readGgufArchitecture(file, { fsImpl, cache }), null);
});

test('architecture lookup stops at its key and caps reads at one MiB', (t) => {
  const bytes = gguf([['general.architecture', 8, 'qwen_image21'], ['later', 8, 'incomplete']]);
  const file = fixture(t, bytes.subarray(0, bytes.length - 5));
  assert.equal(readGgufArchitecture(file, { cache: new Map() }), 'qwen_image21');
  assert.throws(() => readGgufHeader(file), { reason: 'truncated' });
  fs.writeFileSync(file, Buffer.concat([gguf([['general.architecture', 8, 'qwen_image21']]), Buffer.alloc(2 * 1024 * 1024)]));
  let readBytes = 0;
  const fsImpl = { ...fs, readSync(...args) { const count = fs.readSync(...args); readBytes += count; return count; } };
  assert.equal(readGgufArchitecture(file, { fsImpl, cache: new Map() }), 'qwen_image21');
  assert.equal(readBytes, 1024 * 1024);
});

test('architecture cache drops the oldest insertion at 512 entries', (t) => {
  const file = fixture(t, gguf([['general.architecture', 8, 'qwen_image21']]));
  const cache = new Map();
  const fsImpl = { ...fs, statSync: () => fs.statSync(file), openSync: () => fs.openSync(file, 'r') };
  for (let index = 0; index < 513; index += 1) {
    assert.equal(readGgufArchitecture(`model-${index}`, { fsImpl, cache }), 'qwen_image21');
  }
  assert.equal(cache.size, 512);
  assert.equal(cache.has('model-0'), false);
  assert.equal(cache.has('model-1'), true);
});
