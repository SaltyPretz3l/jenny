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
  // Node (tests) only: in the renderer the global `require` is Monaco's AMD loader, which throws for these paths.
  const nodeRequire = typeof module === 'object' && module.exports && typeof require === 'function'
    ? require
    : null;

  const escapeStatusText = (globalThis.stringUtils || (nodeRequire ? nodeRequire('../shared/string-utils') : null)).escapeHtml;

  // The engine names a model can be blocked on (selectedManagedEngine from the main process).
  const MANAGED_ENGINE_LABELS = { 'llama-server': 'llama-server', ninfer: 'NInfer' };

  function getStatusChipUtils() {
    return windowRef.rendererStatusChipUtils
      || (nodeRequire ? nodeRequire('../shell/renderer-status-chip-utils') : null);
  }

  // ---- E64: Force local also turns Team off on this PC (the hold itself is enforced in main) ----

  // True when the Team feature is on and this PC has team data: only then do the sentence and the question apply.
  function teamApplies(state) {
    return state?.features?.featureFlags?.team === true && state?.features?.teamData !== false;
  }

  // The owner's sentence under the Force local switch; '' while Team does not apply.
  function forceLocalTeamNote(state) {
    return teamApplies(state) ? jt('offline.localOnly.teamNote', 'Also turns Team off on this PC: no hosting, no joined teams, no shared GPU.') : '';
  }

  function createForceLocalDialog(win) {
    const factory = win.rendererIdeConfirmDialog?.createIdeConfirmDialog;
    const overlay = win.inventoryHelpOverlay?.createHelpOverlay;
    if (typeof factory !== 'function' || typeof overlay !== 'function') return null;
    return factory({ document: win.document, actionButton: win.inventoryActionButton, helpOverlayFactory: overlay, hostId: 'forceLocalTeamConfirmOverlay' });
  }

  // The host state the team store already holds (main pushes it), or null when it holds none.
  function storedHostState(win) {
    try { return win.rendererTeamStore?.getTeamStore?.().snapshot().host || null; } catch (_error) { return null; }
  }

  // Before Force local is turned on: asks only while this PC's team server runs; true to go on. The store's host state
  // is read first, main asked only when it holds none. Team not applying, a host state that cannot be read or no dialog
  // switches at once.
  async function confirmForceLocal({ state = null, win = windowRef, dialog = null } = {}) {
    if (!teamApplies(state)) return true;
    let host = storedHostState(win);
    if (!host) {
      try { host = (await win.jennyShell.team.hostStatus())?.host || null; } catch (_error) { return true; }
    }
    if (!host || host.state !== 'running') return true;
    const ask = dialog || createForceLocalDialog(win);
    if (!ask || typeof ask.confirm !== 'function') return true;
    try {
      return (await ask.confirm({ title: jt('offline.localOnly.label', 'Force local inference'),
        message: jt('offline.localOnly.teamConfirm', 'Turn on Force local? The team server on this PC stops and everyone is disconnected until you turn it off.'),
        confirmLabel: jt('settings.team.net.turnOn', 'Turn on'), cancelLabel: jt('common.cancel', 'Cancel') })) === true;
    } finally {
      if (!dialog) ask.dispose?.();
    }
  }

  // Render inventory switches into a stable .settings-toggle-list container.
  // Delegates to the shared lazy-renderers helper so the resolve/build logic
  // lives in one place; passes the module-local escaper for byte-identical output.
  function renderOfflineToggleList(target, fields) {
    if (!target) { return; }
    const lazy = windowRef.rendererSettingsLazyRenderers
      || (nodeRequire ? nodeRequire('../shell/renderer-settings-lazy-renderers') : null);
    if (lazy && typeof lazy.renderToggleListInto === 'function') {
      lazy.renderToggleListInto(target, fields, escapeStatusText);
    } else {
      target.innerHTML = ''; // Settings scripts not loaded yet; the Settings page renders the list when it opens.
    }
  }

  // The one readiness sentence in Force local inference's help line; '' keeps the row's own baseline
  // copy (before the first payload, or when nothing more is known).
  function readinessSentence(offlineState) {
    const model = offlineState.preferredLocalModel;
    const engine = MANAGED_ENGINE_LABELS[offlineState.selectedManagedEngine];
    if (offlineState.resolved === false) return '';
    if (model && engine) {
      return jt('offline.status.forceLocalEngine', 'Blocks every cloud model. Not usable with {model} yet: it runs on {engine}.', { model, engine });
    }
    if (!model) return jt('offline.status.forceLocalNoModel', 'Blocks every cloud model. Pick an Ollama model as the local default.');
    if (offlineState.localChatReady) return jt('offline.status.forceLocalReady', 'Blocks every cloud model. Ready with {model}.', { model });
    const reason = offlineState.unavailableReason || offlineState.summary;
    return reason ? jt('offline.status.forceLocalReason', 'Blocks every cloud model. {reason}', { reason }) : '';
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
        selectedManagedEngine: String(source.selectedManagedEngine || '').trim().toLowerCase(),
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

    function renderOfflineManager() {
      const { offlineLocalOnlyList } = getDomSnapshot();
      const offlineState = state.offline || normalizeOfflineState({});
      // E64: with Team on, the owner's sentence follows the switch's own description.
      const teamNote = forceLocalTeamNote(state);
      renderOfflineToggleList(offlineLocalOnlyList, [{
        id: 'offlineLocalOnlyToggle',
        label: jt('offline.localOnly.label', 'Force local inference'),
        description: readinessSentence(offlineState) + (teamNote ? ' ' + teamNote : ''),
        checked: offlineState.mode === 'local_only',
      }]);
      renderComposerOfflineLabel(offlineState);
      // An open Quick settings modal repaints its Force local status from the new state.
      try { windowRef?.rendererQuickSettingsModalController?.refreshOffline?.(); } catch (_e) { /* best-effort */ }
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

  return { createOfflineManager, renderComposerPosture: renderComposerOfflineLabel, confirmForceLocal, forceLocalTeamNote, teamApplies };
});
