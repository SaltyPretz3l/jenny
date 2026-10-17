'use strict';

const { checkLiveCall } = require('./propose-tool-support');
const { supportsSessionMessageContext } = require('../../session-runtime/inference-protocol');
const { normalizeSessionMessageResultMetadata } = require('../../backend/tool-result-diff-metadata');
const { classify, validSessionId, isPlainObject } = require('../../chat-messaging-contract');
const { validateBody } = require('../../backend/session-message-envelope');

const ACTION_KEYS = Object.freeze({
  list_targets: ['action'], read: ['action', 'message_id'],
  send: ['action', 'destination_session_id', 'body'],
});

function validInput(input) {
  if (!isPlainObject(input) || !Object.hasOwn(ACTION_KEYS, input.action)) return false;
  const keys = ACTION_KEYS[input.action];
  if (Object.keys(input).length !== keys.length || !keys.every(key => Object.hasOwn(input, key))) return false;
  if (input.action === 'read') return typeof input.message_id === 'string' && input.message_id.length > 0
    && input.message_id.length <= 256;
  return input.action !== 'send' || (validSessionId(input.destination_session_id) && validateBody(input.body).ok);
}

function destinationView(value) {
  return { session_id: value.session_id, title: value.title, project_label: value.project_label ?? null };
}

function result(action, value) {
  return {
    content: JSON.stringify(value), summary: `Session message: ${action || 'invalid request'}`,
    isError: false,
    metadata: normalizeSessionMessageResultMetadata({ result_kind: 'session_message', action, ...value }) || {},
  };
}

function failure(action, reason) {
  return result(action, { ok: false, reason: classify(reason).reason });
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
  let authorization;
  if (prepared.grant?.grant_id) {
    authorization = { kind: 'grant', grant_id: prepared.grant.grant_id };
  } else {
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
      || !decision.consent_event_id || context.abortSignal?.aborted) {
      try { await service.agentCancel(operation); } catch (_error) { /* Still report the consent refusal. */ }
      return failure('send', 'authorization_required');
    }
    authorization = { kind: 'once', consent_event_id: decision.consent_event_id };
  }
  if (!checkLiveCall(context).ok) {
    await service.agentCancel(operation);
    return failure('send', 'stale_operation');
  }
  const sent = await service.agentSend({ ...operation, authorization });
  if (!sent?.ok) return failure('send', sent?.reason || 'unavailable');
  return result('send', { ok: true, operation_id: prepared.operation_id,
    state: sent.operation.state, destination: destinationView(prepared.destination) });
}

module.exports = {
  name: 'session_message', category: 'builtin', workspaceRequired: false,
  description: 'List messaging targets, read included mail, or send an exact message to another chat.',
  readOnly: false, sideEffecting: true, parameters: {},
  summarize: input => `Session message: ${input?.action || 'invalid request'}`,
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
      const response = action === 'read'
        ? await service.agentRead({ ...source, messageId: input.message_id })
        : await service.listAgentTargets(source);
      if (!response?.ok) return failure(action, response?.reason || 'unavailable');
      if (action === 'read') return result(action, { ok: true, envelope: response.envelope });
      return result(action, { ok: true, targets: response.targets.map(target => ({
        ...destinationView(target), free_form_allowed: target.free_form_allowed === true,
        grant: target.grant ? { expires_at: target.grant.expires_at, remaining_sends: target.grant.remaining_sends } : null,
      })) });
    } catch (_error) { return failure(action, 'unavailable'); }
  },
};
