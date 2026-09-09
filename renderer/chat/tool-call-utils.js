/**
 * renderer/chat/tool-call-utils.js
 *
 * Renderer-side utility functions for tool activity display (UMD).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.toolCallUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const _stringUtils = typeof globalThis !== 'undefined' && typeof globalThis.stringUtils !== 'undefined' ? globalThis.stringUtils
    : typeof require === 'function' ? require('../shared/string-utils')
    : { normalizeString: function (v) { return String(v || '').trim(); } };
  const { normalizeString } = _stringUtils;
  const _toolApprovalFacts = typeof globalThis !== 'undefined' && typeof globalThis.toolApprovalFacts !== 'undefined'
    ? globalThis.toolApprovalFacts : require('./tool-approval-facts');

  const TOOL_KIND_ALIASES = {
    read_file: 'Read',
    edit_file: 'Edit',
    write_file: 'Write',
    move_file: 'Move',
    run_command: 'Bash',
    mermaid_generate: 'Mermaid',
  };

  const DENIED_TOOL_CODES = new Set([
    'CMP-TOOL-0001',
    'CMP-TOOL-0007',
    'CMP-TOOL-0017',
    'CMP-TOOL-0039',
    'CMP-APPROVAL-REJECTED',
  ]);

  const GRANULAR_TOOL_STATUSES = new Set([
    'denied', 'cancelled', 'blocked', 'timed_out', 'interrupted', 'abandoned',
  ]);

  const FILE_OPERATION_NON_TERMINAL_STATUSES = new Set([
    'running', 'executing', 'requested', 'approved', 'awaiting_approval',
  ]);

  // Single source for the approval-gap-row variant: an exit_plan_mode approval
  // whose plan document is still pending renders as the buttonless 'plan' row.
  // Both derivation seams — the hydrated projector (renderer-turn-row-projector)
  // and the live stream-event translator (renderer-turn-reducer-stream-event-utils)
  // — call this so the condition can't drift between the two paths.
  // The plan document owns review and decision rendering; keep raw tool rows
  // only when there is no matching document (for example, validation errors).
  function hasPlanDocumentForTool(toolName, callId, messages) {
    const id = normalizeString(callId);
    return normalizeString(toolName) === 'exit_plan_mode' && Boolean(id)
      && Array.isArray(messages) && messages.some((message) =>
        message?.kind === 'plan_document'
        && normalizeString(message.plan_document?.tool_call_id) === id);
  }

  function deriveApprovalVariant(toolName, hasPendingPlanDocument) {
    return hasPendingPlanDocument === true && String(toolName || '').trim() === 'exit_plan_mode'
      ? 'plan'
      : '';
  }

  // Only a call still waiting on the user opens itself. Finished rows — including
  // failures — stay collapsed like every other tool row; the status label and
  // severity tint already flag them, and a self-opening failure reflows the
  // transcript under the reader.
  const TOOL_AUTO_EXPAND_STATUSES = new Set(['awaiting_approval']);

  const TOOL_STATUS_SEVERITY = Object.freeze({
    errored: 'danger',
    error: 'danger',
    timed_out: 'caution',
    interrupted: 'caution',
    abandoned: 'caution',
    denied: 'calm',
    cancelled: 'calm',
    blocked: 'calm',
  });

  const TOOL_ICONS = {
    Read: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 2h7l3 3v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M10 2v3h3" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M5 8h6M5 11h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
    Write: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 2h7l3 3v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M10 2v3h3" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M5 9l1.5-1.5L9 10l-1.5 1.5H5V9z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
    Edit: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M9 4l3 3" stroke="currentColor" stroke-width="1.2"/></svg>',
    Move: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 5h9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="m8 2 3 3-3 3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 11H5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="m8 8-3 3 3 3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    Bash: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="2" width="14" height="12" rx="2" stroke="currentColor" stroke-width="1.2"/><path d="M4 7l2.5 2L4 11" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 11h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
    Glob: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.2"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M5 7h4M7 5v4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
    Grep: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.2"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
    python_execute: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8.3 1.5c2.7 0 2.6 1.2 2.6 1.2v1.3H5.8c-1.2 0-2.1 1-2.1 2.1v3.2c0 1.1.9 2.1 2.1 2.1h1.4V9.5c0-1.1.9-2.1 2.1-2.1h3.5c1.1 0 2.1-.9 2.1-2.1V2.7s.4-1.2-2.6-1.2H8.3Z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/><path d="M7.7 14.5c-2.7 0-2.6-1.2-2.6-1.2V12h5.1c1.2 0 2.1-1 2.1-2.1V6.7c0-1.1-.9-2.1-2.1-2.1H8.8v1.9c0 1.1-.9 2.1-2.1 2.1H3.2c-1.1 0-2.1.9-2.1 2.1v2.6s-.4 1.2 2.6 1.2h4Z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/><circle cx="9.7" cy="2.7" r=".7" fill="currentColor"/><circle cx="6.3" cy="13.3" r=".7" fill="currentColor"/></svg>',
    web_search: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.2"/><path d="M2.5 8h11M8 2.5a9.5 9.5 0 0 1 2.5 5.5A9.5 9.5 0 0 1 8 13.5M8 2.5A9.5 9.5 0 0 0 5.5 8 9.5 9.5 0 0 0 8 13.5" stroke="currentColor" stroke-width="1"/></svg>',
    fetch_url: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 3H3v10h10v-3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 2h5v5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 2L7 9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
    Mermaid: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 3.5h12v9H2z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M4.5 6.25h2.5l1.2 1.5 1.3-1.5h2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.5 10h7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  };

  const DEFAULT_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.2"/><path d="M8 5v3l2 2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function titleCaseToolLabel(value) {
    return String(value || '')
      .trim()
      .split(/[_\-\s]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }

  function normalizeToolKind(toolName) {
    const normalizedName = normalizeString(toolName);
    return TOOL_KIND_ALIASES[normalizedName] || normalizedName;
  }

  const {
    APPROVAL_FACT_KINDS,
    getApprovalPurpose,
    getApprovalFacts,
    getApprovalCommandPreview,
  } = _toolApprovalFacts.createToolApprovalFacts({ normalizeToolKind, normalizeString });

  /**
   * The transcript label for a tool. One precedence, so the two render paths
   * and the approval card cannot disagree (F16): the renderer's short alias
   * for the kinds it knows (Read, Write, Edit, Move, Bash, Mermaid) wins;
   * then the catalog name the sidecar sends as tool_display_name (it carries
   * overrides such as "Fetch URL" that title-casing cannot produce); then a
   * title-cased tool id.
   */
  function getToolDisplayName(toolName, catalogDisplayName) {
    const normalizedName = normalizeString(toolName);
    const normalizedKind = normalizeToolKind(toolName);
    if (!normalizedKind) {
      return 'Tool';
    }
    if (normalizedKind === normalizedName) {
      return normalizeString(catalogDisplayName) || titleCaseToolLabel(normalizedKind) || 'Tool';
    }
    return normalizedKind;
  }

  /**
   * Human-readable one-liner for a tool call.
   * e.g. "Read src/app.js", "Bash npm test", "Edit src/utils.js"
   * When resultMeta is provided, enriches the summary with result data.
   */
  function formatToolCallSummary(toolName, input, resultMeta) {
    const normalizedToolName = normalizeToolKind(toolName);
    if (!input || typeof input !== 'object') {
      return getToolDisplayName(toolName);
    }
    const meta = resultMeta && resultMeta.metadata ? resultMeta.metadata : {};
    switch (normalizedToolName) {
      case 'Read': {
        const path = normalizeString(input.path || input.file_path);
        const offset = input.offset != null ? Number(input.offset) : null;
        const limit = input.limit != null ? Number(input.limit) : null;
        const hasRange = Number.isFinite(offset) && Number.isFinite(limit) && limit > 0;
        if (path && hasRange) {
          return 'Read ' + path + ' lines ' + offset + '-' + (offset + limit - 1);
        }
        return path ? 'Read ' + path : jt('chat.toolCall.readFile', 'Read file');
      }
      case 'Write': {
        const targetPath = normalizeString(input.path || input.file_path);
        const base = targetPath ? 'Write ' + targetPath : jt('chat.toolCall.writeFile', 'Write file');
        return base;
      }
      case 'Edit': {
        const targetPath = normalizeString(input.path || input.file_path);
        const base = targetPath ? 'Edit ' + targetPath : jt('chat.toolCall.editFile', 'Edit file');
        return base;
      }
      case 'Move': {
        const moves = Array.isArray(input.moves) ? input.moves : [];
        if (moves.length > 1) return 'Move ' + moves.length + ' files';
        const targetPath = getToolPrimaryPath(toolName, input);
        return targetPath ? 'Move ' + targetPath : jt('chat.toolCall.moveFile', 'Move file');
      }
      case 'Bash': {
        const cmd = normalizeString(input.command);
        const desc = input.description ? normalizeString(input.description) : '';
        let label = desc || (cmd ? 'Run ' + (cmd.length <= 56 ? cmd : cmd.slice(0, 53) + '...') : jt('chat.toolCall.runCommand', 'Run command'));
        if (meta.exitCode != null) label += ' (exit ' + meta.exitCode + ')';
        return label;
      }
      case 'monitor': {
        const desc = normalizeString(input.description);
        return desc || jt('chat.toolCall.monitorCommand', 'Monitor command');
      }
      case 'Glob':
        return input.pattern ? 'Scan ' + input.pattern : jt('chat.toolCall.scanFiles', 'Scan files');
      case 'Grep':
        return input.pattern ? jt('chat.toolCall.searchFor', 'Search for {pattern}', { pattern: input.pattern }) : jt('chat.toolCall.searchFiles', 'Search files');
      case 'python_execute': {
        const code = normalizeString(input.code);
        if (!code) return jt('chat.toolCall.runPython', 'Run Python');
        return code.length <= 50 ? jt('chat.toolCall.runPythonCode', 'Run Python: {code}', { code: code }) : jt('chat.toolCall.runPythonCode', 'Run Python: {code}', { code: code.slice(0, 47) + '...' });
      }
      case 'web_search': {
        const query = normalizeString(input.query);
        return query ? jt('chat.toolCall.searchWebFor', 'Search web for {query}', { query: query.length <= 38 ? query : query.slice(0, 35) + '...' }) : jt('chat.toolCall.searchWeb', 'Search web');
      }
      case 'fetch_url': {
        const url = normalizeString(input.url);
        return url ? 'Fetch ' + (url.length <= 50 ? url : url.slice(0, 47) + '...') : jt('chat.toolCall.fetchUrl', 'Fetch URL');
      }
      case 'Mermaid': {
        const diagramType = normalizeString(input.diagram_type) || 'flowchart';
        const prompt = normalizeString(input.prompt);
        if (!prompt) return jt('chat.toolCall.generateMermaidType', 'Generate Mermaid ({type})', { type: diagramType });
        const clipped = prompt.length <= 44 ? prompt : prompt.slice(0, 41) + '...';
        return 'Mermaid ' + diagramType + ': ' + clipped;
      }
      default: {
        // For unknown tools, try to extract a meaningful subject from common input fields
        const subject = normalizeString(
          input.file_name || input.path || input.file_path || input.title ||
          input.query || input.url || input.command || input.pattern
        );
        if (subject) return subject.length <= 56 ? subject : subject.slice(0, 53) + '...';
        return getToolDisplayName(toolName);
      }
    }
  }

  /**
   * A compact result line for the tool-row header's meta slot, derived from
   * the result metadata alone so the chat timeline can show a verdict without
   * a second call. `verify` emits its gate verdict and `task_board` emits the
   * completed mutation (for example, "task added"). Other result kinds return
   * '' so the header anatomy stays unchanged.
   */
  function formatToolResultMeta(toolName, metadata) {
    const meta = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : null;
    if (!meta) return '';
    // Command sandbox execution is intentionally nested and scoped to the
    // foreground run_command result. Other tools may carry metadata of their
    // own, but must never inherit a Docker badge from a shared formatter.
    if (normalizeToolKind(toolName) === 'Bash'
      && meta.execution && typeof meta.execution === 'object' && !Array.isArray(meta.execution)
      && normalizeString(meta.execution.backend).toLowerCase() === 'docker') {
      const execution = meta.execution;
      const status = normalizeString(execution.status).toLowerCase();
      const statusLabels = {
        completed: jt('chat.toolCall.sandboxCompleted', 'Completed'),
        success: jt('chat.toolCall.sandboxCompleted', 'Completed'),
        running: jt('chat.toolCall.sandboxRunning', 'Running'),
        preparing: jt('chat.toolCall.sandboxPreparing', 'Preparing'),
        failed: jt('chat.toolCall.sandboxFailed', 'Failed'),
        error: jt('chat.toolCall.sandboxFailed', 'Failed'),
        cancelled: jt('chat.toolCall.sandboxCancelled', 'Cancelled'),
        timed_out: jt('chat.toolCall.sandboxTimedOut', 'Timed out'),
        interrupted: jt('chat.toolCall.sandboxInterrupted', 'Interrupted'),
        output_limit: jt('chat.toolCall.sandboxOutputLimit', 'Output limit reached'),
      };
      const parts = [jt('chat.toolCall.dockerSandbox', 'Docker sandbox')];
      if (statusLabels[status]) parts.push(statusLabels[status]);
      const exitCode = Number(execution.exit_code ?? execution.exitCode);
      if (Number.isInteger(exitCode)) {
        parts.push(jt('chat.toolCall.sandboxExitCode', 'exit {code}', { code: exitCode }));
      }
      if (execution.output_truncated === true) {
        parts.push(jt('chat.toolCall.sandboxOutputTruncated', 'output truncated'));
      }
      if (execution.cleanup_confirmed === false) {
        parts.push(jt('chat.toolCall.sandboxCleanupPending', 'cleanup pending'));
      }
      return parts.join(' · ');
    }
    if (meta.result_kind === 'task_board') {
      if (normalizeString(meta.status) === 'failed') return '';
      return ({
        add: jt('chat.toolCall.taskAdded', 'task added'),
        update: jt('chat.toolCall.taskUpdated', 'task updated'),
        complete: jt('chat.toolCall.taskCompleted', 'task completed'),
        list: jt('chat.toolCall.tasksListed', 'tasks listed'),
      })[normalizeString(meta.action)] || '';
    }
    if (normalizeToolKind(toolName) !== 'verify' || meta.result_kind !== 'verify') return '';
    const status = normalizeString(meta.status);
    const action = normalizeString(meta.action);
    if (action === 'list' || !status || status === 'ok') return '';
    const parts = [action === 'gate' ? 'Gate' : ''];
    const passed = Number(meta.passed_count);
    const failed = Number(meta.failed_count);
    const haveCounts = Number.isFinite(passed) && Number.isFinite(failed);
    if (status === 'passed') {
      parts.push('Passed' + (haveCounts ? ' · ' + (passed + failed) : ''));
    } else if (status === 'failed') {
      parts.push('Failed' + (haveCounts ? ' · ' + failed + ' of ' + (passed + failed) : ''));
    } else if (status === 'skipped') {
      parts.push(normalizeString(meta.reason) === 'already_running' ? jt('chat.toolCall.skippedRunInProgress', 'Skipped · a run was in progress') : 'Skipped');
    } else {
      return '';
    }
    const durationMs = Number(meta.duration_ms);
    if (Number.isFinite(durationMs) && durationMs > 0) {
      parts.push((durationMs / 1000).toFixed(1) + 's');
    }
    const attempt = Number(meta.attempt);
    if (Number.isInteger(attempt) && attempt > 0) {
      parts.push('attempt ' + attempt);
    }
    return parts.filter(Boolean).join(' · ');
  }

  /**
   * SVG icon for a tool.
   */
  function getToolIcon(toolName) {
    return TOOL_ICONS[normalizeToolKind(toolName)] || DEFAULT_ICON;
  }

  /**
   * Approval prompt label.
   * e.g. "Jenny wants to run npm test"
   */
  function getApprovalLabel(toolName, input) {
    const summary = formatToolCallSummary(toolName, input);
    switch (normalizeToolKind(toolName)) {
      case 'Bash':
        return jt('chat.toolCall.approvalRun', 'Jenny wants to run: {summary}', { summary: summary });
      case 'Write':
        return jt('chat.toolCall.approvalWrite', 'Jenny wants to write: {target}', { target: input && (input.file_path || input.path) || jt('chat.toolCall.aFile', 'a file') });
      case 'Edit':
        return jt('chat.toolCall.approvalEdit', 'Jenny wants to edit: {target}', { target: input && input.file_path || jt('chat.toolCall.aFile', 'a file') });
      default:
        return jt('chat.toolCall.approvalUse', 'Jenny wants to use {tool}', { tool: getToolDisplayName(toolName) });
    }
  }

  /**
   * The workspace file a tool call primarily targets, for the chat timeline's
   * clickable path chips + context menu (W1-4). Only file-target tools return
   * a path; command/search/web tools return '' so no chip renders.
   */
  function getToolPrimaryPath(toolName, input) {
    const args = input && typeof input === 'object' && !Array.isArray(input) ? input : null;
    if (!args) return '';
    switch (normalizeToolKind(toolName)) {
      case 'Read':
      case 'Write':
      case 'Edit':
      case 'delete_file':
        return normalizeString(args.path || args.file_path);
      case 'Move': {
        const firstMove = Array.isArray(args.moves) && args.moves.length ? args.moves[0] : null;
        return normalizeString(args.destination || firstMove && firstMove.destination);
      }
      default:
        return '';
    }
  }

  function getToolTargetBasename(toolName, input) {
    const targetPath = getToolPrimaryPath(toolName, input).replace(/\\/g, '/').replace(/\/+$/, '');
    return targetPath ? targetPath.slice(targetPath.lastIndexOf('/') + 1) : '';
  }

  function formatToolElapsedLabel(ms) {
    const clockUtils = typeof globalThis !== 'undefined' && globalThis.rendererTurnElapsedClock
      ? globalThis.rendererTurnElapsedClock
      : (typeof require === 'function' ? require('./renderer-turn-elapsed-clock') : null);
    return clockUtils && typeof clockUtils.formatElapsedLabel === 'function'
      ? clockUtils.formatElapsedLabel(ms)
      : '';
  }

  /**
   * Status label for display.
   */
  function getStatusLabel(status) {
    switch (status) {
      case 'requested': return 'Requested';
      case 'awaiting_approval':
      case 'pending_approval': return jt('chat.toolCall.awaitingApproval', 'Awaiting approval');
      case 'approved': return 'Approved';
      case 'running': return 'Running';
      case 'completed': return 'Success';
      case 'errored':
      case 'error': return 'Error';
      case 'denied': return 'Denied';
      case 'blocked': return 'Blocked';
      case 'timed_out': return jt('chat.toolCall.timedOut', 'Timed out');
      case 'cancelled': return 'Cancelled';
      case 'abandoned': return jt('chat.toolCall.noResult', 'No result');
      case 'interrupted': return 'Interrupted';
      default: return status || 'Unknown';
    }
  }

  function normalizeToolStatus(value) {
    const status = normalizeString(value).toLowerCase();
    if (!status) return 'requested';
    if (status === 'pending_approval') return 'awaiting_approval';
    if (status === 'error') return 'errored';
    if (status === 'timeout') return 'timed_out';
    if (status === 'preempted') return 'cancelled';
    return status;
  }

  function isFileOperationSettledStatus(status) {
    return !FILE_OPERATION_NON_TERMINAL_STATUSES.has(normalizeToolStatus(status));
  }

  function classifyToolResultOutcome(payload) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const code = normalizeString(p.error_code).toUpperCase();
    const status = normalizeToolStatus(p.status || p.state || p.terminal_status || p.approval_state);
    if (DENIED_TOOL_CODES.has(code) || status === 'denied' || status === 'cancelled' || status === 'blocked') {
      return 'stopped';
    }
    if (status === 'timed_out' || status === 'interrupted' || status === 'abandoned') {
      return 'interrupted';
    }
    return 'failure';
  }

  const TOOL_FAILURE_SUMMARY_MAX_CHARS = 160;

  /**
   * One bounded line of a failed call's own failure text for the collapsed
   * header, so the reason a row went red is in the DOM (find-in-page, the
   * accessibility tree) before the reader opens it. Mirrors the detail body's
   * precedence: the tool's output first, then the result summary. Only a
   * genuine failure gets a line; denied / cancelled / timed-out rows already
   * say so in their status word.
   */
  function summarizeToolFailure(result) {
    const r = result && typeof result === 'object' ? result : {};
    if (r.isError !== true) return '';
    if (classifyToolResultOutcome({ error_code: r.errorCode, is_error: true, status: r.status }) !== 'failure') {
      return '';
    }
    const firstOutputLine = String(r.outputText || '').split(/\r?\n/u)
      .map((line) => line.trim()).find(Boolean) || '';
    const text = (firstOutputLine || normalizeString(r.resultSummary) || jt('chat.toolCall.toolFailed', 'Tool failed'))
      .replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim();
    const characters = Array.from(text);
    return characters.length > TOOL_FAILURE_SUMMARY_MAX_CHARS
      ? characters.slice(0, TOOL_FAILURE_SUMMARY_MAX_CHARS - 3).join('') + '...'
      : text;
  }

  function statusForToolResult(payload) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const status = normalizeToolStatus(p.status || p.state || p.terminal_status || p.approval_state);
    if (GRANULAR_TOOL_STATUSES.has(status)) return status;
    if (p.is_error !== true && p.result_is_error !== true) return 'completed';
    const outcome = classifyToolResultOutcome(p);
    if (outcome === 'stopped') return 'denied';
    if (outcome === 'interrupted') return 'interrupted';
    return 'errored';
  }

  function getToolStatusSeverity(status) {
    return TOOL_STATUS_SEVERITY[normalizeToolStatus(status)] || '';
  }

  function shouldAutoExpandToolDetails(status) {
    return TOOL_AUTO_EXPAND_STATUSES.has(normalizeToolStatus(status));
  }

  function buildToolRowKey(parts) {
    const value = parts && typeof parts === 'object' ? parts : {};
    const sessionId = normalizeString(value.sessionId || value.session_id);
    const turnId = normalizeString(value.turnId || value.turn_id);
    const rowId = normalizeString(value.rowId || value.row_id);
    const messageId = normalizeString(value.messageId || value.message_id || value.primary_message_id);
    const callId = normalizeString(value.callId || value.call_id || value.tool_call_id);
    const encodePart = (part) => encodeURIComponent(part);
    return [
      'session=' + encodePart(sessionId),
      'turn=' + encodePart(turnId),
      'row=' + encodePart(rowId || messageId),
      'call=' + encodePart(callId),
    ].join('|');
  }

  function buildToolRowDomToken(rowKey) {
    return 'tool-row-' + encodeURIComponent(normalizeString(rowKey) || 'unknown');
  }

  /*
   * Map a tool-call status to a foundation .status-dot--* tone modifier.
   * Shared by the compact shell renderer and the generic transcript path
   * so both header treatments agree on a single dot palette.
   */
  function statusToneFor(status, isRunning) {
    if (isRunning) return 'active';
    if (!normalizeString(status)) return 'muted';
    switch (normalizeToolStatus(status)) {
      case 'completed':
      case 'approved': return 'ok';
      case 'errored': return 'error';
      case 'timed_out':
      case 'interrupted':
      case 'abandoned': return 'warn';
      case 'denied':
      case 'cancelled':
      case 'blocked': return 'muted';
      case 'awaiting_approval':
      case 'requested': return 'pending';
      default: return 'muted';
    }
  }

  // Only authoritative per-operation totals; never infer missing values as zero.
  function getToolLineCounts(toolName, metadata, status, isError) {
    const diff = metadata && metadata.diff;
    if (!/^(Edit|Write)$/.test(normalizeToolKind(toolName))
      || normalizeToolStatus(status) !== 'completed' || isError
      || !diff || diff.review_state === 'failed' || diff.status === 'unknown'
      || ![diff.additions, diff.deletions].every(value => Number.isSafeInteger(value) && value >= 0)) return null;
    return { additions: diff.additions, deletions: diff.deletions };
  }

  // Shared by shell and timeline headers. Callback markup must escape dynamic values.
  function buildToolHeaderInner(model, helpers) {
    const esc = helpers.escapeHtml;
    const affordance = typeof helpers.renderReviewChangesAffordance === 'function'
      ? helpers.renderReviewChangesAffordance
      : function () { return ''; };
    const summaryMarkup = typeof helpers.renderSummary === 'function'
      ? helpers.renderSummary(model.summary, model)
      : '<span class="tool-call-summary">' + esc(model.summary) + '</span>';
    const durationMarkup = typeof helpers.renderDuration === 'function'
      ? helpers.renderDuration(model.durationLabel, model)
      : (model.durationLabel
          ? ' <span class="tool-call-duration">' + esc(model.durationLabel) + '</span>'
          : '');
    const iconMarkup = typeof helpers.renderIcon === 'function'
      ? helpers.renderIcon(model.icon, model)
      : '';
    const statusLabelClass = model.status === 'completed' && !model.isRunning
      ? 'tool-call-status-label sr-only'
      : 'tool-call-status-label';
    return '<span class="status-dot status-dot--' + statusToneFor(model.status, model.isRunning) + '" aria-hidden="true"></span>'
      + iconMarkup
      + '<span class="tool-call-main">'
      + '<span class="tool-call-name">' + esc(model.displayToolName) + '</span>'
      + summaryMarkup
      + (model.failureSummary
        ? '<span class="tool-call-failure-summary">' + esc(model.failureSummary) + '</span>'
        : '')
      + '</span>'
      + '<span class="tool-call-status-cluster">'
      + affordance(model.reviewableChange)
      + (model.lineCounts
        ? '<span class="tool-call-line-counts"><span class="sr-only">'
          + esc(jt('toolCallUtils.lineChanges', '{additions} lines added, {deletions} lines removed', model.lineCounts)) + '</span>'
          + '<span aria-hidden="true" class="tool-call-line-add' + (model.lineCounts.additions === 0 ? ' tool-call-line-zero' : '') + '">+' + esc(model.lineCounts.additions) + '</span>'
          + '<span aria-hidden="true" class="tool-call-line-remove' + (model.lineCounts.deletions === 0 ? ' tool-call-line-zero' : '') + '">−' + esc(model.lineCounts.deletions) + '</span></span>'
        : '')
      + (model.secondaryMeta
        ? '<span class="tool-call-meta">' + esc(model.secondaryMeta) + '</span>'
        : '')
      + '<span class="tool-call-status tool-call-status-' + esc(model.status) + '">'
      + '<span class="' + statusLabelClass + '">' + esc(model.statusLabel) + '</span>'
      + durationMarkup
      + '</span>'
      + '<span class="tool-call-disclosure" aria-hidden="true"></span>'
      + '</span>';
  }

  function getTrustedToolResultImageUrls(resultMeta) {
    const refs = resultMeta && Array.isArray(resultMeta.trusted_attachment_refs)
      ? resultMeta.trusted_attachment_refs
      : [];
    return refs.map((attachment) => {
      const assetPath = String(attachment?.asset_path || attachment?.assetPath || '').trim();
      if (!assetPath || /^\\\\/.test(assetPath) || /^\/\//.test(assetPath)) return '';
      const normalized = assetPath.replace(/\\/g, '/');
      const prefixed = normalized.startsWith('/') ? normalized : `/${normalized}`;
      try {
        const fileUrl = new URL('file:///');
        fileUrl.pathname = prefixed;
        return fileUrl.toString();
      } catch (_error) {
        return '';
      }
    }).filter(Boolean);
  }

  /*
   * Class-E projected-row tool-call-id resolver: a deliberately-narrow 2-key
   * subset (payload-first) distinct from the canonical 8-key extractToolCallId.
   * It relies on the projector pre-normalizing payload.tool_call_id, so it must
   * NOT be widened to the raw-event keys.
   */
  function resolveProjectedRowCallId(row) {
    const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
    return normalizeString(payload.tool_call_id || (row && row.tool_call_id));
  }

  return {
    APPROVAL_FACT_KINDS,
    deriveApprovalVariant,
    hasPlanDocumentForTool,
    normalizeToolKind,
    getToolDisplayName,
    formatToolCallSummary,
    formatToolResultMeta,
    getToolIcon,
    getApprovalLabel,
    getApprovalPurpose,
    getApprovalFacts,
    getApprovalCommandPreview,
    getToolPrimaryPath,
    getToolTargetBasename,
    formatToolElapsedLabel,
    getStatusLabel,
    normalizeToolStatus,
    isFileOperationSettledStatus,
    classifyToolResultOutcome,
    statusForToolResult,
    summarizeToolFailure,
    getToolStatusSeverity,
    shouldAutoExpandToolDetails,
    buildToolRowKey,
    buildToolRowDomToken,
    statusToneFor,
    buildToolHeaderInner,
    getToolLineCounts,
    getTrustedToolResultImageUrls,
    resolveProjectedRowCallId,
  };
});
