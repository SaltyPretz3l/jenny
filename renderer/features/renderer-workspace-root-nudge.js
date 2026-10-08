/* renderer/features/renderer-workspace-root-nudge.js
 *
 * Slim dismissible hint above the composer, in one of two states:
 *
 *   set-root    no Workspace folder is configured at all.
 *   use-folder  a folder is configured, but this chat's project has none
 *               (General, or a project that was unbound by hand), so file
 *               tools are off for this chat. The action adopts the workspace
 *               project through `projects.adoptWorkspace` (idle chats only;
 *               nothing is retargeted without this explicit click).
 *
 * Projects v2 (2026-09-20) also owns the composer's project pill
 * (#composerProjectPillSlot, beside the run-mode and model pills): it names
 * the current chat's project (General included) and opens the shared
 * "Move this chat to" menu (the switcher's one move engine, idle-only). It
 * never switches the Workspace.
 *
 * Project names come from the switcher's one cache (never listed here, 2026-09-27).
 *
 * Truthful "no Workspace folder" signal: `state.workspaceRoot.path`, populated
 * by `refreshWorkspaceRootState()` from
 * `window.jennyShell.workspaceRoot.getState()`. Status can legitimately be
 * `checking` while a persisted or newly selected directory is probed, so it
 * must not drive this one-time configuration hint. Invalid-root guidance is
 * owned by Settings rather than a misleading "No workspace root set" chip.
 *
 * "Set Workspace folder" reuses the existing picker seam, the same one the
 * Settings › Tools surface's "Choose folder…" button calls: does NOT build a
 * new picker or mint a new IPC channel.
 *
 * Dismiss is session-scoped (controller state, not persisted config): the
 * set-root hint once per window, the use-folder hint once per chat. Both
 * clear if the module is freshly reloaded. Re-render also happens on the
 * shell's snapshot cadence, so the chip follows root, chat and idle changes
 * live without a page reload.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.rendererWorkspaceRootNudge = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  var asyncFence = (root && root.rendererAsyncFence)
    || (typeof require === 'function' ? require('../shared/async-fence') : null);
  var CHIP_ID = 'workspaceRootNudge';
  var COMPOSER_WRAP_SELECTOR = '#composerWrap';
  var GENERAL_PROJECT_ID = 'project_general';

  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  function folderName(rootPath) {
    var parts = String(rootPath || '').split(/[\\/]+/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : String(rootPath || '');
  }

  function resolveActionButton() {
    return (root && root.inventoryActionButton)
      || (typeof require === 'function' ? require('../inventory/action-button') : null)
      || null;
  }

  function dismissButtonHtml(actionButton) {
    return actionButton({
      plain: true,
      className: 'workspace-root-nudge-dismiss',
      label: '✕',
      ariaLabel: jt('projects.nudge.dismiss', 'Dismiss Workspace folder hint'),
      title: jt('projects.nudge.dismiss', 'Dismiss Workspace folder hint'),
      dataset: { 'workspace-root-nudge-action': 'dismiss' },
    });
  }

  function chipOpen(variant, key) {
    return '<div class="workspace-root-nudge" id="' + CHIP_ID + '" role="status" data-workspace-root-nudge'
      + ' data-nudge-variant="' + escapeHtml(variant) + '" data-nudge-key="' + escapeHtml(key) + '">'
      + '<span class="workspace-root-nudge-icon" aria-hidden="true">⚠</span>';
  }

  function buildChipHtml() {
    var actionButton = resolveActionButton();
    return chipOpen('set-root', 'set-root')
      + '<span class="workspace-root-nudge-text">' + escapeHtml(jt('projects.nudge.noFolder', 'No Workspace folder set — file tools are off for this chat.')) + '</span>'
      + actionButton({
        plain: true,
        className: 'workspace-root-nudge-action',
        label: jt('projects.nudge.setFolder', 'Set Workspace folder'),
        dataset: { 'workspace-root-nudge-action': 'set-root' },
      })
      + dismissButtonHtml(actionButton)
      + '</div>';
  }

  var PILL_SLOT_ID = 'composerProjectPillSlot';
  var PILL_ID = 'composerProjectPill';

  function resolveChip() {
    return (root && root.inventoryChip)
      || (typeof require === 'function' ? require('../inventory/chip') : null)
      || null;
  }

  // Quiet text on the Composer bar: "in <name>" with a caret (row 38 item 3,
  // variant A). The name takes the accent while the Chats filter hides this
  // chat, so the bar says where the message lands even when the list shows
  // another project.
  function buildProjectPillHtml(pill) {
    var chip = resolveChip();
    if (typeof chip !== 'function') return '';
    return chip({
      id: 'composer-project',
      domId: PILL_ID,
      iconHtml: '<span class="composer-project-pill-prefix">' + escapeHtml(jt('composer.projectPill.prefix', 'in')) + '</span>',
      label: pill.name,
      ariaLabel: jt('composer.projectPill.ariaLabel', 'Project: {name}. Move this chat to another project.', { name: pill.name }),
      title: pill.hiddenByFilter
        ? jt('composer.projectPill.titleFiltered', 'This chat is in {name}. The Chats list is showing another project; your next message still goes here. Click to move it.', { name: pill.name })
        : pill.rootPath
        ? jt('composer.projectPill.title', 'This chat is in {name} ({path}). Click to move it.', { name: pill.name, path: pill.rootPath })
        : jt('composer.projectPill.titleNoFolder', 'This chat is in {name} (no folder). Click to move it.', { name: pill.name }),
      hasPopup: true,
      className: 'composer-project-pill'
        + (pill.rootPath ? '' : ' composer-project-pill--general')
        + (pill.hiddenByFilter ? ' composer-project-pill--filtered' : ''),
    });
  }

  function buildUseFolderChipHtml(candidate) {
    var actionButton = resolveActionButton();
    var folder = folderName(candidate.rootPath);
    return chipOpen('use-folder', candidate.key)
      + '<span class="workspace-root-nudge-text">' + escapeHtml(jt('workspace.rootNudge.unboundChat', 'This chat has no folder — file tools are off for it.')) + '</span>'
      + actionButton({
        plain: true,
        className: 'workspace-root-nudge-action',
        label: jt('workspace.rootNudge.useFolder', 'Use {folder}', { folder: folder }),
        title: candidate.idle
          ? candidate.rootPath
          : jt('workspace.rootNudge.waitIdle', 'Wait for this chat to finish first.'),
        disabled: !candidate.idle,
        dataset: { 'workspace-root-nudge-action': 'use-folder' },
      })
      + dismissButtonHtml(actionButton)
      + '</div>';
  }

  function createWorkspaceRootNudgeController(deps) {
    var d = deps || {};
    var state = d.state || {};
    var windowRef = d.windowRef || (typeof globalThis !== 'undefined' ? globalThis : {});
    var documentRef = d.documentRef || windowRef.document || null;
    var appendClientLog = typeof d.appendClientLog === 'function' ? d.appendClientLog : function noop() {};
    var chooseWorkspaceRoot = typeof d.chooseWorkspaceRoot === 'function' ? d.chooseWorkspaceRoot : null;
    // projects.adoptWorkspace only; project names come from the switcher.
    var getProjectsApi = typeof d.getProjectsApi === 'function'
      ? d.getProjectsApi
      : function () { return windowRef && windowRef.jennyShell ? windowRef.jennyShell.projects : null; };
    var refreshSessions = typeof d.refreshSessions === 'function' ? d.refreshSessions : null;
    // Projects v2: resolves the lazily loaded project switcher (shared menu).
    var getProjectSwitcher = typeof d.getProjectSwitcher === 'function' ? d.getProjectSwitcher : null;
    var disposalFence = asyncFence.createDisposalFence();

    // Session-scoped dismiss: lives on the controller instance, not on
    // `state` and not persisted to config/disk. A fresh controller instance
    // (new window/session bootstrap) starts un-dismissed.
    var dismissed = false;
    var dismissedChats = {};
    var projectsById = null;
    var projectsKey = null;
    // Projects this window adopted before the switcher's list caught up.
    var adoptedProjects = {};
    var switcherRef = null;
    var switcherRequested = false;
    var unsubscribeProjects = null;
    var adoptInFlight = '';

    function workspaceRootPath() {
      var workspaceRootState = state && state.workspaceRoot;
      return String(workspaceRootState && workspaceRootState.path || '').trim();
    }

    function isWorkspaceRootConfigured() {
      return Boolean(workspaceRootPath());
    }

    function currentSession() {
      var id = String(state && state.currentSessionId || '').trim();
      if (!id) return null;
      var sessions = Array.isArray(state.sessions) ? state.sessions : [];
      for (var i = 0; i < sessions.length; i += 1) {
        if (String(sessions[i] && sessions[i].id || '').trim() === id) return sessions[i];
      }
      return null;
    }

    // Mirrors the idle rule of the Settings > Projects section (the former
    // Runtime & orchestration page):
    // no live turn, stream, queued send or preflight for this chat.
    function isSessionIdle(session) {
      var id = String(session && session.id || '').trim();
      var activeTurn = session && (session.active_turn || session.activeTurn);
      var activeStream = String(state.activeStreamSessionId || '').trim() === id;
      var queued = Boolean(state.queuedSendBySession && typeof state.queuedSendBySession.has === 'function'
        && state.queuedSendBySession.has(id));
      var preflight = String(state.sendPreflight && state.sendPreflight.sessionId || '').trim() === id;
      return !activeTurn && !activeStream && !queued && !preflight;
    }

    // projectsById: id -> { name, rootPath } ('' rootPath = folderless).
    function knownProject(projectId) {
      return projectsById && Object.prototype.hasOwnProperty.call(projectsById, projectId) ? projectsById[projectId] : null;
    }

    // 'unbound' | 'bound' | 'unknown'. Asking keeps the switcher's cache
    // fresh (a no-op inside its 15 s window); changes arrive by subscription.
    function projectRootState(projectId) {
      if (!projectId || projectId === GENERAL_PROJECT_ID) return 'unbound';
      requestProjects();
      var known = knownProject(projectId);
      return known ? (known.rootPath ? 'bound' : 'unbound') : 'unknown';
    }

    function projectEntry(project) {
      var id = String(project && project.id || '').trim();
      if (!id) return null;
      var rootPath = typeof project.rootPath === 'string' ? project.rootPath
        : (typeof project.root_path === 'string' ? project.root_path : '');
      return { id: id, name: String(project.name || '').trim() || id, rootPath: rootPath.trim() };
    }

    function rememberProjects(list) {
      var next = {};
      for (var i = 0; i < list.length; i += 1) {
        var entry = projectEntry(list[i]);
        if (!entry) continue;
        next[entry.id] = { name: entry.name, rootPath: entry.rootPath };
        delete adoptedProjects[entry.id];
      }
      Object.keys(adoptedProjects).forEach(function (id) { next[id] = adoptedProjects[id]; });
      projectsById = next;
    }

    function projectsSignature(list) {
      return (Array.isArray(list) ? list : []).map(function (project) {
        var entry = projectEntry(project);
        return entry ? [entry.id, entry.name, entry.rootPath].join('\u001f') : '';
      }).sort().join('\u001e'); // order-free: a most-recently-used reorder is not a change here
    }

    function absorbProjects(list) {
      if (disposalFence.isDisposed()) return;
      var key = projectsSignature(list);
      if (key === projectsKey) return;
      projectsKey = key;
      rememberProjects(Array.isArray(list) ? list : []);
      var slot = pillSlot();
      if (slot) slot.__jennyPillKey = '';
      render();
    }

    function logProjectsFailure(error) {
      appendClientLog('WARN', 'workspace_root_nudge.projects_list_failed', {
        message: error && error.message ? error.message : String(error),
      });
    }

    function refreshFromSwitcher(force) {
      var switcher = switcherRef;
      if (!switcher) return;
      var read = null;
      if (typeof switcher.refreshProjects === 'function') read = switcher.refreshProjects({ force: force === true });
      else if (typeof switcher.getProjects === 'function') read = switcher.getProjects();
      if (!read) return;
      Promise.resolve(read).then(disposalFence.guard(absorbProjects)).catch(disposalFence.guard(logProjectsFailure));
    }

    function attachSwitcher(switcher) {
      switcherRef = switcher;
      if (typeof switcher.onProjectsChanged === 'function') {
        unsubscribeProjects = switcher.onProjectsChanged(disposalFence.guard(absorbProjects));
      }
      refreshFromSwitcher(false);
    }

    // The switcher loads lazily; the first non-General chat asks for it once.
    function requestProjects() {
      if (disposalFence.isDisposed()) return;
      if (switcherRef) { refreshFromSwitcher(false); return; }
      if (switcherRequested || !getProjectSwitcher) return;
      switcherRequested = true;
      Promise.resolve(getProjectSwitcher())
        .then(disposalFence.guard(function (switcher) { if (switcher) attachSwitcher(switcher); }))
        .catch(disposalFence.guard(logProjectsFailure));
    }

    // The composer pill: the current chat's project, General included. Unknown
    // (list not fetched yet) renders the neutral "Project" label meanwhile.
    function projectPillModel() {
      var session = currentSession();
      if (!session) return null;
      var projectId = String(session.project_id || '').trim() || GENERAL_PROJECT_ID;
      var known = projectId === GENERAL_PROJECT_ID ? null : knownProject(projectId);
      // Freshness is judged for every non-General pill (a rename elsewhere
      // resets the stamp); the nudge's own logic may never run for a bound chat.
      if (projectId !== GENERAL_PROJECT_ID) projectRootState(projectId);
      var name = projectId === GENERAL_PROJECT_ID
        ? jt('projects.switcher.generalName', 'General')
        : (known ? known.name : jt('projects.filter.project', 'Project'));
      var rootPath = known ? known.rootPath : '';
      var filter = String(state.ui && state.ui.chatsProjectFilter || '').trim();
      var hiddenByFilter = Boolean(filter) && filter !== projectId;
      return {
        sessionId: String(session.id || '').trim(),
        projectId: projectId,
        name: name,
        rootPath: rootPath,
        hiddenByFilter: hiddenByFilter,
        idle: isSessionIdle(session),
        key: ['pill', session.id, projectId, name, rootPath, hiddenByFilter ? 'filtered' : ''].join('|'),
      };
    }

    function pillSlot() {
      return documentRef && typeof documentRef.getElementById === 'function' ? documentRef.getElementById(PILL_SLOT_ID) : null;
    }

    function renderProjectPill() {
      var slot = pillSlot();
      if (!slot) return;
      var model = projectPillModel();
      if (!model) {
        if (slot.innerHTML) { slot.innerHTML = ''; slot.__jennyPillKey = ''; }
        return;
      }
      if (slot.__jennyPillKey === model.key) return;
      slot.__jennyPillKey = model.key;
      slot.innerHTML = buildProjectPillHtml(model);
      var pill = slot.querySelector('#' + PILL_ID);
      if (pill) pill.setAttribute('aria-haspopup', 'menu');
    }

    function unboundChatCandidate() {
      var session = currentSession();
      if (!session) return null;
      var sessionId = String(session.id || '').trim();
      if (dismissedChats[sessionId]) return null;
      if (session.session_type === 'plugin') return null;
      // A chat with no backend record yet (first Send in flight, or a local
      // draft) carries no project_id: sessions.create binds it to the Workspace
      // folder's project, so its project is unknown here, not General.
      if (session.optimistic_local === true && !String(session.project_id || '').trim()) return null;
      if (projectRootState(String(session.project_id || '').trim()) !== 'unbound') return null;
      var rootPath = workspaceRootPath();
      var idle = isSessionIdle(session) && adoptInFlight !== sessionId;
      return {
        sessionId: sessionId,
        rootPath: rootPath,
        idle: idle,
        key: ['use-folder', sessionId, idle ? 'idle' : 'busy', rootPath].join('|'),
      };
    }

    function findComposerWrap() {
      if (!documentRef || typeof documentRef.querySelector !== 'function') {
        return null;
      }
      return documentRef.querySelector(COMPOSER_WRAP_SELECTOR);
    }

    function existingChip() {
      return documentRef && typeof documentRef.getElementById === 'function'
        ? documentRef.getElementById(CHIP_ID)
        : null;
    }

    function removeExistingChip() {
      var existing = existingChip();
      if (existing && existing.parentNode) {
        existing.parentNode.removeChild(existing);
      }
    }

    function mount(key, html) {
      var existing = existingChip();
      if (existing && existing.getAttribute('data-nudge-key') === key) {
        // Already mounted and still applicable — leave it in place.
        return;
      }
      var wrap = findComposerWrap();
      if (!wrap) return;
      removeExistingChip();
      wrap.insertAdjacentHTML('afterbegin', html);
    }

    function render() {
      if (disposalFence.isDisposed()) return;
      renderProjectPill();
      // Boot seed: the root state is not authoritative until the feature
      // payload lands, so no chip mounts (and flashes) before hydration.
      if (state && state.features && state.features.availabilityResolved === false) {
        removeExistingChip();
        return;
      }
      if (!isWorkspaceRootConfigured()) {
        if (dismissed) removeExistingChip();
        else mount('set-root', buildChipHtml());
        return;
      }
      var candidate = unboundChatCandidate();
      if (!candidate) {
        removeExistingChip();
        return;
      }
      mount(candidate.key, buildUseFolderChipHtml(candidate));
    }

    function handleMoveChatClick(anchor) {
      var model = projectPillModel();
      if (!model || !getProjectSwitcher) return;
      Promise.resolve(getProjectSwitcher())
        .then(disposalFence.guard(function (switcher) {
          if (!switcher || typeof switcher.openMoveMenu !== 'function') return;
          if (!switcherRef) attachSwitcher(switcher);
          return switcher.openMoveMenu(anchor, [model.sessionId], {
            source: 'composer',
            onMoved: disposalFence.guard(function () {
              var slot = pillSlot();
              if (slot) slot.__jennyPillKey = '';
              render();
            }),
          });
        }))
        .catch(disposalFence.guard(function (error) {
          appendClientLog('WARN', 'workspace_root_nudge.move_menu_failed', {
            message: error && error.message ? error.message : String(error),
          });
        }));
    }

    function handleSetRootClick() {
      if (typeof chooseWorkspaceRoot !== 'function') {
        appendClientLog('WARN', 'workspace_root_nudge.choose_unavailable', {});
        return;
      }
      Promise.resolve(chooseWorkspaceRoot())
        .then(disposalFence.guard(function () {
          render();
        }))
        .catch(disposalFence.guard(function (error) {
          appendClientLog('WARN', 'workspace_root_nudge.choose_failed', {
            message: error && error.message ? error.message : String(error),
          });
        }));
    }

    function showAdoptFailure(sessionId, message) {
      var chip = existingChip();
      var text = chip && chip.querySelector ? chip.querySelector('.workspace-root-nudge-text') : null;
      if (text) {
        text.textContent = jt('workspace.rootNudge.useFolderFailed', 'Could not use {folder}: {message}', {
          folder: folderName(workspaceRootPath()), message: message,
        });
      }
      appendClientLog('WARN', 'workspace_root_nudge.adopt_failed', { sessionId: sessionId, message: message });
    }

    function applyAdoptedSession(session, project) {
      var sessionId = String(session && session.id || '').trim();
      var sessions = Array.isArray(state.sessions) ? state.sessions : [];
      for (var i = 0; i < sessions.length; i += 1) {
        if (String(sessions[i] && sessions[i].id || '').trim() === sessionId) {
          sessions[i].project_id = String(session.project_id || '').trim();
        }
      }
      var entry = projectEntry(project);
      if (entry) {
        if (!projectsById) projectsById = {};
        adoptedProjects[entry.id] = { name: entry.name, rootPath: entry.rootPath };
        projectsById[entry.id] = adoptedProjects[entry.id];
        // Adoption can provision a project: the one cache re-reads.
        refreshFromSwitcher(true);
      }
    }

    function handleUseFolderClick() {
      var candidate = unboundChatCandidate();
      if (!candidate || !candidate.idle) return;
      var api = getProjectsApi();
      if (!api || typeof api.adoptWorkspace !== 'function') {
        appendClientLog('WARN', 'workspace_root_nudge.adopt_unavailable', {});
        return;
      }
      var sessionId = candidate.sessionId;
      adoptInFlight = sessionId;
      render();
      var pending;
      try {
        pending = Promise.resolve(api.adoptWorkspace({ session_id: sessionId }));
      } catch (error) {
        pending = Promise.reject(error);
      }
      pending
        .then(disposalFence.guard(function (result) {
          adoptInFlight = '';
          if (!result || result.ok === false) {
            var error = result && result.error;
            render();
            showAdoptFailure(sessionId, String(error && (error.message || error.reason) || 'adopt_failed'));
            return;
          }
          applyAdoptedSession(result.session || { id: sessionId, project_id: result.project && result.project.id }, result.project);
          appendClientLog('INFO', 'workspace_root_nudge.adopted', {
            sessionId: sessionId, projectId: String(result.project && result.project.id || ''),
          });
          render();
          if (refreshSessions) Promise.resolve(refreshSessions()).catch(function () {});
        }))
        .catch(disposalFence.guard(function (error) {
          adoptInFlight = '';
          render();
          showAdoptFailure(sessionId, error && error.message ? error.message : String(error));
        }));
    }

    function handleDismissClick() {
      var chip = existingChip();
      if (chip && chip.getAttribute('data-nudge-variant') === 'use-folder') {
        var candidate = unboundChatCandidate();
        if (candidate) dismissedChats[candidate.sessionId] = true;
      } else {
        dismissed = true;
      }
      render();
    }

    function handleClick(event) {
      var target = event && event.target;
      if (!target || typeof target.closest !== 'function') {
        return;
      }
      var pillEl = target.closest('#' + PILL_ID);
      if (pillEl) {
        event.preventDefault();
        handleMoveChatClick(pillEl);
        return;
      }
      var actionEl = target.closest('[data-workspace-root-nudge-action]');
      if (!actionEl) {
        return;
      }
      var action = actionEl.getAttribute('data-workspace-root-nudge-action');
      if (action === 'set-root') {
        handleSetRootClick();
      } else if (action === 'use-folder') {
        handleUseFolderClick();
      } else if (action === 'dismiss') {
        handleDismissClick();
      }
    }

    // The composer re-renders on every chat switch and busy/idle transition
    // and announces it (renderer-render-pipeline-chrome.js); the chip follows
    // that instead of polling for the current chat.
    function handleComposerRendered() {
      render();
    }

    function handleSidebarRendered() {
      if (disposalFence.isDisposed()) return;
      renderProjectPill();
    }

    function bind() {
      if (disposalFence.isDisposed() || !documentRef || typeof documentRef.addEventListener !== 'function') {
        return;
      }
      documentRef.addEventListener('click', handleClick);
      documentRef.addEventListener('composer-state-rendered', handleComposerRendered);
      documentRef.addEventListener('sidebar-rendered', handleSidebarRendered, true);
    }

    function dispose() {
      if (!disposalFence.dispose()) return;
      if (documentRef && typeof documentRef.removeEventListener === 'function') {
        documentRef.removeEventListener('click', handleClick);
        documentRef.removeEventListener('composer-state-rendered', handleComposerRendered);
        documentRef.removeEventListener('sidebar-rendered', handleSidebarRendered, true);
      }
      if (typeof unsubscribeProjects === 'function') unsubscribeProjects();
      unsubscribeProjects = null;
      switcherRef = null;
      var slot = pillSlot();
      if (slot) { slot.innerHTML = ''; slot.__jennyPillKey = ''; }
      removeExistingChip();
    }

    return {
      bind: bind,
      dispose: dispose,
      render: render,
      isWorkspaceRootConfigured: isWorkspaceRootConfigured,
    };
  }

  return {
    createWorkspaceRootNudgeController: createWorkspaceRootNudgeController,
    folderName: folderName,
  };
});
