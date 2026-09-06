/* renderer/shell/renderer-settings-control-tower-utils.js - Settings -> Readiness.
 *
 * The readiness checklist is its own Settings section (first in the rail), not a
 * banner above every page. This module builds the model, renders the list into
 * the card's host, and syncs the two always-visible indicators that hang off the
 * same model: the card-header badge and the nav-rail count badge. Runtime phase
 * (backend starting/ready) is deliberately NOT a check here - the toprail health
 * pill owns it app-wide, and it was the one row that flipped through every boot.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSettingsControlTowerUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DEFAULT_ESCAPE = function defaultEscapeHtml(value) {
    return String(value || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  };

  const READINESS_SECTION_ID = 'readiness';
  const READY_ITEM_ID = 'settings-ready';

  function normalizeRecord(value) {
    return value && typeof value === 'object' ? value : {};
  }

  function readPath(source, keys) {
    let cursor = source;
    for (let index = 0; index < keys.length; index += 1) {
      if (!cursor || typeof cursor !== 'object') {
        return undefined;
      }
      cursor = cursor[keys[index]];
    }
    return cursor;
  }

  function firstDefined(source, paths) {
    for (let index = 0; index < paths.length; index += 1) {
      const value = readPath(source, paths[index]);
      if (value !== undefined && value !== null && value !== '') {
        return value;
      }
    }
    return undefined;
  }

  function normalizeStatusToken(value) {
    if (value && typeof value === 'object') {
      return String(value.state || value.status || value.phase || '').trim().toLowerCase();
    }
    return String(value || '').trim().toLowerCase();
  }

  /* Tones are the house status vocabulary (renderer/inventory/status-row.js):
   * warning = needs a hand, pending = informational / partial, success = ready. */
  function addItem(items, item) {
    items.push({
      id: item.id,
      label: item.label,
      message: item.message,
      tone: item.tone || 'warning',
      sectionId: item.sectionId || 'models',
      actionLabel: item.actionLabel || 'Open',
      priority: Number.isFinite(Number(item.priority)) ? Number(item.priority) : 100,
    });
  }

  function hasLoadedSetup(state) {
    const loaded = firstDefined(state, [
      ['setup', 'loaded'],
      ['setupState', 'loaded'],
      ['setupStatus', 'loaded'],
    ]);
    return loaded !== false;
  }

  function isSetupComplete(state) {
    const value = firstDefined(state, [
      ['setup', 'setupComplete'],
      ['setup', 'complete'],
      ['setupState', 'setupComplete'],
      ['setupState', 'complete'],
      ['setupStatus', 'setupComplete'],
      ['setupStatus', 'complete'],
    ]);
    return value !== false;
  }

  function getModelName(state) {
    return firstDefined(state, [
      ['models', 'status', 'currentModel'],
      ['models', 'status', 'model'],
      ['models', 'currentModel'],
      ['modelList', 'active_model'],
      ['modelList', 'activeModel'],
      ['runtime', 'currentModel'],
      ['status', 'model'],
      ['runtimePreferences', 'model'],
      ['currentModel'],
    ]);
  }

  function getWorkspaceRoot(state) {
    return firstDefined(state, [
      ['workspaceRoot', 'path'],
      ['workspaceRoot', 'root'],
      ['workspace', 'root'],
      ['tools', 'workspaceRoot'],
      ['featureState', 'workspaceRoot'],
      ['runtimePreferences', 'tools_workspace_root'],
    ]);
  }

  function getWorkspaceStatus(state) {
    return firstDefined(state, [
      ['workspaceRoot', 'status'],
      ['workspace', 'status'],
      ['featureState', 'workspaceRootStatus'],
      ['tools', 'workspaceStatus'],
    ]);
  }

  function getBlockedToolCount(state) {
    const featureState = normalizeRecord(state.featureState || state.features);
    const tools = normalizeRecord(featureState.tools || state.tools);
    const availabilityRoot = normalizeRecord(featureState.availability || featureState.toolAvailability || state.toolAvailability);
    const availability = normalizeRecord(availabilityRoot.tools || availabilityRoot);
    return Object.keys(tools).reduce((count, key) => {
      if (tools[key] !== true) {
        return count;
      }
      const toolState = normalizeRecord(availability[key]);
      return toolState.enabled === false ? count + 1 : count;
    }, 0);
  }

  function isLocalOnlyNotReady(state) {
    const offline = normalizeRecord(state.offline || state.offlineState);
    const localOnly = offline.localOnly === true || offline.mode === 'local' || offline.mode === 'local_only';
    if (!localOnly) {
      return false;
    }
    return offline.localChatReady === false
      || offline.localReady === false
      || offline.ready === false
      || offline.status === 'unavailable';
  }

  function hasMemoryIssue(state) {
    const memories = normalizeRecord(state.memories || state.memory || state.memoryManager);
    return memories.ready === false
      || memories.available === false
      || memories.unavailable === true
      || normalizeStatusToken(memories.status) === 'unavailable';
  }

  function hasProactiveIssue(state) {
    const proactive = normalizeRecord(state.proactive || state.proactiveState);
    return proactive.ready === false || proactive.available === false || normalizeStatusToken(proactive.status) === 'unavailable';
  }

  function hasSkillsIssue(state) {
    const skills = normalizeRecord(state.skills || state.skillsState);
    return skills.ready === false || skills.available === false || normalizeStatusToken(skills.status) === 'unavailable';
  }

  function getDegradedPaneCount(state) {
    const degraded = normalizeRecord(readPath(state, ['settingsRefresh', 'degradedBySection']));
    return Object.keys(degraded).filter((sectionId) => {
      const value = degraded[sectionId];
      return Array.isArray(value) ? value.length > 0 : Boolean(value);
    }).length;
  }

  function buildSettingsControlTowerModel(input) {
    const state = normalizeRecord(input?.state);
    const items = [];

    if (!String(getModelName(state) || '').trim()) {
      addItem(items, {
        id: 'model-unavailable',
        label: 'No active model',
        message: 'Choose or load a model before starting local-first work.',
        tone: 'warning',
        sectionId: 'models',
        actionLabel: 'Choose a model',
        priority: 20,
      });
    }

    const workspaceRootValue = getWorkspaceRoot(state);
    const workspaceStatusValue = getWorkspaceStatus(state);
    const workspaceRoot = String(workspaceRootValue || '').trim();
    const workspaceStatus = normalizeStatusToken(workspaceStatusValue);
    const hasWorkspaceSignal = workspaceRootValue !== undefined
      || workspaceStatusValue !== undefined
      || Object.prototype.hasOwnProperty.call(state, 'workspaceRoot')
      || Object.prototype.hasOwnProperty.call(state, 'workspace');
    if (
      hasWorkspaceSignal
      && (
        !workspaceRoot
        || workspaceStatus === 'missing'
        || workspaceStatus === 'blocked'
        || workspaceStatus === 'invalid'
        || workspaceStatus === 'unavailable'
        || workspaceStatus === 'error'
      )
    ) {
      addItem(items, {
        id: 'workspace-missing',
        label: 'Workspace root is missing',
        message: 'Set a workspace root so tools work inside a clear boundary.',
        tone: 'warning',
        sectionId: 'tools',
        actionLabel: 'Set a workspace root',
        priority: 30,
      });
    }

    const blockedToolCount = getBlockedToolCount(state);
    if (blockedToolCount > 0) {
      addItem(items, {
        id: 'tools-blocked',
        label: 'Enabled tools are blocked',
        message: `${blockedToolCount} enabled ${blockedToolCount === 1 ? 'tool is' : 'tools are'} blocked by current settings or workspace readiness.`,
        tone: 'warning',
        sectionId: 'tools',
        actionLabel: 'Review tools',
        priority: 40,
      });
    }

    if (hasLoadedSetup(state) && !isSetupComplete(state)) {
      addItem(items, {
        id: 'setup-incomplete',
        label: 'Setup is incomplete',
        message: 'Finish the first-run setup so Jenny is ready across sessions.',
        tone: 'warning',
        sectionId: 'account',
        actionLabel: 'Finish setup',
        priority: 50,
      });
    }

    if (isLocalOnlyNotReady(state)) {
      addItem(items, {
        id: 'local-only-not-ready',
        label: 'Force local inference needs attention',
        message: 'Force local inference is on, but the selected local model is not ready.',
        tone: 'warning',
        sectionId: 'offline',
        actionLabel: 'Check local model',
        priority: 60,
      });
    }

    if (hasMemoryIssue(state)) {
      addItem(items, {
        id: 'memory-not-ready',
        label: 'Memory manager is not ready',
        message: 'Approved memory controls stay limited until the memory manager recovers.',
        tone: 'warning',
        sectionId: '__memory',
        actionLabel: 'Open memories',
        priority: 70,
      });
    }

    if (hasProactiveIssue(state)) {
      addItem(items, {
        id: 'proactive-not-ready',
        label: 'Proactive features are unavailable',
        message: 'Morning briefings, reminders, or resource alerts need a readiness check.',
        tone: 'warning',
        sectionId: 'proactive',
        actionLabel: 'Check proactive',
        priority: 80,
      });
    }

    if (hasSkillsIssue(state)) {
      addItem(items, {
        id: 'skills-not-ready',
        label: 'Skills are unavailable',
        message: 'Skill discovery or activation stays limited until the skills state refreshes.',
        tone: 'warning',
        sectionId: 'skills',
        actionLabel: 'Open skills',
        priority: 90,
      });
    }

    const degradedPaneCount = getDegradedPaneCount(state);
    if (degradedPaneCount > 0) {
      addItem(items, {
        id: 'settings-refresh-degraded',
        label: 'Some settings panes are partial',
        message: `${degradedPaneCount} settings ${degradedPaneCount === 1 ? 'pane has' : 'panes have'} partial data. The rows you can see are still current.`,
        tone: 'pending',
        sectionId: '__diagnostics',
        actionLabel: 'Open diagnostics',
        priority: 95,
      });
    }

    items.sort((left, right) => left.priority - right.priority);

    const attentionCount = items.length;
    // The ready state is a real, visible row: the page is never empty and never
    // collapses, so its height is the same whether or not anything needs a hand.
    if (!attentionCount) {
      addItem(items, {
        id: READY_ITEM_ID,
        label: "Everything's ready",
        message: 'Model, workspace, tools, setup, and companion surfaces all look ready.',
        tone: 'success',
        sectionId: 'models',
        actionLabel: 'Review models',
        priority: 1000,
      });
    }

    const hasWarning = items.some((item) => item.tone === 'warning' || item.tone === 'danger');
    return {
      tone: attentionCount > 0 ? 'attention' : 'ready',
      summaryLabel: attentionCount > 0 ? `${attentionCount} to review` : 'Ready',
      summaryMessage: attentionCount > 0
        ? `${attentionCount} ${attentionCount === 1 ? 'item needs' : 'items need'} a look before everything is ready.`
        : 'Settings are ready for the current local-first workflow.',
      attentionCount,
      readyCount: items.length - attentionCount,
      // Nav-rail badge source. Empty text at zero keeps the slot rendered-but-empty.
      badgeText: attentionCount > 0 ? String(attentionCount) : '',
      badgeTone: attentionCount > 0 ? (hasWarning ? 'warning' : 'pending') : '',
      items,
    };
  }

  function fallbackStatusRow(escapeHtml, row) {
    return '<div class="inv-status-row inv-status-row--' + escapeHtml(row.tone) + '" data-status-tone="' + escapeHtml(row.tone) + '">'
      + '<span class="inv-status-row-leading" aria-hidden="true"><span class="inv-status-row-dot"></span></span>'
      + '<div class="inv-status-row-main"><div class="inv-status-row-message">'
      + '<span class="inv-status-row-label">' + escapeHtml(row.label) + '</span>' + escapeHtml(row.message)
      + '</div></div></div>';
  }

  /* The list only. The card header (title + summary badge) is static markup in
   * index.html; syncSettingsControlTowerIndicators() paints its badge. */
  function renderSettingsControlTowerMarkup(model, options) {
    const escapeHtml = options?.escapeHtml || DEFAULT_ESCAPE;
    const actionButton = options?.actionButton
      || ((typeof globalThis !== 'undefined' && globalThis.inventoryActionButton) || null);
    const statusRow = options?.statusRow
      || ((typeof globalThis !== 'undefined' && globalThis.inventoryStatusRow) || null);
    const safeModel = normalizeRecord(model);
    const items = Array.isArray(safeModel.items) ? safeModel.items : [];
    const rows = items.map((item) => {
      const sectionId = String(item.sectionId || 'models').trim() || 'models';
      const actionLabel = String(item.actionLabel || 'Open');
      const tone = String(item.tone || 'warning');
      const actionMarkup = typeof actionButton === 'function'
        ? actionButton({
          id: 'settings-control-tower-open',
          label: actionLabel,
          variant: 'secondary',
          size: 'sm',
          className: 'settings-control-tower-action',
          dataset: { 'settings-control-section': sectionId },
        })
        : '<span class="settings-control-tower-action" role="button" tabindex="0" data-settings-control-section="' + escapeHtml(sectionId) + '">' + escapeHtml(actionLabel) + '</span>';
      const statusMarkup = typeof statusRow === 'function'
        ? statusRow({ tone, label: String(item.label || ''), message: String(item.message || ''), className: 'settings-control-tower-status' })
        : fallbackStatusRow(escapeHtml, { tone, label: String(item.label || ''), message: String(item.message || '') });
      return '<li class="settings-control-tower-row" data-control-tower-item="' + escapeHtml(item.id) + '" data-tone="' + escapeHtml(tone) + '">'
        + statusMarkup
        + actionMarkup
        + '</li>';
    }).join('');

    return '<section class="settings-control-tower" id="settingsControlTower" data-tone="' + escapeHtml(safeModel.tone || 'ready') + '" aria-label="Readiness checks">'
      + '<p class="settings-copy settings-control-tower-summary">' + escapeHtml(safeModel.summaryMessage || '') + '</p>'
      + '<ul class="settings-control-tower-list">' + rows + '</ul>'
      + '</section>';
  }

  /* Paint the two indicators that live outside the host: the card-header
   * `.settings-badge` (#readinessBadge, data-state convention) and the nav-rail
   * count badge via renderer-settings-nav-utils.setNavItemBadge. Both are
   * idempotent so the per-render call never causes layout churn. */
  function syncSettingsControlTowerIndicators(model, options) {
    const safeModel = normalizeRecord(model);
    const documentRef = options?.documentRef
      || (typeof globalThis !== 'undefined' && globalThis.document) || null;
    if (!documentRef || typeof documentRef.getElementById !== 'function') return;
    const headerBadge = documentRef.getElementById('readinessBadge');
    if (headerBadge) {
      const label = String(safeModel.summaryLabel || 'Ready');
      if (headerBadge.textContent !== label) headerBadge.textContent = label;
      const tone = safeModel.attentionCount > 0 ? (safeModel.badgeTone === 'pending' ? 'pending' : 'warning') : 'success';
      if (headerBadge.getAttribute('data-state') !== tone) headerBadge.setAttribute('data-state', tone);
    }
    const setNavItemBadge = typeof options?.setNavItemBadge === 'function'
      ? options.setNavItemBadge
      : (typeof globalThis !== 'undefined' && globalThis.rendererSettingsNavUtils
        && typeof globalThis.rendererSettingsNavUtils.setNavItemBadge === 'function'
        ? globalThis.rendererSettingsNavUtils.setNavItemBadge
        : null);
    if (setNavItemBadge) {
      setNavItemBadge(documentRef, READINESS_SECTION_ID, safeModel.badgeText || '', safeModel.badgeTone || '');
    }
  }

  return {
    READINESS_SECTION_ID,
    READY_ITEM_ID,
    buildSettingsControlTowerModel,
    renderSettingsControlTowerMarkup,
    syncSettingsControlTowerIndicators,
  };
});
