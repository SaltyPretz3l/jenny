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
    glob_files: 'Glob',
    grep_search: 'Grep',
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

  const COMMAND_BLOCKED_CODE = 'CMP-TOOL-0007';
  // Calls that never failed on their own: the user's Stop ("aborted by user
  // cancellation", F3) and a batched call the approval window dropped before it
  // ran, which the model re-issues (F16). Both read Cancelled, not Error.
  const NOT_RUN_TOOL_CODES = new Set(['CMP-TOOL-0041', 'CMP-TOOL-0042']);

  // The sidecar's shell tool reports exit_code (wire casing); exitCode is the
  // older Electron-run shape. Either names the command's own exit status.
  function readToolExitCode(metadata) {
    const m = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
    const raw = m.exitCode != null ? m.exitCode : (m.exit_code != null ? m.exit_code : readSandboxExitCode(m.execution));
    const code = raw != null ? Number(raw) : NaN;
    return Number.isInteger(code) ? code : null;
  }

  // A Docker sandbox receipt carries the command's exit status under
  // execution; a run the sandbox itself stopped has no exit status to show.
  const SANDBOX_NO_EXIT_STATUSES = new Set(['timed_out', 'cancelled', 'interrupted', 'output_limit', 'running', 'preparing']);
  function readSandboxExitCode(execution) {
    if (!execution || typeof execution !== 'object' || Array.isArray(execution)) return null;
    if (SANDBOX_NO_EXIT_STATUSES.has(normalizeString(execution.status).toLowerCase())) return null;
    return execution.exit_code ?? execution.exitCode ?? null;
  }

  // The shell tool stopped the command at its time limit (sidecar timed_out,
  // older Electron-run timedOut); the row reads Timed out, not Errored.
  function readToolTimedOut(metadata) {
    const m = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
    return m.timed_out === true || m.timedOut === true;
  }

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
    // The per-conversation todo list is "Jenny's checklist" everywhere the
    // user sees it; the catalog's "Todo Write" is an implementation name.
    if (normalizedName === 'todo_write') return jt('chat.toolCall.checklistName', 'Checklist');
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
        const exitCode = readToolExitCode(meta);
        if (exitCode != null) label += ' (exit ' + exitCode + ')';
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
      case 'todo_write': {
        const todos = Array.isArray(input.todos) ? input.todos : [];
        if (!todos.length) return getToolDisplayName(toolName);
        const done = todos.filter((todo) => normalizeString(todo?.status) === 'completed').length;
        const current = todos.find((todo) => normalizeString(todo?.status) === 'in_progress')
          || todos.find((todo) => normalizeString(todo?.status) !== 'completed');
        const progress = jt('chat.toolCall.checklistProgress', '{done} of {total} done', { done, total: todos.length });
        const item = normalizeString(current?.content);
        return item ? progress + ' · ' + item : progress;
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
      case 'requested': return jt('chat.toolCall.requested', 'Requested');
      case 'awaiting_approval':
      case 'pending_approval': return jt('chat.toolCall.awaitingApproval', 'Awaiting approval');
      case 'approved': return jt('chat.toolCall.approved', 'Approved');
      case 'running': return jt('chat.toolCall.running', 'Running');
      case 'completed': return jt('chat.toolCall.success', 'Success');
      case 'errored':
      case 'error': return jt('chat.toolCall.error', 'Error');
      case 'denied': return jt('chat.toolCall.denied', 'Denied');
      case 'blocked': return jt('chat.toolCall.blocked', 'Blocked');
      case 'timed_out': return jt('chat.toolCall.timedOut', 'Timed out');
      case 'cancelled': return jt('chat.toolCall.cancelled', 'Cancelled');
      case 'abandoned': return jt('chat.toolCall.noResult', 'No result');
      case 'interrupted': return jt('chat.toolCall.interrupted', 'Interrupted');
      default: return status || jt('chat.toolCall.unknown', 'Unknown');
    }
  }

  // A command that ran and exited non-zero reports its own result: the row
  // reads "exit N", not Error (dogfood HB-035). `result` is the tool_result
  // payload or its metadata; either may carry the exit code.
  function getResultStatusLabel(status, result) {
    const normalized = normalizeToolStatus(status);
    if (normalized === 'errored') {
      const r = result && typeof result === 'object' && !Array.isArray(result) ? result : {};
      const exitCode = readToolExitCode(r.metadata) ?? readToolExitCode(r);
      if (exitCode != null && exitCode !== 0) {
        return jt('chat.toolShell.exitCode', 'exit {code}', { code: exitCode });
      }
    }
    return getStatusLabel(normalized === 'errored' ? 'errored' : status);
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
    if (DENIED_TOOL_CODES.has(code) || NOT_RUN_TOOL_CODES.has(code)
      || status === 'denied' || status === 'cancelled' || status === 'blocked') {
      return 'stopped';
    }
    if (status === 'timed_out' || status === 'interrupted' || status === 'abandoned') {
      return 'interrupted';
    }
    return 'failure';
  }

  const TOOL_FAILURE_SUMMARY_MAX_CHARS = 160;
  // The sidecar's per-chat budget guidance (tool_loop._quota_block_guidance);
  // "session's" is the wording rows persisted before TR-008 carry.
  const SESSION_TOOL_BUDGET_TEXT_RE = /(?:chat|session)'s tool budget \(\d+/u;

  /* TR-008: a call the per-chat tool budget refused (CMP-TOOL-0013 is shared
   * with the per-turn caps, so the quota scope or the guidance text decides). */
  function isSessionToolBudgetBlock(result) {
    const r = result && typeof result === 'object' ? result : {};
    if (normalizeString(r.errorCode).toUpperCase() !== 'CMP-TOOL-0013') return false;
    const metadata = r.metadata && typeof r.metadata === 'object' ? r.metadata : {};
    return metadata.quota_scope === 'session_tool_budget'
      || SESSION_TOOL_BUDGET_TEXT_RE.test(String(r.outputText || ''));
  }

  const JSON_OPENER_RE = /^[{[]$/u;
  // "...[truncated]" and the capture-limit note are the tool's markers, not output.
  const TRUNCATION_MARKER_RE = /^\.\.\.\[[^\]]*\]$/u;

  // The shell tool's output is a JSON object, so its first line is "{". The
  // line worth showing is the command's own last word: the tool's message,
  // else the last line of stderr, else of stdout (dogfood HB-035).
  function commandFailureLine(outputText) {
    const text = String(outputText || '').trim();
    if (!text.startsWith('{')) return '';
    let parsed;
    try { parsed = JSON.parse(text); } catch (_error) { return ''; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('command' in parsed)) return '';
    for (const key of ['message', 'stderr', 'stdout']) {
      const lines = String(typeof parsed[key] === 'string' ? parsed[key] : '').split(/\r?\n/u)
        .map((line) => line.trim()).filter((line) => line && !TRUNCATION_MARKER_RE.test(line));
      if (lines.length) return lines[lines.length - 1];
    }
    return '';
  }

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
    if (r.errorCode === 'CMP-TOOL-0047') {
      return /^The PDF reading add-on is installed/u.test(String(r.outputText || '').trim())
        ? jt('chat.toolCall.pdfAddonLoadFailed', 'PDF reading add-on could not be loaded')
        : jt('chat.toolCall.pdfAddonMissing', 'PDF reading add-on not installed');
    }
    if (isSessionToolBudgetBlock(r)) {
      return jt('chat.toolCall.sessionToolBudgetUsed', 'This chat used its tool budget. Start a new chat to keep working.');
    }
    const firstOutputLine = commandFailureLine(r.outputText) || String(r.outputText || '').split(/\r?\n/u)
      .map((line) => line.trim()).find((line) => line && !JSON_OPENER_RE.test(line)) || '';
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
    // A guard refused the command before it ran; nobody denied anything.
    if (normalizeString(p.error_code).toUpperCase() === COMMAND_BLOCKED_CODE) return 'blocked';
    if (outcome === 'failure' && readToolTimedOut(p.metadata)) return 'timed_out';
    if (NOT_RUN_TOOL_CODES.has(normalizeString(p.error_code).toUpperCase())) return 'cancelled';
    if (outcome === 'stopped') return 'denied';
    if (outcome === 'interrupted') return 'interrupted';
    return 'errored';
  }

  function getToolStatusSeverity(status) {
    return TOOL_STATUS_SEVERITY[normalizeToolStatus(status)] || '';
  }

  // Transcript view 'everything' opens every tool card by default; the other
  // views keep the status rule (approval rows still open in 'answers').
  function shouldAutoExpandToolDetails(status, { transcriptView = '' } = {}) {
    if (transcriptView === 'everything') return true;
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

  // Prefix every buildToolRowKey key of one session starts with.
  function toolRowKeySessionPrefix(sessionId) {
    return 'session=' + encodeURIComponent(normalizeString(sessionId)) + '|';
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

  // ── Tool runs (Answers transcript view, NEXT_STEPS row 21) ──
  // Two or more consecutive tool steps fold into one summary row. The row-list
  // builder (render) and the live patch lane (DOM refresh) both reduce the same
  // member descriptors through summarizeToolRun, so a patched summary and a
  // fully rendered one cannot disagree.
  const TOOL_RUN_VERB_BY_KIND = Object.freeze({
    Read: 'read',
    list_dir: 'list',
    Glob: 'search',
    Grep: 'search',
    knowledge_search: 'search',
    Edit: 'edit',
    Write: 'edit',
    Move: 'edit',
    delete_file: 'edit',
    Bash: 'run',
    python_execute: 'run',
    run_temp_script: 'run',
    web_search: 'web',
    fetch_url: 'fetch',
    git_status: 'git',
    git_log: 'git',
    git_diff: 'git',
    git_show: 'git',
    todo_write: 'checklist',
  });
  function toolRunVerb(name) {
    return TOOL_RUN_VERB_BY_KIND[normalizeToolKind(name)] || '';
  }
  // Rows that carry their own content (questions, plans, images, diagrams,
  // artifacts, spawned tasks, calendar blocks) never fold into a run.
  const TOOL_RUN_UNFOLDABLE_TOOLS = new Set([
    'ask_user', 'exit_plan_mode', 'image_generate', 'mermaid_generate', 'create_artifact',
    'workspace_present', 'preview_test', 'session_spawn', 'delegate', 'home',
  ]);
  // A step waiting on the user ends the run and stays its own open card.
  const TOOL_RUN_BREAK_STATUSES = new Set(['awaiting_approval', 'pending_user_input']);
  const TOOL_RUN_LIVE_STATUSES = new Set(['pending', 'queued', 'requested', 'approved', 'running', 'executing']);
  // Run statuses use the one-liner vocabulary (normalizeToolStatus) so the
  // render and patch lanes agree; an empty status is settled, not requested.
  function toolRunStatus(status) {
    return normalizeString(status) ? normalizeToolStatus(status) : '';
  }
  // "Failed" is the one-liner's error tone: a timeout, stop or denial reads
  // amber or muted on its own row, so it does not turn the run red either.
  function isToolRunMemberFailed(member, status) {
    // isError decides only for a member with no status word of its own.
    return statusToneFor(status) === 'error' || (member.isError === true && !status);
  }
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn)
    || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, Object.assign({ count: count }, params || {})); };

  /**
   * Whether a tool step may join a run. `approvalRequested` covers a step that
   * was ever gated: once approved it stays a single row instead of merging back
   * into the run above it (no jump when the approval resolves).
   */
  function isToolRunFoldable({ toolName, status, approvalRequested, hasOwnContent } = {}) {
    if (approvalRequested || hasOwnContent) return false;
    if (TOOL_RUN_UNFOLDABLE_TOOLS.has(normalizeString(toolName))) return false;
    return !TOOL_RUN_BREAK_STATUSES.has(toolRunStatus(status));
  }

  /**
   * Group row roles into runs. entries: [{ role: 'member' | 'transparent' |
   * 'break', breakBefore?: boolean }]. Transparent rows (reasoning, visually
   * empty rows) neither start nor break a run; the ones between two members
   * belong to it (`interior`). Returns runs of two or more members only.
   */
  function groupToolRuns(entries) {
    const runs = [];
    let current = null;
    let pendingTransparent = [];
    const close = () => {
      if (current && current.members.length >= 2) runs.push(current);
      current = null;
      pendingTransparent = [];
    };
    (Array.isArray(entries) ? entries : []).forEach((entry, index) => {
      if (entry && entry.breakBefore) close();
      const role = entry && entry.role;
      if (role === 'member') {
        if (current) current.interior.push(...pendingTransparent);
        else current = { members: [], interior: [] };
        pendingTransparent = [];
        current.members.push(index);
      } else if (role === 'transparent') {
        if (current) pendingTransparent.push(index);
      } else {
        close();
      }
    });
    close();
    return runs;
  }

  function toolRunVerbPhrase(verb, count, toolLabel) {
    switch (verb) {
      case 'read': return jtn('chat.toolRun.read', count, null, 'read a file', 'read {count} files');
      case 'list': return jtn('chat.toolRun.list', count, null, 'listed a folder', 'listed {count} folders');
      case 'search': return jtn('chat.toolRun.search', count, null, 'searched once', 'searched {count} times');
      case 'edit': return jtn('chat.toolRun.edit', count, null, 'edited a file', 'edited {count} files');
      case 'run': return jtn('chat.toolRun.run', count, null, 'ran a command', 'ran {count} commands');
      case 'web': return jtn('chat.toolRun.web', count, null, 'searched the web', 'searched the web {count} times');
      case 'fetch': return jtn('chat.toolRun.fetch', count, null, 'fetched a page', 'fetched {count} pages');
      case 'git': return jtn('chat.toolRun.git', count, null, 'checked Git', 'checked Git {count} times');
      case 'checklist': return jtn('chat.toolRun.checklist', count, null, 'updated the checklist', 'updated the checklist {count} times');
      default: return jtn('chat.toolRun.used', count, { tool: toolLabel }, 'used {tool}', 'used {tool} {count} times');
    }
  }

  /**
   * Reduce run members to the summary model. members: [{ tool, toolLabel,
   * status, isError, durationMs, label, startedAtMs }].
   */
  function summarizeToolRun(members) {
    const list = Array.isArray(members) ? members.filter(Boolean) : [];
    const verbs = new Map();
    let failedCount = 0;
    let durationMs = 0;
    let liveMember = null;
    let doneCount = 0;
    list.forEach((member) => {
      const verb = toolRunVerb(member.tool);
      const toolLabel = normalizeString(member.toolLabel) || getToolDisplayName(member.tool);
      const key = verb || `used:${toolLabel}`;
      const entry = verbs.get(key) || { verb, toolLabel, count: 0 };
      entry.count += 1;
      verbs.set(key, entry);
      const status = toolRunStatus(member.status);
      // A step a patch moved to an approval wait is not done: the next
      // structural render splits it out of the run.
      if (isToolRunLiveStatus(status) || TOOL_RUN_BREAK_STATUSES.has(status)) {
        liveMember = member;
      } else {
        doneCount += 1;
      }
      if (isToolRunMemberFailed(member, status)) failedCount += 1;
      const ms = Number(member.durationMs);
      if (Number.isFinite(ms) && ms > 0) durationMs += ms;
    });
    const last = list[list.length - 1];
    const phrases = Array.from(verbs.values()).map((entry) => toolRunVerbPhrase(entry.verb, entry.count, entry.toolLabel));
    const joined = phrases.join(jt('chat.toolRun.separator', ', '));
    return {
      memberCount: list.length,
      sentence: joined ? joined.charAt(0).toLocaleUpperCase() + joined.slice(1) : '',
      failedCount,
      lastFailed: !liveMember && Boolean(last) && isToolRunMemberFailed(last, toolRunStatus(last.status)),
      live: Boolean(liveMember),
      liveLabel: liveMember ? (normalizeString(liveMember.label) || normalizeString(liveMember.toolLabel)) : '',
      liveStartedAtMs: liveMember ? Number(liveMember.startedAtMs) || 0 : 0,
      doneCount,
      durationMs,
    };
  }

  function toolRunState(summary) {
    if (summary && summary.live) return 'live';
    return summary && summary.lastFailed ? 'failed' : 'ok';
  }

  function formatToolRunDuration(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value <= 0) return '';
    if (value < 1000) return `${Math.round(value)}ms`;
    if (value < 60000) return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}s`;
    const totalSeconds = Math.round(value / 1000);
    return `${Math.floor(totalSeconds / 60)}m ${String(totalSeconds % 60).padStart(2, '0')}s`;
  }

  /**
   * Inner markup of the summary row's toggle, in the one-liner grammar:
   * dot · sentence (or the live step, shimmering) · failed count · meta · caret.
   * While live, the meta carries a ticking elapsed node for the running step
   * (renderer-turn-elapsed-clock scans [data-turn-elapsed]).
   */
  function buildToolRunToggleInner(summary, helpers) {
    const esc = helpers && typeof helpers.escapeHtml === 'function' ? helpers.escapeHtml : _stringUtils.escapeHtml;
    const model = summary || {};
    const state = toolRunState(model);
    const tone = state === 'live' ? 'active' : (state === 'failed' ? 'error' : 'ok');
    const text = model.live && model.liveLabel ? model.liveLabel : model.sentence;
    const textClass = `tool-run-summary${model.live ? ' shimmer-active' : ''}`;
    let metaMarkup;
    if (model.live) {
      const clock = globalThis.rendererTurnElapsedClock
        || (typeof require === 'function' ? require('./renderer-turn-elapsed-clock') : null);
      const now = helpers && typeof helpers.now === 'function' ? helpers.now() : Date.now();
      const done = model.doneCount > 0
        ? `<span class="tool-call-meta">${esc(jt('chat.toolRun.done', '{count} done', { count: model.doneCount }))}</span>`
        : '';
      const elapsed = model.liveStartedAtMs > 0 && clock && typeof clock.formatElapsedLabel === 'function'
        ? `<span class="tool-result-duration" data-turn-elapsed="true" data-elapsed-started-at="${esc(model.liveStartedAtMs)}" data-elapsed-running="true">${esc(clock.formatElapsedLabel(Math.max(0, now - model.liveStartedAtMs)))}</span>`
        : '';
      metaMarkup = done + elapsed;
    } else {
      const duration = formatToolRunDuration(model.durationMs);
      metaMarkup = duration ? `<span class="tool-result-duration">${esc(duration)}</span>` : '';
    }
    const failedMarkup = model.failedCount > 0
      ? `<span class="tool-run-failed">${esc(jt('chat.toolRun.failed', '{count} failed', { count: model.failedCount }))}</span>`
      : '';
    return `<span class="status-dot status-dot--${tone}" aria-hidden="true"></span>`
      + `<span class="${textClass}">${esc(text)}</span>`
      + failedMarkup
      + `<span class="tool-call-status-cluster">${metaMarkup}<span class="tool-call-disclosure" aria-hidden="true"></span></span>`;
  }

  // Member rows carry their descriptor as data-run-* attributes: the row-list
  // builder writes them and the live patch lane reads them back.
  function buildToolRunMemberAttributes(member, escapeHtml) {
    const esc = typeof escapeHtml === 'function' ? escapeHtml : _stringUtils.escapeHtml;
    const model = member || {};
    return `data-run-member="step" data-run-tool="${esc(model.tool)}" data-run-tool-label="${esc(model.toolLabel)}"`
      + ` data-run-label="${esc(model.label)}" data-run-duration-ms="${esc(String(Number(model.durationMs) || 0))}"`;
  }

  function readToolRunMemberAttributes(node) {
    return {
      tool: node.getAttribute('data-run-tool') || '',
      toolLabel: node.getAttribute('data-run-tool-label') || '',
      label: node.getAttribute('data-run-label') || '',
      durationMs: Number(node.getAttribute('data-run-duration-ms')) || 0,
    };
  }

  // The summary row and member rows of one run inside a .turn-row-list.
  function getToolRunRows(scope, runId) {
    if (!runId || typeof scope?.querySelectorAll !== 'function') return [];
    return Array.from(scope.querySelectorAll('.chat-row[data-run-id]'))
      .filter((node) => node.getAttribute('data-run-id') === runId);
  }

  function isToolRunLiveStatus(status) {
    return TOOL_RUN_LIVE_STATUSES.has(toolRunStatus(status));
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
    getResultStatusLabel,
    normalizeToolStatus,
    isFileOperationSettledStatus,
    classifyToolResultOutcome,
    statusForToolResult,
    readToolExitCode,
    readToolTimedOut,
    summarizeToolFailure,
    isSessionToolBudgetBlock,
    getToolStatusSeverity,
    shouldAutoExpandToolDetails,
    buildToolRowKey,
    toolRowKeySessionPrefix,
    isToolRunFoldable,
    groupToolRuns,
    summarizeToolRun,
    toolRunState,
    toolRunVerb,
    formatToolRunDuration,
    buildToolRunToggleInner,
    buildToolRunMemberAttributes,
    readToolRunMemberAttributes,
    getToolRunRows,
    isToolRunLiveStatus,
    buildToolRowDomToken,
    statusToneFor,
    buildToolHeaderInner,
    getToolLineCounts,
    getTrustedToolResultImageUrls,
    resolveProjectedRowCallId,
  };
});
