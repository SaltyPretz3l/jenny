/* renderer/chat/renderer-turn-phase-model.js - Shared turn phase and terminal derivation. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-timeline-v2-presentation'));
    return;
  }
  root.rendererTurnPhaseModel = factory(root.rendererTimelineV2Presentation || {});
})(typeof globalThis !== 'undefined' ? globalThis : this, function (timelineV2Presentation) {
  'use strict';

  const presentationUtils = timelineV2Presentation && typeof timelineV2Presentation === 'object'
    ? timelineV2Presentation
    : {};
  const deckToolSummary = typeof presentationUtils.deckToolSummary === 'function' ? presentationUtils.deckToolSummary : (() => '');
  const RUNNING_TOOL_STATES = presentationUtils.RUNNING_TOOL_STATES instanceof Set
    ? presentationUtils.RUNNING_TOOL_STATES
    : new Set(['running', 'requested', 'approved']);
  const APPROVAL_STATES = presentationUtils.APPROVAL_STATES instanceof Set
    ? presentationUtils.APPROVAL_STATES
    : new Set(['awaiting_approval', 'pending_approval', 'pending']);
  const ROW_DERIVED_TERMINAL_STATES = new Set([
    'cancelled',
    'canceled',
    'denied',
    'interrupted',
    'preempted',
    'timeout',
    'timed_out',
    'unknown',
  ]);

  function normalizeString(value) {
    return String(value == null ? '' : value).trim();
  }

  function normalizeKey(value) {
    return normalizeString(value).toLowerCase();
  }

  const isPendingApprovalState = typeof presentationUtils.isPendingApprovalState === 'function'
    ? presentationUtils.isPendingApprovalState
    : function fallbackIsPendingApprovalState(value) {
      return APPROVAL_STATES.has(normalizeKey(value));
    };
  const terminalPhaseForStatus = typeof presentationUtils.terminalPhaseForStatus === 'function'
    ? presentationUtils.terminalPhaseForStatus
    : function fallbackTerminalPhaseForStatus(value) {
      const normalized = normalizeKey(value);
      if (normalized === 'completed' || normalized === 'complete' || normalized === 'done') return 'completed';
      if (normalized === 'error' || normalized === 'errored' || normalized === 'failed' || normalized === 'timeout' || normalized === 'timed_out' || normalized === 'preempted' || normalized === 'denied') return 'error';
      if (normalized === 'cancelled' || normalized === 'canceled') return 'cancelled';
      if (normalized === 'interrupted') return 'interrupted';
      return '';
    };
  const resolveTerminalPresentationIfTerminal = typeof presentationUtils.resolveTerminalPresentationIfTerminal === 'function'
    ? presentationUtils.resolveTerminalPresentationIfTerminal
    : (() => null);
  const resolveTerminalPresentation = typeof presentationUtils.resolveTerminalPresentation === 'function'
    ? presentationUtils.resolveTerminalPresentation
    : () => ({ status: 'errored', summary: 'The turn needs recovery.' });
  const compactText = typeof presentationUtils.compactText === 'function'
    ? presentationUtils.compactText
    : function fallbackCompactText(value, maxLength = 160) {
    const text = normalizeString(value).replace(/\s+/g, ' ');
    if (!text || text.length <= maxLength) {
      return text;
    }
    if (maxLength <= 3) {
      return '.'.repeat(Math.max(0, maxLength));
    }
    return `${text.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
  };
  const toolNameLabel = typeof presentationUtils.toolNameLabel === 'function'
    ? presentationUtils.toolNameLabel
    : function fallbackToolNameLabel(value) {
    const raw = normalizeString(value);
    if (!raw) {
      return 'Tool';
    }
    return raw
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  };

  function readPayload(row) {
    return row && row.payload && typeof row.payload === 'object' ? row.payload : {};
  }

  function readRows(activeTurn) {
    return Array.isArray(activeTurn?.rows) ? activeTurn.rows : [];
  }

  function readEvents(activeTurn) {
    return Array.isArray(activeTurn?.events) ? activeTurn.events : [];
  }

  function normalizeArtifact(candidate) {
    const artifactId = normalizeString(candidate?.artifact_id || candidate?.artifactId || candidate?.id);
    if (!artifactId) {
      return null;
    }
    return {
      artifactId,
      title: normalizeString(candidate?.title || candidate?.file_name || candidate?.fileName || artifactId),
      status: normalizeString(candidate?.status || 'available') || 'available',
    };
  }

  function collectArtifactsFromPayload(payload) {
    const list = Array.isArray(payload?.generated_artifacts)
      ? payload.generated_artifacts
      : (Array.isArray(payload?.generatedArtifacts) ? payload.generatedArtifacts : []);
    return list.map(normalizeArtifact).filter(Boolean);
  }

  function payloadHasResultError(payload) {
    return Boolean(
      payload
      && (
        payload.is_error === true
        || payload.isError === true
        || payload.result_is_error === true
        || payload.resultIsError === true
      )
    );
  }

  function fallbackToolResultState(payload) {
    const approvalState = normalizeKey(payload?.approval_state || payload?.approvalState);
    const approvalPhase = terminalPhaseForStatus(approvalState);
    if (approvalPhase && approvalPhase !== 'completed') {
      return approvalState;
    }
    return payloadHasResultError(payload) ? 'errored' : 'completed';
  }

  function normalizeToolRow(row) {
    const payload = readPayload(row);
    const kind = normalizeKey(row?.kind);
    const callId = normalizeString(row?.tool_call_id || payload.tool_call_id || payload.call_id || payload.callId);
    const toolName = normalizeString(payload.tool_name || payload.toolName || row?.tool_name);
    let state = normalizeKey(payload.state || row?.state || row?.status);
    if (!state && kind === 'tool_result') {
      state = fallbackToolResultState(payload);
    }
    const summary = compactText(deckToolSummary(payload, toolName) || payload.summary || payload.result_summary || payload.input_summary || payload.prompt || toolNameLabel(toolName));
    return {
      callId,
      toolName,
      label: toolNameLabel(toolName),
      state: state || 'running',
      summary,
      artifacts: collectArtifactsFromPayload(payload),
    };
  }

  function collectTerminalToolCallIds(rows) {
    const terminalToolCallIds = new Set();
    const list = Array.isArray(rows) ? rows : [];
    for (const row of list) {
      const kind = normalizeKey(row?.kind);
      if (kind !== 'tool_step' && kind !== 'tool_call' && kind !== 'tool_result' && kind !== 'tool_use') {
        continue;
      }
      const tool = normalizeToolRow(row);
      if (!tool.callId) {
        continue;
      }
      const terminalPhase = terminalPhaseForStatus(tool.state);
      if (terminalPhase) {
        terminalToolCallIds.add(tool.callId);
      }
    }
    return terminalToolCallIds;
  }

  function normalizeApprovalRow(row) {
    const payload = readPayload(row);
    const callId = normalizeString(row?.tool_call_id || payload.tool_call_id || payload.call_id || payload.callId);
    const toolName = normalizeString(payload.tool_name || payload.toolName || row?.tool_name);
    const prompt = compactText(payload.prompt || payload.summary || 'Waiting for approval');
    return {
      callId,
      toolName,
      label: toolNameLabel(toolName),
      prompt,
      state: normalizeKey(payload.state || row?.state || row?.status) || 'awaiting_approval',
      requestedAt: Number(payload.approval_requested_at_ms) || Number(payload.requested_at_ms) || null,
    };
  }

  function normalizePhaseFromRow(row) {
    const payload = readPayload(row);
    const phase = payload.phase && typeof payload.phase === 'object' && !Array.isArray(payload.phase)
      ? payload.phase
      : {};
    const phaseKind = normalizeKey(
      phase.phase_kind
      || phase.phaseKind
      || payload.phase_kind
      || payload.phaseKind
      || row?.phase_kind
      || row?.phaseKind
    );
    const phaseId = normalizeString(
      phase.phase_id
      || phase.phaseId
      || payload.phase_id
      || payload.phaseId
      || row?.phase_id
      || row?.phaseId
    );
    const summary = compactText(phase.summary || payload.summary || payload.label || payload.title || '');
    if (!phaseKind && !phaseId && !summary) {
      return null;
    }
    return {
      phaseId,
      kind: phaseKind || 'reasoning',
      summary,
      completed: payload.completed === true || row?.status === 'completed',
    };
  }

  function normalizePhaseFromEvent(event) {
    if (!event || event.kind !== 'reasoning_phase') {
      return null;
    }
    return normalizePhaseFromRow(event);
  }

  function mergePhase(phases, phaseIndexById, phase) {
    if (!phase) {
      return;
    }
    const phaseId = normalizeString(phase.phaseId);
    if (!phaseId || !phaseIndexById.has(phaseId)) {
      if (phaseId) {
        phaseIndexById.set(phaseId, phases.length);
      }
      phases.push(phase);
      return;
    }
    const existing = phases[phaseIndexById.get(phaseId)];
    phases[phaseIndexById.get(phaseId)] = {
      phaseId,
      kind: phase.kind || existing.kind,
      summary: phase.summary || existing.summary,
      completed: existing.completed === true || phase.completed === true,
    };
  }

  function defaultTerminalSummary(status) {
    return resolveTerminalPresentationIfTerminal(status)?.summary || '';
  }

  function deriveTerminalFromRows(rows) {
    const list = Array.isArray(rows) ? rows : [];
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const row = list[index];
      const payload = readPayload(row);
      const state = normalizeKey(payload.state || payload.status || row?.state || row?.status);
      if (!ROW_DERIVED_TERMINAL_STATES.has(state)) {
        continue;
      }
      const terminalPresentation = resolveTerminalPresentationIfTerminal(state);
      if (!terminalPresentation || terminalPresentation.phase === 'completed') {
        continue;
      }
      const summary = compactText(
        payload.result_summary
        || payload.summary
        || payload.prompt
        || payload.error_message
        || payload.errorMessage
        || defaultTerminalSummary(state)
      );
      return {
        kind: terminalPresentation.status,
        summary,
      };
    }
    return { kind: '', summary: '' };
  }

  function buildTerminal(activeTurn, rows) {
    const status = normalizeKey(activeTurn?.status || activeTurn?.state);
    const terminalPresentation = resolveTerminalPresentationIfTerminal(status);
    if (!terminalPresentation) {
      const rowTerminal = deriveTerminalFromRows(rows);
      if (rowTerminal.kind) {
        return rowTerminal;
      }
      const errorRow = rows.find((row) => normalizeKey(row?.kind) === 'system_notice' && normalizeKey(readPayload(row).subkind) === 'assistant_error');
      if (!errorRow) {
        return { kind: '', summary: '' };
      }
      return { kind: resolveTerminalPresentationIfTerminal('error').status, summary: compactText(readPayload(errorRow).stream_error || readPayload(errorRow).summary || 'The turn needs recovery.') };
    }
    return {
      kind: terminalPresentation.status,
      summary: terminalPresentation.phase === 'completed' ? '' : compactText(activeTurn?.error || activeTurn?.message || ''),
    };
  }

  function latestAssistantText(rows) {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      if (normalizeKey(row?.kind) !== 'assistant_text') {
        continue;
      }
      const text = compactText(readPayload(row).text || row.text || '');
      if (text) {
        return text;
      }
    }
    return '';
  }

  function summarizeArtifacts(artifacts) {
    const list = Array.isArray(artifacts) ? artifacts : [];
    const timelineArtifacts = [];
    const seenTimelineIds = new Set();
    const seenCountIds = new Set();
    for (const artifact of list) {
      const artifactId = normalizeString(artifact?.artifactId);
      if (artifactId) {
        seenCountIds.add(artifactId);
      }
      if (seenTimelineIds.has(artifactId)) {
        continue;
      }
      seenTimelineIds.add(artifactId);
      timelineArtifacts.push(artifact);
    }
    return {
      timelineArtifacts,
      count: seenCountIds.size || list.length,
    };
  }

  function collectModelParts(activeTurn, featureFlags = {}) {
    const rows = readRows(activeTurn);
    const events = readEvents(activeTurn);
    const phases = [];
    const phaseIndexById = new Map();
    const runningTools = [];
    const terminalTools = [];
    const approvalBlockers = [];
    const settledApprovals = [];
    const artifacts = [];
    const terminalToolCallIds = collectTerminalToolCallIds(rows);

    for (const row of rows) {
      const kind = normalizeKey(row?.kind);
      const payload = readPayload(row);
      if (kind === 'reasoning') {
        mergePhase(phases, phaseIndexById, normalizePhaseFromRow(row));
      }
      const approvalState = normalizeKey(payload.state || row?.state || row?.status);
      if (kind === 'approval_gap') {
        if (!approvalState || isPendingApprovalState(approvalState)) {
          approvalBlockers.push(normalizeApprovalRow(row));
        } else {
          settledApprovals.push(normalizeApprovalRow(row));
        }
      } else if (isPendingApprovalState(approvalState)) {
        approvalBlockers.push(normalizeApprovalRow(row));
      }
      if (kind === 'tool_step' || kind === 'tool_call' || kind === 'tool_result' || kind === 'tool_use') {
        const tool = normalizeToolRow(row);
        if (RUNNING_TOOL_STATES.has(tool.state)) {
          if (!tool.callId || !terminalToolCallIds.has(tool.callId)) {
            runningTools.push(tool);
          }
        } else if (terminalPhaseForStatus(tool.state) && !(tool.artifacts.length && terminalPhaseForStatus(tool.state) === 'completed')) {
          terminalTools.push(tool); // Completed tools that emitted an artifact are represented by the artifact row to avoid duplication.
        }
        for (const artifact of tool.artifacts) {
          artifacts.push(artifact);
        }
      } else {
        for (const artifact of collectArtifactsFromPayload(payload)) {
          artifacts.push(artifact);
        }
      }
    }

    if (featureFlags.stream_envelope_v2 !== true) {
      for (const event of events) {
        const phase = normalizePhaseFromEvent(event);
        const phaseId = normalizeString(phase?.phaseId);
        if (phases.length === 0 || (phaseId && phaseIndexById.has(phaseId))) {
          mergePhase(phases, phaseIndexById, phase);
        }
      }
    }

    return {
      rows,
      events,
      phases,
      runningTools,
      terminalTools,
      approvalBlockers,
      settledApprovals,
      artifacts,
      artifactSummary: summarizeArtifacts(artifacts),
    };
  }

  function resolvePhaseKey(parts, terminal) {
    const terminalPhase = terminalPhaseForStatus(terminal.kind);
    if (terminalPhase) return terminalPhase;
    if (parts.approvalBlockers.length) return 'approval_wait';
    if (parts.runningTools.length) return 'tool_use';
    const latestPhase = parts.phases[parts.phases.length - 1];
    if (latestPhase?.kind) return latestPhase.kind;
    if (latestAssistantText(parts.rows)) return 'text';
    return 'reasoning';
  }

  /* Hydrated turn-level error notices remain authoritative. Otherwise the preserved live terminal
     hint prevents unknown outcomes from becoming completed when reconciliation replaces live rows. */
  function deriveReconciledTurnStatus(rows, statusHint = '') {
    const list = Array.isArray(rows) ? rows : [];
    for (const row of list) {
      if (String((row && row.kind) || '').trim().toLowerCase() !== 'system_notice') {
        continue;
      }
      const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
      if (String(payload.subkind || '').trim().toLowerCase() !== 'assistant_error') {
        continue;
      }
      const terminal = resolveTerminalPresentation(
        payload.terminal_status || payload.terminalStatus || payload.recovery_class,
        { fallbackStatus: 'error' }
      );
      return { status: terminal.status, error: String(payload.stream_error || payload.summary || terminal.summary).trim() };
    }
    const hintedTerminal = statusHint ? resolveTerminalPresentation(statusHint) : null;
    if (hintedTerminal) {
      return {
        status: hintedTerminal.status,
        error: hintedTerminal.phase === 'completed' ? '' : hintedTerminal.summary,
      };
    }
    return { status: 'completed', error: '' };
  }

  function selectActiveTurnFromLiveState(liveState) {
    if (!liveState || typeof liveState !== 'object') {
      return null;
    }
    const activeTurnId = normalizeString(liveState.active_turn_id || liveState.activeTurnId);
    const liveTurns = liveState.turns_by_id && typeof liveState.turns_by_id === 'object'
      ? liveState.turns_by_id
      : {};
    if (activeTurnId && liveTurns[activeTurnId]) {
      return liveTurns[activeTurnId];
    }
    const liveKeys = Object.keys(liveTurns);
    if (liveKeys.length) {
      return liveTurns[liveKeys[liveKeys.length - 1]];
    }
    const reconciled = liveState.reconciled_rows_by_turn_id && typeof liveState.reconciled_rows_by_turn_id === 'object'
      ? liveState.reconciled_rows_by_turn_id
      : {};
    const reconciledKeys = Object.keys(reconciled);
    if (!reconciledKeys.length) {
      return null;
    }
    const entry = reconciled[reconciledKeys[reconciledKeys.length - 1]];
    if (!entry?.turn) {
      return null;
    }
    /* Prefer a terminal status preserved from the live reducer, then derive from hydrated rows. */
    const reconciledRows = Array.isArray(entry.rows) ? entry.rows : entry.turn.rows;
    const settled = deriveReconciledTurnStatus(reconciledRows, entry.turn.status);
    return { ...entry.turn, rows: reconciledRows, status: settled.status, ...(settled.error ? { error: settled.error } : {}) };
  }

  return {
    APPROVAL_STATES,
    ROW_DERIVED_TERMINAL_STATES,
    RUNNING_TOOL_STATES,
    buildTerminal,
    collectArtifactsFromPayload,
    collectModelParts,
    collectTerminalToolCallIds,
    deriveReconciledTurnStatus,
    deriveTerminalFromRows,
    fallbackToolResultState,
    latestAssistantText,
    mergePhase,
    normalizeApprovalRow,
    normalizeArtifact,
    normalizeKey,
    normalizePhaseFromEvent,
    normalizePhaseFromRow,
    normalizeString,
    normalizeToolRow,
    payloadHasResultError,
    readEvents,
    readPayload,
    readRows,
    resolvePhaseKey,
    selectActiveTurnFromLiveState,
    summarizeArtifacts,
    terminalPhaseForStatus,
  };
});
