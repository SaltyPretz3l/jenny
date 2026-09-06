const { normalizeString: normalizeToken } = require('./shared/normalize');

const STREAM_ENVELOPE_SCHEMA_VERSION = 2;
const STREAM_ENVELOPE_CHANNELS = new Set(['reasoning', 'response', 'tool', 'phase', 'control']);
const TOOL_CHAT_STREAM_TYPES = new Set(['tool_use', 'tool_result', 'tool_approval_needed']);
const TERMINAL_CHAT_STREAM_TYPES = new Set(['complete', 'question_batch', 'plan_proposal', 'error']);
const ENVELOPE_PAYLOAD_METADATA_KEYS = [
  'aggregate',
  'reasoning',
  'phase',
  'channel',
  'channelSequence',
  'channel_sequence',
  'channelSequenceEnd',
  'channel_sequence_end',
  'sequence',
  'sequenceEnd',
  'sequence_end',
  'schemaVersion',
  'schema_version',
  'emittedAtMs',
  'emitted_at_ms',
  'bridgedAtMs',
  'bridged_at_ms',
];

function normalizeEventPayload(event) {
  return event && typeof event === 'object' && !Array.isArray(event) ? { ...event } : {};
}

function normalizeNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : null;
}

function normalizeFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeEnvelopePhase(payload = {}) {
  const source = payload.phase && typeof payload.phase === 'object' && !Array.isArray(payload.phase)
    ? payload.phase
    : payload;
  const phaseId = normalizeToken(source.phaseId || source.phase_id || payload.phaseId || payload.phase_id);
  const phaseKind = normalizeToken(source.phaseKind || source.phase_kind || payload.phaseKind || payload.phase_kind);
  const thinkingId = normalizeToken(source.thinkingId || source.thinking_id || payload.thinkingId || payload.thinking_id);
  const toolCallId = normalizeToken(source.toolCallId || source.tool_call_id || payload.toolCallId || payload.tool_call_id || payload.callId || payload.call_id);
  const toolName = normalizeToken(source.toolName || source.tool_name || payload.toolName || payload.tool_name);
  const summary = normalizeToken(source.summary || payload.summary);
  const iteration = normalizeNumber(source.iteration ?? payload.iteration);
  if (!phaseId && !phaseKind && !thinkingId && !toolCallId && !toolName && !summary && iteration == null) {
    return null;
  }
  return {
    ...(phaseId ? { phaseId } : {}),
    ...(phaseKind ? { phaseKind } : {}),
    ...(iteration != null ? { iteration } : {}),
    ...(thinkingId ? { thinkingId } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(toolName ? { toolName } : {}),
    ...(summary ? { summary } : {}),
  };
}

function phaseKindOf(phase) {
  return normalizeToken(phase?.phaseKind || phase?.phase_kind).toLowerCase();
}

function phaseMatchesEnvelopeChannel(phase, channel) {
  if (!phase) return true;
  if (channel === 'phase' || channel === 'control') return true;
  const kind = phaseKindOf(phase);
  if (!kind) return false;
  if (channel === 'reasoning') return kind === 'reasoning' || kind === 'thinking';
  if (channel === 'response') return kind === 'text' || kind === 'response' || kind === 'final_answer';
  if (channel === 'tool') return kind === 'tool_use' || kind === 'tool_result' || kind === 'approval_wait';
  return false;
}

function phaseKey(phase) {
  if (!phase) return '';
  return [
    normalizeToken(phase.phaseId || phase.phase_id),
    normalizeToken(phase.phaseKind || phase.phase_kind),
    normalizeNumber(phase.iteration) ?? '',
    normalizeToken(phase.thinkingId || phase.thinking_id),
    normalizeToken(phase.toolCallId || phase.tool_call_id),
    normalizeToken(phase.toolName || phase.tool_name),
  ].join('|');
}

function inferEnvelopeChannel(payload, type) {
  const explicit = normalizeToken(payload?.channel);
  if (STREAM_ENVELOPE_CHANNELS.has(explicit)) return explicit;
  if (type === 'delta') {
    const hasReasoning = Array.isArray(payload?.reasoning?.entriesDelta)
      && payload.reasoning.entriesDelta.length > 0;
    const hasContent = Object.prototype.hasOwnProperty.call(payload, 'content')
      && String(payload.content || '') !== '';
    if (hasReasoning && !hasContent) return 'reasoning';
    return 'response';
  }
  if (type === 'phase_started' || type === 'phase_completed') return 'phase';
  if (TOOL_CHAT_STREAM_TYPES.has(type) || type === 'tool_output_chunk') return 'tool';
  return 'control';
}

function inferEnvelopeEventKind(type) {
  if (type === 'stream_reset') return 'reset';
  if (TERMINAL_CHAT_STREAM_TYPES.has(type)) return 'terminal';
  if (type === 'phase_started' || type === 'tool_use' || type === 'tool_approval_needed' || type === 'started') return 'started';
  if (type === 'phase_completed' || type === 'tool_result') return 'completed';
  // W2-1 live tool-output batches must NOT classify as 'delta' — the bridge
  // coalesces same-key delta envelopes with a payload merge that replaces
  // `lines` (earlier batches would vanish). 'progress' passes through 1:1.
  // Same hazard for the mid-turn context-ring snapshot: a stream of readings
  // on one channel would coalesce into a single merged payload, so the ring
  // would jump instead of tracking the turn. 'progress' passes through 1:1.
  if (type === 'tool_output_chunk' || type === 'context_usage') return 'progress';
  return 'delta';
}

function isTerminalChatStreamType(type) {
  return TERMINAL_CHAT_STREAM_TYPES.has(normalizeToken(type));
}

function buildReasoningEnvelopePayload(payload) {
  const reasoning = payload.reasoning && typeof payload.reasoning === 'object' && !Array.isArray(payload.reasoning)
    ? payload.reasoning
    : {};
  const aggregateLength = normalizeNumber(payload.aggregateLength);
  const hasAggregate = Object.prototype.hasOwnProperty.call(payload, 'aggregate');
  const envelopePayload = {
    source: normalizeToken(reasoning.source) || 'provider',
    entriesDelta: Array.isArray(reasoning.entriesDelta)
      ? reasoning.entriesDelta.map((entry) => normalizeEventPayload(entry))
      : [],
    ...(hasAggregate ? { aggregate: String(payload.aggregate || '') } : {}),
    ...(aggregateLength != null ? { aggregateLength } : {}),
  };
  const delta = String(reasoning.delta || reasoning.text || payload.delta || '');
  if (delta) envelopePayload.delta = delta;
  const summary = normalizeToken(reasoning.summary || payload.summary);
  if (summary) envelopePayload.summary = summary;
  const tokensPerSecond = normalizeFiniteNumber(reasoning.tokensPerSecond ?? reasoning.tokens_per_second ?? payload.tokensPerSecond ?? payload.tokens_per_second);
  if (tokensPerSecond != null) envelopePayload.tokensPerSecond = tokensPerSecond;
  return envelopePayload;
}

function buildResponseEnvelopePayload(payload) {
  const tokenSequence = normalizeNumber(payload.tokenSequence ?? payload.token_sequence);
  const aggregateLength = normalizeNumber(payload.aggregateLength);
  const hasAggregate = Object.prototype.hasOwnProperty.call(payload, 'aggregate');
  return {
    delta: String(payload.content || ''),
    // Carry cumulative `aggregate` so the renderer can detect content rollback
    // (qwen3 and similar reasoners retract tokens mid-stream). Without it the
    // renderer's rollback branch never fires and the chat row flickers as
    // partial deltas get appended after a retraction. Preserved across V2
    // coalescing in mergeEnvelopeDeltaPayloads (checkpoint-aware merge).
    ...(hasAggregate ? { aggregate: String(payload.aggregate || '') } : {}),
    ...(aggregateLength != null ? { aggregateLength } : {}),
    ...(tokenSequence != null ? { tokenSequence } : {}),
  };
}

function cloneEnvelopePayload(payload) {
  const clone = normalizeEventPayload(payload);
  for (const key of ENVELOPE_PAYLOAD_METADATA_KEYS) {
    delete clone[key];
  }
  return clone;
}

function mergeEnvelopeDeltaPayloads(existing = {}, incoming = {}) {
  const merged = { ...existing, ...incoming };
  const existingDelta = String(existing.delta || '');
  const incomingDelta = String(incoming.delta || '');
  if (existingDelta || incomingDelta) merged.delta = existingDelta + incomingDelta;
  const existingEntries = Array.isArray(existing.entriesDelta) ? existing.entriesDelta : [];
  const incomingEntries = Array.isArray(incoming.entriesDelta) ? incoming.entriesDelta : [];
  if (existingEntries.length || incomingEntries.length) {
    // Replace full snapshots by id to avoid duplicate-entry growth across coalesced frames.
    const entriesDelta = existingEntries.slice();
    const entryIndexById = new Map();
    for (let index = 0; index < entriesDelta.length; index += 1) {
      const id = String(entriesDelta[index]?.id || '').trim();
      if (id && !entryIndexById.has(id)) entryIndexById.set(id, index);
    }
    for (const entry of incomingEntries) {
      const id = String(entry?.id || '').trim();
      const existingIndex = id ? entryIndexById.get(id) : undefined;
      if (Number.isInteger(existingIndex)) {
        entriesDelta[existingIndex] = entry;
      } else {
        if (id) entryIndexById.set(id, entriesDelta.length);
        entriesDelta.push(entry);
      }
    }
    merged.entriesDelta = entriesDelta;
  }
  const incomingSummary = normalizeToken(incoming.summary);
  if (incomingSummary) merged.summary = incomingSummary;
  else if (normalizeToken(existing.summary)) merged.summary = normalizeToken(existing.summary);
  // aggregate is cumulative: prefer the latest checkpoint, otherwise drop a stale one.
  //
  // Deliberately does NOT mirror the legacy merge's reconstruct-from-content step.
  // That step adds `incoming.delta` to the previous aggregate, which is only valid
  // where `delta` is the visible-text increment. On the reasoning channel `delta`
  // comes from `reasoning.delta || reasoning.text` (buildReasoningEnvelopePayload),
  // a DIFFERENT text stream from the `aggregate`/`aggregateLength` pair, which
  // always describe the visible assistant text. A length coincidence there would
  // fabricate an aggregate that then passes the self-check below. Dropping instead
  // costs one checkpoint's worth of re-seed and falls back to delta-concat, which
  // is always correct.
  const incomingHasAggregate = Object.prototype.hasOwnProperty.call(incoming, 'aggregate');
  const incomingHasAggregateLength = Object.prototype.hasOwnProperty.call(incoming, 'aggregateLength');
  if (incomingHasAggregate) {
    merged.aggregate = incoming.aggregate;
    if (incomingHasAggregateLength) merged.aggregateLength = incoming.aggregateLength;
    else delete merged.aggregateLength;
  } else if (incomingHasAggregateLength) {
    delete merged.aggregate;
  }
  if (
    Object.prototype.hasOwnProperty.call(merged, 'aggregate')
    && Object.prototype.hasOwnProperty.call(merged, 'aggregateLength')
    && String(merged.aggregate || '').length !== merged.aggregateLength
  ) {
    delete merged.aggregate;
  }
  return merged;
}

function mergeContiguousRangeEnd(baseStartValue, baseEndValue, incomingStartValue, incomingEndValue) {
  const baseStart = normalizeNumber(baseStartValue);
  const baseEnd = normalizeNumber(baseEndValue) ?? baseStart;
  const incomingStart = normalizeNumber(incomingStartValue);
  const incomingEnd = normalizeNumber(incomingEndValue) ?? incomingStart;
  if (baseEnd == null) {
    return incomingEnd;
  }
  if (incomingStart == null) {
    return baseEnd;
  }
  if (incomingStart <= baseEnd + 1) {
    return Math.max(baseEnd, incomingEnd ?? incomingStart);
  }
  return baseEnd;
}

function mergeStreamEnvelopeDeltas(existingEnvelope, incomingEnvelope) {
  const base = existingEnvelope || incomingEnvelope;
  const incoming = incomingEnvelope || existingEnvelope;
  return {
    ...incoming,
    sequence: base.sequence,
    sequenceEnd: mergeContiguousRangeEnd(
      base.sequence,
      base.sequenceEnd,
      incoming.sequence,
      incoming.sequenceEnd
    ),
    channelSequence: base.channelSequence,
    channelSequenceEnd: mergeContiguousRangeEnd(
      base.channelSequence,
      base.channelSequenceEnd,
      incoming.channelSequence,
      incoming.channelSequenceEnd
    ),
    emittedAtMs: normalizeNumber(base.emittedAtMs) ?? normalizeNumber(incoming.emittedAtMs),
    payload: mergeEnvelopeDeltaPayloads(base.payload, incoming.payload),
  };
}

function buildEnvelopeDeltaKey(envelope) {
  return [
    normalizeToken(envelope?.streamId),
    normalizeToken(envelope?.channel),
    normalizeToken(envelope?.eventKind),
    phaseKey(envelope?.phase),
  ].join('\u0000');
}

function buildEnvelopeSources(payload, type) {
  if (type !== 'delta') {
    return [{
      channel: inferEnvelopeChannel(payload, type),
      eventKind: inferEnvelopeEventKind(type),
      payload: cloneEnvelopePayload(payload),
    }];
  }
  const sources = [];
  const hasContentKey = Object.prototype.hasOwnProperty.call(payload, 'content');
  const content = String(payload.content || '');
  if ((inferEnvelopeChannel(payload, type) === 'response' && hasContentKey) || content) {
    sources.push({ channel: 'response', eventKind: 'delta', payload: buildResponseEnvelopePayload(payload) });
  }
  const reasoning = payload.reasoning && typeof payload.reasoning === 'object' && !Array.isArray(payload.reasoning)
    ? payload.reasoning
    : null;
  const hasReasoningEntries = Array.isArray(reasoning?.entriesDelta) && reasoning.entriesDelta.length > 0;
  const hasReasoningDelta = Boolean(reasoning && (reasoning.delta || reasoning.text || reasoning.summary));
  if (hasReasoningEntries || hasReasoningDelta) {
    sources.push({ channel: 'reasoning', eventKind: 'delta', payload: buildReasoningEnvelopePayload(payload) });
  }
  if (!sources.length) {
    sources.push({ channel: inferEnvelopeChannel(payload, type), eventKind: 'delta', payload: cloneEnvelopePayload(payload) });
  }
  return sources;
}

module.exports = {
  STREAM_ENVELOPE_CHANNELS,
  STREAM_ENVELOPE_SCHEMA_VERSION,
  buildEnvelopeDeltaKey,
  buildEnvelopeSources,
  mergeStreamEnvelopeDeltas,
  isTerminalChatStreamType,
  normalizeEnvelopePhase,
  phaseMatchesEnvelopeChannel,
};
