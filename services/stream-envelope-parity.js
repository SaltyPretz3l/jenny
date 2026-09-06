const { normalizeString: normalizeToken } = require('./shared/normalize');

const TERMINAL_TYPES = new Set(['complete', 'error', 'question_batch']);

function clonePlain(value) {
  if (!value || typeof value !== 'object') {
    return value;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_error) {
    return value;
  }
}

function normalizePhase(phaseLike = {}) {
  const phase = phaseLike && typeof phaseLike === 'object' && !Array.isArray(phaseLike)
    ? phaseLike
    : {};
  const phaseId = normalizeToken(phase.phaseId || phase.phase_id);
  const phaseKind = normalizeToken(phase.phaseKind || phase.phase_kind);
  if (!phaseId && !phaseKind) {
    return null;
  }
  return {
    phaseId,
    phaseKind,
  };
}

function createProjection() {
  return {
    content: '',
    reasoningEntries: [],
    reasoningEditMismatches: 0,
    phases: [],
    tools: [],
    terminalStatus: '',
  };
}

function appendReasoningEntries(projection, entries) {
  if (!Array.isArray(entries) || !entries.length) {
    return;
  }
  for (const entry of entries) {
    const isEdit = entry
      && typeof entry.baseLength === 'number'
      && typeof entry.append === 'string';
    if (isEdit) {
      const id = normalizeToken(entry.id);
      let handled = false;
      for (let index = projection.reasoningEntries.length - 1; index >= 0; index -= 1) {
        const existing = projection.reasoningEntries[index];
        if (normalizeToken(existing?.id) !== id) {
          continue;
        }
        const text = String(existing?.text || '');
        if (
          typeof entry.baseTail === 'string'
          && text.length === entry.baseLength
          && text.endsWith(entry.baseTail)
        ) {
          existing.text = text + entry.append;
        } else {
          projection.reasoningEditMismatches = (projection.reasoningEditMismatches || 0) + 1;
        }
        handled = true;
        break;
      }
      if (!handled) {
        projection.reasoningEditMismatches = (projection.reasoningEditMismatches || 0) + 1;
      }
      continue;
    }
    projection.reasoningEntries.push(clonePlain(entry));
  }
}

function appendReasoningDelta(projection, payload = {}, envelope = {}) {
  const entries = Array.isArray(payload.entriesDelta) ? payload.entriesDelta : [];
  if (entries.length) {
    appendReasoningEntries(projection, entries);
    return;
  }
  const delta = String(payload.delta || '');
  if (!delta) {
    return;
  }
  projection.reasoningEntries.push({
    id: `reasoning_${normalizeToken(envelope.streamId) || 'stream'}_${normalizeToken(envelope.channelSequence || envelope.sequence) || '0'}`,
    text: delta,
  });
}

function resetProjectionForSegment(projection) {
  projection.content = '';
  projection.reasoningEntries = [];
  projection.phases = [];
}

function appendPhase(projection, phaseLike) {
  const phase = normalizePhase(phaseLike);
  if (!phase) {
    return;
  }
  const key = `${phase.phaseId}|${phase.phaseKind}`;
  if (projection.phases.some((entry) => `${entry.phaseId}|${entry.phaseKind}` === key)) {
    return;
  }
  projection.phases.push(phase);
}

function appendTool(projection, payload = {}) {
  const type = normalizeToken(payload.type);
  if (!type || !type.startsWith('tool_')) {
    return;
  }
  projection.tools.push({
    type,
    callId: normalizeToken(payload.callId || payload.call_id),
    toolName: normalizeToken(payload.toolName || payload.tool_name),
    status: normalizeToken(payload.status || payload.approvalState || payload.approval_state),
  });
}

function projectLegacyStreamPayload(projection, payload = {}) {
  const type = normalizeToken(payload.type);
  if (type === 'delta') {
    projection.content += String(payload.content || '');
    appendReasoningEntries(projection, payload.reasoning?.entriesDelta);
    appendPhase(projection, payload.phase || {
      phaseId: payload.phaseId,
      phaseKind: payload.phaseKind,
    });
    return projection;
  }
  if (type === 'phase_started' || type === 'phase_completed') {
    appendPhase(projection, payload.phase || {
      phaseId: payload.phaseId,
      phaseKind: payload.phaseKind,
    });
    return projection;
  }
  if (type === 'stream_reset') {
    resetProjectionForSegment(projection);
    return projection;
  }
  appendTool(projection, payload);
  if (TERMINAL_TYPES.has(type)) {
    projection.terminalStatus = type;
  }
  return projection;
}

function projectEnvelope(projection, envelope = {}) {
  const channel = normalizeToken(envelope.channel);
  const eventKind = normalizeToken(envelope.eventKind);
  const payload = envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : {};
  if (eventKind === 'reset') {
    resetProjectionForSegment(projection);
    return projection;
  }
  appendPhase(projection, envelope.phase);
  if (eventKind === 'delta' && channel === 'response') {
    projection.content += String(payload.delta || '');
    return projection;
  }
  if (eventKind === 'delta' && channel === 'reasoning') {
    appendReasoningDelta(projection, payload, envelope);
    return projection;
  }
  if (channel === 'tool') {
    appendTool(projection, payload);
  }
  if (eventKind === 'terminal') {
    projection.terminalStatus = normalizeToken(payload.type) || 'terminal';
  }
  return projection;
}

function stableJson(value) {
  return JSON.stringify(value);
}

function diffStreamEnvelopeProjections(legacyProjection, envelopeProjection) {
  const diff = {};
  const legacy = legacyProjection || createProjection();
  const envelope = envelopeProjection || createProjection();
  if (legacy.content !== envelope.content) {
    diff.content = { legacy: legacy.content, envelope: envelope.content };
  }
  if (stableJson(legacy.reasoningEntries) !== stableJson(envelope.reasoningEntries)) {
    diff.reasoningEntries = {
      legacy: legacy.reasoningEntries,
      envelope: envelope.reasoningEntries,
    };
  }
  if (stableJson(legacy.phases) !== stableJson(envelope.phases)) {
    diff.phaseRows = { legacy: legacy.phases, envelope: envelope.phases };
  }
  if (stableJson(legacy.tools) !== stableJson(envelope.tools)) {
    diff.toolRows = { legacy: legacy.tools, envelope: envelope.tools };
  }
  if (legacy.terminalStatus !== envelope.terminalStatus) {
    diff.terminalStatus = {
      legacy: legacy.terminalStatus,
      envelope: envelope.terminalStatus,
    };
  }
  return diff;
}

function hasDiff(diff) {
  return diff && typeof diff === 'object' && Object.keys(diff).length > 0;
}

function createStreamEnvelopeParityTracker({ log = () => {} } = {}) {
  const legacyProjection = createProjection();
  const envelopeProjection = createProjection();
  let legacyTerminal = false;
  let envelopeTerminal = false;
  let terminalLogged = false;

  function maybeLogTerminalDiff(streamId) {
    if (terminalLogged) {
      return;
    }
    if (!legacyTerminal || !envelopeTerminal) {
      return;
    }
    terminalLogged = true;
    const diff = diffStreamEnvelopeProjections(legacyProjection, envelopeProjection);
    if (!hasDiff(diff)) {
      return;
    }
    log('WARN', 'chat.stream_envelope_v2_parity_mismatch', {
      streamId: normalizeToken(streamId),
      diff,
    });
  }

  return {
    noteLegacy(payload) {
      projectLegacyStreamPayload(legacyProjection, payload);
      if (TERMINAL_TYPES.has(normalizeToken(payload?.type))) {
        legacyTerminal = true;
      }
      maybeLogTerminalDiff(payload?.streamId);
    },
    noteEnvelope(envelope) {
      projectEnvelope(envelopeProjection, envelope);
      if (normalizeToken(envelope?.eventKind) === 'terminal') {
        envelopeTerminal = true;
      }
      maybeLogTerminalDiff(envelope?.streamId);
    },
    diff() {
      return diffStreamEnvelopeProjections(legacyProjection, envelopeProjection);
    },
  };
}

module.exports = {
  createStreamEnvelopeParityTracker,
  diffStreamEnvelopeProjections,
  projectLegacyStreamPayload,
  projectEnvelope,
};
