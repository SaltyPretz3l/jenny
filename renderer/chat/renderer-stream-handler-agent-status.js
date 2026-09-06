/* renderer/chat/renderer-stream-handler-agent-status.js -- pure agent-status + phase-summary normalization helpers (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-subagent-monitor-model'));
    return;
  }
  root.rendererStreamHandlerAgentStatus = factory(root.rendererSubagentMonitorModel || {});
})(typeof globalThis !== 'undefined' ? globalThis : this, function (subagentModel) {
  function resolveDependencyModule(globalName, modulePath) {
    if (typeof globalThis !== 'undefined' && globalThis[globalName]) {
      return globalThis[globalName];
    }
    if (typeof require === 'function') {
      try { return require(modulePath); } catch (_error) { /* unavailable in browser script mode */ }
    }
    return null;
  }

  const _stringUtils = resolveDependencyModule('stringUtils', '../shared/string-utils');
  if (!_stringUtils || typeof _stringUtils.normalizeString !== 'function') {
    throw new Error('string-utils must load before renderer/chat/renderer-stream-handler-agent-status.js');
  }
  const { normalizeString } = _stringUtils;

  const PHASE_SUMMARY_MAX_LENGTH = 240;
  const AGENT_STATUS_STEPS_MAX = 24;

  function normalizePhaseSummary(value) {
    const summary = normalizeString(value).replace(/\s+/g, ' ').trim();
    if (!summary) {
      return '';
    }
    if (summary.length <= PHASE_SUMMARY_MAX_LENGTH) {
      return summary;
    }
    return `${summary.slice(0, PHASE_SUMMARY_MAX_LENGTH - 3).trim()}...`;
  }

  function normalizeAgentStatusStep(next) {
    const stage = normalizeString(next?.stage) || 'working';
    const taskId = normalizeString(next?.taskId);
    const streamId = normalizeString(next?.streamId);
    const childTaskId = normalizeString(next?.childTaskId || next?.child_task_id);
    const childAgentId = normalizeString(next?.childAgentId || next?.child_agent_id);
    const key = childTaskId || childAgentId || `${taskId || streamId || ''}::${stage}`;
    const percentRaw = Number(next?.percent);
    const percent = Number.isFinite(percentRaw)
      ? Math.min(100, Math.max(0, Math.round(percentRaw)))
      : 0;
    return {
      key,
      stage,
      taskId,
      streamId,
      agentId: normalizeString(next?.agentId || next?.agent_id),
      parentAgentId: normalizeString(next?.parentAgentId || next?.parent_agent_id),
      toolCallId: normalizeString(next?.toolCallId || next?.tool_call_id),
      childTaskId,
      childAgentId,
      childOrdinal: Number.isSafeInteger(next?.childOrdinal) ? next.childOrdinal : null,
      childCount: Number.isSafeInteger(next?.childCount) ? next.childCount : null,
      childLabel: normalizeString(next?.childLabel || next?.child_label).slice(0, 80),
      childTerminal: next?.childTerminal === true || next?.child_terminal === true,
      childSuccess: next?.childSuccess === true || next?.child_success === true,
      model: normalizeString(next?.model).slice(0, 96),
      provider: normalizeString(next?.provider).slice(0, 96),
      usage: typeof subagentModel.normalizeUsage === 'function' ? subagentModel.normalizeUsage(next?.usage) : null,
      terminalReason: normalizeString(next?.terminalReason || next?.terminal_reason).slice(0, 64),
      taskType: normalizeString(next?.taskType),
      source: normalizeString(next?.source),
      status: normalizeString(next?.status),
      percent,
      summary: normalizeString(next?.summary),
      terminal: next?.terminal === true,
      success: next?.success === true,
      updatedAt: Number.isFinite(Number(next?.updatedAt)) ? Number(next.updatedAt) : Date.now(),
    };
  }

  function appendAgentStatusStep(existing, next) {
    const incoming = normalizeAgentStatusStep(next);
    const prior = Array.isArray(existing) ? existing.slice() : [];
    const idx = prior.findIndex((step) => step && step.key === incoming.key);
    if (idx !== -1) {
      const current = prior[idx];
      // Terminal steps are not overwritten by later non-terminal events (defensive).
      if ((current.terminal === true && incoming.terminal !== true)
        || (current.childTerminal === true && incoming.childTerminal !== true)) {
        return prior;
      }
      prior[idx] = {
        ...current,
        taskType: incoming.taskType || current.taskType,
        agentId: incoming.agentId || current.agentId,
        parentAgentId: incoming.parentAgentId || current.parentAgentId,
        toolCallId: incoming.toolCallId || current.toolCallId,
        childTaskId: incoming.childTaskId || current.childTaskId,
        childAgentId: incoming.childAgentId || current.childAgentId,
        childOrdinal: incoming.childOrdinal || current.childOrdinal,
        childCount: incoming.childCount || current.childCount,
        childLabel: incoming.childLabel || current.childLabel,
        childTerminal: incoming.childTerminal,
        childSuccess: incoming.childSuccess,
        model: incoming.model || current.model,
        provider: incoming.provider || current.provider,
        usage: incoming.usage || current.usage,
        terminalReason: incoming.terminalReason || current.terminalReason,
        source: incoming.source || current.source,
        status: incoming.status || current.status,
        percent: incoming.percent,
        summary: incoming.summary || current.summary,
        terminal: incoming.terminal,
        success: incoming.success,
        startedAt: current.status === 'queued' && incoming.status === 'running'
          ? incoming.updatedAt
          : current.startedAt,
        updatedAt: incoming.updatedAt,
      };
      return prior;
    }
    const startedAt = incoming.updatedAt;
    prior.push({ ...incoming, startedAt });
    if (prior.length > AGENT_STATUS_STEPS_MAX) {
      const dropIdx = prior.findIndex((step) => step && step.terminal !== true);
      if (dropIdx !== -1) {
        prior.splice(dropIdx, 1);
      } else {
        prior.shift();
      }
    }
    return prior;
  }

  return {
    PHASE_SUMMARY_MAX_LENGTH,
    AGENT_STATUS_STEPS_MAX,
    normalizePhaseSummary,
    normalizeAgentStatusStep,
    appendAgentStatusStep,
  };
});
