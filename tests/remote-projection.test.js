'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const contracts = require('../services/remote/remote-contracts');
const limits = require('../services/remote/remote-limits');
const {
  projectMessage,
  projectPage,
} = require('../services/remote/remote-transcript-projector');
const { createRemoteEventProjector } = require('../services/remote/remote-event-projector');
const { normalizeMessageFields } = require('../services/backend/message-normalization');

const MESSAGE_KEYS = [
  'id', 'role', 'kind', 'content', 'status', 'terminal_subcode', 'timestamp',
  'parent_stream_id', 'event_seq', 'tool_steps', 'interactive_batch',
  'truncated',
];

function message(overrides = {}) {
  return normalizeMessageFields({
    id: 'message_1',
    role: 'assistant',
    kind: 'message',
    content: 'fallback',
    status: 'completed',
    terminal_subcode: '',
    timestamp: '2026-09-05T12:00:00.000Z',
    parent_stream_id: 'stream_1',
    event_seq: 4,
    tool_steps: [{ tool_name: 'read_file', status: 'completed', call_id: 'call_1' }],
    interactive_batch: {
      batch_id: 'batch_1',
      questions: [{
        id: 'q1', prompt: 'Continue?', options: [{ id: 'yes', label: 'Yes' }],
        multi_select: true, allow_other: true, secret: 'drop',
      }],
      continuation_token: { secret: true },
    },
    reasoning: { entries: [{ text: 'private' }] },
    attachments: [{ path: 'secret.txt' }],
    sourceFields: { private: true },
    tool_call: { input: { path: 'secret.txt' } },
    tool_result: { content: 'raw' },
    plugin_operation: { payload: 'raw' },
    turn_events: [{ payload: 'raw' }],
    ...overrides,
  });
}

test('message projection is a fresh strict allowlist', () => {
  const source = message();
  const projected = projectMessage(source);
  assert.notEqual(projected, source);
  assert.deepEqual(Object.keys(projected), MESSAGE_KEYS);
  assert.deepEqual(projected.tool_steps, [{ name: 'read_file', status: 'completed' }]);
  assert.deepEqual(projected.interactive_batch, {
    batch_id: 'batch_1',
    questions: [{
      id: 'q1', prompt: 'Continue?', options: [{ id: 'yes', label: 'Yes' }],
      multi_select: false,
    }],
  });
  for (const forbidden of [
    'reasoning', 'attachments', 'sourceFields', 'tool_call', 'tool_result',
    'plugin_operation', 'turn_events',
  ]) assert.equal(Object.hasOwn(projected, forbidden), false, forbidden);
});

test('canonical visible segment composition preserves normalized visible text and legacy fallback', () => {
  const projected = projectMessage(message({
    visible_segments: [
      { kind: 'text', text: 'Hello ' },
      { text: 'world' },
    ],
  }));
  assert.equal(projected.content, 'Hello world');
  assert.equal(projectMessage(message({ visible_segments: undefined, content: 'legacy' })).content, 'legacy');
});

test('page projection takes the newest bounded page in chronological order', () => {
  const messages = Array.from({ length: 5 }, (_, index) => message({
    id: `message_${index + 1}`, content: `content_${index + 1}`,
  }));
  const countPage = projectPage(messages, {
    limit: 2,
    limits: { TRANSCRIPT_PAGE_MAX_MESSAGES: 3, TRANSCRIPT_PAGE_MAX_BYTES: 100_000 },
  });
  assert.deepEqual(countPage.messages.map((entry) => entry.id), ['message_4', 'message_5']);
  assert.equal(countPage.has_more, true);
  assert.equal(countPage.next_before, 'message_4');
  const prior = projectPage(messages, {
    before: countPage.next_before,
    limit: 2,
    limits: { TRANSCRIPT_PAGE_MAX_MESSAGES: 3, TRANSCRIPT_PAGE_MAX_BYTES: 100_000 },
  });
  assert.deepEqual(prior.messages.map((entry) => entry.id), ['message_2', 'message_3']);

  const bytes = Buffer.byteLength(JSON.stringify(projectMessage(messages[4])), 'utf8');
  const bytePage = projectPage(messages, {
    limit: 5,
    limits: { TRANSCRIPT_PAGE_MAX_MESSAGES: 5, TRANSCRIPT_PAGE_MAX_BYTES: bytes + 2 },
  });
  assert.deepEqual(bytePage.messages.map((entry) => entry.id), ['message_5']);
  assert.equal(bytePage.has_more, true);

  const oversized = projectPage([message({ id: 'large', content: 'x'.repeat(5000) })], {
    limit: 1,
    limits: { TRANSCRIPT_PAGE_MAX_MESSAGES: 1, TRANSCRIPT_PAGE_MAX_BYTES: 600 },
  });
  assert.equal(oversized.messages[0].id, 'large');
  assert.equal(oversized.messages[0].truncated, true);
  assert.ok(oversized.messages[0].content.length < 5000);
  assert.ok(Buffer.byteLength(JSON.stringify(oversized.messages), 'utf8') <= 600);
  assert.equal(oversized.has_more, false);
});

function fakeTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    setTimer(callback, delay) {
      const id = nextId;
      nextId += 1;
      pending.set(id, { callback, delay });
      return id;
    },
    clearTimer(id) { pending.delete(id); },
    runNext() {
      const entry = pending.entries().next().value;
      if (!entry) return false;
      pending.delete(entry[0]);
      entry[1].callback();
      return true;
    },
    size: () => pending.size,
    delays: () => [...pending.values()].map((entry) => entry.delay),
  };
}

function eventHarness({ shared = true } = {}) {
  const backend = new EventEmitter();
  const emitted = [];
  const timers = fakeTimers();
  const decisionState = {
    tool: [{
      approval_id: 'approval_1', stream_id: 'stream_1', call_id: 'call_approval',
      tool_name: 'write_file', classification: 'phone_ok', decision_revision: 3,
      facts: { tool_name: 'write_file', summary: 'Write notes.txt', policy_scope: '', policy_consequence: '' },
    }],
    plan: [{
      approval_id: 'approval_plan', stream_id: 'stream_1', call_id: 'call_plan',
      tool_name: 'exit_plan_mode', classification: 'phone_ok', decision_revision: 2,
      facts: { plan: { title: 'Plan', summary: 'Summary', steps: ['One'] } },
    }],
    questions: [{
      question_ref: 'question_1', batch_id: 'batch_1', call_id: 'call_questions',
      questions: [{ id: 'q1', prompt: 'Continue?', options: [], multi_select: false, allow_other: false }],
    }],
  };
  const projector = createRemoteEventProjector({
    backendService: backend,
    isSessionShared: () => shared,
    limits,
    now: () => 0,
    emit: (event) => emitted.push(event),
    contracts,
    decisions: { pendingFor: () => decisionState },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return { backend, emitted, timers, projector, decisionState };
}

function streamEvent(type, overrides = {}) {
  return { type, sessionId: 'session_1', streamId: 'stream_1', ...overrides };
}

test('event projector maps canonical visible stream events with monotonic sequence', () => {
  const { backend, emitted, projector, decisionState } = eventHarness();
  backend.emit('chat-stream', streamEvent('started'));
  backend.emit('chat-stream', streamEvent('tool_use', {
    callId: 'call_1', toolName: 'read_file', status: 'running', input: { secret: true },
  }));
  backend.emit('chat-stream', streamEvent('tool_result', {
    callId: 'call_1', toolName: 'read_file', status: 'completed', summary: 'x'.repeat(300),
    content: 'must not be a summary', discard_scope: 'all',
  }));
  backend.emit('chat-stream', streamEvent('tool_approval_needed', {
    approvalId: 'approval_1', callId: 'call_approval', toolName: 'write_file',
  }));
  backend.emit('chat-stream', streamEvent('tool_approval_needed', {
    approvalId: 'approval_plan', callId: 'call_plan', toolName: 'exit_plan_mode',
  }));
  backend.emit('chat-stream', streamEvent('user_questions_requested', {
    questionRef: 'question_1', questionId: 'batch_1',
  }));
  backend.emit('chat-stream', streamEvent('stream_reset', {
    reason: 'provider_retry', discard_scope: 'all', preserve_prior_segments: false,
  }));
  backend.emit('chat-stream', streamEvent('complete', {
    status: 'completed', messageId: 'assistant_1', content: 'terminal answer',
  }));
  backend.emit('chat-stream', streamEvent('question_batch'));
  backend.emit('chat-stream', streamEvent('error', {
    message: 'bad C:\\Users\\private\\secret.txt token=sk-abcdefghijklmnop',
  }));

  assert.deepEqual(emitted.map((event) => event.type), [
    'started', 'tool_use', 'tool_result', 'tool_approval_needed', 'plan_proposed',
    'user_questions_requested', 'reset', 'complete', 'complete', 'error',
  ]);
  assert.deepEqual(emitted.map((event) => event.event_seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(emitted[1].payload, {
    call_id: 'call_1', tool_name: 'read_file', status: 'running',
  });
  assert.equal(emitted[2].payload.summary.length, 200);
  assert.deepEqual(emitted[3].payload, {
    approval_id: 'approval_1', call_id: 'call_approval', tool_name: 'write_file',
    classification: 'phone_ok', decision_revision: 3,
    facts: { tool_name: 'write_file', summary: 'Write notes.txt', policy_scope: '', policy_consequence: '' },
  });
  assert.deepEqual(emitted[4].payload.plan, {
    title: 'Plan', summary: 'Summary', steps: ['One'],
  });
  assert.deepEqual(emitted[5].payload, {
    question_ref: 'question_1', batch_id: 'batch_1', call_id: 'call_questions',
    questions: [{ id: 'q1', prompt: 'Continue?', options: [], multi_select: false, allow_other: false }],
  });
  assert.deepEqual(emitted[6].payload, { reason: 'provider_retry', discard_scope: 'all' });
  assert.deepEqual(emitted[7].payload, {
    status: 'completed', assistant_message_id: 'assistant_1', content: 'terminal answer',
    replaces_stream_text: true,
  });
  assert.deepEqual(emitted[8].payload, {
    status: 'continue_on_desktop', reason: 'question_batch',
    assistant_message_id: '', replaces_stream_text: false,
  });
  assert.equal(emitted[9].payload.reason, 'not_reachable');
  assert.doesNotMatch(emitted[9].payload.detail, /Users|sk-abcdefghijklmnop/);
  assert.deepEqual(projector.pendingFor('session_1'), decisionState);
  projector.dispose();
});

test('tool results never infer summaries or resets from raw content', () => {
  const { backend, emitted, projector } = eventHarness();
  backend.emit('chat-stream', streamEvent('tool_result', {
    callId: 'call_1', toolName: 'read_file', content: 'private raw output', discard_scope: 'all',
  }));
  assert.deepEqual(emitted.map((event) => event.type), ['tool_result']);
  assert.equal(emitted[0].payload.summary, '');
  projector.dispose();
});

test('complete without terminal content instructs transcript reconciliation', () => {
  const { backend, emitted, projector } = eventHarness();
  backend.emit('chat-stream', streamEvent('complete', { status: 'completed' }));
  assert.deepEqual(emitted[0].payload, {
    status: 'completed', assistant_message_id: '', replaces_stream_text: false,
  });
  projector.dispose();
});

test('delta text coalesces on the injected timer and flushes before non-delta', () => {
  const { backend, emitted, timers, projector } = eventHarness();
  backend.emit('chat-stream', streamEvent('delta', { content: 'hello ' }));
  backend.emit('chat-stream', streamEvent('delta', { content: 'world' }));
  assert.equal(emitted.length, 0);
  assert.deepEqual(timers.delays(), [limits.DELTA_COALESCE_MS]);
  timers.runNext();
  assert.equal(emitted[0].type, 'delta');
  assert.deepEqual(emitted[0].payload, { text: 'hello world' });

  backend.emit('chat-stream', streamEvent('delta', { content: 'before tool' }));
  backend.emit('chat-stream', streamEvent('tool_use', {
    callId: 'call_2', toolName: 'read_file', status: 'running',
  }));
  assert.deepEqual(emitted.slice(1).map((event) => event.type), ['delta', 'tool_use']);
  projector.dispose();
});

test('coalesced delta text flushes early once it reaches 16 KiB', () => {
  const { backend, emitted, timers, projector } = eventHarness();
  backend.emit('chat-stream', streamEvent('delta', { content: 'a'.repeat(10_000) }));
  assert.equal(emitted.length, 0);
  backend.emit('chat-stream', streamEvent('delta', { content: 'b'.repeat(6_384) }));
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].type, 'delta');
  assert.equal(Buffer.byteLength(emitted[0].payload.text, 'utf8'), 16_384);
  backend.emit('chat-stream', streamEvent('delta', { content: 'tail' }));
  assert.equal(emitted.length, 1);
  timers.runNext();
  assert.deepEqual(emitted[1].payload, { text: 'tail' });
  projector.dispose();
});

test('reasoning-only deltas, preserved resets, and unshared sessions produce no event', () => {
  const sharedHarness = eventHarness();
  sharedHarness.backend.emit('chat-stream', streamEvent('delta', {
    content: '', reasoning: { entriesDelta: [{ text: 'private' }] },
  }));
  sharedHarness.backend.emit('chat-stream', streamEvent('stream_reset', {
    reason: 'tool_continuation', discard_scope: 'none', preserve_prior_segments: true,
  }));
  assert.equal(sharedHarness.emitted.length, 0);
  sharedHarness.projector.dispose();

  const unshared = eventHarness({ shared: false });
  unshared.backend.emit('chat-stream', streamEvent('started'));
  unshared.backend.emit('chat-stream', streamEvent('delta', { content: 'secret' }));
  assert.equal(unshared.emitted.length, 0);
  assert.equal(unshared.timers.size(), 0);
  unshared.projector.dispose();
});

test('dispose removes the backend listener and clears pending timers', () => {
  const { backend, timers, projector } = eventHarness();
  assert.equal(backend.listenerCount('chat-stream'), 1);
  backend.emit('chat-stream', streamEvent('delta', { content: 'pending' }));
  assert.equal(timers.size(), 1);
  projector.dispose();
  assert.equal(backend.listenerCount('chat-stream'), 0);
  assert.equal(timers.size(), 0);
});
