'use strict';

const { redactSensitiveLikeText } = require('../backend/tool-loop-input-sanitization');

const MAX_SUMMARY_CHARS = 200;
// Coalesced delta text is flushed early once it reaches this many bytes.
const DELTA_FLUSH_BYTES = 16_384;

function text(value, limit = MAX_SUMMARY_CHARS) {
  return Array.from(redactSensitiveLikeText(String(value || '')).trim()).slice(0, limit).join('');
}

function identifier(value, limit = 256) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  return normalized.length <= limit ? normalized : '';
}

function createRemoteEventProjector(deps = {}) {
  const {
    backendService,
    isSessionShared,
    limits = {},
    emit,
    contracts,
    decisions,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = deps;
  if (!backendService?.on || typeof emit !== 'function' || typeof isSessionShared !== 'function') {
    throw new TypeError('Remote event projection requires a backend event source, share gate, and emitter.');
  }
  if (typeof contracts?.buildEvent !== 'function') {
    throw new TypeError('Remote event projection requires the remote contracts.');
  }

  let eventSeq = 0;
  let disposed = false;
  const pendingDeltas = new Map();
  const deferredTimers = new Set();

  function shared(sessionId) {
    try {
      return isSessionShared(sessionId) === true;
    } catch (_error) {
      return false;
    }
  }

  function emitProjected(type, source, payload) {
    const sessionId = identifier(source.sessionId, 128);
    if (disposed || !sessionId || !shared(sessionId)) return;
    const streamId = identifier(source.streamId);
    const turnId = identifier(source.turnId || source.turn_id, 128);
    try {
      emit(contracts.buildEvent({
        eventSeq: ++eventSeq,
        type,
        sessionId,
        ...(streamId ? { streamId } : {}),
        ...(turnId ? { turnId } : {}),
        payload,
      }));
    } catch (_error) {
      // Projection failures must not break the backend's canonical event emitter.
    }
  }

  function flushDelta(streamId) {
    const pending = pendingDeltas.get(streamId);
    if (!pending) return;
    pendingDeltas.delete(streamId);
    if (pending.timer != null) clearTimer(pending.timer);
    if (pending.text) emitProjected('delta', pending.source, { text: pending.text });
  }

  function queueDelta(source) {
    const streamId = identifier(source.streamId);
    if (!streamId || !source.content) return;
    const existing = pendingDeltas.get(streamId);
    if (existing) {
      existing.text += String(source.content);
      existing.bytes += Buffer.byteLength(String(source.content), 'utf8');
      if (existing.bytes >= DELTA_FLUSH_BYTES) flushDelta(streamId);
      return;
    }
    const text = String(source.content);
    const pending = { source, text, bytes: Buffer.byteLength(text, 'utf8'), timer: null };
    pending.timer = setTimer(() => flushDelta(streamId), limits.DELTA_COALESCE_MS);
    pendingDeltas.set(streamId, pending);
  }

  function approvalProjection(source) {
    let pending;
    try {
      pending = decisions?.pendingFor?.(source.sessionId) || {};
    } catch (_error) {
      return null;
    }
    const entries = source.toolName === 'exit_plan_mode' ? pending.plan : pending.tool;
    return (Array.isArray(entries) ? entries : []).find((entry) => (
      entry.approval_id === source.approvalId && entry.stream_id === source.streamId
    )) || null;
  }

  function questionProjection(source) {
    let pending;
    try {
      pending = decisions?.pendingFor?.(source.sessionId) || {};
    } catch (_error) {
      return null;
    }
    return (Array.isArray(pending.questions) ? pending.questions : []).find((entry) => (
      entry.question_ref === source.questionRef
    )) || null;
  }

  function deferOnce(callback) {
    let timer;
    timer = setTimer(() => {
      deferredTimers.delete(timer);
      callback();
    }, 0);
    deferredTimers.add(timer);
  }

  function emitApproval(source, allowRetry = true) {
    const pending = approvalProjection(source);
    if (!pending) {
      if (allowRetry) deferOnce(() => emitApproval(source, false));
      return;
    }
    const payload = {
      approval_id: pending.approval_id,
      call_id: pending.call_id,
      tool_name: pending.tool_name,
      classification: pending.classification,
      decision_revision: pending.decision_revision,
    };
    if (pending.tool_name === 'exit_plan_mode') {
      emitProjected('plan_proposed', source, {
        ...payload,
        plan: pending.facts?.plan
          || { title: '', summary: '', steps: [], notes: '', verification: '' },
      });
    } else {
      emitProjected('tool_approval_needed', source, { ...payload, facts: pending.facts || {} });
    }
  }

  function emitQuestions(source, allowRetry = true) {
    const pending = questionProjection(source);
    if (!pending) {
      if (allowRetry) deferOnce(() => emitQuestions(source, false));
      return;
    }
    emitProjected('user_questions_requested', source, {
      question_ref: pending.question_ref,
      batch_id: pending.batch_id,
      call_id: pending.call_id,
      questions: pending.questions,
    });
  }

  function emitResetIfReplacing(source) {
    // Electron's authoritative reset discriminator is `discard_scope`:
    // `all` and `live_slice` replace visible text; `none` preserves it.
    if (!['all', 'live_slice'].includes(source.discard_scope)) return;
    emitProjected('reset', source, {
      reason: text(source.reason),
      discard_scope: source.discard_scope,
    });
  }

  function projectNonDelta(source) {
    switch (source.type) {
      case 'started':
        emitProjected('started', source, {});
        break;
      case 'tool_use':
        emitProjected('tool_use', source, {
          call_id: identifier(source.callId),
          tool_name: identifier(source.toolName, 128),
          status: text(source.status, 64),
        });
        break;
      case 'tool_result':
        emitProjected('tool_result', source, {
          call_id: identifier(source.callId),
          tool_name: identifier(source.toolName, 128),
          status: text(source.status || (source.isError ? 'error' : 'completed'), 64),
          summary: text(source.summary),
        });
        break;
      case 'tool_approval_needed':
        emitApproval(source);
        break;
      case 'user_questions_requested':
        emitQuestions(source);
        break;
      case 'stream_reset':
        emitResetIfReplacing(source);
        break;
      case 'complete':
        emitProjected('complete', source, {
          status: text(source.status || source.terminalStatus || 'completed', 64),
          assistant_message_id: identifier(
            source.assistantMessageId || source.assistant_message_id
              || source.messageId || source.message_id
          ),
          ...(typeof source.content === 'string' ? { content: source.content } : {}),
          replaces_stream_text: typeof source.content === 'string',
        });
        break;
      case 'question_batch':
        emitProjected('complete', source, {
          status: 'continue_on_desktop', reason: 'question_batch',
          assistant_message_id: '', replaces_stream_text: false,
        });
        break;
      case 'error': {
        const candidate = String(
          source.errorCode || source.code || source.category || source.reason || ''
        ).trim();
        const publicCode = /^(?:[a-z][a-z0-9_]{0,63}|CMP-[A-Z]+-\d{4})$/;
        const reason = publicCode.test(candidate) ? candidate : 'not_reachable';
        const detail = text(source.message || source.reason || 'chat error');
        emitProjected('error', source, {
          reason,
          ...(detail && detail !== reason ? { detail } : {}),
        });
        break;
      }
      default:
        break;
    }
  }

  function onChatStream(source) {
    if (disposed || !source || typeof source !== 'object') return;
    const streamId = identifier(source.streamId);
    if (!shared(source.sessionId)) {
      if (streamId) flushDelta(streamId);
      return;
    }
    if (source.type === 'delta') {
      if (source.content) queueDelta(source);
      return;
    }
    if (streamId) flushDelta(streamId);
    projectNonDelta(source);
  }

  backendService.on('chat-stream', onChatStream);

  function dispose() {
    if (disposed) return;
    disposed = true;
    backendService.off?.('chat-stream', onChatStream)
      || backendService.removeListener?.('chat-stream', onChatStream);
    for (const pending of pendingDeltas.values()) clearTimer(pending.timer);
    pendingDeltas.clear();
    for (const timer of deferredTimers) clearTimer(timer);
    deferredTimers.clear();
  }

  // Reconnect lifecycle snapshot: the portal receives this exact live,
  // sanitized `{ tool, questions, plan }` shape before subsequent events.
  function pendingFor(sessionId) {
    try {
      return decisions?.pendingFor?.(sessionId) || { tool: [], questions: [], plan: [] };
    } catch (_error) {
      return { tool: [], questions: [], plan: [] };
    }
  }

  // `complete` without content is still terminal; the portal must reconcile
  // its authoritative assistant row from transcript.page in that case.
  return Object.freeze({ dispose, pendingFor });
}

module.exports = { createRemoteEventProjector };
