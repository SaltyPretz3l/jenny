'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const {
  MAX_PENDING_READS,
  FrameReader,
  signFrame,
  verifyFrame,
  encodeFrame,
} = require('../../../services/plugins/restricted-host/authenticated-channel');

test('authenticated frames bind channel, sequence, kind, digest, and MAC', () => {
  const key = Buffer.alloc(32, 7);
  const frame = signFrame(key, { channelId: 'channel_1', sequence: 0, kind: 'invoke', payload: { ok: true } });
  assert.deepEqual(verifyFrame(key, frame, { channelId: 'channel_1', sequence: 0, kind: 'invoke' }).payload, { ok: true });
  assert.equal(verifyFrame(key, frame, { channelId: 'channel_1', sequence: 1 }).ok, false);
  assert.equal(verifyFrame(key, { ...frame, payload_json: '{}' }, { channelId: 'channel_1', sequence: 0 }).ok, false);
  assert.throws(() => encodeFrame({ value: 'x'.repeat(1024) }, 8), /size_rejected/);
});

test('frame reader destroys a peer that exceeds the bounded receive buffer', async () => {
  const stream = new PassThrough();
  const reader = new FrameReader(stream, { maxBufferedBytes: 8 });
  const pending = reader.read();
  stream.write(Buffer.alloc(9));
  await assert.rejects(pending, /channel_buffer_limit_rejected/);
  await assert.rejects(reader.read(), /channel_buffer_limit_rejected/);
  assert.equal(stream.destroyed, true);
});

test('frame reader bounds pending receive operations', async () => {
  const stream = new PassThrough();
  const reader = new FrameReader(stream);
  const pending = Array.from({ length: MAX_PENDING_READS }, () => reader.read());
  const overflow = reader.read();
  await assert.rejects(overflow, /channel_read_queue_limit_rejected/);
  const settled = await Promise.allSettled(pending);
  assert.ok(settled.every((item) => (
    item.status === 'rejected' && /channel_read_queue_limit_rejected/.test(item.reason.message)
  )));
});
