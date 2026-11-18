'use strict';

const { summarizeToolPayload } = require('./backend-service-utils');
const { buildToolUseMessageId } = require('./tool-message-id');
const {
  resolveApprovalCallId, sanitizeApprovalReason, sanitizeApprovalPolicyPresentation,
  buildPersistedToolInputSnapshot, sanitizeToolSummary, buildScopedApprovalId,
  makeNoteTurnEvent, buildToolCallPayload, buildApprovalCanonicalEvent, approvalStateFromAbortSignal,
  approvalTerminalOutput,
  sessionMessageApprovalFields,
  browserApprovalFields,
  findToolMessageId,
  peekToolLookupMessages,
} = require('./chat-stream-tool-payload-utils');
const planDocuments = require('./plan-document-events');
const { SESSION_STOP_SCOPE, TOOL_NAME: SESSION_STOP_TOOL, sessionStopApprovalFields } = require('./session-stop-approval');
const { SETTINGS_CHANGE_SCOPE, TOOL_NAME: SETTINGS_CHANGE_TOOL, settingsChangeApprovalFields } = require('./settings-change-approval');
const { SCHEDULE_CHANGE_SCOPE, TOOL_NAME: SCHEDULE_CHANGE_TOOL, scheduleChangeApprovalFields } = require('./schedule-change-approval');
const { TOOL_NAME: PROJECT_CREATE_TOOL, projectCreateRefusal } = require('./project-create-approval');
const { appControlCardStep, hasCardStep } = require('./app-control-card-refusals');
const { actionRuleDenial } = require('./action-rule-gate');
const { FULL_AUTO_SCOPE, fullAutoApproves } = require('./full-auto-gate');
const { TEAM_RULE_SCOPE, noteTeamRuleUse, teamRuleApproves } = require('./team-rule-gate');
const {
  ROUND_SCOPE, noteRoundAllowed, roundApprovalEventFields, roundGrantApproves, roundOfferFor,
} = require('./round-approval-gate');
const {
  CHAT_ALWAYS_ALLOW_SCOPE, CHAT_PYTHON_SCOPE, chatPythonGrantApproves, chatPythonGrantEligible, isPythonRequest,
} = require('./chat-python-grant-gate');
const { RULE_DENIED_MESSAGE } = require('../primary-action-rules');
const { MID_TOOL_CONSENT_TOOLS } = require('../tools/mid-tool-consent');
const {
  EXACT_APPROVAL_FIELDS, buildExactApprovalPresentation, commandAlwaysAllowScope, exactInputStillShown,
} = require('./chat-stream-exact-approval');
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
const UNATTENDED_PAUSE_APPROVAL_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const _setTimeout = setTimeout;
const _clearTimeout = clearTimeout;
// Only a tool's own consent executes it. A plan decision token (`accepted`,
// `rejected`) consents to a plan, never to another tool; a message send is
// consented only by an explicit `approved` (so is a browser step); `exit_plan_mode` takes any plan
// decision (resolvePlanApprovalState already fails unknown tokens closed).
const EXECUTING_APPROVAL_STATES = new Set(['approved', 'approved_auto']);
function approvalExecutes(toolName, state) {
  if (toolName === 'session_message' || toolName === 'browser') return state === 'approved';
  if (toolName === 'exit_plan_mode') return state !== 'denied';
  return EXECUTING_APPROVAL_STATES.has(state);
}

// Row 87 D6 (Q2, owner pick C1): a primary-chat message card to one of its own linked chats offers the button
// "Always allow for chats Jenny started" while rules are on. Only the user's answer can take the offer (`remember`); the model never sets it.
function linkedChildrenOffer(service, sessionId, turnId, messageFields) {
  try {
    const controls = service?.primaryChatControls;
    const destinationId = messageFields.session_message_approval?.destination?.session_id;
    if (!destinationId || controls?.actionRulesEnabled?.() !== true || controls.isPrimary?.(sessionId) !== true) return '';
    const parent = service.sessionStore?.getSessionSummary?.(destinationId)?.spawned_from?.parent_session_id;
    if (parent !== sessionId) return '';
    // A deny or ask rule already covering this chat outranks a new allow, so the button would change nothing.
    const covering = service.primaryActionRules?.match?.({ action: 'message', sessionId, turnId, target: { session_id: destinationId } });
    return covering && covering.effect !== 'allow' ? '' : 'linked_children';
  } catch (_error) {
    return '';
  }
}

// Nobody was asked, so this is not the user's Deny: the sidecar gives `feedback` to the model as the
// call's result and the turn goes on. The row is already written; the call never runs.
const appRefused = (feedback) => ({ approved: false, decision: 'app_refused', feedback });

async function waitForApproval(service, streamId, sessionId, requestId, params, controller,
  turnEventCollector, executionAuthority, persistTerminalApprovalResult) {
  const toolName = String(params.tool_name || '').trim();
  const callId = resolveApprovalCallId(toolName, params.tool_call_id);
  const policyDecisionId = String(
    params.policy_decision_id || params.policyDecisionId || ''
  ).trim();
  const askedReason = controller.unattendedPauseRequested === true
    ? 'Auto paused after keyboard or mouse inactivity. ' + sanitizeApprovalReason(params.reason)
    : sanitizeApprovalReason(params.reason);
  const presentation = sanitizeApprovalPolicyPresentation(params);
  const policyScope = toolName === SESSION_STOP_TOOL ? SESSION_STOP_SCOPE
    : toolName === SETTINGS_CHANGE_TOOL ? SETTINGS_CHANGE_SCOPE
      : toolName === SCHEDULE_CHANGE_TOOL ? SCHEDULE_CHANGE_SCOPE : presentation.policyScope;
  const { policyConsequence } = presentation;
  const input = params.tool_input && typeof params.tool_input === 'object' ? params.tool_input : {};
  const commandScope = commandAlwaysAllowScope(toolName, input);
  // A settings batch and a scheduled-check change are approved once, never always (rows 88 / 85; also NEVER_PERSIST_ALWAYS_ALLOW),
  // and so is a chained command (row 103).
  const askedOnce = toolName === 'session_message' || toolName === SETTINGS_CHANGE_TOOL || toolName === SCHEDULE_CHANGE_TOOL
    || toolName === PROJECT_CREATE_TOOL || hasCardStep(toolName)
    || params.one_off_only === true || commandScope?.kind === 'none';
  // D1 (session review 2026-11-17): Python's Always is a grant for this chat. Where that grant cannot apply
  // (team host, paranoid mode), the card offers Allow once only: it never offers an Always nothing honours.
  const pythonCall = isPythonRequest(toolName, input);
  const chatGrantable = pythonCall && chatPythonGrantEligible(service, { toolName, input, oneOffOnly: askedOnce });
  const oneOffOnly = askedOnce || (pythonCall && !chatGrantable);
  const alwaysAllowScope = commandScope || (chatGrantable ? CHAT_ALWAYS_ALLOW_SCOPE : null);
  const persistedInputSnapshot = buildPersistedToolInputSnapshot(input);
  const exactApproval = buildExactApprovalPresentation(toolName, input);
  const exactApprovalSha256 = exactApproval?.sha256 || '';
  // D10: read once for every request of the stream, so a request that is not the next call of an allowed round
  // ends that round. The answer is used only after every refusal below has had its say.
  const roundGranted = roundGrantApproves(service, controller, { toolName, callId, oneOffOnly, exactApprovalSha256 });
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
  // The sidecar's `tool_call_requested` may already have written this call's
  // tool_use row; the pending state updates that row instead of appending a twin.
  const existingToolUseId = findToolMessageId(peekToolLookupMessages(service, sessionId), {
    kind: 'tool_use', callId, streamId, fallbackId: toolUseMessageId,
  });
  const rowMessageId = existingToolUseId || toolUseMessageId;
  // A refusal before any card still names its call, or the sidecar's approval events project as orphans.
  const noteRefusedToolUse = () => noteTurnEvent('tool_use', () => ({
    primary_message_id: rowMessageId, source_message_ids: [rowMessageId], tool_call_id: callId, status: 'denied',
    payload: { tool_name: toolName, input: persistedInputSnapshot.input, summary, parent_stream_id: streamId },
  }));
  // Row 87: a user's deny rule refuses a Jenny-chat stop, settings change or scheduled-check change before any card.
  if (actionRuleDenial(service, { toolName, sessionId, turnId: turnEventCollector?.turnId || streamId, input })) {
    noteRefusedToolUse();
    persistTerminalApprovalResult({
      service, sessionId, streamId, callId, toolName, summary, model: service.currentModel, approvalState: 'denied',
      inputSnapshot: persistedInputSnapshot, policyDecisionId, turnEventCollector, output: RULE_DENIED_MESSAGE,
      metadata: { rule_denied: true },
    });
    return appRefused(RULE_DENIED_MESSAGE);
  }
  // Row 94 P2 / P4: a project, export or terminal command its port refuses ends here with its reason, before any card.
  const cardStep = hasCardStep(toolName) ? await appControlCardStep(service, toolName, sessionId, callId, input) : null;
  const projectRefusal = toolName === PROJECT_CREATE_TOOL ? await projectCreateRefusal(service, sessionId, callId, input) : cardStep?.refusal || null;
  // The export's file name or the terminal's folder joins the reason, so the card names where the result lands.
  const reason = cardStep?.cardNote ? `${askedReason} ${sanitizeApprovalReason(cardStep.cardNote)}`.trim() : askedReason;
  if (projectRefusal) {
    noteRefusedToolUse();
    persistTerminalApprovalResult({
      service, sessionId, streamId, callId, toolName, summary, model: service.currentModel, approvalState: 'denied',
      inputSnapshot: persistedInputSnapshot, policyDecisionId, turnEventCollector, output: projectRefusal,
      metadata: { app_refused: true },
    });
    return appRefused(projectRefusal);
  }
  const messageFields = { ...sessionMessageApprovalFields(params), ...browserApprovalFields(params) };
  // Only a stop, a settings change and a scheduled-check change await here (every other approval registers synchronously); read
  // before the duplicate check below, which stays synchronous with the waiter's registration. The
  // settings card's rows are the app's own reading (row 88 D3), remembered by the port under this call.
  const stopFields = toolName === SESSION_STOP_TOOL ? await sessionStopApprovalFields(service, sessionId, input)
    : toolName === SETTINGS_CHANGE_TOOL ? await settingsChangeApprovalFields(service, sessionId, callId, input)
      : toolName === SCHEDULE_CHANGE_TOOL ? await scheduleChangeApprovalFields(service, sessionId, input) : {};
  // Missing exact-content presentation must fail closed; never ask over a clipped preview.
  if (toolName === 'session_message' && !messageFields.session_message_approval) return false;
  if (toolName === 'browser' && !messageFields.browser_approval) return false;
  const rememberOffer = toolName === 'session_message' ? linkedChildrenOffer(service, sessionId, turnEventCollector?.turnId || streamId, messageFields) : '';

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
  // Row 111: nobody is shown a card, and the same settlement as a person's Allow once runs below.
  const answeredByFullAuto = fullAutoApproves(service, { toolName, sessionId, executionAuthority });
  // Slice 3-12 (E66): on a team host, a project admin's rule answers write_file / edit_file the same way.
  const teamRule = answeredByFullAuto ? null
    : teamRuleApproves(service, { toolName, sessionId, input: params.tool_input, oneOffOnly, executionAuthority });
  // D10 (row 166): the next edit of a round the user allowed on its first card, asking for exactly what was shown.
  const answeredByRound = roundGranted && !answeredByFullAuto && teamRule === null;
  // D1: a Python call in a chat whose person pressed "Always for this chat" on an earlier Python card.
  const answeredByChatPython = !answeredByFullAuto && teamRule === null && !answeredByRound && chatGrantable
    && chatPythonGrantApproves(service, { toolName, input, sessionId, executionAuthority, oneOffOnly, controller });
  const answeredWithoutCard = answeredByFullAuto || teamRule !== null || answeredByRound || answeredByChatPython;
  // What this card may offer with its own call: the round's later edits, each shown whole.
  const roundOffer = answeredWithoutCard ? []
    : roundOfferFor(service, { toolName, callId, params, oneOffOnly, exactApproval });

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

  if (!answeredWithoutCard) service.emit('chat-stream', {
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
  if (!answeredWithoutCard) service.emit('chat-stream', {
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
    ...roundApprovalEventFields(roundOffer),
    ...(alwaysAllowScope ? { alwaysAllowScope } : {}),
    ...(rememberOffer ? { rememberOffer } : {}),
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
    const finish = (approved, approvalState = 'denied', feedback = '', plan = null, scope = '', remember = '') => {
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
      const roundScoped = scope === ROUND_SCOPE && (answeredByRound || roundOffer.length > 0);
      const approvalScope = normalizedApproved && (scope === 'always' || scope === 'once'
        || scope === FULL_AUTO_SCOPE || scope === TEAM_RULE_SCOPE || roundScoped
        || (scope === CHAT_PYTHON_SCOPE && pythonCall)) ? scope : '';
      const ruleFields = approvalScope === TEAM_RULE_SCOPE ? { teamRuleSeq: teamRule.rule_seq } : {};
      // The receipt names the saved command prefix (row 103); an exact grant quotes the command.
      const alwaysAllowPrefix = approvalScope === 'always' && alwaysAllowScope?.kind === 'prefix' ? alwaysAllowScope.prefix : '';
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
          ...(alwaysAllowPrefix ? { alwaysAllowPrefix } : {}), ...ruleFields,
        });
        const resolutionEvent = buildApprovalCanonicalEvent({
          streamId, sessionId, callId, type: 'tool_approval_resolved',
          payload: {
            approval_id: approvalId, approval_state: resolvedState, approved: normalizedApproved,
            ...(approvalScope ? { approval_scope: approvalScope } : {}),
            ...(alwaysAllowPrefix ? { always_allow_prefix: alwaysAllowPrefix } : {}),
            ...(ruleFields.teamRuleSeq ? { team_rule_seq: ruleFields.teamRuleSeq } : {}),
            ...(policyDecisionId ? { policy_decision_id: policyDecisionId } : {}), tool_name: toolName,
          },
        });
        noteTurnEvent(null, () => resolutionEvent);
        if (ruleFields.teamRuleSeq) noteTeamRuleUse(service, { sessionId, ruleSeq: ruleFields.teamRuleSeq });
        consentEventId = resolutionEvent.event_id;
        // D10: the user pressed "Allow all" on a card that showed these calls whole.
        if (approvalScope === ROUND_SCOPE && !answeredByRound) noteRoundAllowed(controller, toolName, roundOffer);
        // Hosted commands keep their explicit one-off approval, so a wait there asks again.
        if (normalizedApproved && service.hostMode !== 'server') service.approvedCallGrants?.noteApproved({ streamId, callId, toolName, input });
        if (!normalizedApproved && !MID_TOOL_CONSENT_TOOLS.has(toolName)) {
          planDocuments.abandonPlanApproval({ toolName, service, sessionId, streamId, callId, turnEventCollector });
          persistTerminalApprovalResult({
            service, sessionId, streamId, callId, toolName, summary,
            model: service.currentModel, approvalState: resolvedState,
            inputSnapshot: persistedInputSnapshot, policyDecisionId, turnEventCollector,
            output: approvalTerminalOutput(toolName, resolvedState, reason),
          });
        }
        // Row 87 D6: the user pressed "Always allow for chats Jenny started" on an offered card. Best
        // effort: a failed rule write never changes this approval.
        if (normalizedApproved && rememberOffer && remember === rememberOffer) {
          try {
            service.primaryChatControls?.addActionRule?.({ action: 'message', target: { kind: 'linked_children' }, effect: 'allow' });
          } catch (_error) {
            service?._emitServiceLog?.('WARN', 'primary_action_rules.remember_failed', { approvalId, sessionId, callId });
          }
        }
      } catch (settlementError) {
        if (MID_TOOL_CONSENT_TOOLS.has(toolName)) normalizedApproved = false;
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
      // The presentation itself, not just its hash: a chat reopened mid-wait rebuilds its card from
      // the active-turn snapshot (backend-active-turn-state.js), which reads it from here.
      ...(exactApproval ? { exactApproval, exactApprovalSha256 } : {}),
      messageId: rowMessageId,
      resolve: finish,
      requireExactRef: Boolean(controller._runtimeDecisionControl && params.runtime_decision),
      policyDecisionId,
      ...(reason ? { reason } : {}),
      policyScope,
      policyConsequence,
      ...(oneOffOnly ? { oneOffOnly: true } : {}),
      // A chat reopened mid-wait rebuilds the card's Always allow label from here.
      ...(alwaysAllowScope ? { alwaysAllowScope } : {}),
      // Row 87: so a reopened chat can rebuild the card's "Always allow for chats Jenny started" button.
      ...(rememberOffer ? { rememberOffer } : {}),
      // D10: the round this card offers, so a reopened chat rebuilds it and an answer can take it.
      ...(roundOffer.length ? { roundOffer } : {}),
      executionAuthority,
    });
    if (controller.signal.aborted) {
      finish(false, 'cancelled');
      return;
    }
    if (answeredWithoutCard) {
      finish(true, 'approved', '', null,
        answeredByFullAuto ? FULL_AUTO_SCOPE : (teamRule !== null ? TEAM_RULE_SCOPE
          : (answeredByChatPython ? CHAT_PYTHON_SCOPE : ROUND_SCOPE)));
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
