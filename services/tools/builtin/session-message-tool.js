'use strict';

const { checkLiveCall } = require('./propose-tool-support');
const { supportsSessionMessageContext } = require('../../session-runtime/inference-protocol');
const { normalizeSessionMessageResultMetadata } = require('../../backend/tool-result-diff-metadata');
const { classify, validSessionId, isPlainObject } = require('../../chat-messaging-contract');
const { validateBody } = require('../../backend/session-message-envelope');
const { manifestSchema } = require('./tool-result');
const { RULE_DENIED_MESSAGE } = require('../../primary-action-rules');
const { sessionRunMode } = require('../../backend/action-rule-gate');

const ACTION_KEYS = Object.freeze({
  list_targets: ['action'], read: ['action', 'message_id'],
  send: ['action', 'destination_session_id', 'body'], list_inbox: ['action'],
});
const OPTIONAL_KEYS = Object.freeze({ list_inbox: ['limit'] });

// Row 87: accept-time refusals of an allow rule; the same prepared send then asks with the card instead.
const RULE_FALLBACK_REASONS = new Set(['rule_cap_reached', 'rule_not_live']);

// Summaries name only a known action, never the model's raw string.
function actionLabel(action) {
  return typeof action === 'string' && Object.hasOwn(ACTION_KEYS, action) ? action : 'invalid request';
}

function validInput(input) {
  if (!isPlainObject(input) || !Object.hasOwn(ACTION_KEYS, input.action)) return false;
  const keys = ACTION_KEYS[input.action];
  const optional = OPTIONAL_KEYS[input.action] || [];
  if (!keys.every(key => Object.hasOwn(input, key))
    || !Object.keys(input).every(key => keys.includes(key) || optional.includes(key))) return false;
  if (input.action === 'list_inbox') return !Object.hasOwn(input, 'limit')
    || (Number.isSafeInteger(input.limit) && input.limit >= 1 && input.limit <= 50);
  if (input.action === 'read') return typeof input.message_id === 'string' && input.message_id.length > 0
    && input.message_id.length <= 256;
  return input.action !== 'send' || (validSessionId(input.destination_session_id) && validateBody(input.body).ok);
}

function destinationView(value) {
  return { session_id: value.session_id, title: value.title, project_label: value.project_label ?? null };
}

function result(action, value) {
  return {
    content: JSON.stringify(value), summary: `Session message: ${actionLabel(action)}`,
    isError: false,
    metadata: normalizeSessionMessageResultMetadata({ result_kind: 'session_message', action, ...value }) || {},
  };
}

function failure(action, reason) {
  return result(action, { ok: false, reason: classify(reason).reason });
}

// Row 87 D3: the user's standing rule for this Jenny-chat send ({effect, rule_id}) or null. Never throws.
function messageRule(input, context, live) {
  try {
    const service = context.backendService;
    return service?.primaryActionRules?.match?.({
      action: 'message', sessionId: live.sessionId, turnId: live.turnId,
      target: { session_id: input.destination_session_id }, runMode: sessionRunMode(service, live.sessionId),
    }) || null;
  } catch (_error) { return null; }
}

// The exact-content card -> {kind:'once', consent_event_id} | null (refused, cancelled or failed).
async function askOnce(input, context, prepared) {
  let decision;
  try {
    // This is exact-content consent, including in Auto mode. Policy is never consent.
    decision = await context.authorize?.({
      tool_name: 'session_message', tool_call_id: context.callId, tool_input: input,
      one_off_only: true,
      messageFields: { session_message_approval: {
        schema_version: 1, operation_id: prepared.operation_id,
        destination: destinationView(prepared.destination), body: input.body,
        envelope_sha256: prepared.envelope_sha256, one_off_only: true,
      } },
    }, context.abortSignal);
  } catch (_error) { decision = null; }
  if (decision?.approved !== true || typeof decision.consent_event_id !== 'string'
    || !decision.consent_event_id || context.abortSignal?.aborted) return null;
  return { kind: 'once', consent_event_id: decision.consent_event_id };
}

// Spends `authorization` on the prepared send -> agentSend's answer, or a refusal after cancelling it.
async function sendAuthorized(service, operation, context, authorization) {
  if (!authorization) {
    try { await service.agentCancel(operation); } catch (_error) { /* Still report the consent refusal. */ }
    return { ok: false, reason: 'authorization_required' };
  }
  if (!checkLiveCall(context).ok) {
    await service.agentCancel(operation);
    return { ok: false, reason: 'stale_operation' };
  }
  return await service.agentSend({ ...operation, authorization }) || { ok: false, reason: 'unavailable' };
}

async function send(input, context, service, live) {
  const prepared = await service.agentPrepare({
    sourceSessionId: live.sessionId, sourceIncarnation: live.incarnation,
    turnId: live.turnId, toolCallId: context.callId,
    destinationSessionId: input.destination_session_id, body: input.body,
  });
  if (!prepared?.ok) return failure('send', prepared?.reason || 'unavailable');
  // A replayed call never asks again: a send already past consent reports its state, and one the
  // user refused (cancelled) or that failed stays refused.
  if (prepared.created === false && prepared.state !== 'prepared') {
    if (['pending', 'delivered'].includes(prepared.state)) {
      return result('send', { ok: true, operation_id: prepared.operation_id, state: prepared.state,
        destination: destinationView(prepared.destination) });
    }
    return failure('send', prepared.state === 'cancelled' ? 'authorization_required' : 'stale_operation');
  }
  const operation = { sourceSessionId: live.sessionId, operationId: prepared.operation_id };
  const rule = messageRule(input, context, live);
  if (rule?.effect === 'deny') {
    try { await service.agentCancel(operation); } catch (_error) { /* Still report the rule's refusal. */ }
    try { context.backendService?.primaryChatControls?.recordRuleDenied?.(rule.rule_id); } catch (_error) { /* Activity only */ }
    return result('send', { ok: false, reason: classify('rule_denied').reason, message: RULE_DENIED_MESSAGE });
  }
  // An ask rule always shows the card, even over a live grant; an allow rule defers to a live grant.
  const grantId = rule?.effect === 'ask' ? null : prepared.grant?.grant_id;
  const authorization = grantId ? { kind: 'grant', grant_id: grantId }
    : rule?.effect === 'allow' ? { kind: 'rule', rule_id: rule.rule_id } : await askOnce(input, context, prepared);
  let sent = await sendAuthorized(service, operation, context, authorization);
  // A rule refused at accept (cap reached, no longer live) left the SAME operation prepared: ask with the card.
  if (authorization?.kind === 'rule' && !sent.ok && RULE_FALLBACK_REASONS.has(sent.reason)) {
    try {
      context.backendService?._emitServiceLog?.('INFO', 'primary_action_rules.message_card_fallback', { rule_id: rule.rule_id, reason: sent.reason });
    } catch (_error) { /* diagnostics only */ }
    sent = await sendAuthorized(service, operation, context, await askOnce(input, context, prepared));
  }
  if (!sent.ok) return failure('send', sent.reason || 'unavailable');
  return result('send', { ok: true, operation_id: prepared.operation_id,
    state: sent.operation.state, destination: destinationView(prepared.destination) });
}

module.exports = {
  name: 'session_message', ...manifestSchema('session_message'), category: 'builtin', workspaceRequired: false,
  readOnly: false, sideEffecting: true,
  summarize: input => `Session message: ${actionLabel(input?.action)}`,
  async execute(input, context = {}) {
    if (!validInput(input)) return failure(input?.action, 'invalid_request');
    const action = input.action;
    if (!supportsSessionMessageContext(context.backendService?.sidecarClient)) return failure(action, 'unsupported');
    const live = checkLiveCall(context);
    if (!live.ok || !context.callId) return failure(action, 'stale_operation');
    if (action === 'send' && (context.readOnly || context.planMode)) return failure(action, 'authorization_required');
    const service = context.backendService?.chatMessages;
    if (!service) return failure(action, 'unavailable');
    try {
      if (action === 'send') return await send(input, context, service, live);
      const source = { sourceSessionId: live.sessionId, sourceIncarnation: live.incarnation };
      const response = action === 'read' ? await service.agentRead({ ...source, messageId: input.message_id })
        : action === 'list_inbox' ? await service.agentListInbox?.({ ...source, limit: input.limit ?? 20 })
          : await service.listAgentTargets(source);
      if (!response?.ok) return failure(action, response?.reason || 'unavailable');
      if (action === 'read') return result(action, { ok: true, envelope: response.envelope });
      if (action === 'list_inbox') {
        return result(action, { ok: true, messages: response.messages, counts: response.counts, truncated: response.truncated === true });
      }
      return result(action, { ok: true, targets: response.targets.map(target => ({
        ...destinationView(target), free_form_allowed: target.free_form_allowed === true,
        grant: target.grant ? { expires_at: target.grant.expires_at, remaining_sends: target.grant.remaining_sends } : null,
      })) });
    } catch (_error) { return failure(action, 'unavailable'); }
  },
};
