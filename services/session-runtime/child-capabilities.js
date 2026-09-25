'use strict';

const { stableJson, validId } = require('./contracts');
const { exact, fail } = require('./lineage-contracts');
const { resolveChildLineage } = require('./runtime-work-authority');
const { getTrustedExecutionBinding } = require('../backend/session-execution-authority');
const { TOOL_ERROR_CODES } = require('../backend/error-codes');

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
  try {
    const entry = currentCapability(binding);
    if (!validId(callId)) fail('runtime_child_call_id_required');
    let result;
    if (toolName === 'session_spawn') result = await entry.gateway.children.spawn(args, callId);
    else if (['session_wait', 'session_result'].includes(toolName)) result = readChild(entry, args);
    else fail('runtime_child_tool_invalid');
    currentCapability(binding);
    return { content: JSON.stringify(result), isError: false };
  } catch (_error) {
    return { content: 'This child operation is unavailable for the current request.',
      isError: true, errorCode: TOOL_ERROR_CODES.DISABLED };
  }
}

function applyRuntimeChildSendFields(params, binding, gateway, continuationSend, budgetRequired) {
  Object.assign(params, continuationSend?.fields, { ...(budgetRequired ? { inference_budget_required: true } : {}),
    ...(budgetRequired && getTrustedExecutionBinding(binding)?.readOnly ? { runtime_child_read_only: true } : {}),
    ...(budgetRequired && gateway?.children && continuationSend ? { runtime_children_enabled: true } : {}) });
}

module.exports = { readRuntimeChildResult: readChild, registerRuntimeChildCapability, executeRuntimeChildTool, applyRuntimeChildSendFields };
