'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { stableJson } = require('../../services/session-runtime/contracts');
const { buildAdmittedContinuationContext } = require('../../services/session-runtime/continuation-context');
const { createManagedContinuationBoundary } = require('../../services/backend/runtime-continuation-managed');
const { proveDependencyPrefix } = require('../../services/session-runtime/dependency-proof');

function hash(value) { return createHash('sha256').update(stableJson(value)).digest('hex'); }
function bytes(value) { return Buffer.from(stableJson(value)).toString('base64'); }
function dependencyFixture(h, child, { announceWait = false, omitSpawnAnnouncement = false, entryIndex = 0, prior = null, currentEvents = null, waitId = 'wait_1' } = {}) {
  const work = h.runtime.store.get(h.started.work_id);
  const request = h.starts[entryIndex].request;
  const inference = request.runtimeOperationGateway.inference;
  if (inference.snapshot().reserved) {
    // Model the initial generation that produced the synthetic spawn/wait calls.
    // Its admission consumes the reserved lane; settlement must precede pause.
    const binding = { api_version: '2026-08-17', schema_version: 1, kind: 'inference',
      operation_id: 'dependency_fixture_generation', request_id: work.attempt.stream_id,
      session_id: work.session_id, authority_revision: work.attempt.authority_revision };
    assert.equal(inference.handle({ ...binding, phase: 'admit', engine_type: request.runtimeRoute.engine_type,
      maxima: { inference_requests: 1, input_tokens: 32, output_tokens: 32 } }).status, 'granted');
    assert.equal(inference.handle({ ...binding, phase: 'settle', status: 'succeeded',
      cleanup: 'confirmed', consumption: 'unknown', charge_consumption: true }).status, 'settled');
  }
  const execution = h.service.sessionExecutionAuthority.toExecutionContext(request.runtimeExecutionAuthority);
  const context = buildAdmittedContinuationContext({ work, attempt: work.attempt,
    route: request.runtimeRoute, executionContext: execution });
  const events = currentEvents || ['tool_use', 'tool_executing', 'tool_result'].map((kind, index) => ({
    event_id: `${work.attempt.stream_id}:canonical:${index + 1}`, turn_id: work.turn_id,
    kind, status: kind === 'tool_result' ? 'completed' : kind === 'tool_executing' ? 'running' : 'pending',
    tool_call_id: 'spawn_1', primary_message_id: `${kind}_${work.turn_id}_spawn_1`, source_message_ids: [],
    payload: { canonical_seq: index + 1,
      canonical_event_type: ['tool_call_requested', 'tool_execution_started', 'tool_execution_completed'][index],
      tool_name: 'session_spawn', tool_input: { task: 'Read the project' },
      ...(kind === 'tool_result' ? { success: true, tool_output_summary: JSON.stringify(child) } : {}) },
  }));
  if (omitSpawnAnnouncement) events.splice(0, 1);
  const refs = prior?.completed_spawn_refs || proveDependencyPrefix({ runtime: h.runtime, work, events,
    dependencyId: child.child_work_id }).completed_spawn_refs;
  const collector = { canonicalPrimary: true, sessionId: work.session_id, turnId: work.turn_id,
    attemptId: work.attempt.stream_id, capturedEvents: events, flushJournalEvents() {} };
  const args = { child_work_id: child.child_work_id };
  if (announceWait) {
    const { CanonicalTurnEventCollector } = require('../../services/backend/canonical-turn-event-collector');
    const { buildCanonicalTurnEvent } = require('../../services/backend/canonical-turn-event');
    const actual = new CanonicalTurnEventCollector({ sessionId: work.session_id, turnId: work.turn_id,
      attemptId: work.attempt.stream_id, canonicalPrimary: true });
    const { makeCtx } = require('./managed-runtime-notification-harness');
    const { handleNotification } = require('../../services/backend/chat-stream-managed-runtime-notifications');
    const { handleToolNotification } = require('../../services/backend/chat-stream-tool-handling');
    const ctx = makeCtx({ service: { ...h.service, emit() {} }, streamId: work.attempt.stream_id, turnId: work.turn_id,
      resolvedSessionId: work.session_id, turnEventCollector: actual });
    const toolContext = { seenToolCalls: new Set(), toolSummaries: new Map(), model: 'test',
      resolvedSessionId: work.session_id, streamId: work.attempt.stream_id, turnEventCollector: actual,
      workspaceRoot: '', eventBase: { sessionId: work.session_id, requestId: work.attempt.stream_id } };
    const wire = events.map(event => buildCanonicalTurnEvent({ type: event.payload.canonical_event_type,
      turn_id: work.turn_id, stream_id: work.attempt.stream_id, seq: event.payload.canonical_seq,
      event_id: event.event_id, tool_call_id: event.tool_call_id, payload: event.payload }));
    wire.push(buildCanonicalTurnEvent({ type: 'tool_call_requested',
      turn_id: work.turn_id, stream_id: work.attempt.stream_id, seq: 4,
      event_id: `${work.attempt.stream_id}:canonical:4`, tool_call_id: waitId,
      payload: { tool_name: 'session_wait', tool_input: args, sequence: 1 } }));
    for (const event of wire) {
      handleNotification(ctx, { method: 'turn.event', params: event }, { toolContext, handleToolNotification });
      const method = event.type === 'tool_execution_started' ? 'tool.executing'
        : event.type === 'tool_execution_completed' ? 'tool.result' : null;
      if (method) handleNotification(ctx, { method, params: { ...event.payload,
        tool_call_id: event.tool_call_id, output: event.payload.tool_output_summary } }, { toolContext, handleToolNotification });
    }
    events.splice(0, events.length, ...actual.capturedEvents);
  }
  const frozen = { call_id: waitId, tool_name: 'session_wait', visible_tool_arguments: args,
    effective_tool_arguments: args, injected_arg_keys: [], effective_args_fingerprint: hash(args),
    execution_context_payload: { session_id: work.session_id, logical_turn_id: work.turn_id,
      authority_revision: work.attempt.authority_revision, project_id: work.project_id,
      root_id: work.authority.root_id, root_revision: work.authority.root_revision } };
  const calls = [{ call_id: waitId, tool_id: 'session_wait', arguments: args,
    idempotency_key: '', coerced: false, malformed_arguments: false, argument_repairs: [] }];
  const boundary = createManagedContinuationBoundary({ context, collector,
    checkpointStore: h.runtime.checkpointStore, conversationStore: h.runtime.conversationStore,
    getCurrentWork: () => h.runtime.store.get(work.work_id),
    assertCurrent: () => { request.runtimeAssertCurrent(); return true; }, assertProtocol: () => true,
    gateway: request.runtimeOperationGateway,
    historySelector: { schema_version: 1, history_scope: 'session', compaction_ref: null,
      canonical_cutoff: { boundary_message_count: 0, boundary_message_id: null, sha256: hash([]) } } });
  const params = { api_version: '2026-08-17', schema_version: 1, kind: 'continuation', phase: 'dependency_checkpoint',
    request_id: work.attempt.stream_id, session_id: work.session_id, authority_revision: work.attempt.authority_revision,
    operation_id: waitId, continuation_context: context, completed_spawn_refs: refs,
    tool_calls: calls, tool_batch_bytes: bytes({ calls }), tool_batch_sha256: hash({ calls }),
    frozen_input: frozen, frozen_input_bytes: bytes(frozen), frozen_input_sha256: hash(frozen),
    position: { completed_iterations: 2, current_iteration: 2, remaining_iterations: 6,
      tool_call_limit: 20, tool_calls_consumed: 2, active_budget_ms_remaining: 5000, ordered_call_ids: [waitId] },
    eligibility: { pending_call_index: 0, prior_outcome_count: 1, emitted_tool_execution_count: 1,
      preview_count: 0, approval_pending: false, mutation_started: false } };
  if (prior) {
    Object.assign(params, prior);
    params.position = { completed_iterations: 3, current_iteration: 3, remaining_iterations: 5,
      tool_call_limit: 20, tool_calls_consumed: 3, active_budget_ms_remaining: 4500, ordered_call_ids: [waitId] };
  }
  return { boundary, params, events, releaseArgs: { actorRegistry: h.service.sessionTurnActors,
    lease: request.turnLease, pendingToolApprovals: new Map(), pendingUserQuestions: new Map() } };
}

module.exports = { dependencyFixture };
