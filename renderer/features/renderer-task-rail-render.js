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
  const chatsPanelTree = typeof require === 'function' ? require('../shell/renderer-chats-panel-tree') : null;

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
          createdAt: String(entry?.createdAt || '').trim(),
          deferredUntil: String(entry?.deferredUntil || '').trim(),
          doneAt: String(entry?.resolvedAt || entry?.archivedAt || '').trim(),
          sessionId: String(entry?.sessionId || '').trim(),
          sessionTitle: String(entry?.sessionTitle || '').trim(),
          projectId: String(entry?.projectId || '').trim(),
          linkedSessionId,
          isCurrentSessionTask: Boolean(linkedSessionId && linkedSessionId === String(state?.currentSessionId || '').trim()),
          _recency: timestampOf(entry),
          _sourceOrder: order,
        });
      }
    }
    // Open before finished; then this chat's own task, due, and open before
    // snoozed; newest first within.
    const snoozed = (row) => (row.section === 'deferred' ? 1 : 0);
    rows.sort((left, right) => {
      if (isOpenRow(left) !== isOpenRow(right)) return isOpenRow(left) ? -1 : 1;
      if (left.isCurrentSessionTask !== right.isCurrentSessionTask) return left.isCurrentSessionTask ? -1 : 1;
      if (left.isDue !== right.isDue) return left.isDue ? -1 : 1;
      return snoozed(left) - snoozed(right) || right._recency - left._recency || left._sourceOrder - right._sourceOrder;
    });
    return rows.map(({ _recency, _sourceOrder, ...row }) => row);
  }

  function action(options) {
    return typeof inventory.actionButton === 'function' ? inventory.actionButton(options) : '';
  }

  function field(options) {
    return typeof inventory.textField === 'function' ? inventory.textField(options) : '';
  }

  function isOpenRow(row) {
    return row.section === 'active' || row.section === 'deferred';
  }

  // The chat list's short relative time ("now", "12m", "3h", "Oct 19").
  function relativeTime(value) {
    const tree = globalThis.rendererChatsPanelTree || chatsPanelTree;
    return value && typeof tree?.formatSessionTime === 'function' ? tree.formatSessionTime(value) : '';
  }

  // When a snoozed task comes back: a time today, Tomorrow, a weekday, or a date.
  function snoozeLabel(value) {
    const at = new Date(value || '');
    if (Number.isNaN(at.valueOf())) return '';
    const tag = globalThis.jennyI18n?.tag?.();
    const dayStart = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).valueOf();
    const days = Math.round((dayStart(at) - dayStart(new Date())) / 86400000);
    if (days <= 0) return at.toLocaleTimeString(tag, { hour: 'numeric', ...globalThis.jennyI18n?.timeOptions?.(), minute: '2-digit' });
    if (days === 1) return jt('companion.defer.tomorrow', 'Tomorrow');
    return at.toLocaleDateString(tag, days < 7 ? { weekday: 'short' } : { month: 'short', day: 'numeric' });
  }

  // The one fact a row shows beside its title.
  function rowFact(row) {
    if (!isOpenRow(row)) return { text: relativeTime(row.doneAt), tone: '' };
    if (row.section === 'deferred') return { text: snoozeLabel(row.deferredUntil), tone: '' };
    if (row.isDue) return { text: jt('companion.openLoops.timing.dueNow', 'Due now'), tone: 'due' };
    if (row.isCurrentSessionTask) return { text: jt('tasks.rail.thisSession', 'This session'), tone: 'here' };
    return { text: relativeTime(row.createdAt), tone: '' };
  }

  function checkbox(row, busy) {
    return typeof inventory.checkbox === 'function' ? inventory.checkbox({
      id: `taskRailCheck-${row.followUpId}`,
      checked: row.status === 'resolved' || row.status === 'archived',
      disabled: busy,
      ariaLabel: `${row.status === 'resolved' || row.status === 'archived' ? 'Reopen' : 'Complete'} ${row.title}`,
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

  // Opened by its title: the notes, where it came from, and the one way into its chat.
  function renderDetail(row, busy, detailId, escapeHtml) {
    const origin = row.sessionTitle
      ? jt('tasks.rail.fromSession', 'from {sessionTitle}', { sessionTitle: row.sessionTitle })
      : jt('tasks.rail.addedByYou', 'Added by you');
    return '<div class="task-rail-detail" id="' + escapeHtml(detailId) + '">'
      + (row.body ? '<div class="task-rail-notes">' + escapeHtml(row.body) + '</div>' : '')
      + '<div class="task-rail-meta">' + escapeHtml(origin) + '</div>'
      + '<div class="task-rail-detail-actions">'
      + action({
        id: row.linkedSessionId ? 'task-rail-open-session' : 'task-rail-start', size: 'sm', disabled: busy,
        label: row.linkedSessionId ? jt('tasks.rail.openSession', 'Open session') : jt('tasks.rail.startSession', 'Start a session'),
        dataset: { 'task-id': row.followUpId },
      })
      + action({ id: 'task-rail-edit', label: jt('common.edit', 'Edit'), variant: 'ghost', size: 'sm', disabled: busy, dataset: { 'task-id': row.followUpId } })
      + '</div></div>';
  }

  function renderRow(row, uiState, escapeHtml) {
    const busy = String(uiState.busyTaskId || '') === row.followUpId;
    if (String(uiState.editTaskId || '') === row.followUpId) return renderEditor(row, escapeHtml);
    const resolved = row.status === 'resolved' || row.status === 'archived';
    const expanded = String(uiState.expandedTaskId || '') === row.followUpId;
    const detailId = `taskRailDetail-${row.followUpId}`;
    const fact = rowFact(row);
    return '<article class="task-rail-row' + (resolved ? ' task-rail-row--resolved' : row.section === 'deferred' ? ' task-rail-row--later' : '')
      + '" data-task-id="' + escapeHtml(row.followUpId) + '" data-expanded="' + expanded + '"><div class="task-rail-row-main">'
      + checkbox(row, busy)
      + action({
        id: 'task-rail-toggle', plain: true, className: 'task-rail-title', label: row.title, ariaExpanded: expanded,
        ariaControls: expanded ? detailId : '', title: row.body ? row.body.slice(0, 300) : '', dataset: { 'task-id': row.followUpId },
      })
      + '<span class="task-rail-fact' + (fact.tone ? ' task-rail-fact--' + fact.tone : '') + '">' + escapeHtml(fact.text) + '</span>'
      + action({ id: 'task-rail-overflow', plain: true, className: 'task-rail-overflow', ariaLabel: jt('tasks.rail.moreActionsFor', 'More actions for {title}', { title: row.title }), ariaHaspopup: 'menu', disabled: busy, trustedHtml: '<span aria-hidden="true">&#8942;</span>', dataset: { 'task-id': row.followUpId } })
      + '</div>' + (expanded ? renderDetail(row, busy, detailId, escapeHtml) : '') + '</article>';
  }

  function rowsForFilter(rows, filter) {
    if (filter === 'done') return rows.filter((row) => row.section === 'recentResolved');
    if (filter === 'all') return rows;
    return rows.filter(isOpenRow);
  }

  const GENERAL_PROJECT_ID = 'project_general';
  const SCOPE_CHEVRON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4.5 6.5 3.5 3.5 3.5-3.5"/></svg>';
  const ADD_GLYPH = '<svg class="task-rail-add-glyph" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>';

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

  // A section heading: its name, optional facts beside it, an optional action at the end.
  function groupHeading(name, details, trailing, escapeHtml) {
    const facts = details.filter(Boolean).map(escapeHtml).join(' &middot; ');
    return '<div class="task-rail-group"><b>' + escapeHtml(name) + '</b>'
      + (facts ? '<span>' + facts + '</span>' : '') + (trailing || '') + '</div>';
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

  function renderFollowUps(visibleRows, scope, state, escapeHtml, sendAction) {
    if (!visibleRows.length) return '';
    const rowsMarkup = (rows) => rows.map((row) => renderRow(row, state, escapeHtml)).join('');
    if (scope && scope.mode === 'all') {
      const groups = groupRowsByProject(visibleRows, scope);
      const sendIndex = groups.findIndex((group) => group.rows.some(isOpenRow));
      return groups.map((group, index) => {
        const open = group.rows.filter(isOpenRow).length;
        const detail = [jtn('tasks.rail.groupOpen', open, { count: open }, '{count} open', '{count} open')];
        if (group.id && group.id === scope.chatProjectId) detail.push(jt('tasks.rail.thisChat', 'this chat'));
        return groupHeading(projectLabel(scope, group.id), detail, index === sendIndex ? sendAction : '', escapeHtml)
          + rowsMarkup(group.rows);
      }).join('');
    }
    const open = visibleRows.filter(isOpenRow);
    const done = visibleRows.filter((row) => !isOpenRow(row));
    const followUps = jt('tasks.rail.followUps', 'Follow-ups');
    return (open.length ? groupHeading(followUps, [], sendAction, escapeHtml) + rowsMarkup(open) : '')
      + (done.length ? groupHeading(open.length ? jt('common.done', 'Done') : followUps, [], '', escapeHtml) + rowsMarkup(done) : '');
  }

  // Jenny's checklist: the step she is on leads; in Open, finished steps fold into one toggle line.
  function renderChecklist(items, filter, foldOpen, escapeHtml) {
    if (!items.length) return '';
    const done = items.filter((item) => item?.status === 'completed');
    const foldable = filter === 'open' && done.length > 0;
    const shown = filter === 'done' ? done
      : filter === 'all' || foldOpen ? items : items.filter((item) => item?.status !== 'completed');
    if (!shown.length && !foldable) return '';
    return groupHeading(jt('tasks.rail.checklistHint', "Jenny's checklist"),
      [jt('tasks.rail.checklistProgress', '{done} of {total} done', { done: done.length, total: items.length })], '', escapeHtml)
      + (foldable ? action({
        id: 'task-rail-checklist-fold', plain: true, className: 'task-rail-check-fold', ariaExpanded: foldOpen,
        trustedHtml: '<span class="status-dot task-rail-check-dot" aria-hidden="true"></span><span>'
          + escapeHtml(jt('tasks.rail.checklistDoneFold', '{count} done', { count: done.length })) + '</span>',
      }) : '')
      + shown.map((item) => '<div class="task-rail-check" data-check-status="'
        + escapeHtml(item.status) + '"><span class="status-dot task-rail-check-dot" aria-hidden="true"></span>'
        + '<span class="task-rail-check-text">' + escapeHtml(item.content) + '</span>'
        + (item.status === 'in_progress' ? '<span class="task-rail-check-meta">'
          + escapeHtml(jt('tasks.rail.now', 'now')) + '</span>' : '')
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

  function renderTaskRailSurface(rows, uiState, helpers) {
    const escapeHtml = typeof helpers?.escapeHtml === 'function' ? helpers.escapeHtml : fallbackEscapeHtml;
    const scope = normalizeScope(helpers?.scope);
    const source = scopeRowsFor(Array.isArray(rows) ? rows : [], scope);
    const state = uiState && typeof uiState === 'object' ? uiState : {};
    const addBusy = String(state.busyTaskId || '') === '__add__';
    // All leads and is the default: open and finished tasks at a glance.
    const filter = ['open', 'done', 'all'].includes(state.filter) ? state.filter : 'all';
    const visibleRows = rowsForFilter(source, filter);
    const checklist = helpers?.checklist && typeof helpers.checklist === 'object'
      ? helpers.checklist : { items: [], updatedAt: '' };
    const checklistItems = Array.isArray(checklist.items) ? checklist.items : [];
    const openCount = source.filter(isOpenRow).length;
    const checklistDone = checklistItems.filter((item) => item?.status === 'completed').length;
    const openTotal = openCount + checklistItems.length - checklistDone;
    const doneTotal = source.filter((row) => row.section === 'recentResolved').length + checklistDone;
    const filters = typeof inventory.segmentedControl === 'function' ? inventory.segmentedControl({
      id: 'task-rail-filter', ariaLabel: jt('tasks.rail.filterLabel', 'Task filter'), value: filter, className: 'task-rail-filters inv-segmented--compact',
      dataset: { action: 'task-rail-filter' },
      options: [
        { value: 'all', label: jt('tasks.rail.all', 'All') },
        { value: 'open', label: openTotal ? jt('tasks.rail.filterOpen', 'Open {count}', { count: openTotal }) : jt('common.open', 'Open') },
        { value: 'done', label: doneTotal ? jt('tasks.rail.filterDone', 'Done {count}', { count: doneTotal }) : jt('common.done', 'Done') },
      ],
    }) : '';
    const sendAction = openCount ? action({ id: 'task-rail-send-list', plain: true, className: 'task-rail-group-action', label: jt('tasks.rail.sendListToChat', 'Send list to chat') }) : '';
    const checklistMarkup = renderChecklist(checklistItems, filter, helpers?.checklistFoldOpen === true, escapeHtml);
    const followUpMarkup = renderFollowUps(visibleRows, scope, state, escapeHtml, sendAction);
    const list = checklistMarkup || followUpMarkup
      ? checklistMarkup + followUpMarkup
      : '<div class="task-rail-empty">' + escapeHtml(emptyCopyFor(filter, scope)) + '</div>';
    const target = addTargetName(scope);
    const placeholder = target
      ? jt('tasks.rail.addToProject', 'Add a task to {project}', { project: target })
      : jt('tasks.rail.addFollowUpPlaceholder', 'Add a follow-up');
    // The panel header carries the "Tasks" title and Close; one toolbar row holds
    // the filter (with counts) and the project scope.
    return '<section class="task-rail-surface" aria-label="' + escapeHtml(jt('artifactPanelV2Render.tasks', 'Tasks')) + '"><header class="task-rail-header">'
      + filters + (scope ? renderScopeButton(scope, escapeHtml) : '') + '</header>'
      + '<div class="task-rail-add">' + ADD_GLYPH
      + field({ id: 'taskRailDraftTitle', value: String(state.draftTitle || ''), placeholder, ariaLabel: jt('tasks.rail.taskTitle', 'Task title'), multiline: true, rows: 1, maxLength: 200, disabled: addBusy, dataset: { 'task-draft-title': '' } })
      + action({ id: 'task-rail-add', label: jt('tasks.rail.add', 'Add'), variant: 'primary', size: 'sm', disabled: addBusy }) + '</div>'
      + (state.lastError ? '<div class="task-rail-error" role="alert">' + escapeHtml(state.lastError) + '</div>' : '')
      + '<div class="task-rail-list">' + list + '</div></section>';
  }

  return { buildSessionChecklist, buildTaskRows, renderTaskRailSurface, scopeRows: (rows, scope) => scopeRowsFor(Array.isArray(rows) ? rows : [], normalizeScope(scope)) };
});
