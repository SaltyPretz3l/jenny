(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    const checkboxModule = require('../inventory/checkbox');
    module.exports = factory({
      actionButton: require('../inventory/action-button'),
      checkbox: checkboxModule.checkbox,
      segmentedControl: require('../inventory/segmented-control'),
      textField: require('../inventory/text-field'),
    });
    return;
  }
  root.rendererTaskRailRender = factory({
    actionButton: root.inventoryActionButton,
    checkbox: root.inventoryCheckbox?.checkbox || root.inventory?.checkbox,
    segmentedControl: root.inventorySegmentedControl,
    textField: root.inventoryTextField,
  });
})(typeof globalThis !== 'undefined' ? globalThis : this, function (inventory) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  const fallbackEscapeHtml = (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  function timestampOf(row) {
    for (const value of [row?.updatedAt, row?.resolvedAt, row?.archivedAt, row?.createdAt]) {
      const parsed = Date.parse(String(value || ''));
      if (Number.isFinite(parsed)) return parsed;
    }
    return 0;
  }

  function buildSessionChecklistValue(messages) {
    const source = Array.isArray(messages) ? messages : [];
    // todo_write answers `{cleared: true}` once every item is completed and
    // drops the list; the finished snapshot before it is what the rail shows.
    let clearedAt = null;
    for (let index = source.length - 1; index >= 0; index -= 1) {
      const message = source[index];
      if (message?.kind !== 'tool_result') continue;
      const result = message?.tool_result && typeof message.tool_result === 'object'
        ? message.tool_result : {};
      const toolName = String(result.tool_name || message?.tool_name || message?.toolName || '')
        .trim().toLowerCase();
      if (toolName !== 'todo_write') continue;
      const isError = result.is_error === true || message?.is_error === true;
      const errorCode = String(result.error_code || message?.error_code || '').trim();
      if (isError || errorCode) continue;
      try {
        const outputText = String(result.output_text || result.content || '');
        const parsed = JSON.parse(outputText);
        const timestamp = String(message?.timestamp || '').trim();
        const updatedAt = timestamp && Number.isFinite(Date.parse(timestamp)) ? timestamp : '';
        if (parsed?.cleared === true && clearedAt === null) {
          clearedAt = updatedAt;
          continue;
        }
        const todos = Array.isArray(parsed?.todos) ? parsed.todos.slice(0, 50) : [];
        const items = todos.map((todo) => {
          const content = String(todo?.content ?? '').trim().slice(0, 300);
          const rawStatus = String(todo?.status || '').trim().toLowerCase();
          const status = clearedAt !== null ? 'completed'
            : ['pending', 'in_progress', 'completed'].includes(rawStatus) ? rawStatus : 'pending';
          return content ? { content, status } : null;
        }).filter(Boolean);
        return { items, updatedAt: clearedAt !== null ? clearedAt : updatedAt };
      } catch (_error) {
        return { items: [], updatedAt: '' };
      }
    }
    return { items: [], updatedAt: '' };
  }

  function buildSessionChecklist(messages) {
    try {
      return buildSessionChecklistValue(messages);
    } catch (_error) {
      return { items: [], updatedAt: '' };
    }
  }

  function buildTaskRows(state) {
    const board = state?.companion?.openLoopsBoard || {};
    const sessions = Array.isArray(state?.sessions) ? state.sessions : [];
    const linkedSessions = new Map();
    for (const session of sessions) {
      const taskId = String(session?.linked_task_id || '').trim();
      if (taskId && !linkedSessions.has(taskId)) linkedSessions.set(taskId, String(session?.id || '').trim());
    }
    // Loops inside the delete-undo window are already gone from the user's view.
    const pendingDeleteIds = new Set(Array.isArray(state?.ui?.pendingLoopDeleteIds)
      ? state.ui.pendingLoopDeleteIds.map((id) => String(id || '').trim()).filter(Boolean)
      : []);
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
        if (!followUpId || pendingDeleteIds.has(followUpId)) continue;
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
          projectId: String(entry?.projectId || '').trim(),
          linkedSessionId,
          isCurrentSessionTask: Boolean(linkedSessionId && linkedSessionId === String(state?.currentSessionId || '').trim()),
          originBadge: String(entry?.sessionId || '').trim() ? jt('tasks.rail.agentTask', 'Agent task') : 'Manual',
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
      + field({ id: `taskRailEditTitle-${row.followUpId}`, value: row.title, label: jt('tasks.rail.titleLabel', 'Title'), maxLength: 200 })
      + field({ id: `taskRailEditBody-${row.followUpId}`, value: row.body, label: jt('tasks.rail.notesLabel', 'Notes'), multiline: true, rows: 3, maxLength: 4000 })
      + '<div class="task-rail-editor-actions">'
      + action({ id: 'task-rail-edit-save', label: jt('common.save', 'Save'), variant: 'primary', size: 'sm', dataset: { 'task-id': row.followUpId } })
      + action({ id: 'task-rail-edit-cancel', label: jt('common.cancel', 'Cancel'), variant: 'ghost', size: 'sm' })
      + '</div></div>';
  }

  function renderRow(row, uiState, escapeHtml) {
    const busy = String(uiState.busyTaskId || '') === row.followUpId;
    if (String(uiState.editTaskId || '') === row.followUpId) return renderEditor(row, escapeHtml);
    const resolved = row.status === 'resolved' || row.status === 'archived';
    const meta = [
      row.originBadge,
      row.timingLabel,
      row.sessionTitle ? jt('tasks.rail.fromSession', 'from {sessionTitle}', { sessionTitle: row.sessionTitle }) : '',
      row.isCurrentSessionTask ? jt('tasks.rail.thisSession', 'This session') : '',
    ].filter(Boolean).map(escapeHtml).join(' &middot; ');
    return '<article class="task-rail-row' + (resolved ? ' task-rail-row--resolved' : '') + '" data-task-id="'
      + escapeHtml(row.followUpId) + '"><div class="task-rail-row-main">'
      + checkbox(row, busy) + '<div class="task-rail-copy"><div class="task-rail-title">'
      + escapeHtml(row.title) + '</div>'
      + (row.body ? '<div class="task-rail-notes">' + escapeHtml(row.body) + '</div>' : '')
      + (meta ? '<div class="task-rail-meta">' + meta + '</div>' : '') + '</div>'
      + action({ id: 'task-rail-overflow', plain: true, className: 'task-rail-overflow', ariaLabel: jt('tasks.rail.moreActionsFor', 'More actions for {title}', { title: row.title }), ariaHaspopup: 'menu', disabled: busy, trustedHtml: '<span aria-hidden="true">&#8942;</span>', dataset: { 'task-id': row.followUpId } })
      + '</div></article>';
  }

  function rowsForFilter(rows, filter) {
    if (filter === 'done') return rows.filter((row) => row.section === 'recentResolved');
    if (filter === 'all') return rows;
    return rows.filter((row) => row.section === 'active' || row.section === 'deferred');
  }

  const GENERAL_PROJECT_ID = 'project_general';
  const SCOPE_CHEVRON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4.5 6.5 3.5 3.5 3.5-3.5"/></svg>';

  function isOpenRow(row) {
    return row.section === 'active' || row.section === 'deferred';
  }

  // The controller's scope helper: { mode: 'current'|'all'|'project', projectId,
  // projectName, chatProjectId, projectNames: Map, projectOrder: [] }. Without
  // one (older callers, pure render tests) the rail shows every row as before.
  function normalizeScope(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
      mode: raw.mode === 'all' ? 'all' : raw.mode === 'project' ? 'project' : 'current',
      projectId: String(raw.projectId || ''),
      projectName: String(raw.projectName || ''),
      chatProjectId: String(raw.chatProjectId || ''),
      projectNames: raw.projectNames instanceof Map ? raw.projectNames : new Map(),
      projectOrder: Array.isArray(raw.projectOrder) ? raw.projectOrder.map((id) => String(id || '')) : [],
    };
  }

  // A row with no project (never backfilled) belongs to no single-project scope.
  function scopeRowsFor(rows, scope) {
    if (!scope || scope.mode === 'all') return rows;
    return rows.filter((row) => row.projectId && row.projectId === scope.projectId);
  }

  function projectLabel(scope, projectId) {
    if (!projectId) return jt('tasks.rail.noProject', 'No project');
    return scope.projectNames.get(projectId)
      || (projectId === GENERAL_PROJECT_ID ? jt('projects.switcher.generalName', 'General') : projectId);
  }

  // The project a new task lands in: the scoped one, or the chat's in All projects.
  function addTargetName(scope) {
    if (!scope) return '';
    if (scope.mode === 'all') return scope.chatProjectId ? projectLabel(scope, scope.chatProjectId) : '';
    return scope.projectName || (scope.projectId ? projectLabel(scope, scope.projectId) : '');
  }

  function renderScopeButton(scope, escapeHtml) {
    const name = scope.mode === 'all'
      ? jt('projects.filter.all', 'All projects')
      : scope.projectName || projectLabel(scope, scope.projectId);
    const away = scope.mode === 'project' && scope.projectId !== scope.chatProjectId;
    return action({
      id: 'task-rail-scope',
      domId: 'task-rail-scope',
      plain: true,
      className: 'task-rail-scope' + (away ? ' task-rail-scope--away' : ''),
      ariaHaspopup: 'menu',
      ariaLabel: jt('tasks.rail.scopeLabel', 'Show tasks from: {name}', { name }),
      title: jt('tasks.rail.scopeTitle', 'Show tasks from'),
      dataset: { 'task-scope': scope.mode },
      trustedHtml: '<span class="task-rail-scope-name">' + escapeHtml(name) + '</span>' + SCOPE_CHEVRON,
    });
  }

  // Chat project first, then the switcher's order, unknown ids, General, and
  // the unstamped rows ("No project") last.
  function groupRowsByProject(rows, scope) {
    const byId = new Map();
    for (const row of rows) {
      const id = row.projectId || '';
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(row);
    }
    const order = [];
    const place = (id) => { if (id && byId.has(id) && !order.includes(id)) order.push(id); };
    place(scope.chatProjectId);
    scope.projectOrder.filter((id) => id !== GENERAL_PROJECT_ID).forEach(place);
    Array.from(byId.keys()).filter((id) => id !== GENERAL_PROJECT_ID).forEach(place);
    place(GENERAL_PROJECT_ID);
    if (byId.has('')) order.push('');
    return order.map((id) => ({ id, rows: byId.get(id) }));
  }

  function renderProjectGroup(group, scope, state, escapeHtml) {
    const open = group.rows.filter(isOpenRow).length;
    const detail = [jtn('tasks.rail.groupOpen', open, { count: open }, '{count} open', '{count} open')];
    if (group.id && group.id === scope.chatProjectId) detail.push(jt('tasks.rail.thisChat', 'this chat'));
    return '<div class="task-rail-group"><b>' + escapeHtml(projectLabel(scope, group.id)) + '</b><span>'
      + detail.map(escapeHtml).join(' &middot; ') + '</span></div>'
      + group.rows.map((row) => renderRow(row, state, escapeHtml)).join('');
  }

  function renderFollowUps(visibleRows, scope, state, escapeHtml) {
    if (!visibleRows.length) return '';
    if (scope && scope.mode === 'all') {
      return groupRowsByProject(visibleRows, scope).map((group) => renderProjectGroup(group, scope, state, escapeHtml)).join('');
    }
    return '<div class="task-rail-group"><b>' + escapeHtml(jt('tasks.rail.followUps', 'Follow-ups'))
      + '</b></div>' + visibleRows.map((row) => renderRow(row, state, escapeHtml)).join('');
  }

  function renderChecklist(items, escapeHtml) {
    if (!items.length) return '';
    return '<div class="task-rail-group"><b>' + escapeHtml(jt('tasks.rail.thisConversation', 'This conversation'))
      + '</b><span>' + escapeHtml(jt('tasks.rail.checklistHint', "Jenny's checklist")) + '</span></div>'
      + items.map((item) => '<div class="task-rail-check" data-check-status="'
        + escapeHtml(item.status) + '"><span class="status-dot task-rail-check-dot" aria-hidden="true"></span>'
        + '<span class="task-rail-check-text">' + escapeHtml(item.content) + '</span>'
        + (item.status === 'in_progress' ? '<span class="task-rail-check-meta">'
          + escapeHtml(jt('tasks.rail.inProgress', 'in progress')) + '</span>' : '')
        + '</div>').join('');
  }

  function emptyCopyFor(filter, scope) {
    if (filter === 'done') return jt('tasks.rail.noCompleted', 'No completed tasks yet.');
    if (filter === 'all') return jt('tasks.rail.noTasks', 'No tasks yet. Ask Jenny to file one, or add one above.');
    const project = scope && scope.mode !== 'all' ? addTargetName(scope) : '';
    return project
      ? jt('tasks.rail.noOpenTasksInProject', 'No open tasks in {project}. Ask Jenny to file one, or add one above.', { project })
      : jt('tasks.rail.noOpenTasks', 'No open tasks. Ask Jenny to file one, or add one above.');
  }

  function followUpSummary(openRows, scope) {
    const count = openRows.length;
    const projects = new Set(openRows.map((row) => row.projectId).filter(Boolean)).size; // unstamped rows are not a project
    if (scope && scope.mode === 'all' && projects > 1) {
      return jtn('tasks.rail.followUpsOpenAcross', count, { count, projects },
        '{count} follow-up open in {projects} projects', '{count} follow-ups open in {projects} projects');
    }
    return jtn('tasks.rail.followUpsOpen', count, { count }, '{count} follow-up open', '{count} follow-ups open');
  }

  function renderTaskRailSurface(rows, uiState, helpers) {
    const escapeHtml = typeof helpers?.escapeHtml === 'function' ? helpers.escapeHtml : fallbackEscapeHtml;
    const scope = normalizeScope(helpers?.scope);
    const source = scopeRowsFor(Array.isArray(rows) ? rows : [], scope);
    const state = uiState && typeof uiState === 'object' ? uiState : {};
    const addBusy = String(state.busyTaskId || '') === '__add__';
    const filter = ['open', 'done', 'all'].includes(state.filter) ? state.filter : 'open';
    const visibleRows = rowsForFilter(source, filter);
    const checklist = helpers?.checklist && typeof helpers.checklist === 'object'
      ? helpers.checklist : { items: [], updatedAt: '' };
    const checklistItems = Array.isArray(checklist.items) ? checklist.items : [];
    const visibleChecklistItems = checklistItems.filter((item) => {
      if (filter === 'done') return item?.status === 'completed';
      if (filter === 'all') return true;
      return item?.status !== 'completed';
    });
    const openRows = source.filter(isOpenRow);
    const openCount = openRows.length;
    const checklistDone = checklistItems.filter((item) => item?.status === 'completed').length;
    const filters = typeof inventory.segmentedControl === 'function' ? inventory.segmentedControl({
      id: 'task-rail-filter', ariaLabel: jt('tasks.rail.filterLabel', 'Task filter'), value: filter, className: 'task-rail-filters',
      dataset: { action: 'task-rail-filter' },
      options: [{ value: 'open', label: jt('common.open', 'Open') }, { value: 'done', label: jt('common.done', 'Done') }, { value: 'all', label: jt('tasks.rail.all', 'All') }],
    }) : '';
    const summary = [
      checklistItems.length
        ? jt('tasks.rail.checklistProgress', '{done} of {total} done', { done: checklistDone, total: checklistItems.length })
        : '',
      followUpSummary(openRows, scope),
    ].filter(Boolean).map(escapeHtml).join(' &middot; ');
    const checklistMarkup = renderChecklist(visibleChecklistItems, escapeHtml);
    const followUpMarkup = renderFollowUps(visibleRows, scope, state, escapeHtml);
    const list = checklistMarkup || followUpMarkup
      ? checklistMarkup + followUpMarkup
      : '<div class="task-rail-empty">' + escapeHtml(emptyCopyFor(filter, scope)) + '</div>';
    const target = addTargetName(scope);
    const placeholder = target
      ? jt('tasks.rail.addToProject', 'Add a task to {project}', { project: target })
      : jt('tasks.rail.addFollowUpPlaceholder', 'Add a follow-up');
    // The panel header carries the "Tasks" title and Close; the rail keeps the summary.
    return '<section class="task-rail-surface" aria-label="' + escapeHtml(jt('artifactPanelV2Render.tasks', 'Tasks')) + '"><header class="task-rail-header">'
      + '<span class="task-rail-summary">' + summary + '</span>' + (scope ? renderScopeButton(scope, escapeHtml) : '') + '</header>'
      + filters + '<div class="task-rail-add">'
      + field({ id: 'taskRailDraftTitle', value: String(state.draftTitle || ''), placeholder, ariaLabel: jt('tasks.rail.taskTitle', 'Task title'), multiline: true, rows: 1, maxLength: 200, disabled: addBusy, dataset: { 'task-draft-title': '' } })
      + action({ id: 'task-rail-add', label: jt('tasks.rail.add', 'Add'), variant: 'primary', size: 'sm', disabled: addBusy }) + '</div>'
      + (state.lastError ? '<div class="task-rail-error" role="alert">' + escapeHtml(state.lastError) + '</div>' : '')
      + '<div class="task-rail-list">' + list + '</div><footer class="task-rail-footer"><span>'
      + escapeHtml(jt('tasks.rail.autoRefreshNote', 'Refreshes automatically when the model files a task.')) + '</span>'
      + action({ id: 'task-rail-send-list', label: jt('tasks.rail.sendListToChat', 'Send list to chat'), variant: 'ghost', size: 'sm', disabled: openCount === 0 })
      + '</footer></section>';
  }

  return { buildSessionChecklist, buildTaskRows, renderTaskRailSurface, scopeRows: (rows, scope) => scopeRowsFor(Array.isArray(rows) ? rows : [], normalizeScope(scope)) };
});
