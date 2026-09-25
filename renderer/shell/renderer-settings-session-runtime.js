/* renderer/shell/renderer-settings-session-runtime.js - Settings > Projects.
 *
 * Projects v2 (owner-approved po-review, 2026-09-20). A project is a folder
 * Jenny can work in; the Workspace folder IS the project. Switching and
 * creating happen in the Workspace, so this page is the tidy-up surface:
 * one row per project (name, folder, chat count, Current / No folder /
 * Folder missing tags), inline Rename, Delete with an inline confirm, an
 * empty state that hands off to the Workspace-folder chooser, and a status
 * line that repeats the backend's own reason on failure instead of a generic
 * "unavailable". The section id stays `runtime` for persisted deep links.
 *
 * Deleting the project the Workspace is bound to also closes the Workspace
 * (`clearWorkspaceRoot`, the same transaction the IDE's Clear runs), and the
 * moved chats are patched to General in `state.sessions` so the chat list and
 * composer follow without a reload.
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

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function normalizeProject(raw) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const id = String(source.id || '').trim();
    const name = String(source.name || '').trim();
    if (!id || !name) return null;
    const revision = Number(source.root_revision);
    return {
      id,
      name,
      root_path: typeof source.root_path === 'string' && source.root_path.trim() ? source.root_path.trim() : null,
      root_revision: Number.isSafeInteger(revision) && revision >= 0 ? revision : 0,
      authority_key: String(source.authority_key || '').trim(),
    };
  }

  function normalizeProjectList(payload) {
    const source = Array.isArray(payload?.projects) ? payload.projects : [];
    return source.map(normalizeProject).filter(Boolean);
  }

  // Folder identity for "is this the Workspace folder": separators and case
  // folded, trailing separators dropped. Both sides come from the same config
  // path normally; this only forgives cosmetic differences.
  function folderKey(value) {
    return String(value || '').trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
  }

  function countSessionsByProject(sessions) {
    const counts = new Map();
    for (const row of Array.isArray(sessions) ? sessions : []) {
      if (!row || !row.id) continue;
      const projectId = String(row.project_id || GENERAL_PROJECT_ID);
      counts.set(projectId, (counts.get(projectId) || 0) + 1);
    }
    return counts;
  }

  // Current Workspace project first, then by name, General last.
  function sortProjects(projects, currentId) {
    return projects.slice().sort((left, right) => {
      if (left.id === currentId) return -1;
      if (right.id === currentId) return 1;
      if (left.id === GENERAL_PROJECT_ID) return 1;
      if (right.id === GENERAL_PROJECT_ID) return -1;
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
    const showError = typeof options.showError === 'function' ? options.showError : function noop() {};
    const chooseWorkspaceRoot = typeof options.chooseWorkspaceRoot === 'function' ? options.chooseWorkspaceRoot : null;
    const clearWorkspaceRoot = typeof options.clearWorkspaceRoot === 'function' ? options.clearWorkspaceRoot : null;
    const renderSessions = typeof options.renderSessions === 'function' ? options.renderSessions : function noop() {};
    let projects = [];
    let storage = { read_only: false, reason: '' };
    let editingId = '';
    let confirmingId = '';
    let disposed = false;
    let bound = false;
    let requestGeneration = 0;
    let pending = false;
    // A rename/delete is running (from the click to its own re-read). An
    // announcement from another surface waits for it (refreshQueued) instead
    // of superseding its request, and waits for an open rename field so the
    // re-render never drops what the user typed.
    let mutating = false;
    let refreshQueued = false;
    let status = '';
    let statusTone = 'default';

    const button = (config) => (typeof actionButton === 'function' ? actionButton(config) : '');
    const field = (config) => (typeof textField === 'function' ? textField(config) : '');
    const smallGhost = (config) => button({ variant: 'ghost', size: 'sm', ...config });

    function workspaceRootPath() {
      return String(state.workspaceRoot?.path || '').trim();
    }

    function currentProjectId() {
      const key = folderKey(workspaceRootPath());
      if (!key) return '';
      return projects.find((project) => project.root_path && folderKey(project.root_path) === key)?.id || '';
    }

    function tag(text, tone = '') {
      return '<span class="projects-tag' + (tone ? ' projects-tag--' + tone : '') + '">' + escapeHtml(text) + '</span>';
    }

    function rowMarkup(project, currentId, counts, locked) {
      const count = counts.get(project.id) || 0;
      const general = project.id === GENERAL_PROJECT_ID;
      const current = project.id === currentId;
      const missing = Boolean(project.root_path) && !project.authority_key;
      const chats = jtn('settings.projects.chatCount', count, { count }, '{count} chat', '{count} chats');
      const meta = general
        ? jt('settings.projects.generalMeta', '{chats} · General never has a folder', { chats })
        : current
          ? jt('settings.projects.currentMeta', '{chats} · new chats start here', { chats })
          : missing
            ? jt('settings.projects.missingMeta', '{chats} · file tools are off until the folder is back', { chats })
            : chats;
      let body;
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
            ariaLabel: jt('common.save', 'Save'), disabled: locked, dataset: { 'project-id': project.id } })
          + smallGhost({ id: 'projects-rename-cancel', label: jt('common.cancel', 'Cancel'), ariaLabel: jt('common.cancel', 'Cancel'),
            dataset: { 'project-id': project.id } })
          + '</div>';
      } else {
        body = '<p class="projects-row-name">' + escapeHtml(project.name)
          + (current ? ' ' + tag(jt('settings.projects.tagCurrent', 'Current')) : '')
          + (general ? ' ' + tag(jt('settings.projects.tagNoFolder', 'No folder'), 'muted') : '')
          + (missing ? ' ' + tag(jt('settings.projects.tagMissing', 'Folder missing'), 'danger') : '')
          + '</p>'
          + (project.root_path ? '<p class="projects-row-folder" title="' + escapeHtml(project.root_path) + '">' + escapeHtml(project.root_path) + '</p>' : '')
          + '<p class="projects-row-meta">' + escapeHtml(meta) + '</p>';
      }
      const actions = general || editingId === project.id ? '' : ''
        + smallGhost({ id: 'projects-rename', label: jt('settings.projects.renameAction', 'Rename'),
          ariaLabel: jt('settings.projects.renameAriaLabel', 'Rename {name}', { name: project.name }), disabled: locked, dataset: { 'project-id': project.id } })
        + smallGhost({ id: 'projects-delete', label: jt('settings.projects.deleteAction', 'Delete…'),
          ariaLabel: jt('settings.projects.deleteAriaLabel', 'Delete {name}', { name: project.name }), disabled: locked, dataset: { 'project-id': project.id } });
      let confirm = '';
      if (confirmingId === project.id) {
        const consequence = current
          ? jt('settings.projects.deleteConfirmCurrent', 'It is your current project: the Workspace closes and new chats go to General until you pick another project. {chats} move to General. Files stay on your disk.', { chats })
          : jt('settings.projects.deleteConfirm', '{chats} move to General. The folder and its files stay on your disk.', { chats });
        confirm = '<div class="projects-confirm" role="group" aria-labelledby="projectsConfirmHeading">'
          + '<p id="projectsConfirmHeading"><strong>' + escapeHtml(jt('settings.projects.deleteConfirmTitle', 'Delete "{name}"?', { name: project.name })) + '</strong></p>'
          + '<p>' + escapeHtml(consequence) + '</p>'
          + '<div class="settings-actions">'
          + button({ id: 'projects-delete-confirm', label: jt('settings.projects.deleteConfirmAction', 'Delete project'), variant: 'danger', size: 'sm',
            ariaLabel: jt('settings.projects.deleteConfirmAction', 'Delete project'), disabled: locked, dataset: { 'project-id': project.id } })
          + smallGhost({ id: 'projects-delete-cancel', label: jt('common.cancel', 'Cancel'), ariaLabel: jt('common.cancel', 'Cancel'), dataset: { 'project-id': project.id } })
          + '</div></div>';
      }
      return '<li class="projects-row" data-project-id="' + escapeHtml(project.id) + '">'
        + '<div>' + body + '</div>'
        + '<div class="projects-row-actions">' + actions + '</div>'
        + confirm + '</li>';
    }

    function render() {
      if (disposed || !host) return;
      const locked = pending || storage.read_only === true;
      const currentId = currentProjectId();
      const counts = countSessionsByProject(state.sessions);
      const rows = sortProjects(projects, currentId);
      const onlyGeneral = rows.length > 0 && rows.every((project) => project.id === GENERAL_PROJECT_ID);
      const noRoot = !workspaceRootPath();
      host.dataset.runtimeLoading = pending ? 'true' : 'false';
      let html = ''
        + '<div class="settings-card-header">'
        + '<h3 data-i18n="settings.sections.projects.title">' + escapeHtml(jt('settings.sections.projects.title', 'Projects')) + '</h3>'
        + '<span class="settings-badge" data-i18n="settings.usage.localBadge">' + escapeHtml(jt('settings.usage.localBadge', 'Local')) + '</span></div>'
        + '<p class="settings-copy" data-i18n="settings.projects.description">'
        + escapeHtml(jt('settings.projects.description', 'A project is a folder Jenny can work in. Switch projects from the Workspace; here you can rename or delete them.'))
        + '</p>'
        + '<div class="settings-group settings-group--wide settings-group--flush" role="group" aria-labelledby="projectsListHeading">'
        + '<h4 class="settings-group-heading" id="projectsListHeading">' + escapeHtml(jt('settings.projects.listHeading', 'Your projects')) + '</h4>';
      if (rows.length) {
        html += '<ul class="projects-list">' + rows.map((project) => rowMarkup(project, currentId, counts, locked)).join('') + '</ul>';
      } else if (!pending) {
        html += '<div class="settings-note">' + escapeHtml(jt('settings.runtime.unavailable', 'Project settings are unavailable in this window.')) + '</div>';
      }
      if (onlyGeneral && noRoot) {
        html += '<div class="settings-note" id="projectsEmptyHint">'
          + escapeHtml(jt('settings.projects.emptyHint', 'You have no Workspace folder yet. Choose one and Jenny creates its project for you.')) + '</div>'
          + '<div class="settings-actions">' + button({
            id: 'projects-choose-folder', label: jt('settings.projects.chooseFolderAction', 'Choose Workspace folder…'), variant: 'primary',
            ariaLabel: jt('settings.projects.chooseFolderAction', 'Choose Workspace folder…'), disabled: locked || !chooseWorkspaceRoot,
          }) + '</div>';
      }
      html += '</div>';
      if (storage.read_only) {
        html += '<div class="settings-note" role="status">' + escapeHtml(jt('settings.projects.readOnly', 'Projects are read-only in this window.')) + '</div>';
      }
      html += '<div class="settings-note" id="runtimeActionStatus" role="status" aria-live="polite" data-tone="' + escapeHtml(statusTone) + '">' + escapeHtml(status) + '</div>';
      host.innerHTML = html;
      if (editingId) {
        const input = host.querySelector('#projectsRenameName');
        if (input && documentRef?.activeElement !== input) {
          input.focus({ preventScroll: true });
          input.select?.();
        }
      }
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

    async function refresh() {
      const api = getProjectsApi();
      refreshQueued = false;
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
        if (editingId && !projects.some((project) => project.id === editingId)) editingId = '';
        if (confirmingId && !projects.some((project) => project.id === confirmingId)) confirmingId = '';
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

    // Projects change on other surfaces too: a folder pick provisions one
    // (the switcher's post-commit sync announces it), a chat moves between
    // projects. This page's own announcements are skipped: its rename/delete
    // already re-read, and re-reading them would echo forever.
    function handleProjectsChanged(event) {
      if (disposed || event?.detail?.source === 'settings') return;
      refreshQueued = true;
      flushQueuedRefresh();
    }

    function flushQueuedRefresh() {
      if (!refreshQueued || disposed || !bound || mutating || editingId) return;
      void refresh();
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
        status = jt('settings.projects.renamed', 'Renamed "{from}" to "{to}".', { from: project.name, to: result.project?.name || name });
        statusTone = 'success';
        await refresh();
        announceProjectsChanged();
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
          setStatus(jt('settings.projects.deleteKeptWorkspace', 'Nothing deleted: the Workspace stayed open.'), 'default');
          return;
        }
      }
      const result = await invoke('delete', { project_id: project.id });
      if (!result) return;
      confirmingId = '';
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
      await refresh();
      announceProjectsChanged();
    }

    function onClick(event) {
      const target = event?.target?.closest?.('[data-action]');
      if (!target || !host?.contains?.(target) || target.disabled) return;
      const action = String(target.dataset.action || '');
      const project = projects.find((entry) => entry.id === String(target.dataset.projectId || '')) || null;
      if (action === 'projects-choose-folder') {
        if (chooseWorkspaceRoot) void chooseWorkspaceRoot();
        return;
      }
      if (!project) return;
      if (action === 'projects-rename') {
        editingId = project.id;
        confirmingId = '';
        status = '';
        render();
      } else if (action === 'projects-rename-cancel') {
        editingId = '';
        render();
        flushQueuedRefresh();
      } else if (action === 'projects-rename-save') {
        const name = String(host.querySelector('#projectsRenameName')?.value || '').trim();
        if (!name) return setStatus(jt('settings.runtime.nameRequired', 'Enter a project name first.'), 'warning');
        if (name === project.name) { editingId = ''; render(); return flushQueuedRefresh(); }
        void rename(project, name);
      } else if (action === 'projects-delete') {
        confirmingId = project.id;
        editingId = '';
        status = '';
        render();
        flushQueuedRefresh();
      } else if (action === 'projects-delete-cancel') {
        confirmingId = '';
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
        editingId = '';
        render();
        flushQueuedRefresh();
      }
    }

    function bind() {
      if (bound || disposed) return;
      bound = true;
      host?.addEventListener?.('click', onClick);
      host?.addEventListener?.('keydown', onKeydown);
      windowRef?.addEventListener?.('jenny:projects-changed', handleProjectsChanged);
      render();
      void refresh();
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      requestGeneration += 1;
      host?.removeEventListener?.('click', onClick);
      host?.removeEventListener?.('keydown', onKeydown);
      windowRef?.removeEventListener?.('jenny:projects-changed', handleProjectsChanged);
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
      }),
    };
  }

  return {
    GENERAL_PROJECT_ID,
    createSessionRuntimeSettingsController,
    normalizeProject,
    normalizeProjectList,
    countSessionsByProject,
    sortProjects,
    folderKey,
  };
});
