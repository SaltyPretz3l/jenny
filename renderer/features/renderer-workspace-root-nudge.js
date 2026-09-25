/* renderer/features/renderer-workspace-root-nudge.js
 *
 * Slim dismissible hint above the composer, gated by the default-on
 * workspace_root_nudge flag, in one of two states:
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
 * the current chat's project (General included) and opens the shared project
 * menu to move THIS chat (the existing idle-only assign). It never switches
 * the Workspace, and it is not gated by the nudge flag.
 *
 * Truthful "no workspace root" signal: `state.workspaceRoot.path`, populated
 * by `refreshWorkspaceRootState()` from
 * `window.jennyShell.workspaceRoot.getState()`. Status can legitimately be
 * `checking` while a persisted or newly selected directory is probed, so it
 * must not drive this one-time configuration hint. Invalid-root guidance is
 * owned by Settings rather than a misleading "No workspace root set" chip.
 *
 * "Set workspace root" reuses the existing picker seam, the same one the
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
  // Project roots change rarely; the list is re-read on the shell's own
  // 15s snapshot cadence at most, and only for non-General chats.
  var PROJECTS_TTL_MS = 15000;

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

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
      ariaLabel: jt('workspace.rootNudge.dismiss', 'Dismiss workspace root hint'),
      title: jt('workspace.rootNudge.dismiss', 'Dismiss workspace root hint'),
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
      + '<span class="workspace-root-nudge-text">' + escapeHtml(jt('workspace.rootNudge.message', 'No workspace root set — file tools are off for this chat.')) + '</span>'
      + actionButton({
        plain: true,
        className: 'workspace-root-nudge-action',
        label: jt('workspace.rootNudge.setRoot', 'Set workspace root'),
        dataset: { 'workspace-root-nudge-action': 'set-root' },
      })
      + dismissButtonHtml(actionButton)
      + '</div>';
  }

  var PILL_SLOT_ID = 'composerProjectPillSlot';
  var PILL_ID = 'composerProjectPill';
  var FOLDER_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z"/></svg>';

  function resolveChip() {
    return (root && root.inventoryChip)
      || (typeof require === 'function' ? require('../inventory/chip') : null)
      || null;
  }

  function buildProjectPillHtml(pill) {
    var chip = resolveChip();
    if (typeof chip !== 'function') return '';
    return chip({
      id: 'composer-project',
      domId: PILL_ID,
      iconHtml: FOLDER_ICON,
      label: pill.name,
      ariaLabel: jt('composer.projectPill.ariaLabel', 'Project: {name}. Move this chat to another project.', { name: pill.name }),
      title: pill.rootPath
        ? jt('composer.projectPill.title', 'This chat is in {name} ({path}). Click to move it.', { name: pill.name, path: pill.rootPath })
        : jt('composer.projectPill.titleNoFolder', 'This chat is in {name} (no folder). Click to move it.', { name: pill.name }),
      hasPopup: true,
      className: 'composer-project-pill' + (pill.rootPath ? '' : ' composer-project-pill--general'),
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
    var getProjectsApi = typeof d.getProjectsApi === 'function'
      ? d.getProjectsApi
      : function () { return windowRef && windowRef.jennyShell ? windowRef.jennyShell.projects : null; };
    var refreshSessions = typeof d.refreshSessions === 'function' ? d.refreshSessions : null;
    // Projects v2: resolves the lazily loaded project switcher (shared menu).
    var getProjectSwitcher = typeof d.getProjectSwitcher === 'function' ? d.getProjectSwitcher : null;
    var now = typeof d.now === 'function' ? d.now : function () { return Date.now(); };
    var disposalFence = asyncFence.createDisposalFence();

    // Session-scoped dismiss: lives on the controller instance, not on
    // `state` and not persisted to config/disk. A fresh controller instance
    // (new window/session bootstrap) starts un-dismissed.
    var dismissed = false;
    var dismissedChats = {};
    var projectsById = null;
    var projectsFetchedAt = 0;
    var projectsFetchInFlight = false;
    var adoptInFlight = '';

    function isFeatureEnabled() {
      return Boolean(
        state
        && state.features
        && state.features.featureFlags
        && state.features.featureFlags.workspace_root_nudge === true
      );
    }

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

    // 'unbound' | 'bound' | 'unknown' (unknown schedules one list fetch).
    function projectRootState(projectId) {
      if (!projectId || projectId === GENERAL_PROJECT_ID) return 'unbound';
      var fresh = projectsById && (now() - projectsFetchedAt) < PROJECTS_TTL_MS;
      var known = knownProject(projectId);
      if (fresh && known) {
        return known.rootPath ? 'bound' : 'unbound';
      }
      if (projectsById && !fresh) fetchProjects();
      else if (!projectsById) fetchProjects();
      return known ? (known.rootPath ? 'bound' : 'unbound') : 'unknown';
    }

    function rememberProjects(list) {
      var next = {};
      for (var i = 0; i < list.length; i += 1) {
        var project = list[i];
        var id = String(project && project.id || '').trim();
        if (!id) continue;
        next[id] = {
          name: String(project.name || '').trim() || id,
          rootPath: typeof project.root_path === 'string' ? project.root_path.trim() : '',
        };
      }
      projectsById = next;
      projectsFetchedAt = now();
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
      return {
        sessionId: String(session.id || '').trim(),
        projectId: projectId,
        name: name,
        rootPath: rootPath,
        idle: isSessionIdle(session),
        key: ['pill', session.id, projectId, name, rootPath].join('|'),
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
      if (pill) pill.setAttribute('aria-haspopup', 'listbox');
    }

    function fetchProjects() {
      if (projectsFetchInFlight || disposalFence.isDisposed()) return;
      var api = getProjectsApi();
      if (!api || typeof api.list !== 'function') return;
      projectsFetchInFlight = true;
      var pending;
      try {
        pending = Promise.resolve(api.list());
      } catch (error) {
        pending = Promise.reject(error);
      }
      pending
        .then(disposalFence.guard(function (payload) {
          projectsFetchInFlight = false;
          rememberProjects(Array.isArray(payload && payload.projects) ? payload.projects : []);
          render();
        }))
        .catch(disposalFence.guard(function (error) {
          projectsFetchInFlight = false;
          appendClientLog('WARN', 'workspace_root_nudge.projects_list_failed', {
            message: error && error.message ? error.message : String(error),
          });
        }));
    }

    function unboundChatCandidate() {
      var session = currentSession();
      if (!session) return null;
      var sessionId = String(session.id || '').trim();
      if (dismissedChats[sessionId]) return null;
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
      if (!isFeatureEnabled()) {
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
          if (!switcher) return;
          return switcher.openMoveChatMenu({
            anchor: anchor,
            sessionId: model.sessionId,
            projectId: model.projectId,
            idle: model.idle,
            onMoved: disposalFence.guard(function () { projectsFetchedAt = 0; render(); }),
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
      if (project && project.id) {
        if (!projectsById) projectsById = {};
        projectsById[String(project.id).trim()] = {
          name: String(project.name || '').trim() || String(project.id).trim(),
          rootPath: typeof project.root_path === 'string' ? project.root_path.trim() : '',
        };
        projectsFetchedAt = now();
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

    function handleProjectsChanged() {
      projectsFetchedAt = 0;
      var slot = pillSlot();
      if (slot) slot.__jennyPillKey = '';
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

    function bind() {
      if (disposalFence.isDisposed() || !documentRef || typeof documentRef.addEventListener !== 'function') {
        return;
      }
      documentRef.addEventListener('click', handleClick);
      documentRef.addEventListener('composer-state-rendered', handleComposerRendered);
      if (windowRef && typeof windowRef.addEventListener === 'function') {
        windowRef.addEventListener('jenny:projects-changed', handleProjectsChanged);
      }
    }

    function dispose() {
      if (!disposalFence.dispose()) return;
      if (documentRef && typeof documentRef.removeEventListener === 'function') {
        documentRef.removeEventListener('click', handleClick);
        documentRef.removeEventListener('composer-state-rendered', handleComposerRendered);
      }
      if (windowRef && typeof windowRef.removeEventListener === 'function') {
        windowRef.removeEventListener('jenny:projects-changed', handleProjectsChanged);
      }
      var slot = pillSlot();
      if (slot) { slot.innerHTML = ''; slot.__jennyPillKey = ''; }
      removeExistingChip();
    }

    return {
      bind: bind,
      dispose: dispose,
      render: render,
      isFeatureEnabled: isFeatureEnabled,
      isWorkspaceRootConfigured: isWorkspaceRootConfigured,
    };
  }

  return {
    createWorkspaceRootNudgeController: createWorkspaceRootNudgeController,
    folderName: folderName,
  };
});
