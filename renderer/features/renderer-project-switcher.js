/* renderer/features/renderer-project-switcher.js
 *
 * Project switcher glue (Projects v2, 2026-09-20). Owns the renderer's cached
 * project list (one projects.list read per 15 s, invalidated by the
 * `jenny:projects-changed` window event that Settings > Projects and this
 * module raise) and the three actions the shared project menu offers:
 *
 *   switch   run the Workspace-folder transition to a project's folder via
 *            workspaceRootService.switchToProject(projectId) - the renderer
 *            sends a project id, never a path ("the Workspace folder is the
 *            project", owner rule 2026-09-17);
 *   new      the existing folder dialog (workspaceRootService.choose) - the
 *            provisioner names the project after the folder, one step;
 *   clear    "No folder (General)" = workspaceRootService.clear.
 *
 * The composer variant moves ONE chat (projects.assignSession, idle-only) and
 * never switches the Workspace. Lazily loaded together with
 * renderer-project-menu.js; created once by the shell's IDE root service and
 * reached through workspaceRootService.getProjectSwitcher().
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.rendererProjectSwitcher = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  const PROJECTS_TTL_MS = 15000;
  const CHANGED_EVENT = 'jenny:projects-changed';

  function resolveMenuUtils() {
    return (root && root.rendererProjectMenu)
      || (typeof require === 'function' ? require('./renderer-project-menu') : null)
      || null;
  }

  function noop() {}

  function createProjectSwitcher(deps) {
    const d = deps || {};
    const state = d.state || {};
    const windowRef = d.windowRef || (typeof globalThis !== 'undefined' ? globalThis : {});
    const documentRef = d.documentRef || windowRef.document || null;
    const menuUtils = d.menuUtils || resolveMenuUtils();
    const { GENERAL_PROJECT_ID, folderKey, countChatsByProject, normalizeProjectList, sortProjectsForMenu, projectRow } = menuUtils;
    const getProjectsApi = typeof d.getProjectsApi === 'function'
      ? d.getProjectsApi
      : () => (windowRef && windowRef.jennyShell ? windowRef.jennyShell.projects : null);
    const workspaceRootService = d.workspaceRootService || null;
    const openSettingsSection = typeof d.openSettingsSection === 'function' ? d.openSettingsSection : noop;
    const showToast = typeof d.showToast === 'function' ? d.showToast : noop;
    const showError = typeof d.showError === 'function' ? d.showError : noop;
    const appendClientLog = typeof d.appendClientLog === 'function' ? d.appendClientLog : noop;
    const refreshSessions = typeof d.refreshSessions === 'function' ? d.refreshSessions : noop;
    const openSession = typeof d.openSession === 'function' ? d.openSession : null;
    const newChat = typeof d.newChat === 'function' ? d.newChat : null;
    const now = typeof d.now === 'function' ? d.now : () => Date.now();
    const menu = d.menu || menuUtils.createProjectMenu({ windowRef, documentRef, actionButton: d.actionButton });

    let projects = [];
    let fetchedAt = 0;
    // Generation gates (renderer/shared/async-fence.js contract, inlined so
    // this lazy module stays dependency-free): a forced re-read supersedes an
    // in-flight list request; a later transition supersedes an earlier one's
    // post-commit continuation.
    let listGen = 0;
    let transitionSeq = 0;
    let inFlight = null;
    let disposed = false;

    function workspaceRootPath() {
      return String(state.workspaceRoot && state.workspaceRoot.path || '').trim();
    }

    function getProjects() {
      return projects.slice();
    }

    function projectById(id) {
      return projects.find((project) => project.id === id) || null;
    }

    function currentProject() {
      const key = folderKey(workspaceRootPath());
      if (!key) return null;
      return projects.find((project) => project.rootPath && folderKey(project.rootPath) === key) || null;
    }

    function title() {
      const current = currentProject();
      return current ? current.name : jt('projects.switcher.workspace', 'Workspace');
    }

    function isFresh() {
      return fetchedAt > 0 && (now() - fetchedAt) < PROJECTS_TTL_MS;
    }

    function notifyChanged() {
      if (windowRef && typeof windowRef.dispatchEvent === 'function' && typeof windowRef.CustomEvent === 'function') {
        try { windowRef.dispatchEvent(new windowRef.CustomEvent(CHANGED_EVENT, { detail: { source: 'switcher' } })); } catch (_error) { /* best-effort */ }
      }
    }

    function refresh(options) {
      const o = options || {};
      if (disposed) return Promise.resolve(projects);
      if (!o.force && isFresh()) return Promise.resolve(projects);
      if (inFlight && !o.force) return inFlight;
      const api = getProjectsApi();
      if (!api || typeof api.list !== 'function') return Promise.resolve(projects);
      let pending;
      try { pending = Promise.resolve(api.list()); } catch (error) { pending = Promise.reject(error); }
      const gen = ++listGen;
      const request = pending.then((payload) => {
        if (disposed) return projects;
        // Superseded by a forced re-read (rename/delete landed meanwhile):
        // hand callers the newer request instead of stamping stale data fresh.
        if (gen !== listGen) return inFlight || projects;
        inFlight = null;
        projects = normalizeProjectList(payload);
        fetchedAt = now();
        return projects;
      }).catch((error) => {
        if (gen === listGen) inFlight = null;
        appendClientLog('WARN', 'project_switcher.list_failed', { message: error && error.message ? error.message : String(error) });
        return projects;
      });
      inFlight = request;
      return request;
    }

    function handleProjectsChanged(event) {
      if (event && event.detail && event.detail.source === 'switcher') return;
      fetchedAt = 0;
      refresh({ force: true }).then(() => notifyChanged());
    }

    // ---- Workspace switcher (Explorer header, welcome page) ----------------

    function switcherRows() {
      const current = currentProject();
      const counts = countChatsByProject(state.sessions);
      const rows = sortProjectsForMenu(projects, current && current.id).map((project) => {
        // A project without a folder cannot become the Workspace (the folder is
        // the project); it stays listed, disabled, so its chats are still findable.
        const folderless = !project.rootPath;
        const row = projectRow(project, {
          count: counts[project.id] || 0,
          selected: Boolean(current && current.id === project.id),
          disabled: folderless,
          title: folderless ? jt('projects.switcher.noFolderShort', 'no folder') : '',
        });
        if (folderless) row.detail = jt('projects.switcher.noFolderShort', 'no folder');
        return row;
      });
      rows.push({ id: '__new', kind: 'action', separatorBefore: true, label: jt('projects.switcher.newFromFolder', 'New project from folder…') });
      rows.push({
        id: '__clear', kind: 'action',
        label: jt('projects.switcher.noFolder', 'No folder (General)'),
        detail: jt('projects.switcher.noFolderDetail', 'closes the Workspace'),
        selected: !current && !workspaceRootPath(),
        disabled: !workspaceRootPath(),
      });
      rows.push({ id: '__manage', kind: 'action', label: jt('projects.switcher.manage', 'Manage projects…') });
      return rows;
    }

    // The project ids known BEFORE a transition starts: the "is it new?"
    // baseline for the post-commit announcement (F33). Read after the commit it
    // is too late: the commit's own UI work (Explorer header first paint, the
    // Chats panel's first request) can land a list read that already holds the
    // provisioned project. null when no list could be read (nothing announced).
    async function captureBaseline() {
      await refresh();
      if (disposed || fetchedAt <= 0) return null;
      return new Set(projects.map((project) => project.id));
    }

    // Post-commit sync for ANY committed transition. The facade calls this for
    // transitions other surfaces start; this module's own actions call it too.
    // options.baseline is captureBaseline()'s result from before the transition.
    async function afterTransition(outcome, options) {
      const o = options || {};
      if (!outcome || outcome.committed !== true) return outcome;
      const token = ++transitionSeq;
      const before = o.baseline !== undefined
        ? o.baseline
        : (fetchedAt > 0 ? new Set(projects.map((project) => project.id)) : null);
      // A switch by id changes no project row; only a folder pick or clear can
      // create or reveal one, so those force the list re-read.
      await refresh({ force: o.forceList !== false });
      if (disposed || token !== transitionSeq) return outcome;
      const current = currentProject();
      // The Chats panel filter follows the Workspace (window-scoped, not persisted).
      if (state.ui) state.ui.chatsProjectFilter = current ? current.id : '';
      await Promise.resolve(refreshSessions()).catch(noop);
      if (disposed || token !== transitionSeq) return outcome;
      if (o.announceNew && current && before instanceof Set && !before.has(current.id)) {
        showToast(jt('projects.switcher.created', 'New project "{name}" from {path}. New chats start here.', { name: current.name, path: current.rootPath }));
      }
      notifyChanged();
      await followWorkspaceChat(current ? current.id : GENERAL_PROJECT_ID);
      return outcome;
    }

    // The open chat follows the Workspace (owner decision 2026-09-20): after a
    // switch, a chat from another project is not left on screen. The most
    // recent chat of the new project opens; with none, a new chat starts there
    // (new chats default into the Workspace project).
    function sessionProjectId(session) {
      return String(session && session.project_id || '').trim() || GENERAL_PROJECT_ID;
    }

    async function followWorkspaceChat(projectId) {
      const sessions = Array.isArray(state.sessions) ? state.sessions : [];
      const currentId = String(state.currentSessionId || '').trim();
      const open = sessions.find((session) => String(session && session.id || '') === currentId) || null;
      if (open && sessionProjectId(open) === projectId) return;
      const candidate = sessions
        .filter((session) => session && !session.archived_at && session.session_type !== 'plugin' && sessionProjectId(session) === projectId)
        .sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')))[0];
      try {
        if (candidate && openSession) await openSession(String(candidate.id));
        else if (newChat) await newChat();
      } catch (error) {
        appendClientLog('WARN', 'projects.follow_chat_failed', { projectId, message: error && error.message ? error.message : String(error) });
      }
    }

    async function switchToProject(projectId) {
      const id = String(projectId || '').trim();
      if (!id || typeof workspaceRootService?.switchToProject !== 'function') return null;
      if (id === GENERAL_PROJECT_ID) return clearWorkspace();
      const current = currentProject();
      if (current && current.id === id) return { committed: false, changed: false, noop: true };
      const outcome = await workspaceRootService.switchToProject(id, { viaSwitcher: true });
      return afterTransition(outcome, { forceList: false });
    }

    async function newProjectFromFolder() {
      if (typeof workspaceRootService?.choose !== 'function') return null;
      const baseline = await captureBaseline();
      const outcome = await workspaceRootService.choose({ viaSwitcher: true });
      return afterTransition(outcome, { announceNew: true, baseline });
    }

    async function clearWorkspace() {
      if (typeof workspaceRootService?.clear !== 'function') return null;
      const outcome = await workspaceRootService.clear({ viaSwitcher: true });
      return afterTransition(outcome);
    }

    function handleSwitcherPick(row) {
      let pending;
      if (row.id === '__new') pending = newProjectFromFolder();
      else if (row.id === '__clear') pending = clearWorkspace();
      else if (row.id === '__manage') { openSettingsSection('runtime'); return; }
      else pending = switchToProject(row.id);
      Promise.resolve(pending).catch((error) => {
        appendClientLog('WARN', 'project_switcher.action_failed', { action: row.id, message: error && error.message ? error.message : String(error) });
      });
    }

    async function openSwitcher(anchor) {
      if (menu.isOpen()) { menu.close(); return null; }
      await refresh();
      if (disposed) return null;
      return menu.show({ anchor, rows: switcherRows(), onPick: handleSwitcherPick });
    }

    // ---- Composer: move this chat --------------------------------------------

    function moveRows(options) {
      const o = options || {};
      const chatProjectId = String(o.projectId || '').trim() || GENERAL_PROJECT_ID;
      const busyTitle = o.idle === false ? jt('workspace.rootNudge.waitIdle', 'Wait for this chat to finish first.') : '';
      const rows = sortProjectsForMenu(projects, chatProjectId).map((project) => ({
        ...projectRow(project, { selected: project.id === chatProjectId, disabled: o.idle === false || project.id === chatProjectId, title: busyTitle }),
        label: project.id === chatProjectId ? project.name : jt('projects.switcher.moveChatTo', 'Move this chat to {name}', { name: project.name }),
      }));
      const general = projectById(GENERAL_PROJECT_ID);
      const generalName = general ? general.name : jt('projects.switcher.generalName', 'General');
      rows.push({
        id: GENERAL_PROJECT_ID, kind: 'project', separatorBefore: true,
        label: chatProjectId === GENERAL_PROJECT_ID ? generalName : jt('projects.switcher.moveChatTo', 'Move this chat to {name}', { name: generalName }),
        detail: jt('projects.switcher.generalDetail', 'no folder · file tools off'),
        selected: chatProjectId === GENERAL_PROJECT_ID,
        disabled: o.idle === false || chatProjectId === GENERAL_PROJECT_ID,
        title: busyTitle,
      });
      return rows;
    }

    async function moveChat(sessionId, projectId) {
      const api = getProjectsApi();
      if (!api || typeof api.assignSession !== 'function') return null;
      let result;
      try {
        result = await api.assignSession({ session_id: sessionId, project_id: projectId });
      } catch (error) {
        result = { ok: false, error: { message: error && error.message ? error.message : String(error) } };
      }
      if (disposed) return result;
      if (!result || result.ok === false) {
        const message = String(result && result.error && (result.error.message || result.error.reason) || 'assign_failed');
        showError(jt('projects.switcher.moveFailed', 'Could not move this chat: {message}', { message }));
        return result;
      }
      const sessions = Array.isArray(state.sessions) ? state.sessions : [];
      sessions.forEach((session) => {
        if (session && String(session.id || '') === sessionId) session.project_id = projectId;
      });
      Promise.resolve(refreshSessions()).catch(noop);
      notifyChanged();
      return result;
    }

    async function openMoveChatMenu(options) {
      const o = options || {};
      const sessionId = String(o.sessionId || '').trim();
      if (!sessionId) return null;
      if (menu.isOpen()) { menu.close(); return null; }
      await refresh();
      if (disposed) return null;
      return menu.show({
        anchor: o.anchor,
        ariaLabel: jt('projects.switcher.moveAriaLabel', 'Move this chat'),
        rows: moveRows(o),
        onPick: (row) => {
          Promise.resolve(moveChat(sessionId, row.id))
            .then((result) => { if (typeof o.onMoved === 'function' && result && result.ok !== false) o.onMoved(result); })
            .catch(noop);
        },
      });
    }

    // ---- Chats panel filter ----------------------------------------------------

    function filterRows(selectedId) {
      const counts = countChatsByProject(state.sessions);
      const total = Object.keys(counts).reduce((sum, key) => sum + counts[key], 0);
      const rows = [{ id: '', kind: 'project', label: jt('projects.filter.all', 'All projects'), count: total, selected: !selectedId }];
      const current = currentProject();
      sortProjectsForMenu(projects, current && current.id).forEach((project) => {
        rows.push(projectRow(project, { count: counts[project.id] || 0, selected: selectedId === project.id }));
      });
      const general = projectById(GENERAL_PROJECT_ID);
      rows.push({
        id: GENERAL_PROJECT_ID, kind: 'project', separatorBefore: true,
        label: general ? general.name : jt('projects.switcher.generalName', 'General'),
        detail: jt('projects.switcher.noFolderShort', 'no folder'),
        count: counts[GENERAL_PROJECT_ID] || 0,
        selected: selectedId === GENERAL_PROJECT_ID,
      });
      return rows;
    }

    async function openFilterMenu(options) {
      const o = options || {};
      if (menu.isOpen()) { menu.close(); return null; }
      await refresh();
      if (disposed) return null;
      return menu.show({
        anchor: o.anchor,
        rows: filterRows(String(o.selectedId || '')),
        onPick: (row) => { if (typeof o.onPick === 'function') o.onPick(row.id); },
      });
    }

    function bind() {
      if (windowRef && typeof windowRef.addEventListener === 'function') {
        windowRef.addEventListener(CHANGED_EVENT, handleProjectsChanged);
      }
    }

    function dispose() {
      disposed = true;
      if (windowRef && typeof windowRef.removeEventListener === 'function') {
        windowRef.removeEventListener(CHANGED_EVENT, handleProjectsChanged);
      }
      menu.dispose();
    }

    return {
      bind, dispose, refresh, getProjects, currentProject, projectById, title,
      switcherRows, openSwitcher, switchToProject, newProjectFromFolder, clearWorkspace, captureBaseline, afterTransition,
      moveRows, openMoveChatMenu, moveChat,
      filterRows, openFilterMenu,
      menu,
    };
  }

  return { CHANGED_EVENT, PROJECTS_TTL_MS, createProjectSwitcher };
});
