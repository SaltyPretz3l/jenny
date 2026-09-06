(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    const checkboxModule = require('../inventory/checkbox');
    module.exports = factory({
      actionButton: require('../inventory/action-button'),
      badge: require('../inventory/badge'),
      checkbox: checkboxModule.checkbox,
      segmentedControl: require('../inventory/segmented-control'),
      textField: require('../inventory/text-field'),
    });
    return;
  }
  root.rendererTaskRailRender = factory({
    actionButton: root.inventoryActionButton,
    badge: root.inventoryBadge,
    checkbox: root.inventoryCheckbox?.checkbox || root.inventory?.checkbox,
    segmentedControl: root.inventorySegmentedControl,
    textField: root.inventoryTextField,
  });
})(typeof globalThis !== 'undefined' ? globalThis : this, function (inventory) {
  'use strict';

  function fallbackEscapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function timestampOf(row) {
    for (const value of [row?.updatedAt, row?.resolvedAt, row?.archivedAt, row?.createdAt]) {
      const parsed = Date.parse(String(value || ''));
      if (Number.isFinite(parsed)) return parsed;
    }
    return 0;
  }

  function buildTaskRows(state) {
    const board = state?.companion?.openLoopsBoard || {};
    const sessions = Array.isArray(state?.sessions) ? state.sessions : [];
    const linkedSessions = new Map();
    for (const session of sessions) {
      const taskId = String(session?.linked_task_id || '').trim();
      if (taskId && !linkedSessions.has(taskId)) linkedSessions.set(taskId, String(session?.id || '').trim());
    }
    const sources = [
      ['active', board.active],
      ['deferred', board.deferred],
      ['recentResolved', board.recentResolved],
      ['archived', board.archived],
    ];
    const rows = [];
    let sourceOrder = 0;
    for (const [section, entries] of sources) {
      for (const entry of Array.isArray(entries) ? entries : []) {
        const order = sourceOrder++;
        const sourceKind = String(entry?.sourceKind || '').trim();
        const sourceBadge = String(entry?.sourceBadge || '').trim().toLowerCase();
        if (sourceKind !== 'agent_task' && sourceBadge !== 'agent task') continue;
        const followUpId = String(entry?.followUpId || '').trim();
        if (!followUpId) continue;
        const linkedSessionId = linkedSessions.get(followUpId) || '';
        rows.push({
          followUpId,
          title: String(entry?.title || '').trim(),
          body: String(entry?.body || '').trim(),
          status: section === 'archived' ? 'archived' : String(entry?.status || '').trim(),
          section,
          isDue: entry?.isDue === true,
          timingLabel: String(entry?.timingLabel || '').trim(),
          sessionId: String(entry?.sessionId || '').trim(),
          sessionTitle: String(entry?.sessionTitle || '').trim(),
          linkedSessionId,
          isCurrentSessionTask: Boolean(linkedSessionId && linkedSessionId === String(state?.currentSessionId || '').trim()),
          originBadge: String(entry?.sessionId || '').trim() ? 'Agent task' : 'Manual',
          _recency: timestampOf(entry),
          _sourceOrder: order,
        });
      }
    }
    rows.sort((left, right) => {
      if (left.isCurrentSessionTask !== right.isCurrentSessionTask) return left.isCurrentSessionTask ? -1 : 1;
      if (left.isDue !== right.isDue) return left.isDue ? -1 : 1;
      return right._recency - left._recency || left._sourceOrder - right._sourceOrder;
    });
    return rows.map(({ _recency, _sourceOrder, ...row }) => row);
  }

  function action(options) {
    return typeof inventory.actionButton === 'function' ? inventory.actionButton(options) : '';
  }

  function badge(text, tone, className) {
    return typeof inventory.badge === 'function'
      ? inventory.badge({ text, tone: tone || 'muted', size: 'sm', className: className || '' })
      : '';
  }

  function field(options) {
    return typeof inventory.textField === 'function' ? inventory.textField(options) : '';
  }

  function checkbox(row, busy) {
    return typeof inventory.checkbox === 'function' ? inventory.checkbox({
      id: `taskRailCheck-${row.followUpId}`,
      checked: row.status === 'resolved' || row.status === 'archived',
      disabled: busy,
      ariaLabel: `${row.status === 'resolved' || row.status === 'archived' ? 'Reopen' : 'Complete'} ${row.title}`,
      className: 'task-rail-checkbox',
      dataset: { 'follow-up-id': row.followUpId },
    }) : '';
  }

  function renderEditor(row, escapeHtml) {
    return '<div class="task-rail-editor" data-task-editor="' + escapeHtml(row.followUpId) + '">'
      + field({ id: `taskRailEditTitle-${row.followUpId}`, value: row.title, label: 'Title', maxLength: 200 })
      + field({ id: `taskRailEditBody-${row.followUpId}`, value: row.body, label: 'Notes', multiline: true, rows: 3, maxLength: 4000 })
      + '<div class="task-rail-editor-actions">'
      + action({ id: 'task-rail-edit-save', label: 'Save', variant: 'primary', size: 'sm', dataset: { 'task-id': row.followUpId } })
      + action({ id: 'task-rail-edit-cancel', label: 'Cancel', variant: 'ghost', size: 'sm' })
      + '</div></div>';
  }

  function renderRow(row, uiState, escapeHtml) {
    const busy = String(uiState.busyTaskId || '') === row.followUpId;
    if (String(uiState.editTaskId || '') === row.followUpId) return renderEditor(row, escapeHtml);
    const resolved = row.status === 'resolved' || row.status === 'archived';
    const sessionLine = row.sessionTitle
      ? '<div class="task-rail-origin-session">from ' + escapeHtml(row.sessionTitle) + '</div>'
      : '';
    const timing = row.timingLabel
      ? '<span class="task-rail-timing' + (row.isDue ? ' is-due' : '') + '">' + escapeHtml(row.timingLabel) + '</span>'
      : '';
    const sessionAction = row.linkedSessionId
      ? action({ id: 'task-rail-open-session', label: 'Open session', size: 'sm', variant: 'ghost', disabled: busy, dataset: { 'task-id': row.followUpId } })
      : action({ id: 'task-rail-start', label: 'Start a session', size: 'sm', variant: 'ghost', disabled: busy, dataset: { 'task-id': row.followUpId } });
    return '<article class="task-rail-row' + (resolved ? ' task-rail-row--resolved' : '') + '" data-task-id="'
      + escapeHtml(row.followUpId) + '"><div class="task-rail-row-main">'
      + checkbox(row, busy) + '<div class="task-rail-copy"><div class="task-rail-title">'
      + escapeHtml(row.title) + '</div>'
      + (row.body ? '<div class="task-rail-notes">' + escapeHtml(row.body) + '</div>' : '')
      + '<div class="task-rail-meta">' + badge(row.originBadge, 'muted', 'task-rail-origin-badge')
      + timing + '</div>' + sessionLine + '</div>'
      + action({ id: 'task-rail-overflow', plain: true, className: 'task-rail-overflow', ariaLabel: `More actions for ${row.title}`, ariaHaspopup: 'menu', disabled: busy, trustedHtml: '<span aria-hidden="true">&#8942;</span>', dataset: { 'task-id': row.followUpId } })
      + '</div><div class="task-rail-row-actions">' + sessionAction
      + (row.isCurrentSessionTask ? badge('This session', 'success', 'task-rail-current-badge') : '')
      + '</div></article>';
  }

  function rowsForFilter(rows, filter) {
    if (filter === 'done') return rows.filter((row) => row.section === 'recentResolved');
    if (filter === 'all') return rows;
    return rows.filter((row) => row.section === 'active' || row.section === 'deferred');
  }

  function renderTaskRailSurface(rows, uiState, helpers) {
    const escapeHtml = typeof helpers?.escapeHtml === 'function' ? helpers.escapeHtml : fallbackEscapeHtml;
    const source = Array.isArray(rows) ? rows : [];
    const state = uiState && typeof uiState === 'object' ? uiState : {};
    const addBusy = String(state.busyTaskId || '') === '__add__';
    const filter = ['open', 'done', 'all'].includes(state.filter) ? state.filter : 'open';
    const visibleRows = rowsForFilter(source, filter);
    const openCount = source.filter((row) => row.section === 'active' || row.section === 'deferred').length;
    const doneCount = source.filter((row) => row.section === 'recentResolved' || row.section === 'archived').length;
    const filters = typeof inventory.segmentedControl === 'function' ? inventory.segmentedControl({
      id: 'task-rail-filter', ariaLabel: 'Task filter', value: filter, className: 'task-rail-filters',
      dataset: { action: 'task-rail-filter' },
      options: [{ value: 'open', label: 'Open' }, { value: 'done', label: 'Done' }, { value: 'all', label: 'All' }],
    }) : '';
    const emptyCopy = filter === 'done'
      ? 'No completed tasks yet.'
      : filter === 'all' ? 'No tasks yet. Ask Jenny to file one, or add one above.'
        : 'No open tasks. Ask Jenny to file one, or add one above.';
    const list = visibleRows.length
      ? visibleRows.map((row) => renderRow(row, state, escapeHtml)).join('')
      : '<div class="task-rail-empty">' + escapeHtml(emptyCopy) + '</div>';
    return '<section class="task-rail-surface" aria-label="Tasks"><header class="task-rail-header">'
      + '<div><h2>Tasks</h2><p>Tasks &middot; ' + openCount + ' open &middot; ' + doneCount + ' done</p></div>'
      + filters + '</header><div class="task-rail-add">'
      + field({ id: 'taskRailDraftTitle', value: String(state.draftTitle || ''), placeholder: 'Add a task', ariaLabel: 'Task title', multiline: true, rows: 1, maxLength: 200, disabled: addBusy, dataset: { 'task-draft-title': '' } })
      + action({ id: 'task-rail-add', label: 'Add', variant: 'primary', size: 'sm', disabled: addBusy }) + '</div>'
      + (state.lastError ? '<div class="task-rail-error" role="alert">' + escapeHtml(state.lastError) + '</div>' : '')
      + '<div class="task-rail-list">' + list + '</div><footer class="task-rail-footer"><span>'
      + escapeHtml('Refreshes automatically when the model files a task.') + '</span>'
      + action({ id: 'task-rail-send-list', label: 'Send list to chat', variant: 'ghost', size: 'sm', disabled: openCount === 0 })
      + '</footer></section>';
  }

  return { buildTaskRows, renderTaskRailSurface };
});
