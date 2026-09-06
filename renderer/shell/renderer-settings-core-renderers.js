/* renderer/shell/renderer-settings-core-renderers.js - Core Settings render helpers. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSettingsCoreRenderers = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
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
        setupSettingsSummary.textContent = 'Loading setup status...';
      } else if (isComplete) {
        setupSettingsSummary.textContent = 'Setup complete. Run again to revisit any step - your progress is preserved.';
      } else {
        const total = sceneUtils?.STEP_ORDER?.length || 5;
        const done = sceneUtils?.countCompletedSteps?.(setupSnapshot.steps || {}) || 0;
        setupSettingsSummary.textContent = `${done} of ${total} setup steps complete. Resume setup to finish.`;
      }
    }
    if (!setupSettingsActions) {
      return;
    }
    const nextLabel = isComplete ? 'Run setup again' : 'Resume setup';
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
        label: isComplete ? 'Setup help' : 'Help with setup',
        variant: 'secondary',
      }),
      '</div>',
      '<details class="settings-overflow"><summary>More</summary>'
        + '<div class="settings-actions">'
        + actionButton({
          id: 'settingsOpenFactoryReset',
          label: 'Reset onboarding',
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
  const APPROVAL_DECISION_LABELS = Object.freeze({ auto: 'Always allow', ask: 'Ask before', deny: 'Never allow' });
  const approvalRulesCache = { fetchedAt: 0, saved: null, inFlight: null, version: 0 };

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
      detail: 'every call',
    }));
    for (const rule of Array.isArray(source.rules) ? source.rules : []) {
      if (!rule || typeof rule !== 'object' || !rule.id) continue;
      const match = rule.match && typeof rule.match === 'object' ? rule.match : {};
      rows.push({
        kind: 'rule',
        key: String(rule.id),
        decision: rule.decision,
        label: `${APPROVAL_DECISION_LABELS[rule.decision] || rule.decision}: ${match.tool_id || 'any tool'}`,
        detail: match.path_prefix ? `for ${match.path_prefix}` : (match.action ? `action ${match.action}` : 'every call'),
      });
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
      container.innerHTML = '<div class="settings-note tools-approval-rules-empty">No saved approval rules yet. '
        + 'Choose "Always allow" on an approval card and it shows up here.</div>';
      return;
    }
    container.innerHTML = rows.map((row) => {
      const remove = actionButton
        ? actionButton({
          id: APPROVAL_RULE_REMOVE_ACTION,
          label: 'Remove',
          variant: 'secondary',
          size: 'sm',
          ariaLabel: `Remove rule: ${row.label} ${row.detail}`,
          title: 'Remove this approval rule',
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
      container.innerHTML = '<div class="settings-note">Approval rules are unavailable in this window.</div>';
      return null;
    }
    const paint = () => renderApprovalRuleRows(
      container, buildApprovalRuleRows(approvalRulesCache.saved), escapeHtml, actionButton
    );
    const stale = !approvalRulesCache.saved
      || Date.now() - approvalRulesCache.fetchedAt >= APPROVAL_RULES_CACHE_MS;
    if (approvalRulesCache.saved) paint();
    else container.innerHTML = '<div class="settings-note">Loading approval rules...</div>';
    if ((!stale || approvalRulesCache.inFlight) && options?.force !== true) return approvalRulesCache.inFlight;
    const version = ++approvalRulesCache.version;
    approvalRulesCache.inFlight = Promise.resolve()
      .then(() => api.getPermissions())
      .then((payload) => {
        if (version !== approvalRulesCache.version) return;
        const saved = payload && typeof payload === 'object' ? payload.saved : null;
        approvalRulesCache.saved = saved && typeof saved === 'object' ? saved : { policies: {}, rules: [] };
        approvalRulesCache.fetchedAt = Date.now();
        paint();
      })
      .catch(() => {
        if (version !== approvalRulesCache.version) return;
        container.innerHTML = '<div class="settings-note">Approval rules could not be loaded.</div>';
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
  }

  function bindApprovalRules(options) {
    const container = options?.container;
    const registerListener = options?.registerListener;
    const api = options?.api;
    if (!container || typeof registerListener !== 'function') return;
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
          container, api, escapeHtml: options.escapeHtml, actionButton: options.actionButton, force: true,
        }))
        .catch((error) => {
          button.disabled = false;
          if (typeof options?.onError === 'function') options.onError(error, 'Approval Rule Removal Failed');
        });
    }, options?.listenerOptions);
  }

  return {
    renderSetupSettingsRow,
    buildApprovalRuleRows,
    renderApprovalRules,
    bindApprovalRules,
    resetApprovalRulesCache,
  };
});
