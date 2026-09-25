/* renderer/shell/renderer-settings-core-renderers.js - Core Settings render helpers. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSettingsCoreRenderers = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  function renderSetupSettingsRow(options) {
    const setupSnapshot = options?.setupSnapshot || {};
    const setupSettingsSummary = options?.setupSettingsSummary || null;
    const setupSettingsActions = options?.setupSettingsActions || null;
    const sceneUtils = options?.sceneUtils || ((typeof globalThis !== 'undefined' && globalThis.rendererSetupSceneUtils) || null);
    const actionButton = options?.actionButton || ((typeof globalThis !== 'undefined' && globalThis.inventoryActionButton) || null);
    // UIUX-005: "Setup complete" is derived from step truth (workspaceRoot +
    // a model path actually done), never from the raw setupComplete boolean
    // -- a skip-through wizard run (or an old buggy-path persisted snapshot)
    // must render honest "N of M ... Resume setup" copy instead.
    const health = sceneUtils?.computeSetupHealth?.(setupSnapshot) || { state: 'pending' };
    const isComplete = health.state === 'complete';

    if (setupSettingsSummary) {
      if (!setupSnapshot.loaded) {
        setupSettingsSummary.textContent = jt('settings.shell.setupLoading', 'Loading setup status...');
      } else if (isComplete) {
        setupSettingsSummary.textContent = jt('settings.shell.setupComplete', 'Setup complete. Run again to revisit any step - your progress is preserved.');
      } else {
        const total = sceneUtils?.STEP_ORDER?.length || 5;
        const done = sceneUtils?.countCompletedSteps?.(setupSnapshot.steps || {}) || 0;
        setupSettingsSummary.textContent = jt('settings.shell.setupProgress', '{done} of {total} setup steps complete. Resume setup to finish.', { done, total });
      }
    }
    if (!setupSettingsActions) {
      return;
    }
    const nextLabel = isComplete ? jt('settings.shell.runSetupAgain', 'Run setup again') : jt('settings.shell.resumeSetup', 'Resume setup');
    const nextSignature = [
      nextLabel,
      setupSnapshot.loaded ? 'loaded' : 'loading',
    ].join('|');
    const lastSignature = setupSettingsActions.dataset.setupSignature || '';
    if (!actionButton) {
      setupSettingsActions.innerHTML = '';
      return;
    }
    if (nextSignature === lastSignature && setupSettingsActions.firstElementChild) {
      return;
    }
    // The overflow <details> must sit BELOW the button row, not inside the
    // flex row - an open <details> stacked inside .settings-actions centers
    // its grown box against the sibling buttons and looks broken.
    setupSettingsActions.innerHTML = [
      '<div class="settings-actions">',
      actionButton({
        id: 'runSetupAgain',
        label: nextLabel,
        variant: 'secondary',
        disabled: !setupSnapshot.loaded,
      }),
      actionButton({
        id: 'settingsOpenSetupHelp',
        label: isComplete ? jt('settings.shell.setupHelp', 'Setup help') : jt('settings.shell.helpWithSetup', 'Help with setup'),
        variant: 'secondary',
      }),
      '</div>',
      '<details class="settings-overflow"><summary>More</summary>'
        + '<div class="settings-actions">'
        + actionButton({
          id: 'settingsOpenFactoryReset',
          label: jt('settings.shell.resetOnboarding', 'Reset onboarding'),
          variant: 'danger',
          disabled: !setupSnapshot.loaded,
        })
        + '</div></details>',
    ].join('');
    setupSettingsActions.dataset.setupSignature = nextSignature;
  }

  // --- Settings > Tools > Approval rules -------------------------------------
  // The user's saved approval decisions: per-tool policies ("Always allow" on a
  // call without a path target, or a per-tool deny) and path-scoped auto rules
  // ("Always allow" on a path-bearing call). Removing a row makes Jenny ask
  // again next time. Rows come from tools.getPermissions on demand rather than
  // renderer state, cached briefly so a Settings repaint is not an IPC round
  // trip; a removal forces a refetch.
  const APPROVAL_RULES_CACHE_MS = 5000;
  const APPROVAL_RULE_REMOVE_ACTION = 'tools-approval-rule-remove';
  const APPROVAL_DECISION_LABELS = Object.freeze({ auto: jt('settings.shell.approvalDecisionAlways', 'Always allow'), ask: jt('settings.shell.approvalDecisionAsk', 'Ask before'), deny: jt('settings.shell.approvalDecisionNever', 'Never allow') });
  const approvalRulesCache = { fetchedAt: 0, saved: null, inFlight: null, version: 0,
    projects: [], reviewExpanded: false, reviewPage: 0 };
  const pendingReviewContainers = new WeakSet();

  function defaultEscapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function buildApprovalRuleRows(saved) {
    const source = saved && typeof saved === 'object' ? saved : {};
    const policies = source.policies && typeof source.policies === 'object' ? source.policies : {};
    const rows = Object.entries(policies).map(([toolName, decision]) => ({
      kind: 'tool',
      key: toolName,
      decision,
      label: `${APPROVAL_DECISION_LABELS[decision] || decision}: ${toolName}`,
      detail: jt('settings.shell.approvalRulesEveryCall', 'every call'),
    }));
    for (const rule of Array.isArray(source.rules) ? source.rules : []) {
      if (!rule || typeof rule !== 'object' || !rule.id) continue;
      const match = rule.match && typeof rule.match === 'object' ? rule.match : {};
      rows.push({
        kind: 'rule',
        key: String(rule.id),
        decision: rule.decision,
        label: `${APPROVAL_DECISION_LABELS[rule.decision] || rule.decision}: ${match.tool_id || jt('settings.tools.approvalRules.anyTool', 'any tool')}`,
        detail: match.path_prefix ? jt('settings.shell.approvalRuleForPath', 'for {path}', { path: match.path_prefix }) : (match.action ? jt('settings.shell.approvalRuleForAction', 'action {action}', { action: match.action }) : jt('settings.shell.approvalRulesEveryCall', 'every call')),
      });
    }
    for (const grant of Array.isArray(source.scoped_grants) ? source.scoped_grants : []) {
      if (!grant?.id || !grant.authority) continue;
      rows.push({ kind: 'rule', key: String(grant.id), decision: 'auto',
        label: `${APPROVAL_DECISION_LABELS.auto}: ${grant.tool_name}`,
        detail: [grant.authority.project_id, grant.authority.root_path,
          JSON.stringify(grant.match || {})].filter(Boolean).join(' · ') });
    }
    return rows;
  }

  function resolveActionButton(options) {
    if (typeof options?.actionButton === 'function') return options.actionButton;
    if (typeof globalThis === 'undefined') return null;
    const fromBarrel = globalThis.inventory && globalThis.inventory.actionButton;
    const candidate = fromBarrel || globalThis.inventoryActionButton;
    return typeof candidate === 'function' ? candidate : null;
  }

  function renderApprovalRuleRows(container, rows, escapeHtml, actionButton) {
    if (!rows.length) {
      container.innerHTML = '<div class="settings-note tools-approval-rules-empty">' + escapeHtml(jt('settings.shell.approvalRulesEmpty', 'No saved approval rules yet. Choose "Always allow" on an approval card and it shows up here.')) + '</div>';
      return;
    }
    container.innerHTML = rows.map((row) => {
      const remove = actionButton
        ? actionButton({
          id: APPROVAL_RULE_REMOVE_ACTION,
          label: jt('common.remove', 'Remove'),
          variant: 'secondary',
          size: 'sm',
          ariaLabel: jt('settings.shell.removeApprovalRuleAria', 'Remove rule: {label} {detail}', { label: row.label, detail: row.detail }),
          title: jt('settings.shell.removeApprovalRule', 'Remove this approval rule'),
          dataset: { 'rule-kind': row.kind, 'rule-key': row.key },
        })
        : '';
      return `<div class="tools-approval-rule" data-rule-kind="${escapeHtml(row.kind)}" data-decision="${escapeHtml(row.decision)}">`
        + '<div class="tools-approval-rule-text">'
        + `<span class="tools-approval-rule-label">${escapeHtml(row.label)}</span>`
        + `<span class="tools-approval-rule-detail">${escapeHtml(row.detail)}</span>`
        + `</div>${remove}</div>`;
    }).join('');
  }

  function renderApprovalRules(options) {
    const container = options?.container;
    if (!container) return null;
    const api = options?.api;
    const escapeHtml = typeof options?.escapeHtml === 'function' ? options.escapeHtml : defaultEscapeHtml;
    const actionButton = resolveActionButton(options);
    if (!api || typeof api.getPermissions !== 'function') {
      container.innerHTML = '<div class="settings-note">' + escapeHtml(jt('settings.shell.approvalRulesUnavailable', 'Approval rules are unavailable in this window.')) + '</div>';
      return null;
    }
    const paint = () => {
      renderApprovalRuleRows(container, buildApprovalRuleRows(approvalRulesCache.saved), escapeHtml, actionButton);
      renderPermissionReview(container, options, escapeHtml, actionButton);
    };
    const stale = !approvalRulesCache.saved
      || Date.now() - approvalRulesCache.fetchedAt >= APPROVAL_RULES_CACHE_MS;
    if (approvalRulesCache.saved) paint();
    else container.innerHTML = '<div class="settings-note">' + escapeHtml(jt('settings.shell.approvalRulesLoading', 'Loading approval rules...')) + '</div>';
    if ((!stale || approvalRulesCache.inFlight) && options?.force !== true) return approvalRulesCache.inFlight;
    const version = ++approvalRulesCache.version;
    approvalRulesCache.inFlight = Promise.resolve()
      .then(() => Promise.all([api.getPermissions(),
        Promise.resolve().then(() => options.projectsApi?.list?.() || null).catch(() => null)]))
      .then(([payload, projects]) => {
        if (version !== approvalRulesCache.version) return;
        const saved = payload && typeof payload === 'object' ? payload.saved : null;
        approvalRulesCache.saved = saved && typeof saved === 'object' ? saved : { policies: {}, rules: [] };
        approvalRulesCache.projects = Array.isArray(projects?.projects) ? projects.projects : [];
        approvalRulesCache.fetchedAt = Date.now();
        paint();
      })
      .catch(() => {
        if (version !== approvalRulesCache.version) return;
        container.innerHTML = '<div class="settings-note">' + escapeHtml(jt('settings.shell.approvalRulesLoadFailed', 'Approval rules could not be loaded.')) + '</div>';
      })
      .finally(() => {
        if (version === approvalRulesCache.version) approvalRulesCache.inFlight = null;
      });
    return approvalRulesCache.inFlight;
  }

  // Tests reset the module-level cache between cases.
  function resetApprovalRulesCache() {
    approvalRulesCache.saved = null;
    approvalRulesCache.fetchedAt = 0;
    approvalRulesCache.inFlight = null;
    approvalRulesCache.version += 1;
    approvalRulesCache.projects = [];
    approvalRulesCache.reviewExpanded = false;
    approvalRulesCache.reviewPage = 0;
  }

  function renderPermissionReview(container, options, escapeHtml, actionButton) {
    const pending = approvalRulesCache.saved?.pending_review;
    if (!Array.isArray(pending) || !pending.length || !actionButton) return;
    const notice = jt('settings.permissionReview.notice', 'Saved automatic permissions need review before they can apply to a project.');
    const reviewLabel = jt('settings.permissionReview.open', 'Review permissions');
    const selectField = options.selectField || globalThis.inventorySelectField;
    const canReview = !approvalRulesCache.saved?.read_only_reason
      && typeof options.permissionReviewApi?.resolve === 'function';
    let markup = `<div class="settings-note" data-permission-review-notice>${escapeHtml(notice)}</div>`
      + actionButton({ id: 'permission-review-open', label: reviewLabel, title: reviewLabel,
        ariaLabel: reviewLabel, disabled: !canReview, variant: 'secondary' });
    if (approvalRulesCache.reviewExpanded && canReview) {
      const projectLabel = jt('settings.permissionReview.project', 'Project and folder');
      const chooseLabel = jt('settings.permissionReview.choose', 'Choose a project and folder');
      markup += `<div data-permission-review-panel><div class="settings-note">${escapeHtml(
        jt('settings.permissionReview.count', 'Permissions awaiting review: {count}', { count: pending.length })
      )}</div>`;
      if (selectField) markup += selectField({ id: 'permission-review-project', label: projectLabel,
        tooltip: projectLabel, ariaLabel: projectLabel, value: '', options: [
          { value: '', label: chooseLabel },
          ...approvalRulesCache.projects.filter(project => project.root_path && project.authority_key)
            .map(project => ({ value: project.id, label: `${project.name} · ${project.root_path}` })),
        ] });
      const lastPage = Math.floor((pending.length - 1) / 50);
      const page = Math.min(approvalRulesCache.reviewPage, lastPage);
      approvalRulesCache.reviewPage = page;
      for (const record of pending.slice(page * 50, (page + 1) * 50)) {
        const match = record.original_record?.match || { tool_id: record.tool_name,
          ...(record.path_prefix ? { path_prefix: record.path_prefix } : {}) };
        markup += `<div class="tools-approval-rule"><div class="tools-approval-rule-text">`
          + `<span class="tools-approval-rule-label">${escapeHtml(record.tool_name)}</span>`
          + `<span class="tools-approval-rule-detail">${escapeHtml(JSON.stringify(match))}</span></div>`;
        for (const decision of ['auto', 'ask', 'deny', 'dismiss']) {
          const label = decision === 'auto'
            ? jt('settings.permissionReview.allow', 'Always allow for this project')
            : decision === 'dismiss'
              ? jt('settings.permissionReview.discard', 'Discard this saved grant')
              : APPROVAL_DECISION_LABELS[decision];
          markup += actionButton({ id: 'permission-review-decide', label, title: label, ariaLabel: label,
            variant: 'secondary', size: 'sm', disabled: decision === 'auto',
            dataset: { 'review-id': record.id, decision } });
        }
        markup += '</div>';
      }
      if (lastPage > 0) {
        for (const [direction, label, disabled] of [
          ['previous', jt('settings.permissionReview.previous', 'Previous permissions'), page === 0],
          ['next', jt('settings.permissionReview.next', 'Next permissions'), page === lastPage],
        ]) markup += actionButton({ id: 'permission-review-page', label, title: label,
          ariaLabel: label, disabled, variant: 'secondary', dataset: { direction } });
      }
      markup += '</div>';
    }
    container.insertAdjacentHTML('afterbegin', markup);
  }

  function bindPermissionReview(options) {
    const { container, registerListener } = options;
    registerListener(container, 'change', event => {
      if (pendingReviewContainers.has(container)) return;
      if (event.target?.id !== 'permission-review-project') return;
      const selected = approvalRulesCache.projects.find(project => project.id === event.target.value);
      for (const button of container.querySelectorAll('[data-review-id][data-decision="auto"]')) {
        button.disabled = !selected?.root_path || !selected?.authority_key;
      }
    }, options.listenerOptions);
    registerListener(container, 'click', event => {
      const button = event.target?.closest?.('[data-action="permission-review-open"], [data-action="permission-review-decide"], [data-action="permission-review-page"]');
      if (!button || !container.contains(button) || button.disabled || pendingReviewContainers.has(container)) return;
      if (button.dataset.action === 'permission-review-open') {
        approvalRulesCache.reviewExpanded = true;
        renderApprovalRules(options)?.then?.(() => container.querySelector('#permission-review-project')?.focus());
        return;
      }
      if (button.dataset.action === 'permission-review-page') {
        approvalRulesCache.reviewPage = Math.max(0, approvalRulesCache.reviewPage
          + (button.dataset.direction === 'next' ? 1 : -1));
        renderApprovalRules(options)?.then?.(() => container.querySelector('#permission-review-project')?.focus());
        return;
      }
      const decision = button.dataset.decision;
      const projectId = container.querySelector('#permission-review-project')?.value;
      const project = approvalRulesCache.projects.find(entry => entry.id === projectId);
      if (decision === 'auto' && (!project?.root_path || !project?.authority_key)) return;
      const request = { review_id: button.dataset.reviewId, decision,
        ...(decision === 'auto' ? { project_id: project.id, expected_root_revision: project.root_revision,
          expected_authority_key: project.authority_key } : {}) };
      const version = approvalRulesCache.version;
      pendingReviewContainers.add(container);
      for (const control of container.querySelectorAll('[data-review-id]')) control.disabled = true;
      Promise.resolve().then(() => options.permissionReviewApi.resolve(request)).then(result => {
        if (result?.ok === false) {
          const error = new Error(result.error?.message || jt('settings.permissionReview.failed', 'Permission review failed'));
          Object.assign(error, result.error || {});
          throw error;
        }
      })
        .then(() => { pendingReviewContainers.delete(container); return renderApprovalRules({ ...options, force: true }); })
        .catch(error => {
          pendingReviewContainers.delete(container);
          if (version === approvalRulesCache.version) renderApprovalRules({ ...options, force: true });
          options.onError?.(error, jt('settings.permissionReview.failed', 'Permission review failed'));
        });
    }, options.listenerOptions);
  }

  function bindApprovalRules(options) {
    const container = options?.container;
    const registerListener = options?.registerListener;
    const api = options?.api;
    if (!container || typeof registerListener !== 'function') return;
    bindPermissionReview(options);
    registerListener(container, 'click', (event) => {
      const target = event?.target;
      const button = target && typeof target.closest === 'function'
        ? target.closest(`[data-action="${APPROVAL_RULE_REMOVE_ACTION}"]`)
        : null;
      if (!button || !container.contains(button)) return;
      const key = button.dataset.ruleKey;
      const method = button.dataset.ruleKind === 'rule' ? 'removePermissionRule' : 'clearPermission';
      button.disabled = true;
      Promise.resolve()
        .then(() => {
          if (!api || typeof api[method] !== 'function') throw new Error('Approval rules are unavailable in this window.');
          return api[method](key);
        })
        .then(() => renderApprovalRules({
          ...options, container, api, force: true,
        }))
        .catch((error) => {
          button.disabled = false;
          if (typeof options?.onError === 'function') options.onError(error, jt('settings.shell.approvalRuleRemovalFailed', 'Approval Rule Removal Failed'));
        });
    }, options?.listenerOptions);
  }

  // Settings > Tools: name the project the Workspace folder provisioned (the
  // folder IS the project, Projects v2). One projects.list read per 15 s per
  // folder: a new folder re-reads at once, since its commit may just have
  // provisioned the project (F33). A stale completion for a different root
  // is dropped.
  let toolsProjectCache = { at: 0, projects: [], generation: 0, key: '' };
  function paintToolsWorkspaceProject(node, rootPath, rootState) {
    if (!node) return;
    const path = String(rootPath || '').trim();
    if (!path || rootState !== 'ready') { node.hidden = true; node.textContent = ''; return; }
    const key = path.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
    const paint = (projects) => {
      const match = (projects || []).find((project) => project && typeof project.root_path === 'string'
        && project.root_path.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase() === key);
      if (!match) { node.hidden = true; node.textContent = ''; return; }
      node.hidden = false;
      node.textContent = jt('settings.tools.workspaceRoot.project', 'Project: {name} · new chats start here', { name: match.name });
    };
    const api = (typeof window !== 'undefined' && window.jennyShell?.projects) || null;
    if (!api || typeof api.list !== 'function') { node.hidden = true; return; }
    const now = Date.now();
    if (toolsProjectCache.key === key && now - toolsProjectCache.at < 15000) { paint(toolsProjectCache.projects); return; }
    const generation = ++toolsProjectCache.generation;
    Promise.resolve().then(() => api.list()).then((result) => {
      if (generation !== toolsProjectCache.generation) return;
      toolsProjectCache = { at: Date.now(), projects: Array.isArray(result?.projects) ? result.projects : [], generation, key };
      paint(toolsProjectCache.projects);
    }).catch(() => { node.hidden = true; });
  }

  return {
    renderSetupSettingsRow,
    buildApprovalRuleRows,
    renderApprovalRules,
    bindApprovalRules,
    resetApprovalRulesCache,
    paintToolsWorkspaceProject,
  };
});
