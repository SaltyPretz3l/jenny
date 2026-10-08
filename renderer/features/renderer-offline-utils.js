(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/async-fence'));
    return;
  }
  root.rendererOfflineUtils = factory(root.rendererAsyncFence);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (asyncFence) {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const windowRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const documentRef = windowRef.document || null;

  const escapeStatusText = (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  function getStatusRowRenderer() {
    return windowRef.inventory && typeof windowRef.inventory.statusRow === 'function'
      ? windowRef.inventory.statusRow
      : null;
  }

  function getActionButtonRenderer() {
    return windowRef.inventoryActionButton
      || (typeof require === 'function' ? require('../inventory/action-button') : null);
  }

  function getStatusChipUtils() {
    return windowRef.rendererStatusChipUtils
      || (typeof require === 'function' ? require('../shell/renderer-status-chip-utils') : null);
  }

  // Render inventory switches into a stable .settings-toggle-list container.
  // Delegates to the shared lazy-renderers helper so the resolve/build logic
  // lives in one place; passes the module-local escaper for byte-identical output.
  function renderOfflineToggleList(target, fields) {
    if (!target) { return; }
    const lazy = windowRef.rendererSettingsLazyRenderers
      || (typeof require === 'function' ? require('../shell/renderer-settings-lazy-renderers') : null);
    if (lazy && typeof lazy.renderToggleListInto === 'function') {
      lazy.renderToggleListInto(target, fields, escapeStatusText);
    } else {
      target.innerHTML = '';
    }
  }

  /* Mirrors renderer/inventory/status-row.js's flat shape so a missing
   * primitive degrades to the same DOM rather than a different one. */
  function buildStatusRowFallbackMarkup(model) {
    const tone = String(model?.tone || 'default').trim();
    const label = String(model?.label || '').trim();
    const badgeText = String(model?.badgeText || '').trim();
    const message = String(model?.message || '').trim();
    const toneClass = tone && tone !== 'default' ? ` inv-status-row--${escapeStatusText(tone)}` : '';
    return ''
      + `<div class="inv-status-row${toneClass}" data-status-tone="${escapeStatusText(tone || 'default')}">`
      + '<span class="inv-status-row-leading" aria-hidden="true"><span class="inv-status-row-dot"></span></span>'
      + '<div class="inv-status-row-main"><div class="inv-status-row-message">'
      + (label ? `<span class="inv-status-row-label">${escapeStatusText(label)}</span>` : '')
      + escapeStatusText(message)
      + (badgeText ? `<span class="inv-status-row-badge">${escapeStatusText(badgeText)}</span>` : '')
      + '</div></div></div>';
  }

  function renderStatusRowHost(target, model) {
    if (!target) {
      return;
    }
    const message = String(model?.message || '').trim();
    if (!message) {
      target.innerHTML = '';
      return;
    }
    const statusRow = getStatusRowRenderer();
    if (statusRow) {
      target.innerHTML = statusRow(model);
      return;
    }
    target.innerHTML = buildStatusRowFallbackMarkup(model);
  }

  /* Runtime posture is represented by the Chat panel dot and text. Module scope: the Settings chrome
   * paints it with the composer carriers on every render pass (row 32), the manager on every refresh. */
  function renderComposerOfflineLabel(offlineState) {
    const dotNode = documentRef?.getElementById('composerChatPostureDot') || null;
    if (!dotNode) {
      return;
    }
    const localOnly = offlineState.mode === 'local_only';
    const postureRow = documentRef?.getElementById('composerChatPosture');
    if (postureRow) postureRow.hidden = !localOnly;
    const posture = !localOnly
      ? 'local'
      : offlineState.localChatReady
        ? 'local-only-ready'
        : 'local-only-error';
    dotNode.setAttribute('data-posture', posture);
    dotNode.classList.toggle('status-dot--active', localOnly && offlineState.localChatReady);
    dotNode.classList.toggle('status-dot--error', localOnly && !offlineState.localChatReady);
    // Tier C #12: data-state only (not the full applyStatusChip treatment,
    // which would also add the settings-status-chip class and overwrite
    // textContent) — this dot is a decorative, textless indicator, so it
    // gets the loading -> live/error convention additively alongside its
    // existing status-dot--* classes above. Before the first offline
    // payload lands this reads 'loading' instead of silently falling
    // through to the "off" styling those classes produce by default.
    const chipUtils = getStatusChipUtils();
    const dotChipState = offlineState.resolved === false
      ? 'loading'
      : chipUtils
        ? chipUtils.resolveAvailabilityChipState({ resolved: true, ok: !(localOnly && !offlineState.localChatReady) })
        : (localOnly && !offlineState.localChatReady ? 'error' : 'live');
    dotNode.setAttribute('data-state', dotChipState);
    const postureTooltip = !localOnly
      ? (offlineState.resolved === false
        ? jt('offline.status.runtimePostureLoading', 'Runtime posture is still loading.')
        : offlineState.localChatReady
          ? jt('offline.status.localRuntimeReadyNetworkAllowed', 'A local runtime is ready. Force local inference is off, so configured inference providers may use the network.')
          : jt('offline.status.forceLocalOffNetworkAllowed', 'Force local inference is off. Configured inference providers may use the network.'))
      : offlineState.localChatReady
        ? (offlineState.localVisionReady
          ? jt('offline.status.usingModelWithVision', 'Force local inference: using {model} for chat and current-turn vision.', { model: offlineState.preferredLocalModel })
          : jt('offline.status.usingModelWithoutVision', 'Force local inference: using {model} for chat. Vision remains unavailable for this model.', { model: offlineState.preferredLocalModel }))
        : (offlineState.unavailableReason || offlineState.summary || jt('offline.status.forceLocalUnavailable', 'Force local inference is enabled but unavailable.'));
    const textNode = documentRef?.getElementById('composerChatPostureText');
    if (textNode) textNode.textContent = postureTooltip;
  }

  function createOfflineManager(deps) {
    const { state } = deps;
    const {
      appendClientLog,
      renderSettings,
    } = deps.callbacks;
    let disposed = false;
    const operationGate = asyncFence.createGenerationGate();

    function getDomSnapshot() {
      const staticDom =
        deps.dom && typeof deps.dom === 'object' && !Array.isArray(deps.dom)
          ? deps.dom
          : {};
      const dynamicDom =
        typeof deps.getDom === 'function'
          ? (deps.getDom() || {})
          : {};
      return {
        ...staticDom,
        ...dynamicDom,
      };
    }

    function normalizeOfflineState(payload) {
      const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
      const localCatalogSource =
        source.localCatalog && typeof source.localCatalog === 'object' && !Array.isArray(source.localCatalog)
          ? source.localCatalog
          : {};
      const managedSidecarSource =
        source.managedSidecar && typeof source.managedSidecar === 'object' && !Array.isArray(source.managedSidecar)
          ? source.managedSidecar
          : {};
      return {
        // Only call site is applyOfflinePayload — a real payload always
        // reaches here, never the bootstrap seed — so this is unconditional.
        // See the seam comment on state.offline in renderer-bootstrap-utils.js.
        resolved: true,
        mode: String(source.mode || '').trim().toLowerCase() === 'local_only' ? 'local_only' : 'disabled',
        preferredLocalModel: String(source.preferredLocalModel || '').trim(),
        localCatalog: {
          available: localCatalogSource.available === true,
          reason: String(localCatalogSource.reason || '').trim(),
          models: Array.isArray(localCatalogSource.models)
            ? localCatalogSource.models.map((entry) => String(
              typeof entry === 'string' ? entry : (entry?.id || entry?.name || entry?.model || '')
            ).trim()).filter(Boolean)
            : [],
        },
        managedSidecar: {
          mode: String(managedSidecarSource.mode || '').trim(),
          phase: String(managedSidecarSource.phase || '').trim() || 'stopped',
          ready: managedSidecarSource.ready === true,
        },
        currentEngine: String(source.currentEngine || '').trim(),
        currentModel: String(source.currentModel || '').trim(),
        engineFallback:
          source.engineFallback && typeof source.engineFallback === 'object' && !Array.isArray(source.engineFallback)
            ? {
                requestedEngine: String(
                  source.engineFallback.requestedEngine || source.engineFallback.requested_engine || ''
                ).trim(),
                reason: String(source.engineFallback.reason || '').trim(),
              }
            : null,
        selectedLocalModelInstalled: source.selectedLocalModelInstalled === true,
        localChatReady: source.localChatReady === true,
        localVisionReady: source.localVisionReady === true,
        unavailableReason: String(source.unavailableReason || '').trim(),
        visionUnavailableReason: String(source.visionUnavailableReason || '').trim(),
        summary: String(source.summary || '').trim(),
      };
    }

    function applyOfflinePayload(payload) {
      state.offline = normalizeOfflineState(payload);
      return state.offline;
    }

    // The Local inference model group's one line: which model, and where to
    // change it (the Model Library button beside it).
    function getModelStatusText(offlineState) {
      if (offlineState.preferredLocalModel && offlineState.localChatReady) {
        return jt('offline.status.localModelInUse', 'Local inference uses {model}. Change it in Model Library.', { model: offlineState.preferredLocalModel });
      }
      if (offlineState.preferredLocalModel && offlineState.selectedLocalModelInstalled) {
        return jt('offline.status.selectedModelNotReady', 'Selected model {model} is installed, but local inference is not ready. {reason}', { model: offlineState.preferredLocalModel, reason: offlineState.unavailableReason || '' }).trim();
      }
      if (offlineState.preferredLocalModel) {
        return jt('offline.status.selectedModelMissing', 'Selected model {model} is not available in the local catalog.', { model: offlineState.preferredLocalModel });
      }
      return jt('offline.status.noModelSelected', 'No local inference model is selected.');
    }

    function renderOfflineManager() {
      const {
        offlineSummary,
        offlineStatus,
        offlineLocalOnlyList,
        offlineModelStatus,
        offlineModelActions,
      } = getDomSnapshot();
      const offlineState = state.offline || normalizeOfflineState({});
      // Prefer the sidecar-curated summary when one is provided — it carries
      // richer context than the UI fallbacks. Fall back to a UI message that
      // matches the current mode/readiness state.
      const offlineSummaryMessage = String(offlineState.summary || '').trim()
        || (offlineState.mode === 'local_only'
          ? (offlineState.localChatReady
            ? jt('offline.status.forceLocalUsingModel', 'Force local inference is on. Jenny will use {model} for model inference.', { model: String(offlineState.preferredLocalModel || 'a local model') })
            : jt('offline.status.forceLocalBlocked', 'Force local inference is on, but model inference is blocked: {reason}', { reason: String(offlineState.unavailableReason || 'the local runtime is not ready') }))
          : offlineState.localChatReady
            ? jt('offline.status.localRuntimeReadyWithModel', 'Local runtime is ready with {model}.', { model: String(offlineState.preferredLocalModel || 'a local model') })
            : jt('offline.status.forceLocalOff', 'Force local inference is off.'));
      if (offlineSummary) {
        renderStatusRowHost(offlineSummary, {
          tone: offlineState.mode === 'local_only'
            ? (offlineState.localChatReady ? 'success' : 'warning')
            : offlineState.localChatReady
              ? 'default'
              : String(offlineState.unavailableReason || '').trim()
                ? 'warning'
                : 'default',
          label: jt('offline.localOnly.label', 'Force local inference'),
          message: offlineSummaryMessage,
          badgeText: offlineState.mode === 'local_only'
            ? 'Forced'
            : offlineState.localChatReady
              ? 'Ready'
              : 'Optional',
          compact: true,
          className: 'settings-inline-status-row',
          ariaLive: 'polite',
        });
      }
      if (offlineStatus) {
        offlineStatus.textContent = '';
      }
      renderOfflineToggleList(offlineLocalOnlyList, [
        { id: 'offlineLocalOnlyToggle', label: jt('offline.localOnly.label', 'Force local inference'), checked: offlineState.mode === 'local_only' },
      ]);
      if (offlineModelStatus) {
        offlineModelStatus.textContent = getModelStatusText(offlineState);
      }
      if (offlineModelActions) {
        const actionButton = getActionButtonRenderer();
        offlineModelActions.innerHTML = typeof actionButton === 'function' ? actionButton({
          plain: true,
          className: 'settings-secondary',
          label: offlineState.preferredLocalModel ? jt('offline.modelLibrary.manage', 'Manage in Model Library') : jt('offline.modelLibrary.choose', 'Choose in Model Library'),
          dataset: { action: 'openOfflineModelLibrary' },
        }) : '';
      }
      renderComposerOfflineLabel(offlineState);
    }

    async function refreshOfflineState() {
      operationGate.bump();
      const operationToken = operationGate.capture();
      const offlinePayload = await windowRef.jennyShell.offline.getState();
      if (disposed || !operationGate.isCurrent(operationToken)) {
        return { offline: state.offline };
      }
      applyOfflinePayload(offlinePayload);
      renderOfflineManager();
      return {
        offline: state.offline,
      };
    }

    async function updateSettings(patch) {
      operationGate.bump();
      const operationToken = operationGate.capture();
      let payload;
      try {
        payload = await windowRef.jennyShell.offline.updateSettings(patch);
      } catch (error) {
        if (!disposed && operationGate.isCurrent(operationToken)) renderOfflineManager();
        throw error;
      }
      if (disposed || !operationGate.isCurrent(operationToken)) {
        return state.offline;
      }
      applyOfflinePayload(payload);
      appendClientLog('INFO', 'offline.settings_updated', {
        mode: state.offline.mode,
        preferredLocalModel: state.offline.preferredLocalModel,
      });
      renderOfflineManager();
      renderSettings();
      return state.offline;
    }

    async function handleOfflineModeChange(enabled) {
      return updateSettings({
        mode: enabled ? 'local_only' : 'disabled',
      });
    }

    function bindShellEvents() {
      // Offline intelligence has no live shell events to bind; kept as a stable
      // no-op so the offline shell-event plumbing stays uniform with other
      // settings sections.
      return () => {};
    }

    return {
      normalizeOfflineState,
      applyOfflinePayload,
      refreshOfflineState,
      renderOfflineManager,
      bindShellEvents,
      handleOfflineModeChange,
      dispose() {
        if (disposed) {
          return;
        }
        disposed = true;
        operationGate.bump();
      },
    };
  }

  return { createOfflineManager, renderComposerPosture: renderComposerOfflineLabel };
});
