const {
  createStreamEnvelopeParityTracker,
} = require('./stream-envelope-parity');
const {
  createStreamEnvelopeReceiptGate,
} = require('./stream-envelope-receipt-gate');
const {
  createStreamEnvelopeRecoveryTicketStore,
} = require('./stream-envelope-recovery-tickets');
const {
  STREAM_ENVELOPE_CHANNELS,
  STREAM_ENVELOPE_SCHEMA_VERSION,
  buildEnvelopeDeltaKey,
  buildEnvelopeSources,
  isTerminalChatStreamType,
  mergeStreamEnvelopeDeltas,
  normalizeEnvelopePhase,
  phaseMatchesEnvelopeChannel,
} = require('./stream-envelope-shape');
const {
  normalizeEventPayload,
  normalizeToken,
  invokeSafely,
  createStreamStats,
  recordRendererForwardFailure,
  updateStreamStats,
  buildTerminalSummary,
  buildUsageMetadata,
  mergeDeltaPayloads,
  isTruthyOption,
  normalizeNumber,
  resolveTurnId,
  resolveEnvelopeIdentity,
} = require('./chat-stream-bridge-support');

const MAX_STREAM_STATS_ENTRIES = 64;
const MAX_STREAM_ENVELOPE_STATE_ENTRIES = MAX_STREAM_STATS_ENTRIES;
const STREAM_ENVELOPE_SEQUENCE_REGRESSION_EVENT = 'chat.stream_envelope_sequence_regression';

// Coalesce same-stream deltas to keep reasoning-heavy models from saturating
// Chromium IPC. content/entriesDelta are incremental; aggregate is cumulative.
// One merged event per frame preserves renderer semantics without main-process
// stalls while the sidecar continues streaming.
const DELTA_COALESCE_WINDOW_MS = 50;

function createChatStreamBridge({
  sendBridgeEvent = () => {},
  log = () => {},
  usageHistory = null,
  now = () => Date.now(),
  setCoalesceTimer = (fn, ms) => setTimeout(fn, ms),
  clearCoalesceTimer = (handle) => clearTimeout(handle),
  isStreamEnvelopeV2Enabled = () => false,
  enableStreamEnvelopeParityDiagnostics = () => false,
  setReceiptWatchdog = (fn, ms) => {
    const handle = setTimeout(fn, ms);
    if (handle && typeof handle.unref === 'function') {
      handle.unref();
    }
    return handle;
  },
  clearReceiptWatchdog = (handle) => clearTimeout(handle),
  envelopeReceiptWatchdogMs = 5000,
} = {}) {
  const statsByStream = new Map();
  const pendingDeltaByStream = new Map(); // streamId -> { payload }
  const pendingEnvelopeDeltaByKey = new Map(); // stream/channel/event/phase -> { streamId, envelope }
  const envelopeStateByStream = new Map();
  const parityByStream = new Map();
  const envelopesSentByStream = new Map(); // streamId -> count
  const receiptWatchdogByStream = new Map(); // streamId -> { handle, sentAtMs, sentCount }
  const envelopeReceiptGate = createStreamEnvelopeReceiptGate({
    log,
    maxStreams: MAX_STREAM_ENVELOPE_STATE_ENTRIES,
  });
  const recoveryTickets = createStreamEnvelopeRecoveryTicketStore({
    log,
    now,
    maxTickets: MAX_STREAM_ENVELOPE_STATE_ENTRIES,
    sendRecoveryRequired(payload) {
      const error = invokeSafely(sendBridgeEvent, 'chat.onStreamRecoveryRequired', payload);
      if (error) throw new Error(error);
    },
  });
  let flushTimerHandle = null;
  // Until the first successful terminal ack proves envelope consumption,
  // legacy events flow alongside envelopes; the renderer subscribes to one.
  // A receipt timeout reopens legacy delivery so reloads/regressions degrade
  // to working streaming instead of silently dead chat.

  function deleteEnvelopeReceiptState(streamId) {
    const normalized = normalizeToken(streamId);
    if (!normalized) {
      return;
    }
    envelopesSentByStream.delete(normalized);
    envelopeReceiptGate.deleteStream(normalized);
    cancelReceiptWatchdog(normalized);
  }

  function deleteEnvelopeState(streamId, options = {}) {
    const normalized = normalizeToken(streamId);
    if (!normalized) {
      return;
    }
    envelopeStateByStream.delete(normalized);
    parityByStream.delete(normalized);
    if (options.preserveReceipt !== true) {
      deleteEnvelopeReceiptState(normalized);
    }
    dropPendingEnvelopeDeltasForStream(normalized);
  }

  function trimStreamMap(map, maxEntries, protectedStreamId = '', onDelete = null) {
    const protectedKey = normalizeToken(protectedStreamId);
    for (const streamId of map.keys()) {
      if (map.size <= maxEntries) {
        break;
      }
      if (streamId === protectedKey) {
        continue;
      }
      if (typeof onDelete === 'function') {
        onDelete(streamId);
      } else {
        map.delete(streamId);
      }
    }
  }

  function capEnvelopeStateMaps(latestStreamId = '') {
    const latest = normalizeToken(latestStreamId);
    trimStreamMap(envelopeStateByStream, MAX_STREAM_ENVELOPE_STATE_ENTRIES, latest, deleteEnvelopeState);
    trimStreamMap(parityByStream, MAX_STREAM_ENVELOPE_STATE_ENTRIES, latest);
  }

  function hasPendingCoalescedWork() {
    return pendingDeltaByStream.size > 0 || pendingEnvelopeDeltaByKey.size > 0;
  }

  function clearCoalesceTimerIfIdle() {
    if (!hasPendingCoalescedWork() && flushTimerHandle) {
      clearCoalesceTimer(flushTimerHandle);
      flushTimerHandle = null;
    }
  }

  function flushAllPendingDeltas() {
    const entries = [...pendingDeltaByStream.values()];
    pendingDeltaByStream.clear();
    for (const entry of entries) {
      const flushError = invokeSafely(sendBridgeEvent, 'chat.onStream', entry.payload);
      if (flushError) {
        recordRendererForwardFailure(
          statsByStream.get(normalizeToken(entry.payload?.streamId)),
          flushError
        );
      }
    }
    clearCoalesceTimerIfIdle();
  }

  function flushAllPendingEnvelopeDeltas() {
    const entries = [...pendingEnvelopeDeltaByKey.values()];
    pendingEnvelopeDeltaByKey.clear();
    for (const entry of entries) {
      sendEnvelope(entry.envelope, statsByStream.get(entry.streamId));
    }
  }

  function flushAllPendingCoalesced() {
    flushTimerHandle = null;
    if (!hasPendingCoalescedWork()) {
      return;
    }
    flushAllPendingDeltas();
    flushAllPendingEnvelopeDeltas();
  }

  function flushPendingDeltaForStream(streamId) {
    if (!streamId) return '';
    const entry = pendingDeltaByStream.get(streamId);
    if (!entry) return '';
    pendingDeltaByStream.delete(streamId);
    clearCoalesceTimerIfIdle();
    const flushError = invokeSafely(sendBridgeEvent, 'chat.onStream', entry.payload);
    if (flushError) {
      recordRendererForwardFailure(statsByStream.get(streamId), flushError);
    }
    return flushError;
  }

  function flushPendingEnvelopeDeltasForStream(streamId) {
    const normalized = normalizeToken(streamId);
    if (!normalized) {
      return '';
    }
    let firstError = '';
    for (const [key, entry] of [...pendingEnvelopeDeltaByKey.entries()]) {
      if (entry.streamId !== normalized) {
        continue;
      }
      pendingEnvelopeDeltaByKey.delete(key);
      firstError = sendEnvelope(entry.envelope, statsByStream.get(normalized)) || firstError;
    }
    clearCoalesceTimerIfIdle();
    return firstError;
  }

  function dropPendingEnvelopeDeltasForStream(streamId) {
    const normalized = normalizeToken(streamId);
    if (!normalized) {
      return;
    }
    for (const [key, entry] of [...pendingEnvelopeDeltaByKey.entries()]) {
      if (entry.streamId === normalized) {
        pendingEnvelopeDeltaByKey.delete(key);
      }
    }
    clearCoalesceTimerIfIdle();
  }

  function scheduleDeltaFlush() {
    if (flushTimerHandle) return;
    flushTimerHandle = setCoalesceTimer(flushAllPendingCoalesced, DELTA_COALESCE_WINDOW_MS);
  }

  function queueDeltaForCoalesce(payload, streamId) {
    if (!streamId) {
      // Can't coalesce without a stream key; send through immediately.
      return invokeSafely(sendBridgeEvent, 'chat.onStream', payload);
    }
    const existing = pendingDeltaByStream.get(streamId);
    const merged = existing ? mergeDeltaPayloads(existing.payload, payload) : payload;
    pendingDeltaByStream.set(streamId, { payload: merged });
    scheduleDeltaFlush();
    return '';
  }

  function queueEnvelopeDeltaForCoalesce(envelope) {
    const streamId = normalizeToken(envelope?.streamId);
    if (!streamId) {
      return sendEnvelope(envelope, null);
    }
    const key = buildEnvelopeDeltaKey(envelope);
    const existing = pendingEnvelopeDeltaByKey.get(key);
    const mergedEnvelope = existing
      ? mergeStreamEnvelopeDeltas(existing.envelope, envelope)
      : envelope;
    pendingEnvelopeDeltaByKey.set(key, {
      streamId,
      envelope: mergedEnvelope,
    });
    scheduleDeltaFlush();
    return '';
  }

  function getEnvelopeState(streamId) {
    const key = normalizeToken(streamId);
    if (!key) {
      return {
        started: false,
        nextSequence: 1,
        lastExplicitSequence: null,
        channelSequences: new Map(),
      };
    }
    let state = envelopeStateByStream.get(key);
    if (!state) {
      state = {
        started: false,
        nextSequence: 1,
        lastExplicitSequence: null,
        channelSequences: new Map(),
      };
      envelopeStateByStream.set(key, state);
      capEnvelopeStateMaps(key);
    }
    return state;
  }

  function getParityTracker(streamId) {
    if (!isTruthyOption(enableStreamEnvelopeParityDiagnostics)) {
      return null;
    }
    const key = normalizeToken(streamId);
    if (!key) {
      return null;
    }
    let tracker = parityByStream.get(key);
    if (!tracker) {
      tracker = createStreamEnvelopeParityTracker({ log });
      parityByStream.set(key, tracker);
      capEnvelopeStateMaps(key);
    }
    return tracker;
  }

  function shouldEmitLegacyStreamEvents() {
    return !isTruthyOption(isStreamEnvelopeV2Enabled)
      || isTruthyOption(enableStreamEnvelopeParityDiagnostics)
      || !envelopeReceiptGate.isProven();
  }

  function nextEnvelopeSequence(state, payload) {
    const explicit = normalizeNumber(payload.sequence);
    const expected = Number(state.nextSequence || 1);
    if (explicit != null && explicit >= expected) {
      state.nextSequence = explicit + 1;
      state.lastExplicitSequence = explicit;
      return explicit;
    }
    if (explicit != null && explicit < expected) {
      const lastExplicit = normalizeNumber(state.lastExplicitSequence);
      if (lastExplicit == null || explicit <= lastExplicit) {
        invokeSafely(log, 'WARN', STREAM_ENVELOPE_SEQUENCE_REGRESSION_EVENT, {
          streamId: normalizeToken(payload.streamId),
          stream_id: normalizeToken(payload.streamId),
          explicitSequence: explicit,
          explicit_sequence: explicit,
          expectedSequence: expected,
          expected_sequence: expected,
        });
      }
      state.lastExplicitSequence = lastExplicit == null ? explicit : Math.max(lastExplicit, explicit);
    }
    state.nextSequence = expected + 1;
    return expected;
  }

  function nextEnvelopeChannelSequence(state, channel, payload) {
    const explicit = normalizeNumber(payload.channelSequence ?? payload.channel_sequence);
    const expected = Number(state.channelSequences.get(channel) || 1);
    if (explicit != null && explicit >= expected) {
      state.channelSequences.set(channel, explicit + 1);
      return explicit;
    }
    state.channelSequences.set(channel, expected + 1);
    return expected;
  }

  function buildStartedEnvelope(payload, timestampMs, state) {
    state.started = true;
    const streamId = normalizeToken(payload.streamId);
    return {
      schemaVersion: STREAM_ENVELOPE_SCHEMA_VERSION,
      streamId,
      turnId: resolveTurnId(payload),
      sessionId: normalizeToken(payload.sessionId),
      ...resolveEnvelopeIdentity(payload, streamId),
      channel: 'control',
      eventKind: 'started',
      phase: null,
      payload: {
        type: 'started',
      },
      emittedAtMs: normalizeNumber(payload.emittedAtMs || payload.emitted_at_ms) ?? timestampMs,
      // bridgedAtMs is stamped once at dispatch in sendEnvelope.
    };
  }

  function buildEnvelope(payload, timestampMs, state, source) {
    const streamId = normalizeToken(payload.streamId);
    const channel = STREAM_ENVELOPE_CHANNELS.has(source.channel) ? source.channel : 'control';
    const sequence = nextEnvelopeSequence(state, payload);
    const channelSequence = nextEnvelopeChannelSequence(state, channel, payload);
    const rawSequenceEnd = normalizeNumber(payload.sequenceEnd ?? payload.sequence_end);
    const rawChannelSequenceEnd = normalizeNumber(payload.channelSequenceEnd ?? payload.channel_sequence_end);
    const sequenceEnd = rawSequenceEnd != null && rawSequenceEnd >= sequence ? rawSequenceEnd : sequence;
    const channelSequenceEnd = rawChannelSequenceEnd != null && rawChannelSequenceEnd >= channelSequence
      ? rawChannelSequenceEnd
      : channelSequence;
    const phase = normalizeEnvelopePhase(payload);
    return {
      streamId,
      turnId: resolveTurnId(payload),
      sessionId: normalizeToken(payload.sessionId),
      ...resolveEnvelopeIdentity(payload, streamId),
      sequence,
      ...(sequenceEnd != null ? { sequenceEnd } : {}),
      channel,
      channelSequence,
      ...(channelSequenceEnd != null ? { channelSequenceEnd } : {}),
      eventKind: source.eventKind,
      phase: phaseMatchesEnvelopeChannel(phase, channel) ? phase : null,
      payload: source.payload,
      emittedAtMs: normalizeNumber(payload.emittedAtMs || payload.emitted_at_ms) ?? timestampMs,
      // bridgedAtMs is stamped once at dispatch in sendEnvelope.
    };
  }

  function sendEnvelope(envelope, stats) {
    const dispatchEnvelope = {
      ...envelope,
      bridgedAtMs: now(),
    };
    const error = invokeSafely(sendBridgeEvent, 'chat.onStreamEnvelope', dispatchEnvelope);
    if (error) {
      recordRendererForwardFailure(stats, error);
      const streamId = normalizeToken(dispatchEnvelope.streamId);
      if (streamId) {
        envelopeReceiptGate.revoke('renderer_envelope_forward_failed', { streamId: streamId.slice(0, 30) });
        envelopeReceiptGate.deleteStream(streamId);
        cancelReceiptWatchdog(streamId);
        envelopesSentByStream.delete(streamId);
      }
      return error;
    }
    const streamId = normalizeToken(dispatchEnvelope.streamId);
    if (streamId) {
      envelopeReceiptGate.noteSent(dispatchEnvelope);
      envelopesSentByStream.set(streamId, (envelopesSentByStream.get(streamId) || 0) + 1);
      if (normalizeToken(dispatchEnvelope.eventKind) === 'terminal') {
        armReceiptWatchdog(streamId, dispatchEnvelope);
      }
    }
    const tracker = getParityTracker(dispatchEnvelope.streamId);
    tracker?.noteEnvelope(dispatchEnvelope);
    return '';
  }

  function armReceiptWatchdog(streamId, terminalEnvelope = {}) {
    const normalized = normalizeToken(streamId);
    if (!normalized) {
      return;
    }
    const existing = receiptWatchdogByStream.get(normalized);
    if (existing && existing.handle) {
      try { clearReceiptWatchdog(existing.handle); } catch (_e) { /* best-effort */ }
    }
    const sentAtMs = now();
    const sentCount = envelopesSentByStream.get(normalized) || 0;
    const handle = setReceiptWatchdog(() => {
      const record = receiptWatchdogByStream.get(normalized);
      if (!record) {
        return;
      }
      receiptWatchdogByStream.delete(normalized);
      envelopesSentByStream.delete(normalized);
      // The renderer stopped consuming the envelope channel — re-open legacy
      // emission so subsequent turns degrade to working legacy streaming.
      const legacyReopened = envelopeReceiptGate.isProven();
      envelopeReceiptGate.revoke('renderer_terminal_ack_timeout', {
        streamId: normalized.slice(0, 30),
      });
      envelopeReceiptGate.deleteStream(normalized);
      recoveryTickets.issue({
        streamId: normalized,
        sessionId: record.sessionId,
        turnId: record.turnId,
        terminalType: record.terminalType,
        reason: 'renderer_terminal_ack_timeout',
      });
      invokeSafely(
        log,
        'WARN',
        'chat.stream_envelope_v2_no_ack',
        {
          streamId: normalized,
          stream_id: normalized,
          sentCount: record.sentCount,
          elapsedMs: Math.max(now() - record.sentAtMs, 0),
          reason: 'renderer_terminal_ack_timeout',
          legacyReopened,
        }
      );
    }, envelopeReceiptWatchdogMs);
    receiptWatchdogByStream.set(normalized, {
      handle,
      sentAtMs,
      sentCount,
      sessionId: normalizeToken(terminalEnvelope.sessionId),
      turnId: normalizeToken(terminalEnvelope.turnId || terminalEnvelope.turn_id),
      terminalType: normalizeToken(terminalEnvelope.payload?.type) || 'terminal',
    });
    trimStreamMap(
      envelopesSentByStream,
      MAX_STREAM_ENVELOPE_STATE_ENTRIES,
      normalized,
      deleteEnvelopeReceiptState
    );
    trimStreamMap(
      receiptWatchdogByStream,
      MAX_STREAM_ENVELOPE_STATE_ENTRIES,
      normalized,
      deleteEnvelopeReceiptState
    );
  }

  function cancelReceiptWatchdog(streamId) {
    const normalized = normalizeToken(streamId);
    if (!normalized) {
      return;
    }
    const existing = receiptWatchdogByStream.get(normalized);
    if (existing && existing.handle) {
      try { clearReceiptWatchdog(existing.handle); } catch (_e) { /* best-effort */ }
    }
    receiptWatchdogByStream.delete(normalized);
  }

  function preservePendingTerminalRecovery(streamId, reason) {
    const normalized = normalizeToken(streamId);
    const record = receiptWatchdogByStream.get(normalized);
    if (!record) return null;
    return recoveryTickets.issue({
      streamId: normalized, sessionId: record.sessionId, turnId: record.turnId,
      terminalType: record.terminalType, reason,
    });
  }

  function recordEnvelopeAck(record = {}) {
    const recordType = normalizeToken(record.recordType || record.record_type);
    if (recordType === 'recovery_applied') {
      return recoveryTickets.acknowledge(record);
    }
    if (recordType === 'subscription_started') {
      const result = envelopeReceiptGate.record(record);
      if (result?.ok !== true) {
        return result;
      }
      recoveryTickets.replay(result.renderer_epoch);
      for (const pendingStreamId of Array.from(receiptWatchdogByStream.keys())) {
        preservePendingTerminalRecovery(pendingStreamId, 'renderer_subscription_replaced_before_terminal_ack');
        cancelReceiptWatchdog(pendingStreamId);
      }
      envelopesSentByStream.clear();
      return result;
    }
    const streamId = normalizeToken(record.streamId || record.stream_id);
    if (!streamId) {
      return envelopeReceiptGate.record(record);
    }
    if (recordType === 'stream_fault') {
      const result = envelopeReceiptGate.record(record);
      let ticket = null;
      if (result?.record_accepted === true) {
        cancelReceiptWatchdog(streamId);
        envelopesSentByStream.delete(streamId);
        ticket = recoveryTickets.issue({ streamId,
          sessionId: record.sessionId || record.session_id, turnId: record.turnId || record.turn_id,
          terminalType: record.terminalType || record.terminal_type,
          reason: record.reason || 'renderer_stream_fault' });
      }
      return {
        ...result,
        recovery_ticket_issued: Boolean(ticket),
        ...(ticket ? { recovery_id: ticket.recovery_id } : {}),
      };
    }
    function issueRejectedReceiptRecovery(result) {
      const ticket = recoveryTickets.issue({
        streamId, sessionId: record.sessionId || record.session_id,
        turnId: record.turnId || record.turn_id,
        terminalType: record.terminalType || record.terminal_type,
        reason: result?.reason || 'terminal_receipt_rejected',
      });
      return {
        ...result,
        recovery_ticket_issued: Boolean(ticket),
        ...(ticket ? { recovery_id: ticket.recovery_id } : {}),
      };
    }
    const hasReceiptState = envelopesSentByStream.has(streamId) || receiptWatchdogByStream.has(streamId);
    if (!hasReceiptState) {
      return issueRejectedReceiptRecovery(envelopeReceiptGate.revoke('missing_receipt_state', {
        streamId: streamId.slice(0, 30),
      }));
    }
    const result = envelopeReceiptGate.record(record);
    if (result?.ok === true) {
      cancelReceiptWatchdog(streamId);
      envelopesSentByStream.delete(streamId);
      return result;
    }
    return issueRejectedReceiptRecovery(result);
  }

  function emitStreamEnvelopes(payload, type, timestampMs, stats) {
    if (!isTruthyOption(isStreamEnvelopeV2Enabled)) {
      return '';
    }
    const streamId = normalizeToken(payload.streamId);
    if (!streamId) {
      return '';
    }
    const state = getEnvelopeState(streamId);
    let firstError = '';
    if (!state.started || type === 'started') {
      const startedEnvelope = buildStartedEnvelope(payload, timestampMs, state);
      firstError = sendEnvelope(startedEnvelope, stats) || firstError;
      if (type === 'started') {
        getParityTracker(streamId)?.noteLegacy(payload);
        return firstError;
      }
    }
    if (type !== 'delta') {
      firstError = flushPendingEnvelopeDeltasForStream(streamId) || firstError;
    }
    const sources = buildEnvelopeSources(payload, type);
    // Extra channels get fresh sequences and carry content on source.payload;
    // drop unused large fields while preserving metadata and phase fields.
    // Build the shared no-sequence metadata once.
    let noSequenceMeta = null;
    for (let index = 0; index < sources.length; index += 1) {
      let sourcePayload;
      if (index === 0) {
        sourcePayload = payload;
      } else {
        if (!noSequenceMeta) {
          noSequenceMeta = { ...payload };
          delete noSequenceMeta.content;
          delete noSequenceMeta.aggregate;
          delete noSequenceMeta.reasoning;
          noSequenceMeta.sequence = undefined;
          noSequenceMeta.sequenceEnd = undefined;
          noSequenceMeta.sequence_end = undefined;
          noSequenceMeta.channelSequence = undefined;
          noSequenceMeta.channel_sequence = undefined;
          noSequenceMeta.channelSequenceEnd = undefined;
          noSequenceMeta.channel_sequence_end = undefined;
        }
        sourcePayload = noSequenceMeta;
      }
      const envelope = buildEnvelope(sourcePayload, timestampMs, state, sources[index]);
      if (envelope.eventKind === 'delta') {
        firstError = queueEnvelopeDeltaForCoalesce(envelope) || firstError;
      } else {
        firstError = sendEnvelope(envelope, stats) || firstError;
      }
    }
    getParityTracker(streamId)?.noteLegacy(payload);
    if (isTerminalChatStreamType(type) && streamId) {
      deleteEnvelopeState(streamId, { preserveReceipt: true });
    }
    return firstError;
  }

  function getStreamStats(payload, timestampMs) {
    const streamId = normalizeToken(payload?.streamId);
    if (!streamId) {
      return null;
    }
    let stats = statsByStream.get(streamId);
    if (!stats) {
      stats = createStreamStats(payload, timestampMs);
      statsByStream.set(streamId, stats);
      trimStreamMap(statsByStream, MAX_STREAM_STATS_ENTRIES, streamId, (oldestStreamId) => {
        statsByStream.delete(oldestStreamId);
        deleteEnvelopeState(oldestStreamId);
      });
    }
    return stats;
  }

  function resetStream(streamId) {
    const normalized = normalizeToken(streamId);
    statsByStream.delete(normalized);
    deleteEnvelopeState(normalized);
    // Drop any pending coalesced delta for the stream — caller is signalling
    // the stream is no longer active and any buffered chunk would be stale.
    if (normalized && pendingDeltaByStream.has(normalized)) {
      pendingDeltaByStream.delete(normalized);
      clearCoalesceTimerIfIdle();
    }
  }

  function handleEvent(event) {
    const payload = normalizeEventPayload(event);
    const type = normalizeToken(payload.type);
    const timestampMs = now();
    const isTerminal = isTerminalChatStreamType(type);
    const streamId = normalizeToken(payload.streamId);

    const stats = getStreamStats(payload, timestampMs);
    const envelopeForwardError = emitStreamEnvelopes(payload, type, timestampMs, stats);
    const emitLegacy = shouldEmitLegacyStreamEvents();
    // Coalesce deltas; flush them before other events to preserve ordering.
    // Incremental content/entriesDelta merge while cumulative aggregate wins.
    let legacyForwardError = '';
    if (emitLegacy) {
      if (type === 'delta') {
        legacyForwardError = queueDeltaForCoalesce(payload, streamId);
      } else {
        if (streamId) {
          flushPendingDeltaForStream(streamId);
        } else if (pendingDeltaByStream.size > 0) {
          // Unkeyed event under load — flush everything to keep ordering safe.
          flushAllPendingDeltas();
        }
        legacyForwardError = invokeSafely(sendBridgeEvent, 'chat.onStream', payload);
      }
    } else if (type !== 'delta' && streamId) {
      pendingDeltaByStream.delete(streamId);
      clearCoalesceTimerIfIdle();
    }
    if (legacyForwardError) {
      recordRendererForwardFailure(stats, legacyForwardError);
    }
    if (isTerminal && envelopeForwardError && legacyForwardError) {
      recoveryTickets.issue({ streamId, sessionId: payload.sessionId,
        turnId: resolveTurnId(payload), terminalType: type,
        reason: 'renderer_terminal_forward_failed' });
    }
    const rendererForwardError = legacyForwardError || (!emitLegacy ? envelopeForwardError : '');
    const shouldLogFirstForward = stats && !stats.firstNotificationLogged && !rendererForwardError;
    updateStreamStats(stats, payload, type);
    if (shouldLogFirstForward) {
      stats.firstNotificationLogged = true;
      invokeSafely(
        log,
        'INFO',
        'chat.first_notification_forwarded',
        {
          type,
          streamId: streamId || '',
          stream_id: streamId || '',
          requestId: stats.requestId || '',
          request_id: stats.requestId || '',
          traceId: stats.traceId || '',
          trace_id: stats.traceId || '',
          sessionId: stats.sessionId || '',
          elapsedMs: Math.max(timestampMs - Number(stats.startedAtMs || timestampMs), 0),
        }
      );
    }

    let usageRecordError = '';
    if (
      isTerminal
      && usageHistory
      && typeof usageHistory.recordTurnUsage === 'function'
    ) {
      const usageMetadata = buildUsageMetadata(payload, type, stats, timestampMs);
      const terminalUsage = payload.usage && typeof payload.usage === 'object'
        && !Array.isArray(payload.usage)
        ? payload.usage
        : {};
      usageRecordError = invokeSafely(
        usageHistory.recordTurnUsage.bind(usageHistory),
        usageMetadata.sessionId,
        terminalUsage,
        usageMetadata
      );
      if (
        usageRecordError
        && typeof usageHistory.reportRecordFailure === 'function'
      ) {
        invokeSafely(
          usageHistory.reportRecordFailure.bind(usageHistory),
          {
            sessionId: usageMetadata.sessionId,
            error: usageRecordError,
          }
        );
      }
    }

    if (!isTerminal) {
      return;
    }

    try {
      const summary = buildTerminalSummary(payload, type, stats, timestampMs);
      if (usageRecordError) {
        summary.usageRecordingFailed = true;
        summary.usageRecordingError = 'record_failed';
      }
      invokeSafely(
        log,
        type === 'error' ? 'ERROR' : 'INFO',
        'chat.stream_summary',
        summary
      );
    } finally {
      if (streamId) {
        statsByStream.delete(streamId);
      }
    }
  }

  return {
    handleEvent,
    resetStream,
    recordEnvelopeAck,
  };
}

module.exports = {
  createChatStreamBridge,
  MAX_STREAM_ENVELOPE_STATE_ENTRIES,
};
