'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { EventStream, MAX_STREAM_CLIENTS } = require('../../server/event-stream');

class Response extends EventEmitter {
  constructor() { super(); this.frames = []; this.writableLength = 0; this.destroyed = false; }
  write(frame) { this.frames.push(frame); }
  destroy() { this.destroyed = true; this.emit('close'); }
}

test('snapshot cursor replays every intervening event before live delivery', () => {
  const events = new EventStream({ bootEpoch: 'boot' });
  events.publish('session_changed', { session_id: 's' });
  const snapshotCursor = events.cursor;
  events.publish('chat_stream', { session_id: 's', stream_id: 'a', content: 'first' });
  const response = new Response();
  events.subscribe({ response, deviceId: 'owner', authorized: () => true, bootEpoch: 'boot', cursor: snapshotCursor });
  events.publish('chat_stream', { session_id: 's', stream_id: 'a', content: 'second' });
  assert.equal(response.frames.length, 2);
  assert.match(response.frames[0], /first/);
  assert.match(response.frames[1], /second/);
  events.dispose();
});

test('age, byte and epoch gaps demand a canonical resnapshot', () => {
  let now = 0;
  const events = new EventStream({ bootEpoch: 'boot', now: () => now, maxAgeMs: 100 });
  events.publish('chat_stream', { content: 'old' });
  now = 101;
  for (const bootEpoch of ['boot', 'prior']) {
    const response = new Response();
    events.subscribe({ response, deviceId: 'owner', authorized: () => true, bootEpoch, cursor: 0 });
    assert.match(response.frames[0], /resync_required/);
  }
  events.dispose();
  const small = new EventStream({ bootEpoch: 'boot', streamBytes: 100 });
  small.publish('chat_stream', { content: 'x'.repeat(100) });
  const response = new Response();
  small.subscribe({ response, deviceId: 'owner', authorized: () => true, bootEpoch: 'boot', cursor: 0 });
  assert.match(response.frames[0], /resync_required/);
  small.dispose();
});

test('slow and revoked browsers cannot block another observer or receive later events', () => {
  const events = new EventStream({ bootEpoch: 'boot' });
  const slow = new Response();
  const observer = new Response();
  for (const [response, deviceId] of [[slow, 'slow'], [observer, 'observer']]) {
    events.subscribe({ response, deviceId, authorized: () => true, bootEpoch: 'boot', cursor: 0 });
  }
  slow.writableLength = 1024 * 1024;
  events.publish('chat_stream', { content: 'delivered' });
  assert.equal(slow.destroyed, true);
  assert.match(observer.frames[0], /delivered/);
  events.revokeDevice('observer');
  events.publish('chat_stream', { content: 'private' });
  assert.equal(observer.frames.length, 1);
  events.dispose();
});

test('the hard maximum is 64 clients and the default stays 32', () => {
  assert.equal(MAX_STREAM_CLIENTS, 64);
  assert.equal(new EventStream({ bootEpoch: 'boot' }).maxClients, 32);
  assert.equal(new EventStream({ bootEpoch: 'boot', maxClients: 64 }).maxClients, 64);
  assert.throws(() => new EventStream({ bootEpoch: 'boot', maxClients: 65 }), /invalid_host_limit/);
  const rejections = [];
  const full = new EventStream({ bootEpoch: 'boot' });
  for (let index = 0; index < 33; index += 1) {
    full.subscribe({ response: new Response(), deviceId: `d${index}`, authorized: () => true,
      bootEpoch: 'boot', cursor: 0, onReject: (reason) => rejections.push(reason) });
  }
  assert.deepEqual(rejections, ['limit']);
  assert.equal(full.clients.size, 32);
  full.dispose();
});

// Measured 2026-11-10, Windows 11, Node v22.23.2: 64 attached clients, 2,000
// publishes of about 1 KiB each, three runs: mean 0.013 to 0.016 ms, worst 0.4 to
// 0.9 ms, heap growth 2 to 8 MiB (no forced GC; the replay buffer is bounded). The
// bounds below are far looser so a loaded machine does not flake.
test('64 attached streams take 2,000 publishes of about 1 KiB within generous bounds', (t) => {
  const events = new EventStream({ bootEpoch: 'boot', maxClients: 64 });
  const responses = [];
  const rejections = [];
  for (let index = 0; index < 64; index += 1) {
    const response = new Response();
    responses.push(response);
    events.subscribe({ response, deviceId: `device-${index}`, authorized: () => true,
      bootEpoch: 'boot', cursor: 0, onReject: (reason) => rejections.push(reason) });
  }
  assert.equal(events.clients.size, 64);
  assert.deepEqual(rejections, []);
  const extra = new Response();
  assert.equal(events.subscribe({ response: extra, deviceId: 'device-64', authorized: () => true,
    bootEpoch: 'boot', cursor: 0, onReject: (reason) => rejections.push(reason) }), null);
  assert.deepEqual(rejections, ['limit']);
  assert.equal(events.clients.size, 64);

  const content = 'x'.repeat(1024);
  const publishes = 2000;
  if (global.gc) global.gc();
  const heapBefore = process.memoryUsage().heapUsed;
  let worst = 0;
  let total = 0;
  for (let index = 0; index < publishes; index += 1) {
    const started = process.hrtime.bigint();
    events.publish('chat_stream', { session_id: 's', stream_id: `stream-${index % 8}`, content });
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
    total += elapsed;
    if (elapsed > worst) worst = elapsed;
    for (const response of responses) response.frames.length = 0;
  }
  const heapGrowthMiB = (process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024);
  const mean = total / publishes;
  t.diagnostic(`64 clients, ${publishes} publishes of ~1 KiB: mean ${mean.toFixed(3)} ms, worst ${worst.toFixed(3)} ms, heap growth ${heapGrowthMiB.toFixed(1)} MiB`);
  assert.equal(events.cursor, publishes);
  assert.equal(events.clients.size, 64);
  assert.equal(responses.every((response) => !response.destroyed), true);
  assert.equal(mean < 5, true, `mean publish ${mean} ms`);
  assert.equal(worst < 250, true, `worst publish ${worst} ms`);
  assert.equal(heapGrowthMiB < 128, true, `heap growth ${heapGrowthMiB} MiB`);
  events.dispose();
});
