'use strict';

const crypto = require('node:crypto');
const {
  validateChatStartPayload: defaultValidateChatStartPayload,
} = require('../backend/generated-chat-lifecycle-contract');
const { normalizeManagedToolPreferences } = require('../backend/backend-service-utils');
const { CANCEL_REASON_USER } = require('../backend/chat-stream-terminal-utils');
const { redactSensitiveLikeText } = require('../backend/tool-loop-input-sanitization');
const defaultProjector = require('./remote-transcript-projector');

const MAX_ERROR_REASON_CHARS = 200;
const RECEIPT_TTL_MS = 600_000;
const EVICTED_RECEIPTS_MAX = 1024;

function failure(error, detail = '', retryable = false) {
  const safeDetail = redactSensitiveLikeText(String(detail || '')).slice(0, MAX_ERROR_REASON_CHARS);
  return {
    ok: false,
    error,
    reason: error,
    retryable,
    ...(safeDetail && safeDetail !== error ? { detail: safeDetail } : {}),
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function projectSession(session, leases) {
  return {
    id: String(session?.id || ''),
    title: String(session?.title || ''),
    updated_at: String(session?.updated_at || ''),
    message_count: Number.isSafeInteger(session?.message_count) ? session.message_count : 0,
    last_message_preview: String(session?.last_message_preview || ''),
    controlled_by: leases?.controllerOf?.(session?.id) || null,
  };
}

function resultData(value) {
  if (Array.isArray(value)) return value;
  return value && typeof value === 'object' && Object.hasOwn(value, 'data') ? value.data : value;
}

function createRemoteChatAdapter(deps = {}) {
  const {
    backendService,
    featureFlags = () => ({}),
    now = Date.now,
    limits = {},
    policy = {},
    contracts = {},
    leases,
    cancellations,
    shareSession,
    currentEpoch = () => '',
  } = deps;
  if (!backendService) throw new TypeError('Remote chat requires a backend service.');
  const validateChatStartPayload = deps.validateChatStartPayload
    || contracts.validateChatStartPayload
    || defaultValidateChatStartPayload;
  const sendLimiter = limits.createRateLimiter({
    perMinute: limits.SENDS_PER_MIN,
    burst: limits.SENDS_PER_MIN,
    now,
  });
  const createLimiter = limits.createRateLimiter({
    perMinute: limits.SESSION_CREATES_PER_HOUR / 60,
    burst: limits.SESSION_CREATES_PER_HOUR,
    now,
  });
  const receipts = new Map();
  const evicted = new Map();
  const receiptLimit = Math.max(1, limits.PENDING_COMMANDS_MAX * (limits.MAX_DEVICES || 1));

  function timestamp() {
    const value = Number(now());
    return Number.isFinite(value) ? value : Date.now();
  }

  function receiptKey(deviceId, epoch, operation, requestId) {
    return `${String(deviceId || '')}\u0000${epoch}\u0000${operation}\u0000${String(requestId || '')}`;
  }

  function rememberEvicted(key, at) {
    evicted.delete(key);
    evicted.set(key, at);
    while (evicted.size > EVICTED_RECEIPTS_MAX) evicted.delete(evicted.keys().next().value);
  }

  function pruneReceipts(epoch, at) {
    for (const [key, receipt] of receipts) {
      if (receipt.settledAt == null) continue;
      if (receipt.epoch !== epoch || at - receipt.settledAt >= RECEIPT_TTL_MS) {
        receipts.delete(key);
        rememberEvicted(key, at);
      }
    }
    while (receipts.size > receiptLimit) {
      const oldestSettled = [...receipts].find(([, receipt]) => receipt.settledAt != null);
      if (!oldestSettled) break;
      receipts.delete(oldestSettled[0]);
      rememberEvicted(oldestSettled[0], at);
    }
  }

  function withReceipt({ deviceId, operation, requestId, payload }, run) {
    if (!String(deviceId || '').trim()) {
      return Promise.resolve(failure('invalid_request', 'device_id is required'));
    }
    if (!String(requestId || '').trim()) {
      return Promise.resolve(failure('invalid_request', 'request_id is required'));
    }
    const epoch = String(currentEpoch() || '');
    const at = timestamp();
    pruneReceipts(epoch, at);
    const key = receiptKey(deviceId, epoch, operation, requestId);
    const payloadDigest = digest(payload);
    const existing = receipts.get(key);
    if (existing) {
      return existing.digest === payloadDigest
        ? existing.promise
        : Promise.resolve(failure('invalid_request', 'request_id was reused with different content'));
    }
    if (evicted.has(key)) return Promise.resolve(failure('invalid_request', 'request_id expired'));
    const receipt = { digest: payloadDigest, promise: null, settledAt: null, epoch };
    const promise = Promise.resolve().then(run).finally(() => {
      receipt.settledAt = timestamp();
      pruneReceipts(String(currentEpoch() || ''), receipt.settledAt);
    });
    receipt.promise = promise;
    receipts.set(key, receipt);
    pruneReceipts(epoch, at);
    return promise;
  }

  function readSession(sessionId) {
    try {
      return backendService.sessionStore?.getSession?.(sessionId) || null;
    } catch (_error) {
      return null;
    }
  }

  function inputAuthorized(input) {
    return input.isEpochLive?.() !== false && input.isAuthorized?.() !== false;
  }

  function authorizeSharedSession(sessionId, hasGrant) {
    const normalized = String(sessionId || '').trim();
    if (!normalized || typeof hasGrant !== 'function' || !hasGrant(normalized)) {
      return { error: failure('session_not_shared') };
    }
    const session = readSession(normalized);
    if (!session) return { error: failure('session_not_shared') };
    const flags = featureFlags() || {};
    if (!policy.canListSession(session, flags)) {
      return { error: session.lockdown === true
        ? failure('lockdown') : failure('session_not_shared') };
    }
    return { session, flags, sessionId: normalized };
  }

  async function listSessions({ hasGrant = () => false } = {}) {
    let response;
    try {
      response = await backendService.listSessions();
    } catch (error) {
      return failure('not_reachable', error?.message || error, true);
    }
    const sessions = Array.isArray(resultData(response)) ? resultData(response) : [];
    const flags = featureFlags() || {};
    return {
      ok: true,
      sessions: sessions
        .filter((session) => hasGrant(session?.id) && policy.canListSession(session, flags))
        .map((session) => projectSession(session, leases)),
    };
  }

  function createSession(input = {}) {
    const { deviceId, requestId } = input;
    if (!String(deviceId || '').trim() || !String(requestId || '').trim()) {
      return Promise.resolve(failure('invalid_request', 'request_id is required'));
    }
    const receiptEpoch = String(currentEpoch() || '');
    const at = timestamp();
    pruneReceipts(receiptEpoch, at);
    const key = receiptKey(deviceId, receiptEpoch, 'session.create', requestId);
    let receipt = receipts.get(key);
    if (receipt?.complete) return receipt.promise;
    if (receipt?.running) return receipt.promise;
    if (evicted.has(key)) return Promise.resolve(failure('invalid_request', 'request_id expired'));
    if (!receipt) {
      receipt = {
        digest: digest({}),
        epoch: receiptEpoch,
        promise: null,
        settledAt: null,
        running: false,
        complete: false,
        created: false,
        sessionId: '',
      };
      receipts.set(key, receipt);
    }
    receipt.running = true;
    receipt.promise = Promise.resolve().then(async () => {
      if (input.isEpochLive?.() === false) return failure('epoch_invalid');
      if (input.isAuthorized?.() === false) return failure('unauthorized');
      if (!receipt.created) {
        if (!createLimiter.take(String(deviceId))) {
          return failure('rate_limited', 'session create rate limit exceeded', true);
        }
        try {
          const response = await backendService.createSession({ title: 'Phone chat' });
          const session = resultData(response);
          receipt.created = true;
          receipt.sessionId = String(session?.id || '');
        } catch (error) {
          return failure('not_reachable', error?.message || error, true);
        }
      }
      if (input.isEpochLive?.() === false) return failure('epoch_invalid');
      if (input.isAuthorized?.() === false) return failure('unauthorized');
      try {
        const shared = await shareSession?.(receipt.sessionId);
        if (!shared?.ok) {
          return {
            ok: false,
            error: 'not_reachable',
            reason: 'share_failed',
            retryable: true,
          };
        }
      } catch (_error) {
        return {
          ok: false,
          error: 'not_reachable',
          reason: 'share_failed',
          retryable: true,
        };
      }
      if (input.isEpochLive?.() === false) return failure('epoch_invalid');
      if (input.isAuthorized?.() === false) return failure('unauthorized');
      const session = readSession(receipt.sessionId) || { id: receipt.sessionId };
      const result = { ok: true, data: projectSession(session, leases) };
      receipt.complete = true;
      return result;
    }).finally(() => {
      receipt.running = false;
      receipt.settledAt = timestamp();
      pruneReceipts(String(currentEpoch() || ''), receipt.settledAt);
    });
    return receipt.promise;
  }

  function send(input = {}) {
    const { deviceId, sessionId, prompt, requestId, hasGrant, lease } = input;
    const forbiddenInput = (policy.FORBIDDEN_BACKEND_OPTIONS || [])
      .find((key) => Object.hasOwn(input, key));
    if (forbiddenInput) {
      return Promise.resolve(failure('invalid_request', `forbidden field: ${forbiddenInput}`));
    }
    return withReceipt({
      deviceId,
      requestId,
      operation: 'chat.send',
      payload: { sessionId, prompt },
    }, async () => {
      if (input.isEpochLive?.() === false) return failure('epoch_invalid');
      const authorization = authorizeSharedSession(sessionId, hasGrant);
      if (authorization.error) return authorization.error;
      if (!policy.canSend(authorization.session, authorization.flags, lease, deviceId)) {
        return failure('unauthorized');
      }
      if (typeof prompt !== 'string' || prompt.length === 0) return failure('invalid_request', 'prompt is required');
      if (Buffer.byteLength(prompt, 'utf8') > limits.PROMPT_MAX_BYTES) {
        return failure('payload_too_large', 'prompt exceeds the byte limit');
      }
      if (!sendLimiter.take(String(deviceId))) return failure('rate_limited', 'send rate limit exceeded', true);

      const overrides = authorization.session.tool_category_overrides || {};
      const toolPreferences = normalizeManagedToolPreferences({
        file_tools: overrides.files,
        web_search: overrides.web,
        Bash: overrides.terminal,
        python_execute: overrides.python,
      });
      const trustedPayload = policy.stripForbiddenBackendOptions({
        sessionId: authorization.sessionId,
        prompt,
        visiblePrompt: prompt,
        traceId: `remote:${requestId}`,
        planMode: authorization.session.plan_mode === true,
        preferredModel: authorization.session.preferred_model || '',
        reasoningEffort: authorization.session.reasoning_effort,
        contextPreferences: authorization.session.context_preferences,
      });
      const backendPayload = {
        ...trustedPayload,
        ...(toolPreferences ? { toolPreferences } : {}),
        approvalMode: authorization.session.run_mode === 'auto' ? 'auto_run' : 'prompt',
      };
      const validated = validateChatStartPayload(backendPayload);
      if (!validated?.ok) return failure('invalid_request', validated?.error?.reason || validated?.reason);
      const cancellation = cancellations?.create?.({ sessionId, deviceId });
      try {
        const started = await backendService.startChatStream(validated.value || backendPayload, { cancellation });
        const streamId = String(started?.streamId || started?.stream_id || started || '').trim();
        const startedSessionId = String(started?.sessionId || started?.session_id || authorization.sessionId);
        if (!streamId) {
          cancellation?.cancel?.('start_failed');
          return failure('not_reachable', 'chat start returned no stream id', true);
        }
        cancellation?.bindStream?.(streamId);
        if (input.isEpochLive?.() === false) {
          cancellation?.cancel?.('remote_disabled');
          return failure('epoch_invalid');
        }
        return { ok: true, data: { session_id: startedSessionId, stream_id: streamId } };
      } catch (error) {
        cancellation?.cancel?.('start_failed');
        const busy = error?.code === 'session_busy' || error?.category === 'session_busy'
          || /turn is already running/i.test(String(error?.message || ''));
        return busy
          ? failure('session_busy', 'session is busy', true)
          : failure('not_reachable', error?.message || error, true);
      }
    });
  }

  async function stop(input = {}) {
    const { deviceId, sessionId, lease } = input;
    const normalized = String(sessionId || '').trim();
    if (!normalized || lease?.session_id !== normalized || lease?.device_id !== deviceId) {
      return failure('unauthorized');
    }
    try {
      const active = await backendService.getActiveTurnState(normalized);
      const currentLease = leases?.leaseFor?.(normalized, deviceId);
      if (!inputAuthorized(input)
        || !currentLease || currentLease.lease_id !== lease.lease_id) {
        return failure('unauthorized');
      }
      const streamId = String(active?.stream_id || '').trim();
      if (!streamId) return failure('not_reachable', 'no active stream for this session');
      await backendService.cancelChatStream(streamId, CANCEL_REASON_USER);
      return { ok: true, data: { session_id: normalized, stream_id: streamId, reason: 'remote_stop' } };
    } catch (error) {
      return failure('not_reachable', error?.message || error, true);
    }
  }

  async function transcriptPage({ sessionId, before, limit, hasGrant } = {}) {
    const authorization = authorizeSharedSession(sessionId, hasGrant);
    if (authorization.error) return authorization.error;
    let response;
    try {
      response = await backendService.getSessionMessages(authorization.sessionId);
    } catch (error) {
      return failure('not_reachable', error?.message || error, true);
    }
    const messages = Array.isArray(resultData(response)) ? resultData(response) : [];
    const page = (deps.projector || defaultProjector).projectPage(
      messages,
      { before, limit, limits }
    );
    return { ok: true, data: page };
  }

  return Object.freeze({ listSessions, createSession, send, stop, transcriptPage });
}

module.exports = { createRemoteChatAdapter };
