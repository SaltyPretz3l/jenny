(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSubagentMonitorModel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TERMINAL = new Set([
    'completed', 'partial', 'failed', 'cancelled', 'rejected', 'skipped_budget',
  ]);

  function normalizeText(value, max = 1000) {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
  }

  function normalizeUsage(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const usage = {};
    for (const key of [
      'input_tokens', 'output_tokens', 'total_tokens', 'last_request_input_tokens',
      'context_tokens_estimate', 'context_window', 'compact_threshold_tokens',
    ]) {
      if (Number.isSafeInteger(value[key]) && value[key] >= 0) usage[key] = value[key];
    }
    const provider = normalizeText(value.provider, 96);
    const model = normalizeText(value.model, 96);
    if (provider) usage.provider = provider;
    if (model) usage.model = model;
    if (!Object.keys(usage).length) return null;
    usage.estimated = value.estimated === true;
    return usage;
  }

  function terminalCopy(reason, status) {
    const copy = {
      deadline_exceeded: 'Ran out of time',
      budget_exhausted: 'Reached its work limit',
      max_iterations_summary: 'Reached its work limit',
      capacity_unavailable: 'Did not start — no subagent slot was available',
      cancelled: 'Cancelled',
      invalid_report: 'Finished, but the result could not be validated',
      runtime_unavailable: 'Could not start the subagent runtime',
      rejected: 'Could not start',
    };
    if (copy[reason]) return copy[reason];
    if (status === 'completed') return 'Completed';
    if (status === 'partial') return 'Partially completed';
    if (status === 'cancelled') return 'Cancelled';
    if (status === 'rejected') return 'Could not start';
    if (status === 'skipped_budget') return 'Reached its work limit';
    if (status === 'failed') return 'Failed';
    if (status === 'queued') return 'Queued';
    return 'Running';
  }

  function toneForStatus(status) {
    if (status === 'completed') return 'success';
    if (status === 'failed') return 'danger';
    if (status === 'partial' || status === 'skipped_budget') return 'warning';
    if (status === 'cancelled' || status === 'rejected' || status === 'queued') return 'muted';
    return 'pending';
  }

  function normalizeEvidence(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 12).map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      const result = {};
      for (const key of [
        'source', 'source_tool', 'summary', 'quote', 'relative_path', 'fact', 'value',
      ]) {
        const text = normalizeText(entry[key], 300);
        if (text) result[key] = text;
      }
      if (Number.isSafeInteger(entry.line_start) && entry.line_start > 0) {
        result.line_start = entry.line_start;
        result.line_end = Number.isSafeInteger(entry.line_end) && entry.line_end >= entry.line_start
          ? entry.line_end
          : entry.line_start;
      }
      if (entry.provenance === 'tool_observed') result.provenance = 'tool_observed';
      return Object.keys(result).length ? result : null;
    }).filter(Boolean);
  }

  function childFromReport(value, index) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const status = normalizeText(source.status, 40).toLowerCase() || 'failed';
    const reason = normalizeText(source.terminal_reason, 64).toLowerCase();
    return {
      key: normalizeText(source.task_id || source.agent_id, 200) || `child-${index + 1}`,
      taskId: normalizeText(source.task_id, 200),
      agentId: normalizeText(source.agent_id, 200),
      parentAgentId: normalizeText(source.parent_agent_id, 200),
      ordinal: Number.isSafeInteger(source.ordinal) ? source.ordinal : index + 1,
      label: normalizeText(source.label, 80) || `Research task ${index + 1}`,
      status,
      terminal: TERMINAL.has(status),
      success: status === 'completed',
      summary: normalizeText(source.summary, 1000) || 'Details unavailable.',
      evidence: normalizeEvidence(source.evidence),
      tools: Array.isArray(source.tools_used) ? source.tools_used.map((item) => normalizeText(item, 64)).filter(Boolean).slice(0, 20) : [],
      uncertainties: Array.isArray(source.uncertainties) ? source.uncertainties.map((item) => normalizeText(item, 300)).filter(Boolean).slice(0, 8) : [],
      usage: normalizeUsage(source.usage),
      budget: source.budget && typeof source.budget === 'object' ? { ...source.budget } : {},
      error: source.error && typeof source.error === 'object' ? { ...source.error } : null,
      terminalReason: reason,
      terminalCopy: terminalCopy(reason, status),
      tone: toneForStatus(status),
      authoritative: true,
    };
  }

  function childFromStep(value, index) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const status = normalizeText(source.status, 40).toLowerCase() || 'running';
    const reason = normalizeText(source.terminalReason || source.terminal_reason, 64).toLowerCase();
    const taskId = normalizeText(source.childTaskId || source.child_task_id || source.taskId || source.task_id, 200);
    const agentId = normalizeText(source.childAgentId || source.child_agent_id || source.agentId || source.agent_id, 200);
    const startedAt = Number.isFinite(Number(source.startedAt)) ? Number(source.startedAt) : 0;
    const updatedAt = Number.isFinite(Number(source.updatedAt)) ? Number(source.updatedAt) : startedAt;
    return {
      key: taskId || agentId || `child-${index + 1}`,
      toolCallId: normalizeText(source.toolCallId || source.tool_call_id, 200),
      taskId,
      agentId,
      parentAgentId: normalizeText(source.parentAgentId || source.parent_agent_id, 200),
      ordinal: Number.isSafeInteger(source.childOrdinal) ? source.childOrdinal : index + 1,
      count: Number.isSafeInteger(source.childCount) ? source.childCount : null,
      label: normalizeText(source.childLabel || source.child_label, 80) || 'Research subagent',
      status,
      stage: normalizeText(source.stage, 80),
      terminal: source.childTerminal === true || source.terminal === true || TERMINAL.has(status),
      success: source.childSuccess === true || source.success === true,
      summary: normalizeText(source.summary, 240) || 'Working on it.',
      evidence: [], tools: [], uncertainties: [],
      usage: normalizeUsage(source.usage),
      budget: {}, error: null,
      model: normalizeText(source.model, 96),
      provider: normalizeText(source.provider, 96),
      terminalReason: reason,
      terminalCopy: terminalCopy(reason, status),
      tone: toneForStatus(status),
      startedAt,
      updatedAt,
      authoritative: false,
    };
  }

  function extractTerminalReport(metadata) {
    const source = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
    if (source.subagent_batch_report && typeof source.subagent_batch_report === 'object') {
      return { kind: 'batch', report: source.subagent_batch_report };
    }
    if (source.subagent_report && typeof source.subagent_report === 'object') {
      return { kind: 'single', report: source.subagent_report };
    }
    return null;
  }

  function selectLiveDelegationSteps(value) {
    const steps = Array.isArray(value) ? value : [];
    const groups = new Map();
    steps.forEach((step, index) => {
      const source = step && typeof step === 'object' ? step : {};
      const toolCallId = normalizeText(source.toolCallId || source.tool_call_id, 200);
      const key = toolCallId || '__legacy_delegate__';
      const timestamp = Number(
        source.updatedAt ?? source.updated_at ?? source.startedAt ?? source.started_at
      );
      const recency = Number.isFinite(timestamp) ? timestamp : index;
      const group = groups.get(key) || { steps: [], recency: -Infinity, order: index };
      group.steps.push(step);
      group.recency = Math.max(group.recency, recency);
      group.order = Math.max(group.order, index);
      groups.set(key, group);
    });
    const candidates = [...groups.values()].map((group) => ({
      ...group,
      terminal: buildMonitorViewModel({ steps: group.steps }).terminal,
    }));
    const active = candidates.filter((group) => !group.terminal);
    const pool = active.length ? active : candidates;
    pool.sort((left, right) => right.recency - left.recency || right.order - left.order);
    return pool[0]?.steps || [];
  }

  function buildMonitorViewModel(input = {}) {
    const steps = Array.isArray(input.steps) ? input.steps : [];
    const terminal = input.terminal && typeof input.terminal === 'object' ? input.terminal : null;
    const liveByKey = new Map();
    steps.forEach((step, index) => {
      const source = step && typeof step === 'object' ? step : {};
      const isBatchAggregate = ['subagent_batch', 'delegate'].includes(String(source.source || ''))
        && !normalizeText(source.childTaskId || source.child_task_id || source.childAgentId || source.child_agent_id, 200);
      if (isBatchAggregate) return;
      const child = childFromStep(step, index);
      const current = liveByKey.get(child.key);
      if (!current || child.updatedAt >= current.updatedAt) liveByKey.set(child.key, child);
    });
    let children = [...liveByKey.values()];
    let status = 'running';
    let usage = null;
    let authoritative = false;
    if (terminal?.kind === 'batch') {
      const tasks = Array.isArray(terminal.report.tasks) ? terminal.report.tasks : [];
      children = tasks.map(childFromReport);
      status = normalizeText(terminal.report.status, 40).toLowerCase() || 'failed';
      usage = normalizeUsage(terminal.report.usage);
      authoritative = true;
    } else if (terminal?.kind === 'single') {
      children = [childFromReport(terminal.report, 0)];
      status = children[0].status;
      usage = children[0].usage;
      authoritative = true;
    } else if (children.length) {
      if (children.some((child) => ['running', 'queued'].includes(child.status))) status = 'running';
      else if (children.some((child) => child.status === 'failed')) status = 'failed';
      else if (children.every((child) => child.status === 'completed')) status = 'completed';
      else status = children.some((child) => child.terminal) ? 'partial' : 'queued';
    }
    children.sort((a, b) => a.ordinal - b.ordinal);
    const active = children.find((child) => !child.terminal && child.status === 'running');
    const failed = children.find((child) => child.status === 'failed');
    const selectedKey = normalizeText(input.selectedKey, 200);
    const selected = children.find((child) => child.key === selectedKey) || active || failed || children[0] || null;
    const elapsedMs = authoritative
      ? Math.max(0, Number(terminal?.report?.budget?.elapsed_ms || selected?.budget?.elapsed_ms || 0))
      : Math.max(0, Number(input.now || Date.now()) - Number(selected?.startedAt || Date.now()));
    const completed = children.filter((child) => child.status === 'completed').length;
    return {
      key: normalizeText(input.key, 200) || normalizeText(input.toolCallId, 200) || selected?.toolCallId || selected?.key || '',
      toolCallId: normalizeText(input.toolCallId, 200) || selected?.toolCallId || '',
      status,
      tone: toneForStatus(status),
      terminal: authoritative || (children.length > 0 && children.every((child) => child.terminal)),
      authoritative,
      children,
      childCount: children.length,
      completedCount: completed,
      selected,
      selectedKey: selected?.key || '',
      elapsedMs,
      usage,
      parentState: input.parentResponding === true
        ? 'Responding'
        : (children.some((child) => !child.terminal) ? 'Waiting on child' : 'Synthesizing results'),
      summaryLabel: terminal?.kind === 'batch' || children.length > 1 ? 'Delegated research' : (selected?.label || 'Delegated research'),
      statusCopy: terminalCopy(selected?.terminalReason, status),
    };
  }

  function buildMonitorFromMessages(messages, key, selectedKey, now) {
    const list = Array.isArray(messages) ? messages : [];
    let terminal = null;
    let toolCallId = '';
    let terminalMessageIndex = -1;
    const steps = [];
    for (let messageIndex = 0; messageIndex < list.length; messageIndex += 1) {
      const message = list[messageIndex];
      for (const step of (Array.isArray(message?.agent_status_steps) ? message.agent_status_steps : [])) {
        const stepKey = normalizeText(step?.toolCallId || step?.tool_call_id || step?.childTaskId || step?.taskId, 200);
        if (!key || !stepKey || stepKey === key) steps.push(step);
      }
      for (const step of (Array.isArray(message?.agent_progress_snapshot) ? message.agent_progress_snapshot : [])) {
        const stepKey = normalizeText(step?.toolCallId || step?.tool_call_id || step?.childTaskId || step?.taskId, 200);
        if (!key || !stepKey || stepKey === key) steps.push(step);
      }
      const result = message?.tool_result;
      const report = extractTerminalReport(result?.metadata);
      const callId = normalizeText(result?.call_id, 200);
      if (report && (!key || callId === key || report.report?.task_id === key || report.report?.batch_id === key)) {
        terminal = report;
        toolCallId = callId;
        terminalMessageIndex = messageIndex;
      }
    }
    const parentResponding = terminalMessageIndex >= 0 && list.slice(terminalMessageIndex + 1).some((message) => (
      String(message?.role || '').toLowerCase() === 'assistant' && Boolean(normalizeText(message?.content, 1))
    ));
    return buildMonitorViewModel({
      steps, terminal, key: key || toolCallId, toolCallId, selectedKey, now, parentResponding,
    });
  }

  function formatElapsed(ms) {
    const seconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return `${minutes}m ${String(remainder).padStart(2, '0')}s`;
  }

  function formatTokens(value) {
    if (value === undefined || value === null || value === '') return 'Unavailable';
    const count = Number(value);
    if (!Number.isFinite(count) || count < 0) return 'Unavailable';
    if (count >= 1000000) return `${(count / 1000000).toFixed(count >= 10000000 ? 0 : 1)}m`;
    if (count >= 1000) return `${(count / 1000).toFixed(count >= 10000 ? 0 : 1)}k`;
    return String(Math.round(count));
  }

  return {
    buildMonitorFromMessages,
    buildMonitorViewModel,
    extractTerminalReport,
    formatElapsed,
    formatTokens,
    normalizeUsage,
    selectLiveDelegationSteps,
    terminalCopy,
    toneForStatus,
  };
});
