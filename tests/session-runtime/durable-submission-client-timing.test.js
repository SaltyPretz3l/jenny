'use strict';

// P3-PERF-A 2026-09-25: the durable send path dropped renderer client timing, so
// chat.performance_turn_summary and the turn-diagnostic JSON never saw it.

const assert = require('node:assert/strict');
const test = require('node:test');

const { normalizeSubmission } = require('../../services/session-runtime/submission-contract');
const { retainManagedRuntimeController } = require('../../services/backend/chat-lifecycle-contracts');
const {
  AUTHORITY,
  createAdapterHarness,
  request,
} = require('../helpers/session-runtime-chat-adapter-harness');

const TIMING = Object.freeze({ send_started_at_ms: 1000, optimistic_rendered_at_ms: 1012, local_render_latency_ms: 12 });

test('the submission contract carries client_timing to the runtime request', () => {
  const base = { idempotency_key: 'durable_1', session_id: 'session_1', prompt: 'hello' };
  assert.deepEqual(normalizeSubmission({ ...base, client_timing: TIMING }).request.clientTiming, TIMING);
  // Telemetry never decides a Send: malformed timing is dropped, not refused.
  const malformed = normalizeSubmission({ ...base,
    client_timing: { send_started_at_ms: 'soon', optimistic_rendered_at_ms: -1, local_render_latency_ms: 4, extra: 1 } });
  assert.deepEqual(malformed.request.clientTiming, { local_render_latency_ms: 4 });
  for (const clientTiming of [null, [], 'x', { junk: 1 }]) {
    const normalized = normalizeSubmission({ ...base, client_timing: clientTiming });
    assert.ok(normalized, `refused client_timing=${JSON.stringify(clientTiming)}`);
    assert.equal(Object.hasOwn(normalized.request, 'clientTiming'), false);
  }
});

test('client timing reaches the managed start but never the durable input', async t => {
  const { adapter, service, sessionId } = createAdapterHarness(t);
  const prepared = await adapter.prepareImmediate(request(sessionId, { clientTiming: TIMING }), {}, {
    workId: 'work-timing', turnId: 'turn-timing',
  });
  assert.deepEqual(prepared.request.clientTiming, TIMING);
  assert.equal(Object.hasOwn(prepared.input.request, 'clientTiming'), false,
    'a resumed or replayed turn must not reuse a stale click time');
  adapter.register(prepared.workId, prepared);
  const pending = { work_id: prepared.workId, turn_id: prepared.turnId, session_id: sessionId,
    project_id: AUTHORITY.project_id, input: prepared.input };
  const claim = adapter.claimCanonical(pending, prepared.route);
  const work = { ...pending, attempt: { attempt_id: 'attempt_timing', stream_id: claim.streamId,
    incarnation: 'host_timing', authority_revision: claim.authorityRevision } };
  let forwarded;
  service._startManagedSidecarChatStream = async options => {
    forwarded = options.clientTiming;
    const controller = new AbortController();
    service.sessionTurnActors.attachController(options.turnLease, controller);
    controller._runtimeCompletion = Promise.resolve({ status: 'completed', producerSettled: true,
      canonicalSettled: true });
    const started = retainManagedRuntimeController({ sessionId, streamId: claim.streamId }, controller);
    service.sessionTurnActors.release(options.turnLease, { status: 'completed' });
    return started;
  };
  await adapter.startProducer({ work, route: prepared.route, assertCurrent: claim.assertCurrent });
  assert.deepEqual(forwarded, TIMING);
});
