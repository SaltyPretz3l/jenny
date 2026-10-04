'use strict';

const { stableJson, validId } = require('./contracts');
const { exact, fail } = require('./lineage-contracts');
const { resolveChildLineage } = require('./runtime-work-authority');
const { getTrustedExecutionBinding } = require('../backend/session-execution-authority');
const { RUNTIME_ERROR_CODES, TOOL_ERROR_CODES } = require('../backend/error-codes');

const CAPABILITIES = new WeakMap();
function registerRuntimeChildCapability({ binding, gateway, runtime, work, assertCurrent }) {
  if (!gateway.children) return;
  if (!getTrustedExecutionBinding(binding)) fail('runtime_child_binding_required');
  CAPABILITIES.set(binding, { gateway, runtime, work, assertCurrent });
}
function currentCapability(binding) {
  const entry = CAPABILITIES.get(binding);
  if (!entry || !getTrustedExecutionBinding(binding)) fail('runtime_child_capability_required');
  entry.assertCurrent();
  entry.gateway.children.assertCurrent();
  const { runtime, gateway, work } = entry;
  const current = runtime.store.get(work.work_id);
  if (gateway.snapshot().closed || !runtime.scheduler.enabled || runtime.scheduler.closing
    || current.status !== 'running' || current.control_request
    || stableJson(current.attempt) !== stableJson(work.attempt)) fail('runtime_child_capability_expired');
  return entry;
}
function readChild(entry, args) {
  if (!exact(args, ['child_work_id']) || !validId(args.child_work_id)) fail('runtime_child_arguments_invalid');
  const { runtime, work } = entry;
  const child = runtime.store.get(args.child_work_id);
  const { child: proof } = resolveChildLineage(runtime, child);
  if (proof.parent_work_id !== work.work_id || proof.parent_turn_id !== work.turn_id) fail('runtime_child_result_unavailable');
  const terminal = ['completed', 'failed', 'cancelled'].includes(child.status)
    && !runtime.scheduler.active.has(child.work_id) && !runtime.scheduler.cancellationFences.has(child.work_id);
  if (!terminal) return { child_work_id: child.work_id, status: 'pending' };
  const session = runtime.conversationStore.getSession(child.session_id);
  if (session?.session_incarnation !== proof.session_incarnation) fail('runtime_child_session_changed');
  const text = (session.messages || []).filter(row => row.turn_id === child.turn_id
    && row.role === 'assistant' && !row.tool_call).map(row => String(row.content || '')).join('\n');
  const body = Buffer.from(text);
  const { StringDecoder } = require('node:string_decoder');
  const result = new StringDecoder('utf8').write(body.subarray(0, 32768));
  return { child_work_id: child.work_id, session_id: child.session_id, turn_id: child.turn_id,
    status: child.status, result, truncated: body.length > 32768 };
}
async function executeRuntimeChildTool(binding, toolName, args, callId) {
  let entry;
  try {
    entry = currentCapability(binding);
    if (!validId(callId)) fail('runtime_child_call_id_required');
    let result;
    if (toolName === 'session_spawn') result = await entry.gateway.children.spawn(args, callId);
    else if (['session_wait', 'session_result'].includes(toolName)) result = readChild(entry, args);
    else fail('runtime_child_tool_invalid');
    currentCapability(binding);
    return { content: JSON.stringify(result), isError: false };
  } catch (error) {
    const reason = error?.code;
    const capacity = ['lineage_descendant_capacity', 'lineage_root_capacity', 'runtime_child_publication_capacity',
      'budget_exhausted', 'budget_root_capacity', 'pending_capacity'].includes(reason);
    const invalid = ['runtime_child_arguments_invalid', 'runtime_child_call_id_required', 'runtime_child_tool_invalid',
      'lineage_spawn_conflict', 'lineage_parent_invalid'].includes(reason);
    const policy = ['runtime_child_capability_required', 'runtime_child_capability_expired',
      'runtime_child_parent_not_current', 'runtime_child_root_grant_required', 'runtime_child_result_unavailable',
      'lineage_root_cancelled', 'lineage_restored_authority_required', 'runtime_child_session_changed'].includes(reason);
    const publicReason = capacity || invalid || policy ? reason : 'runtime_child_operation_failed';
    const errorCode = capacity ? RUNTIME_ERROR_CODES.RESOURCE_EXCEEDED
      : invalid ? RUNTIME_ERROR_CODES.INVALID_REQUEST : policy ? TOOL_ERROR_CODES.POLICY_DENIED
      : TOOL_ERROR_CODES.EXECUTION_FAILED;
    try { entry?.runtime.chatAdapter?.service?._emitServiceLog?.('WARN', 'runtime.child_operation_failed', {
      work_id: entry.work.work_id, call_id: validId(callId) ? callId : null,
      tool_name: ['session_spawn', 'session_wait', 'session_result'].includes(toolName) ? toolName : null,
      reason: publicReason, errorCode,
    }); } catch (_error) { /* Diagnostics cannot change the tool result. */ }
    return { content: JSON.stringify({ reason: publicReason }), isError: true, errorCode };
  }
}

function applyRuntimeChildSendFields(params, binding, gateway, continuationSend, budgetRequired) {
  Object.assign(params, continuationSend?.fields, { ...(budgetRequired ? { inference_budget_required: true } : {}),
    ...(budgetRequired && getTrustedExecutionBinding(binding)?.readOnly ? { runtime_child_read_only: true } : {}),
    ...(budgetRequired && gateway?.children && continuationSend ? { runtime_children_enabled: true } : {}) });
}

module.exports = { readRuntimeChildResult: readChild, registerRuntimeChildCapability, executeRuntimeChildTool, applyRuntimeChildSendFields };
