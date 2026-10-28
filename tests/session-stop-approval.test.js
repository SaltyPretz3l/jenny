'use strict';

// Row 69 Q11 (owner 2026-10-20): the session_stop approval card names its target from the app's own
// caller-scoped directory (title, project, live state), never from model-written text.

const test = require('node:test');
const assert = require('node:assert/strict');

const { SESSION_STOP_SCOPE, sessionStopApprovalFields } = require('../services/backend/session-stop-approval');
const { waitForToolApproval } = require('../services/backend/chat-stream-tool-handling');
const { CanonicalTurnEventCollector } = require('../services/backend/canonical-turn-event-collector');

function serviceWith(digest) {
  const calls = [];
  return {
    calls,
    getSessionDirectory: () => ({ digest: async (args) => { calls.push(args); return digest(args); } }),
  };
}

const found = (status, extra = {}) => async () => ({ ok: true,
  session: { title: 'Beta parser', project: { id: 'p2', name: 'projB' }, status, ...extra } });

test('a stop names its target from the caller-scoped directory and maps the live state', async () => {
  const service = serviceWith(found('running'));
  const fields = await sessionStopApprovalFields(service, 'sess_primary', { session_id: 'sess_beta', purpose: 'x' });
  assert.deepEqual(fields, { session_stop_approval: { schema_version: 1,
    target: { session_id: 'sess_beta', title: 'Beta parser', project_label: 'projB' }, state: 'running' } });
  assert.deepEqual(service.calls, [{ callerSessionId: 'sess_primary', sessionId: 'sess_beta',
    includeTranscriptTail: false, includeChanges: false }]);
  for (const [status, state] of [['waiting_approval', 'waiting_approval'], ['queued', 'queued'],
    ['idle', 'idle'], ['failed', 'idle'], ['waiting_question', 'idle']]) {
    const value = await sessionStopApprovalFields(serviceWith(found(status)), 'sess_primary', { session_id: 'sess_beta' });
    assert.equal(value.session_stop_approval.state, state, status);
  }
});

test('a chat outside the scope reads not_found with no target; failures and other tools give nothing', async () => {
  const outside = serviceWith(async () => ({ ok: false, reason: 'not_found' }));
  assert.deepEqual(await sessionStopApprovalFields(outside, 'sess_a', { session_id: 'sess_x' }),
    { session_stop_approval: { schema_version: 1, target: null, state: 'not_found' } });
  assert.deepEqual(await sessionStopApprovalFields(serviceWith(async () => ({ ok: false, reason: 'unavailable' })),
    'sess_a', { session_id: 'sess_x' }), {});
  assert.deepEqual(await sessionStopApprovalFields(serviceWith(async () => { throw new Error('boom'); }),
    'sess_a', { session_id: 'sess_x' }), {});
  assert.deepEqual(await sessionStopApprovalFields({}, 'sess_a', { session_id: 'sess_x' }), {});
  assert.deepEqual(await sessionStopApprovalFields(serviceWith(found('running')), 'sess_a', {}), {});
  // An oversized title is dropped rather than clipped into something else.
  const long = await sessionStopApprovalFields(serviceWith(found('idle', { title: 'x'.repeat(600) })), 'sess_a', { session_id: 'sess_b' });
  assert.equal(long.session_stop_approval.target.title, null);
});

test('the stop approval carries its target on the live event and both journal events, under the "Another chat" scope', async () => {
  const emitted = [];
  const collector = new CanonicalTurnEventCollector({ turnId: 'stream-stop', sessionId: 'sess_primary' });
  const service = { ...serviceWith(found('running')), sessionStore: { appendMessage() {}, updateMessage() {} },
    emit: (_channel, payload) => emitted.push(payload), pendingToolApprovals: new Map(), currentModel: 'm' };
  const controller = new AbortController();
  const done = waitForToolApproval(service, 'stream-stop', 'sess_primary', 'req-stop', {
    tool_name: 'session_stop', tool_call_id: 'call-stop', tool_input: { session_id: 'sess_beta' },
    policy_scope: 'Local computer', policy_consequence: 'May change data in this scope.',
  }, controller, collector);
  await new Promise((resolve) => setImmediate(resolve));
  const pending = [...service.pendingToolApprovals.values()][0];
  assert.equal(pending.toolName ?? 'session_stop', 'session_stop');
  pending.resolve(false, 'denied');
  await done;
  const needed = emitted.find((event) => event.type === 'tool_approval_needed');
  assert.equal(needed.policyScope, SESSION_STOP_SCOPE);
  assert.equal(needed.session_stop_approval.target.title, 'Beta parser');
  const toolUse = collector.capturedEvents.find((event) => event.kind === 'tool_use');
  assert.equal(toolUse.payload.session_stop_approval.state, 'running');
  assert.equal(toolUse.payload.policy_scope, SESSION_STOP_SCOPE);
  const requested = collector.capturedEvents.find((event) => event.kind === 'approval_requested');
  assert.equal(requested.payload.session_stop_approval.target.project_label, 'projB');
});
