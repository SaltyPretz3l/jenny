/* renderer/features/renderer-background-tasks-panel-render.js - the Background tasks panel's markup (row 138, UMD).

   Pure: the task view models (this chat's background commands from backgroundJobs.getState and its linked chats
   from the chat workspace summary) and the strings the owner (renderer-background-tasks-panel.js) paints. Rows reuse
   the session rail's own job markup; every control is an inventory primitive and every command, title and output
   goes through escapeHtml. A live task's clock is an empty [data-bgt-started-at] span the owner's tick fills, so the
   markup stays the same between ticks. Loaded lazily with the owner. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/string-utils'), require('../inventory/action-button'), require('../inventory/segmented-control'),
      require('../chat/renderer-session-rail-model'), require('../chat/renderer-session-rail-render'));
    return;
  }
  root.rendererBackgroundTasksPanelRender = factory(root.stringUtils, root.inventoryActionButton, root.inventorySegmentedControl,
    root.rendererSessionRailModel, root.rendererSessionRailRender);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stringUtils, actionButton, segmentedControl, railModel, railRender) {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const escapeHtml = stringUtils.escapeHtml;
  const button = (options) => (actionButton || globalThis.inventoryActionButton)(options);
  const FILTERS = Object.freeze(['all', 'servers', 'commands', 'helpers', 'tests']);
  const CLOCK = '\u0001'; // stands in for the ticking clock inside a translated sentence
  const BACK_GLYPH = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M10 3.5 5.5 8l4.5 4.5"></path></svg>';
  const DOT_CLASS = Object.freeze({ active: 'status-dot--active', pending: 'status-dot--pending', error: 'status-dot--error', warn: 'status-dot--warn' });

  const num = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0);
  const time = (value) => (typeof value === 'string' && value ? num(Date.parse(value)) : num(value));

  /* m:ss, or h:mm:ss past an hour. */
  function formatClock(ms) {
    const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const pad = (value) => String(value).padStart(2, '0');
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(total % 60)}` : `${minutes}:${pad(total % 60)}`;
  }

  /* Row 176: the address a live job serves (the tracker's `serving`), or null. Only a loopback http(s) address can be opened. */
  function servingOf(job, live) {
    const url = live && typeof job.serving?.url === 'string' ? job.serving.url.trim() : '';
    return url ? { url, port: Number.isInteger(job.serving.port) ? job.serving.port : null, sinceMs: num(job.serving.sinceMs) } : null;
  }
  function loopbackUrl(value) {
    try {
      const url = new URL(String(value || '').trim());
      return (url.protocol === 'http:' || url.protocol === 'https:') && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ? url.href : '';
    } catch (_error) { return ''; }
  }

  function commandTask(job) {
    const state = String(job.state || '');
    const percent = Number(job.progress?.percent);
    const live = state === 'running' || state === 'killing';
    return {
      id: `job:${job.jobId}`, kind: 'command', jobId: String(job.jobId), state, serving: servingOf(job, live),
      text: String(job.command || '') || jt('chat.backgroundJobs.backgroundJob', 'background job'),
      live, stopping: state === 'killing', failed: state === 'failed',
      stopped: job.stopRequested === true, exitCode: Number.isInteger(job.exitCode) ? job.exitCode : null,
      startedAtMs: num(job.startedAtMs), endedAtMs: num(job.endedAtMs),
      percent: Number.isFinite(percent) && job.progress?.percent !== null ? Math.floor(Math.min(100, Math.max(0, percent))) : null,
    };
  }

  function chatTask(item) {
    const phase = railModel.taskPhase(item.state);
    return {
      id: `chat:${String(item.session_id).trim()}`, kind: 'chat', sessionId: String(item.session_id).trim(), phase,
      text: String(item.title || '').trim() || jt('chat.sessionRail.tasks.sourceLinkedChat', 'Linked chat'),
      live: phase !== 'finished' && phase !== 'failed', running: phase === 'running',
      startedAtMs: time(item.started_at), endedAtMs: time(item.finished_at),
    };
  }

  /* A helper the chat started (the monitor's own list: renderer-subagent-monitor-view.helperRuns). */
  function helperTask(helper) {
    return {
      id: String(helper.id), kind: 'helper', delegationKey: String(helper.delegationKey), childKey: String(helper.childKey),
      text: String(helper.label || '').trim() || String(helper.childKey), live: helper.live === true, failed: helper.failed === true,
      statusLabel: String(helper.statusLabel || ''), startedAtMs: num(helper.startedAtMs), endedAtMs: num(helper.endedAtMs),
    };
  }

  /* A Workspace test run the chat summary lists (it has no title; its output is read in Workspace). */
  function testTask(item) {
    const phase = railModel.taskPhase(item.state);
    return {
      id: `test:${String(item.operation_id).trim()}`, kind: 'test', phase, text: jt('runs.testRun', 'Test run'),
      live: phase !== 'finished' && phase !== 'failed', running: phase === 'running',
      startedAtMs: time(item.started_at), endedAtMs: time(item.finished_at),
    };
  }

  /* The Live tab's program the chat summary lists (row 197): one row, opened in the Live tab and never stopped from here. */
  function liveTask(item) {
    const phase = railModel.taskPhase(item.state);
    const projectId = String(item.project_id).trim();
    return {
      id: `live:${projectId}`, kind: 'live', projectId, phase, runState: String(item.run_state || ''),
      text: String(item.title || '').trim() || jt('runs.liveProgram', 'Live tab program'), live: phase === 'running', running: phase === 'running',
      exitCode: Number.isInteger(item.exit_code) ? item.exit_code : null, startedAtMs: time(item.started_at), endedAtMs: time(item.finished_at),
    };
  }

  /* A live run's state in words; the session rail's model owns the words. */
  const liveWord = (task) => railModel.liveStateWord(task.runState, task.exitCode, task.phase, jt);

  /* This chat's tasks, running first (newest first), then finished (newest first). */
  function buildTasks({ jobs, items, helpers, sessionId } = {}) {
    const sid = String(sessionId || '');
    const tasks = [];
    const seen = new Set();
    const add = (task) => { if (!seen.has(task.id)) { seen.add(task.id); tasks.push(task); } };
    for (const job of Array.isArray(jobs) ? jobs : []) if (job && sid && job.sessionId === sid && job.jobId) add(commandTask(job));
    for (const item of Array.isArray(items) ? items : []) {
      if (item && item.source_kind === 'linked_chat_turn' && String(item.session_id || '').trim()) add(chatTask(item));
      else if (item && item.source_kind === 'workspace_test' && String(item.operation_id || '').trim()) add(testTask(item));
      else if (item && item.source_kind === 'live_run' && String(item.project_id || '').trim()) add(liveTask(item));
    }
    for (const helper of Array.isArray(helpers) ? helpers : []) if (helper && helper.id) add(helperTask(helper));
    const newest = (key) => (a, b) => key(b) - key(a);
    const live = tasks.filter((task) => task.live).sort(newest((task) => task.startedAtMs));
    const done = tasks.filter((task) => !task.live).sort(newest((task) => task.endedAtMs || task.startedAtMs));
    return live.concat(done);
  }

  const duration = (task) => formatClock((task.endedAtMs || task.startedAtMs) - task.startedAtMs);
  const clockSpan = (task) => `<span data-bgt-started-at="${task.serving?.sinceMs || task.startedAtMs}"></span>`; // a server's clock runs from when it came up
  const sentence = (text, task) => escapeHtml(text).replace(CLOCK, clockSpan(task));

  function dotHtml(task) {
    const dot = task.kind === 'chat' || task.kind === 'test' || task.kind === 'live' ? railModel.taskDot(task.phase)
      : task.live ? { tone: 'active', pulse: true } : task.failed && !task.stopped ? { tone: 'error', pulse: false } : null;
    if (!dot || !DOT_CLASS[dot.tone]) return '';
    return `<span class="status-dot ${DOT_CLASS[dot.tone]}${dot.pulse ? ' session-rail-dot-pulse' : ''}" aria-hidden="true"></span>`;
  }

  /* A list row's one fact (markup: a live command's clock is a span the tick fills). */
  function factHtml(task) {
    if (task.kind === 'chat' || task.kind === 'test') return escapeHtml(railModel.taskPhaseLabel(task.phase, jt));
    if (task.kind === 'live') return escapeHtml(liveWord(task));
    if (task.kind === 'helper') return escapeHtml(task.statusLabel);
    if (task.stopping) return escapeHtml(jt('backgroundTasks.stopping', 'Stopping'));
    if (task.live) return task.percent != null ? `${task.percent}%` : clockSpan(task);
    if (task.stopped) return escapeHtml(jt('chat.sessionRail.tasks.stopped', 'Stopped'));
    if (task.exitCode != null) return escapeHtml(jt('backgroundTasks.exitDuration', 'Exit {code} · {duration}', { code: task.exitCode, duration: duration(task) }));
    return escapeHtml(task.failed ? railModel.taskPhaseLabel('failed', jt) : duration(task));
  }

  /* The open task's status words. */
  function statusHtml(task) {
    if (task.kind === 'chat') {
      const word = railModel.taskPhaseLabel(task.phase, jt);
      if (!task.startedAtMs) return escapeHtml(word);
      return task.live ? sentence(jt('backgroundTasks.status.chatLive', '{phase} · {elapsed}', { phase: word, elapsed: CLOCK }), task)
        : escapeHtml(jt('backgroundTasks.status.chatDone', '{phase} · {duration}', { phase: word, duration: duration(task) }));
    }
    if (task.stopping) return escapeHtml(jt('backgroundTasks.status.stopping', 'Stopping…'));
    if (task.serving) return sentence(jt('backgroundTasks.serving.up', 'Up · {elapsed}', { elapsed: CLOCK }), task);
    if (task.live) return sentence(jt('backgroundTasks.status.running', 'Running · {elapsed}', { elapsed: CLOCK }), task);
    const took = duration(task);
    if (task.stopped) return escapeHtml(jt('backgroundTasks.status.stopped', 'Stopped after {duration}', { duration: took }));
    if (task.exitCode === 0) return escapeHtml(jt('backgroundTasks.status.exitZero', 'Exit 0 · took {duration}', { duration: took }));
    if (task.exitCode != null) return escapeHtml(jt('backgroundTasks.status.failedExit', 'Failed, exit {code} · took {duration}', { code: task.exitCode, duration: took }));
    return escapeHtml(task.failed ? jt('backgroundTasks.status.failed', 'Failed · took {duration}', { duration: took })
      : jt('backgroundTasks.status.finished', 'Finished · took {duration}', { duration: took }));
  }

  function stopHtml(task) {
    const chat = task.kind === 'chat';
    return button({
      plain: true, className: 'session-rail-job-stop', label: jt('chat.backgroundJobs.stop', 'Stop'),
      ariaLabel: chat ? jt('backgroundTasks.stopChatAria', 'Stop linked chat: {title}', { title: task.text })
        : jt('chat.backgroundJobs.stopAriaLabel', 'Stop background job: {command}', { command: task.text }),
      title: chat ? jt('backgroundTasks.stopChatTitle', 'Stop this chat\'s turn') : jt('chat.backgroundJobs.stopTitle', 'Stop this background job'),
      disabled: task.stopping === true, dataset: { 'bgt-stop': task.id },
    });
  }

  /* A row's name: a serving job's address, else the command, title or helper line (the Session tab reads these too). */
  const addressOf = (task) => (task.serving ? railModel.bareAddress(task.serving.url) : '');
  const detailOf = (task) => (task.kind === 'helper' ? task.statusLabel : task.kind === 'chat' || task.kind === 'test' ? railModel.taskPhaseLabel(task.phase, jt)
    : task.kind === 'live' ? liveWord(task) : task.serving ? task.text : task.percent != null ? `${task.percent}%` : '');

  function rowHtml(task) {
    const address = task.serving ? railModel.bareAddress(task.serving.url) : ''; // a serving job's row shows its address, in mono, like the rail
    const helper = task.kind === 'helper' ? jt('runs.helperRow', 'Helper: {name}', { name: task.text }) : '';
    const name = helper ? `<span class="session-rail-ellip">${escapeHtml(helper)}</span>` : address ? `<span class="session-rail-ellip session-rail-ellip--addr">${escapeHtml(address)}</span>`
      : `<span class="session-rail-ellip${task.kind === 'command' ? ' background-tasks-command-name' : ''}">${escapeHtml(task.text)}</span>`;
    const title = task.kind === 'test' ? jt('runs.testRowTitle', 'Its output is in Workspace.')
      : task.kind === 'live' ? jt('runs.liveRowTitle', 'Opens the Live tab.')
      : address ? jt('chat.sessionRail.servers.jobTitle', '{command} on {address}', { command: task.text, address }) : helper || task.text;
    return `<div class="session-rail-job" data-job-state="${task.kind === 'command' && task.live ? 'running' : 'done'}" data-bgt-task="${escapeHtml(task.id)}">`
      + button({
        plain: true, className: 'session-rail-fact session-rail-row', title, dataset: { 'bgt-open': task.id }, disabled: task.kind === 'test',
        trustedHtml: `<span class="session-rail-icon">${dotHtml(task)}</span>${name}<span class="session-rail-meta">${factHtml(task)}</span>`,
      })
      + (task.kind === 'command' && task.live ? stopHtml(task) : '') + '</div>';
  }

  /* Linked chats show under All only; Tests only exists while the data holds a test run. */
  const matchesFilter = (filter) => (task) => filter === 'all' || (filter === 'servers' ? Boolean(task.serving) : filter === 'commands' ? task.kind === 'command'
    : filter === 'helpers' ? task.kind === 'helper' : task.kind === 'test');
  const availableFilter = (filter, tasks) => (FILTERS.includes(filter) && (filter !== 'tests' || tasks.some((task) => task.kind === 'test')) ? filter : 'all');

  /* The line under the list after a Clear: what it did and the way back. */
  function undoHtml(count) {
    const n = Math.floor(Number(count));
    if (!(n > 0)) return '';
    const words = n === 1 ? jt('runs.clearedOne', '1 finished run cleared from this list.')
      : jt('runs.cleared', '{count} finished runs cleared from this list.', { count: n });
    return `<div class="background-tasks-undo" role="status"><span>${escapeHtml(words)}</span>${button({
      variant: 'ghost', size: 'sm', label: jt('common.undo', 'Undo'), dataset: { 'bgt-undo': '' } })}</div>`;
  }

  /* The list page: the filter, then running rows, the "N finished" fold with Clear, the finished rows, then the undo line. */
  function listHtml(options) {
    return listBodyHtml(options) + undoHtml(options?.undoCount);
  }

  function listBodyHtml({ tasks, filter, foldOpen, clearable }) {
    const all = Array.isArray(tasks) ? tasks : [];
    const current = availableFilter(filter, all);
    const toolbar = `<div class="background-tasks-toolbar">${segmentedControl({
      id: 'bgt-filter', ariaLabel: jt('backgroundTasks.filterLabel', 'Show'), value: current, className: 'inv-segmented--compact', maxOptions: 5,
      dataset: { action: 'bgt-filter' },
      options: [
        { value: 'all', label: jt('runs.filter.all', 'All') },
        { value: 'servers', label: jt('runs.filter.servers', 'Servers') },
        { value: 'commands', label: jt('runs.filter.commands', 'Commands') },
        { value: 'helpers', label: jt('runs.filter.helpers', 'Helpers') },
      ].concat(all.some((task) => task.kind === 'test') ? [{ value: 'tests', label: jt('runs.filter.tests', 'Tests') }] : []),
    })}</div>`;
    const shown = all.filter(matchesFilter(current));
    if (!shown.length) {
      const empty = current === 'servers' ? jt('runs.empty.servers', 'No servers are running. A server Jenny starts, such as a dev server, shows up here.')
        : current === 'commands' ? jt('runs.empty.commands', 'No background commands yet. A command Jenny runs in the background shows up here.')
        : current === 'helpers' ? jt('runs.empty.helpers', 'No helpers yet. Jenny starts one when a job is big enough to split.')
          : jt('runs.empty.all', 'Nothing has run in this chat yet. Servers, commands and helpers Jenny starts show up here.');
      return `${toolbar}<p class="background-tasks-empty">${escapeHtml(empty)}</p>`;
    }
    const running = shown.filter((task) => task.live);
    const done = shown.filter((task) => !task.live);
    let html = `${toolbar}<div class="background-tasks-list">${running.map(rowHtml).join('')}`;
    if (done.length) {
      const clear = clearable && done.some((task) => task.kind === 'command')
        ? button({ plain: true, className: 'background-tasks-link', label: jt('backgroundTasks.clear', 'Clear'),
          ariaLabel: jt('backgroundTasks.clearAria', 'Clear finished commands'), dataset: { 'bgt-clear': '' },
          title: jt('runs.clearTitle', 'Clear finished runs from this list. You can undo it.') }) : '';
      html += `<div class="background-tasks-fold">${button({
        plain: true, className: 'session-rail-divider', ariaExpanded: foldOpen !== false, dataset: { 'bgt-fold': '' },
        trustedHtml: `${railRender.CHEVRON}<span class="session-rail-divider-text">${escapeHtml(jt('chat.sessionRail.tasks.finished', '{count} finished', { count: done.length }))}</span><span class="session-rail-divider-rule" aria-hidden="true"></span>`,
      })}${clear}</div>`;
      if (foldOpen !== false) html += done.map(rowHtml).join('');
    }
    return `${html}</div>`;
  }

  /* The open task's status line: dot, words, Stop at the end while it runs. */
  function statusLineHtml(task) {
    const stoppable = task.kind === 'command' ? task.live : task.running;
    return `<div class="background-tasks-status" data-bgt-status>${dotHtml(task)}<span>${statusHtml(task)}</span>`
      + `<span class="background-tasks-actions">${stoppable ? stopHtml(task) : ''}</span></div>`;
  }

  /* A serving job's plain label/value lines under the status: where it answers, on which port. Empty for any other task. */
  function factsHtml(task) {
    const s = task.serving;
    const line = (label, value, mono) => `<dt>${escapeHtml(label)}</dt><dd${mono ? ' class="background-tasks-command-name"' : ''}>${escapeHtml(value)}</dd>`;
    return `<dl class="background-tasks-facts" data-bgt-facts>${s ? line(jt('backgroundTasks.serving.address', 'Address'), s.url, true)
      + (s.port == null ? '' : line(jt('backgroundTasks.serving.port', 'Port'), jt('backgroundTasks.serving.portValue', '{port}, this PC only', { port: s.port }))) : ''}</dl>`;
  }

  /* The output's words: the text, else what its absence means. */
  function outputText(task, out) {
    if (out?.failed) return jt('chat.sessionRail.tasks.outputUnavailable', "That job's output isn't available any more.");
    if (out?.text) return out.text;
    if (task.live) return jt('backgroundTasks.noOutputYet', 'No output yet.');
    return out?.loaded ? jt('chat.sessionRail.tasks.noOutput', 'No output.') : '';
  }

  function link(label, data, extraClass) {
    return button({ plain: true, className: `background-tasks-link${extraClass ? ` ${extraClass}` : ''}`, label, dataset: data });
  }

  /* The foot line: copy and open actions, then Following output / Jump to latest while the command runs. */
  function footHtml(task, out, following) {
    if (task.kind === 'chat') return `<div class="background-tasks-foot" data-bgt-foot>${link(jt('backgroundTasks.openChat', 'Open chat'), { 'bgt-open-chat': task.sessionId })}</div>`;
    const where = !task.serving ? '' : (loopbackUrl(task.serving.url) ? link(jt('backgroundTasks.serving.open', 'Open in browser'), { 'bgt-open-address': '' }) : '')
      + link(jt('backgroundTasks.serving.copy', 'Copy address'), { 'bgt-copy-address': '' });
    const full = out?.fullOutputPath ? link(jt('chat.sessionRail.tasks.openFullOutput', 'Open full output'), { 'bgt-open-full': task.jobId }) : '';
    const live = !task.live ? '' : following !== false
      ? `<span class="background-tasks-live">${escapeHtml(jt('backgroundTasks.following', 'Following output'))}</span>`
      : link(jt('backgroundTasks.jumpToLatest', 'Jump to latest'), { 'bgt-jump': '' }, 'background-tasks-live');
    return `<div class="background-tasks-foot" data-bgt-foot>${where}${link(jt('backgroundTasks.copyCommand', 'Copy command'), { 'bgt-copy-command': '' })}`
      + `${link(jt('backgroundTasks.copyOutput', 'Copy output'), { 'bgt-copy-output': '' })}${full}${live}</div>`;
  }

  /* The detail page. The output node is painted once; the owner patches its text in place. */
  function detailHtml(task, out, following) {
    const output = task.kind !== 'command' ? ''
      : `<p class="session-rail-note" data-bgt-truncated${out?.truncated ? '' : ' hidden'}>${escapeHtml(jt('backgroundTasks.truncated', 'Showing the last part of the output.'))}</p>`
        + `<div class="session-rail-job-output background-tasks-output"><pre data-bgt-output tabindex="0">${escapeHtml(outputText(task, out))}</pre></div>`;
    return `<div class="background-tasks-detail" data-bgt-detail="${escapeHtml(task.id)}">`
      + `<p class="background-tasks-command${task.kind === 'chat' ? ' background-tasks-command--plain' : ''}">${escapeHtml(task.text)}</p>`
      + statusLineHtml(task) + factsHtml(task) + output + footHtml(task, out, following)
      + '<span class="sr-only" role="status" aria-live="polite" data-bgt-announce></span></div>';
  }

  /* The panel title while a task is open: the way back to the list. */
  function titleHtml() {
    return button({
      plain: true, domId: 'backgroundTasksBack', className: 'background-tasks-back', ariaLabel: jt('runs.backAria', 'Back to Runs'),
      dataset: { 'bgt-back': '' }, trustedHtml: `${BACK_GLYPH}<span>${escapeHtml(jt('runs.back', 'Runs'))}</span>`,
    });
  }

  return { FILTERS, formatClock, buildTasks, factHtml, matchesFilter, addressOf, detailOf, listHtml, detailHtml, statusLineHtml, factsHtml, footHtml, outputText, statusHtml, titleHtml, loopbackUrl };
});
