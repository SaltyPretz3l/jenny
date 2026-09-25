'use strict';

const { stableJson } = require('./contracts');
const { fail } = require('./lineage-contracts');
const { assertQuotaProgress } = require('./quota-state');

function readDependencyPredecessor(runtime, work, reference, visited = new Set()) {
  return require('./continuation-predecessor').readContinuationPredecessor(runtime, work, reference, visited);
}

function assertDependencyProgress(previous, current, events) {
  assertQuotaProgress(previous.quota_state, current.quota_state,
    current.tool_calls || [current.pending_call], [
      ...current.completed_spawn_refs.map(ref => ({ ...ref, tool_id: 'session_spawn', success: true })),
      ...(current.completed_wait_refs || []).map(ref => ({ ...ref, tool_id: 'session_wait', success: true })),
    ]);
  const prior = previous.position;
  const next = current.position;
  const priorEffects = previous.completed_spawn_refs.length + (previous.completed_wait_refs?.length || 0);
  if (current.prior_effect_count !== priorEffects || next.tool_call_limit !== prior.tool_call_limit
    || next.current_iteration <= prior.current_iteration
    || next.completed_iterations + next.remaining_iterations > prior.completed_iterations + prior.remaining_iterations
    || next.tool_calls_consumed <= prior.tool_calls_consumed
    || (prior.active_budget_ms_remaining !== null && (next.active_budget_ms_remaining === null
      || next.active_budget_ms_remaining > prior.active_budget_ms_remaining))
    || stableJson(current.completed_spawn_refs.slice(0, previous.completed_spawn_refs.length)) !== stableJson(previous.completed_spawn_refs)
    || stableJson(current.completed_wait_refs.slice(0, previous.completed_wait_refs?.length || 0)) !== stableJson(previous.completed_wait_refs || [])) {
    fail('runtime_dependency_progress_invalid');
  }
  const finished = current.completed_wait_refs[previous.completed_wait_refs?.length || 0];
  if (finished?.call_id !== previous.pending_call.call_id || finished.child_work_id !== previous.wait.dependency_id) {
    fail('runtime_dependency_predecessor_wait_unproven');
  }
  let resumed = false;
  for (const event of events || []) {
    if (!String(event.event_id).startsWith(`${current.source_attempt?.stream_id}:`)
      || !['tool_use', 'tool_executing', 'tool_result'].includes(event.kind)) continue;
    if (event.tool_call_id !== previous.pending_call.call_id || event.payload?.tool_name !== 'session_wait'
      || event.payload.tool_input?.child_work_id !== previous.wait.dependency_id) fail('runtime_dependency_predecessor_wait_order');
    if (event.kind === 'tool_result') { resumed = true; break; }
  }
  if (!resumed) fail('runtime_dependency_predecessor_wait_order');
}

module.exports = { readDependencyPredecessor, assertDependencyProgress };
