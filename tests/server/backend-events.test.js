'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { BackendEvents, streamEventDto } = require('../../server/backend-events');

test('live projection reconnects from current aggregate and is discarded at terminal', () => {
  const backend = new EventEmitter();
  const events = new BackendEvents({ backend, bootEpoch: 'boot' });
  backend.emit('chat-stream', { type: 'started', sessionId: 's', streamId: 'turn' });
  backend.emit('chat-stream', { type: 'delta', sessionId: 's', streamId: 'turn', content: 'Hi', aggregate: 'Hi' });
  backend.emit('chat-stream', { type: 'delta', sessionId: 's', streamId: 'turn', content: ' there' });
  assert.equal(events.snapshot('s').content, 'Hi there');
  const copy = events.snapshot('s');
  copy.content = 'changed';
  assert.equal(events.snapshot('s').content, 'Hi there');
  backend.emit('chat-stream', { type: 'complete', sessionId: 's', streamId: 'turn' });
  assert.equal(events.snapshot('s'), null);
  events.dispose();
  assert.equal(backend.listenerCount('chat-stream'), 0);
});

test('wire projection never reflects arbitrary runtime metadata or raw provider errors', () => {
  const dto = streamEventDto({ type: 'error', sessionId: 's', streamId: 'turn',
    content: 'secret=private', aggregate: 'secret', status: 'secret', reasoning: { entriesDelta: [{ id: 'secret', text: 'secret' }] },
    detail: 'provider-body', endpoint: 'private-host', error: { token: 'hidden' } });
  assert.deepEqual(dto, { session_id: 's', stream_id: 'turn', type: 'error', reason: 'turn_failed' });
  assert.equal(streamEventDto({ type: 'plugin_private', sessionId: 's' }), null);
});

test('approval wakeups, live output and reasoning edits retain bounded useful data', () => {
  const approval = streamEventDto({ type: 'tool_approval_needed', sessionId: 's', streamId: 't',
    approvalId: 'approval', callId: 'call', toolName: 'write_file', summary: 'Write', input: { secret: 'hidden' } });
  assert.equal(approval.approval_id, 'approval');
  assert.equal(approval.input, undefined);
  const chunk = streamEventDto({ type: 'tool_output_chunk', sessionId: 's', streamId: 't',
    lines: [{ stream: 'stderr', text: 'bounded' }], partial: 'wait', sequence: 2 });
  assert.equal(chunk.lines[0].text, 'bounded');
  const backend = new EventEmitter();
  const events = new BackendEvents({ backend, bootEpoch: 'boot' });
  backend.emit('chat-stream', { type: 'started', sessionId: 's', streamId: 't' });
  for (const entry of [{ id: 'r', text: 'Think' }, { id: 'r', baseLength: 5, baseTail: 'Think', append: ' more' }]) {
    backend.emit('chat-stream', { type: 'delta', sessionId: 's', streamId: 't', reasoning: { entriesDelta: [entry] } });
  }
  assert.equal(events.snapshot('s').reasoning[0].text, 'Think more');
  events.dispose();
});

test('late events cannot resurrect or replace a different admitted stream', () => {
  const backend = new EventEmitter();
  const events = new BackendEvents({ backend, bootEpoch: 'boot' });
  for (const streamId of ['old', 'new']) backend.emit('chat-stream', { type: 'started', sessionId: 's', streamId });
  backend.emit('chat-stream', { type: 'delta', sessionId: 's', streamId: 'new', content: 'current' });
  for (const type of ['complete', 'stream_reset', 'delta']) backend.emit('chat-stream', { type, sessionId: 's', streamId: 'old', content: 'stale' });
  assert.equal(events.snapshot('s').content, 'current');
  backend.emit('chat-stream', { type: 'complete', sessionId: 's', streamId: 'new' });
  backend.emit('chat-stream', { type: 'delta', sessionId: 's', streamId: 'new', content: 'late' });
  assert.equal(events.snapshot('s'), null);
  assert.equal(streamEventDto({ type: 'started', sessionId: 'x'.repeat(129), streamId: 's' }), null);
  events.dispose();
});


test('admission DTO validates logical identity and keeps arbitrary metadata private', () => {
  const runtimeAdmission = { work_id: 'work_1', turn_id: 'turn_1', session_id: 'session_1', stream_id: 'stream_1',
    user_message_id: 'user_1', idempotency_key: 'receipt_1', authority: 'secret' };
  const event = { type: 'started', sessionId: 'session_1', streamId: 'stream_1', turnId: 'turn_1', runtimeAdmission };
  const dto = streamEventDto(event);
  assert.equal(dto.turn_id, 'turn_1'); assert.equal(dto.runtime_admission.work_id, 'work_1');
  assert.equal(JSON.stringify(dto).includes('secret'), false);
  assert.equal(streamEventDto({ ...event, turnId: 'foreign' }), null);
  assert.equal(streamEventDto({ ...event, runtimeAdmission: { ...runtimeAdmission, session_id: 'foreign' } }), null);
});

test('evicting a live aggregate does not discard subsequent events or retain terminal identities', () => {
  const backend = new EventEmitter(); const events = new BackendEvents({ backend, bootEpoch: 'boot' });
  for (let i = 0; i < 12; i++) backend.emit('chat-stream', { type: 'started', sessionId: `s_${i}`, streamId: `t_${i}` });
  assert.equal(events.live.size, 8); assert.equal(events.snapshot('s_0'), null);
  const cursor = events.cursor;
  backend.emit('chat-stream', { type: 'delta', sessionId: 's_0', streamId: 't_0', content: 'still published' });
  assert.equal(events.cursor, cursor + 1);
  for (let i = 0; i < 12; i++) backend.emit('chat-stream', { type: 'complete', sessionId: `s_${i}`, streamId: `t_${i}` });
  assert.equal(events.active.size, 0); assert.equal(events.live.size, 0);
  const settled = events.cursor;
  backend.emit('chat-stream', { type: 'delta', sessionId: 's_0', streamId: 't_0', content: 'late' });
  assert.equal(events.cursor, settled); events.dispose();
});
