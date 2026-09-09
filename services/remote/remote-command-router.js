'use strict';

const defaultContracts = require('./remote-contracts');
const defaultLimits = require('./remote-limits');
const defaultPolicy = require('./remote-policy');

const LEASE_OPERATIONS = new Set([
  'chat.send',
  'chat.stop',
  'decision.tool',
  'decision.question',
  'decision.plan',
]);
const SESSION_FREE_OPERATIONS = new Set(['session.list', 'session.create', 'heartbeat', 'resync']);
const SAFE_REASONS = new Set([
  'control_required',
  'controlled_by_other',
  'internal_error',
  'session_not_shared',
  'epoch_invalid',
  'rate_limited',
  'share_failed',
]);

function createCommandRouter(options = {}) {
  const {
    contracts = defaultContracts,
    limits = defaultLimits,
    policy = defaultPolicy,
    chatAdapter,
    decisionAdapter,
    leases,
    getSession,
    hasGrant,
    featureFlags = () => ({}),
    now,
    currentEpoch,
    emitEvent = () => true,
    log = () => {},
  } = options;
  if (!chatAdapter || !decisionAdapter || !leases
    || typeof getSession !== 'function' || typeof hasGrant !== 'function'
    || typeof now !== 'function' || typeof currentEpoch !== 'function') {
    throw new TypeError('Invalid remote command router configuration.');
  }
  const limiter = limits.createRateLimiter({
    perMinute: limits.COMMANDS_PER_MIN,
    burst: limits.COMMANDS_BURST,
    now,
  });

  function error(requestId, code, reason = code, retryable = false) {
    const safeReason = SAFE_REASONS.has(reason) ? reason : String(code).slice(0, 64);
    return contracts.buildError(requestId, code, safeReason, retryable);
  }

  function mapAdapter(requestId, response) {
    if (!response || response.ok !== true) {
      const code = response?.error || response?.code || 'not_reachable';
      const known = Object.hasOwn(contracts.ERROR_CODES, code) ? code : 'not_reachable';
      const reason = SAFE_REASONS.has(response?.reason) ? response.reason : known;
      return error(requestId, known, reason, response?.retryable === true);
    }
    if (Object.hasOwn(response, 'data')) return contracts.buildResult(requestId, response.data);
    const data = { ...response };
    delete data.ok;
    return contracts.buildResult(requestId, data);
  }

  function normalizeCommand(command) {
    const validated = contracts.validateCommand(command);
    return validated?.ok ? validated.value : null;
  }

  function sessionContext(peer, command) {
    if (SESSION_FREE_OPERATIONS.has(command.operation)) {
      return { hasGrant, lease: null };
    }
    if (!command.session_id || !hasGrant(command.session_id)) {
      return { error: error(command.request_id, 'session_not_shared', 'session_not_shared') };
    }
    const session = getSession(command.session_id);
    if (!session || !policy.canListSession(session, featureFlags() || {})) {
      return { error: error(command.request_id, 'session_not_shared', 'session_not_shared') };
    }
    const lease = leases.leaseFor(command.session_id, peer.deviceId);
    if (LEASE_OPERATIONS.has(command.operation)
      && (!lease || (command.control_lease && command.control_lease !== lease.lease_id))) {
      return { error: error(command.request_id, 'unauthorized', 'control_required') };
    }
    return { hasGrant, lease };
  }

  async function dispatch(peer, command, context, isAuthorized) {
    const base = {
      deviceId: peer.deviceId,
      sessionId: command.session_id,
      requestId: command.request_id,
      hasGrant: context.hasGrant,
      lease: context.lease,
      isEpochLive: () => currentEpoch() === peer.epoch,
      isAuthorized,
    };
    switch (command.operation) {
      case 'session.list':
        return mapAdapter(command.request_id, await chatAdapter.listSessions(base));
      case 'session.create':
        return mapAdapter(command.request_id, await chatAdapter.createSession(base));
      case 'session.share_ack':
        return contracts.buildResult(command.request_id, {});
      case 'transcript.page':
        return mapAdapter(command.request_id, await chatAdapter.transcriptPage({
          ...base, ...command.payload,
        }));
      case 'chat.send':
        return mapAdapter(command.request_id, await chatAdapter.send({
          ...base, prompt: command.payload.prompt,
        }));
      case 'chat.stop':
        return mapAdapter(command.request_id, await chatAdapter.stop(base));
      case 'decision.tool':
        return mapAdapter(command.request_id, await decisionAdapter.decideTool({
          ...base,
          streamId: command.payload.stream_id,
          approvalId: command.payload.approval_id,
          decisionRevision: command.payload.decision_revision,
          decision: command.payload.decision,
        }));
      case 'decision.plan':
        return mapAdapter(command.request_id, await decisionAdapter.decidePlan({
          ...base,
          streamId: command.payload.stream_id,
          approvalId: command.payload.approval_id,
          decisionRevision: command.payload.decision_revision,
          decision: command.payload.decision,
          feedback: command.payload.feedback,
        }));
      case 'decision.question': {
        const method = command.payload.decision === 'answer'
          ? 'answerQuestions' : 'declineQuestions';
        return mapAdapter(command.request_id, await decisionAdapter[method]({
          ...base,
          questionRef: command.payload.question_ref,
          batchId: command.payload.batch_id,
          answers: command.payload.answers,
        }));
      }
      case 'control.request': {
        const granted = leases.request(command.session_id, peer.deviceId);
        if (!granted.ok) {
          return error(command.request_id, 'session_busy', 'controlled_by_other', true);
        }
        emitEvent({
          type: 'control_changed',
          session_id: command.session_id,
          payload: { controlled_by: peer.deviceId },
        });
        return contracts.buildResult(command.request_id, { lease: granted.lease });
      }
      case 'control.release': {
        const released = leases.release(command.session_id, peer.deviceId);
        if (released) emitEvent({
          type: 'control_changed', session_id: command.session_id,
          payload: { controlled_by: null },
        });
        return contracts.buildResult(command.request_id, {});
      }
      case 'heartbeat':
        return contracts.buildResult(command.request_id, { now: Number(now()) });
      case 'resync':
        return {
          resync: true,
          request_id: command.request_id,
          last_event_seq: command.payload.last_event_seq,
        };
      default:
        return error(command.request_id, 'invalid_request', 'invalid_request');
    }
  }

  async function handle({ peer, command, isAuthorized } = {}) {
    const normalized = normalizeCommand(command);
    const requestId = normalized ? normalized.request_id
      : (typeof command?.request_id === 'string' ? command.request_id.slice(0, 64) : 'invalid__');
    if (!normalized) return error(requestId, 'invalid_request', 'invalid_request');
    if (!peer || currentEpoch() !== peer.epoch) {
      return error(requestId, 'epoch_invalid', 'epoch_invalid');
    }
    if (!limiter.take(String(peer.deviceId || ''))) {
      return error(requestId, 'rate_limited', 'rate_limited', true);
    }
    const context = sessionContext(peer, normalized);
    if (context.error) return context.error;
    try {
      if (currentEpoch() !== peer.epoch) return error(requestId, 'epoch_invalid', 'epoch_invalid');
      const authority = typeof isAuthorized === 'function'
        ? isAuthorized : () => currentEpoch() === peer.epoch;
      const result = await dispatch(peer, normalized, context, authority);
      if (currentEpoch() !== peer.epoch) return null;
      return result;
    } catch (_error) {
      try { log('WARN', 'remote.command_failed', { operation: normalized.operation }); } catch (_ignored) { /* optional */ }
      return error(requestId, 'not_reachable', 'internal_error', true);
    }
  }

  return Object.freeze({ handle, normalizeCommand });
}

module.exports = { createCommandRouter };
