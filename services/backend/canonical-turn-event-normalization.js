// Pure, stateless normalization helpers safe to require from the collector and tests.

const { normalizeId } = require('../shared/normalize');

const REDACTED_PATH_TOKEN = '[redacted:path]';
const REDACTED_PAYLOAD_PATH_KEYS = new Set(['absolute_path', 'absolutePath', 'resolvedPath']);

function cloneJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneJsonValue(entry));
  }
  if (value && typeof value === 'object') {
    const cloned = {};
    for (const [key, entry] of Object.entries(value)) {
      cloned[key] = cloneJsonValue(entry);
    }
    return cloned;
  }
  return value;
}

function normalizeBoundedText(value, maxLength = 160) {
  const text = normalizeId(value);
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeInteger(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : null;
}

function sanitizePathFieldsInPayload(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizePathFieldsInPayload(entry));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const sanitized = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (REDACTED_PAYLOAD_PATH_KEYS.has(entryKey)) {
      sanitized[entryKey] = String(entryValue || '').trim() ? REDACTED_PATH_TOKEN : '';
      continue;
    }
    sanitized[entryKey] = sanitizePathFieldsInPayload(entryValue);
  }
  return sanitized;
}

function normalizeStreamEnvelopePhaseMetadata(source) {
  const phase = source && typeof source === 'object' && !Array.isArray(source)
    ? source
    : {};
  const metadata = {};
  const phaseId = normalizeBoundedText(phase.phase_id || phase.phaseId, 128);
  const phaseKind = normalizeBoundedText(phase.phase_kind || phase.phaseKind, 64);
  const thinkingId = normalizeBoundedText(phase.thinking_id || phase.thinkingId, 128);
  const toolCallId = normalizeBoundedText(phase.tool_call_id || phase.toolCallId, 128);
  const toolName = normalizeBoundedText(phase.tool_name || phase.toolName, 128);
  const summary = normalizeBoundedText(phase.summary, 240);
  const iteration = normalizeInteger(phase.iteration);
  if (phaseId) metadata.phase_id = phaseId;
  if (phaseKind) metadata.phase_kind = phaseKind;
  if (iteration != null) metadata.iteration = Math.max(0, iteration);
  if (thinkingId) metadata.thinking_id = thinkingId;
  if (toolCallId) metadata.tool_call_id = toolCallId;
  if (toolName) metadata.tool_name = toolName;
  if (summary) metadata.summary = summary;
  return Object.keys(metadata).length ? metadata : null;
}

function normalizeStreamEnvelopeMetadata(source) {
  const envelope = source && typeof source === 'object' && !Array.isArray(source)
    ? source
    : {};
  const metadata = {};
  const sequence = normalizeInteger(envelope.sequence);
  const sequenceEnd = normalizeInteger(envelope.sequence_end ?? envelope.sequenceEnd);
  const channelSequence = normalizeInteger(envelope.channel_sequence ?? envelope.channelSequence);
  const channelSequenceEnd = normalizeInteger(envelope.channel_sequence_end ?? envelope.channelSequenceEnd);
  const channel = normalizeBoundedText(envelope.channel, 32);
  const eventKind = normalizeBoundedText(envelope.event_kind || envelope.eventKind, 32);
  if (sequence != null) metadata.sequence = Math.max(0, sequence);
  if (sequenceEnd != null) metadata.sequence_end = Math.max(0, sequenceEnd);
  if (channel) metadata.channel = channel;
  if (channelSequence != null) metadata.channel_sequence = Math.max(0, channelSequence);
  if (channelSequenceEnd != null) metadata.channel_sequence_end = Math.max(0, channelSequenceEnd);
  if (eventKind) metadata.event_kind = eventKind;
  const phase = normalizeStreamEnvelopePhaseMetadata(envelope.phase);
  if (phase) metadata.phase = phase;
  return Object.keys(metadata).length ? metadata : null;
}

function attachStreamEnvelopeMetadata(payload, source) {
  if (payload.stream_envelope) {
    return;
  }
  const streamEnvelope = normalizeStreamEnvelopeMetadata(source);
  if (streamEnvelope) {
    payload.stream_envelope = streamEnvelope;
  }
}

module.exports = {
  cloneJsonValue,
  normalizeId,
  normalizeBoundedText,
  normalizeInteger,
  sanitizePathFieldsInPayload,
  normalizeStreamEnvelopePhaseMetadata,
  normalizeStreamEnvelopeMetadata,
  attachStreamEnvelopeMetadata,
};
