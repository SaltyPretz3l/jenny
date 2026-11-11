/* renderer/chat/tool-call-status.js owns the tool-call status vocabulary:
 * the status words and their labels, how a tool_result payload maps to a row
 * status and outcome, the shell exit-code and time-out readers, the collapsed
 * header's one-line failure text, and the severity / status-dot palette.
 * Loaded before tool-call-utils.js, which binds it at factory time (its i18n
 * reader and label clip) and re-exports it so consumers keep calling
 * toolCallUtils.normalizeToolStatus and related APIs. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.toolCallStatus = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createToolCallStatus(deps) {
    const { normalizeString, jt, clipLabel } = deps || {};
    if (typeof normalizeString !== 'function' || typeof jt !== 'function' || typeof clipLabel !== 'function') {
      throw new TypeError('normalizeString, jt and clipLabel must be functions');
    }

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

    // Only a call still waiting on the user opens itself. Finished rows — including
    // failures — stay collapsed like every other tool row; the status label and
    // severity tint already flag them, and a self-opening failure reflows the
    // transcript under the reader.
    const TOOL_AUTO_EXPAND_STATUSES = new Set(['awaiting_approval']);

    const TOOL_STATUS_SEVERITY = Object.freeze({
      errored: 'danger',
      timed_out: 'caution',
      interrupted: 'caution',
      abandoned: 'caution',
      denied: 'calm',
      cancelled: 'calm',
      blocked: 'calm',
    });

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
      // Row 87: a Jenny-chat rule refused the call before any card (metadata.rule_denied from the backend).
      if (normalized === 'denied' && result && result.metadata && result.metadata.rule_denied === true) {
        return jt('chat.toolCall.ruleDenied', 'Blocked by your rule');
      }
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
      return clipLabel(text);
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

    return {
      readToolExitCode, readToolTimedOut, getStatusLabel, getResultStatusLabel, normalizeToolStatus,
      isFileOperationSettledStatus, classifyToolResultOutcome, isSessionToolBudgetBlock, summarizeToolFailure,
      statusForToolResult, getToolStatusSeverity, shouldAutoExpandToolDetails, statusToneFor,
    };
  }

  return { createToolCallStatus };
});
