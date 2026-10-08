/* renderer/shell/renderer-runs-view.js - Diagnostics › Runs: what Jenny is working on across chats.
 *
 * Keyed patch rendering (spec 2026-09-27 R3): the page skeleton is built once;
 * rows are keyed by work_id and updated in place, so a 2 s poll never rebuilds
 * the page, never drops keyboard focus and never eats a click. Only a row part
 * whose own content changed is rewritten, and focus inside it is restored by
 * its data-focus-key. Model text (titles, purposes) is always escaped.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../inventory/action-button'), require('../inventory/text-field'));
  } else root.rendererRunsView = factory(root.inventoryActionButton, root.inventoryTextField);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (button, field) {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback
    || function (key, fallback, params) { return String(fallback).replace(/\{(\w+)\}/g, (match, name) => params?.[name] ?? match); };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn)
    || function (key, count, params, one, other) { return jt.call(null, key, count === 1 ? one : other, params); };
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const GENERAL_PROJECT_ID = 'project_general';
  const GROUPS = ['needs_you', 'running', 'waiting', 'paused_earlier', 'finished'];
  // Paused work untouched for a day leaves "Needs you" for the collapsed
  // "Paused earlier" group: still resumable and stoppable, never deleted (gate F10).
  const PAUSED_EARLIER_MS = 24 * 60 * 60 * 1000;
  const COLLAPSIBLE = { paused_earlier: { listId: 'runsPausedEarlierList', open: 'pausedEarlierOpen' },
    finished: { listId: 'runsFinishedList', open: 'finishedOpen' } };
  const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
  const locale = () => { try { return globalThis.jennyI18n?.tag?.() || undefined; } catch (_error) { return undefined; } };

  function labels() {
    return {
      title: jt('runtime.runs.title', 'Runs'),
      copy: jt('runtime.runs.copy', 'What Jenny is working on across your chats. Start new work from a chat.'),
      loading: jt('runtime.runs.loading', 'Loading runs…'),
      off: jt('runtime.runs.off', 'Runtime is off. Nothing new runs until it is back; you can still stop work and change limits.'),
      unavailable: jt('runtime.runs.unavailable', 'Runs are unavailable right now. Jenny retries on her own.'),
      failedAction: jt('runtime.runs.failedAction', "That didn't go through. The list refreshes; try again."),
      stopRequested: jt('runtime.runs.stopRequestedMessage', 'Stop requested. Jenny finishes cleaning up first.'),
      empty: jt('runtime.runs.empty', 'Nothing is running. Work you start in a chat shows up here.'),
      truncated: jt('runtime.runs.truncated', 'Showing the first 100 items.'),
      allProjects: jt('runtime.runs.allProjects', 'All projects'),
      filterLabel: jt('runtime.runs.filterLabel', 'Show runs from'),
      untitled: jt('runtime.runs.untitledChat', 'Untitled chat'),
      general: jt('projects.general', 'General'),
      unknownProject: jt('runtime.runs.unknownProject', 'Project'),
      groups: {
        needs_you: jt('runtime.runs.group.needsYou', 'Needs you'),
        running: jt('runtime.runs.group.running', 'Running'),
        waiting: jt('runtime.runs.group.waiting', 'Waiting'),
      },
      resume: jt('runtime.runs.resume', 'Resume'), openChat: jt('runtime.runs.openChat', 'Open chat'),
      openChatLink: jt('runtime.runs.openChatLink', 'Open chat ›'),
      pause: jt('runtime.runs.pause', 'Pause'), stop: jt('runtime.runs.stop', 'Stop'),
      stopConfirm: jt('runtime.runs.stopConfirm', 'Stop this run?'), keepRunning: jt('runtime.runs.keepRunning', 'Keep running'),
      withdraw: jt('runtime.runs.withdraw', 'Withdraw'),
      requests: jt('runtime.runs.detail.requests', 'Requests'), tokens: jt('runtime.runs.detail.tokens', 'Tokens'),
      subagents: jt('runtime.runs.detail.subagents', 'Subagents'), instructions: jt('runtime.runs.detail.instructions', 'Instructions'),
      saveInstructions: jt('runtime.runs.detail.saveInstructions', 'Update instructions'),
      moreSubagents: jt('runtime.runs.detail.moreSubagents', 'More subagents'),
      detailUnavailable: jt('runtime.runs.detail.unavailable', 'Details are unavailable for this run.'),
    };
  }

  function number(value) {
    try { return new Intl.NumberFormat(locale()).format(value); } catch (_error) { return String(value); }
  }
  function ordinal(value) {
    let rule = 'other';
    try { rule = new Intl.PluralRules(locale(), { type: 'ordinal' }).select(value); } catch (_error) { /* other */ }
    const forms = { one: jt('runtime.runs.ordinal.one', '{n}st', { n: number(value) }),
      two: jt('runtime.runs.ordinal.two', '{n}nd', { n: number(value) }),
      few: jt('runtime.runs.ordinal.few', '{n}rd', { n: number(value) }) };
    return forms[rule] || jt('runtime.runs.ordinal.other', '{n}th', { n: number(value) });
  }
  function age(value, now) {
    const at = Date.parse(value);
    if (!Number.isFinite(at)) return '';
    const seconds = Math.round((at - now) / 1000);
    const [unit, size] = Math.abs(seconds) < 60 ? ['second', 1] : Math.abs(seconds) < 3600 ? ['minute', 60]
      : Math.abs(seconds) < 86400 ? ['hour', 3600] : ['day', 86400];
    try {
      if (unit === 'second') return new Intl.RelativeTimeFormat(locale(), { numeric: 'auto', style: 'short' }).format(0, 'second');
      return new Intl.RelativeTimeFormat(locale(), { numeric: 'auto', style: 'short' }).format(Math.round(seconds / size), unit);
    } catch (_error) { return new Date(at).toLocaleString(locale()); }
  }

  // Needs-you detail: what happened, in plain words, from recovery.kind.
  function needsYouDetail(item) {
    if (item.recovery_kind === 'restart_paused') return jt('runtime.runs.state.restartPaused', 'paused when Jenny restarted');
    if (item.recovery_kind === 'transition_repaired') return jt('runtime.runs.state.repaired', 'recovered after an interruption');
    if (item.status === 'paused' && item.control_kind === 'pause') return jt('runtime.runs.state.pausedByYou', 'paused');
    if (item.status === 'paused') return jt('runtime.runs.state.paused', 'paused');
    return jt('runtime.runs.state.attention', 'needs your attention');
  }
  function stateDetail(item) {
    if (item.control_kind === 'cancel' && !TERMINAL.has(item.status)) return jt('runtime.runs.state.stopRequested', 'stop requested, cleaning up');
    if (item.group === 'running') {
      // A persisted pause intent is not a pause: the turn keeps running until
      // the runtime settles the request at its own boundary.
      if (item.control_kind === 'pause') return jt('runtime.runs.state.pauseRequested', 'pause requested');
      const steps = item.progress?.steps; const tools = item.progress?.tool_calls;
      if (Number.isInteger(steps) && Number.isInteger(tools)) {
        return jtn('runtime.runs.state.progress', tools, { steps: number(steps), tools: number(tools) },
          'step {steps} · {tools} tool call', 'step {steps} · {tools} tool calls');
      }
      if (Number.isInteger(steps)) return jt('runtime.runs.state.step', 'step {steps}', { steps: number(steps) });
      return jt('runtime.runs.state.running', 'running now');
    }
    if (item.group === 'waiting') {
      if (item.wait_kind === 'dependency') return jt('runtime.runs.state.waitingSubagents', 'waiting for its subagents');
      if (item.wait_kind === 'resource') return jt('runtime.runs.state.waitingSlot', 'waiting for a free slot');
      if (Number.isInteger(item.queue_position)) return jt('runtime.runs.state.queued', 'queued · {ordinal} in line', { ordinal: ordinal(item.queue_position) });
      return jt('runtime.runs.state.queuedUnknown', 'queued');
    }
    if (item.group === 'needs_you' || item.group === 'paused_earlier') return needsYouDetail(item);
    if (item.status === 'completed') return jt('runtime.runs.state.completed', 'finished');
    if (item.status === 'failed') return jt('runtime.runs.state.failed', 'failed');
    return jt('runtime.runs.state.cancelled', 'stopped');
  }

  // A paged (hosted) snapshot has no group fields: derive them from status.
  function groupOf(item) {
    if (GROUPS.includes(item.group)) return item.group;
    if (TERMINAL.has(item.status)) return 'finished';
    return item.status === 'running' ? 'running' : item.status === 'pending' ? 'waiting' : 'needs_you';
  }
  function projectName(projectId, projects) {
    if (!projectId || projectId === GENERAL_PROJECT_ID) return labels().general;
    const found = (projects || []).find(project => project?.id === projectId);
    return found?.name ? String(found.name) : labels().unknownProject;
  }
  function sessionTitle(item, sessions) {
    const session = (sessions || []).find(row => row && (row.id === item.session_id || row.session_id === item.session_id));
    const title = String(session?.title || '').trim();
    if (title) return title;
    // A subagent's own session is not in the chat list; its purpose names it.
    if (item.purpose && item.purpose !== 'chat' && item.parent_work_id) return item.purpose;
    return labels().untitled;
  }

  /* Pure: the rows the page shows, grouped and ordered. Finished rows are
   * today's only (a view filter; the runtime keeps its history). */
  function buildRunsModel({ snapshot, detail = null, sessions = [], projects = [], projectFilter = '', now = Date.now(), finishedSince = 0 } = {}) {
    const items = Array.isArray(snapshot?.work) ? snapshot.work.slice() : [];
    const selectedWork = detail?.work;
    if (selectedWork && !items.some(item => item.work_id === selectedWork.work_id)) items.push({ ...selectedWork, pinned: true });
    const groups = { needs_you: [], running: [], waiting: [], paused_earlier: [], finished: [] };
    const projectIds = new Set();
    for (const raw of items) {
      const item = { ...raw, group: groupOf(raw) };
      if (item.group === 'needs_you' && item.status === 'paused'
        && now - Date.parse(item.updated_at || item.created_at) > PAUSED_EARLIER_MS) item.group = 'paused_earlier';
      if (item.group === 'finished' && !item.pinned && !(Date.parse(item.updated_at) >= finishedSince)) continue;
      projectIds.add(item.project_id || GENERAL_PROJECT_ID);
      if (projectFilter && (item.project_id || GENERAL_PROJECT_ID) !== projectFilter) continue;
      groups[item.group].push({ ...item, title: sessionTitle(item, sessions),
        meta: [projectName(item.project_id, projects), stateDetail(item), age(item.updated_at || item.created_at, now)].filter(Boolean).join(' · ') });
    }
    const order = (left, right) => String(left.created_at).localeCompare(String(right.created_at)) || String(left.work_id).localeCompare(String(right.work_id));
    // Finished today reads newest first: the run that just ended leads.
    const finishedAt = item => String(item.updated_at || item.created_at || '');
    const newestFirst = (left, right) => finishedAt(right).localeCompare(finishedAt(left)) || order(right, left);
    for (const group of GROUPS) groups[group].sort(group === 'finished' ? newestFirst : order);
    return { groups, projectIds: [...projectIds],
      counts: { running: groups.running.length, waiting: groups.waiting.length, finished: groups.finished.length,
        total: GROUPS.reduce((sum, group) => sum + groups[group].length, 0) } };
  }

  function rowActions(item, model, l) {
    const blocked = model.busy || model.canControl?.(item) === false;
    const off = !model.snapshot?.enabled || model.snapshot?.read_only || model.snapshot?.closing;
    const act = (name, label, extra = {}) => button({ id: `runs-${name}`, label, ariaLabel: `${label}: ${item.title}`, size: 'sm',
      dataset: { 'work-id': item.work_id, 'focus-key': `${item.work_id}:${name}` }, ...extra });
    if (model.confirmStop === item.work_id && item.group !== 'finished') {
      return '<span class="runs-confirm" role="group" aria-label="' + escape(l.stopConfirm) + '"><span class="runs-confirm-text">'
        + escape(l.stopConfirm) + '</span>' + act('stop-confirm', l.stop, { variant: 'danger', ariaLabel: l.stop, disabled: blocked })
        + act('stop-keep', l.keepRunning, { variant: 'ghost', ariaLabel: l.keepRunning }) + '</span>';
    }
    const cancelRequested = item.control_kind === 'cancel';
    // Stop stays available on paused and needs-attention work, runtime off included (§5).
    if (item.group === 'needs_you' || item.group === 'paused_earlier') {
      // No Resume the scheduler would refuse: `resumable: false` is paused work with no checkpoint for its attempt.
      return (item.status === 'paused' && item.resumable !== false
        ? act('resume', l.resume, { variant: 'primary', disabled: blocked || off || cancelRequested }) : '')
        + act('stop', l.stop, { disabled: blocked || cancelRequested }) + act('open', l.openChat, { variant: 'ghost' });
    }
    if (item.group === 'running') {
      return act('pause', l.pause, { disabled: blocked || item.control_kind === 'pause' || cancelRequested })
        + act('stop', l.stop, { disabled: blocked || cancelRequested });
    }
    if (item.group === 'waiting') return act('withdraw', l.withdraw, { disabled: blocked || cancelRequested });
    return '';
  }

  function detailMarkup(item, model, l) {
    const detail = model.detail?.work?.work_id === item.work_id ? model.detail : null;
    if (!detail) return '';
    const c = detail.coordination || {};
    const blocked = model.busy || model.canControl?.(item) === false;
    let html = '<dl class="runs-detail-list">';
    if (c.budget) {
      const { charged, limits } = c.budget;
      html += '<dt>' + escape(l.requests) + '</dt><dd>' + escape(jt('runtime.runs.detail.requestsValue', '{used} of {limit}',
        { used: number(charged.inference_requests), limit: number(limits.inference_requests) })) + '</dd>'
        + '<dt>' + escape(l.tokens) + '</dt><dd>' + escape(jt('runtime.runs.detail.tokensValue', '{in} of {inLimit} in · {out} of {outLimit} out',
          { in: number(charged.input_tokens), inLimit: number(limits.input_tokens), out: number(charged.output_tokens), outLimit: number(limits.output_tokens) })) + '</dd>';
    }
    if (c.child_count) {
      html += '<dt>' + escape(l.subagents) + '</dt><dd><ul class="runs-children">' + (c.children || []).map(child => '<li>'
        + button({ id: 'runs-child', label: child.purpose || l.untitled, variant: 'ghost', size: 'sm', className: 'runs-child',
          dataset: { 'work-id': child.work_id, 'focus-key': `${child.work_id}:child` } })
        + '<span class="runs-child-state">' + escape(stateDetail({ ...child, group: groupOf(child) })) + '</span></li>').join('') + '</ul>'
        + (c.next_child_offset !== null && c.next_child_offset !== undefined ? button({ id: 'runs-children-next', label: l.moreSubagents,
          variant: 'ghost', size: 'sm', disabled: model.busy, dataset: { 'work-id': item.work_id, 'focus-key': `${item.work_id}:children-next` } }) : '') + '</dd>';
    }
    html += '</dl>';
    if (c.editable) {
      html += field({ id: `runs_edit_${item.work_id}`, label: l.instructions, multiline: true, rows: 3,
        value: model.draft.edit ?? c.prompt ?? '', disabled: blocked,
        // The revision this text was read at: the save is checked against what the person saw.
        dataset: { draft: 'edit', 'focus-key': `${item.work_id}:edit`, revision: String(detail.work?.revision ?? '') } })
        + '<div class="runs-detail-actions">' + button({ id: 'runs-edit', label: l.saveInstructions, size: 'sm', disabled: blocked,
          dataset: { 'work-id': item.work_id, 'focus-key': `${item.work_id}:edit-save` } }) + '</div>';
    }
    if (c.available === false) html += '<p class="runs-detail-note">' + escape(l.detailUnavailable) + '</p>';
    html += button({ id: 'runs-open', label: l.openChatLink, variant: 'ghost', size: 'sm', className: 'runs-open-link',
      dataset: { 'work-id': item.work_id, 'focus-key': `${item.work_id}:open-link` } });
    return html;
  }

  const shownRowIds = host => [...host.querySelectorAll('.runs-row')]
    .filter(node => !node.closest('[hidden]')).map(node => node.dataset.workId);
  function captureFocus(host) {
    const active = host.ownerDocument.activeElement;
    if (!active || !host.contains(active)) return null;
    return { element: active, key: active.dataset?.focusKey || '', start: active.selectionStart, end: active.selectionEnd,
      row: active.closest('.runs-row')?.dataset.workId || '', rows: shownRowIds(host) };
  }
  // The row whose control had focus left the list (Withdraw, a confirmed Stop,
  // or it finished into the collapsed group): the next shown row takes focus,
  // else the previous one, else the project filter (F7, 2026-09-27 gate).
  function neighbourTarget(focus, find) {
    const index = focus.rows.indexOf(focus.row);
    if (index < 0) return null;
    for (const id of [...focus.rows.slice(index + 1), ...focus.rows.slice(0, index).reverse()]) {
      const target = find(`${id}:select`);
      if (target) return target;
    }
    return find('filter');
  }
  function restoreFocus(host, focus) {
    if (!focus || host.ownerDocument.activeElement === focus.element && host.contains(focus.element)
      && !focus.element.closest('[hidden]')) return;
    if (!focus.key) return;
    const find = key => [...host.querySelectorAll('[data-focus-key]')]
      .find(node => node.dataset.focusKey === key && !node.disabled && !node.closest('[hidden]'));
    // A poll can remove the focused control (Pause turns into Resume when the
    // run pauses): focus falls back to the same row, then to a neighbour,
    // never to the page body.
    const target = find(focus.key) || (focus.row ? find(`${focus.row}:select`) || neighbourTarget(focus, find) : null);
    if (!target) return;
    target.focus({ preventScroll: true });
    if (Number.isInteger(focus.start)) target.setSelectionRange?.(focus.start, focus.end);
  }
  function setHtml(node, html, cache, key) {
    if (cache.get(key) === html) return;
    cache.set(key, html);
    node.innerHTML = html;
  }

  function createRunsView(host) {
    const doc = host.ownerDocument;
    const l = labels();
    const rows = new Map();
    const parts = new Map();
    host.innerHTML = '<div class="settings-card-header runs-header"><h3 class="runs-title">' + escape(l.title) + '</h3>'
      + '<span class="runs-count" data-runs-count></span><div class="runs-filter" data-runs-filter></div></div>'
      + '<p class="settings-copy runs-copy">' + escape(l.copy) + '</p>'
      + '<p class="settings-note runs-status" data-runs-status role="status" aria-live="polite"></p>'
      + '<p class="settings-note runs-message" data-runs-message role="status" aria-live="polite" hidden></p>'
      + '<div class="runs-groups" data-runs-groups>' + GROUPS.map(group => '<section class="runs-group" data-group="' + group + '" hidden>'
        + '<h4 class="group-label runs-group-label" data-runs-group-label></h4><ul class="runs-list" data-runs-list'
        + (COLLAPSIBLE[group] ? ' id="' + COLLAPSIBLE[group].listId + '"' : '') + '></ul></section>').join('') + '</div>'
      + '<p class="settings-note runs-empty" data-runs-empty hidden>' + escape(l.empty) + '</p>';
    const q = selector => host.querySelector(selector);
    const groupNodes = Object.fromEntries(GROUPS.map(group => {
      const section = q(`.runs-group[data-group="${group}"]`);
      return [group, { section, label: section.querySelector('[data-runs-group-label]'), list: section.querySelector('[data-runs-list]') }];
    }));

    function rowNode(item) {
      let node = rows.get(item.work_id);
      if (!node) {
        node = doc.createElement('li');
        node.className = 'runs-row';
        node.dataset.workId = item.work_id;
        node.innerHTML = '<div class="runs-row-line">' + button({ id: 'runs-select', plain: true, className: 'runs-row-main',
          trustedHtml: '<span class="runs-dot" aria-hidden="true"></span><span class="runs-row-text"><span class="runs-row-title"></span>'
            + '<span class="runs-row-meta"></span></span>' }) + '<div class="runs-row-actions"></div></div>'
          + '<div class="runs-row-detail" hidden></div>';
        rows.set(item.work_id, node);
        parts.set(item.work_id, new Map());
      }
      return node;
    }
    function patchRow(node, item, model) {
      const selected = model.selected === item.work_id;
      const main = node.querySelector('.runs-row-main');
      node.classList.toggle('is-selected', selected);
      node.dataset.group = item.group;
      main.dataset.workId = item.work_id;
      main.dataset.focusKey = `${item.work_id}:select`;
      main.setAttribute('aria-expanded', String(selected));
      main.setAttribute('aria-controls', `runs_detail_${item.work_id}`);
      const dot = main.querySelector('.runs-dot');
      const tone = item.group === 'needs_you' ? 'attention' : item.group === 'running' ? 'running' : 'muted';
      if (dot.dataset.tone !== tone) dot.dataset.tone = tone;
      const title = main.querySelector('.runs-row-title');
      if (title.textContent !== item.title) title.textContent = item.title;
      const meta = main.querySelector('.runs-row-meta');
      if (meta.textContent !== item.meta) meta.textContent = item.meta;
      const cache = parts.get(item.work_id);
      setHtml(node.querySelector('.runs-row-actions'), rowActions(item, model, l), cache, 'actions');
      const detail = node.querySelector('.runs-row-detail');
      detail.id = `runs_detail_${item.work_id}`;
      const detailHtml = selected ? detailMarkup(item, model, l) : '';
      detail.hidden = !detailHtml;
      // The instructions draft lives in the textarea: never overwrite what the
      // person is typing just because the poll re-read the same work. Until
      // they type, the box follows the latest prompt (and its revision).
      const editing = detail.querySelector('[data-draft="edit"]');
      const nextSignature = model.draft.edit === undefined ? detailHtml
        : detailHtml.replace(/<textarea([^>]*)>[\s\S]*?<\/textarea>/, '<textarea$1></textarea>');
      if (cache.get('detail-signature') !== nextSignature) {
        cache.set('detail-signature', nextSignature);
        const draft = editing && editing.value;
        detail.innerHTML = detailHtml;
        const replaced = detail.querySelector('[data-draft="edit"]');
        if (replaced && editing && model.draft.edit !== undefined) replaced.value = draft;
      }
    }
    function patchFilter(model, built) {
      const holder = q('[data-runs-filter]');
      const names = built.projectIds.map(id => ({ id, name: projectName(id, model.projects) }))
        .sort((a, b) => a.name.localeCompare(b.name, locale(), { sensitivity: 'base' }));
      const current = model.projectFilter ? projectName(model.projectFilter, model.projects) : l.allProjects;
      const menu = model.filterOpen ? '<div class="runs-filter-menu" role="menu" aria-label="' + escape(l.filterLabel) + '">'
        + '<p class="group-label runs-filter-heading" aria-hidden="true">' + escape(l.filterLabel) + '</p>'
        + [{ id: '', name: l.allProjects }, ...names].map(entry => button({ id: 'runs-filter-pick', label: entry.name, plain: true,
          className: 'runs-filter-item', role: 'menuitemradio', ariaLabel: entry.name,
          dataset: { 'project-id': entry.id, 'focus-key': `filter:${entry.id || 'all'}`, checked: String((model.projectFilter || '') === entry.id) } }))
          .join('') + '</div>' : '';
      const html = button({ id: 'runs-filter', label: `${current} ▾`, variant: 'ghost', size: 'sm', ariaHaspopup: 'menu',
        ariaExpanded: model.filterOpen === true, ariaLabel: `${l.filterLabel}: ${current}`, dataset: { 'focus-key': 'filter' } }) + menu;
      if (holder.dataset.html !== html) {
        holder.dataset.html = html;
        holder.innerHTML = html;
        holder.querySelectorAll('[role="menuitemradio"]').forEach(node => node.setAttribute('aria-checked', node.dataset.checked));
      }
    }

    function update(model) {
      const focus = captureFocus(host);
      const snapshot = model.snapshot;
      const built = buildRunsModel({ snapshot, detail: model.detail, sessions: model.sessions, projects: model.projects,
        projectFilter: model.projectFilter, now: model.now, finishedSince: model.finishedSince });
      const count = q('[data-runs-count]');
      const countText = snapshot ? jt('runtime.runs.count', '{running} running · {waiting} waiting',
        { running: number(built.counts.running), waiting: number(built.counts.waiting) }) : '';
      if (count.textContent !== countText) count.textContent = countText;
      patchFilter(model, built);
      const status = q('[data-runs-status]');
      // Loading is not "off": off is only what a snapshot says (enabled:false).
      const statusText = !model.loaded ? l.loading : snapshot && snapshot.enabled === false ? l.off
        : snapshot?.truncated ? l.truncated : '';
      if (status.textContent !== statusText) status.textContent = statusText;
      status.hidden = !statusText;
      const message = q('[data-runs-message]');
      const messageText = model.actionMessage || model.readError || '';
      if (message.textContent !== messageText) message.textContent = messageText;
      message.hidden = !messageText;
      const seen = new Set();
      for (const group of GROUPS) {
        const nodes = groupNodes[group];
        const items = built.groups[group];
        nodes.section.hidden = items.length === 0;
        const collapsible = COLLAPSIBLE[group];
        if (collapsible) {
          const finished = group === 'finished';
          const label = finished ? jt('runtime.runs.group.finishedToday', 'Finished today · {count}', { count: number(items.length) })
            : jt('runtime.runs.group.pausedEarlier', 'Paused earlier · {count}', { count: number(items.length) });
          const open = model[collapsible.open] === true;
          const toggle = button({ id: finished ? 'runs-finished-toggle' : 'runs-paused-earlier-toggle', label,
            plain: true, className: 'runs-group-toggle', ariaExpanded: open, ariaControls: collapsible.listId,
            dataset: { 'focus-key': finished ? 'finished-toggle' : 'paused-earlier-toggle' } });
          if (nodes.label.dataset.html !== toggle) { nodes.label.dataset.html = toggle; nodes.label.innerHTML = toggle; }
          nodes.list.hidden = !open;
        } else if (nodes.label.textContent !== l.groups[group]) nodes.label.textContent = l.groups[group];
        let previous = null;
        for (const item of items) {
          const node = rowNode(item);
          seen.add(item.work_id);
          patchRow(node, item, model);
          const expected = previous ? previous.nextSibling : nodes.list.firstChild;
          if (node.parentNode !== nodes.list || expected !== node) nodes.list.insertBefore(node, expected);
          previous = node;
        }
      }
      for (const [workId, node] of rows) {
        if (seen.has(workId)) continue;
        node.remove(); rows.delete(workId); parts.delete(workId);
      }
      const empty = q('[data-runs-empty]');
      empty.hidden = !(model.loaded && built.counts.total === 0);
      restoreFocus(host, focus);
      return built;
    }
    function focusKey(key) {
      const target = [...host.querySelectorAll('[data-focus-key]')].find(node => node.dataset.focusKey === key);
      target?.focus({ preventScroll: true });
      return Boolean(target);
    }
    return { update, focusKey, dispose() { rows.clear(); parts.clear(); } };
  }

  return { createRunsView, buildRunsModel, labels, stateDetail, groupOf, GENERAL_PROJECT_ID };
});
