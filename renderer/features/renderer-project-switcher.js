/* renderer/features/renderer-project-switcher.js
 *
 * Project switcher glue (Projects v2, 2026-09-20; intents 2026-09-27). Owns
 * the renderer's ONE project cache (one projects.list read per 15 s; every
 * other surface reads getProjects() or subscribes with onProjectsChanged, and
 * the `jenny:projects-changed` window event carries the list after every
 * refresh that changed it) and the three things the shared project menu is
 * used for, each named by the menu heading:
 *
 *   Open project     (Explorer header, welcome page) run the Workspace-folder
 *                    transition by PROJECT ID via
 *                    workspaceRootService.switchToProject - the renderer never
 *                    sends a path ("the Workspace folder is the project", owner
 *                    rule 2026-09-17). Fork 2 A: the open chat stays; a toast
 *                    offers the latest chat. A missing folder offers Locate
 *                    (projects.chooseRoot rebinds the same project). New = the
 *                    existing folder dialog (workspaceRootService.choose);
 *                    "No folder (General)" = workspaceRootService.clear.
 *   Move this chat to (composer pill, chat row menu, Chats bulk bar) the one
 *                    move engine: idle chats only (projects.assignSession),
 *                    busy ones skipped, one refresh, a toast with Undo. It never
 *                    switches the Workspace.
 *   Show chats from  (Chats panel filter) All projects plus per-project counts.
 *
 * Lazily loaded together with renderer-project-menu.js; created once by the
 * shell's IDE root service and reached through
 * workspaceRootService.getProjectSwitcher() / peekProjectSwitcher().
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
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };

  const PROJECTS_TTL_MS = 15000;
  const CHANGED_EVENT = 'jenny:projects-changed';
  // Backend refusal reasons that mean "this chat is working right now".
  const BUSY_REASONS = new Set(['session_busy', 'project_sessions_busy', 'sessionBusy', 'projectSessionsBusy']);

  function resolveMenuUtils() {
    return (root && root.rendererProjectMenu)
      || (typeof require === 'function' ? require('./renderer-project-menu') : null)
      || null;
  }

  function noop() {}

  function errorText(error) {
    return error && error.message ? error.message : String(error);
  }

  function uniqueIds(ids) {
    const seen = new Set();
    (Array.isArray(ids) ? ids : [ids]).forEach((id) => {
      const value = String(id || '').trim();
      if (value) seen.add(value);
    });
    return Array.from(seen);
  }

  function createProjectSwitcher(deps) {
    const d = deps || {};
    const state = d.state || {};
    const windowRef = d.windowRef || (typeof globalThis !== 'undefined' ? globalThis : {});
    const documentRef = d.documentRef || windowRef.document || null;
    const menuUtils = d.menuUtils || resolveMenuUtils();
    const {
      GENERAL_PROJECT_ID, folderKey, countChatsByProject, normalizeProjectList, sortProjectsForMenu, orderProjects,
      displayNames, generalName, sessionProjectId, projectRow,
    } = menuUtils;
    const getProjectsApi = typeof d.getProjectsApi === 'function'
      ? d.getProjectsApi
      : () => (windowRef && windowRef.jennyShell ? windowRef.jennyShell.projects : null);
    const workspaceRootService = d.workspaceRootService || null;
    const openSettingsSection = typeof d.openSettingsSection === 'function' ? d.openSettingsSection : noop;
    // showToast(message, { tone?, dedupeKey?, actions?: [{ id, label, kind, onClick }] })
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
    let listSignature = '';
    // The Workspace folder the last list's is_current flags were computed
    // against (null when it changed mid-request: fall back to the path compare).
    let fetchedForRoot = null;
    // Generation gates (renderer/shared/async-fence.js contract, inlined so
    // this lazy module stays dependency-free): a forced re-read supersedes an
    // in-flight list request; a later transition supersedes an earlier one's
    // post-commit continuation.
    let listGen = 0;
    let transitionSeq = 0;
    let inFlight = null;
    let disposed = false;
    // D8: once the user picks a Chats filter this session ("All projects"
    // included), Workspace switches stop overwriting it.
    let filterPickedByUser = false;
    const listeners = new Set();

    function workspaceRootPath() {
      return String(state.workspaceRoot && state.workspaceRoot.path || '').trim();
    }

    function sessionsList() {
      return Array.isArray(state.sessions) ? state.sessions : [];
    }

    function findSession(id) {
      return sessionsList().find((session) => String(session && session.id || '') === id) || null;
    }

    // One order everywhere (D18): current first, most recently used, General last.
    function getProjects() {
      const current = currentProject();
      return orderProjects(projects, { currentId: current && current.id, sessions: state.sessions });
    }

    function projectById(id) {
      return projects.find((project) => project.id === id) || null;
    }

    // D5: main's is_current (realpath-aware) wins while the list was read for
    // the Workspace folder that is open now; otherwise the normalized-path
    // compare (older backend, or the folder changed since the read).
    function currentProject() {
      const rootPath = workspaceRootPath();
      if (!rootPath) return null;
      const key = folderKey(rootPath);
      const flagged = projects.some((project) => project.isCurrent !== null);
      if (flagged && fetchedForRoot !== null && folderKey(fetchedForRoot) === key) {
        return projects.find((project) => project.isCurrent === true) || null;
      }
      return projects.find((project) => project.rootPath && folderKey(project.rootPath) === key) || null;
    }

    function labelFor(projectId) {
      const project = projectById(projectId);
      if (!project) return projectId === GENERAL_PROJECT_ID ? generalName() : projectId;
      return displayNames(projects)[projectId] || project.name;
    }

    function title() {
      const current = currentProject();
      return current ? current.name : jt('projects.switcher.workspace', 'Workspace');
    }

    function isFresh() {
      return fetchedAt > 0 && (now() - fetchedAt) < PROJECTS_TTL_MS;
    }

    function signatureOf(list) {
      return list.map((project) => [project.id, project.name, project.rootPath, project.folderExists, project.folderMissing, project.isCurrent, project.rootRevision].join('\u001f')).join('\u001e');
    }

    // Subscribers and the window event hear the one list (source 'switcher'
    // so this module's own listener does not echo).
    let emitCount = 0;
    function emitChanged(reason) {
      emitCount += 1;
      const snapshot = getProjects();
      listeners.forEach((listener) => {
        try { listener(snapshot, { reason }); } catch (error) { appendClientLog('WARN', 'project_switcher.listener_failed', { message: errorText(error) }); }
      });
      if (windowRef && typeof windowRef.dispatchEvent === 'function' && typeof windowRef.CustomEvent === 'function') {
        try { windowRef.dispatchEvent(new windowRef.CustomEvent(CHANGED_EVENT, { detail: { source: 'switcher', reason, projects: snapshot } })); } catch (_error) { /* best-effort */ }
      }
    }

    function onProjectsChanged(listener) {
      if (typeof listener !== 'function') return noop;
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }

    function refresh(options) {
      const o = options || {};
      if (disposed) return Promise.resolve(projects);
      if (!o.force && isFresh()) return Promise.resolve(projects);
      if (inFlight && !o.force) return inFlight;
      const api = getProjectsApi();
      if (!api || typeof api.list !== 'function') return Promise.resolve(projects);
      const rootAtRequest = workspaceRootPath();
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
        fetchedForRoot = rootAtRequest === workspaceRootPath() ? rootAtRequest : null;
        const signature = signatureOf(projects);
        if (signature !== listSignature) {
          listSignature = signature;
          emitChanged('list');
        }
        return projects;
      }).catch((error) => {
        if (gen === listGen) inFlight = null;
        appendClientLog('WARN', 'project_switcher.list_failed', { message: errorText(error) });
        return projects;
      });
      inFlight = request;
      return request;
    }

    function refreshProjects(options) {
      return refresh(options).then(() => getProjects());
    }

    function handleProjectsChanged(event) {
      if (event && event.detail && event.detail.source === 'switcher') return;
      fetchedAt = 0;
      refresh({ force: true });
    }

    // ---- Chats filter rules (D7, D8) --------------------------------------------

    function activeFilter() {
      return String(state.ui && state.ui.chatsProjectFilter || '').trim();
    }

    // An explicit filter pick (the "Show chats from" menu, Settings "Show
    // chats"): '' = All projects.
    function setChatsFilter(projectId) {
      if (!state.ui) state.ui = {};
      filterPickedByUser = true;
      state.ui.chatsProjectFilter = String(projectId || '').trim();
    }

    // D7: a chat created in projectId must not vanish behind the filter.
    function ensureFilterShows(projectId) {
      const id = String(projectId || '').trim() || GENERAL_PROJECT_ID;
      const active = activeFilter();
      if (!state.ui || !active || active === id) return false;
      state.ui.chatsProjectFilter = id;
      return true;
    }

    // ---- Open project (Explorer header, welcome page) ---------------------------

    function switcherRows() {
      const current = currentProject();
      const counts = countChatsByProject(state.sessions);
      const labels = displayNames(projects);
      const noFolder = jt('projects.switcher.noFolderShort', 'no folder');
      const rows = sortProjectsForMenu(projects, current && current.id, state.sessions).map((project) => {
        // A project without a folder cannot become the Workspace (the folder is
        // the project); it stays listed, disabled, so its chats are still findable.
        const folderless = !project.rootPath;
        const isCurrent = Boolean(current && current.id === project.id);
        const row = projectRow(project, {
          label: labels[project.id],
          count: counts[project.id] || 0,
          selected: isCurrent,
          disabled: folderless,
          reason: folderless ? noFolder : '',
        });
        if (folderless) row.detail = noFolder;
        else if (project.folderMissing && !isCurrent) {
          // A missing folder cannot open; activating the row locates it.
          row.detail = jt('projects.menu.locate', 'Locate…');
          row.danger = true;
          row.intent = 'locate';
        }
        return row;
      });
      // F9 (row 40): switch, No folder, Open folder…, Manage projects…; Settings › Projects
      // owns rename, delete, reveal and new chat.
      rows.push({
        id: '__clear', kind: 'action', radio: true, separatorBefore: true,
        label: jt('projects.switcher.noFolder', 'No folder (General)'),
        detail: jt('projects.switcher.noFolderDetail', 'closes the Workspace'),
        selected: !current && !workspaceRootPath(),
        disabled: !workspaceRootPath(),
      });
      rows.push({ id: '__new', kind: 'action', label: jt('projects.menu.openFolder', 'Open folder…') });
      rows.push({ id: '__manage', kind: 'action', label: jt('projects.menu.manageProjects', 'Manage projects…') });
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

    function latestChat(projectId) {
      return sessionsList()
        .filter((session) => session && !session.archived_at && session.session_type !== 'plugin' && sessionProjectId(session) === projectId)
        .sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')))[0] || null;
    }

    // What the switch toast offers: the open chat already belongs -> nothing;
    // the project has chats -> "Open latest chat"; none -> "New chat here".
    function chatActionFor(projectId) {
      const open = findSession(String(state.currentSessionId || '').trim());
      if (open && sessionProjectId(open) === projectId) return null;
      const run = (fn) => () => Promise.resolve(fn()).catch((error) => {
        appendClientLog('WARN', 'projects.switch_toast_action_failed', { projectId, message: errorText(error) });
      });
      if (latestChat(projectId)) {
        return openSession
          ? { id: 'open-latest-chat', label: jt('projects.switcher.openLatestChat', 'Open latest chat'), kind: 'primary', onClick: run(() => followWorkspaceChat(projectId)) }
          : null;
      }
      return newChat
        ? { id: 'new-chat-here', label: jt('projects.switcher.newChatHere', 'New chat here'), kind: 'primary', onClick: run(() => newChatInProject(projectId)) }
        : null;
    }

    function announceSwitch(project, isNew) {
      const action = chatActionFor(project.id);
      const message = isNew
        ? jt('projects.switcher.created', 'New project "{name}" from {path}. New chats start here.', { name: project.name, path: project.rootPath })
        : jt('projects.switcher.switched', 'Workspace is now {name}. New chats start here.', { name: labelFor(project.id) });
      showToast(message, { tone: 'info', dedupeKey: 'projects:switched', actions: action ? [action] : [] });
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
      const emitsBefore = emitCount;
      // Always re-read: even a switch by id flips main's is_current flags.
      await refresh({ force: true });
      if (disposed || token !== transitionSeq) return outcome;
      const current = currentProject();
      // The Chats filter follows the Workspace until the user picks one (D8).
      if (state.ui && !filterPickedByUser) state.ui.chatsProjectFilter = current ? current.id : '';
      await Promise.resolve(refreshSessions()).catch(noop);
      if (disposed || token !== transitionSeq) return outcome;
      const provisioning = outcome.project_provisioning
        || (outcome.backendResult && outcome.backendResult.project_provisioning)
        || null;
      if (provisioning && provisioning.ok === false) {
        // D4: the folder opened, but no project could be made for it.
        appendClientLog('WARN', 'projects.provisioning_failed', { reason: String(provisioning.reason || '').slice(0, 80) });
        showError(jt('projects.switcher.provisioningFailed', 'Jenny couldn\'t create a project for this folder. New chats go to General.'));
      } else if (current) {
        // Fork 2 A: the open chat stays; the toast says where new chats go.
        announceSwitch(current, Boolean(o.announceNew && before instanceof Set && !before.has(current.id)));
      }
      // Surfaces repaint for the new current project; once is enough when
      // the re-read already announced a changed list.
      if (emitCount === emitsBefore) emitChanged('transition');
      return outcome;
    }

    function referenceChatProjectId(options) {
      // Split view W3-4 (Explorer nudge): the project of the chat the Workspace
      // view talks to - pane 0's session while the IDE chat dock shows it
      // (options.docked), else the focused chat. '' when no such chat is listed.
      const paneUtils = d.paneVisibilityUtils || (root && root.rendererPaneVisibilityUtils) || null;
      const docked = Boolean(options && options.docked) && paneUtils && typeof paneUtils.resolvePaneSessionId === 'function';
      const sessionId = String((docked ? paneUtils.resolvePaneSessionId(state, 0) : state.currentSessionId) || '').trim();
      if (!sessionId) return '';
      const session = findSession(sessionId);
      return session ? sessionProjectId(session) : '';
    }

    // "Open latest chat": the newest live chat of the project opens; with none,
    // a new chat starts there. Never runs on its own (Fork 2 A).
    async function followWorkspaceChat(projectId) {
      const open = findSession(String(state.currentSessionId || '').trim());
      if (open && sessionProjectId(open) === projectId) return;
      const candidate = latestChat(projectId);
      try {
        if (candidate && openSession) await openSession(String(candidate.id));
        else await newChatInProject(projectId);
      } catch (error) {
        appendClientLog('WARN', 'projects.follow_chat_failed', { projectId, message: errorText(error) });
      }
    }

    function announceMissingFolder(project) {
      const id = project.id;
      showToast(jt('projects.switcher.folderMissingToast', 'The folder for "{name}" is missing. Locate it to open the project.', { name: labelFor(id) }), {
        tone: 'warning',
        dedupeKey: 'projects:folder-missing:' + id,
        actions: [{
          id: 'locate-folder', kind: 'primary',
          label: jt('projects.switcher.locateFolder', 'Locate folder'),
          onClick: () => locateProjectFolder(id, { openAfter: true }).catch(noop),
        }],
      });
    }

    async function openProjectAsWorkspace(projectId) {
      const id = String(projectId || '').trim();
      if (!id || typeof workspaceRootService?.switchToProject !== 'function') return null;
      if (id === GENERAL_PROJECT_ID) return clearWorkspace();
      const current = currentProject();
      if (current && current.id === id) return { committed: false, changed: false, noop: true };
      const project = projectById(id);
      if (project && project.folderMissing) {
        announceMissingFolder(project);
        return { committed: false, changed: false, blocked: true, code: 'workspace_folder_missing' };
      }
      const outcome = await workspaceRootService.switchToProject(id, { viaSwitcher: true });
      if (disposed) return outcome;
      if (outcome && outcome.committed !== true && outcome.code === 'workspace_folder_missing') {
        // The folder vanished after the list was read: main refused.
        announceMissingFolder(project || { id });
        refresh({ force: true });
        return outcome;
      }
      return afterTransition(outcome);
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

    // Locate / Change folder: main opens the folder picker and rebinds THIS
    // project (same id, same chats). options.openAfter opens it as the
    // Workspace once found (the "Open project" intent).
    async function locateProjectFolder(projectId, options) {
      const o = options || {};
      const id = String(projectId || '').trim();
      const api = getProjectsApi();
      if (!id || id === GENERAL_PROJECT_ID || !api || typeof api.chooseRoot !== 'function') return null;
      const project = projectById(id);
      const payload = { project_id: id };
      if (project && project.rootRevision !== null) payload.expected_root_revision = project.rootRevision;
      let result;
      try {
        result = await api.chooseRoot(payload);
      } catch (error) {
        result = { ok: false, error: { message: errorText(error) } };
      }
      if (disposed) return result;
      if (result && result.ok === true) {
        await refresh({ force: true });
        if (o.openAfter && !disposed) await openProjectAsWorkspace(id);
        return result;
      }
      const error = (result && result.error) || {};
      const reason = String((result && result.reason) || error.reason || error.code || '');
      if (reason === 'canceled' || reason === 'cancelled' || (result && result.canceled === true)) return result;
      if (reason === 'folder_already_project') {
        const name = String((result && result.conflict_project_name) || error.conflict_project_name || '');
        showError(jt('projects.locate.folderTaken', 'That folder is already the project "{name}".', { name }));
      } else if (reason === 'project_is_current') {
        showError(jt('projects.locate.projectIsCurrent', 'Close the Workspace before changing its folder.'));
      } else {
        showError(jt('projects.locate.failed', 'Could not change the folder: {message}', { message: String(error.message || reason || 'bind_failed') }));
      }
      return result;
    }

    function handleSwitcherPick(row) {
      let pending;
      if (row.id === '__new') pending = newProjectFromFolder();
      else if (row.id === '__clear') pending = clearWorkspace();
      else if (row.id === '__manage') { openSettingsSection('runtime'); return; }
      else if (row.intent === 'locate') pending = locateProjectFolder(row.id, { openAfter: true });
      else pending = openProjectAsWorkspace(row.id);
      Promise.resolve(pending).catch((error) => {
        appendClientLog('WARN', 'project_switcher.action_failed', { action: row.id, message: errorText(error) });
      });
    }

    async function openSwitcher(anchor) {
      if (menu.isOpen()) { menu.close(); return null; }
      await refresh();
      if (disposed) return null;
      return menu.show({ anchor, heading: jt('projects.menu.openHeading', 'Open project'), rows: switcherRows(), onPick: handleSwitcherPick });
    }

    // ---- New chat in a project -----------------------------------------------------

    // New chats land in the Workspace project; a chat for another project is
    // created there and then assigned (a fresh chat is idle). It asks for a
    // real record (requireRecord): while another send is busy a plain New Chat
    // is a local draft, which would later land in the Workspace project. The
    // filter follows so the new chat is visible (D7).
    async function newChatInProject(projectId) {
      const id = String(projectId || '').trim() || GENERAL_PROJECT_ID;
      if (!newChat) return null;
      ensureFilterShows(id);
      const current = currentProject();
      let created;
      try {
        created = String(await newChat({ projectId: id, requireRecord: (current ? current.id : GENERAL_PROJECT_ID) !== id }) || '').trim();
      } catch (error) {
        appendClientLog('WARN', 'projects.new_chat_failed', { projectId: id, message: errorText(error) });
        return null;
      }
      if (!created || disposed) return created || null;
      const session = findSession(created);
      const landed = session ? sessionProjectId(session) : (current ? current.id : GENERAL_PROJECT_ID);
      if (landed === id) return created;
      if (session && (session.local_draft === true || session.optimistic_local === true)) {
        // A local draft (another send is busy) has no backend record to move yet.
        appendClientLog('INFO', 'projects.new_chat_draft_unassigned', { projectId: id });
        return created;
      }
      const result = await assign(created, id);
      if (result && result.ok !== false) {
        setLocalProject(created, id);
        Promise.resolve(refreshSessions()).catch(noop);
      } else {
        showError(jt('projects.switcher.moveFailed', 'Could not move this chat: {message}', { message: resultMessage(result) }));
      }
      return created;
    }

    // ---- Move engine (composer pill, chat row menu, Chats bulk bar) ----------------

    // Mirrors the nudge / Settings idle rule: no live turn, stream, queued
    // send or preflight for this chat.
    function isSessionIdle(session) {
      const id = String(session && session.id || '').trim();
      const activeTurn = session && (session.active_turn || session.activeTurn);
      const activeStream = String(state.activeStreamSessionId || '').trim() === id;
      const queued = Boolean(state.queuedSendBySession && typeof state.queuedSendBySession.has === 'function'
        && state.queuedSendBySession.has(id));
      const preflight = String(state.sendPreflight && state.sendPreflight.sessionId || '').trim() === id;
      return !activeTurn && !activeStream && !queued && !preflight;
    }

    function resultMessage(result) {
      const error = result && result.error;
      return String(error && (error.message || error.reason) || 'assign_failed');
    }

    function isBusyRefusal(result) {
      const error = result && result.error;
      return BUSY_REASONS.has(String(error && (error.reason || error.code) || ''));
    }

    async function assign(sessionId, projectId) {
      const api = getProjectsApi();
      if (!api || typeof api.assignSession !== 'function') return { ok: false, error: { reason: 'assign_unavailable' } };
      try {
        return (await api.assignSession({ session_id: sessionId, project_id: projectId })) || { ok: false };
      } catch (error) {
        return { ok: false, error: { message: errorText(error) } };
      }
    }

    function setLocalProject(sessionId, projectId) {
      sessionsList().forEach((session) => {
        if (session && String(session.id || '') === sessionId) session.project_id = projectId;
      });
    }

    function skippedSuffix(count) {
      return count > 0
        ? ' ' + jtn('projects.move.skippedBusy', count, { count }, '{count} busy chat was skipped.', '{count} busy chats were skipped.')
        : '';
    }

    async function undoMove(entries) {
      const failed = [];
      for (const entry of entries) {
        if (disposed) return;
        const result = await assign(entry.id, entry.from);
        if (result && result.ok !== false) setLocalProject(entry.id, entry.from);
        else failed.push(resultMessage(result));
      }
      if (disposed) return;
      await Promise.resolve(refreshSessions()).catch(noop);
      if (failed.length) showError(jt('projects.switcher.moveFailed', 'Could not move this chat: {message}', { message: failed[0] }));
      emitChanged('move');
    }

    // Returns { moved, skipped, failed: [{ id, message }], unchanged }.
    async function moveSessionsToProject(sessionIds, projectId, options) {
      const o = options || {};
      const target = String(projectId || '').trim() || GENERAL_PROJECT_ID;
      const ids = uniqueIds(sessionIds);
      const outcome = { moved: [], skipped: [], failed: [], unchanged: [] };
      if (!ids.length) return outcome;
      const undo = [];
      for (const id of ids) {
        if (disposed) return outcome;
        const session = findSession(id);
        const from = session ? sessionProjectId(session) : '';
        if (from === target) { outcome.unchanged.push(id); continue; }
        if (session && !isSessionIdle(session)) { outcome.skipped.push(id); continue; }
        const result = await assign(id, target);
        if (result && result.ok !== false) {
          outcome.moved.push(id);
          setLocalProject(id, target);
          // Undo re-assigns into `from`, which main refuses while its folder is missing.
          if (from && !(projectById(from) || {}).folderMissing) undo.push({ id, from });
        } else if (isBusyRefusal(result)) {
          outcome.skipped.push(id);
        } else {
          outcome.failed.push({ id, message: resultMessage(result) });
        }
      }
      if (disposed) return outcome;
      if (outcome.moved.length || outcome.failed.length) await Promise.resolve(refreshSessions()).catch(noop);
      if (disposed) return outcome;
      const name = labelFor(target);
      const moved = outcome.moved.length;
      const skipped = outcome.skipped.length;
      if (outcome.failed.length) {
        showError(jt('projects.switcher.moveFailed', 'Could not move this chat: {message}', { message: outcome.failed[0].message }));
      }
      if (moved) {
        const message = (ids.length === 1
          ? jt('projects.move.movedOne', 'Moved this chat to {name}.', { name })
          : jtn('projects.move.movedMany', moved, { count: moved, name }, 'Moved {count} chat to {name}.', 'Moved {count} chats to {name}.'))
          + skippedSuffix(skipped);
        showToast(message, {
          tone: 'success',
          dedupeKey: 'projects:moved',
          actions: undo.length
            ? [{ id: 'undo-move', kind: 'secondary', label: jt('projects.move.undo', 'Undo'), onClick: () => undoMove(undo).catch(noop) }]
            : [],
        });
      } else if (skipped) {
        showError(ids.length === 1
          ? jt('workspace.rootNudge.waitIdle', 'Wait for this chat to finish first.')
          : jt('projects.move.noneMoved', 'No chats were moved.') + skippedSuffix(skipped));
      }
      appendClientLog('INFO', 'projects.sessions_moved', {
        source: String(o.source || ''), projectId: target, moved, skipped, failed: outcome.failed.length,
      });
      emitChanged('move');
      return outcome;
    }

    function moveRows(sessionIds) {
      const ids = uniqueIds(sessionIds);
      const sessions = ids.map(findSession).filter(Boolean);
      const origins = new Set(sessions.map(sessionProjectId));
      // "here now" only when every chat being moved already sits in one project.
      const origin = sessions.length === ids.length && origins.size === 1 ? Array.from(origins)[0] : '';
      const busy = ids.length === 1 && sessions.length === 1 && !isSessionIdle(sessions[0]);
      const busyReason = busy ? jt('workspace.rootNudge.waitIdle', 'Wait for this chat to finish first.') : '';
      const hereNow = jt('projects.move.hereNow', 'here now');
      const labels = displayNames(projects);
      const current = currentProject();
      const rows = sortProjectsForMenu(projects, current && current.id, state.sessions).map((project) => {
        const here = project.id === origin;
        const row = projectRow(project, { label: labels[project.id], selected: here, disabled: busy || here, reason: here ? hereNow : busyReason });
        if (here) { row.detail = hereNow; row.danger = false; }
        return row;
      });
      const generalHere = origin === GENERAL_PROJECT_ID;
      rows.push({
        id: GENERAL_PROJECT_ID, kind: 'project', separatorBefore: true,
        label: labelFor(GENERAL_PROJECT_ID),
        detail: generalHere ? hereNow : jt('projects.switcher.generalDetail', 'no folder · file tools off'),
        selected: generalHere,
        disabled: busy || generalHere,
        reason: generalHere ? hereNow : busyReason,
      });
      return rows;
    }

    // Opens "Move this chat to" / "Move {n} chats to" anchored on anchorEl.
    // options: { onMoved(result), onClose(), source }
    async function openMoveMenu(anchorEl, sessionIds, options) {
      const o = options || {};
      const ids = uniqueIds(sessionIds);
      if (!ids.length) return null;
      if (menu.isOpen()) { menu.close(); return null; }
      await refresh();
      if (disposed) return null;
      const heading = ids.length === 1
        ? jt('projects.move.headingOne', 'Move this chat to')
        : jtn('projects.move.headingMany', ids.length, { count: ids.length }, 'Move {count} chat to', 'Move {count} chats to');
      return menu.show({
        anchor: anchorEl,
        heading,
        footnote: jt('projects.move.footnote', 'Its file access and memories follow the project.'),
        rows: moveRows(ids),
        onClose: o.onClose,
        onPick: (row) => {
          Promise.resolve(moveSessionsToProject(ids, row.id, { source: o.source || 'menu' }))
            .then((result) => { if (typeof o.onMoved === 'function' && result && result.moved.length) o.onMoved(result); })
            .catch(noop);
        },
      });
    }

    // ---- Chats panel filter ----------------------------------------------------

    function filterRows(selectedId) {
      const counts = countChatsByProject(state.sessions);
      const total = Object.keys(counts).reduce((sum, key) => sum + counts[key], 0);
      const labels = displayNames(projects);
      const rows = [{ id: '', kind: 'project', label: jt('projects.filter.all', 'All projects'), count: total, selected: !selectedId }];
      const current = currentProject();
      sortProjectsForMenu(projects, current && current.id, state.sessions).forEach((project) => {
        rows.push(projectRow(project, { label: labels[project.id], count: counts[project.id] || 0, selected: selectedId === project.id }));
      });
      rows.push({
        id: GENERAL_PROJECT_ID, kind: 'project', separatorBefore: true,
        label: labelFor(GENERAL_PROJECT_ID),
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
        heading: jt('projects.filter.heading', 'Show chats from'),
        rows: filterRows(String(o.selectedId || '')),
        onPick: (row) => {
          filterPickedByUser = true;
          if (typeof o.onPick === 'function') o.onPick(row.id);
        },
      });
    }

    function bind() {
      if (windowRef && typeof windowRef.addEventListener === 'function') {
        windowRef.addEventListener(CHANGED_EVENT, handleProjectsChanged);
      }
    }

    function dispose() {
      disposed = true;
      listeners.clear();
      if (windowRef && typeof windowRef.removeEventListener === 'function') {
        windowRef.removeEventListener(CHANGED_EVENT, handleProjectsChanged);
      }
      menu.dispose();
    }

    return {
      bind, dispose,
      // One project cache.
      refresh, refreshProjects, getProjects, onProjectsChanged, currentProject, projectById, title, referenceChatProjectId,
      // Open project.
      switcherRows, openSwitcher, openProjectAsWorkspace, switchToProject: openProjectAsWorkspace,
      newProjectFromFolder, clearWorkspace, locateProjectFolder, newChatInProject, followWorkspaceChat,
      captureBaseline, afterTransition,
      // Move engine.
      moveRows, openMoveMenu, moveSessionsToProject, isSessionIdle,
      // Chats filter.
      filterRows, openFilterMenu, ensureFilterShows, setChatsFilter,
      menu,
    };
  }

  return { CHANGED_EVENT, PROJECTS_TTL_MS, createProjectSwitcher };
});
