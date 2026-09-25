/* Hosted project and imported-permission review controller. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('../inventory/action-button'),
      require('../inventory/text-field'),
      require('../inventory/select-field'),
    );
    return;
  }
  root.jennyBrowserProjects = factory(
    root.inventoryActionButton,
    root.inventoryTextField,
    root.inventorySelectField,
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (
  actionButton,
  textField,
  selectField,
) {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t)
    || globalThis.jennyI18nFallback
    || function (_key, fallback, params) {
      return params ? String(fallback).replace(/\{(\w+)\}/g, function (match, name) {
        return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match;
      }) : fallback;
    };
  const escapeHtml = typeof actionButton?.escapeHtml === 'function'
    ? actionButton.escapeHtml
    : (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[character]));

  function text(value, fallback = '') { return typeof value === 'string' ? value : fallback; }
  function button(options) { return typeof actionButton === 'function' ? actionButton(options) : ''; }
  function field(options) { return typeof textField === 'function' ? textField(options) : ''; }
  function choice(options) { return typeof selectField === 'function' ? selectField(options) : ''; }
  function projectId(value) {
    const id = text(value);
    return /^project_[A-Za-z0-9_-]{1,128}$/u.test(id) ? id : '';
  }
  function reviewId(value) {
    const id = text(value);
    return /^[A-Za-z0-9_-]{1,128}$/u.test(id) ? id : '';
  }

  function projectRows(state) {
    const busy = state.projectsBusy === true || state.mutationPending === true;
    const editBlocked = busy || state.projectStorage?.read_only === true;
    const currentProjectId = text(state.snapshot?.session?.project_id)
      || text((state.sessions || []).find((item) => item.session_id === state.selectedSessionId)?.project_id);
    const canAssign = Boolean(
      state.selectedSessionId && state.control?.owned === true && !state.activeStreamId && !busy
    );
    return (state.projects || []).map((project) => {
      const id = projectId(project?.id);
      if (!id) return '';
      const name = text(project.name);
      const general = id === 'project_general';
      const current = id === currentProjectId;
      return `<article class="browser-project-row" data-project-id="${escapeHtml(id)}">
        <div class="browser-project-row-heading"><strong>${escapeHtml(name)}</strong>${current ? `<span>${escapeHtml(jt('browserProjects.current', 'Current project'))}</span>` : ''}</div>
        ${field({ id: `browser-project-name-${id}`, label: jt('browserProjects.renameProject', 'Rename project'), value: name, maxLength: 80, disabled: editBlocked })}
        <div class="browser-project-actions">${button({ id: 'project-save-name', label: jt('browserProjects.saveName', 'Save name'), variant: 'ghost', size: 'sm', disabled: editBlocked, dataset: { 'project-id': id } })}${button({ id: 'project-assign', label: jt('browserProjects.assign', 'Use for this conversation'), variant: current ? 'ghost' : 'secondary', size: 'sm', disabled: !canAssign || current, dataset: { 'project-id': id } })}</div>
        ${general
          ? `<p class="browser-project-note">${escapeHtml(jt('browserProjects.generalUnbound', 'General does not own a workspace root.'))}</p>`
          : `${field({ id: `browser-project-root-${id}`, label: jt('browserProjects.projectRoot', 'Workspace root'), value: text(project.root_path), placeholder: jt('browserProjects.rootPlaceholder', '/workspace/project'), hint: jt('browserProjects.rootHint', 'Use a path inside the host workspace mount. Leave empty to unbind.'), maxLength: 4096, disabled: editBlocked })}<div class="browser-project-actions">${button({ id: 'project-save-root', label: jt('browserProjects.saveRoot', 'Save root'), variant: 'ghost', size: 'sm', disabled: editBlocked, dataset: { 'project-id': id, 'root-revision': String(project.root_revision) } })}</div>`}
      </article>`;
    }).join('') || `<p class="browser-project-note">${escapeHtml(jt('browserProjects.noProjects', 'No projects found.'))}</p>`;
  }

  function reviewRows(state) {
    const reviewState = state.permissionReview || {};
    if (reviewState.read_only) {
      return `<p class="browser-project-error">${escapeHtml(jt('browserProjects.readOnly', 'Permission review is read-only: {value1}', { value1: text(reviewState.read_only_reason, 'unavailable') }))}</p>`;
    }
    const pending = Array.isArray(reviewState.pending) ? reviewState.pending : [];
    if (!pending.length) {
      return `<p class="browser-project-note">${escapeHtml(jt('browserProjects.noReviews', 'No imported permissions need review.'))}</p>`;
    }
    const grantProjects = (state.projects || []).filter((project) => (
      projectId(project?.id) && text(project.root_path) && /^authority_[a-f0-9]{64}$/u.test(project.authority_key || '')
    ));
    const busy = state.projectsBusy === true || state.mutationPending === true;
    const lastPage = Math.floor((pending.length - 1) / 50);
    const page = Math.min(
      Number.isSafeInteger(state.permissionReviewPage) && state.permissionReviewPage >= 0
        ? state.permissionReviewPage
        : 0,
      lastPage,
    );
    state.permissionReviewPage = page;
    const rows = pending.slice(page * 50, (page + 1) * 50).map((review) => {
      const id = reviewId(review?.id);
      if (!id) return '';
      const tool = text(review.tool_name, jt('browserProjects.unknownTool', 'Unknown tool'));
      const pathPrefix = text(review.path_prefix);
      const match = review.original_record?.match || {
        tool_id: tool, ...(pathPrefix ? { path_prefix: pathPrefix } : {}),
      };
      const scope = {
        match,
        ...(review.original_record?.restrictions !== undefined
          ? { restrictions: review.original_record.restrictions }
          : {}),
      };
      const projectLabel = jt('browserProjects.reviewProject', 'Project for this grant');
      const options = [
        { value: '', label: jt('settings.permissionReview.choose', 'Choose a project and folder') },
        ...grantProjects.map((project) => ({
          value: project.id, label: `${text(project.name)} · ${text(project.root_path)}`,
        })),
      ];
      return `<article class="browser-permission-review" data-review-id="${escapeHtml(id)}">
        <strong>${escapeHtml(jt('browserProjects.reviewTool', 'Tool: {value1}', { value1: tool }))}</strong>
        ${pathPrefix ? `<small>${escapeHtml(jt('browserProjects.reviewPath', 'Path: {value1}', { value1: pathPrefix }))}</small>` : ''}
        <small>${escapeHtml(JSON.stringify(scope))}</small>
        ${choice({ id: `browser-review-project-${id}`, label: projectLabel, tooltip: projectLabel, ariaLabel: projectLabel, value: '', options, disabled: busy || grantProjects.length === 0 })}
        <div class="browser-project-actions">${button({ id: 'permission-review-auto', label: jt('browserProjects.allowForProject', 'Allow for project'), title: jt('browserProjects.allowForProject', 'Allow for project'), ariaLabel: jt('browserProjects.allowForProject', 'Allow for project'), variant: 'primary', size: 'sm', disabled: busy || grantProjects.length === 0, dataset: { 'review-id': id } })}${button({ id: 'permission-review-ask', label: jt('browserProjects.askEachTime', 'Ask each time'), title: jt('browserProjects.askEachTime', 'Ask each time'), ariaLabel: jt('browserProjects.askEachTime', 'Ask each time'), variant: 'ghost', size: 'sm', disabled: busy, dataset: { 'review-id': id } })}${button({ id: 'permission-review-deny', label: jt('browserProjects.deny', 'Deny'), title: jt('browserProjects.deny', 'Deny'), ariaLabel: jt('browserProjects.deny', 'Deny'), variant: 'ghost', size: 'sm', disabled: busy, dataset: { 'review-id': id } })}${button({ id: 'permission-review-dismiss', label: jt('browserProjects.discard', 'Discard import'), title: jt('browserProjects.discard', 'Discard import'), ariaLabel: jt('browserProjects.discard', 'Discard import'), variant: 'danger', size: 'sm', disabled: busy, dataset: { 'review-id': id } })}</div>
      </article>`;
    }).join('');
    if (lastPage === 0) return rows;
    const previous = jt('settings.permissionReview.previous', 'Previous permissions');
    const next = jt('settings.permissionReview.next', 'Next permissions');
    return `${rows}<div class="browser-project-actions">${button({ id: 'permission-review-page', label: previous, title: previous, ariaLabel: previous, variant: 'secondary', size: 'sm', disabled: busy || page === 0, dataset: { direction: 'previous' } })}${button({ id: 'permission-review-page', label: next, title: next, ariaLabel: next, variant: 'secondary', size: 'sm', disabled: busy || page === lastPage, dataset: { direction: 'next' } })}</div>`;
  }

  class BrowserProjectsController {
    constructor(options = {}) {
      this.command = options.command || (async () => null);
      this.getState = options.getState || (() => ({}));
      this.getRoot = options.getRoot || (() => null);
      this.getGeneration = options.getGeneration || (() => 0);
      this.isDisposed = options.isDisposed || (() => false);
      this.renderApp = options.render || (() => {});
      this.setError = options.setError || (() => {});
      this.normalizeReason = options.normalizeReason || ((error) => text(error?.message));
    }

    _current(generation) { return !this.isDisposed() && generation === this.getGeneration(); }
    _input(id) { return this.getRoot()?.querySelector?.(`#${id}`) || null; }

    render() {
      const state = this.getState();
      const panel = this.getRoot()?.querySelector?.('[data-browser-projects]');
      const toggle = this.getRoot()?.querySelector?.('[data-action="projects-toggle"]');
      if (!panel) return;
      panel.hidden = state.projectsOpen !== true;
      toggle?.setAttribute?.('aria-expanded', state.projectsOpen === true ? 'true' : 'false');
      if (panel.hidden) return;
      panel.innerHTML = state.projectsBusy && !(state.projects || []).length
        ? `<p class="browser-project-note">${escapeHtml(jt('browserProjects.loading', 'Loading projects…'))}</p>`
        : `<div class="browser-project-panel-heading"><strong>${escapeHtml(jt('browserProjects.heading', 'Projects and permissions'))}</strong></div>
          ${state.projectsError ? `<p class="browser-project-error">${escapeHtml(state.projectsError)}</p>` : ''}
          ${state.projectStorage?.read_only ? `<p class="browser-project-error">${escapeHtml(jt('browserProjects.projectStorageReadOnly', 'Project storage is read-only: {value1}', { value1: text(state.projectStorage.reason, 'unavailable') }))}</p>` : ''}
          <section class="browser-project-create"><h2>${escapeHtml(jt('browserProjects.createProject', 'Create project'))}</h2>${field({ id: 'browser-project-create-name', label: jt('browserProjects.projectName', 'Project name'), maxLength: 80, disabled: state.projectsBusy === true || state.mutationPending === true || state.projectStorage?.read_only === true })}${button({ id: 'project-create', label: jt('browserProjects.create', 'Create'), variant: 'secondary', size: 'sm', disabled: state.projectsBusy === true || state.mutationPending === true || state.projectStorage?.read_only === true })}</section>
          <section class="browser-project-list">${projectRows(state)}</section>
          <section class="browser-permission-list"><h2>${escapeHtml(jt('browserProjects.permissionsHeading', 'Imported permission review'))}</h2>${reviewRows(state)}</section>`;
    }

    async toggle() {
      const state = this.getState();
      state.projectsOpen = !state.projectsOpen;
      if (state.projectsOpen) state.authSessionsOpen = false;
      this.renderApp();
      if (state.projectsOpen) await this.load();
    }

    async load({ quiet = false } = {}) {
      const state = this.getState();
      if (state.projectsBusy || this.isDisposed()) return;
      const generation = this.getGeneration();
      state.projectsBusy = true;
      state.projectsError = '';
      this.renderApp();
      const [projects, reviews] = await Promise.all([
        this.command('projects.list', { params: {} }, { quiet: true }),
        this.command('permissionReview.getState', { params: {} }, { quiet: true }),
      ]);
      if (!this._current(generation)) return;
      state.projectsBusy = false;
      if (projects?.ok && reviews?.ok) {
        state.projects = Array.isArray(projects.projects) ? projects.projects : [];
        state.projectStorage = projects.storage || null;
        state.permissionReview = reviews;
      } else if (!quiet) {
        const failure = projects?.ok === false ? projects : reviews;
        state.projectsError = this.normalizeReason({ payload: failure });
      }
      this.renderApp();
    }

    async _mutate(operation, params, options = {}) {
      const state = this.getState();
      if (state.projectsBusy || state.mutationPending || this.isDisposed()) return null;
      const generation = this.getGeneration();
      state.projectsBusy = true;
      this.renderApp();
      const result = await this.command(operation, { ...options, params });
      if (!this._current(generation)) return null;
      state.projectsBusy = false;
      if (result?.ok) await this.load({ quiet: true });
      else this.renderApp();
      return result;
    }

    async handleAction(action, id) {
      const state = this.getState();
      if (id === 'projects-toggle') { await this.toggle(); return true; }
      if (!id.startsWith('project-') && !id.startsWith('permission-review-')) return false;
      if (id === 'project-create') {
        const name = text(this._input('browser-project-create-name')?.value).trim();
        if (name) await this._mutate('projects.create', { name });
        return true;
      }
      const idFromAction = projectId(action?.dataset?.projectId);
      if (id === 'project-save-name' && idFromAction) {
        const name = text(this._input(`browser-project-name-${idFromAction}`)?.value).trim();
        if (name) await this._mutate('projects.rename', { project_id: idFromAction, name });
        return true;
      }
      if (id === 'project-save-root' && idFromAction) {
        const revision = Number(action.dataset.rootRevision);
        const rootPath = text(this._input(`browser-project-root-${idFromAction}`)?.value).trim();
        if (Number.isSafeInteger(revision) && revision >= 0) await this._mutate('projects.bindRoot', {
          project_id: idFromAction, root_path: rootPath || null, expected_root_revision: revision,
        });
        return true;
      }
      if (id === 'project-assign' && idFromAction && state.selectedSessionId && state.control?.owned) {
        const targetSessionId = state.selectedSessionId;
        const result = await this._mutate('projects.assignSession', { project_id: idFromAction }, {
          sessionId: targetSessionId,
          controlGeneration: state.control.generation,
          expectedRevision: text(state.snapshot?.session?.revision),
        });
        if (result?.ok) {
          state.sessions = (state.sessions || []).map((session) => session.session_id === targetSessionId
            ? { ...session, ...result.session }
            : session);
          if (state.selectedSessionId === targetSessionId
            && state.snapshot?.session?.session_id === targetSessionId) {
            state.snapshot.session.project_id = idFromAction;
            this.renderApp();
          }
        }
        return true;
      }
      if (id === 'permission-review-page') {
        state.permissionReviewPage = Math.max(0, (state.permissionReviewPage || 0)
          + (action?.dataset?.direction === 'next' ? 1 : -1));
        this.renderApp();
        return true;
      }
      const pendingId = reviewId(action?.dataset?.reviewId);
      if (!pendingId) return true;
      let decision = '';
      if (id === 'permission-review-auto') decision = 'auto';
      else if (id === 'permission-review-ask') decision = 'ask';
      else if (id === 'permission-review-deny') decision = 'deny';
      else if (id === 'permission-review-dismiss') decision = 'dismiss';
      if (!decision) return true;
      const params = { review_id: pendingId, decision };
      if (decision === 'auto') {
        const selectedId = projectId(this._input(`browser-review-project-${pendingId}`)?.value);
        const project = (state.projects || []).find((item) => item.id === selectedId);
        if (!project || !Number.isSafeInteger(project.root_revision)
          || !/^authority_[a-f0-9]{64}$/u.test(project.authority_key || '')) return true;
        Object.assign(params, {
          project_id: selectedId,
          expected_root_revision: project.root_revision,
          expected_authority_key: project.authority_key,
        });
      }
      await this._mutate('permissionReview.resolve', params);
      return true;
    }
  }

  function createProjectState() {
    return {
      projects: [], projectsOpen: false, projectsBusy: false, projectsError: '',
      projectStorage: null, permissionReview: null, permissionReviewPage: 0,
    };
  }

  function attachBrowserProjects(app, normalizeReason) {
    return new BrowserProjectsController({
      command: (operation, options, commandOptions) => app._command(
        operation, options, commandOptions
      ),
      getState: () => app.state,
      getRoot: () => app.root,
      getGeneration: () => app.authGeneration,
      isDisposed: () => app.disposed,
      render: () => app.render(),
      setError: (message) => app._setError(message),
      normalizeReason,
    });
  }

  return {
    BrowserProjectsController,
    attachBrowserProjects,
    createProjectState,
    projectRows,
    reviewRows,
  };
});
