/* renderer/chat/renderer-timeline-v2-presentation.js - Shared Timeline V2 row summaries. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./tool-call-utils'), require('./renderer-stream-terminal-state'));
    return;
  }
  root.rendererTimelineV2Presentation = factory(root.toolCallUtils, root.rendererStreamTerminalState || {});
})(typeof globalThis !== 'undefined' ? globalThis : this, function (toolCallUtilsModule, terminalStateUtils) {
  'use strict';

  const formatToolCallSummary = toolCallUtilsModule.formatToolCallSummary;

  const SURFACE_CAPS = Object.freeze({
    transcript: 160,
    deck: 140,
  });

  /* Tone buckets drive the visual tone attribute. Lifecycle classifiers (below) drive
     row-collection decisions. Membership overlaps but the two serve different jobs and
     should not be merged. */
  const ACTIVE_STATES = new Set(['active', 'approved', 'requested', 'running', 'streaming']);
  const WARNING_STATES = new Set(['awaiting_approval', 'blocked', 'pending', 'pending_approval', 'queued', 'waiting']);
  const SUCCESS_STATES = new Set(['complete', 'completed', 'resolved', 'success', 'succeeded']);
  const DANGER_STATES = new Set([
    'cancelled',
    'canceled',
    'denied',
    'error',
    'errored',
    'failed',
    'preempted',
    'timeout',
    'timed_out',
  ]);

  const terminalMatrix = terminalStateUtils.TERMINAL_PRESENTATION_MATRIX || {};
  const TERMINAL_STATES = new Set([
    ...Object.keys(terminalMatrix),
    ...Object.values(terminalMatrix).map((presentation) => presentation.status),
    'done', 'failed', 'canceled',
  ]);
  const resolveKnownTerminalPresentation = terminalStateUtils.resolveTerminalPresentationIfTerminal;
  const RUNNING_TOOL_STATES = new Set(['running', 'requested', 'approved']);
  const APPROVAL_STATES = new Set(['awaiting_approval', 'pending_approval', 'pending']);

  function normalizeString(value) {
    return String(value == null ? '' : value).trim();
  }

  function normalizeKey(value) {
    return normalizeString(value).toLowerCase();
  }

  function isPendingApprovalState(value) {
    return APPROVAL_STATES.has(normalizeKey(value));
  }

  function terminalPhaseForStatus(value) {
    return typeof terminalStateUtils.terminalPhaseForStatus === 'function'
      ? terminalStateUtils.terminalPhaseForStatus(value)
      : '';
  }

  function compactText(value, maxLength = SURFACE_CAPS.transcript) {
    const text = normalizeString(value).replace(/\s+/g, ' ');
    const limit = Number(maxLength);
    const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : SURFACE_CAPS.transcript;
    if (!text || text.length <= cap) {
      return text;
    }
    if (cap <= 3) {
      return '.'.repeat(cap);
    }
    return `${text.slice(0, cap - 3).trimEnd()}...`;
  }

  function readPayload(input) {
    return input && input.payload && typeof input.payload === 'object' ? input.payload : {};
  }

  function readFirstString(...values) {
    for (const value of values) {
      const normalized = normalizeString(value);
      if (normalized) {
        return normalized;
      }
    }
    return '';
  }

  function readKind(input) {
    return normalizeKey(input && input.kind) || 'unknown';
  }

  function surfaceCap(surface) {
    const key = normalizeKey(surface) || 'transcript';
    return SURFACE_CAPS[key] || SURFACE_CAPS.transcript;
  }

  function toolNameLabel(value) {
    const raw = normalizeString(value);
    if (!raw) {
      return 'Tool';
    }
    return raw
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function phaseLabel(key) {
    const normalized = normalizeKey(key);
    const terminalPresentation = resolveKnownTerminalPresentation?.(normalized);
    if (terminalPresentation) return terminalPresentation.label;
    const terminalPhase = terminalPhaseForStatus(normalized);
    if (normalized === 'approval_wait') return 'Approval Needed';
    if (normalized === 'tool_use' || normalized === 'running_tool') return 'Using Tools';
    if (normalized === 'tool_result') return 'Reading Results';
    if (normalized === 'text' || normalized === 'final_answer') return 'Writing';
    if (terminalPhase === 'completed') return 'Complete';
    if (terminalPhase === 'error') return 'Needs Recovery';
    if (terminalPhase === 'cancelled') return 'Cancelled';
    if (terminalPhase === 'interrupted') return 'Interrupted';
    return 'Thinking';
  }

  function presenceForPhase(key) {
    const normalized = normalizeKey(key);
    const terminalPresentation = resolveKnownTerminalPresentation?.(normalized);
    if (terminalPresentation) return terminalPresentation.presenceState;
    const terminalPhase = terminalPhaseForStatus(normalized);
    if (normalized === 'approval_wait') return 'needs_approval';
    if (normalized === 'tool_use' || normalized === 'running_tool' || normalized === 'tool_result') return 'using_tools';
    if (normalized === 'text' || normalized === 'final_answer') return 'responding';
    if (terminalPhase === 'completed') return 'complete';
    if (terminalPhase === 'error') return 'recovery';
    if (terminalPhase === 'cancelled' || terminalPhase === 'interrupted') return terminalPhase;
    return 'thinking';
  }

  function normalizeArtifact(candidate) {
    const artifactId = readFirstString(candidate?.artifact_id, candidate?.artifactId, candidate?.id);
    if (!artifactId) {
      return null;
    }
    return {
      artifactId,
      title: readFirstString(candidate?.title, candidate?.file_name, candidate?.fileName, artifactId),
      status: readFirstString(candidate?.status, 'available') || 'available',
    };
  }

  function collectArtifacts(payload) {
    const source = Array.isArray(payload?.generated_artifacts)
      ? payload.generated_artifacts
      : (Array.isArray(payload?.generatedArtifacts) ? payload.generatedArtifacts : []);
    return source.map(normalizeArtifact).filter(Boolean);
  }

  function toneForState(state, fallbackTone) {
    const normalized = normalizeKey(state);
    const terminalPresentation = resolveKnownTerminalPresentation?.(normalized);
    if (terminalPresentation) return terminalPresentation.tone;
    if (DANGER_STATES.has(normalized)) return 'danger';
    if (WARNING_STATES.has(normalized)) return 'warning';
    if (SUCCESS_STATES.has(normalized)) return 'success';
    if (ACTIVE_STATES.has(normalized)) return 'active';
    return fallbackTone || 'neutral';
  }

  /* classifyStepLifecycle(row) -> 'done' | 'running' | 'pending' | 'error'. Drives the deck
     timeline's state-distinct node shape/color. Reads the row's normalized state first
     (authoritative), then falls back to its tone, then its kind. Pure: takes a presented row
     ({ kind, state, tone }), never the raw event. */
  function classifyStepLifecycle(row) {
    const safe = row && typeof row === 'object' ? row : {};
    const kind = normalizeKey(safe.kind);
    if (kind === 'overflow') {
      return 'pending';
    }
    const state = normalizeKey(safe.state);
    const tone = normalizeKey(safe.tone);
    const terminalPhase = terminalPhaseForStatus(state);
    if (terminalPhase === 'error' || tone === 'danger' || DANGER_STATES.has(state)) {
      return 'error';
    }
    if (terminalPhase === 'completed' || SUCCESS_STATES.has(state)) {
      return 'done';
    }
    if (RUNNING_TOOL_STATES.has(state) || ACTIVE_STATES.has(state)) {
      return 'running';
    }
    if (APPROVAL_STATES.has(state) || WARNING_STATES.has(state)) {
      return 'pending';
    }
    if (tone === 'success') {
      return 'done';
    }
    if (tone === 'active') {
      return 'running';
    }
    if (tone === 'warning') {
      return 'pending';
    }
    /* No decisive state/tone: the latest phase row is what Jenny is actively working. */
    if (kind === 'phase') {
      return 'running';
    }
    return 'pending';
  }

  function makeTarget(kind, callId, artifactId) {
    return {
      kind: normalizeKey(kind) || 'none',
      callId: normalizeString(callId),
      artifactId: normalizeString(artifactId),
    };
  }

  function makeAttrs(rowKind, tone, state, target) {
    const safeTarget = target && typeof target === 'object' ? target : makeTarget('none');
    return {
      rowKind: normalizeKey(rowKind) || 'unknown',
      tone: normalizeKey(tone) || 'neutral',
      state: normalizeKey(state),
      targetKind: normalizeKey(safeTarget.kind) || 'none',
    };
  }

  function finalizePresentation(kind, label, summary, tone, state, target) {
    const safeKind = normalizeKey(kind) || 'unknown';
    const safeTone = normalizeKey(tone) || 'neutral';
    const safeState = normalizeKey(state);
    const safeTarget = target && typeof target === 'object' ? target : makeTarget('none');
    return {
      kind: safeKind,
      label: normalizeString(label),
      summary: normalizeString(summary),
      tone: safeTone,
      state: safeState,
      target: safeTarget,
      attrs: makeAttrs(safeKind, safeTone, safeState, safeTarget),
    };
  }

  function emptyPresentation() {
    return finalizePresentation('unknown', '', '', 'neutral', '', makeTarget('none'));
  }

  function readToolCallId(input, payload) {
    return readFirstString(
      input?.tool_call_id,
      input?.toolCallId,
      input?.call_id,
      input?.callId,
      payload.tool_call_id,
      payload.toolCallId,
      payload.call_id,
      payload.callId
    );
  }

  function readToolName(input, payload) {
    return readFirstString(payload.tool_name, payload.toolName, input?.tool_name, input?.toolName);
  }

  function buildPhasePresentation(input, payload, cap) {
    const phaseKind = readFirstString(
      input?.phase_kind,
      input?.phaseKind,
      input?.key,
      payload.phase_kind,
      payload.phaseKind,
      'reasoning'
    );
    const state = normalizeKey(input?.state || input?.status || payload.state || payload.status);
    const tone = toneForState(state, payload.completed === true || input?.completed === true ? 'success' : 'neutral');
    const target = makeTarget('phase', '', '');
    const kind = readKind(input);
    const label = phaseLabel(phaseKind);
    const summary = compactText(readFirstString(payload.summary, input?.summary, payload.label, input?.label, payload.title), cap);
    return finalizePresentation(kind, label, summary, tone, state, target);
  }

  function buildToolPresentation(input, payload, cap) {
    const state = normalizeKey(payload.state || payload.status || input?.state || input?.status || 'running');
    const callId = readToolCallId(input, payload);
    const toolName = readToolName(input, payload);
    const label = toolNameLabel(readFirstString(input?.label, toolName));
    const kind = readKind(input);
    const summary = compactText(readFirstString(
      payload.input_summary,
      payload.inputSummary,
      payload.summary,
      input?.summary,
      payload.prompt,
      label
    ), cap);
    const tone = toneForState(state, 'active');
    const target = makeTarget('tool', callId, '');
    return finalizePresentation(kind, label, summary, tone, state, target);
  }

  function buildResultPresentation(input, payload, cap) {
    const state = normalizeKey(payload.state || payload.status || input?.state || input?.status || 'completed');
    const callId = readToolCallId(input, payload);
    const toolName = readToolName(input, payload);
    const artifacts = collectArtifacts(payload);
    const firstArtifact = artifacts[0] || null;
    const label = toolNameLabel(readFirstString(input?.label, toolName));
    const summary = compactText(readFirstString(
      payload.result_summary,
      payload.resultSummary,
      payload.summary,
      input?.summary,
      payload.error_message,
      payload.errorMessage,
      firstArtifact?.title,
      label
    ), cap);
    const isError = payload.is_error === true
      || payload.isError === true
      || payload.result_is_error === true
      || payload.resultIsError === true;
    const tone = isError ? 'danger' : toneForState(state, 'success');
    const kind = readKind(input);
    const target = makeTarget('tool', callId, firstArtifact?.artifactId || '');
    return finalizePresentation(kind, label, summary, tone, state, target);
  }

  function buildApprovalPresentation(input, payload, cap) {
    const state = normalizeKey(payload.state || payload.status || input?.state || input?.status || 'awaiting_approval');
    const callId = readToolCallId(input, payload);
    const toolName = readToolName(input, payload);
    const label = toolNameLabel(readFirstString(input?.label, toolName));
    const summary = compactText(readFirstString(payload.prompt, payload.summary, input?.summary, 'Waiting for approval'), cap);
    const resolvedTone = toneForState(state, 'warning');
    const tone = resolvedTone === 'neutral' ? 'warning' : resolvedTone;
    const kind = readKind(input);
    const target = makeTarget('approval', callId, '');
    return finalizePresentation(kind, label, summary, tone, state, target);
  }

  function buildArtifactPresentation(input, payload, cap) {
    const artifactId = readFirstString(input?.artifactId, input?.artifact_id, payload.artifact_id, payload.artifactId, input?.key);
    const title = readFirstString(input?.title, input?.label, payload.title, payload.file_name, payload.fileName, artifactId);
    const state = normalizeKey(input?.state || payload.state || payload.status || 'available');
    const tone = toneForState(state, 'success');
    const kind = readKind(input);
    const target = makeTarget('artifact', '', artifactId);
    return finalizePresentation(
      kind,
      title,
      compactText(readFirstString(input?.summary, payload.summary, state, title), cap),
      tone,
      state,
      target
    );
  }

  function buildTimelineV2Presentation(input, options = {}) {
    if (!input || typeof input !== 'object') {
      return emptyPresentation();
    }
    const payload = readPayload(input);
    const cap = surfaceCap(options.surface);
    const kind = readKind(input);
    if (kind === 'reasoning' || kind === 'phase') {
      return buildPhasePresentation(input, payload, cap);
    }
    if (kind === 'tool_call' || kind === 'tool_step' || kind === 'tool' || kind === 'tool_use') {
      return buildToolPresentation(input, payload, cap);
    }
    if (kind === 'tool_result') {
      return buildResultPresentation(input, payload, cap);
    }
    if (kind === 'approval_gap' || kind === 'approval') {
      return buildApprovalPresentation(input, payload, cap);
    }
    if (kind === 'artifact') {
      return buildArtifactPresentation(input, payload, cap);
    }
    const state = normalizeKey(input.state || input.status || payload.state || payload.status);
    const tone = toneForState(state, 'neutral');
    const target = makeTarget('none');
    return finalizePresentation(
      kind,
      compactText(readFirstString(input.label, payload.label), cap),
      compactText(readFirstString(input.summary, payload.summary, input.text, payload.text), cap),
      tone,
      state,
      target
    );
  }

  /* A2: rich one-liner ("Search web for X" / "Fetch <url>") from a tool row's captured input. Empty when
     there is no input or the builder is unavailable; callers then fall back to backend summaries / name. */
  function deckToolSummary(payload, toolName) {
    const source = payload && typeof payload === 'object' ? payload : {};
    const input = source.input && typeof source.input === 'object' && !Array.isArray(source.input) ? source.input : null;
    if (!input || !Object.keys(input).length) {
      return '';
    }
    return normalizeString(formatToolCallSummary(toolName, input));
  }

  /* A3: a settled tool exists as TWO terminal rows (the tool_call row + its paired tool_result row, both
     reconciled to the terminal state). Collapse first-wins by call id so the deck shows one entry per
     call — the earlier tool_call row wins, preserving its input-derived summary. */
  function dedupeTerminalToolsByCallId(tools) {
    const list = Array.isArray(tools) ? tools : [];
    const seen = new Set();
    const out = [];
    for (const tool of list) {
      const callId = normalizeString(tool && tool.callId);
      if (callId && seen.has(callId)) {
        continue;
      }
      if (callId) {
        seen.add(callId);
      }
      out.push(tool);
    }
    return out;
  }

  return {
    deckToolSummary,
    dedupeTerminalToolsByCallId,
    TERMINAL_STATES,
    RUNNING_TOOL_STATES,
    APPROVAL_STATES,
    isPendingApprovalState,
    terminalPhaseForStatus,
    classifyStepLifecycle,
    buildTimelineV2Presentation,
    compactText,
    phaseLabel,
    presenceForPhase,
    resolveTerminalPresentation: terminalStateUtils.resolveTerminalPresentation,
    resolveTerminalPresentationIfTerminal: resolveKnownTerminalPresentation,
    toolNameLabel,
  };
});
