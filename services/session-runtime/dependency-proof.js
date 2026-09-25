'use strict';

const { createHash } = require('node:crypto');
const { stableJson, validId } = require('./contracts');
const { exact, fail } = require('./lineage-contracts');
const { resolveChildLineage } = require('./runtime-work-authority');
const { rootDefinition } = require('./root-run-start');
const { isContinuationTextProjection } = require('./continuation-events');
const { readRuntimeChildResult } = require('./child-capabilities');

const TYPES = { tool_use: 'tool_call_requested', tool_executing: 'tool_execution_started',
  tool_result: 'tool_execution_completed' };
const TEXT_KINDS = new Set(['assistant_text_segment', 'reasoning_phase']);
function digest(value) { return createHash('sha256').update(stableJson(value)).digest('hex'); }
function spawnReceipt(rootRunId, child) {
  return { root_run_id: rootRunId, child_work_id: child.work_id,
    session_id: child.session_id, turn_id: child.turn_id };
}
function childForCall(runtime, work, rootRunId, callId) {
  const lineage = runtime.lineageStore.get(rootRunId);
  const child = lineage.children.find(row => row.parent_work_id === work.work_id
    && row.parent_turn_id === work.turn_id && row.call_id === callId);
  if (!child || child.state !== 'committed') fail('runtime_dependency_spawn_unproven');
  const published = runtime.store.get(child.work_id);
  resolveChildLineage(runtime, published);
  return child;
}

// Resolve every prior tool result against application publication proofs. Text
// is retained as untrusted model content; it cannot grant a child dependency.
function proveDependencyPrefix({ runtime, work, events, dependencyId, expectedRefs = null, expectedWaitRefs = null, pendingCallId = null, permittedStreams = [work.attempt.stream_id], allowRepeatedAnnouncements = false }) {
  const root = work.input.kind === 'child_chat' ? resolveChildLineage(runtime, work).root : rootDefinition(work);
  if (root?.schema_version !== 2 || !validId(dependencyId)
    || !Array.isArray(events) || events.length > 4096) fail('runtime_dependency_prefix_invalid');
  const calls = new Map();
  const inputs = new Map();
  const refs = [];
  const waits = [];
  const sequences = new Map();
  let lastStream = null;
  let pendingSeen = false;
  for (const event of events) {
    const stream = String(event?.event_id || '').split(':')[0];
    const projection = isContinuationTextProjection(event);
    if (event?.turn_id !== work.turn_id || (!projection && (!Number.isSafeInteger(event.payload?.canonical_seq)
      || event.payload.canonical_seq <= (sequences.get(stream) || 0))) || !permittedStreams.includes(stream)
      || (lastStream !== null && stream !== lastStream && sequences.has(stream))) {
      fail('runtime_dependency_prefix_identity');
    }
    sequences.set(stream, projection ? (sequences.get(stream) || 0) : event.payload.canonical_seq);
    lastStream = stream;
    if (TEXT_KINDS.has(event.kind)) continue;
    const payload = event.payload;
    if (event.tool_call_id === pendingCallId) {
      if (pendingSeen || event.kind !== 'tool_use' || payload.canonical_event_type !== 'tool_call_requested'
        || payload.tool_name !== 'session_wait' || stream !== work.attempt.stream_id
        || !exact(payload.tool_input, ['child_work_id']) || payload.tool_input.child_work_id !== dependencyId) {
        fail('runtime_dependency_pending_effect');
      }
      pendingSeen = true;
      continue;
    }
    const isWait = expectedWaitRefs !== null && payload.tool_name === 'session_wait';
    if ((!isWait && payload.tool_name !== 'session_spawn') || TYPES[event.kind] !== payload.canonical_event_type
      || !validId(event.tool_call_id)) fail('runtime_dependency_prefix_effect');
    const child = isWait ? { work_id: payload.tool_input?.child_work_id }
      : childForCall(runtime, work, root.root_run_id, event.tool_call_id);
    if (isWait ? !exact(payload.tool_input, ['child_work_id']) || !refs.some(ref => ref.child_work_id === child.work_id)
      : !exact(payload.tool_input, ['task']) || digest(payload.tool_input) !== child.args_sha256) {
      fail('runtime_dependency_spawn_arguments');
    }
    const prior = calls.get(event.tool_call_id);
    const input = digest({ name: payload.tool_name, args: payload.tool_input });
    if (inputs.has(event.tool_call_id) && inputs.get(event.tool_call_id) !== input) fail('runtime_dependency_call_changed');
    inputs.set(event.tool_call_id, input);
    if (event.kind === 'tool_use' && (!prior || (allowRepeatedAnnouncements && prior === 'requested'))) calls.set(event.tool_call_id, 'requested');
    else if (event.kind === 'tool_executing' && (!prior || prior === 'requested')) calls.set(event.tool_call_id, 'executing');
    else if (event.kind === 'tool_result' && prior === 'executing') {
      const expected = isWait ? readRuntimeChildResult({ runtime, work }, payload.tool_input) : spawnReceipt(root.root_run_id, child);
      if (isWait && expected.status === 'pending') fail('runtime_dependency_wait_unsettled');
      let result;
      try { result = JSON.parse(payload.tool_output_summary); } catch (_error) { fail('runtime_dependency_spawn_result'); }
      if (payload.success !== true || stableJson(result) !== stableJson(expected)) fail('runtime_dependency_spawn_result');
      calls.set(event.tool_call_id, 'completed');
      (isWait ? waits : refs).push({ call_id: event.tool_call_id, child_work_id: child.work_id, result_sha256: digest(expected) });
    } else fail('runtime_dependency_spawn_order');
  }
  if (!refs.length || refs.length + waits.length >= 256 || [...calls.values()].some(state => state !== 'completed')
    || !refs.some(ref => ref.child_work_id === dependencyId)
    || (expectedRefs !== null && stableJson(expectedRefs) !== stableJson(refs))
    || (expectedWaitRefs !== null && stableJson(expectedWaitRefs) !== stableJson(waits))) fail('runtime_dependency_prefix_incomplete');
  return { completed_spawn_refs: refs, ...(expectedWaitRefs !== null ? { completed_wait_refs: waits } : {}),
    wait: { kind: 'dependency', resource_class: null, dependency_id: dependencyId } };
}

function dependencyReady(runtime, work, childWorkId) {
  const child = runtime.store.get(childWorkId);
  const { child: lineage } = resolveChildLineage(runtime, child);
  if (lineage.parent_work_id !== work.work_id || lineage.parent_turn_id !== work.turn_id) {
    fail('runtime_dependency_parent_mismatch');
  }
  return ['completed', 'failed', 'cancelled'].includes(child.status)
    && !runtime.scheduler.active.has(childWorkId) && !runtime.scheduler.cancellationFences.has(childWorkId);
}

module.exports = { proveDependencyPrefix, spawnReceipt, dependencyReady };
