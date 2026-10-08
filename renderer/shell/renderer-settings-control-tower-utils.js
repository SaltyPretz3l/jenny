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
    module.exports = factory(require('../inventory/badge'));
    return;
  }
  root.rendererSettingsControlTowerUtils = factory(root.inventoryBadge);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (inventoryBadge) {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  const DEFAULT_ESCAPE = (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  const READINESS_SECTION_ID = 'readiness';
  const READY_ITEM_ID = 'model-ready';

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
      action: item.action || '',
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

  // Tools-page labels for the toggles a folder can block; other keys show as-is.
  const TOOL_LABELS = {
    fileTools: () => jt('settings.tools.fileTools.label', 'File tools'),
    richFiles: () => jt('settings.tools.richFiles.label', 'Rich file reading'),
    subagents: () => jt('settings.tools.subagents.label', 'Delegated research'),
    bash: () => jt('settings.tools.bash.label', 'Terminal commands'),
    lsp: () => jt('settings.tools.lsp.label', 'Code intelligence'),
    worktree: () => jt('settings.tools.worktree.label', 'Worktree tools'),
  };

  function getBlockedToolNames(state) {
    const featureState = normalizeRecord(state.featureState || state.features);
    const tools = normalizeRecord(featureState.tools || state.tools);
    const availabilityRoot = normalizeRecord(featureState.availability || featureState.toolAvailability || state.toolAvailability);
    const availability = normalizeRecord(availabilityRoot.tools || availabilityRoot);
    return Object.keys(tools).filter((key) => {
      const toolState = normalizeRecord(availability[key]);
      return tools[key] === true && toolState.enabled === false;
    }).map((key) => ({ name: key, needsFolder: normalizeRecord(availability[key]).workspaceRootRequired === true }));
  }

  function isLocalOnly(state) {
    const offline = normalizeRecord(state.offline || state.offlineState);
    return offline.localOnly === true || offline.mode === 'local' || offline.mode === 'local_only';
  }

  function isLocalOnlyNotReady(state) {
    const offline = normalizeRecord(state.offline || state.offlineState);
    if (!isLocalOnly(state)) {
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
    const chatReady = Boolean(String(getModelName(state) || '').trim());

    if (!chatReady) {
      addItem(items, {
        id: 'model-unavailable',
        label: jt('settings.controlTower.noActiveModel', 'No active model'),
        message: jt('settings.controlTower.chooseModel', 'Choose or load a model before starting local-first work.'),
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
    const workspaceMissing = hasWorkspaceSignal
      && (
        !workspaceRoot
        || workspaceStatus === 'missing'
        || workspaceStatus === 'blocked'
        || workspaceStatus === 'invalid'
        || workspaceStatus === 'unavailable'
        || workspaceStatus === 'error'
      );
    // Only tools blocked for want of a folder fold into the workspace row; the
    // rest (platform, sidecar) keep their own row.
    const blockedTools = getBlockedToolNames(state);
    const folderBlockedNames = workspaceMissing ? blockedTools.filter((tool) => tool.needsFolder).map((tool) => (TOOL_LABELS[tool.name] ? TOOL_LABELS[tool.name]() : tool.name)) : [];
    const blockedToolCount = blockedTools.length - folderBlockedNames.length;
    if (workspaceMissing) {
      let message = jt('settings.controlTower.fileToolsFolderMessage', 'File tools need a folder to work in.');
      const folderBlockedCount = folderBlockedNames.length;
      if (folderBlockedCount > 0) {
        const blocked = jtn('settings.controlTower.workspaceBlocksTools', folderBlockedCount, { count: folderBlockedCount }, 'Also blocks: {count} enabled tool', 'Also blocks: {count} enabled tools');
        const names = folderBlockedNames.slice(0, 3).join(', ') + (folderBlockedCount > 3 ? ', …' : '');
        message += ' ' + jt('settings.controlTower.workspaceBlockedToolNames', '{blocked} ({names}).', { blocked, names });
      }
      addItem(items, {
        id: 'workspace-missing',
        label: jt('settings.controlTower.noWorkspaceFolder', 'No workspace folder'),
        message,
        tone: 'warning',
        sectionId: 'tools',
        actionLabel: jt('settings.controlTower.chooseFolderAction', 'Choose folder'),
        action: 'choose-workspace',
        priority: 30,
      });
    }

    if (blockedToolCount > 0) {
      addItem(items, {
        id: 'tools-blocked',
        label: jt('settings.controlTower.enabledToolsBlocked', 'Enabled tools are blocked'),
        message: jtn('settings.controlTower.enabledToolsBlockedCount', blockedToolCount, { count: blockedToolCount }, '{count} enabled tool is blocked by current settings or workspace readiness.', '{count} enabled tools are blocked by current settings or workspace readiness.'),
        tone: 'warning',
        sectionId: 'tools',
        actionLabel: jt('settings.controlTower.reviewTools', 'Review tools'),
        priority: 40,
      });
    }

    if (hasLoadedSetup(state) && !isSetupComplete(state)) {
      addItem(items, {
        id: 'setup-incomplete',
        label: jt('settings.controlTower.setupNotFinished', 'Setup not finished'),
        message: jt('settings.controlTower.finishSetup', 'Finish the first-run setup so Jenny is ready across sessions.'),
        tone: 'warning',
        sectionId: 'account',
        actionLabel: jt('settings.controlTower.resumeSetupAction', 'Resume setup'),
        action: 'resume-setup',
        priority: 50,
      });
    }

    if (isLocalOnlyNotReady(state)) {
      addItem(items, {
        id: 'local-only-not-ready',
        label: jt('settings.controlTower.forceLocalAttention', 'Force local inference needs attention'),
        message: jt('settings.controlTower.forceLocalNotReady', 'Force local inference is on, but the selected local model is not ready.'),
        tone: 'warning',
        sectionId: 'offline',
        actionLabel: jt('settings.controlTower.checkLocalModel', 'Check local model'),
        priority: 60,
      });
    }

    if (hasMemoryIssue(state)) {
      addItem(items, {
        id: 'memory-not-ready',
        label: jt('settings.controlTower.memoryNotReady', 'Memory manager is not ready'),
        message: jt('settings.controlTower.memoryLimited', 'Approved memory controls stay limited until the memory manager recovers.'),
        tone: 'warning',
        sectionId: '__memory',
        actionLabel: jt('settings.controlTower.openMemories', 'Open memories'),
        priority: 70,
      });
    }

    if (hasProactiveIssue(state)) {
      addItem(items, {
        id: 'proactive-not-ready',
        label: jt('settings.controlTower.proactiveUnavailable', 'Proactive features are unavailable'),
        message: jt('settings.controlTower.proactiveReadiness', 'Morning briefings, reminders, or resource alerts need a readiness check.'),
        tone: 'warning',
        sectionId: 'proactive',
        actionLabel: jt('settings.controlTower.checkProactive', 'Check proactive'),
        priority: 80,
      });
    }

    if (hasSkillsIssue(state)) {
      addItem(items, {
        id: 'skills-not-ready',
        label: jt('settings.controlTower.skillsUnavailable', 'Skills are unavailable'),
        message: jt('settings.controlTower.skillsLimited', 'Skill discovery or activation stays limited until the skills state refreshes.'),
        tone: 'warning',
        sectionId: 'skills',
        actionLabel: jt('settings.controlTower.openSkills', 'Open skills'),
        priority: 90,
      });
    }

    const degradedPaneCount = getDegradedPaneCount(state);
    if (degradedPaneCount > 0) {
      addItem(items, {
        id: 'settings-refresh-degraded',
        label: jt('settings.controlTower.somePanesPartial', 'Some settings panes are partial'),
        message: jtn('settings.controlTower.partialPaneCount', degradedPaneCount, { count: degradedPaneCount }, '{count} settings pane has partial data. The rows you can see are still current.', '{count} settings panes have partial data. The rows you can see are still current.'),
        tone: 'pending',
        sectionId: '__diagnostics',
        actionLabel: jt('settings.controlTower.openDiagnostics', 'Open diagnostics'),
        priority: 95,
      });
    }

    items.sort((left, right) => left.priority - right.priority);

    const attentionCount = items.length;
    // The ready state lists each area the checks above cover as a success row, so
    // the page is never empty and shows what was checked. An area appears only
    // when its state is known (Force local: only while it is on).
    if (!attentionCount) {
      const ready = (id, label, message, sectionId, actionLabel) => addItem(items, {
        id, label, message, tone: 'success', sectionId, actionLabel,
      });
      ready(READY_ITEM_ID, jt('settings.controlTower.ready.model', 'Model'), jt('settings.controlTower.ready.modelMessage', '{model} is the active model.', { model: String(getModelName(state)).trim() }), 'models', jt('settings.controlTower.reviewModels', 'Review models'));
      if (hasWorkspaceSignal) {
        ready('workspace-ready', jt('settings.controlTower.ready.workspace', 'Workspace'), workspaceRoot, 'tools', jt('settings.controlTower.openTools', 'Open tools'));
      }
      ready('tools-ready', jt('settings.controlTower.ready.tools', 'Tools'), jt('settings.controlTower.ready.toolsMessage', 'No enabled tool is blocked.'), 'tools', jt('settings.controlTower.reviewTools', 'Review tools'));
      if (hasLoadedSetup(state)) {
        ready('setup-ready', jt('settings.controlTower.ready.setup', 'Setup'), jt('settings.controlTower.ready.setupMessage', 'First-run setup is complete.'), 'account', jt('settings.controlTower.openProfile', 'Open profile'));
      }
      const known = (record) => Object.keys(normalizeRecord(record)).length > 0;
      if (isLocalOnly(state)) {
        ready('local-only-ready', jt('settings.controlTower.ready.forceLocal', 'Force local'), jt('settings.controlTower.ready.forceLocalMessage', 'Force local inference is on and the local model is ready.'), 'offline', jt('settings.controlTower.checkLocalModel', 'Check local model'));
      }
      if (known(state.memories || state.memory || state.memoryManager)) {
        ready('memory-ready', jt('settings.controlTower.ready.memory', 'Memory'), jt('settings.controlTower.ready.memoryMessage', 'The memory manager is ready.'), '__memory', jt('settings.controlTower.openMemories', 'Open memories'));
      }
      if (known(state.proactive || state.proactiveState)) {
        ready('proactive-ready', jt('settings.controlTower.ready.proactive', 'Proactive features'), jt('settings.controlTower.ready.proactiveMessage', 'Briefings, reminders and resource alerts are available.'), 'proactive', jt('settings.controlTower.checkProactive', 'Check proactive'));
      }
      if (known(state.skills || state.skillsState)) {
        ready('skills-ready', jt('settings.controlTower.ready.skills', 'Skills'), jt('settings.controlTower.ready.skillsMessage', 'Skill discovery and activation are available.'), 'skills', jt('settings.controlTower.openSkills', 'Open skills'));
      }
    }

    const hasWarning = items.some((item) => item.tone === 'warning' || item.tone === 'danger');
    const capabilities = [{
      tone: chatReady ? 'success' : 'warning',
      text: chatReady ? jt('settings.controlTower.chatReady', 'Chat ready') : jt('settings.controlTower.chatNeedsModel', 'Chat needs a model'),
    }];
    if (hasWorkspaceSignal || blockedToolCount > 0) {
      capabilities.push({
        tone: workspaceMissing || blockedToolCount > 0 ? 'warning' : 'success',
        text: workspaceMissing
          ? jt('settings.controlTower.fileToolsNeedFolder', 'File tools need a folder')
          : blockedToolCount > 0
            ? jt('settings.controlTower.someToolsBlocked', 'Some tools are blocked')
            : jt('settings.controlTower.fileToolsReady', 'File tools ready'),
      });
    }
    return {
      tone: attentionCount > 0 ? 'attention' : 'ready',
      summaryLabel: attentionCount > 0 ? jt('settings.controlTower.reviewCount', '{count} to review', { count: attentionCount }) : 'Ready',
      summaryMessage: attentionCount > 0
        ? ''
        : jt('settings.controlTower.readySummary', 'Settings are ready for the current local-first workflow.'),
      attentionCount,
      readyCount: items.length - attentionCount,
      // Nav-rail badge source. Empty text at zero keeps the slot rendered-but-empty.
      badgeText: attentionCount > 0 ? String(attentionCount) : '',
      badgeTone: attentionCount > 0 ? (hasWarning ? 'warning' : 'pending') : '',
      capabilities,
      items,
    };
  }

  function fallbackStatusRow(escapeHtml, row) {
    return '<div class="inv-status-row settings-control-tower-status inv-status-row--' + escapeHtml(row.tone) + '" data-status-tone="' + escapeHtml(row.tone) + '">'
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
    const badge = options?.badge || inventoryBadge;
    const capabilities = Array.isArray(safeModel.capabilities) ? safeModel.capabilities : [];
    const chips = capabilities.map((capability) => badge({ tone: capability.tone, text: capability.text, size: 'sm' })).join('');
    const items = Array.isArray(safeModel.items) ? safeModel.items : [];
    const rows = items.map((item) => {
      const sectionId = String(item.sectionId || 'models').trim() || 'models';
      const actionLabel = String(item.actionLabel || 'Open');
      const tone = String(item.tone || 'warning');
      const dataset = { 'settings-control-section': sectionId };
      if (item.action) dataset['settings-control-action'] = item.action;
      const actionMarkup = typeof actionButton === 'function'
        ? actionButton({
          id: 'settings-control-tower-open',
          label: actionLabel,
          variant: 'secondary',
          size: 'sm',
          className: 'settings-control-tower-action',
          dataset,
        })
        : '<span class="settings-control-tower-action" role="button" tabindex="0" data-settings-control-section="' + escapeHtml(sectionId) + '"'
          + (item.action ? ' data-settings-control-action="' + escapeHtml(item.action) + '"' : '') + '>' + escapeHtml(actionLabel) + '</span>';
      const statusMarkup = typeof statusRow === 'function'
        ? statusRow({ tone, label: String(item.label || ''), message: String(item.message || ''), className: 'settings-control-tower-status' })
        : fallbackStatusRow(escapeHtml, { tone, label: String(item.label || ''), message: String(item.message || '') });
      return '<li class="settings-control-tower-row" data-control-tower-item="' + escapeHtml(item.id) + '" data-tone="' + escapeHtml(tone) + '">'
        + statusMarkup
        + actionMarkup
        + '</li>';
    }).join('');

    return '<section class="settings-control-tower" id="settingsControlTower" data-tone="' + escapeHtml(safeModel.tone || 'ready') + '" aria-label="' + escapeHtml(jt('settings.controlTower.readinessChecksAria', 'Readiness checks')) + '">'
      + '<div class="settings-control-tower-capabilities">' + chips + '</div>'
      + (safeModel.attentionCount > 0 ? '' : '<p class="settings-copy settings-control-tower-summary">' + escapeHtml(safeModel.summaryMessage || '') + '</p>')
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
