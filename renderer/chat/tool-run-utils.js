/* renderer/chat/tool-run-utils.js owns Answers-view tool runs (NEXT_STEPS
 * row 21): which steps may fold, how consecutive steps group, the summary
 * sentence and state, the toggle markup and the member descriptor attributes
 * the live patch lane reads back. Loaded before tool-call-utils.js, which
 * binds it at factory time (tool-kind and status vocabulary, i18n readers) and
 * re-exports it so consumers keep calling toolCallUtils.summarizeToolRun and
 * related APIs. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.toolRunUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createToolRunUtils(deps) {
    const {
      normalizeString, normalizeToolKind, normalizeToolStatus, getToolDisplayName,
      statusToneFor, formatToolDurationMs, escapeHtml: defaultEscapeHtml, jt, jtn,
    } = deps || {};
    if ([normalizeString, normalizeToolKind, normalizeToolStatus, getToolDisplayName, statusToneFor,
      formatToolDurationMs, jt, jtn].some((fn) => typeof fn !== 'function')) {
      throw new TypeError('tool-run-utils dependencies must be functions');
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
      browser: 'browser',
    });
    function toolRunVerb(name) {
      return TOOL_RUN_VERB_BY_KIND[normalizeToolKind(name)] || '';
    }
    // Rows that carry their own content (questions, plans, images, diagrams,
    // artifacts, spawned tasks, calendar blocks, notes rows, proposal cards) never fold into a run.
    const TOOL_RUN_UNFOLDABLE_TOOLS = new Set([
      'ask_user', 'exit_plan_mode', 'image_generate', 'mermaid_generate', 'create_artifact',
      'workspace_present', 'preview_test', 'session_spawn', 'delegate', 'home', 'project_notes', 'memory', 'propose_git_action', 'propose_command', 'propose_session', 'complete_session_handoff', 'report_findings', 'suggest_next_step',
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
        case 'browser': return jtn('browserUse.row.run', count, null, 'took a browser step', 'took {count} browser steps');
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
      if (!(Number.isFinite(value) && value >= 10000)) return formatToolDurationMs(value);
      if (value < 60000) return `${Math.round(value / 1000)}s`;
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
      const esc = helpers && typeof helpers.escapeHtml === 'function' ? helpers.escapeHtml : defaultEscapeHtml;
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
      const esc = typeof escapeHtml === 'function' ? escapeHtml : defaultEscapeHtml;
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

    return {
      isToolRunFoldable, groupToolRuns, summarizeToolRun, toolRunState, toolRunVerb, formatToolRunDuration,
      buildToolRunToggleInner, buildToolRunMemberAttributes, readToolRunMemberAttributes, getToolRunRows, isToolRunLiveStatus,
    };
  }

  return { createToolRunUtils };
});
