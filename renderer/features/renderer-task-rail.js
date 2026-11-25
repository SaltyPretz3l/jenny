(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-task-rail-render'), require('../shared/task-brief-utils'));
    return;
  }
  root.rendererTaskRail = factory(root.rendererTaskRailRender, root.rendererTaskBriefUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (taskRailRender, taskBriefUtils) {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const GENERAL_PROJECT_ID = 'project_general';
  const PROJECTS_CHANGED_EVENT = 'jenny:projects-changed';
  const render = taskRailRender || {};
  const buildTaskBrief = typeof taskBriefUtils?.buildTaskBrief === 'function'
    ? taskBriefUtils.buildTaskBrief : (task) => String(task?.title || '');
  function noop() {}

  const fallbackEscapeHtml = (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  function createTaskRail(deps) {
    const d = deps || {};
    const state = d.state;
    if (!state || typeof state !== 'object') throw new Error('renderer-task-rail: state dep is required');
    const windowRef = d.windowRef || globalRef.window || globalRef;
    const dom = d.dom || {};
    const panelEl = dom.artifactReviewPanel || windowRef?.document?.getElementById?.('artifactReviewPanel') || null;
    const utilityCluster = dom.utilityCluster || windowRef?.document?.getElementById?.('chatTimelineUtilityCluster') || null;
    const chatInput = dom.chatInput || windowRef?.document?.getElementById?.('chatInput') || null;
    const escapeHtml = typeof d.escapeHtml === 'function' ? d.escapeHtml : fallbackEscapeHtml;
    const openArtifactRail = typeof d.openArtifactRail === 'function' ? d.openArtifactRail : noop;
    const renderArtifactReviewPanel = typeof d.renderArtifactReviewPanel === 'function' ? d.renderArtifactReviewPanel : noop;
    const setActiveView = typeof d.setActiveView === 'function' ? d.setActiveView : noop;
    const syncComposerInputHeight = typeof d.syncComposerInputHeight === 'function' ? d.syncComposerInputHeight : noop;
    const renderAll = typeof d.renderAll === 'function' ? d.renderAll : noop;
    const appendClientLog = typeof d.appendClientLog === 'function' ? d.appendClientLog : noop;
    const showToastMessage = typeof d.showToastMessage === 'function' ? d.showToastMessage : noop;
    const activateWorkspaceSession = typeof d.activateWorkspaceSession === 'function' ? d.activateWorkspaceSession : noop;
    const toggleArtifactReview = typeof d.toggleArtifactReview === 'function' ? d.toggleArtifactReview : noop;
    const getProjectSwitcher = typeof d.getProjectSwitcher === 'function' ? d.getProjectSwitcher : null;
    // Choosing Notes opens the Notes side (the entry loads its modules lazily); the strip hears of count changes.
    const openNotes = typeof d.openNotes === 'function' ? d.openNotes : () => { openArtifactRail('notes'); renderArtifactReviewPanel(); };
    const onSignalsChanged = typeof d.onSignalsChanged === 'function' ? d.onSignalsChanged : noop;
    const inventory = d.inventory || windowRef.inventory || globalRef.inventory || {};
    const companionApi = windowRef?.jennyShell?.companion || {};
    const listenerToken = `task-rail-${Math.random().toString(36).slice(2)}`;
    let toggleEl = null;
    let panelListenersBound = false;
    let toggleBound = false;
    let disposed = false;
    let flashTimer = null;
    let initialRefreshStarted = false;
    let lastSignalCount = -1;
    // The shared project switcher loads lazily; hold it once it resolves so the
    // synchronous render can name projects (see requestProjectSwitcher).
    let projectSwitcher = null;
    let switcherRequested = false;
    let projectsListenerBound = false;

    function isEnabled() {
      return state.features?.featureFlags?.tools_task_board_enabled === true;
    }

    function ensureUiState() {
      if (!state.ui || typeof state.ui !== 'object') state.ui = {};
      if (!state.ui.taskRail || typeof state.ui.taskRail !== 'object') {
        state.ui.taskRail = { filter: 'all', draftTitle: '', busyTaskId: '', editTaskId: '', expandedTaskId: '', lastError: '', scope: 'current', hiddenIds: [] };
      }
      const ui = state.ui.taskRail;
      if (!['open', 'done', 'all'].includes(ui.filter)) ui.filter = 'all';
      // 'current' follows the active chat's project; 'all'; or a project id.
      ui.scope = typeof ui.scope === 'string' && ui.scope.trim() ? ui.scope.trim() : 'current';
      ui.draftTitle = String(ui.draftTitle || '');
      ui.busyTaskId = String(ui.busyTaskId || '');
      ui.editTaskId = String(ui.editTaskId || '');
      ui.lastError = String(ui.lastError || '');
      if (!Array.isArray(ui.hiddenIds)) ui.hiddenIds = [];
      return ui;
    }

    function buildRows() {
      return typeof render.buildTaskRows === 'function' ? render.buildTaskRows(state) : [];
    }

    const isOpenRow = (row) => row.section === 'active' || row.section === 'deferred';

    // The active chat's project: its stored id (General when the chat has
    // none), or '' while the chat is not in the session list yet.
    function chatProjectId() {
      const sessionId = String(state.currentSessionId || '').trim();
      const sessions = Array.isArray(state.sessions) ? state.sessions : [];
      const session = sessionId ? sessions.find((entry) => String(entry?.id || '') === sessionId) : null;
      return session ? String(session.project_id || '').trim() || GENERAL_PROJECT_ID : '';
    }

    function effectiveScopeProjectId() {
      const { scope } = ensureUiState();
      return scope === 'current' ? chatProjectId() : scope === 'all' ? '' : scope;
    }

    function requestProjectSwitcher() {
      if (projectSwitcher) return Promise.resolve(projectSwitcher);
      if (!getProjectSwitcher) return Promise.resolve(null);
      return Promise.resolve(getProjectSwitcher()).then(async (switcher) => {
        if (disposed || !switcher) return null;
        if (!projectSwitcher) {
          projectSwitcher = switcher;
          try { await switcher.refresh?.(); } catch (_error) { /* names fall back to ids */ }
          handleProjectsChanged();
        }
        return switcher;
      }).catch(() => null);
    }

    // A picked project that no longer exists falls back to following the chat.
    function reconcileScope() {
      const ui = ensureUiState();
      if (ui.scope === 'current' || ui.scope === 'all' || ui.scope === GENERAL_PROJECT_ID || !projectSwitcher) return;
      const projects = projectSwitcher.getProjects?.() || [];
      if (projects.length && !projectSwitcher.projectById?.(ui.scope)) ui.scope = 'current';
    }

    function scopeHelper() {
      if (!projectSwitcher && !switcherRequested) { switcherRequested = true; void requestProjectSwitcher(); }
      reconcileScope();
      const scope = ensureUiState().scope;
      const chatId = chatProjectId();
      const names = render.projectNameMap(projectSwitcher, state.sessions, [chatId, scope, ...buildRows().map((row) => row.projectId)]);
      const projectId = effectiveScopeProjectId();
      return {
        mode: scope === 'all' ? 'all' : scope === 'current' ? 'current' : 'project',
        projectId,
        projectName: projectId ? names.get(projectId) || '' : '',
        chatProjectId: chatId,
        projectNames: names,
        projectOrder: Array.from(names.keys()),
      };
    }

    async function openScopeMenu(anchor) {
      const switcher = await requestProjectSwitcher();
      const menu = switcher?.menu;
      if (!menu?.show || disposed) return;
      if (menu.isOpen?.()) { menu.close(); return; }
      try { await switcher.refresh?.(); } catch (_error) { /* the cached list stands */ }
      if (disposed) return;
      const helper = scopeHelper();
      menu.show({
        anchor,
        heading: jt('tasks.rail.scopeHeading', 'Show tasks from'),
        rows: render.scopeMenuRows(switcher, helper, buildRows()),
        onPick: (row) => {
          const id = String(row.id || '');
          ensureUiState().scope = !id ? 'all' : id === helper.chatProjectId ? 'current' : id;
          rerender();
        },
      });
    }

    function currentChecklist() {
      const sessionId = String(state.currentSessionId || '').trim();
      const messages = state.messagesBySession instanceof Map
        ? state.messagesBySession.get(sessionId) || [] : [];
      return typeof render.buildSessionChecklist === 'function'
        ? render.buildSessionChecklist(messages) : { items: [], updatedAt: '' };
    }

    function isTasksMode() {
      return state.ui?.artifactReview?.mode === 'tasks';
    }

    function isRailVisible() {
      const prefs = state.ui?.artifactReview || {};
      return prefs.enabled === true && prefs.collapsed !== true && !panelEl?.classList?.contains('hidden');
    }

    function syncToggle() {
      if (!toggleEl) return;
      const active = isTasksMode() && isRailVisible();
      toggleEl.setAttribute('aria-pressed', active ? 'true' : 'false');
      toggleEl.classList.toggle('active', active);
    }

    const storage = () => { try { return windowRef.localStorage || null; } catch (_error) { return null; } };

    // Open follow-ups of the active chat's project, whatever scope the rail shows.
    function openTaskCount() {
      return typeof render.openTaskCount === 'function' ? render.openTaskCount(buildRows(), chatProjectId()) : 0;
    }

    // The tab strip reads openTaskCount(); this tells it when the number moved.
    function syncSignals() {
      syncToggle();
      const count = openTaskCount();
      if (count !== lastSignalCount) { lastSignalCount = count; onSignalsChanged(); }
      return count;
    }

    function applyCompanionPayload(payload) {
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) state.companion = payload;
      return state.companion;
    }

    async function refreshCompanion() {
      if (typeof companionApi.getState !== 'function') return state.companion;
      const payload = await companionApi.getState();
      if (disposed) return state.companion;
      return applyCompanionPayload(payload);
    }

    function renderRailContent(surface) {
      const host = render.prepareSurface?.(surface);
      if (!host) return false;
      // A chat in another project ends the Undo line: the deletion is made for good.
      const pending = ensureUiState().pendingDelete;
      if (pending && chatProjectId() && pending.projectId !== chatProjectId()) void commitPendingDelete();
      // The list re-renders wholesale (opening a row, folds, refreshes); keep its scroll.
      const scrollTop = host.querySelector?.('.task-rail-list')?.scrollTop || 0;
      host.innerHTML = typeof render.renderTaskRailSurface === 'function'
        ? render.renderTaskRailSurface(buildRows(), ensureUiState(), { escapeHtml, scope: scopeHelper() }) : '';
      const list = host.querySelector?.('.task-rail-list');
      if (list && scrollTop) list.scrollTop = scrollTop;
      render.rememberSide?.(chatProjectId(), 'tasks', storage());
      syncSignals();
      return true;
    }

    function rerender() {
      renderArtifactReviewPanel();
      syncToggle();
    }

    // Re-paints the rail after the chat or its project changed (the scope follows the chat). It never
    // throws away a follow-up being edited or a draft being typed; the signals sync either way.
    function refreshChecklist(options) {
      if (disposed) return;
      const sessionId = String(options?.sessionId || '').trim();
      if (sessionId && sessionId !== String(state.currentSessionId || '').trim()) return;
      const activeEl = panelEl?.ownerDocument?.activeElement;
      const typing = Boolean(ensureUiState().editTaskId)
        || Boolean(activeEl && panelEl?.contains?.(activeEl) && activeEl.closest?.('.task-rail-add, .task-rail-editor'));
      if (!typing && isTasksMode() && isRailVisible()) {
        const currentSurface = panelEl?.querySelector?.('.task-rail-surface');
        if (currentSurface?.parentElement) renderRailContent(currentSurface.parentElement);
        else rerender();
      }
      syncSignals();
    }

    const findInPanel = (selector, attr, id) => Array.from(panelEl?.querySelectorAll?.(selector) || []).find((el) => el.getAttribute(attr) === id) || null;
    function rowById(taskId) {
      const id = String(taskId || '').trim();
      return buildRows().find((row) => row.followUpId === id) || null;
    }

    async function runMutation(taskId, operation) {
      const ui = ensureUiState();
      ui.busyTaskId = String(taskId || '');
      ui.lastError = '';
      rerender();
      try {
        const payload = await operation();
        if (disposed) return false;
        applyCompanionPayload(payload);
        ui.busyTaskId = '';
        rerender();
        syncSignals();
        return true;
      } catch (error) {
        if (disposed) return false;
        ui.busyTaskId = '';
        ui.lastError = jt('tasks.rail.updateFailed', 'Task update failed.');
        appendClientLog('WARN', 'task_rail.update_failed', { name: String(error?.name || 'Error').slice(0, 80) });
        showToastMessage(jt('tasks.rail.updateFailed', 'Task update failed.'));
        rerender();
        return false;
      }
    }

    function open(taskId) {
      if (!isEnabled() || disposed) return false;
      openArtifactRail('tasks');
      renderArtifactReviewPanel();
      const id = String(taskId || '').trim();
      if (!id) return true;
      const row = findInPanel('[data-task-id]', 'data-task-id', id);
      row?.scrollIntoView?.({ block: 'center', behavior: 'auto' });
      const reduced = windowRef?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
      if (row && !reduced) {
        row.classList.add('task-rail-row--flash');
        if (flashTimer) windowRef.clearTimeout(flashTimer);
        flashTimer = windowRef.setTimeout(() => row.classList.remove('task-rail-row--flash'), 1200);
      }
      return true;
    }

    async function notifyMutation() {
      if (disposed) return;
      try {
        await refreshCompanion();
        if (disposed) return;
        if (isTasksMode() && isRailVisible()) rerender();
        syncSignals();
      } catch (error) {
        appendClientLog('WARN', 'task_rail.refresh_failed', { message: String(error?.message || error || '').slice(0, 200) });
      }
    }

    function addTask() {
      const ui = ensureUiState();
      if (ui.busyTaskId === '__add__') return;
      const input = panelEl?.querySelector?.('[data-task-draft-title]');
      const title = String(input?.value || '').trim();
      if (!title) {
        input?.focus?.();
        return;
      }
      ui.draftTitle = title;
      // A new task lands in the scoped project, or the chat's in All projects.
      const projectId = effectiveScopeProjectId() || chatProjectId();
      void runMutation('__add__', () => companionApi.addFollowUp({
        label: title, body: '', status: 'active', sourceKind: 'agent_task', sessionId: '',
        ...(projectId ? { projectId } : {}),
      })).then((ok) => {
        if (!ok || disposed) return;
        ensureUiState().draftTitle = '';
        rerender();
      });
    }

    function sendListToChat() {
      const rows = (typeof render.scopeRows === 'function' ? render.scopeRows(buildRows(), scopeHelper()) : buildRows()).filter(isOpenRow);
      if (!rows.length || !chatInput) return;
      chatInput.value = 'Open tasks:\n' + rows.map((row) => `- ${row.title} (id ${row.followUpId})`).join('\n');
      syncComposerInputHeight();
      setActiveView('chat');
      chatInput.focus();
      renderAll();
      showToastMessage(jt('tasks.rail.addedToComposer', 'Task list added to the composer.'));
    }

    function saveEditor(taskId) {
      const editor = findInPanel('[data-task-editor]', 'data-task-editor', taskId);
      const fields = editor?.querySelectorAll?.('.inv-text-field-control') || [];
      const label = String(fields[0]?.value || '').trim();
      if (!label) return fields[0]?.focus?.();
      void runMutation(taskId, () => companionApi.updateFollowUp(taskId, {
        label, body: String(fields[1]?.value || '').trim(),
      })).then((ok) => {
        if (ok && !disposed) { ensureUiState().editTaskId = ''; rerender(); }
      });
    }

    async function openOrStartSession(row) {
      if (!row) return;
      if (row.linkedSessionId) return activateWorkspaceSession(row.linkedSessionId);
      const ui = ensureUiState();
      if (ui.busyTaskId === row.followUpId) return;
      ui.busyTaskId = row.followUpId;
      rerender();
      try {
        await Promise.resolve(windowRef.rendererTaskSessionActions?.start?.({
          title: row.title,
          initialPrompt: buildTaskBrief(row, { linkedTaskId: row.followUpId }),
          linkedTaskId: row.followUpId,
          ...(row.projectId ? { projectId: row.projectId } : {}),
        }));
      } finally {
        if (!disposed) { ui.busyTaskId = ''; rerender(); }
      }
    }

    // Delete is permanent in the store, so the row is held back and the real deletion
    // runs when the Undo line goes (another delete, the side or project changes, the tab closes).
    function deleteTask(row) {
      const ui = ensureUiState();
      void commitPendingDelete();
      ui.hiddenIds.push(row.followUpId);
      ui.pendingDelete = { id: row.followUpId, projectId: chatProjectId() };
      rerender();
      syncSignals();
    }

    async function commitPendingDelete() {
      const ui = ensureUiState();
      const pending = ui.pendingDelete;
      if (!pending) return;
      ui.pendingDelete = null;
      try {
        const payload = await companionApi.deleteFollowUp(pending.id);
        if (!disposed) applyCompanionPayload(payload);
      } catch (error) {
        appendClientLog('WARN', 'task_rail.delete_failed', { name: String(error?.name || 'Error').slice(0, 80) });
        showToastMessage(jt('tasks.rail.updateFailed', 'Task update failed.'));
      }
      ui.hiddenIds = ui.hiddenIds.filter((id) => id !== pending.id);
      if (!disposed) { rerender(); syncSignals(); }
    }

    function undoDelete() {
      const ui = ensureUiState();
      const pending = ui.pendingDelete;
      if (!pending) return;
      ui.pendingDelete = null;
      ui.hiddenIds = ui.hiddenIds.filter((id) => id !== pending.id);
      rerender();
      syncSignals();
      findInPanel('[data-action="task-rail-toggle"]', 'data-task-id', pending.id)?.focus?.();
    }

    async function switchToNotes() {
      void commitPendingDelete();
      render.rememberSide?.(chatProjectId(), 'notes', storage());
      await Promise.resolve(openNotes());
      if (!disposed) render.focusSide?.(panelEl, 'notes');
    }

    function showOverflow(anchor, row) {
      const contextMenu = inventory.contextMenu || windowRef.inventoryContextMenu;
      if (!contextMenu?.show || !row) return;
      const items = [
        {
          label: row.linkedSessionId
            ? jt('tasks.rail.openSession', 'Open session')
            : jt('tasks.rail.startSession', 'Start a session'),
          disabled: String(ensureUiState().busyTaskId || '') === row.followUpId,
          action: () => openOrStartSession(row),
        },
        { label: jt('common.edit', 'Edit'), action: () => { ensureUiState().editTaskId = row.followUpId; rerender(); } },
      ];
      // The service rejects defer on resolved/archived loops; a done task reopens instead.
      if (row.status === 'resolved') {
        items.push(
          { label: jt('companion.actions.reopen', 'Reopen'), action: () => runMutation(row.followUpId, () => companionApi.activateFollowUp(row.followUpId)) },
          { label: jt('tasks.rail.archive', 'Archive'), action: () => runMutation(row.followUpId, () => companionApi.archiveFollowUp(row.followUpId)) },
        );
      } else if (row.status !== 'archived') {
        items.push({ label: jt('tasks.rail.deferUntilTomorrow', 'Defer until tomorrow'), action: () => runMutation(row.followUpId, () => companionApi.deferFollowUp(row.followUpId, 'tomorrow')) });
      }
      items.push({ separator: true }, {
        label: jt('common.delete', 'Delete'), danger: true,
        action: () => deleteTask(row),
      });
      anchor.setAttribute('aria-expanded', 'true'); // Keeps the hover-only button visible while its menu is open.
      contextMenu.show({ anchorEl: anchor, rootEl: panelEl, restoreFocusTo: anchor, items, onHide: () => anchor.setAttribute('aria-expanded', 'false') });
    }

    async function handlePanelClick(event) {
      if (disposed || !isTasksMode()) return;
      const target = event.target;
      if (target?.closest?.('[data-action="task-rail-filter"]')) {
        const option = target.closest?.('[data-value]');
        return option ? setFilter(option.dataset.value) : undefined;
      }
      const button = target?.closest?.('[data-action]');
      if (!button) return;
      const action = button.dataset.action;
      const taskId = String(button.dataset.taskId || '').trim();
      const row = rowById(taskId);
      const ui = ensureUiState();
      if (action === 'task-rail-scope') return openScopeMenu(button);
      if (action === 'task-rail-add') return addTask();
      if (action === 'task-rail-send-list') return sendListToChat();
      if (action === 'task-rail-undo-delete') return undoDelete();
      if (action === 'task-rail-start' && row) return openOrStartSession(row);
      if (action === 'task-rail-open-session' && row?.linkedSessionId) return activateWorkspaceSession(row.linkedSessionId);
      if (action === 'task-rail-overflow') return showOverflow(button, row);
      // A keyboard toggle (click detail 0) keeps focus on the re-rendered control; the checklist fold is per chat.
      if (action === 'task-rail-toggle') { ui.expandedTaskId = ui.expandedTaskId === taskId ? '' : taskId; rerender(); return event.detail === 0 ? findInPanel('[data-action="task-rail-toggle"]', 'data-task-id', taskId)?.focus?.() : undefined; }
      if (action === 'task-rail-edit' && row) { ui.editTaskId = taskId; return rerender(); }
      if (action === 'task-rail-edit-save') return saveEditor(taskId);
      if (action === 'task-rail-edit-cancel') { ui.editTaskId = ''; return rerender(); }
    }

    function setFilter(value) {
      ensureUiState().filter = ['open', 'done', 'all'].includes(value) ? value : 'all';
      rerender();
    }

    function handlePanelChange(event) {
      if (disposed || !isTasksMode()) return;
      const draft = event.target?.closest?.('[data-task-draft-title]');
      if (draft) ensureUiState().draftTitle = String(draft.value || '');
      const checkboxEl = event.target?.closest?.('[data-inv-checkbox][data-follow-up-id]');
      if (!checkboxEl) return;
      const id = String(checkboxEl.dataset.followUpId || '').trim();
      const method = checkboxEl.checked ? companionApi.resolveFollowUp : companionApi.activateFollowUp;
      if (id && typeof method === 'function') void runMutation(id, () => method.call(companionApi, id));
    }

    function handleSegmentedChange(event) {
      if (disposed || !isTasksMode()) return;
      const { id, value } = event.detail || {};
      if (id === 'task-rail-filter') setFilter(value);
      else if (id === 'project-tab-side' && value === 'notes') void switchToNotes();
    }

    function handlePanelKeydown(event) {
      if (disposed || !isTasksMode() || event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      if (!event.target?.closest?.('[data-task-draft-title]')) return;
      event.preventDefault();
      addTask();
    }

    function handleProjectsChanged() {
      if (disposed || !isEnabled()) return;
      reconcileScope();
      refreshChecklist();
    }

    function handleToggleClick() {
      if (isTasksMode() && isRailVisible()) {
        toggleArtifactReview();
        syncToggle();
        return;
      }
      open();
    }

    function createToggle() {
      if (toggleEl || !utilityCluster || typeof inventory.actionButton !== 'function') return toggleEl;
      toggleEl = windowRef.document.getElementById('chatTimelineTasksToggle');
      if (toggleEl) return toggleEl;
      const mount = windowRef.document.createElement('div');
      mount.innerHTML = inventory.actionButton({
        id: 'chatTimelineTasksToggle', domId: 'chatTimelineTasksToggle', plain: true,
        className: 'chat-timeline-utility-button chat-timeline-tasks-toggle',
        ariaLabel: jt('artifactPanelV2Render.tasks', 'Tasks'), title: jt('artifactPanelV2Render.tasks', 'Tasks'), ariaPressed: false,
        trustedHtml: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.25 4h7M6.25 8h7M6.25 12h7"/><path d="m2.5 4 .75.75L4.75 3.25M2.5 8l.75.75L4.75 7.25M2.5 12l.75.75 1.5-1.5"/></svg>',
      });
      toggleEl = mount.firstElementChild;
      const splitToggle = utilityCluster.querySelector?.('#artifactSplitViewToggle');
      utilityCluster.insertBefore(toggleEl, splitToggle?.nextSibling || utilityCluster.firstChild);
      toggleEl.hidden = splitToggle?.hidden !== false;
      return toggleEl;
    }

    function bind() {
      if (disposed || !isEnabled()) return;
      ensureUiState();
      createToggle();
      if (panelEl?.addEventListener && panelEl.dataset.taskRailBound !== listenerToken) {
        if (!panelEl.dataset.taskRailBound) {
          panelEl.dataset.taskRailBound = listenerToken;
          panelEl.addEventListener('click', handlePanelClick);
          panelEl.addEventListener('change', handlePanelChange);
          panelEl.addEventListener('inv-segmented-change', handleSegmentedChange);
          panelEl.addEventListener('keydown', handlePanelKeydown);
          panelListenersBound = true;
        }
      }
      if (toggleEl && !toggleBound) {
        toggleEl.addEventListener('click', handleToggleClick);
        toggleBound = true;
      }
      if (!projectsListenerBound && typeof windowRef.addEventListener === 'function') {
        windowRef.addEventListener(PROJECTS_CHANGED_EVENT, handleProjectsChanged);
        projectsListenerBound = true;
      }
      windowRef.rendererTaskBoard = boardActions;
      windowRef.rendererTaskRailActions = railActions;
      syncSignals();
      if (!initialRefreshStarted) {
        initialRefreshStarted = true;
        void notifyMutation();
      }
    }

    function dispose() {
      if (disposed) return;
      void commitPendingDelete();
      disposed = true;
      if (flashTimer) windowRef.clearTimeout(flashTimer);
      inventory.contextMenu?.hide?.({ restoreFocus: false });
      if (panelListenersBound) {
        panelEl.removeEventListener('click', handlePanelClick);
        panelEl.removeEventListener('change', handlePanelChange);
        panelEl.removeEventListener('inv-segmented-change', handleSegmentedChange);
        panelEl.removeEventListener('keydown', handlePanelKeydown);
        if (panelEl.dataset.taskRailBound === listenerToken) delete panelEl.dataset.taskRailBound;
      }
      if (toggleBound) toggleEl?.removeEventListener?.('click', handleToggleClick);
      if (projectsListenerBound) windowRef.removeEventListener?.(PROJECTS_CHANGED_EVENT, handleProjectsChanged);
      if (windowRef.rendererTaskBoard === boardActions) delete windowRef.rendererTaskBoard;
      if (windowRef.rendererTaskRailActions === railActions) delete windowRef.rendererTaskRailActions;
    }

    const boardActions = { notifyMutation };
    const railActions = { open, refreshChecklist, openTaskCount };
    return {
      bind, dispose, renderRailContent, notifyMutation, open, refreshChecklist, isEnabled, openTaskCount, currentChecklist,
      settlePendingDelete: commitPendingDelete,
    };
  }

  // The side the owner last chose for a project ('tasks', 'notes' or ''): the tab strip reopens on it.
  const preferredSide = (projectId, storage) => (typeof render.preferredSide === 'function' ? render.preferredSide(projectId, storage) : '');

  return { createTaskRail, preferredSide };
});
