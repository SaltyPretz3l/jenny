/* renderer/shell/renderer-settings-session-runtime.js - Settings > Projects.
 *
 * The project manager (Projects PO review 2026-09-27, Fork 1 A). A project is
 * a folder Jenny works in; the Workspace folder IS the project. One row per
 * project: name + Current / No folder / Folder missing tags, the mono folder
 * path, "{n} chats · last used {age}", ONE primary action (Open / Show chats /
 * Locate folder) and a ⋯ command menu (the shared project menu in command
 * mode) with Open as Workspace, New chat here, Show chats, Change folder,
 * Rename and Delete. "New project from folder" sits in the header, always.
 * Rename and Delete keep their inline patterns; the status line repeats the
 * backend's own reason on failure. The section id stays `runtime` for
 * persisted deep links.
 *
 * The project switcher (lazy, reached through options.getProjectSwitcher)
 * owns the renderer's one project cache: this page reads its own list once on
 * bind (for the storage read-only flag) and afterwards repaints from the
 * switcher's change notifications instead of re-reading. Without a switcher
 * (hosted client, tests) it falls back to its own list reads and the
 * `jenny:projects-changed` window event, and to inline Rename / Delete.
 *
 * Deleting the project the Workspace is bound to also closes the Workspace
 * (`clearWorkspaceRoot`, the same transaction the IDE's Clear runs), and the
 * moved chats are patched to General in `state.sessions` so the chat list and
 * composer follow without a reload.
 *
 * Focus (D13): every render restores focus to the control that had it, keyed
 * by data-project-id + data-action, so a re-render never drops keyboard focus
 * to the page body.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../inventory/action-button'), require('../inventory/text-field'));
    return;
  }
  root.rendererSettingsSessionRuntime = factory(root.inventoryActionButton, root.inventoryTextField);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (defaultActionButton, defaultTextField) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t)
    || globalThis.jennyI18nFallback
    || function (key, fallback, params) {
      return params ? String(fallback).replace(/\{(\w+)\}/g, function (match, name) {
        return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match;
      }) : fallback;
    };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn)
    || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  const GENERAL_PROJECT_ID = 'project_general';
  const MORE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true" class="projects-row-more-icon"><circle cx="3.25" cy="8" r="1.25" /><circle cx="8" cy="8" r="1.25" /><circle cx="12.75" cy="8" r="1.25" /></svg>';

  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  // The Chats list's relative time ("5m", "3h", "Sep 3"): one age vocabulary.
  function resolveFormatSessionTime() {
    const panel = (typeof globalThis !== 'undefined' && globalThis.rendererChatsPanel)
      || (typeof require === 'function' ? require('./renderer-chats-panel') : null);
    return panel && typeof panel.formatSessionTime === 'function' ? panel.formatSessionTime : () => '';
  }

  // Accepts the backend row (root_path, authority_key, folder_exists,
  // is_current) and the switcher's normalized row (rootPath, folderMissing,
  // isCurrent), so either source repaints the same page.
  function normalizeProject(raw) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const id = String(source.id || '').trim();
    const name = String(source.name || '').trim();
    if (!id || !name) return null;
    const revision = Number(source.root_revision);
    const rawRoot = typeof source.root_path === 'string' ? source.root_path : (typeof source.rootPath === 'string' ? source.rootPath : '');
    const rootPath = rawRoot.trim() || null;
    let folderMissing = false;
    if (rootPath) {
      if (typeof source.folder_exists === 'boolean') folderMissing = !source.folder_exists;
      else if (typeof source.folderExists === 'boolean') folderMissing = !source.folderExists;
      else if (typeof source.folderMissing === 'boolean') folderMissing = source.folderMissing;
      else if (Object.prototype.hasOwnProperty.call(source, 'authority_key')) folderMissing = !String(source.authority_key || '').trim();
    }
    const isCurrent = typeof source.is_current === 'boolean' ? source.is_current
      : (typeof source.isCurrent === 'boolean' ? source.isCurrent : null);
    return {
      id,
      name,
      root_path: rootPath,
      root_revision: Number.isSafeInteger(revision) && revision >= 0 ? revision : 0,
      authority_key: String(source.authority_key || '').trim(),
      folder_missing: folderMissing,
      is_current: isCurrent,
    };
  }

  function normalizeProjectList(payload) {
    const source = Array.isArray(payload) ? payload : (Array.isArray(payload?.projects) ? payload.projects : []);
    return source.map(normalizeProject).filter(Boolean);
  }

  // Folder identity for "is this the Workspace folder" when main does not say
  // (no is_current): separators and case folded, trailing separators dropped.
  function folderKey(value) {
    return String(value || '').trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
  }

  function sessionProjectId(row) {
    return String(row?.project_id || '').trim() || GENERAL_PROJECT_ID;
  }

  function countSessionsByProject(sessions) {
    const counts = new Map();
    for (const row of Array.isArray(sessions) ? sessions : []) {
      if (!row || !row.id) continue;
      const projectId = sessionProjectId(row);
      counts.set(projectId, (counts.get(projectId) || 0) + 1);
    }
    return counts;
  }

  // Newest chat activity per project (ISO strings compare lexically).
  function lastUsedByProject(sessions) {
    const latest = new Map();
    for (const row of Array.isArray(sessions) ? sessions : []) {
      if (!row || !row.id) continue;
      const stamp = String(row.updated_at || row.created_at || '');
      if (!stamp) continue;
      const projectId = sessionProjectId(row);
      if (!latest.has(projectId) || stamp > latest.get(projectId)) latest.set(projectId, stamp);
    }
    return latest;
  }

  // Current Workspace project first, then most recently used, then by name;
  // General last.
  function sortProjects(projects, currentId, lastUsed) {
    const used = lastUsed instanceof Map ? lastUsed : new Map();
    return projects.slice().sort((left, right) => {
      if (left.id === currentId) return -1;
      if (right.id === currentId) return 1;
      if (left.id === GENERAL_PROJECT_ID) return 1;
      if (right.id === GENERAL_PROJECT_ID) return -1;
      const a = used.get(left.id) || '';
      const b = used.get(right.id) || '';
      if (a !== b) return a > b ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
  }

  function createSessionRuntimeSettingsController(options = {}) {
    const windowRef = options.windowRef || globalThis.window || globalThis;
    const documentRef = options.documentRef || windowRef?.document || globalThis.document;
    const state = options.state || {};
    const host = options.host || documentRef?.getElementById?.('sessionRuntimeSettingsMount') || null;
    const inventory = options.inventory || {};
    const actionButton = inventory.actionButton || defaultActionButton;
    const textField = inventory.textField || defaultTextField;
    const getProjectsApi = typeof options.getProjectsApi === 'function'
      ? options.getProjectsApi
      : () => windowRef?.jennyShell?.projects || null;
    const getMemoryApi = typeof options.getMemoryApi === 'function'
      ? options.getMemoryApi
      : () => windowRef?.jennyShell?.memory || null;
    const getProjectSwitcher = typeof options.getProjectSwitcher === 'function' ? options.getProjectSwitcher : null;
    const showError = typeof options.showError === 'function' ? options.showError : function noop() {};
    const chooseWorkspaceRoot = typeof options.chooseWorkspaceRoot === 'function' ? options.chooseWorkspaceRoot : null;
    const clearWorkspaceRoot = typeof options.clearWorkspaceRoot === 'function' ? options.clearWorkspaceRoot : null;
    const renderSessions = typeof options.renderSessions === 'function' ? options.renderSessions : function noop() {};
    const setActiveView = typeof options.setActiveView === 'function' ? options.setActiveView : null;
    const setSidebarCollapsed = typeof options.setSidebarCollapsed === 'function' ? options.setSidebarCollapsed : null;
    const formatTime = typeof options.formatTime === 'function' ? options.formatTime : resolveFormatSessionTime();
    let projects = [];
    let storage = { read_only: false, reason: '' };
    let editingId = '';
    let confirmingId = '';
    // Approved memories of the project whose delete is being confirmed (null
    // until the read lands, or when it cannot be read: the copy stays generic).
    let deleteMemoryCount = null;
    let memoryCountSeq = 0;
    let disposed = false;
    let bound = false;
    let requestGeneration = 0;
    let pending = false;
    // A rename/delete is running (from the click to its own re-read). An
    // announcement from another surface waits for it (refreshQueued /
    // applyQueued) instead of superseding its request, and waits for an open
    // rename field so the re-render never drops what the user typed.
    let mutating = false;
    let refreshQueued = false;
    let applyQueued = false;
    let status = '';
    let statusTone = 'default';
    let switcher = null;
    let switcherRequested = false;
    let unsubscribeSwitcher = null;
    // The control to focus after the next render: { projectId, action }.
    let focusIntent = null;
    // The last list a window event carried (the no-subscription path).
    let lastEventProjects = null;

    const button = (config) => (typeof actionButton === 'function' ? actionButton(config) : '');
    const field = (config) => (typeof textField === 'function' ? textField(config) : '');
    const smallGhost = (config) => button({ variant: 'ghost', size: 'sm', ...config });
    const can = (name) => Boolean(switcher && typeof switcher[name] === 'function');
    const rowMenu = () => (switcher && switcher.menu && typeof switcher.menu.show === 'function' ? switcher.menu : null);

    function workspaceRootPath() {
      return String(state.workspaceRoot?.path || '').trim();
    }

    function currentProjectId() {
      // Main's own answer (realpath-aware, D5) wins when the rows carry it.
      if (projects.some((project) => typeof project.is_current === 'boolean')) {
        return projects.find((project) => project.is_current === true)?.id || '';
      }
      const key = folderKey(workspaceRootPath());
      if (!key) return '';
      return projects.find((project) => project.root_path && folderKey(project.root_path) === key)?.id || '';
    }

    function displayName(project) {
      return project.id === GENERAL_PROJECT_ID ? jt('projects.switcher.generalName', 'General') : project.name;
    }

    function tag(text, tone = '') {
      return '<span class="projects-tag' + (tone ? ' projects-tag--' + tone : '') + '">' + escapeHtml(text) + '</span>';
    }

    // The one primary action a row offers, or null.
    function primaryAction(project, currentId) {
      if (project.folder_missing) {
        return can('locateProjectFolder') ? { id: 'projects-locate', label: jt('settings.projects.locateAction', 'Locate folder') } : null;
      }
      if (project.id === currentId || project.id === GENERAL_PROJECT_ID) {
        return { id: 'projects-show-chats', label: jt('settings.projects.showChatsAction', 'Show chats') };
      }
      return project.root_path && (can('openProjectAsWorkspace') || can('switchToProject'))
        ? { id: 'projects-open', label: jt('settings.projects.openAction', 'Open') }
        : null;
    }

    // The ⋯ command rows (project-menu command mode); General has none.
    function menuRows(project, currentId) {
      if (project.id === GENERAL_PROJECT_ID) return [];
      const groups = [
        [
          project.id !== currentId && project.root_path && !project.folder_missing && (can('openProjectAsWorkspace') || can('switchToProject'))
            ? { id: 'open', label: jt('settings.projects.menuOpen', 'Open as Workspace') } : null,
          can('newChatInProject') ? { id: 'new-chat', label: jt('settings.projects.menuNewChat', 'New chat here') } : null,
          { id: 'show-chats', label: jt('settings.projects.showChatsAction', 'Show chats') },
          project.root_path && !project.folder_missing && typeof getProjectsApi()?.revealFolder === 'function'
            ? { id: 'reveal', label: jt('settings.projects.menuReveal', 'Reveal folder') } : null,
        ],
        [
          can('locateProjectFolder') ? { id: 'change-folder', label: jt('settings.projects.menuChangeFolder', 'Change folder…') } : null,
          { id: 'rename', label: jt('settings.projects.renameAction', 'Rename') },
        ],
        [{ id: 'delete', label: jt('settings.projects.deleteAction', 'Delete…'), danger: true }],
      ];
      const rows = [];
      groups.forEach((group) => {
        group.filter(Boolean).forEach((row, index) => {
          rows.push({ ...row, kind: 'action', separatorBefore: index === 0 && rows.length > 0 });
        });
      });
      return rows;
    }

    function rowMarkup(project, currentId, counts, lastUsed, locked) {
      const count = counts.get(project.id) || 0;
      const general = project.id === GENERAL_PROJECT_ID;
      const current = project.id === currentId;
      const missing = project.folder_missing;
      const name = displayName(project);
      const chats = jtn('settings.projects.chatCount', count, { count }, '{count} chat', '{count} chats');
      const age = count ? formatTime(lastUsed.get(project.id) || '') : '';
      const meta = age ? jt('settings.projects.rowMeta', '{chats} · last used {age}', { chats, age }) : chats;
      const projectData = { 'project-id': project.id };
      let body;
      let actions = '';
      if (editingId === project.id) {
        body = '<div class="projects-row-rename">'
          + field({
            id: 'projectsRenameName',
            label: jt('settings.projects.nameLabel', 'Name'),
            ariaLabel: jt('settings.projects.nameLabel', 'Name'),
            value: project.name,
            maxLength: 80,
            disabled: locked,
          })
          + button({ id: 'projects-rename-save', label: jt('common.save', 'Save'), variant: 'primary', size: 'sm',
            ariaLabel: jt('common.save', 'Save'), disabled: locked, dataset: projectData })
          + smallGhost({ id: 'projects-rename-cancel', label: jt('common.cancel', 'Cancel'), ariaLabel: jt('common.cancel', 'Cancel'),
            dataset: projectData })
          + '</div>';
      } else {
        body = '<p class="projects-row-name">' + escapeHtml(name)
          + (current ? ' ' + tag(jt('settings.projects.tagCurrent', 'Current')) : '')
          + (general ? ' ' + tag(jt('settings.projects.tagNoFolder', 'No folder'), 'muted') : '')
          + (missing ? ' ' + tag(jt('settings.projects.tagMissing', 'Folder missing'), 'danger') : '')
          + '</p>'
          + (project.root_path ? '<p class="projects-row-folder" title="' + escapeHtml(project.root_path) + '">' + escapeHtml(project.root_path) + '</p>' : '')
          + '<p class="projects-row-meta">' + escapeHtml(meta) + '</p>';
        const primary = primaryAction(project, currentId);
        if (primary) {
          actions += button({ id: primary.id, label: primary.label, size: 'sm', disabled: locked,
            ariaLabel: jt('settings.projects.rowActionAriaLabel', '{action}: {name}', { action: primary.label, name }), dataset: { ...projectData, 'row-primary': 'true' } });
        }
        if (!general && rowMenu()) {
          const moreLabel = jt('settings.projects.moreAriaLabel', 'More actions for {name}', { name });
          actions += smallGhost({ id: 'projects-more', ariaLabel: moreLabel, title: moreLabel, ariaHaspopup: 'menu',
            ariaExpanded: false, disabled: locked, className: 'projects-row-more', trustedHtml: MORE_ICON, dataset: projectData });
        } else if (!general) {
          // No shared menu in this window: the commands stay inline.
          actions += smallGhost({ id: 'projects-rename', label: jt('settings.projects.renameAction', 'Rename'),
            ariaLabel: jt('settings.projects.renameAriaLabel', 'Rename {name}', { name }), disabled: locked, dataset: projectData })
            + smallGhost({ id: 'projects-delete', label: jt('settings.projects.deleteAction', 'Delete…'),
              ariaLabel: jt('settings.projects.deleteAriaLabel', 'Delete {name}', { name }), disabled: locked, dataset: projectData });
        }
      }
      let confirm = '';
      if (confirmingId === project.id) {
        const consequence = current
          ? jtn('settings.projects.deleteConfirmCurrentChats', count, { count },
            'It is your current project: the Workspace closes and new chats go to General until you pick another project. {count} chat moves to General. Files stay on your disk.',
            'It is your current project: the Workspace closes and new chats go to General until you pick another project. {count} chats move to General. Files stay on your disk.')
          : jtn('settings.projects.deleteConfirmChats', count, { count },
            '{count} chat moves to General. The folder and its files stay on your disk.',
            '{count} chats move to General. The folder and its files stay on your disk.');
        const memories = deleteMemoryCount === null
          ? jt('settings.projects.deleteConfirmMemories', 'Its memories and knowledge folders move to General.')
          : jtn('settings.projects.deleteConfirmMemoryCount', deleteMemoryCount, { count: deleteMemoryCount },
            "{count} memory and the project's knowledge folders move to General.",
            "{count} memories and the project's knowledge folders move to General.");
        confirm = '<div class="projects-confirm" role="group" aria-labelledby="projectsConfirmHeading">'
          + '<p id="projectsConfirmHeading"><strong>' + escapeHtml(jt('settings.projects.deleteConfirmTitle', 'Delete "{name}"?', { name })) + '</strong></p>'
          + '<p>' + escapeHtml(consequence) + ' ' + escapeHtml(memories) + '</p>'
          + '<div class="settings-actions">'
          + button({ id: 'projects-delete-confirm', label: jt('settings.projects.deleteConfirmAction', 'Delete project'), variant: 'danger', size: 'sm',
            ariaLabel: jt('settings.projects.deleteConfirmAction', 'Delete project'), disabled: locked, dataset: projectData })
          + smallGhost({ id: 'projects-delete-cancel', label: jt('common.cancel', 'Cancel'), ariaLabel: jt('common.cancel', 'Cancel'), dataset: projectData })
          + '</div></div>';
      }
      return '<li class="projects-row" data-project-id="' + escapeHtml(project.id) + '">'
        + '<div class="projects-row-main">' + body + '</div>'
        + '<div class="projects-row-actions">' + actions + '</div>'
        + confirm + '</li>';
    }

    // ---- Focus (D13) ---------------------------------------------------------

    function focusKey(element) {
      const action = String(element?.dataset?.action || '');
      if (element?.id === 'projectsRenameName') return { projectId: editingId, action: 'projects-rename-field' };
      return action ? { projectId: String(element.dataset.projectId || ''), action } : null;
    }

    function findControl(projectId, action) {
      if (!host) return null;
      return Array.from(host.querySelectorAll('[data-action]')).find((element) => element.dataset.action === action
        && String(element.dataset.projectId || '') === projectId) || null;
    }

    // Exact control first; a control that no longer exists hands focus to its
    // row's ⋯ (or inline command), then the row's primary, then the header.
    function resolveFocusTarget(intent) {
      const exact = findControl(intent.projectId, intent.action);
      if (exact) return exact;
      if (intent.projectId && projects.some((project) => project.id === intent.projectId)) {
        for (const action of ['projects-more', 'projects-rename', 'projects-delete', 'projects-show-chats', 'projects-open', 'projects-locate']) {
          const fallback = findControl(intent.projectId, action);
          if (fallback) return fallback;
        }
      }
      return findControl('', 'projects-new-folder');
    }

    function focusElement(element) {
      try { element.focus({ preventScroll: true }); } catch (_error) { element.focus?.(); }
    }

    function restoreFocus(hadFocus) {
      if (editingId) {
        const input = host.querySelector('#projectsRenameName');
        if (input && documentRef?.activeElement !== input) {
          focusElement(input);
          input.select?.();
        }
        focusIntent = null;
        return;
      }
      if (!focusIntent) return;
      const active = documentRef?.activeElement || null;
      const focusLost = hadFocus || !active || active === documentRef?.body || host.contains(active);
      if (!focusLost) { focusIntent = null; return; }
      const target = resolveFocusTarget(focusIntent);
      // A disabled target (a request in flight) keeps the intent for the render
      // that re-enables it.
      if (!target || target.disabled) return;
      focusElement(target);
      focusIntent = null;
    }

    function render() {
      if (disposed || !host) return;
      const active = documentRef?.activeElement || null;
      const hadFocus = Boolean(active && active !== host && host.contains?.(active));
      if (hadFocus && !focusIntent) focusIntent = focusKey(active);
      const locked = pending || storage.read_only === true;
      const currentId = currentProjectId();
      const counts = countSessionsByProject(state.sessions);
      const lastUsed = lastUsedByProject(state.sessions);
      const rows = sortProjects(projects, currentId, lastUsed);
      const onlyGeneral = rows.length > 0 && rows.every((project) => project.id === GENERAL_PROJECT_ID);
      const noRoot = !workspaceRootPath();
      const canCreate = can('newProjectFromFolder') || Boolean(chooseWorkspaceRoot);
      host.dataset.runtimeLoading = pending ? 'true' : 'false';
      let html = ''
        + '<div class="settings-card-header">'
        + '<h3 data-i18n="settings.sections.projects.title">' + escapeHtml(jt('settings.sections.projects.title', 'Projects')) + '</h3>'
        + button({ id: 'projects-new-folder', label: jt('settings.projects.newFromFolderAction', 'New project from folder'), variant: 'primary',
          ariaLabel: jt('settings.projects.newFromFolderAction', 'New project from folder'), disabled: locked || !canCreate })
        + '</div>'
        + '<p class="settings-copy">'
        + escapeHtml(jt('settings.projects.managerDescription', 'A project is a folder Jenny works in. Its chats, memories and file access stay with it.'))
        + '</p>'
        + '<div class="settings-group settings-group--wide settings-group--flush" role="group" aria-labelledby="projectsListHeading">'
        + '<h4 class="settings-group-heading" id="projectsListHeading">' + escapeHtml(jt('settings.projects.listHeading', 'Your projects')) + '</h4>';
      if (rows.length) {
        html += '<ul class="projects-list">' + rows.map((project) => rowMarkup(project, currentId, counts, lastUsed, locked)).join('') + '</ul>';
      } else if (!pending) {
        html += '<div class="settings-note">' + escapeHtml(jt('settings.runtime.unavailable', 'Project settings are unavailable in this window.')) + '</div>';
      }
      if (onlyGeneral && noRoot) {
        html += '<div class="settings-note" id="projectsEmptyHint">'
          + escapeHtml(jt('settings.projects.emptyHint', 'You have no Workspace folder yet. Choose one and Jenny creates its project for you.')) + '</div>';
      }
      html += '</div>';
      if (storage.read_only) {
        html += '<div class="settings-note" role="status">' + escapeHtml(jt('settings.projects.readOnly', 'Projects are read-only in this window.')) + '</div>';
      }
      html += '<div class="settings-note" id="runtimeActionStatus" role="status" aria-live="polite" data-tone="' + escapeHtml(statusTone) + '">' + escapeHtml(status) + '</div>';
      host.innerHTML = html;
      restoreFocus(hadFocus);
    }

    function setStatus(message, tone = 'default') {
      status = String(message || '');
      statusTone = tone;
      render();
    }

    // The backend's own sentence wins; the generic text is only for a missing API.
    function failureMessage(result, fallback) {
      return String(result?.error?.message || result?.message || result?.error?.reason || result?.reason || fallback);
    }

    function unavailableMessage() {
      return jt('settings.runtime.unavailable', 'Project settings are unavailable in this window.');
    }

    function reconcileOpenEditors() {
      if (editingId && !projects.some((project) => project.id === editingId)) editingId = '';
      if (confirmingId && !projects.some((project) => project.id === confirmingId)) confirmingId = '';
    }

    async function refresh() {
      const api = getProjectsApi();
      refreshQueued = false;
      applyQueued = false;
      const generation = ++requestGeneration;
      pending = true;
      render();
      if (!api || typeof api.list !== 'function') {
        if (!disposed && generation === requestGeneration) {
          pending = false;
          setStatus(unavailableMessage(), 'danger');
        }
        return [];
      }
      try {
        const result = await api.list();
        if (disposed || generation !== requestGeneration) return projects.slice();
        if (result?.ok === false) throw new Error(failureMessage(result, 'project_list_failed'));
        projects = normalizeProjectList(result);
        storage = result?.storage && typeof result.storage === 'object'
          ? { read_only: result.storage.read_only === true, reason: String(result.storage.reason || '') }
          : { read_only: false, reason: '' };
        reconcileOpenEditors();
        pending = false;
        render();
        return projects.slice();
      } catch (error) {
        if (!disposed && generation === requestGeneration) {
          pending = false;
          status = unavailableMessage();
          statusTone = 'danger';
          render();
          showError(error, status);
        }
        return projects.slice();
      }
    }

    // The switcher's cache is the one list; an empty cache (not read yet) is
    // never applied over a list this page already shows.
    function applyProjectList(list) {
      const next = normalizeProjectList(list);
      if (!next.length || disposed) return false;
      projects = next;
      reconcileOpenEditors();
      render();
      return true;
    }

    function switcherProjects(payload) {
      if (Array.isArray(payload)) return payload;
      if (Array.isArray(payload?.projects)) return payload.projects;
      if (Array.isArray(payload?.detail?.projects)) return payload.detail.projects;
      return can('getProjects') ? switcher.getProjects() : null;
    }

    // One mutation at a time; the result's own message is what the user reads.
    async function invoke(method, payload) {
      if (disposed || pending) return null;
      const api = getProjectsApi();
      if (!api || typeof api[method] !== 'function') {
        setStatus(unavailableMessage(), 'danger');
        return null;
      }
      const generation = ++requestGeneration;
      pending = true;
      render();
      try {
        const result = await api[method](payload);
        if (disposed || generation !== requestGeneration) return null;
        pending = false;
        if (!result || result.ok === false) {
          setStatus(failureMessage(result, unavailableMessage()), 'danger');
          return null;
        }
        return result;
      } catch (error) {
        if (!disposed && generation === requestGeneration) {
          pending = false;
          setStatus(unavailableMessage(), 'danger');
          showError(error, status);
        }
        return null;
      }
    }

    // Every other project surface (Explorer header, welcome page, composer
    // line, Chats filter) repaints from one shared list on this event.
    function announceProjectsChanged() {
      if (typeof windowRef?.dispatchEvent !== 'function' || typeof windowRef?.CustomEvent !== 'function') return;
      try { windowRef.dispatchEvent(new windowRef.CustomEvent('jenny:projects-changed', { detail: { source: 'settings' } })); } catch (_error) { /* best-effort */ }
    }

    // After this page's own rename/delete: the switcher re-reads once and
    // notifies every surface; without one, this page re-reads and announces.
    async function syncAfterMutation() {
      if (can('refreshProjects')) {
        try {
          const list = await switcher.refreshProjects({ force: true });
          if (disposed) return;
          if (applyProjectList(switcherProjects(list))) return;
        } catch (_error) { /* fall through to the page's own read */ }
      }
      await refresh();
      announceProjectsChanged();
    }

    // Projects change on other surfaces too: a folder pick provisions one, a
    // chat moves between projects, a folder is located. The switcher's
    // notification carries its list (no re-read); the window event without a
    // list (no switcher) re-reads. This page's own announcements are skipped.
    function handleProjectsChanged(event) {
      if (disposed || event?.detail?.source === 'settings') return;
      if (unsubscribeSwitcher) return; // the switcher subscription covers it
      const list = Array.isArray(event?.detail?.projects) ? event.detail.projects : null;
      if (list && list.length) applyQueued = true;
      else refreshQueued = true;
      flushQueuedRefresh();
    }

    function handleSwitcherProjects(payload) {
      if (disposed || payload?.source === 'settings' || payload?.detail?.source === 'settings') return;
      applyQueued = true;
      flushQueuedRefresh();
    }

    function flushQueuedRefresh() {
      if ((!refreshQueued && !applyQueued) || disposed || !bound || mutating || editingId) return;
      if (refreshQueued) { void refresh(); return; }
      applyQueued = false;
      if (!applyProjectList(switcherProjects(null) || lastEventProjects)) void refresh();
    }

    function rememberEventProjects(event) {
      if (Array.isArray(event?.detail?.projects)) lastEventProjects = event.detail.projects;
    }

    function connectSwitcher() {
      if (!getProjectSwitcher || switcherRequested || disposed) return;
      switcherRequested = true;
      Promise.resolve().then(() => getProjectSwitcher()).then((resolved) => {
        if (disposed || !resolved) return;
        switcher = resolved;
        if (typeof resolved.onProjectsChanged === 'function') {
          try {
            const off = resolved.onProjectsChanged(handleSwitcherProjects);
            unsubscribeSwitcher = typeof off === 'function' ? off : () => {};
          } catch (_error) { unsubscribeSwitcher = null; }
        }
        render();
      }).catch(() => {});
    }

    async function exclusively(operation) {
      mutating = true;
      try {
        await operation();
      } finally {
        mutating = false;
        flushQueuedRefresh();
      }
    }

    function rename(project, name) {
      return exclusively(async () => {
        const result = await invoke('rename', { project_id: project.id, name });
        if (!result) return;
        editingId = '';
        focusIntent = { projectId: project.id, action: 'projects-more' };
        status = jt('settings.projects.renamed', 'Renamed "{from}" to "{to}".', { from: project.name, to: result.project?.name || name });
        statusTone = 'success';
        await syncAfterMutation();
      });
    }

    function remove(project) {
      return exclusively(() => removeProject(project));
    }

    async function removeProject(project) {
      // The current project's delete starts with the cancelable Workspace
      // close (dirty buffers, running processes). A canceled or refused close
      // keeps the project: nothing is deleted or moved until the folder is shut.
      if (currentProjectId() === project.id && clearWorkspaceRoot) {
        let outcome;
        try { outcome = await clearWorkspaceRoot(); } catch (_error) { outcome = null; }
        if (disposed) return;
        if (!outcome || outcome.committed !== true) {
          confirmingId = '';
          focusIntent = { projectId: project.id, action: 'projects-more' };
          setStatus(jt('settings.projects.deleteKeptWorkspace', 'Nothing deleted: the Workspace stayed open.'), 'default');
          return;
        }
      }
      const result = await invoke('delete', { project_id: project.id });
      if (!result) return;
      confirmingId = '';
      focusIntent = { projectId: '', action: 'projects-new-folder' };
      const moved = Number(result.moved_sessions) || 0;
      // Chats moved to General: patch the rows the chat list and composer read.
      if (Array.isArray(state.sessions)) {
        for (const row of state.sessions) {
          if (row && String(row.project_id || '') === project.id) row.project_id = GENERAL_PROJECT_ID;
        }
        try { renderSessions(); } catch (_error) { /* the list repaints on its own cadence */ }
      }
      status = jtn('settings.projects.deleted', moved, { name: project.name, count: moved },
        'Deleted "{name}". {count} chat moved to General.', 'Deleted "{name}". {count} chats moved to General.');
      statusTone = 'success';
      await syncAfterMutation();
    }

    // ---- Switcher-backed actions --------------------------------------------

    // Show chats: the Chats filter set to this project (an explicit pick, so a
    // later Workspace switch leaves it alone, D8), then the Chats view.
    function showChats(project) {
      if (!state.ui || typeof state.ui !== 'object') state.ui = {};
      if (can('setChatsFilter')) switcher.setChatsFilter(project.id);
      else state.ui.chatsProjectFilter = project.id;
      try { renderSessions(); } catch (_error) { /* the list repaints on its own cadence */ }
      setActiveView?.('chat');
      setSidebarCollapsed?.(false);
    }

    // The switcher reports its own outcomes (toasts for a taken folder, a
    // missing folder, a canceled pick); the page repaints on its change event.
    function runSwitcher(method, project) {
      if (!can(method)) return;
      Promise.resolve().then(() => switcher[method](project.id)).catch((error) => {
        if (!disposed) showError(error, unavailableMessage());
      });
    }

    function openProject(project) {
      runSwitcher(can('openProjectAsWorkspace') ? 'openProjectAsWorkspace' : 'switchToProject', project);
    }

    function newProjectFromFolder() {
      const run = can('newProjectFromFolder') ? () => switcher.newProjectFromFolder() : chooseWorkspaceRoot;
      if (!run) return;
      Promise.resolve().then(run).catch((error) => { if (!disposed) showError(error, unavailableMessage()); });
    }

    function beginRename(project) {
      editingId = project.id;
      confirmingId = '';
      status = '';
      render();
    }

    function beginDelete(project) {
      confirmingId = project.id;
      editingId = '';
      status = '';
      focusIntent = { projectId: project.id, action: 'projects-delete-confirm' };
      readDeleteMemoryCount(project.id);
      render();
      flushQueuedRefresh();
    }

    // The confirm names how many memories move (N5). The approved list carries
    // each memory's project; a failed or missing read keeps the generic line.
    function readDeleteMemoryCount(projectId) {
      deleteMemoryCount = null;
      const seq = ++memoryCountSeq;
      const memoryApi = getMemoryApi();
      if (typeof memoryApi?.listApproved !== 'function') return;
      Promise.resolve().then(() => memoryApi.listApproved()).then((result) => {
        if (disposed || seq !== memoryCountSeq || confirmingId !== projectId || !Array.isArray(result?.memories)) return;
        deleteMemoryCount = result.memories.filter((memory) => String(memory?.project_id || '') === projectId).length;
        render();
      }).catch(() => { /* the generic memory line stays */ });
    }

    // New chat here opens the new chat, as New chat does everywhere else (N7).
    // Creation is asynchronous: the page navigates only if the user is still
    // on Settings > Projects when it lands (a later navigation wins).
    // The section's registry id stays `runtime` (renderer-settings-section-registry.js).
    function stillOnProjectsPage() {
      return state.ui?.activeView === 'settings' && state.ui?.activeSettingsSection === 'runtime';
    }

    function newChatHere(project) {
      if (!can('newChatInProject')) return;
      Promise.resolve().then(() => switcher.newChatInProject(project.id)).then((created) => {
        if (!disposed && created && stillOnProjectsPage()) setActiveView?.('chat');
      }).catch((error) => {
        if (!disposed) showError(error, unavailableMessage());
      });
    }

    // Main opens the project's own folder; the renderer sends only its id.
    async function revealFolder(project) {
      let result;
      try {
        result = await getProjectsApi()?.revealFolder?.({ project_id: project.id });
      } catch (error) {
        result = { ok: false, error: { message: error && error.message ? error.message : String(error) } };
      }
      if (!disposed && result && result.ok === false) {
        setStatus(result.error?.message || jt('settings.projects.revealFailed', 'The folder could not be opened.'), 'error');
      }
    }

    function runMenuAction(projectId, actionId) {
      const project = projects.find((entry) => entry.id === projectId);
      if (!project || disposed) return;
      if (actionId === 'open') openProject(project);
      else if (actionId === 'new-chat') newChatHere(project);
      else if (actionId === 'show-chats') showChats(project);
      else if (actionId === 'reveal') revealFolder(project);
      else if (actionId === 'change-folder') runSwitcher('locateProjectFolder', project);
      else if (actionId === 'rename') beginRename(project);
      else if (actionId === 'delete') beginDelete(project);
    }

    function openRowMenu(project, anchor) {
      const menu = rowMenu();
      if (!menu) return;
      const rows = menuRows(project, currentProjectId());
      if (!rows.length) return;
      const projectId = project.id;
      menu.show({
        anchor,
        ariaLabel: jt('settings.projects.moreAriaLabel', 'More actions for {name}', { name: displayName(project) }),
        rows,
        onPick: (row) => runMenuAction(projectId, row.id),
        // The menu returns focus to its anchor; a re-render meanwhile replaced
        // that button, so the fresh ⋯ of the same project takes it instead.
        onClose: () => {
          if (disposed || anchor?.isConnected !== false) return;
          const active = documentRef?.activeElement || null;
          if (active && active !== documentRef?.body && !host.contains(active)) return;
          const fresh = findControl(projectId, 'projects-more');
          if (fresh) focusElement(fresh);
        },
      });
    }

    function onClick(event) {
      const target = event?.target?.closest?.('[data-action]');
      if (!target || !host?.contains?.(target) || target.disabled) return;
      const action = String(target.dataset.action || '');
      const project = projects.find((entry) => entry.id === String(target.dataset.projectId || '')) || null;
      if (action === 'projects-new-folder') {
        newProjectFromFolder();
        return;
      }
      if (!project) return;
      if (action === 'projects-more') {
        openRowMenu(project, target);
      } else if (action === 'projects-open') {
        openProject(project);
      } else if (action === 'projects-show-chats') {
        showChats(project);
      } else if (action === 'projects-locate') {
        runSwitcher('locateProjectFolder', project);
      } else if (action === 'projects-rename') {
        beginRename(project);
      } else if (action === 'projects-rename-cancel') {
        editingId = '';
        focusIntent = { projectId: project.id, action: 'projects-more' };
        render();
        flushQueuedRefresh();
      } else if (action === 'projects-rename-save') {
        const name = String(host.querySelector('#projectsRenameName')?.value || '').trim();
        if (!name) return setStatus(jt('settings.runtime.nameRequired', 'Enter a project name first.'), 'warning');
        if (name === project.name) {
          editingId = '';
          focusIntent = { projectId: project.id, action: 'projects-more' };
          render();
          return flushQueuedRefresh();
        }
        void rename(project, name);
      } else if (action === 'projects-delete') {
        beginDelete(project);
      } else if (action === 'projects-delete-cancel') {
        confirmingId = '';
        focusIntent = { projectId: project.id, action: 'projects-more' };
        render();
      } else if (action === 'projects-delete-confirm') {
        void remove(project);
      }
    }

    function onKeydown(event) {
      if (!editingId || event?.target?.id !== 'projectsRenameName') return;
      if (event.key === 'Enter') {
        event.preventDefault();
        host.querySelector('[data-action="projects-rename-save"]')?.click();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        const projectId = editingId;
        editingId = '';
        focusIntent = { projectId, action: 'projects-more' };
        render();
        flushQueuedRefresh();
      }
    }

    function onWindowProjectsChanged(event) {
      rememberEventProjects(event);
      handleProjectsChanged(event);
    }

    function bind() {
      if (bound || disposed) return;
      bound = true;
      host?.addEventListener?.('click', onClick);
      host?.addEventListener?.('keydown', onKeydown);
      windowRef?.addEventListener?.('jenny:projects-changed', onWindowProjectsChanged);
      render();
      connectSwitcher();
      void refresh();
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      requestGeneration += 1;
      host?.removeEventListener?.('click', onClick);
      host?.removeEventListener?.('keydown', onKeydown);
      windowRef?.removeEventListener?.('jenny:projects-changed', onWindowProjectsChanged);
      try { unsubscribeSwitcher?.(); } catch (_error) { /* best-effort */ }
      unsubscribeSwitcher = null;
    }

    return {
      bind,
      dispose,
      refresh,
      render,
      getState: () => ({
        projects: projects.map((project) => ({ ...project })),
        currentProjectId: currentProjectId(),
        editingId,
        confirmingId,
        pending,
        disposed,
        switcherConnected: Boolean(switcher),
      }),
    };
  }

  return {
    GENERAL_PROJECT_ID,
    createSessionRuntimeSettingsController,
    normalizeProject,
    normalizeProjectList,
    countSessionsByProject,
    lastUsedByProject,
    sortProjects,
    folderKey,
  };
});
