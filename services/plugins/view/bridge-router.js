'use strict';

const { validate } = require('../contracts/generated-plugin-contracts');
const { validateBridgeMessage, checkResponseSize } = require('./bridge-message-validator');
const { VIEW_LIMITS, STAGE7_LIMITS } = require('./stage7-budgets');

const REQUEST_OPERATIONS = Object.freeze([
  'get_context', 'read_settings', 'update_settings', 'provider_auth_status',
  'provider_auth_start', 'provider_auth_cancel', 'provider_auth_sign_out',
  'provider_activate', 'artifact_read_chunk', 'artifact_ready', 'artifact_error',
]);
const EVENT_TOPICS = Object.freeze([
  'context_changed', 'settings_changed', 'provider_auth_changed', 'artifact_changed',
]);

function boundedResult(requestId, status, reasonCode = '', retryable = false, payload = null) {
  const candidate = {
    result_schema_version: 5,
    request_id: requestId,
    status,
    reason_code: reasonCode,
    retryable,
    payload_json: JSON.stringify(payload),
  };
  const checked = validate('PluginViewResultV5', candidate);
  return checked.ok ? checked.value : {
    result_schema_version: 5, request_id: requestId, status: 'failed',
    reason_code: 'bridge_result_invalid', retryable: false, payload_json: 'null',
  };
}

async function invokeBoundedHandler({ state, requestId, handler, args,
  context, unavailableReason, failureReason }) {
  if (state.cancelled.delete(requestId)) {
    return boundedResult(requestId, 'cancelled', 'cancelled_by_view');
  }
  if (typeof handler !== 'function') {
    return boundedResult(requestId, 'rejected', unavailableReason);
  }
  const value = await handler(...args, context, { requestId });
  if (state.cancelled.delete(requestId)) {
    return boundedResult(requestId, 'cancelled', 'cancelled_by_view');
  }
  const resultPayload = value?.value ?? value ?? null;
  if (value?.ok !== false && !checkResponseSize(resultPayload, VIEW_LIMITS).ok) {
    return boundedResult(requestId, 'failed', 'bridge_response_too_large');
  }
  const result = value?.ok === false
    ? boundedResult(requestId, 'failed', value.reason || failureReason, value.retryable === true)
    : boundedResult(requestId, 'succeeded', '', false, resultPayload);
  return checkResponseSize(result, VIEW_LIMITS).ok
    ? result : boundedResult(requestId, 'failed', 'bridge_response_too_large');
}

class PluginViewBridgeRouter {
  constructor({ resolveContext, handlers = {}, sessionProviderHandler = null,
    now = () => Date.now(), log = () => {} } = {}) {
    if (typeof resolveContext !== 'function') throw new TypeError('bridge router requires resolveContext');
    this.resolveContext = resolveContext;
    this.handlers = handlers;
    this.sessionProviderHandler = sessionProviderHandler;
    this.now = now;
    this.log = log;
    this.states = new Map();
  }

  _state(id) {
    if (!this.states.has(id)) this.states.set(id, {
      rate: { windowStartMs: this.now(), countInWindow: 0, queueLength: 0 },
      subscriptions: new Set(), cancelled: new Set(), sequence: 0,
    });
    return this.states.get(id);
  }

  async route(event, message) {
    const context = this.resolveContext(event, message);
    if (!context || context.senderId !== event?.sender?.id || context.origin !== event?.senderFrame?.origin) {
      return boundedResult('bridge_request', 'rejected', 'bridge_sender_rejected');
    }
    const state = this._state(context.viewInstanceId);
    const checked = validateBridgeMessage(message, {
      ...context, limits: VIEW_LIMITS,
      allowedMethods: ['request', 'subscribe', 'unsubscribe', 'cancel'],
    }, state.rate, this.now());
    if (!checked.ok) return boundedResult('bridge_request', 'rejected', checked.error.code);
    state.rate = checked.rateState;
    let payload;
    try { payload = JSON.parse(message.payload_json); } catch (_error) {
      state.rate.queueLength -= 1;
      return boundedResult('bridge_request', 'rejected', 'bridge_payload_not_json');
    }
    const requestId = typeof payload.request_id === 'string' ? payload.request_id : 'bridge_request';
    try {
      if (message.method === 'cancel') {
        if (!state.cancelled.has(requestId)
          && state.cancelled.size >= STAGE7_LIMITS.bridge_queue) {
          return boundedResult(requestId, 'rejected', 'bridge_cancel_limit_exceeded');
        }
        state.cancelled.add(requestId);
        return boundedResult(requestId, 'cancelled', 'cancelled_by_view');
      }
      if (message.method === 'subscribe' || message.method === 'unsubscribe') {
        const topic = payload.topic;
        if (!EVENT_TOPICS.includes(topic) || !context.allowedEventTopics?.includes(topic)) {
          return boundedResult(requestId, 'rejected', 'bridge_topic_not_allowed');
        }
        if (message.method === 'subscribe') {
          if (state.subscriptions.size >= STAGE7_LIMITS.bridge_subscriptions) {
            return boundedResult(requestId, 'rejected', 'bridge_subscription_limit_exceeded');
          }
          state.subscriptions.add(topic);
        } else state.subscriptions.delete(topic);
        return boundedResult(requestId, 'succeeded', '', false, { topic });
      }
      if (payload?.call_schema_version === 1 && payload?.action) {
        const call = validate('PluginSessionProviderViewCallV1', payload);
        if (!call.ok || context.sessionProviderAuthorized !== true
          || typeof this.sessionProviderHandler !== 'function') {
          return boundedResult(requestId, 'rejected', 'session_provider_call_not_allowed');
        }
        return await invokeBoundedHandler({ state, requestId, handler: this.sessionProviderHandler,
          args: [call.value], context, unavailableReason: 'session_provider_call_not_allowed',
          failureReason: 'session_provider_call_failed' });
      }
      const call = validate('PluginViewCallV5', payload);
      if (!call.ok || !REQUEST_OPERATIONS.includes(payload.operation)
        || !context.allowedOperations?.includes(payload.operation)) {
        return boundedResult(requestId, 'rejected', 'bridge_operation_not_allowed');
      }
      const handler = this.handlers[payload.operation];
      const operationPayload = JSON.parse(payload.payload_json);
      return await invokeBoundedHandler({ state, requestId, handler, args: [operationPayload], context,
        unavailableReason: 'bridge_operation_unavailable', failureReason: 'bridge_operation_failed' });
    } catch (_error) {
      this.log('plugin.view.bridge_failed', { reason_code: 'bridge_operation_failed' });
      return boundedResult(requestId, 'failed', 'bridge_operation_failed');
    } finally {
      state.rate.queueLength = Math.max(0, state.rate.queueLength - 1);
    }
  }

  detach(viewInstanceId) { this.states.delete(viewInstanceId); }

  publish(viewInstanceId, topic, payload, deliver) {
    const state = this.states.get(viewInstanceId);
    if (!state?.subscriptions.has(topic) || !EVENT_TOPICS.includes(topic) || typeof deliver !== 'function') return false;
    const candidate = {
      event_schema_version: 5,
      sequence: state.sequence += 1,
      topic,
      payload_json: JSON.stringify(payload ?? null),
    };
    const checked = validate('PluginViewEventV5', candidate);
    if (!checked.ok || !checkResponseSize(checked.value, VIEW_LIMITS).ok) return false;
    deliver(checked.value);
    return true;
  }
}

module.exports = { REQUEST_OPERATIONS, EVENT_TOPICS, boundedResult, PluginViewBridgeRouter };
