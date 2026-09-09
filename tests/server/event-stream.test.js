'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { EventStream } = require('../../server/event-stream');

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
