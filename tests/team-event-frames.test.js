'use strict';

// The member client's event-stream frame parser (team slice 2a-4a): raw chunks in,
// complete `{ id, event, data }` frames out, in order. Frames split anywhere
// (inside a multi-byte character too), several frames per chunk, comments and
// heartbeats ignored, and a hard per-frame byte bound. Pure: no timers, no I/O.

const assert = require('node:assert/strict');
const test = require('node:test');

const { MAX_FRAME_BYTES, createFrameParser } = require('../services/team/event-frames');

const frameText = (id, data) => `id: ${id}\nevent: jenny\ndata: ${data}\n\n`;

function feedAll(parser, chunks) {
  const frames = [];
  let error = null;
  for (const chunk of chunks) {
    const result = parser.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8'));
    frames.push(...result.frames);
    if (result.error) error = result.error;
  }
  return { frames, error };
}

test('one frame', () => {
  const { frames, error } = feedAll(createFrameParser(), [frameText('boot_a:1', '{"cursor":1}')]);
  assert.equal(error, null);
  assert.deepEqual(frames, [{ id: 'boot_a:1', event: 'jenny', data: '{"cursor":1}' }]);
});

test('a frame split at every byte position gives the same frame', () => {
  const bytes = Buffer.from(frameText('boot_a:7', '{"text":"Grüße 👋 done"}'), 'utf8');
  const expected = [{ id: 'boot_a:7', event: 'jenny', data: '{"text":"Grüße 👋 done"}' }];
  for (let at = 1; at < bytes.length; at += 1) {
    const { frames, error } = feedAll(createFrameParser(), [bytes.subarray(0, at), bytes.subarray(at)]);
    assert.equal(error, null, `split at ${at}`);
    assert.deepEqual(frames, expected, `split at ${at}`);
  }
  // And one byte at a time.
  const single = [];
  for (let index = 0; index < bytes.length; index += 1) single.push(bytes.subarray(index, index + 1));
  assert.deepEqual(feedAll(createFrameParser(), single).frames, expected);
});

test('three frames in one chunk arrive in order', () => {
  const chunk = frameText('b:1', '{"n":1}') + frameText('b:2', '{"n":2}') + frameText('b:3', '{"n":3}');
  const { frames, error } = feedAll(createFrameParser(), [chunk]);
  assert.equal(error, null);
  assert.deepEqual(frames.map((frame) => frame.id), ['b:1', 'b:2', 'b:3']);
  assert.deepEqual(frames.map((frame) => JSON.parse(frame.data).n), [1, 2, 3]);
});

test('a multi-byte character split across chunks is decoded whole', () => {
  const bytes = Buffer.from(frameText('b:4', '{"t":"€"}'), 'utf8');
  const euro = bytes.indexOf(Buffer.from('€', 'utf8'));
  // Split after the first byte and after the second byte of the three-byte character.
  for (const at of [euro + 1, euro + 2]) {
    const { frames, error } = feedAll(createFrameParser(), [bytes.subarray(0, at), bytes.subarray(at)]);
    assert.equal(error, null);
    assert.equal(JSON.parse(frames[0].data).t, '€');
  }
});

test('heartbeats and comment lines between frames are ignored', () => {
  const chunks = [': heartbeat\n\n', frameText('b:1', '{}'), ': heartbeat\n\n', ':a comment\n\n', frameText('b:2', '{}'),
    ': heartbeat\n\n'];
  const { frames, error } = feedAll(createFrameParser(), chunks);
  assert.equal(error, null);
  assert.deepEqual(frames.map((frame) => frame.id), ['b:1', 'b:2']);
});

test('CRLF line endings and multi-line data are read as the event-stream format says', () => {
  const { frames } = feedAll(createFrameParser(), ['id: b:9\r\nevent: jenny\r\ndata: one\r\ndata: two\r\n\r\n']);
  assert.deepEqual(frames, [{ id: 'b:9', event: 'jenny', data: 'one\ntwo' }]);
});

test('a frame of exactly the bound is accepted; one byte more is a protocol error', () => {
  const head = 'id: b:1\nevent: jenny\ndata: ';
  const fill = (total) => `${head}${'x'.repeat(total - Buffer.byteLength(head) - 1)}\n`;
  assert.equal(Buffer.byteLength(fill(MAX_FRAME_BYTES)), MAX_FRAME_BYTES);
  assert.equal(MAX_FRAME_BYTES, 1024 * 1024);

  const under = feedAll(createFrameParser(), [fill(MAX_FRAME_BYTES), '\n']);
  assert.equal(under.error, null);
  assert.equal(under.frames.length, 1);
  assert.equal(under.frames[0].data.length, MAX_FRAME_BYTES - Buffer.byteLength(head) - 1);

  const over = feedAll(createFrameParser(), [fill(MAX_FRAME_BYTES + 1), '\n']);
  assert.equal(over.error, 'event_frame_too_large');
  assert.deepEqual(over.frames, []);
});

test('an endless line with no newline is refused once it passes the bound, before it ends', () => {
  const parser = createFrameParser();
  const piece = Buffer.alloc(64 * 1024, 0x78);
  let error = null;
  let pushes = 0;
  while (!error && pushes < 64) { error = parser.push(piece).error; pushes += 1; }
  assert.equal(error, 'event_frame_too_large');
  assert.ok(pushes <= 17, `refused after ${pushes} pushes of 64 KiB`);
  // The parser stays failed: nothing after a protocol error is delivered.
  assert.deepEqual(parser.push(Buffer.from(frameText('b:1', '{}'))), { frames: [], error: 'event_frame_too_large' });
});

test('frames before an oversized one in the same chunk are still delivered, nothing after it', () => {
  const big = `data: ${'y'.repeat(MAX_FRAME_BYTES)}\n\n`;
  const { frames, error } = feedAll(createFrameParser(), [frameText('b:1', '{}') + big + frameText('b:3', '{}')]);
  assert.equal(error, 'event_frame_too_large');
  assert.deepEqual(frames.map((frame) => frame.id), ['b:1']);
});

test('bytes that are not UTF-8 are a protocol error', () => {
  const bad = Buffer.concat([Buffer.from('id: b:1\nevent: jenny\ndata: '), Buffer.from([0xff, 0xfe]), Buffer.from('\n\n')]);
  const { frames, error } = feedAll(createFrameParser(), [bad]);
  assert.equal(error, 'event_frame_invalid');
  assert.deepEqual(frames, []);
});

test('more than the bound of heartbeat blocks in total never trips it', () => {
  const parser = createFrameParser();
  const block = ': heartbeat\n\n';
  const count = Math.ceil((MAX_FRAME_BYTES * 1.5) / block.length);
  // In one large chunk, then in many small ones.
  assert.equal(parser.push(Buffer.from(block.repeat(count))).error, null);
  for (let index = 0; index < count; index += 1) assert.equal(parser.push(Buffer.from(block)).error, null);
  assert.deepEqual(parser.push(Buffer.from(frameText('b:1', '{}'))).frames.map((frame) => frame.id), ['b:1']);
});

test('300,000 one-byte chunks with no newline keep the retained partial line near its byte count', () => {
  const parser = createFrameParser();
  const one = Buffer.from('x');
  for (let index = 0; index < 300_000; index += 1) assert.equal(parser.push(one).error, null);
  // The partial line is one growing buffer: at most twice its bytes, not one entry per chunk.
  const retained = parser.retainedBytes();
  assert.ok(retained >= 300_000 && retained <= 600_000, `retained ${retained}`);
  // The line still completes into the frame it belongs to.
  const done = parser.push(Buffer.from('\nid: b:2\nevent: jenny\ndata: {}\n\n'));
  assert.deepEqual(done.frames.map((frame) => frame.id), ['b:2']);
  assert.ok(parser.retainedBytes() <= 64 * 1024, 'a large partial buffer is released once its line ends');
});

test('two parsers share no state', () => {
  const first = createFrameParser();
  const second = createFrameParser();
  const text = frameText('b:1', '{"who":"first"}');
  assert.deepEqual(first.push(Buffer.from(text.slice(0, 12))).frames, []);
  const other = second.push(Buffer.from(frameText('b:5', '{"who":"second"}')));
  assert.deepEqual(other.frames.map((frame) => frame.id), ['b:5']);
  const rest = first.push(Buffer.from(text.slice(12)));
  assert.deepEqual(rest.frames, [{ id: 'b:1', event: 'jenny', data: '{"who":"first"}' }]);
  // A failure in one leaves the other working.
  assert.equal(first.push(Buffer.from([0xff, 0x0a, 0x0a])).error, 'event_frame_invalid');
  assert.equal(second.push(Buffer.from(frameText('b:6', '{}'))).error, null);
});
