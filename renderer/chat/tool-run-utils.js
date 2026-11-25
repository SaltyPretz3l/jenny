/* renderer/chat/tool-run-utils.js owns tool runs (row 21) and the steps heading
 * (row 192): folding, grouping, summary sentence and state, toggle markup and
 * the member stamps the live patch lane reads back. tool-call-utils.js binds
 * it at factory time (vocabulary, i18n) and re-exports it. */
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

    // ── Tool runs (row 21) ── Two or more consecutive steps fold into one
    // summary row; render and patch lanes both reduce through summarizeToolRun.
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
      'workspace_present', 'preview_test', 'session_spawn', 'delegate', 'subagent_run', 'subagent_batch', 'home', 'project_notes', 'memory', 'propose_git_action', 'propose_command', 'propose_session', 'complete_session_handoff', 'report_findings', 'suggest_next_step',
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
     * Whether a step may join a run. A step ever gated stays its own row in an
     * Answers run (no jump when the approval resolves); under the steps heading
     * (scope 'ledger') it folds like any other, its answer on its own row.
     */
    function isToolRunFoldable({ toolName, status, approvalRequested, hasOwnContent, scope } = {}) {
      if ((approvalRequested && scope !== 'ledger') || hasOwnContent) return false;
      if (TOOL_RUN_UNFOLDABLE_TOOLS.has(normalizeString(toolName))) return false;
      return !TOOL_RUN_BREAK_STATUSES.has(toolRunStatus(status));
    }

    /**
     * Group roles ('member' | 'transparent' | 'break', breakBefore?) into runs
     * of two or more members. Transparent rows neither start nor break a run;
     * those between two members are its `interior`.
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

    // Member rows carry their descriptor as data-run-* attributes (data-ledger-*
    // under the steps heading): the row-list builder writes them and the live
    // patch lane reads them back.
    function buildToolRunMemberAttributes(member, escapeHtml, prefix = 'run') {
      const esc = typeof escapeHtml === 'function' ? escapeHtml : defaultEscapeHtml;
      const model = member || {};
      const p = prefix === 'ledger' ? 'ledger' : 'run';
      return `data-${p}-member="step" data-${p}-tool="${esc(model.tool)}" data-${p}-tool-label="${esc(model.toolLabel)}"`
        + ` data-${p}-label="${esc(model.label)}" data-${p}-duration-ms="${esc(String(Number(model.durationMs) || 0))}"`;
    }

    function readToolRunMemberAttributes(node, prefix = 'run') {
      const p = prefix === 'ledger' ? 'ledger' : 'run';
      return {
        tool: node.getAttribute(`data-${p}-tool`) || '',
        toolLabel: node.getAttribute(`data-${p}-tool-label`) || '',
        label: node.getAttribute(`data-${p}-label`) || '',
        durationMs: Number(node.getAttribute(`data-${p}-duration-ms`)) || 0,
      };
    }

    // ── Steps heading (row 192; Thinking, Everything) ── One heading per turn
    // decides which flat rows are in view (data-ledger-show); text stays put and
    // the steps between notes fold into run lines (C15). Render, toggles and
    // patch lane share these reducers.

    /**
     * What a closed heading keeps in view. members, in list order: [{ kind:
     * 'step' | 'note' | 'run', pinned, text, inRun }]. Pinned rows (open card,
     * own content, opened, text) always; a settled turn with no text folds
     * whole; else run lines, lone steps and a run's rows (while it is open), and
     * while live the thinking after the last step.
     */
    function workLedgerTail(members, live) {
      const list = Array.isArray(members) ? members : [];
      const tail = list.map((member) => Boolean(member && member.pinned));
      if (live !== true && !list.some((member) => member && member.text)) return tail;
      let stepSeen = false;
      for (let index = list.length - 1; index >= 0; index -= 1) {
        const member = list[index];
        if (!member) continue;
        if (member.kind === 'step') stepSeen = true;
        tail[index] ||= member.kind !== 'note' || Boolean(member.inRun) || (live === true && !stepSeen);
      }
      return tail;
    }

    // A member in view, and nested one indent in (a step of an opened run line).
    function workLedgerShow(member, expanded) {
      if (expanded) return { show: member.kind !== 'run', nested: false };
      const open = Boolean(member.inRun && member.runExpanded && member.tail);
      return member.inRun ? { show: open, nested: open } : { show: Boolean(member.tail), nested: false };
    }

    // Re-derives a member row's view from its stamps; true when one changed.
    function applyWorkLedgerShow(node, expanded, tail = node.getAttribute('data-ledger-tail') === 'true') {
      const view = workLedgerShow({ kind: node.getAttribute('data-ledger-member'), tail, inRun: node.hasAttribute('data-run-member'),
        runExpanded: node.getAttribute('data-run-expanded') === 'true' }, expanded);
      let changed = false;
      for (const [name, on] of [['data-ledger-tail', tail], ['data-ledger-show', view.show], ['data-ledger-nested', view.nested]]) {
        if (on === (node.getAttribute(name) === 'true')) continue;
        if (on) node.setAttribute(name, 'true'); else node.removeAttribute(name);
        changed = true;
      }
      return changed;
    }

    /**
     * The heading model for a turn's steps (summarizeToolRun members).
     * context: { live, failed, startedAtMs }. state: live | waiting | ok | failed.
     */
    function summarizeWorkLedger(steps, context) {
      const ctx = context || {};
      const list = Array.isArray(steps) ? steps.filter(Boolean) : [];
      const summary = summarizeToolRun(list);
      const live = ctx.live === true;
      const waiting = live && list.some((member) => TOOL_RUN_BREAK_STATUSES.has(toolRunStatus(member.status)));
      const state = live ? (waiting ? 'waiting' : 'live') : (ctx.failed === true ? 'failed' : 'ok');
      return { ...summary, state, stepNumber: summary.doneCount + 1, startedAtMs: Number(ctx.startedAtMs) || 0 };
    }

    function workLedgerToggleTitle(expanded) {
      return expanded ? jt('chat.workLedger.hideSteps', 'Hide the steps') : jt('chat.workLedger.showSteps', 'Show every step');
    }

    /**
     * Inner markup of the heading's toggle: dot · lead · sentence · failed
     * count · time · caret. The lead says where the turn is ("Step 6", "Step 3
     * is waiting for you", "45 steps"); while the turn runs the time is a
     * ticking elapsed node (renderer-turn-elapsed-clock), once settled the
     * steps' total.
     */
    function buildWorkLedgerToggleInner(model, helpers) {
      const esc = helpers && typeof helpers.escapeHtml === 'function' ? helpers.escapeHtml : defaultEscapeHtml;
      const ledger = model || {};
      const tone = { live: 'active', waiting: 'pending', failed: 'muted' }[ledger.state] || 'ok';
      const running = ledger.state === 'live' || ledger.state === 'waiting';
      let lead;
      if (ledger.state === 'waiting') {
        lead = jt('chat.workLedger.stepWaiting', 'Step {count} is waiting for you', { count: ledger.stepNumber });
      } else if (ledger.state === 'live') {
        lead = jt('chat.workLedger.stepRunning', 'Step {count}', { count: ledger.stepNumber });
      } else {
        lead = jtn('chat.workLedger.steps', ledger.memberCount, { count: ledger.memberCount }, '1 step', '{count} steps');
      }
      const sentence = ledger.sentence
        ? `<span class="work-ledger-sep" aria-hidden="true"> · </span>${esc(ledger.sentence)}` : '';
      let metaMarkup;
      if (running) {
        const clock = globalThis.rendererTurnElapsedClock
          || (typeof require === 'function' ? require('./renderer-turn-elapsed-clock') : null);
        const now = helpers && typeof helpers.now === 'function' ? helpers.now() : Date.now();
        metaMarkup = ledger.startedAtMs > 0 && clock && typeof clock.formatElapsedLabel === 'function'
          ? `<span class="tool-result-duration" data-turn-elapsed="true" data-elapsed-started-at="${esc(ledger.startedAtMs)}" data-elapsed-running="true">${esc(clock.formatElapsedLabel(Math.max(0, now - ledger.startedAtMs)))}</span>`
          : '';
      } else {
        const duration = formatToolRunDuration(ledger.durationMs);
        metaMarkup = duration ? `<span class="tool-result-duration">${esc(duration)}</span>` : '';
      }
      const failedMarkup = ledger.failedCount > 0
        ? `<span class="tool-run-failed">${esc(jt('chat.toolRun.failed', '{count} failed', { count: ledger.failedCount }))}</span>`
        : '';
      return `<span class="status-dot status-dot--${tone}" aria-hidden="true"></span>`
        + `<span class="tool-run-summary"><span class="work-ledger-lead">${esc(lead)}</span>${sentence}</span>`
        + failedMarkup
        + `<span class="tool-call-status-cluster">${metaMarkup}<span class="tool-call-disclosure" aria-hidden="true"></span></span>`;
    }

    // ── Steps heading rows (row 192): which rows of a turn are its work, and the heading row itself ──
    const LEDGER_NOTE_PHASES = new Set(['commentary', 'intermediate']);
    const LEDGER_STOP_STATES = new Set(['cancelled', 'interrupted', 'abandoned']);

    // What one entry is to the heading: a 'step' (a tool row), a 'note'
    // (thinking, an orphan result, an approval row, mid-turn text: pinned, C15),
    // 'prose' (text with no phase: a note only before the last step), or null
    // (the answer, an error card, anything else that is not the work).
    function describeLedgerEntry(entry, host) {
      const { normalizeId, readMarkupAttribute } = host;
      const row = entry.row;
      const kind = normalizeId(row && row.kind);
      if (kind === 'tool_call' || kind === 'tool_step') {
        const tool = host.readToolEntry(entry);
        const rowKey = readMarkupAttribute(tool.toolTag, 'data-tool-row-key');
        // A row the user opened (or search revealed) stays in view, so opening one never folds it away.
        const opened = Boolean(rowKey) && host.getExpansion(rowKey) === true;
        return {
          kind: 'step',
          pinned: opened || !isToolRunFoldable({ ...tool.fold, scope: 'ledger' }),
          status: tool.fold.status,
          member: tool.member,
          startedAtMs: Number(tool.payload.running_started_at_ms) || 0,
        };
      }
      if (kind === 'approval_gap') {
        const empty = entry.markup.slice(0, entry.markup.indexOf('>') + 1).includes('data-row-visually-empty="true"');
        const status = readMarkupAttribute(entry.markup, 'data-approval-status');
        // An open card (or one paused for Resume) is always in view; an answered one renders empty.
        return { kind: 'note', pinned: empty || status === 'pending' || status === 'paused' };
      }
      if (kind === 'reasoning' || kind === 'tool_result') return { kind: 'note' };
      if (kind === 'assistant_text') {
        const phase = normalizeId(row.assistant_phase);
        if (phase === 'final_answer' || /^[^>]*data-assistant-lead-in="true"/.test(entry.markup)) return null;
        const text = !/^[^>]*data-row-visually-empty="true"/.test(entry.markup);
        return { kind: LEDGER_NOTE_PHASES.has(phase) ? 'note' : 'prose', text, pinned: text };
      }
      return null;
    }

    // A settled turn reads failed or stopped when it carries an error card, or
    // when it ends on a stopped step with no reply after it.
    function isLedgerTurnFailed(entries, lastStepStatus, lastStepIndex, normalizeId) {
      const rowOf = (entry) => entry.row || {};
      if (entries.some((entry) => normalizeId(rowOf(entry).kind) === 'system_notice'
        && normalizeId(rowOf(entry).payload && rowOf(entry).payload.subkind) === 'assistant_error')) return true;
      const answered = entries.some((entry, index) => index > lastStepIndex && normalizeId(rowOf(entry).kind) === 'assistant_text');
      return !answered && LEDGER_STOP_STATES.has(normalizeId(lastStepStatus).toLowerCase());
    }

    // The running heading's elapsed anchor: the earliest step start or message time of the turn's work.
    function ledgerStartedAtMs(entries, memberIndexes, descriptors, messageById, normalizeId) {
      let earliest = 0;
      const consider = (ms) => { if (ms > 0 && (!earliest || ms < earliest)) earliest = ms; };
      for (const index of memberIndexes) {
        consider(descriptors[index].startedAtMs || 0);
        const message = messageById && typeof messageById.get === 'function'
          ? messageById.get(normalizeId(entries[index].row && entries[index].row.primary_message_id)) : null;
        consider(Date.parse(String(message && message.timestamp || '')) || 0);
      }
      return earliest;
    }

    // The heading row, emitted first; members are stamped data-ledger-*. Only a
    // whole turn of the projected chat timeline gets one (turnId +
    // projectionContext), never a single-row re-render or another list. `runs`:
    // groupToolRuns runs with `expanded`; their summary rows get runStamps.
    function buildWorkLedger(entries, renderOptions, messageById, host, runs = []) {
      const { normalizeId, escapeHtml, getExpansion } = host;
      const view = normalizeId(renderOptions.transcriptView);
      const turnId = normalizeId(renderOptions.turnId);
      if (view === 'answers' || !turnId || !renderOptions.projectionContext) return null;
      const descriptors = entries.map((entry) => describeLedgerEntry(entry, host));
      const lastStep = descriptors.reduce((last, descriptor, index) => (descriptor && descriptor.kind === 'step' ? index : last), -1);
      if (lastStep < 0) return null;
      const memberIndexes = descriptors.reduce((list, descriptor, index) => {
        if (descriptor && (descriptor.kind !== 'prose' || index < lastStep)) list.push(index);
        return list;
      }, []);
      const members = memberIndexes.map((index) => ({ ...descriptors[index], kind: descriptors[index].kind === 'step' ? 'step' : 'note' }));
      const live = renderOptions.turnLive === true;
      const startedAtMs = live ? ledgerStartedAtMs(entries, memberIndexes, descriptors, messageById, normalizeId) : 0;
      const model = summarizeWorkLedger(members.filter((member) => member.kind === 'step').map((member) => member.member), {
        live, startedAtMs, failed: !live && isLedgerTurnFailed(entries, descriptors[lastStep].status, lastStep, normalizeId),
      });
      const key = host.buildToolRowKey({ sessionId: renderOptions.sessionId, turnId, rowId: 'work_ledger' });
      const override = getExpansion(key);
      const expanded = override === undefined ? view === 'everything' : override === true;
      const runOf = new Map();
      runs.forEach((run) => [...run.members, ...run.interior].forEach((index) => runOf.set(index, run)));
      // List order: a run line sits right before its first step.
      const rows = [];
      memberIndexes.forEach((index, position) => {
        const run = runOf.get(index);
        if (run && run.members[0] === index) rows.push({ kind: 'run', run });
        rows.push({ ...members[position], index, inRun: Boolean(run), runExpanded: Boolean(run && run.expanded) });
      });
      const tail = workLedgerTail(rows, live);
      const stampByIndex = new Map();
      const runStamps = new Map();
      rows.forEach((row, position) => {
        const shown = workLedgerShow({ ...row, tail: tail[position] }, expanded);
        const attrs = [row.kind === 'step'
          ? buildToolRunMemberAttributes(row.member, escapeHtml, 'ledger') : `data-ledger-member="${row.kind}"`];
        if (row.pinned) attrs.push('data-ledger-pin="true"');
        if (tail[position]) attrs.push('data-ledger-tail="true"');
        if (shown.show) attrs.push('data-ledger-show="true"');
        if (shown.nested) attrs.push('data-ledger-nested="true"');
        if (row.kind === 'run') runStamps.set(row.run.members[0], attrs.join(' '));
        else stampByIndex.set(row.index, attrs.join(' '));
      });
      const rowId = `${turnId}:work_ledger`;
      const expandedText = expanded ? 'true' : 'false';
      const startedAttr = startedAtMs > 0 ? ` data-ledger-started-at="${escapeHtml(String(startedAtMs))}"` : '';
      return {
        stampByIndex,
        runStamps,
        rowId,
        markup: `<div class="chat-row" data-row-id="${escapeHtml(rowId)}" data-row-kind="work_ledger" data-ledger-expanded="${expandedText}" data-ledger-state="${model.state}" data-ledger-step="${model.stepNumber}"${startedAttr}>`
          + `<div class="tool-run-row work-ledger" data-tool-run-state="${model.state === 'failed' ? 'ok' : model.state}">`
          + `<div class="tool-run-toggle" role="button" tabindex="0" data-tool-run-toggle="true" data-tool-run-key="${escapeHtml(key)}" aria-expanded="${expandedText}" title="${escapeHtml(workLedgerToggleTitle(expanded))}">`
          + `${buildWorkLedgerToggleInner(model, { escapeHtml })}</div></div></div>`,
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
      workLedgerTail, workLedgerShow, applyWorkLedgerShow, summarizeWorkLedger, workLedgerToggleTitle, buildWorkLedgerToggleInner, buildWorkLedger,
    };
  }

  return { createToolRunUtils };
});
