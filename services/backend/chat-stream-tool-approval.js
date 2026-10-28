'use strict';

const crypto = require('node:crypto');
const { summarizeToolPayload } = require('./backend-service-utils');
const { buildToolUseMessageId } = require('./tool-message-id');
const {
  resolveApprovalCallId, sanitizeApprovalReason, sanitizeApprovalPolicyPresentation,
  buildPersistedToolInputSnapshot, sanitizeToolSummary, buildScopedApprovalId,
  makeNoteTurnEvent, buildToolCallPayload, buildApprovalCanonicalEvent, approvalStateFromAbortSignal,
  approvalTerminalOutput,
  sessionMessageApprovalFields,
  findToolMessageId,
  peekToolLookupMessages,
} = require('./chat-stream-tool-payload-utils');
const planDocuments = require('./plan-document-events');
const { SESSION_STOP_SCOPE, TOOL_NAME: SESSION_STOP_TOOL, sessionStopApprovalFields } = require('./session-stop-approval');
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
const UNATTENDED_PAUSE_APPROVAL_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const _setTimeout = setTimeout;
const _clearTimeout = clearTimeout;
// Only a tool's own consent executes it. A plan decision token (`accepted`,
// `rejected`) consents to a plan, never to another tool; a message send is
// consented only by an explicit `approved`; `exit_plan_mode` takes any plan
// decision (resolvePlanApprovalState already fails unknown tokens closed).
const EXECUTING_APPROVAL_STATES = new Set(['approved', 'approved_auto']);
function approvalExecutes(toolName, state) {
  if (toolName === 'session_message') return state === 'approved';
  if (toolName === 'exit_plan_mode') return state !== 'denied';
  return EXECUTING_APPROVAL_STATES.has(state);
}

// The arguments that decide what a command runs or a write writes, in display order. The
// persisted snapshot redacts secret-shaped text and clips every string at 512 chars, so the
// approval card would ask over text that is not what runs. The live request instead carries
// these fields exactly (plus any other argument but `purpose`, after them), and Electron keeps
// the hash of that presentation: an approval whose signed arguments no longer hash the same, or
// whose presentation was too large to show, is denied. Transcripts and logs keep the snapshot.
const EXACT_APPROVAL_FIELDS = Object.freeze({
  run_command: ['command', 'cwd', 'run_in_background'],
  run_temp_script: ['script', 'language', 'cwd'],
  python_execute: ['code'],
  monitor: ['command', 'cwd'],
  write_file: ['path', 'file_path', 'content', 'file_content'],
  edit_file: ['file_path', 'old_string', 'new_string', 'replace_all', 'edits'],
});
const EXACT_APPROVAL_MAX_BYTES = 32 * 1024;

function exactFieldText(value) {
  if (typeof value === 'string') return value;
  try {
    const json = JSON.stringify(value, null, 2);
    return json === undefined ? String(value) : json;
  } catch (_error) {
    return String(value);
  }
}

function buildExactApprovalPresentation(toolName, args) {
  const decisive = Object.hasOwn(EXACT_APPROVAL_FIELDS, toolName) ? EXACT_APPROVAL_FIELDS[toolName] : null;
  if (!decisive) return null;
  const source = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const names = [
    ...decisive.filter((name) => Object.hasOwn(source, name)),
    ...Object.keys(source).filter((name) => name !== 'purpose' && !decisive.includes(name)).sort(),
  ];
  const fields = names.filter((name) => source[name] !== undefined)
    .map((name) => ({ name, text: exactFieldText(source[name]) }));
  const bytes = fields.reduce((total, field) => total
    + Buffer.byteLength(field.name, 'utf8') + Buffer.byteLength(field.text, 'utf8'), 0);
  if (bytes > EXACT_APPROVAL_MAX_BYTES) {
    return { schema_version: 1, too_large: true, bytes, limit_bytes: EXACT_APPROVAL_MAX_BYTES };
  }
  const sha256 = crypto.createHash('sha256')
    .update(JSON.stringify(fields.map((field) => [field.name, field.text])), 'utf8').digest('hex');
  return { schema_version: 1, fields, bytes, sha256 };
}

// The arguments Electron signs (the bridge's noteApproved input) must still hash to what was shown.
function exactInputStillShown(toolName, params, displayedSha256) {
  try {
    return Boolean(displayedSha256) && buildExactApprovalPresentation(
      toolName, params.tool_input || params.arguments || {}
    )?.sha256 === displayedSha256;
  } catch (_error) {
    return false;
  }
}

async function waitForApproval(service, streamId, sessionId, requestId, params, controller,
  turnEventCollector, executionAuthority, persistTerminalApprovalResult) {
  const toolName = String(params.tool_name || '').trim();
  const callId = resolveApprovalCallId(toolName, params.tool_call_id);
  const policyDecisionId = String(
    params.policy_decision_id || params.policyDecisionId || ''
  ).trim();
  const reason = controller.unattendedPauseRequested === true
    ? 'Auto paused after keyboard or mouse inactivity. ' + sanitizeApprovalReason(params.reason)
    : sanitizeApprovalReason(params.reason);
  const presentation = sanitizeApprovalPolicyPresentation(params);
  const policyScope = toolName === SESSION_STOP_TOOL ? SESSION_STOP_SCOPE : presentation.policyScope;
  const { policyConsequence } = presentation;
  const oneOffOnly = toolName === 'session_message' || params.one_off_only === true;
  const input = params.tool_input && typeof params.tool_input === 'object' ? params.tool_input : {};
  const persistedInputSnapshot = buildPersistedToolInputSnapshot(input);
  const exactApproval = buildExactApprovalPresentation(toolName, input);
  const exactApprovalSha256 = exactApproval?.sha256 || '';
  // Live events only: the card and the Input panel read the exact arguments; nothing persisted does.
  const liveInput = exactApprovalSha256
    ? { ...persistedInputSnapshot.input, ...Object.fromEntries(exactApproval.fields.map(({ name }) => [name, input[name]])) }
    : persistedInputSnapshot.input;
  const exactApprovalFields = exactApproval ? { exact_approval: exactApproval } : {};
  const summary = sanitizeToolSummary(summarizeToolPayload(toolName, input));
  const approvalId = buildScopedApprovalId({ sessionId, streamId, callId });
  const toolUseMessageId = buildToolUseMessageId(streamId, callId);
  const noteTurnEvent = makeNoteTurnEvent(turnEventCollector, streamId);
  const planApproval = planDocuments.preparePlanApproval({ toolName, service, sessionId, streamId, callId, input, approvalId, turnEventCollector });
  const messageFields = sessionMessageApprovalFields(params);
  // Only a stop awaits here (every other approval registers synchronously); read before the
  // duplicate check below, which stays synchronous with the waiter's registration.
  const stopFields = toolName === SESSION_STOP_TOOL ? await sessionStopApprovalFields(service, sessionId, input) : {};
  // Missing exact-content presentation must fail closed; never ask over a clipped preview.
  if (toolName === 'session_message' && !messageFields.session_message_approval) return false;

  if (planDocuments.denyUnrenderablePlan(planApproval, persistTerminalApprovalResult, {
    service, sessionId, streamId, callId, toolName, summary, model: service.currentModel,
    inputSnapshot: persistedInputSnapshot, policyDecisionId, turnEventCollector,
  })) return false;
  // A second request for a live approval id never replaces the first waiter: the
  // duplicate is denied and the original keeps its resolve.
  if (service.pendingToolApprovals.has(approvalId)) {
    service?._emitServiceLog?.('WARN', 'chat.tool_approval_duplicate_denied', {
      approvalId, sessionId, streamId, callId, toolName,
    });
    return false;
  }

  // The sidecar's `tool_call_requested` may already have written this call's
  // tool_use row; the pending state updates that row instead of appending a twin.
  const existingToolUseId = findToolMessageId(peekToolLookupMessages(service, sessionId), {
    kind: 'tool_use', callId, streamId, fallbackId: toolUseMessageId,
  });
  const rowMessageId = existingToolUseId || toolUseMessageId;
  const pendingToolCall = buildToolCallPayload({
    callId,
    approvalId, policyDecisionId, reason, oneOffOnly,
    toolName,
    input,
    inputSnapshot: persistedInputSnapshot,
    summary,
    status: 'pending_approval',
    approvalState: 'pending',
    streamId,
  });
  if (existingToolUseId) {
    service.sessionStore.updateMessage(sessionId, existingToolUseId, { tool_call: pendingToolCall });
  } else {
    service.sessionStore.appendMessage(sessionId, {
      turn_id: turnEventCollector?.turnId || streamId,
      id: toolUseMessageId,
      role: 'assistant',
      kind: 'tool_use',
      content: summary,
      tool_call: pendingToolCall,
      finalizedAt: new Date().toISOString(),
      timestamp: new Date().toISOString(),
      model_used: service.currentModel,
    }, { updatePreview: false });
  }

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
    input: liveInput,
    summary,
    status: 'pending_approval',
    ...exactApprovalFields,
  });
  noteTurnEvent('tool_use', () => ({
    primary_message_id: rowMessageId,
    source_message_ids: [rowMessageId],
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
      ...messageFields,
      ...stopFields,
    },
  }));
  // The canonical request stays the ordinary sequenced event (runtime continuation proofs need
  // exactly one per call). The exact message body is not run through its 32 KiB cap/redactor:
  // the full presentation rides the tool_use projection above and the live event below; the
  // canonical event carries only its identity (operation, hash, destination).
  const { body: _body, ...messageIdentity } = messageFields.session_message_approval || {};
  const canonicalMessageFields = messageFields.session_message_approval ? { session_message_approval: messageIdentity } : {};
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
      ...canonicalMessageFields,
      ...stopFields,
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
    input: liveInput,
    summary,
    policy: 'ask',
    ...exactApprovalFields,
    ...planApproval.messageFields,
    ...messageFields,
    ...stopFields,
  });

  // The settled flag + abort handler ordering is safe because JavaScript is
  // single-threaded: finish() cannot be re-entered, and the abort listener
  // registration cannot race with the early-abort check.
  return new Promise((resolve) => {
    let settled = false;
    let timeoutId;
    let detachDecision = null;
    const handleAbort = () => finish(false, approvalStateFromAbortSignal(controller));
    const finish = (approved, approvalState = 'denied', feedback = '', plan = null, scope = '') => {
      if (settled) {
        return;
      }
      settled = true;
      detachDecision?.();
      _clearTimeout(timeoutId);
      controller.signal.removeEventListener('abort', handleAbort);
      if (service.pendingToolApprovals.get(approvalId)?.resolve === finish) {
        service.pendingToolApprovals.delete(approvalId);
      }
      // A human decision ends the guard-initiated pause: later waiters in
      // this turn go back to the normal timeout and reason text.
      if (!controller.signal.aborted && approvalState !== 'timeout' && approvalState !== 'cancelled') {
        controller.unattendedPauseRequested = false;
      }
      // An unknown decision, or a decision that is not this tool's own consent,
      // resolves to 'denied' and fails closed.
      let resolvedState = planDocuments.resolvePlanApprovalState(Boolean(approved), approvalState);
      if (approved && !approvalExecutes(toolName, resolvedState)) resolvedState = 'denied';
      const exactInputDenied = Boolean(approved) && resolvedState !== 'denied' && exactApproval
        && !exactInputStillShown(toolName, params, exactApprovalSha256);
      if (exactInputDenied) resolvedState = 'denied';
      let normalizedApproved = Boolean(approved) && resolvedState !== 'denied';
      const approvalScope = normalizedApproved && (scope === 'always' || scope === 'once') ? scope : '';
      let consentEventId = '';
      // Everything above is unconditional teardown, so the waiter can never
      // be re-entered. Everything below is fallible bookkeeping; a throw here
      // is logged and swallowed, and resolve() always runs in `finally`
      // with the decision already computed above (SP-13 containment).
      try {
        if (exactInputDenied) {
          service?._emitServiceLog?.('WARN', 'chat.tool_approval_exact_input_denied', {
            approvalId, sessionId, streamId, callId, toolName, tooLarge: exactApproval.too_large === true,
          });
        }
        service.sessionStore.updateMessage(sessionId, rowMessageId, {
          tool_call: buildToolCallPayload({
            callId, approvalId, policyDecisionId, reason, policyScope, policyConsequence, oneOffOnly, toolName, input,
            inputSnapshot: persistedInputSnapshot, summary,
            status: resolvedState, approvalState: resolvedState, streamId,
          }),
        });
        service.emit('chat-stream', {
          type: 'tool_use', streamId, sessionId, model: service.currentModel,
          turnId: turnEventCollector?.turnId || streamId,
          callId, approvalId, ...(policyDecisionId ? { policyDecisionId } : {}),
          toolName, input: persistedInputSnapshot.input, summary, status: resolvedState,
          ...(approvalScope ? { approvalScope } : {}),
        });
        const resolutionEvent = buildApprovalCanonicalEvent({
          streamId, sessionId, callId, type: 'tool_approval_resolved',
          payload: {
            approval_id: approvalId, approval_state: resolvedState, approved: normalizedApproved,
            ...(approvalScope ? { approval_scope: approvalScope } : {}),
            ...(policyDecisionId ? { policy_decision_id: policyDecisionId } : {}), tool_name: toolName,
          },
        });
        noteTurnEvent(null, () => resolutionEvent);
        consentEventId = resolutionEvent.event_id;
        if (!normalizedApproved && toolName !== 'session_message') {
          planDocuments.abandonPlanApproval({ toolName, service, sessionId, streamId, callId, turnEventCollector });
          persistTerminalApprovalResult({
            service, sessionId, streamId, callId, toolName, summary,
            model: service.currentModel, approvalState: resolvedState,
            inputSnapshot: persistedInputSnapshot, policyDecisionId, turnEventCollector,
            output: approvalTerminalOutput(toolName, resolvedState, reason),
          });
        }
      } catch (settlementError) {
        if (toolName === 'session_message') normalizedApproved = false;
        service?._emitServiceLog?.('ERROR', 'chat.tool_approval_settlement_failed', {
          approvalId, sessionId, streamId, callId, toolName,
          approved: normalizedApproved, approvalState: resolvedState,
          message: String(settlementError?.message || settlementError || ''),
        });
      } finally {
        resolve(toolName === 'session_message'
          ? { approved: normalizedApproved, decision: resolvedState,
            consent_event_id: consentEventId }
          : planDocuments.planApprovalWaiterResult({ toolName, approved: normalizedApproved, state: resolvedState, feedback, plan }));
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
      ...(exactApproval ? { exactApprovalSha256 } : {}),
      messageId: rowMessageId,
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

module.exports = { EXACT_APPROVAL_FIELDS, buildExactApprovalPresentation, waitForApproval };
