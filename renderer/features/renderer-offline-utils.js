(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/async-fence'));
    return;
  }
  root.rendererOfflineUtils = factory(root.rendererAsyncFence);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (asyncFence) {
  const windowRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const documentRef = windowRef.document || null;

  function escapeStatusText(value) {
    return String(value || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

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

    function getBadgeLabel(offlineState) {
      if (offlineState.mode === 'local_only') {
        return offlineState.localChatReady ? 'Forced' : 'Blocked';
      }
      if (offlineState.localChatReady) {
        return 'Ready';
      }
      if (offlineState.localCatalog.available === false) {
        return 'Unavailable';
      }
      return 'Optional';
    }

    function getModelStatusText(offlineState) {
      if (offlineState.preferredLocalModel && offlineState.localChatReady) {
        return `Selected model ${offlineState.preferredLocalModel} is ready for local inference.`;
      }
      if (offlineState.preferredLocalModel && offlineState.selectedLocalModelInstalled) {
        return `Selected model ${offlineState.preferredLocalModel} is installed, but local inference is not ready. ${offlineState.unavailableReason || ''}`.trim();
      }
      if (offlineState.preferredLocalModel) {
        return `Selected model ${offlineState.preferredLocalModel} is not available in the local catalog.`;
      }
      return 'No local inference model is selected.';
    }

    /* Runtime posture is represented by the composer gear dot and tooltip. */
    function renderComposerOfflineLabel(offlineState) {
      const dotNode = documentRef?.getElementById('composerGearPostureDot') || null;
      if (!dotNode) {
        return;
      }
      const localOnly = offlineState.mode === 'local_only';
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
          ? 'Runtime posture is still loading.'
          : offlineState.localChatReady
            ? 'A local runtime is ready. Force local inference is off, so configured inference providers may use the network.'
            : 'Force local inference is off. Configured inference providers may use the network.')
        : offlineState.localChatReady
          ? (offlineState.localVisionReady
            ? `Force local inference: using ${offlineState.preferredLocalModel} for chat and current-turn vision.`
            : `Force local inference: using ${offlineState.preferredLocalModel} for chat. Vision remains unavailable for this model.`)
          : (offlineState.unavailableReason || offlineState.summary || 'Force local inference is enabled but unavailable.');
      const gear = documentRef?.getElementById('composerSettingsButton') || null;
      if (gear) {
        /* data-tooltip (not title) so the inventory tooltip shows the
         * combined string without a native double-tooltip. */
        gear.setAttribute('data-tooltip', `Session settings · ${postureTooltip}`);
        gear.removeAttribute('title');
      }
    }

    function renderOfflineManager() {
      const {
        offlineBadge,
        offlineSummary,
        offlineStatus,
        offlineLocalOnlyList,
        offlineModelStatus,
        offlineModelActions,
      } = getDomSnapshot();
      const offlineState = state.offline || normalizeOfflineState({});
      const badgeLabel = getBadgeLabel(offlineState);
      if (offlineBadge) {
        // Tier C #12: additive settings-status-chip/data-state on top of the
        // existing text-badge contract — offlineBadge.textContent stays the
        // same computed label (existing tests assert exact text), it just
        // also now flashes 'loading' before the first offline payload lands
        // instead of the optimistic 'Optional' seed.
        const chipUtils = getStatusChipUtils();
        const badgeOk = badgeLabel !== 'Blocked' && badgeLabel !== 'Unavailable';
        const badgeChipState = offlineState.resolved === false
          ? 'loading'
          : chipUtils
            ? chipUtils.resolveAvailabilityChipState({ resolved: true, ok: badgeOk })
            : (badgeOk ? 'live' : 'error');
        if (chipUtils && typeof chipUtils.applyStatusChip === 'function') {
          chipUtils.applyStatusChip(offlineBadge, {
            state: badgeChipState,
            label: offlineState.resolved === false ? 'Checking...' : badgeLabel,
          });
        } else {
          offlineBadge.textContent = offlineState.resolved === false ? 'Checking...' : badgeLabel;
        }
      }
      // Prefer the sidecar-curated summary when one is provided — it carries
      // richer context than the UI fallbacks. Fall back to a UI message that
      // matches the current mode/readiness state.
      const offlineSummaryMessage = String(offlineState.summary || '').trim()
        || (offlineState.mode === 'local_only'
          ? (offlineState.localChatReady
            ? `Force local inference is on. Jenny will use ${String(offlineState.preferredLocalModel || 'a local model')} for model inference.`
            : `Force local inference is on, but model inference is blocked: ${String(offlineState.unavailableReason || 'the local runtime is not ready')}`)
          : offlineState.localChatReady
            ? `Local runtime is ready with ${String(offlineState.preferredLocalModel || 'a local model')}.`
            : 'Force local inference is off.');
      if (offlineSummary) {
        renderStatusRowHost(offlineSummary, {
          tone: offlineState.mode === 'local_only'
            ? (offlineState.localChatReady ? 'success' : 'warning')
            : offlineState.localChatReady
              ? 'default'
              : String(offlineState.unavailableReason || '').trim()
                ? 'warning'
                : 'default',
          label: 'Force local inference',
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
        { id: 'offlineLocalOnlyToggle', label: 'Force local inference', checked: offlineState.mode === 'local_only' },
      ]);
      if (offlineModelStatus) {
        offlineModelStatus.textContent = getModelStatusText(offlineState);
      }
      if (offlineModelActions) {
        const actionButton = getActionButtonRenderer();
        offlineModelActions.innerHTML = typeof actionButton === 'function' ? actionButton({
          plain: true,
          className: 'settings-secondary',
          label: offlineState.preferredLocalModel ? 'Manage in Model Library' : 'Choose in Model Library',
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

  return { createOfflineManager };
});
