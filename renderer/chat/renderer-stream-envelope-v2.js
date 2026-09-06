/* renderer/chat/renderer-stream-envelope-v2.js -- Stream Envelope V2 adapter helpers (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererStreamEnvelopeV2 = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const STREAM_ENVELOPE_SCHEMA_VERSION = 2;
  const STREAM_ENVELOPE_CHANNELS = new Set(['reasoning', 'response', 'tool', 'phase', 'control']);
  // 'progress' (W2-1): live tool-output batches — pass-through 1:1, never
  // coalesced; the generic branch restores payload.type ('tool_output_chunk').
  const STREAM_ENVELOPE_EVENT_KINDS = new Set(['delta', 'started', 'completed', 'reset', 'terminal', 'progress']);
  const DEFAULT_RENDERER_ENVELOPE_STREAM_CAP = 128;

  function normalizeString(value) {
    return String(value || '').trim();
  }

  function normalizeNumber(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.trunc(numeric) : null;
  }

  function normalizePositiveInteger(value, fallback) {
    const normalized = normalizeNumber(value);
    return normalized != null && normalized > 0 ? normalized : fallback;
  }

  function pruneOldestStreamEntry(map, maxStreams, protectedStreamId, appendClientLog, eventName) {
    const protectedKey = normalizeString(protectedStreamId);
    for (const streamId of map.keys()) {
      if (map.size <= maxStreams) {
        break;
      }
      if (streamId === protectedKey) {
        continue;
      }
      map.delete(streamId);
      appendClientLog('WARN', eventName, {
        streamId: streamId.slice(0, 30),
        maxStreams,
      });
    }
  }

  function cloneEntries(entries) {
    return Array.isArray(entries)
      ? entries.map((entry) => ({ ...(entry && typeof entry === 'object' ? entry : { text: String(entry || '') }) }))
      : [];
  }

  function buildDeltaReasoningEntry(envelope, delta) {
    const text = String(delta || '');
    if (!text) {
      return null;
    }
    const streamId = normalizeString(envelope.streamId);
    const sequence = normalizeNumber(envelope.channelSequence) ?? normalizeNumber(envelope.sequence) ?? 0;
    return {
      id: `reasoning_${streamId || 'stream'}_${sequence}`,
      text,
    };
  }

  function buildReasoningEntries(envelope, payload) {
    const entries = cloneEntries(payload.entriesDelta);
    if (entries.length) {
      return entries;
    }
    const deltaEntry = buildDeltaReasoningEntry(envelope, payload.delta);
    return deltaEntry ? [deltaEntry] : [];
  }

  function normalizePhase(phaseLike) {
    const phase = phaseLike && typeof phaseLike === 'object' && !Array.isArray(phaseLike)
      ? phaseLike
      : {};
    const phaseId = normalizeString(phase.phaseId || phase.phase_id);
    const phaseKind = normalizeString(phase.phaseKind || phase.phase_kind);
    const thinkingId = normalizeString(phase.thinkingId || phase.thinking_id);
    const toolCallId = normalizeString(phase.toolCallId || phase.tool_call_id);
    const toolName = normalizeString(phase.toolName || phase.tool_name);
    const summary = normalizeString(phase.summary);
    const iteration = normalizeNumber(phase.iteration);
    if (!phaseId && !phaseKind && !thinkingId && !toolCallId && !toolName && !summary && iteration == null) {
      return null;
    }
    return {
      ...(phaseId ? { phaseId, phase_id: phaseId } : {}),
      ...(phaseKind ? { phaseKind, phase_kind: phaseKind } : {}),
      ...(iteration != null ? { iteration } : {}),
      ...(thinkingId ? { thinkingId, thinking_id: thinkingId } : {}),
      ...(toolCallId ? { toolCallId, tool_call_id: toolCallId } : {}),
      ...(toolName ? { toolName, tool_name: toolName } : {}),
      ...(summary ? { summary } : {}),
    };
  }

  function deriveEnvelopeDisplayLabel(envelope = {}, normalizedPhase = undefined) {
    const channel = normalizeString(envelope.channel);
    const payload = envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : {};
    const phase = normalizedPhase === undefined ? normalizePhase(envelope.phase) : normalizedPhase;
    const toolName = normalizeString(payload.toolName || payload.tool_name || phase?.toolName || phase?.tool_name);
    const phaseKind = normalizeString(phase?.phaseKind || phase?.phase_kind);
    if (channel === 'tool' || phaseKind === 'tool_use') {
      return toolName ? `Calling ${toolName}...` : 'Calling tool...';
    }
    if (phaseKind === 'tool_result') {
      return 'Reading tool result...';
    }
    if (channel === 'response' || phaseKind === 'text' || phaseKind === 'final_answer') {
      return 'Writing answer...';
    }
    return 'Reasoning...';
  }

  function commonLegacyFields(envelope = {}) {
    const phase = normalizePhase(envelope.phase);
    return {
      streamId: normalizeString(envelope.streamId),
      sessionId: normalizeString(envelope.sessionId),
      requestId: normalizeString(envelope.requestId || envelope.request_id || envelope.streamId),
      traceId: normalizeString(envelope.traceId || envelope.trace_id || envelope.streamId),
      turnId: normalizeString(envelope.turnId || envelope.turn_id || envelope.streamId),
      sequence: normalizeNumber(envelope.sequence),
      sequenceEnd: normalizeNumber(envelope.sequenceEnd),
      channel: normalizeString(envelope.channel),
      channelSequence: normalizeNumber(envelope.channelSequence),
      channelSequenceEnd: normalizeNumber(envelope.channelSequenceEnd),
      phase,
      phaseId: normalizeString(phase?.phaseId || phase?.phase_id),
      phaseKind: normalizeString(phase?.phaseKind || phase?.phase_kind),
      thinkingId: normalizeString(phase?.thinkingId || phase?.thinking_id),
      toolCallId: normalizeString(phase?.toolCallId || phase?.tool_call_id),
      toolName: normalizeString(phase?.toolName || phase?.tool_name),
      displayLabel: deriveEnvelopeDisplayLabel(envelope, phase),
    };
  }

  function streamEnvelopeToLegacyPayload(envelope = {}) {
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
      return null;
    }
    const channel = normalizeString(envelope.channel);
    const eventKind = normalizeString(envelope.eventKind);
    const schemaVersion = normalizeNumber(envelope.schemaVersion);
    if (
      (schemaVersion != null && schemaVersion !== STREAM_ENVELOPE_SCHEMA_VERSION)
      || !STREAM_ENVELOPE_CHANNELS.has(channel)
      || !STREAM_ENVELOPE_EVENT_KINDS.has(eventKind)
      || !normalizeString(envelope.streamId)
    ) {
      return null;
    }
    const payload = envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : {};
    const common = commonLegacyFields(envelope);

    if (eventKind === 'started' && channel === 'control') {
      return {
        ...payload,
        ...common,
        type: normalizeString(payload.type) || 'started',
      };
    }
    if (eventKind === 'reset') {
      // Preserve the full reset payload, including reason, next_assistant_message_id, preserve_prior_segments, and discard_scope; common transport identity fields take precedence.
      return {
        ...payload,
        ...common,
        type: 'stream_reset',
      };
    }
    if (eventKind === 'terminal') {
      return {
        ...payload,
        ...common,
        type: normalizeString(payload.type) || 'complete',
      };
    }
    if (eventKind === 'delta' && channel === 'response') {
      const hasAggregate = Object.prototype.hasOwnProperty.call(payload, 'aggregate');
      const hasAggregateLength = Object.prototype.hasOwnProperty.call(payload, 'aggregateLength');
      return {
        ...common,
        type: 'delta',
        content: String(payload.delta || ''),
        ...(hasAggregate ? { aggregate: String(payload.aggregate || '') } : {}),
        ...(hasAggregateLength ? { aggregateLength: normalizeNumber(payload.aggregateLength) } : {}),
      };
    }
    if (eventKind === 'delta' && channel === 'reasoning') {
      const hasAggregate = Object.prototype.hasOwnProperty.call(payload, 'aggregate');
      const hasAggregateLength = Object.prototype.hasOwnProperty.call(payload, 'aggregateLength');
      const reasoning = {
        source: normalizeString(payload.source) || 'provider',
        entriesDelta: buildReasoningEntries(envelope, payload),
      };
      const summary = normalizeString(payload.summary);
      if (summary) {
        reasoning.summary = summary;
      }
      const tokensPerSecond = Number(payload.tokensPerSecond ?? payload.tokens_per_second);
      if (Number.isFinite(tokensPerSecond) && tokensPerSecond > 0) {
        reasoning.tokensPerSecond = tokensPerSecond;
      }
      return {
        ...common,
        type: 'delta',
        content: '',
        reasoning,
        ...(summary ? { summary } : {}),
        ...(hasAggregate ? { aggregate: String(payload.aggregate || '') } : {}),
        ...(hasAggregateLength ? { aggregateLength: normalizeNumber(payload.aggregateLength) } : {}),
      };
    }
    return {
      ...payload,
      ...common,
      type: normalizeString(payload.type)
        || (eventKind === 'completed' && channel === 'phase' ? 'phase_completed' : '')
        || (eventKind === 'started' && channel === 'phase' ? 'phase_started' : '')
        || eventKind,
    };
  }

  function createStreamEnvelopeSequenceGuard({
    appendClientLog = () => {},
    maxStreams = DEFAULT_RENDERER_ENVELOPE_STREAM_CAP,
  } = {}) {
    const sequenceStateByStream = new Map();
    const maxTrackedStreams = normalizePositiveInteger(maxStreams, DEFAULT_RENDERER_ENVELOPE_STREAM_CAP);

    function reject(state, streamId, reason, details) {
      state.poisoned = true;
      state.reason = reason;
      const eventName = reason === 'sequence_regression' || reason === 'channel_sequence_regression'
        ? 'stream.envelope_v2_sequence_regression'
        : reason.startsWith('invalid_')
          ? 'stream.envelope_v2_sequence_invalid'
          : 'stream.envelope_v2_sequence_gap';
      appendClientLog('WARN', eventName, {
        streamId: streamId.slice(0, 30),
        reason,
        ...details,
      });
      pruneOldestStreamEntry(
        sequenceStateByStream,
        maxTrackedStreams,
        streamId,
        appendClientLog,
        'stream.envelope_v2_sequence_state_pruned'
      );
      return false;
    }

    return {
      shouldAccept(envelope = {}) {
        const streamId = normalizeString(envelope.streamId);
        const sequence = normalizeNumber(envelope.sequence);
        if (!streamId) {
          return true;
        }
        let state = sequenceStateByStream.get(streamId);
        if (!state) {
          state = {
            nextSequence: 1, nextByChannel: new Map(), poisoned: false, reason: '',
            missingSequenceLogged: false,
          };
          sequenceStateByStream.set(streamId, state);
        }
        if (state.poisoned) {
          return false;
        }
        // The synthetic started envelope intentionally carries no sequence,
        // and other producers may legitimately omit stamping. A sequence-less
        // envelope is tolerated without advancing the guard's expectations —
        // poisoning here silently dropped the whole renderer to legacy mode.
        // Logged once per stream so a chatty producer is visible, not noisy.
        if (sequence == null) {
          if (normalizeString(envelope.eventKind) !== 'started' && !state.missingSequenceLogged) {
            state.missingSequenceLogged = true;
            appendClientLog('WARN', 'stream.envelope_v2_sequence_missing', {
              streamId: streamId.slice(0, 30),
              channel: normalizeString(envelope.channel).slice(0, 30),
              eventKind: normalizeString(envelope.eventKind).slice(0, 30),
            });
          }
          pruneOldestStreamEntry(
            sequenceStateByStream,
            maxTrackedStreams,
            streamId,
            appendClientLog,
            'stream.envelope_v2_sequence_state_pruned'
          );
          return true;
        }
        if (sequence < 1) {
          return reject(state, streamId, 'invalid_sequence', { sequence });
        }
        const sequenceEnd = normalizeNumber(envelope.sequenceEnd);
        const normalizedEnd = sequenceEnd ?? sequence;
        if (normalizedEnd < sequence) {
          return reject(state, streamId, 'invalid_sequence_range', { sequence, sequenceEnd: normalizedEnd });
        }
        if (sequence !== state.nextSequence) {
          return reject(
            state,
            streamId,
            sequence < state.nextSequence ? 'sequence_regression' : 'sequence_gap',
            { sequence, expectedSequence: state.nextSequence }
          );
        }
        const channel = normalizeString(envelope.channel);
        const channelSequence = normalizeNumber(envelope.channelSequence);
        const channelSequenceEnd = normalizeNumber(envelope.channelSequenceEnd) ?? channelSequence;
        if (!channel || channelSequence == null || channelSequence < 1 || channelSequenceEnd < channelSequence) {
          return reject(state, streamId, 'invalid_channel_sequence', {
            channel: channel.slice(0, 30),
            channelSequence,
            channelSequenceEnd,
          });
        }
        const expectedChannelSequence = state.nextByChannel.get(channel) || 1;
        if (channelSequence !== expectedChannelSequence) {
          return reject(state, streamId, channelSequence < expectedChannelSequence
            ? 'channel_sequence_regression'
            : 'channel_sequence_gap', {
            channel: channel.slice(0, 30),
            channelSequence,
            expectedChannelSequence,
          });
        }
        state.nextSequence = normalizedEnd + 1;
        state.nextByChannel.set(channel, channelSequenceEnd + 1);
        pruneOldestStreamEntry(
          sequenceStateByStream,
          maxTrackedStreams,
          streamId,
          appendClientLog,
          'stream.envelope_v2_sequence_state_pruned'
        );
        return true;
      },
      consumeFault(streamId) {
        const state = sequenceStateByStream.get(normalizeString(streamId));
        return state?.poisoned ? String(state.reason || 'sequence_fault') : '';
      },
      clear(streamId) {
        sequenceStateByStream.delete(normalizeString(streamId));
      },
    };
  }

  function createStreamEnvelopeReceiptTracker({
    sendAck = () => {},
    appendClientLog = () => {},
    onRejected = () => {},
    maxStreams = DEFAULT_RENDERER_ENVELOPE_STREAM_CAP,
  } = {}) {
    const proofByStream = new Map();
    // Buffered payloads are owned by the semantic stream buffer. Receipt state
    // retains only fixed-size proof ranges and terminal identity, never payloads.
    const bufferedByStream = new Map();
    const maxTrackedStreams = normalizePositiveInteger(maxStreams, DEFAULT_RENDERER_ENVELOPE_STREAM_CAP);
    let rendererEpoch = 0;

    function sendRecord(record, streamId = '') {
      function handleResult(result) {
        if (result && typeof result === 'object' && result.ok === false) {
          onRejected(result, record);
        }
        return result;
      }
      try {
        const result = sendAck(record);
        if (result && typeof result.catch === 'function') {
          result.then(handleResult).catch((error) => {
            appendClientLog('WARN', 'stream.envelope_v2_ack_failed', {
              streamId: normalizeString(streamId).slice(0, 30),
              message: String(error?.message || error).slice(0, 300),
            });
          });
        } else {
          handleResult(result);
        }
        return result;
      } catch (error) {
        appendClientLog('WARN', 'stream.envelope_v2_ack_failed', {
          streamId: normalizeString(streamId).slice(0, 30),
          message: String(error?.message || error).slice(0, 300),
        });
        return null;
      }
    }

    function beginSubscription(epoch, mode = 'envelope') {
      const normalizedEpoch = normalizeNumber(epoch);
      rendererEpoch = normalizedEpoch != null && normalizedEpoch > 0 ? normalizedEpoch : rendererEpoch + 1;
      proofByStream.clear();
      bufferedByStream.clear();
      return sendRecord({
        recordType: 'subscription_started',
        rendererEpoch,
        mode: normalizeString(mode) || 'legacy',
      });
    }

    function getProof(streamId) {
      let proof = proofByStream.get(streamId);
      if (!proof) {
        proof = { count: 0, sequenceStart: null, sequenceEnd: null, channels: new Map() };
        proofByStream.set(streamId, proof);
      }
      return proof;
    }

    function addEnvelopeToProof(proof, envelope = {}) {
      proof.count += 1;
      const sequence = normalizeNumber(envelope.sequence);
      const sequenceEnd = normalizeNumber(envelope.sequenceEnd) ?? sequence;
      if (sequence != null) {
        proof.sequenceStart = proof.sequenceStart == null ? sequence : Math.min(proof.sequenceStart, sequence);
        proof.sequenceEnd = proof.sequenceEnd == null ? sequenceEnd : Math.max(proof.sequenceEnd, sequenceEnd);
      }
      const channel = normalizeString(envelope.channel);
      const channelSequence = normalizeNumber(envelope.channelSequence);
      const channelSequenceEnd = normalizeNumber(envelope.channelSequenceEnd) ?? channelSequence;
      if (channel && channelSequence != null) {
        const channelProof = proof.channels.get(channel) || {
          count: 0,
          sequenceStart: channelSequence,
          sequenceEnd: channelSequenceEnd,
        };
        channelProof.count += 1;
        channelProof.sequenceStart = Math.min(channelProof.sequenceStart, channelSequence);
        channelProof.sequenceEnd = Math.max(channelProof.sequenceEnd, channelSequenceEnd);
        proof.channels.set(channel, channelProof);
      }
    }

    function mergeProof(target, incoming) {
      target.count += incoming.count;
      if (incoming.sequenceStart != null) {
        target.sequenceStart = target.sequenceStart == null
          ? incoming.sequenceStart
          : Math.min(target.sequenceStart, incoming.sequenceStart);
        target.sequenceEnd = target.sequenceEnd == null
          ? incoming.sequenceEnd
          : Math.max(target.sequenceEnd, incoming.sequenceEnd);
      }
      for (const [channel, incomingChannel] of incoming.channels) {
        const current = target.channels.get(channel);
        if (!current) {
          target.channels.set(channel, { ...incomingChannel });
          continue;
        }
        current.count += incomingChannel.count;
        current.sequenceStart = Math.min(current.sequenceStart, incomingChannel.sequenceStart);
        current.sequenceEnd = Math.max(current.sequenceEnd, incomingChannel.sequenceEnd);
      }
    }

    function noteEnvelope(envelope = {}) {
      const streamId = normalizeString(envelope.streamId);
      if (!streamId) {
        return;
      }
      addEnvelopeToProof(getProof(streamId), envelope);
      pruneOldestStreamEntry(
        proofByStream,
        maxTrackedStreams,
        streamId,
        appendClientLog,
        'stream.envelope_v2_receipt_state_pruned'
      );
    }

    // Count a processed envelope, or stash a buffered one for later replay (#8).
    function noteProcessed(envelope = {}, buffered = false) {
      if (buffered === true) {
        noteBufferedEnvelope(envelope);
      } else {
        noteEnvelope(envelope);
      }
    }

    // Summarize an envelope buffered but not yet processed. A terminal receipt
    // is emitted only after semantic replay succeeds.
    function noteBufferedEnvelope(envelope = {}) {
      const streamId = normalizeString(envelope.streamId);
      if (!streamId) {
        return;
      }
      const summary = bufferedByStream.get(streamId) || {
        proof: { count: 0, sequenceStart: null, sequenceEnd: null, channels: new Map() },
        identity: null,
        terminalEnvelope: null,
      };
      addEnvelopeToProof(summary.proof, envelope);
      summary.identity = {
        streamId,
        sessionId: normalizeString(envelope.sessionId),
        turnId: normalizeString(envelope.turnId || envelope.turn_id),
      };
      if (normalizeString(envelope.eventKind) === 'terminal') {
        summary.terminalEnvelope = {
          ...summary.identity,
          eventKind: 'terminal',
          payload: { type: normalizeString(envelope.payload?.type) || 'terminal' },
        };
      }
      bufferedByStream.set(streamId, summary);
      pruneOldestStreamEntry(
        bufferedByStream,
        maxTrackedStreams,
        streamId,
        appendClientLog,
        'stream.envelope_v2_receipt_state_pruned'
      );
    }

    // Called after flushBufferedStreamEvents replays a stream's buffered payloads:
    // count each previously-buffered envelope (now processed) and ack a terminal
    // if one was in the batch.
    function flushBufferedReceipts(streamId) {
      const normalized = normalizeString(streamId);
      if (!normalized) {
        return;
      }
      const summary = bufferedByStream.get(normalized);
      if (!summary) {
        bufferedByStream.delete(normalized);
        return;
      }
      bufferedByStream.delete(normalized);
      mergeProof(getProof(normalized), summary.proof);
      if (summary.terminalEnvelope) {
        flushAck(summary.terminalEnvelope);
      }
    }

    function faultBufferedReceipts(streamId, reason = 'buffer_replay_degraded') {
      const normalized = normalizeString(streamId);
      const summary = bufferedByStream.get(normalized);
      if (!summary) return null;
      return noteFault(summary.identity || { streamId: normalized }, reason);
    }

    function flushAck(envelope = {}) {
      const streamId = normalizeString(envelope.streamId);
      if (!streamId) {
        return;
      }
      const proof = proofByStream.get(streamId) || {
        count: 0,
        sequenceStart: null,
        sequenceEnd: null,
        channels: new Map(),
      };
      proofByStream.delete(streamId);
      const channels = {};
      for (const channel of Array.from(proof.channels.keys()).sort()) {
        channels[channel] = { ...proof.channels.get(channel) };
      }
      return sendRecord({
        recordType: 'terminal_receipt',
        rendererEpoch,
        streamId,
        ...(normalizeString(envelope.sessionId) ? { session_id: normalizeString(envelope.sessionId) } : {}),
        ...(normalizeString(envelope.turnId || envelope.turn_id)
          ? { turn_id: normalizeString(envelope.turnId || envelope.turn_id) }
          : {}),
        receivedCount: proof.count,
        sequenceStart: proof.sequenceStart,
        sequenceEnd: proof.sequenceEnd,
        channels,
        terminalType: normalizeString(envelope.payload?.type) || normalizeString(envelope.eventKind),
        eventKind: normalizeString(envelope.eventKind),
      }, streamId);
    }

    function noteFault(envelope = {}, reason = 'sequence_fault') {
      const streamId = normalizeString(envelope.streamId);
      if (!streamId) {
        return null;
      }
      proofByStream.delete(streamId);
      bufferedByStream.delete(streamId);
      return sendRecord({
        recordType: 'stream_fault',
        rendererEpoch,
        streamId,
        ...(normalizeString(envelope.sessionId) ? { session_id: normalizeString(envelope.sessionId) } : {}),
        ...(normalizeString(envelope.turnId || envelope.turn_id)
          ? { turn_id: normalizeString(envelope.turnId || envelope.turn_id) }
          : {}),
        reason: normalizeString(reason).slice(0, 80) || 'sequence_fault',
      }, streamId);
    }

    function dropStream(streamId) {
      const normalized = normalizeString(streamId);
      if (!normalized) {
        return;
      }
      proofByStream.delete(normalized);
      bufferedByStream.delete(normalized);
    }

    function size() {
      return proofByStream.size;
    }

    return {
      beginSubscription,
      noteEnvelope,
      noteProcessed,
      noteBufferedEnvelope,
      flushBufferedReceipts,
      faultBufferedReceipts,
      flushAck,
      noteFault,
      dropStream,
      size,
    };
  }

  return {
    STREAM_ENVELOPE_SCHEMA_VERSION,
    createStreamEnvelopeReceiptTracker,
    createStreamEnvelopeSequenceGuard,
    streamEnvelopeToLegacyPayload,
  };
});
