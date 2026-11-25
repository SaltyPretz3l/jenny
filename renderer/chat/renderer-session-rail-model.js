/* renderer/chat/renderer-session-rail-model.js - the session rail's pure model (UMD).

   Row 195 (side panels). No DOM, no I/O: given the C2 summary (`chatWorkspace.getSummary`), the persisted
   workspace view and the injected run and checklist readers it returns the section view models the renderer
   paints. At most four sections, in this order:

   - This chat          project and run mode, folder, branch (the summary's environment).
   - Context            "{n}% full", then Used, one plain line and the way into Context details.
   - Running now        present only while something runs. Its rows come from the injected getRunningRows (the
                        Runs tab's own list); with none injected they are built from the summary's running items.
   - Jenny's checklist  present only when getChecklist returns steps.

   Checking, unavailable and stale are muted words, never zero. Unknown is never 0. A summary that belongs to
   another session is never shown (it reads as checking). Disclosure defaults apply only where the persisted
   disclosure is null; a section's persisted key is the service's own (PERSIST_KEY) and the checklist has none,
   so its fold lasts for the pane only.

   Copy goes through jt('sessionRail.*' | 'chat.sessionRail.*', 'English default'). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-context-preview'));
    return;
  }
  root.rendererSessionRailModel = factory(root.rendererContextPreview);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (contextPreview) {
  'use strict';

  const SECTION_KEYS = Object.freeze(['this_chat', 'context', 'running_now', 'checklist']);
  const SUMMARY_KEYS = Object.freeze(['environment', 'context', 'background_tasks']); // the summary sections this rail reads
  const SUMMARY_FIELD = Object.freeze({ this_chat: 'environment', context: 'context' });
  // The key the service persists a section's disclosure under (services/backend/session-coordination-records.js).
  const PERSIST_KEY = Object.freeze({ this_chat: 'environment', context: 'context', running_now: 'background_tasks' });
  const DISCLOSURE_KEYS = SECTION_KEYS;
  const CONTEXT_WARN_RATIO = 0.8;
  const MAX_RUNNING_ROWS = 8;
  const MAX_CHECKLIST_ROWS = 50;
  const RUN_KINDS = Object.freeze(['server', 'command', 'helper', 'linked', 'test', 'live']);
  const CHECKLIST_STATES = Object.freeze(['done', 'now', 'todo']);

  function fallbackJt(key, fallback, params) {
    return params
      ? String(fallback).replace(/\{(\w+)\}/g, (match, name) => (Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match))
      : String(fallback);
  }

  function defaultJt() {
    const i18n = typeof globalThis !== 'undefined' ? globalThis.jennyI18n : null;
    return (i18n && typeof i18n.t === 'function') ? i18n.t.bind(i18n) : fallbackJt;
  }

  function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function count(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  function text(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  /* ── Words ───────────────────────────────────────────────────────────── */

  function formatTokens(value) {
    const n = count(value);
    if (n === null) return '';
    if (n < 1000) return String(n);
    const unit = n >= 1000000 ? 1000000 : 1000;
    const suffix = unit === 1000000 ? 'M' : 'k';
    const scaled = n / unit;
    const digits = scaled >= 100 ? 0 : 1;
    return `${scaled.toFixed(digits).replace(/\.0$/, '')}${suffix}`;
  }

  /* Percent of the auto-compact point when the next-send estimate carries one, else of the
     window: the composer ring uses the same projection and the same rounding (row 63). */
  function contextPercent(data) {
    const { used, target } = contextPreview.project(data);
    if (used === null || !target) return null;
    return contextPreview.formatPercent(used, target);
  }

  function runModeLabel(mode, jt, fullAuto) {
    const token = text(mode).toLowerCase();
    if (fullAuto === true || token === 'full_auto') return jt('sessionRail.fullAuto', 'Full auto');
    if (!token) return '';
    if (token === 'ask') return jt('composer.runMode.ask', 'Ask');
    if (token === 'auto') return jt('composer.runMode.auto', 'Auto');
    if (token === 'plan') return jt('composer.runMode.plan', 'Plan');
    return token.charAt(0).toUpperCase() + token.slice(1);
  }

  function executionLabel(value, jt) {
    const token = text(value).toLowerCase();
    if (token === 'local') return jt('chat.sessionRail.environment.local', 'Local');
    if (token === 'sandbox') return jt('chat.sessionRail.environment.sandbox', 'Sandbox');
    if (token === 'hosted') return jt('chat.sessionRail.environment.hosted', 'Hosted');
    return '';
  }

  const TASK_STATES = Object.freeze({
    running: ['running', 'active', 'in_progress', 'started', 'killing'],
    waiting: ['waiting', 'queued', 'pending', 'paused'],
    failed: ['failed', 'error', 'errored', 'timed_out'],
    attention: ['needs_attention', 'attention'],
    finished: ['completed', 'complete', 'finished', 'succeeded', 'success', 'done', 'cancelled', 'canceled', 'stopped'],
  });

  function taskPhase(state) {
    const token = text(state).toLowerCase();
    for (const phase of Object.keys(TASK_STATES)) {
      if (TASK_STATES[phase].includes(token)) return phase;
    }
    return 'unknown';
  }

  function taskPhaseLabel(phase, jt) {
    if (phase === 'running') return jt('chat.sessionRail.tasks.stateRunning', 'Running');
    if (phase === 'waiting') return jt('chat.sessionRail.tasks.stateWaiting', 'Waiting');
    if (phase === 'failed') return jt('chat.sessionRail.tasks.stateFailed', 'Failed');
    if (phase === 'attention') return jt('chat.sessionRail.tasks.stateAttention', 'Needs attention');
    if (phase === 'finished') return jt('chat.sessionRail.tasks.stateFinished', 'Finished');
    return jt('chat.sessionRail.state.unknown', 'Unknown');
  }

  /* A live run's state in words (an early end names its exit code); the task phase word when the run state is not one of them. */
  function liveStateWord(runState, exitCode, phase, jt) {
    switch (runState) {
      case 'building': return jt('runs.liveState.building', 'Building');
      case 'starting': return jt('runs.liveState.starting', 'Starting');
      case 'no_window': return jt('runs.liveState.no_window', 'No window yet');
      case 'running': return jt('runs.liveState.running', 'Running');
      case 'minimized': return jt('runs.liveState.minimized', 'Minimized');
      case 'stopping': return jt('runs.liveState.stopping', 'Stopping');
      case 'close_refused': return jt('runs.liveState.close_refused', 'Waiting to close');
      case 'build_failed': return jt('runs.liveState.build_failed', 'Build failed');
      case 'ended_early': {
        const word = jt('runs.liveState.ended_early', 'Ended early');
        return exitCode == null ? word : `${word} · ${jt('runs.liveExit', 'exit {code}', { code: exitCode })}`;
      }
      case 'closed': return jt('runs.liveState.closed', 'Closed');
      default: return taskPhaseLabel(phase, jt);
    }
  }

  function taskSourceLabel(kind, jt) {
    const token = text(kind);
    if (token === 'workspace_test') return jt('chat.sessionRail.tasks.sourceWorkspaceTest', 'Workspace tests');
    if (token === 'session_runtime') return jt('chat.sessionRail.tasks.sourceSessionRuntime', 'Session run');
    if (token === 'linked_chat_turn') return jt('chat.sessionRail.tasks.sourceLinkedChat', 'Linked chat');
    if (token === 'live_run') return jt('chat.sessionRail.tasks.sourceLiveRun', 'Live tab program');
    return jt('chat.sessionRail.tasks.sourceOther', 'Task');
  }

  function sectionTitle(key, jt) {
    switch (key) {
      case 'this_chat': return jt('sessionRail.thisChat', 'This chat');
      case 'context': return jt('chat.sessionRail.section.context', 'Context');
      case 'checklist': return jt('sessionRail.checklist', "Jenny's checklist");
      default: return jt('sessionRail.runningNow', 'Running now');
    }
  }

  function taskDot(phase) {
    if (phase === 'running') return { tone: 'active', pulse: true };
    if (phase === 'waiting') return { tone: 'pending', pulse: false };
    if (phase === 'failed') return { tone: 'error', pulse: false };
    if (phase === 'attention') return { tone: 'warn', pulse: false };
    return null;
  }

  /* mm:ss, or h:mm:ss past an hour: a running job's elapsed time. */
  function formatElapsed(ms) {
    const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const hours = Math.floor(total / 3600);
    const pad = (value) => String(value).padStart(2, '0');
    const clock = `${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
    return hours > 0 ? `${hours}:${clock}` : clock;
  }

  const bareAddress = (url) => text(url).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/$/, '');

  /* ── Summary sections ────────────────────────────────────────────────── */

  /* Every builder returns { valueText, parts?, dot?, rows, defaultOpen }. */
  function buildThisChat(data, jt, extra) {
    const rows = [];
    const projectName = text(data.project_name) || jt('chat.sessionRail.environment.noProject', 'No project');
    rows.push({
      kind: 'action', key: 'project', icon: 'project', surface: 'environment', resourceRef: '',
      text: projectName, meta: runModeLabel(data.run_mode, jt, extra.fullAuto), title: projectName,
    });
    const displayPath = text(data.display_path);
    if (displayPath) rows.push({ kind: 'fact', key: 'path', icon: 'folder', text: displayPath, meta: '', title: displayPath, pathLike: true });
    const branch = text(data.branch);
    if (branch) {
      const worktree = text(data.worktree_id) ? jt('chat.sessionRail.environment.worktree', 'worktree') : '';
      rows.push({ kind: 'fact', key: 'branch', icon: 'branch', text: branch, meta: worktree, title: branch });
    }
    // A really partial summary keeps one plain note; a complete one says nothing.
    if (extra.partial === true) rows.push({ kind: 'note', key: 'coverage', text: jt('chat.sessionRail.tasks.partial', "Some sources aren't connected yet.") });
    return { valueText: executionLabel(data.execution_environment, jt), parts: null, dot: null, rows, defaultOpen: true };
  }

  /* Opened, Context shows exactly: Used (as "20.5k of 32k"), one plain line, and the way into the details
     view, which keeps the token ledger. Nothing used yet reads in one voice. */
  function buildContext(data, jt) {
    const used = count(data.used_tokens);
    const percent = contextPercent(data);
    const projection = contextPreview.project(data);
    const capacity = projection.target || count(data.capacity_tokens);
    let valueText;
    let dot = null;
    if (percent !== null) {
      valueText = jt('sessionRail.contextFull', '{percent}% full', { percent: percent.replace(/%$/, '') });
      if (used / projection.target >= CONTEXT_WARN_RATIO) dot = { tone: 'warn', pulse: false };
    } else if (used !== null) {
      valueText = jt('chat.sessionRail.context.tokens', '{count} tokens', { count: formatTokens(used) });
    } else {
      valueText = data.status === 'unavailable' ? jt('chat.sessionRail.state.unavailable', 'Unavailable')
        : data.scope === 'next_send' ? jt('chat.sessionRail.state.checking', 'Checking…') : jt('chat.sessionRail.state.unknown', 'Unknown');
    }
    const rows = [];
    if (used === 0) {
      rows.push({ kind: 'note', key: 'empty', text: jt('sessionRail.contextEmpty', 'Nothing used yet. This fills as you and Jenny talk.') });
    } else {
      if (used !== null) {
        const meta = capacity
          ? jt('chat.sessionRail.context.usedOf', '{used} of {capacity}', { used: formatTokens(used), capacity: formatTokens(capacity) })
          : formatTokens(used);
        rows.push({ kind: 'fact', key: 'used', icon: '', text: jt('sessionRail.contextUsed', 'Used'), meta, title: meta });
      }
      rows.push({ kind: 'note', key: 'note', text: jt('sessionRail.contextNote', 'Jenny summarises older messages when this fills.') });
    }
    rows.push({ kind: 'action', key: 'details', icon: '', surface: 'context', resourceRef: '', text: jt('chat.sessionRail.context.details', 'Context details'), meta: '', title: '' });
    return { valueText, parts: null, dot, rows, defaultOpen: false };
  }

  const BUILDERS = { this_chat: buildThisChat, context: buildContext };

  function checkingSection(key, jt) {
    return { key, title: sectionTitle(key, jt), state: 'checking', stateWord: jt('chat.sessionRail.state.checking', 'Checking…'), valueText: jt('chat.sessionRail.state.checking', 'Checking…'), parts: null, dot: null, rows: [], defaultOpen: false, stale: false };
  }

  function unavailableSection(key, jt, state) {
    const word = state === 'not_applicable' ? jt('chat.sessionRail.state.notApplicable', 'Not applicable') : jt('chat.sessionRail.state.unavailable', 'Unavailable');
    return { key, title: sectionTitle(key, jt), state, stateWord: word, valueText: word, parts: null, dot: null, rows: [], defaultOpen: false, stale: false };
  }

  /* One summary section's view model from its wrapper. `extra`: { fullAuto, partial } for This chat. */
  function buildSection(key, wrapper, jt, extra) {
    if (!isObject(wrapper)) return checkingSection(key, jt);
    const state = text(wrapper.state);
    if (state === 'checking' && !(key === 'context' && wrapper.data?.scope === 'next_send')) return checkingSection(key, jt);
    if (state === 'available' || state === 'stale' || (key === 'context' && wrapper.data?.scope === 'next_send')) {
      if (!isObject(wrapper.data)) return unavailableSection(key, jt, 'unavailable');
      const built = BUILDERS[key](wrapper.data, jt, isObject(extra) ? extra : {});
      const stale = state === 'stale';
      const staleWord = jt('chat.sessionRail.state.stale', 'stale');
      return {
        key, title: sectionTitle(key, jt), state, stateWord: '',
        valueText: stale && built.valueText ? `${built.valueText} · ${staleWord}` : (stale ? staleWord : built.valueText),
        parts: built.parts, dot: stale ? null : built.dot, rows: built.rows, defaultOpen: built.defaultOpen, stale,
      };
    }
    return unavailableSection(key, jt, state === 'not_applicable' ? 'not_applicable' : 'unavailable');
  }

  /* ── Running now ─────────────────────────────────────────────────────── */

  function toMs(value) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /* The injected rows, normalised: { id, kind, label, detail, startedAt, canStop }, plus the optional
     sessionId (a linked chat), progressPercent and progressMarks (a test run's progress). */
  function normalizeRuns(list) {
    const seen = new Set();
    const out = [];
    for (const raw of Array.isArray(list) ? list : []) {
      const id = isObject(raw) ? text(raw.id) : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id, kind: RUN_KINDS.includes(raw.kind) ? raw.kind : 'helper', label: text(raw.label), detail: text(raw.detail),
        startedAt: toMs(raw.startedAt), canStop: raw.canStop === true, stopping: raw.stopping === true, sessionId: text(raw.sessionId),
        progressPercent: Number.isFinite(raw.progressPercent) ? raw.progressPercent : null,
        progressMarks: Array.isArray(raw.progressMarks) ? raw.progressMarks.filter(Number.isFinite) : [],
      });
    }
    return out;
  }

  /* With no getRunningRows wired: the summary's running items in the same shape. This is the only place the
     summary's task items are read for this section. */
  function summaryRuns(wrapper, jt) {
    const items = ['available', 'stale'].includes(text(wrapper?.state)) && Array.isArray(wrapper.data?.items) ? wrapper.data.items.filter(isObject) : [];
    const servers = [];
    const others = [];
    items.forEach((item, index) => {
      if (taskPhase(item.state) !== 'running') return;
      const source = text(item.source_kind);
      const opId = text(item.operation_id) || `row-${index}`;
      const stopping = text(item.state) === 'killing';
      if (source === 'background_job') {
        const jobId = text(item.job_id);
        const command = text(item.command) || jt('chat.backgroundJobs.backgroundJob', 'background job');
        const serving = Boolean(text(item.serving_url));
        const entry = {
          id: `job:${jobId}`, kind: serving ? 'server' : 'command', label: command, detail: serving ? bareAddress(item.serving_url) : '',
          startedAt: serving ? (Number(item.serving_since_ms) || Number(item.started_at_ms) || 0) : (Number(item.started_at_ms) || 0),
          canStop: Boolean(jobId), stopping, progressPercent: item.progress_percent, progressMarks: item.progress_marks,
        };
        (serving ? servers : others).push(entry);
      } else if (source === 'linked_chat_turn') {
        const child = text(item.session_id);
        others.push({ id: child ? `chat:${child}` : `task:${opId}`, kind: 'linked', label: text(item.title) || taskSourceLabel(source, jt), detail: '', sessionId: child, startedAt: toMs(item.started_at) });
      } else if (source === 'live_run') {
        const project = text(item.project_id);
        const detail = liveStateWord(text(item.run_state), Number.isInteger(item.exit_code) ? item.exit_code : null, 'running', jt);
        others.push({ id: project ? `live:${project}` : `task:${opId}`, kind: 'live', label: text(item.title) || taskSourceLabel(source, jt), detail, startedAt: toMs(item.started_at) });
      } else {
        others.push({ id: `task:${opId}`, kind: source === 'workspace_test' ? 'test' : 'helper', label: taskSourceLabel(source, jt), detail: '', startedAt: toMs(item.started_at) });
      }
    });
    servers.sort((a, b) => a.startedAt - b.startedAt);
    return normalizeRuns([...servers, ...others]);
  }

  const SERVER_DOT = Object.freeze({ tone: 'active', pulse: false });

  /* The chat's open browser page: a server-like row that closes itself (the only run the Runs list does not hold). */
  function browserRow(browser, jt) {
    const page = isObject(browser) && browser.open === true ? text(browser.url) : '';
    if (!page) return null;
    const name = text(browser.title) || bareAddress(page);
    return { kind: 'server', key: 'server:browser', serverKind: 'browser', dot: SERVER_DOT, text: name, meta: jt('chat.sessionRail.servers.browser', 'Browser'),
      title: `${name} (${page})`, surface: 'browser', resourceRef: '', stopLabel: jt('chat.sessionRail.servers.close', 'Close'),
      stopAria: jt('chat.sessionRail.servers.closeAria', 'Close the browser: {title}', { title: name }) };
  }

  function runRow(entry, jt, nowMs) {
    // A job, a chat or a Live tab program names its own task in the panel; any other run opens the list.
    const base = { key: `run:${entry.id}`, runId: entry.id, surface: 'background_tasks', resourceRef: /^(job|chat|live):/.test(entry.id) ? entry.id : '' };
    const jobId = entry.id.startsWith('job:') ? entry.id.slice(4) : '';
    const stoppable = entry.canStop && Boolean(jobId);
    const stop = {
      jobId, canStop: stoppable, stopping: entry.stopping, stopLabel: jt('chat.backgroundJobs.stop', 'Stop'),
      stopTitle: stoppable ? jt('chat.backgroundJobs.stopTitle', 'Stop this background job') : jt('sessionRail.cannotStop', 'This run cannot be stopped from here.'),
    };
    if (entry.kind === 'server') {
      const address = entry.detail || entry.label;
      const label = entry.label || address;
      return { ...base, ...stop, kind: 'server', serverKind: 'run', dot: SERVER_DOT, text: address, addr: true,
        metaPrefix: jt('sessionRail.serverUp', 'Up'), startedAtMs: entry.startedAt,
        title: label === address ? address : jt('chat.sessionRail.servers.jobTitle', '{command} on {address}', { command: label, address }),
        stopAria: jt('chat.sessionRail.servers.stopAria', 'Stop server: {address}', { address }) };
    }
    if (entry.kind === 'command') {
      const label = entry.label || jt('chat.backgroundJobs.backgroundJob', 'background job');
      return { ...base, ...stop, kind: 'job', dot: taskDot('running'), text: label, title: label, startedAtMs: entry.startedAt,
        meta: formatElapsed(nowMs - entry.startedAt), progressPercent: entry.progressPercent, progressMarks: entry.progressMarks,
        stopAria: jt('chat.backgroundJobs.stopAriaLabel', 'Stop background job: {command}', { command: label }) };
    }
    const label = entry.label || taskSourceLabel(entry.kind === 'linked' ? 'linked_chat_turn' : '', jt);
    const running = jt('sessionRail.running', 'Running');
    const meta = entry.kind === 'live' && entry.detail ? entry.detail : running; // the Live tab's program says its state (Building, Stopping)
    return { ...base, kind: 'action', icon: '', dot: taskDot('running'), text: label, meta, title: `${label} (${meta})`,
      ...(entry.kind === 'linked' && entry.sessionId ? { sessionRef: entry.sessionId } : {}) };
  }

  function buildRunningNow(entries, browser, jt, nowMs) {
    const page = browserRow(browser, jt);
    const total = entries.length + (page ? 1 : 0);
    if (!total) return null;
    const rows = [...(page ? [page] : []), ...entries.slice(0, MAX_RUNNING_ROWS).map((entry) => runRow(entry, jt, nowMs))];
    rows.push({ kind: 'action', key: 'all', icon: 'list', surface: 'background_tasks', resourceRef: '', allRuns: true, text: jt('sessionRail.allRuns', 'All runs'), meta: '', title: '' });
    return { key: 'running_now', title: sectionTitle('running_now', jt), state: 'available', stateWord: '', valueText: String(total), parts: null,
      dot: taskDot('running'), rows, defaultOpen: true, stale: false };
  }

  /* ── Jenny's checklist ───────────────────────────────────────────────── */

  function buildChecklist(list, jt) {
    const steps = (Array.isArray(list) ? list : []).filter((step) => isObject(step) && text(step.text)).slice(0, MAX_CHECKLIST_ROWS)
      .map((step) => ({ text: text(step.text), state: CHECKLIST_STATES.includes(step.state) ? step.state : 'todo' }));
    if (!steps.length) return null;
    const done = steps.filter((step) => step.state === 'done').length;
    const rows = steps.map((step, index) => ({
      kind: 'fact', key: `step:${index}`, icon: '', text: step.text, title: step.text,
      meta: step.state === 'done' ? jt('sessionRail.stepDone', 'Done') : (step.state === 'now' ? jt('sessionRail.stepNow', 'Now') : ''),
      ...(step.state === 'now' ? { dot: taskDot('running') } : {}),
    }));
    return { key: 'checklist', title: sectionTitle('checklist', jt), state: 'available', stateWord: '',
      valueText: jt('sessionRail.checklistDone', '{done} of {total} done', { done, total: steps.length }), parts: null, dot: null, rows, defaultOpen: true, stale: false };
  }

  /* Whether a section shows open in a built view model. */
  function isDisclosureOpen(vm, key) {
    return Boolean(vm.sections.find((entry) => entry.key === key)?.open);
  }

  /* Persisted disclosure where set, the section's default otherwise. */
  function resolveOpen(section, persisted, override) {
    if (override === true || override === false) return override;
    const persistKey = PERSIST_KEY[section.key];
    const value = persistKey && isObject(persisted) ? persisted[persistKey] : undefined;
    if (value === true || value === false) return value;
    return section.defaultOpen === true;
  }

  function safeCall(fn, sessionId) {
    if (typeof fn !== 'function') return null;
    try { return fn(sessionId); } catch (_error) { return null; }
  }

  /* The rail's whole view model.
       summary        the C2 summary, or null while checking / after a failed fetch
       status         'checking' | 'ready' | 'unavailable' (a failed fetch is unavailable)
       sessionId      the pane's session now; a summary for any other session reads as checking
       workspaceView  the persisted { disclosures, children_expanded }
       overrides      optimistic disclosure toggles not yet confirmed (key -> boolean)
       browser        the chat's browser { open, url, title }, or null (Running now lists it while open)
       fullAuto       full auto is armed for this chat (This chat names it as the run mode)
       getRunningRows (sessionId) -> [{ id, kind, label, detail, startedAt, canStop }]; absent: the summary's running items
       getChecklist   (sessionId) -> [{ text, state }]; absent: no checklist section
       nowMs          the clock for a running command's first elapsed reading */
  function buildRailViewModel({ summary, status = 'ready', sessionId = '', workspaceView = null, overrides = null, jt = defaultJt(), browser = null, fullAuto = false, getRunningRows = null, getChecklist = null, nowMs = Date.now() } = {}) {
    const belongs = isObject(summary) && text(summary.session_id) === text(sessionId) && text(sessionId) !== '';
    const view = isObject(workspaceView) ? workspaceView : {};
    const disclosures = isObject(view.disclosures) ? view.disclosures : {};
    const pending = isObject(overrides) ? overrides : {};
    const tasks = belongs ? summary.background_tasks : null;
    const tasksData = ['available', 'stale'].includes(text(tasks?.state)) && isObject(tasks.data) ? tasks.data : null;
    const extra = {
      fullAuto: fullAuto === true,
      partial: Boolean(tasksData && (tasksData.coverage === 'partial' || tasksData.unsupported_sources?.length > 0 || tasksData.failed_sources?.length > 0)),
    };
    const sections = ['this_chat', 'context'].map((key) => {
      if (belongs) return buildSection(key, summary[SUMMARY_FIELD[key]], jt, extra);
      return status === 'unavailable' ? unavailableSection(key, jt, 'unavailable') : checkingSection(key, jt);
    });
    // The Runs list answers with an array once it holds this chat's rows; until then (null) the summary's items stand in.
    const listed = typeof getRunningRows === 'function' ? safeCall(getRunningRows, sessionId) : null;
    const runs = Array.isArray(listed) ? normalizeRuns(listed) : (belongs ? summaryRuns(tasks, jt) : []);
    for (const built of [buildRunningNow(runs, browser, jt, nowMs), buildChecklist(safeCall(getChecklist, sessionId), jt)]) {
      if (built) sections.push(built);
    }
    return {
      sessionId: text(sessionId), status: belongs ? 'ready' : status,
      sections: sections.map((section) => ({ ...section, open: resolveOpen(section, disclosures, pending[section.key]) })),
    };
  }

  return {
    SECTION_KEYS,
    SUMMARY_KEYS,
    DISCLOSURE_KEYS,
    PERSIST_KEY,
    defaultJt,
    formatTokens,
    contextPercent,
    taskPhase,
    taskPhaseLabel,
    liveStateWord,
    taskDot,
    formatElapsed,
    isDisclosureOpen,
    buildSection,
    buildRailViewModel,
    bareAddress,
  };
});
