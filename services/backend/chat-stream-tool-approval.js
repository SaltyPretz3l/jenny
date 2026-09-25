'use strict';

const { summarizeToolPayload } = require('./backend-service-utils');
const { buildToolUseMessageId } = require('./tool-message-id');
const {
  resolveApprovalCallId, sanitizeApprovalReason, sanitizeApprovalPolicyPresentation,
  buildPersistedToolInputSnapshot, sanitizeToolSummary, buildScopedApprovalId,
  makeNoteTurnEvent, buildToolCallPayload, buildApprovalCanonicalEvent, approvalStateFromAbortSignal,
  approvalTerminalOutput,
} = require('./chat-stream-tool-payload-utils');
const planDocuments = require('./plan-document-events');
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
const UNATTENDED_PAUSE_APPROVAL_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const _setTimeout = setTimeout;
const _clearTimeout = clearTimeout;

async function waitForApproval(service, streamId, sessionId, requestId, params, controller,
  turnEventCollector, executionAuthority, persistTerminalApprovalResult) {
  let workspaceRoot = '';
  try {
    const rootPath = executionAuthority
      && service.sessionExecutionAuthority?.toExecutionContext?.(executionAuthority)?.root_path;
    if (typeof rootPath === 'string' && rootPath.trim()) workspaceRoot = rootPath;
  } catch (_error) { /* model replay path handling must not affect approval */ }
  const toolName = String(params.tool_name || '').trim();
  const callId = resolveApprovalCallId(toolName, params.tool_call_id);
  const policyDecisionId = String(
    params.policy_decision_id || params.policyDecisionId || ''
  ).trim();
  const reason = controller.unattendedPauseRequested === true
    ? 'Auto paused after keyboard or mouse inactivity. ' + sanitizeApprovalReason(params.reason)
    : sanitizeApprovalReason(params.reason);
  const { policyScope, policyConsequence } = sanitizeApprovalPolicyPresentation(params);
  const oneOffOnly = params.one_off_only === true;
  const input = params.tool_input && typeof params.tool_input === 'object' ? params.tool_input : {};
  const persistedInputSnapshot = buildPersistedToolInputSnapshot(input);
  const summary = sanitizeToolSummary(summarizeToolPayload(toolName, input));
  const approvalId = buildScopedApprovalId({ sessionId, streamId, callId });
  const toolUseMessageId = buildToolUseMessageId(streamId, callId);
  const noteTurnEvent = makeNoteTurnEvent(turnEventCollector, streamId);
  const planApproval = planDocuments.preparePlanApproval({ toolName, service, sessionId, streamId, callId, input, approvalId, turnEventCollector });

  if (planDocuments.denyUnrenderablePlan(planApproval, persistTerminalApprovalResult, {
    service, sessionId, streamId, callId, toolName, summary, model: service.currentModel,
    inputSnapshot: persistedInputSnapshot, policyDecisionId, turnEventCollector,
  })) return false;

  service.sessionStore.appendMessage(sessionId, {
    turn_id: turnEventCollector?.turnId || streamId,
    id: toolUseMessageId,
    role: 'assistant',
    kind: 'tool_use',
    content: summary,
    tool_call: buildToolCallPayload({
      callId,
      approvalId, policyDecisionId, reason, oneOffOnly,
      toolName,
      input,
      workspaceRoot,
      inputSnapshot: persistedInputSnapshot,
      summary,
      status: 'pending_approval',
      approvalState: 'pending',
      streamId,
    }),
    finalizedAt: new Date().toISOString(),
    timestamp: new Date().toISOString(),
    model_used: service.currentModel,
  }, { updatePreview: false });

  service.emit('chat-stream', {
    type: 'tool_use',
    streamId,
    turnId: turnEventCollector?.turnId || streamId,
    sessionId,
    model: service.currentModel,
    callId,
    approvalId,
    ...(policyDecisionId ? { policyDecisionId } : {}),
    ...(reason ? { reason } : {}),
    ...(policyScope ? { policyScope } : {}),
    ...(policyConsequence ? { policyConsequence } : {}),
    ...(oneOffOnly ? { oneOffOnly: true } : {}),
    toolName,
    input: persistedInputSnapshot.input,
    summary,
    status: 'pending_approval',
  });
  noteTurnEvent('tool_use', () => ({
    primary_message_id: toolUseMessageId,
    source_message_ids: [toolUseMessageId],
    tool_call_id: callId,
    status: 'pending_approval',
    payload: {
      approval_id: approvalId,
      ...(policyDecisionId ? { policy_decision_id: policyDecisionId } : {}),
      ...(reason ? { reason } : {}),
      ...(policyScope ? { policy_scope: policyScope } : {}),
      ...(policyConsequence ? { policy_consequence: policyConsequence } : {}),
      ...(oneOffOnly ? { one_off_only: true } : {}),
      tool_name: toolName,
      input: persistedInputSnapshot.input,
      summary,
      parent_stream_id: streamId,
    },
  }));
  noteTurnEvent(null, () => buildApprovalCanonicalEvent({
    streamId,
    sessionId,
    callId,
    type: 'tool_approval_requested',
    payload: {
      approval_id: approvalId,
      approval_state: 'pending',
      ...(policyDecisionId ? { policy_decision_id: policyDecisionId } : {}),
      ...(reason ? { reason } : {}),
      ...(policyScope ? { policy_scope: policyScope } : {}),
      ...(policyConsequence ? { policy_consequence: policyConsequence } : {}),
      ...(oneOffOnly ? { one_off_only: true } : {}),
      tool_name: toolName,
      summary,
    },
  }));
  service.emit('chat-stream', {
    type: 'tool_approval_needed',
    streamId,
    turnId: turnEventCollector?.turnId || streamId,
    sessionId,
    model: service.currentModel,
    callId,
    approvalId,
    ...(policyDecisionId ? { policyDecisionId } : {}),
    ...(reason ? { reason } : {}),
    ...(policyScope ? { policyScope } : {}),
    ...(policyConsequence ? { policyConsequence } : {}),
    ...(oneOffOnly ? { oneOffOnly: true } : {}),
    toolName,
    input: persistedInputSnapshot.input,
    summary,
    policy: 'ask',
    ...planApproval.messageFields,
  });

  // The settled flag + abort handler ordering is safe because JavaScript is
  // single-threaded: finish() cannot be re-entered, and the abort listener
  // registration cannot race with the early-abort check.
  return new Promise((resolve) => {
    let settled = false;
    let timeoutId;
    let detachDecision = null;
    const handleAbort = () => finish(false, approvalStateFromAbortSignal(controller));
    const finish = (approved, approvalState = 'denied', feedback = '', plan = null) => {
      if (settled) {
        return;
      }
      settled = true;
      detachDecision?.();
      _clearTimeout(timeoutId);
      controller.signal.removeEventListener('abort', handleAbort);
      service.pendingToolApprovals.delete(approvalId);
      // A human decision ends the guard-initiated pause: later waiters in
      // this turn go back to the normal timeout and reason text.
      if (!controller.signal.aborted && approvalState !== 'timeout' && approvalState !== 'cancelled') {
        controller.unattendedPauseRequested = false;
      }
      const resolvedState = planDocuments.resolvePlanApprovalState(Boolean(approved), approvalState);
      // An approval whose decision resolved to 'denied' (unknown decision) fails closed.
      const normalizedApproved = Boolean(approved) && resolvedState !== 'denied';
      // Everything above is unconditional teardown, so the waiter can never
      // be re-entered. Everything below is fallible bookkeeping; a throw here
      // is logged and swallowed, and resolve() always runs in `finally`
      // with the decision already computed above (SP-13 containment).
      try {
        service.sessionStore.updateMessage(sessionId, toolUseMessageId, {
          tool_call: buildToolCallPayload({
            callId, approvalId, policyDecisionId, reason, policyScope, policyConsequence, oneOffOnly, toolName, input,
            workspaceRoot,
            inputSnapshot: persistedInputSnapshot, summary,
            status: resolvedState, approvalState: resolvedState, streamId,
          }),
        });
        service.emit('chat-stream', {
          type: 'tool_use', streamId, sessionId, model: service.currentModel,
          turnId: turnEventCollector?.turnId || streamId,
          callId, approvalId, ...(policyDecisionId ? { policyDecisionId } : {}),
          toolName, input: persistedInputSnapshot.input, summary, status: resolvedState,
        });
        noteTurnEvent(null, () => buildApprovalCanonicalEvent({
          streamId, sessionId, callId, type: 'tool_approval_resolved',
          payload: {
            approval_id: approvalId, approval_state: resolvedState, approved: normalizedApproved,
            ...(policyDecisionId ? { policy_decision_id: policyDecisionId } : {}), tool_name: toolName,
          },
        }));
        if (!normalizedApproved) {
          planDocuments.abandonPlanApproval({ toolName, service, sessionId, streamId, callId, turnEventCollector });
          persistTerminalApprovalResult({
            service, sessionId, streamId, callId, toolName, summary,
            model: service.currentModel, approvalState: resolvedState,
            inputSnapshot: persistedInputSnapshot, policyDecisionId, turnEventCollector,
            output: approvalTerminalOutput(toolName, resolvedState, reason),
          });
        }
      } catch (settlementError) {
        service?._emitServiceLog?.('ERROR', 'chat.tool_approval_settlement_failed', {
          approvalId, sessionId, streamId, callId, toolName,
          approved: normalizedApproved, approvalState: resolvedState,
          message: String(settlementError?.message || settlementError || ''),
        });
      } finally {
        resolve(planDocuments.planApprovalWaiterResult({ toolName, approved: normalizedApproved, state: resolvedState, feedback, plan }));
      }
    };
    service.pendingToolApprovals.set(approvalId, {
      approvalId,
      streamId,
      sessionId,
      requestId,
      callId,
      toolName,
      toolInput: input,
      messageId: toolUseMessageId,
      resolve: finish,
      requireExactRef: Boolean(controller._runtimeDecisionControl && params.runtime_decision),
      policyDecisionId,
      ...(reason ? { reason } : {}),
      policyScope,
      policyConsequence,
      ...(oneOffOnly ? { oneOffOnly: true } : {}),
      executionAuthority,
    });
    if (controller.signal.aborted) {
      finish(false, 'cancelled');
      return;
    }
    controller.signal.addEventListener('abort', handleAbort, { once: true });
    const approvalTimeoutMs = controller.unattendedPauseRequested === true
      ? UNATTENDED_PAUSE_APPROVAL_TIMEOUT_MS
      : APPROVAL_TIMEOUT_MS;
    let unattendedPauseTimeoutExtended = approvalTimeoutMs === UNATTENDED_PAUSE_APPROVAL_TIMEOUT_MS;
    const handleTimeout = () => {
      if (!unattendedPauseTimeoutExtended && controller.unattendedPauseRequested === true) {
        unattendedPauseTimeoutExtended = true;
        armTimeout(UNATTENDED_PAUSE_APPROVAL_TIMEOUT_MS - APPROVAL_TIMEOUT_MS);
        return;
      }
      finish(false, 'timeout');
    };
    const armTimeout = (delayMs) => {
      const timer = _setTimeout(handleTimeout, delayMs);
      if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();
      timeoutId = timer;
    };
    armTimeout(approvalTimeoutMs);
    if (params.runtime_decision && controller._runtimeDecisionControl) {
      try {
        if (params.runtime_decision.call_id !== callId || params.runtime_decision.kind !== 'approval'
          || params.runtime_decision.execution_started !== false) throw new Error('runtime_approval_decision_invalid');
        detachDecision = controller._runtimeDecisionControl.offer(params.runtime_decision, pause => {
          if (settled || controller.signal.aborted
            || service.pendingToolApprovals.get(approvalId)?.resolve !== finish) return false;
          settled = true;
          _clearTimeout(timeoutId);
          controller.signal.removeEventListener('abort', handleAbort);
          service.pendingToolApprovals.delete(approvalId);
          // Live-only notice: the persisted row stays pending for the
          // checkpoint, so nothing is journaled or stored here.
          try {
            service.emit('chat-stream', {
              type: 'tool_approval_withdrawn', streamId, turnId: turnEventCollector?.turnId || streamId,
              sessionId, callId, approvalId, toolName, reason: 'runtime_pause',
            });
          } catch (_error) { /* the suspension must still settle */ }
          resolve(pause);
          return true;
        });
      } catch (_error) {
        finish(false, 'cancelled');
      }
    }
  });
}

module.exports = { waitForApproval };
