const PHASE_SUMMARY_MAX_LENGTH = 240;

function cloneValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item));
  }
  if (value && typeof value === 'object') {
    const cloned = {};
    for (const [key, item] of Object.entries(value)) {
      cloned[key] = cloneValue(item);
    }
    return cloned;
  }
  return value;
}

function normalizePhaseSummary(value) {
  const summary = String(value || '').replace(/\s+/g, ' ').trim();
  if (!summary) {
    return '';
  }
  if (summary.length <= PHASE_SUMMARY_MAX_LENGTH) {
    return summary;
  }
  return `${summary.slice(0, PHASE_SUMMARY_MAX_LENGTH - 3).trim()}...`;
}

function normalizeReasoningEntry(entry, fallbackIndex = 0) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }
  const text = String(entry.text || '').trim();
  if (!text) {
    return null;
  }
  const normalized = {
    id: String(entry.id || `reasoning_${fallbackIndex}`),
    text,
    timestamp: String(entry.timestamp || ''),
  };
  const thinkingId = String(entry.thinkingId || entry.thinking_id || '').trim();
  if (thinkingId) {
    normalized.thinkingId = thinkingId;
  }
  return normalized;
}

function mergeReasoningEntryLists(existingEntries, incomingEntries) {
  const merged = [];
  const indexById = new Map();
  const combined = []
    .concat(Array.isArray(existingEntries) ? existingEntries : [])
    .concat(Array.isArray(incomingEntries) ? incomingEntries : []);
  for (let index = 0; index < combined.length; index += 1) {
    const entry = normalizeReasoningEntry(combined[index], index);
    if (!entry) {
      continue;
    }
    const existingIndex = indexById.get(entry.id);
    if (Number.isInteger(existingIndex)) {
      merged[existingIndex] = entry;
      continue;
    }
    const duplicateIndex = merged.findIndex(
      (candidate) =>
        candidate.text === entry.text
        && candidate.timestamp === entry.timestamp
        && String(candidate.thinkingId || '') === String(entry.thinkingId || '')
    );
    if (duplicateIndex !== -1) {
      continue;
    }
    indexById.set(entry.id, merged.length);
    merged.push(entry);
  }
  return merged;
}

function flattenReasoningEntriesFromPhases(phases, fallbackEntries) {
  const reasoningPhases = Array.isArray(phases) ? phases : [];
  const flattened = [];
  for (const phase of reasoningPhases) {
    if (String(phase?.phase_kind || '').trim() !== 'reasoning') {
      continue;
    }
    flattened.push(...(Array.isArray(phase.entries) ? phase.entries : []));
  }
  const merged = mergeReasoningEntryLists([], flattened);
  if (merged.length) {
    return merged;
  }
  return mergeReasoningEntryLists([], fallbackEntries);
}

function buildReasoningPayloadFromPhases(phases, fallbackEntries) {
  const entries = flattenReasoningEntriesFromPhases(phases, fallbackEntries);
  return {
    source: entries.length ? 'provider' : 'none',
    entries,
  };
}

function buildReasoningPhaseView(phases) {
  return (Array.isArray(phases) ? phases : [])
    .filter((phase) => String(phase?.phase_kind || '').trim() === 'reasoning')
    .map((phase) => {
      const view = {
        phaseId: String(phase.phase_id || ''),
        phaseKind: 'reasoning',
        iteration: Number(phase.iteration || 0) || 0,
        thinkingId: String(phase.thinking_id || ''),
        toolCallId: String(phase.tool_call_id || ''),
        toolName: String(phase.tool_name || ''),
        completed: Boolean(phase.completed_at || !phase.started_at),
        renderCollapsed: phase.render_collapsed === true,
        startedAt: String(phase.started_at || ''),
        completedAt: String(phase.completed_at || ''),
      };
      /* Optional v2 fields; absent on legacy phases. */
      const summary = String(phase.summary || '').trim();
      if (summary) view.summary = summary;
      const tokRate = Number(phase.tokens_per_second);
      if (Number.isFinite(tokRate) && tokRate > 0) view.tokensPerSecond = tokRate;
      return view;
    });
}

function normalizeTokenRate(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function applyPhaseTelemetry(phase, meta = {}) {
  if (!phase || typeof phase !== 'object') {
    return phase;
  }
  const summary = normalizePhaseSummary(meta.summary);
  if (summary) {
    phase.summary = summary;
  }
  const tokenRate = normalizeTokenRate(meta.tokens_per_second ?? meta.tokensPerSecond);
  if (tokenRate != null) {
    phase.tokens_per_second = tokenRate;
  }
  return phase;
}

class TranscriptPhaseCollector {
  constructor({ streamId } = {}) {
    this.streamId = String(streamId || '').trim();
    this.turnHasVisibleText = false;
    this.slice = this._createEmptySlice();
    this.currentPhase = null;
    this._phaseSequence = 0;
    this._segmentSequence = 0;
  }

  _createEmptySlice() {
    return {
      phases: [],
      visibleSegments: [],
      toolSteps: [],
    };
  }

  _nextPhaseId(phaseKind) {
    this._phaseSequence += 1;
    return `phase_${String(phaseKind || 'phase')}_${this.streamId || 'stream'}_${this._phaseSequence}`;
  }

  _nextSegmentId() {
    this._segmentSequence += 1;
    return `segment_${this.streamId || 'stream'}_${this._segmentSequence}`;
  }

  _openPhase(meta = {}, timestamp = new Date().toISOString()) {
    const phaseKind = String(meta.phase_kind || meta.phaseKind || '').trim();
    if (!phaseKind) {
      return null;
    }
    const phase = {
      phase_id: String(meta.phase_id || meta.phaseId || this._nextPhaseId(phaseKind)),
      phase_kind: phaseKind,
      iteration: Number(meta.iteration || 0) || 0,
      thinking_id: String(meta.thinking_id || meta.thinkingId || '').trim(),
      tool_call_id: String(meta.tool_call_id || meta.toolCallId || '').trim(),
      tool_name: String(meta.tool_name || meta.toolName || '').trim(),
      render_collapsed: phaseKind === 'reasoning' && this.turnHasVisibleText,
      started_at: String(meta.started_at || meta.startedAt || timestamp || ''),
      completed_at: '',
    };
    applyPhaseTelemetry(phase, meta);
    if (phaseKind === 'reasoning') {
      phase.entries = [];
    }
    this.slice.phases.push(phase);
    this.currentPhase = phase;
    return phase;
  }

  _ensurePhase(meta = {}, timestamp = new Date().toISOString()) {
    const phaseKind = String(meta.phase_kind || meta.phaseKind || '').trim();
    if (!phaseKind) {
      return null;
    }
    const explicitPhaseId = String(meta.phase_id || meta.phaseId || '').trim();
    if (
      this.currentPhase
      && this.currentPhase.phase_kind === phaseKind
      && (!explicitPhaseId || this.currentPhase.phase_id === explicitPhaseId)
    ) {
      return this.currentPhase;
    }
    if (this.currentPhase) {
      this.completeCurrentPhase({}, timestamp);
    }
    return this._openPhase(meta, timestamp);
  }

  notePhaseStarted(meta = {}, timestamp = new Date().toISOString()) {
    return this._ensurePhase(meta, timestamp);
  }

  completeCurrentPhase(meta = {}, timestamp = new Date().toISOString()) {
    if (!this.currentPhase) {
      return null;
    }
    this.currentPhase.completed_at = String(
      meta.completed_at || meta.completedAt || timestamp || this.currentPhase.completed_at || ''
    );
    applyPhaseTelemetry(this.currentPhase, meta);
    const completed = this.currentPhase;
    this.currentPhase = null;
    return completed;
  }

  notePhaseCompleted(meta = {}, timestamp = new Date().toISOString()) {
    const phaseId = String(meta.phase_id || meta.phaseId || '').trim();
    if (this.currentPhase && (!phaseId || this.currentPhase.phase_id === phaseId)) {
      return this.completeCurrentPhase(meta, timestamp);
    }
    if (!phaseId) {
      return null;
    }
    const existing = this.slice.phases.find((phase) => phase.phase_id === phaseId);
    if (!existing) {
      return null;
    }
    existing.completed_at = String(meta.completed_at || meta.completedAt || timestamp || existing.completed_at || '');
    applyPhaseTelemetry(existing, meta);
    return existing;
  }

  appendReasoningEntries(entries, meta = {}, options = {}) {
    const list = Array.isArray(entries) ? entries : [];
    if (!list.length) {
      return { protocolViolation: false, phase: this.currentPhase };
    }
    if (
      options.requirePhaseBoundary === true
      && this.turnHasVisibleText
      && this.currentPhase
      && this.currentPhase.phase_kind === 'text'
    ) {
      return { protocolViolation: true, phase: this.currentPhase };
    }
    const phase = this._ensurePhase(
      {
        phase_kind: 'reasoning',
        phase_id: meta.phase_id || meta.phaseId,
        iteration: meta.iteration,
        thinking_id: meta.thinking_id || meta.thinkingId,
        summary: meta.summary,
        tokens_per_second: meta.tokens_per_second ?? meta.tokensPerSecond,
      },
      meta.timestamp,
    );
    applyPhaseTelemetry(phase, meta);
    phase.entries = mergeReasoningEntryLists(phase.entries, list);
    return { protocolViolation: false, phase };
  }

  appendText(text, meta = {}) {
    const normalizedText = String(text || '');
    if (!normalizedText) {
      return null;
    }
    const phase = this._ensurePhase(
      {
        phase_kind: 'text',
        phase_id: meta.phase_id || meta.phaseId,
        iteration: meta.iteration,
      },
      meta.timestamp,
    );
    let segment = this.slice.visibleSegments[this.slice.visibleSegments.length - 1] || null;
    if (!segment || String(segment.phase_id || '') !== String(phase.phase_id || '')) {
      segment = {
        segment_id: this._nextSegmentId(),
        phase_id: String(phase.phase_id || ''),
        text: '',
      };
      this.slice.visibleSegments.push(segment);
    }
    segment.text += normalizedText;
    this.turnHasVisibleText = true;
    return segment;
  }

  replaceVisibleText(text) {
    const authoritativeText = String(text || '');
    const segments = this.slice.visibleSegments;
    if (!segments.length) {
      return this.appendText(authoritativeText, {});
    }
    let offset = 0;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const remaining = authoritativeText.slice(offset);
      const take = index === segments.length - 1
        ? remaining.length
        : Math.min(String(segment.text || '').length, remaining.length);
      segment.text = remaining.slice(0, take);
      offset += take;
    }
    const visibleSegments = segments.filter((segment) => String(segment.text || '').length > 0);
    const visiblePhaseIds = new Set(
      visibleSegments.map((segment) => String(segment.phase_id || '')).filter(Boolean)
    );
    this.slice.visibleSegments = visibleSegments;
    this.slice.phases = this.slice.phases.filter((phase) =>
      String(phase.phase_kind || '') !== 'text'
      || visiblePhaseIds.has(String(phase.phase_id || ''))
    );
    if (this.currentPhase && !this.slice.phases.includes(this.currentPhase)) {
      this.currentPhase = null;
    }
    this.turnHasVisibleText = visibleSegments.length > 0;
    return visibleSegments[visibleSegments.length - 1] || null;
  }

  noteToolStep({ callId, toolName, status, toolUseMessageId = '', toolResultMessageId = '' } = {}) {
    const normalizedCallId = String(callId || '').trim();
    if (!normalizedCallId) {
      return null;
    }
    const normalizedToolName = String(toolName || '').trim();
    const existing = this.slice.toolSteps.find((entry) => entry.call_id === normalizedCallId);
    const next = {
      call_id: normalizedCallId,
      tool_name: normalizedToolName,
      tool_use_message_id: String(toolUseMessageId || '').trim() || `tool_use_${normalizedCallId}`,
      tool_result_message_id: String(toolResultMessageId || '').trim() || `tool_result_${normalizedCallId}`,
      status: String(status || '').trim() || 'completed',
    };
    if (existing) {
      Object.assign(existing, next);
      return existing;
    }
    this.slice.toolSteps.push(next);
    return next;
  }

  buildAssistantMessageFields({ fallbackReasoningEntries = [] } = {}) {
    const phases = cloneValue(this.slice.phases);
    const visibleSegments = cloneValue(this.slice.visibleSegments);
    const toolSteps = cloneValue(this.slice.toolSteps);
    return {
      parent_stream_id: this.streamId,
      phases,
      visible_segments: visibleSegments,
      tool_steps: toolSteps,
      reasoning: buildReasoningPayloadFromPhases(phases, fallbackReasoningEntries),
      reasoning_phases: buildReasoningPhaseView(phases),
    };
  }

  resetSlice() {
    this.slice = this._createEmptySlice();
    this.currentPhase = null;
  }
}

module.exports = {
  TranscriptPhaseCollector,
  buildReasoningPayloadFromPhases,
  buildReasoningPhaseView,
  flattenReasoningEntriesFromPhases,
  normalizePhaseSummary,
};
