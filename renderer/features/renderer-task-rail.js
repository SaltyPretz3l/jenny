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
    const inventory = d.inventory || windowRef.inventory || globalRef.inventory || {};
    const companionApi = windowRef?.jennyShell?.companion || {};
    const listenerToken = `task-rail-${Math.random().toString(36).slice(2)}`;
    let toggleEl = null;
    let panelListenersBound = false;
    let toggleBound = false;
    let disposed = false;
    let flashTimer = null;
    let initialRefreshStarted = false;
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
        state.ui.taskRail = { filter: 'open', draftTitle: '', busyTaskId: '', editTaskId: '', lastError: '', scope: 'current' };
      }
      const ui = state.ui.taskRail;
      if (!['open', 'done', 'all'].includes(ui.filter)) ui.filter = 'open';
      // 'current' follows the active chat's project; 'all'; or a project id.
      ui.scope = typeof ui.scope === 'string' && ui.scope.trim() ? ui.scope.trim() : 'current';
      ui.draftTitle = String(ui.draftTitle || '');
      ui.busyTaskId = String(ui.busyTaskId || '');
      ui.editTaskId = String(ui.editTaskId || '');
      ui.lastError = String(ui.lastError || '');
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

    function projectNameMap(chatId) {
      const names = new Map();
      for (const entry of projectSwitcher?.filterRows?.('') || []) {
        if (entry.id) names.set(entry.id, entry.label);
      }
      const loaded = Boolean(projectSwitcher?.getProjects?.().length);
      const sessions = Array.isArray(state.sessions) ? state.sessions : [];
      const seen = [chatId, ensureUiState().scope, ...sessions.map((entry) => String(entry?.project_id || '').trim()),
        ...buildRows().map((row) => row.projectId)];
      for (const id of seen.filter((value) => value && value !== 'current' && value !== 'all' && !names.has(value))) {
        names.set(id, id === GENERAL_PROJECT_ID ? jt('projects.switcher.generalName', 'General')
          : loaded ? jt('projects.filter.project', 'Project') : id);
      }
      return names;
    }

    function scopeHelper() {
      if (!projectSwitcher && !switcherRequested) { switcherRequested = true; void requestProjectSwitcher(); }
      reconcileScope();
      const scope = ensureUiState().scope;
      const chatId = chatProjectId();
      const names = projectNameMap(chatId);
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

    function scopeMenuRows(switcher, helper) {
      const open = buildRows().filter(isOpenRow);
      const countFor = (id) => open.filter((row) => row.projectId === id).length;
      const selectedId = helper.mode === 'all' ? null : helper.projectId;
      const chatId = helper.chatProjectId;
      const rows = chatId ? [{
        id: chatId, label: helper.projectNames.get(chatId) || chatId, kind: 'project',
        detail: jt('tasks.rail.thisChat', 'this chat'), count: countFor(chatId), selected: selectedId === chatId,
      }] : [];
      rows.push({ id: '', label: jt('projects.filter.all', 'All projects'), kind: 'project', count: open.length, selected: helper.mode === 'all' });
      for (const entry of switcher.filterRows('')) {
        if (!entry.id || entry.id === chatId) continue;
        rows.push({ ...entry, count: countFor(entry.id), selected: selectedId === entry.id });
      }
      return rows;
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
        rows: scopeMenuRows(switcher, helper),
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

    function syncCount() {
      // The badge follows the active chat's project, whatever scope the rail shows.
      const chatId = chatProjectId();
      const followUpCount = chatId
        ? buildRows().filter((row) => isOpenRow(row) && row.projectId === chatId).length : 0;
      const checklistCount = currentChecklist().items
        .filter((item) => item.status !== 'completed').length;
      const count = followUpCount + checklistCount;
      const badgeEl = toggleEl?.querySelector?.('[data-task-count]');
      if (badgeEl) {
        badgeEl.textContent = String(count);
        badgeEl.dataset.taskCount = String(count);
        badgeEl.hidden = count === 0;
      }
      // The badge is visual only: the name and tooltip carry the count too.
      if (toggleEl) {
        const name = count > 0 ? jt('tasks.rail.toggleNameOpen', 'Tasks, {count} open', { count }) : jt('artifactPanelV2Render.tasks', 'Tasks');
        toggleEl.setAttribute('aria-label', name);
        toggleEl.setAttribute('title', name);
      }
      syncToggle();
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

    function prepareSurface(surface) {
      if (!surface) return null;
      surface.detailEmpty?.classList?.add('hidden');
      surface.detailPanel?.classList?.remove('hidden');
      surface.metaPane?.classList?.add('hidden');
      for (const button of [surface.saveButton, surface.revertButton, surface.revealButton,
        surface.openExternalButton, surface.deleteButton]) button?.classList?.add('hidden');
      surface.editorShell?.classList?.add('hidden');
      surface.dirtyBadge?.classList?.add('hidden');
      for (const field of [surface.detailKicker, surface.detailTitle, surface.detailPath,
        surface.detailStatus, surface.detailNote]) if (field) field.textContent = '';
      if (surface.detailMeta) surface.detailMeta.innerHTML = '';
      if (surface.provenanceTimeline) surface.provenanceTimeline.innerHTML = '';
      const host = surface.previewContent || surface;
      host?.classList?.remove?.('hidden');
      return host;
    }

    function renderRailContent(surface) {
      const host = prepareSurface(surface);
      if (!host) return;
      host.innerHTML = typeof render.renderTaskRailSurface === 'function'
        ? render.renderTaskRailSurface(buildRows(), ensureUiState(), {
            escapeHtml,
            checklist: currentChecklist(),
            scope: scopeHelper(),
          }) : '';
      syncCount();
    }

    function rerender() {
      renderArtifactReviewPanel();
      syncToggle();
    }

    function refreshChecklist(options) {
      if (disposed) return;
      const sessionId = String(options?.sessionId || '').trim();
      if (sessionId && sessionId !== String(state.currentSessionId || '').trim()) return;
      // A re-render replaces the rail's markup wholesale; never throw away a
      // follow-up the user is editing or a draft they are typing. The count
      // still syncs, and the next ordinary render picks the checklist up.
      const activeEl = panelEl?.ownerDocument?.activeElement;
      const typing = Boolean(ensureUiState().editTaskId)
        || Boolean(activeEl && panelEl?.contains?.(activeEl)
          && activeEl.closest?.('.task-rail-add, .task-rail-editor'));
      if (!typing && isTasksMode() && isRailVisible()) {
        const currentSurface = panelEl?.querySelector?.('.task-rail-surface');
        if (currentSurface?.parentElement) renderRailContent(currentSurface.parentElement);
        else rerender();
      }
      syncCount();
    }

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
        syncCount();
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
      syncToggle();
      const id = String(taskId || '').trim();
      if (!id) return true;
      const row = Array.from(panelEl?.querySelectorAll?.('[data-task-id]') || [])
        .find((entry) => entry.getAttribute('data-task-id') === id);
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
        syncCount();
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
      const editor = Array.from(panelEl?.querySelectorAll?.('[data-task-editor]') || [])
        .find((entry) => entry.getAttribute('data-task-editor') === taskId);
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
        action: () => runMutation(row.followUpId, () => companionApi.deleteFollowUp(row.followUpId)),
      });
      contextMenu.show({ anchorEl: anchor, rootEl: panelEl, restoreFocusTo: anchor, items });
    }

    async function handlePanelClick(event) {
      if (disposed || !isTasksMode()) return;
      const target = event.target;
      const filterGroup = target?.closest?.('[data-action="task-rail-filter"]');
      if (filterGroup) {
        const option = target.closest?.('[data-value]');
        if (option) {
          ensureUiState().filter = ['open', 'done', 'all'].includes(option.dataset.value) ? option.dataset.value : 'open';
          rerender();
        }
        return;
      }
      const button = target?.closest?.('[data-action]');
      if (!button) return;
      const action = button.dataset.action;
      const taskId = String(button.dataset.taskId || '').trim();
      const row = rowById(taskId);
      if (action === 'task-rail-scope') return openScopeMenu(button);
      if (action === 'task-rail-add') return addTask();
      if (action === 'task-rail-send-list') return sendListToChat();
      if (action === 'task-rail-start' && row) return openOrStartSession(row);
      if (action === 'task-rail-open-session' && row?.linkedSessionId) return activateWorkspaceSession(row.linkedSessionId);
      if (action === 'task-rail-overflow') return showOverflow(button, row);
      if (action === 'task-rail-edit-save') return saveEditor(taskId);
      if (action === 'task-rail-edit-cancel') { ensureUiState().editTaskId = ''; return rerender(); }
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
      if (disposed || !isTasksMode() || event.detail?.id !== 'task-rail-filter') return;
      ensureUiState().filter = ['open', 'done', 'all'].includes(event.detail.value) ? event.detail.value : 'open';
      rerender();
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
        trustedHtml: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.25 4h7M6.25 8h7M6.25 12h7"/><path d="m2.5 4 .75.75L4.75 3.25M2.5 8l.75.75L4.75 7.25M2.5 12l.75.75 1.5-1.5"/></svg><span class="chat-timeline-utility-count" data-task-count="0" hidden>0</span>',
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
      syncCount();
      if (!initialRefreshStarted) {
        initialRefreshStarted = true;
        void notifyMutation();
      }
    }

    function dispose() {
      if (disposed) return;
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
    const railActions = { open, refreshChecklist };
    return { bind, dispose, renderRailContent, notifyMutation, open, refreshChecklist, isEnabled };
  }

  return { createTaskRail };
});
