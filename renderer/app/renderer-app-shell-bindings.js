(function (root) {
  'use strict';

  const noop = () => {};

  function bindComposerV2Decorations(ctx) {
    const {
      state,
      documentRef,
      dom,
      controllers,
      callbacks,
    } = ctx;
    const {
      chatShellController,
      multiStreamController,
    } = controllers;
    const {
      appendClientLog,
      getSessionMessages,
      setSessionMessages,
      renderAll,
      registerCleanup,
    } = callbacks;

    if (!chatShellController?.composerV2) {
      return;
    }
    const composerV2RenderModule = root.rendererComposerV2Render;
    const composerModeChipsContainer = documentRef.querySelector('#composerModeChips');
    if (
      composerModeChipsContainer
      && composerV2RenderModule
      && typeof composerV2RenderModule.createComposerModeChipsRenderer === 'function'
    ) {
      try {
        const composerModeChipsAnnouncer = composerModeChipsContainer.querySelector('#composerModeChipsAnnouncer');
        const composerModeChipsRenderer = composerV2RenderModule.createComposerModeChipsRenderer({
          container: composerModeChipsContainer,
          controller: chatShellController.composerV2,
          getSessionId: () => state.currentSessionId,
          announcer: composerModeChipsAnnouncer,
          // Wave G: plan-mode chip state = the active session's persisted
          // plan_mode, falling back to the sticky runtime draft. Click is
          // delegated by renderer-chat-event-settings-bindings (the
          // runtime-prefs owner); render-pipeline-chrome keeps it synced.
          getPlanMode: () => {
            const active = (Array.isArray(state.sessions) ? state.sessions : [])
              .find((session) => session?.id === state.currentSessionId) || null;
            return active ? active.plan_mode === true : state.runtimeDraft?.planMode === true;
          },
        });
        registerCleanup(() => composerModeChipsRenderer?.destroy?.());
      } catch (error) {
        appendClientLog('WARN', 'composer.mode_chip_mount_failed', {
          message: String(error?.message || error || ''),
        });
      }
    }

    /* D3: model pill — chip trigger for the static #composerModelPopover
     * (which hosts the real model/effort selects, so all existing
     * population/sync/change wiring keeps working). insertAdjacentHTML so
     * the popover markup inside the slot survives the mount. */
    const composerModelPillSlot = documentRef.querySelector('#composerModelPillSlot');
    const inventoryRef = root.inventory || null;
    if (
      composerModelPillSlot
      && inventoryRef?.chip
      && !composerModelPillSlot.querySelector('[data-inv-chip="composer-model"]')
    ) {
      try {
        composerModelPillSlot.insertAdjacentHTML('afterbegin', inventoryRef.chip({
          id: 'composer-model',
          domId: 'composerModelPill',
          label: 'Model',
          hasPopup: true,
          ariaControls: 'composerModelPopover',
          ariaLabel: 'Model and reasoning effort',
          title: 'Model and reasoning effort',
          className: 'composer-model-pill',
        }));
      } catch (error) {
        appendClientLog('WARN', 'composer.model_pill_mount_failed', {
          message: String(error?.message || error || ''),
        });
      }
    }

    /* The picker drives the hidden model and effort carrier selects, keeping
     * the existing save and reconciliation wiring untouched while it owns
     * the composer pill and popover presentation. */
    const composerModelPickerModule = root.rendererComposerModelPicker || null;
    if (composerModelPickerModule && typeof composerModelPickerModule.createComposerModelPicker === 'function') {
      try {
        const composerModelPicker = composerModelPickerModule.createComposerModelPicker({ state, documentRef });
        composerModelPicker.bind();
        composerModelPicker.syncPill();
        registerCleanup(() => composerModelPicker.dispose());
      } catch (error) {
        appendClientLog('WARN', 'composer.model_picker_mount_failed', { message: String(error?.message || error || '') });
      }
    }

    const composerAttachmentTray = documentRef.querySelector('#attachmentTray');
    const composerAttachmentPreviewPill = documentRef.querySelector('#composerAttachmentPreviewPill');
    if (
      composerAttachmentTray
      && composerAttachmentPreviewPill
      && composerV2RenderModule
      && typeof composerV2RenderModule.createComposerAttachmentTrayPreviewRenderer === 'function'
    ) {
      try {
        const composerAttachmentPreviewRenderer = composerV2RenderModule.createComposerAttachmentTrayPreviewRenderer({
          tray: composerAttachmentTray,
          pill: composerAttachmentPreviewPill,
        });
        composerAttachmentTray.setAttribute('data-composer-v2', 'on');
        composerAttachmentPreviewPill.setAttribute('data-composer-v2', 'on');
        registerCleanup(() => composerAttachmentPreviewRenderer?.destroy?.());
      } catch (error) {
        appendClientLog('WARN', 'composer.attachment_preview_mount_failed', {
          message: String(error?.message || error || ''),
        });
      }
    }

    const composerV2FailedSendNotice = documentRef.querySelector('#composerV2FailedSendNotice');
    if (
      composerV2FailedSendNotice
      && dom.chatTimeline
      && composerV2RenderModule
      && typeof composerV2RenderModule.createComposerFailedSendNoticeRenderer === 'function'
    ) {
      try {
        const composerV2FailedSendNoticeRenderer = composerV2RenderModule.createComposerFailedSendNoticeRenderer({
          noticeNode: composerV2FailedSendNotice,
          chatThread: dom.chatTimeline,
          getCurrentSessionId: () => state.currentSessionId,
          getMessagesForSession: (sessionId) => getSessionMessages(sessionId),
          getRetryAvailability: ({ failure }) =>
            chatShellController.getFailedPayloadRetryAvailability?.(failure?.payload_id)
              || { available: false, reason: 'The original failed payload is unavailable.' },
          onRetry: ({ failure }) => {
            Promise.resolve(chatShellController.retryFailedPayload?.(failure?.payload_id))
              .catch(() => { /* startPromptSend surfaces its own send errors */ });
          },
          onDismiss: ({ sessionId, messageId, failure }) => {
            chatShellController.dismissFailedPayload?.(failure?.payload_id);
            if (!sessionId || !messageId) return;
            const current = getSessionMessages(sessionId);
            if (!Array.isArray(current) || !current.length) return;
            let changed = false;
            const next = current.map((msg) => {
              if (!msg || String(msg.id || '').trim() !== messageId) return msg;
              if (!msg.send_failure || msg.send_failure.dismissed === true) return msg;
              changed = true;
              return { ...msg, send_failure: { ...msg.send_failure, dismissed: true } };
            });
            if (changed) {
              setSessionMessages(sessionId, next, `session_${sessionId}`);
              try { renderAll?.(); } catch (_err) { /* noop */ }
            }
          },
        });
        composerV2FailedSendNotice.setAttribute('data-composer-v2', 'on');
        registerCleanup(() => composerV2FailedSendNoticeRenderer?.destroy?.());
      } catch (error) {
        appendClientLog('WARN', 'composer.failed_send_notice_mount_failed', {
          message: String(error?.message || error || ''),
        });
      }
    }

    if (
      dom.sendButton
      && composerV2RenderModule
      && typeof composerV2RenderModule.createComposerBlockedSendTooltipRenderer === 'function'
    ) {
      try {
        const composerBlockedSendTooltipRenderer = composerV2RenderModule.createComposerBlockedSendTooltipRenderer({
          sendButton: dom.sendButton,
          getReason: () => {
            const reasons = composerV2RenderModule.BLOCKED_SEND_REASONS || {};
            const sessionId = String(state.currentSessionId || '').trim();
            if (!sessionId) return reasons.NO_SESSION;
            if (!state.auth?.authenticated) return reasons.NOT_AUTHENTICATED;
            if (state.backend?.phase === 'preflight') return reasons.BACKEND_PREFLIGHT;
            if (state.backend?.phase && state.backend.phase !== 'ready') return reasons.BACKEND_NOT_READY;
            const sessionForBatch = (state.sessions || []).find((s) => s && s.id === sessionId);
            if (sessionForBatch && sessionForBatch.pending_question_batch) return reasons.INTERACTIVE_PENDING;
            const sessionBusy = Boolean(multiStreamController?.isStreamingForSession?.(sessionId))
              || Boolean(state.activeStreamSessionId && state.activeStreamSessionId === sessionId);
            if (sessionBusy) return reasons.STREAMING;
            const draft = String(dom.chatInput?.value || '').trim();
            const hasAttachments = Array.isArray(state.attachments?.queued) && state.attachments.queued.length > 0;
            if (!draft && !hasAttachments) return reasons.EMPTY_DRAFT;
            // The composer vision gate's sr-only reason (#composerSendDisabledReason) beats the generic fallback.
            return String(dom.sendButton.ownerDocument?.getElementById?.('composerSendDisabledReason')?.textContent || '').trim() || reasons.UNAVAILABLE;
          },
        });
        registerCleanup(() => composerBlockedSendTooltipRenderer?.destroy?.());
      } catch (error) {
        appendClientLog('WARN', 'composer.blocked_send_tooltip_mount_failed', {
          message: String(error?.message || error || ''),
        });
      }
    }
  }

  const { bindShellEventControllers, bindAttachments } = root.rendererAppShellBindingsControllers;

  function registerShellCleanups(ctx) {
    const { windowRef, documentRef, state, controllers, modules, refs, callbacks, constants } = ctx;
    const {
      chatShellController,
      settingsShellController,
      contextPanelController,
      workspaceChromeController,
      workspaceStateController,
      pinToTopController,
      chatWayfinderController,
      thinkingIndicator,
      lifecycleController,
      shellStatusController,
    } = controllers;
    const {
      disposeCometPersonality,
      disposeComposerHolo,
      disposeSpriteHolo,
      disposeViewportController,
      refreshSnapshots,
      registerCleanup,
    } = callbacks;

    chatShellController?.bind?.();
    registerCleanup(() => chatShellController?.dispose?.());
    registerCleanup(() => settingsShellController?.dispose?.());
    if (contextPanelController) {
      contextPanelController.bind();
      registerCleanup(() => contextPanelController.dispose?.());
    }
    registerCleanup(() => workspaceChromeController?.dispose?.());
    registerCleanup(() => workspaceStateController?.dispose?.());
    registerCleanup(() => modules.contextUsageModule?.clearAllUsage?.());
    registerCleanup(() => disposeViewportController?.());
    pinToTopController?.bind();
    registerCleanup(() => pinToTopController?.dispose?.());
    chatWayfinderController?.bind?.();
    registerCleanup(() => chatWayfinderController?.dispose?.());
    registerCleanup(() => {
      const frame = refs.thinkingIndicatorRenderFrame.get();
      if (frame) {
        windowRef.cancelAnimationFrame(frame);
        refs.thinkingIndicatorRenderFrame.set(0);
      }
      thinkingIndicator?.dispose?.();
    });
    registerCleanup(() => disposeCometPersonality());
    registerCleanup(() => disposeComposerHolo?.());
    registerCleanup(() => disposeSpriteHolo?.());
    // includeModels:false is load-bearing, not a micro-optimisation. This poller
    // is created unconditionally with autoStart and is NOT view-gated, so on the
    // chat view it still ticks every 15s. Passing no options left
    // refreshOptions.includeModels undefined, which passes the `!== false` test
    // in renderer-snapshot-refresh.js -- so every tick ran full Ollama catalog
    // discovery: 2 loopback HTTP calls, an atomic catalog-cache file replace and
    // an INFO log, up to 480 requests and 240 file replaces an hour.
    //
    // Model-inclusive refreshes still happen at the three points that need them:
    // the model-library controller's refreshModelPickers below (no options → keeps
    // models), settings/models section activation via ensureSettingsSectionReady,
    // and the post-load/pull terminal state.
    const refreshSnapshotsPoller = (globalThis.rendererSettingsSnapshotPoll || {}).createSnapshotPoller?.({
      windowRef, task: () => refreshSnapshots({ includeModels: false }), intervalMs: 15000,
    }) || null;
    registerCleanup(() => refreshSnapshotsPoller?.stop());
    registerCleanup(() => {
      if (lifecycleController && typeof lifecycleController.disposeLifecycleController === 'function') {
        try { lifecycleController.disposeLifecycleController(); } catch (_e) { /* best-effort teardown */ }
      }
    });
    registerCleanup(() => {
      if (shellStatusController && typeof shellStatusController.dispose === 'function') {
        try { shellStatusController.dispose(); } catch (_e) { /* best-effort teardown */ }
      }
    });
    settingsShellController?.bind?.();
    settingsShellController?.ensureSettingsSectionReady?.('proactive');
    settingsShellController?.ensureSettingsSectionReady?.('memories');

    // Model library (Settings > Models "Model library" group, model_management_ui
    // flag): self-contained sibling controller, no-ops entirely when the flag is
    // off. Reuses refreshSnapshots (models.list + renderSettings) as the shared
    // picker-refresh path so the Composer model selector stays in sync.
    const modelTuningConfirmFactory = windowRef.rendererIdeConfirmDialog?.createIdeConfirmDialog;
    const modelTuningHelpOverlayFactory = windowRef.inventoryHelpOverlay?.createHelpOverlay;
    const modelTuningConfirmDialog = typeof modelTuningConfirmFactory === 'function'
      && typeof modelTuningHelpOverlayFactory === 'function'
      ? modelTuningConfirmFactory({
        document: documentRef || windowRef.document,
        actionButton: windowRef.inventoryActionButton,
        helpOverlayFactory: modelTuningHelpOverlayFactory,
        hostId: 'modelTuningContextRestartConfirmOverlay',
      })
      : null;
    const modelTuningDrawerController = (windowRef.rendererModelTuningDrawer || {})
      .createModelTuningDrawerController?.({
        state,
        windowRef,
        documentRef: documentRef || windowRef.document,
        overlayManager: controllers.overlayManager || null,
        getStreamingSessionIds: () => controllers.multiStreamController?.getStreamingSessionIds?.()
          || (String(state.activeStreamSessionId || '').trim() ? [String(state.activeStreamSessionId).trim()] : []),
        confirmDialog: modelTuningConfirmDialog,
        onEngineSettingsChanged: (localEngines) => modelLibrarySectionController?.syncEngineSettings?.(localEngines),
      }) || null;
    controllers.modelTuningDrawerController = modelTuningDrawerController;
    windowRef.rendererModelTuningDrawerController = modelTuningDrawerController;
    registerCleanup(() => {
      modelTuningDrawerController?.dispose?.();
      if (windowRef.rendererModelTuningDrawerController === modelTuningDrawerController) {
        windowRef.rendererModelTuningDrawerController = null;
      }
    });
    const modelLibraryController = (windowRef.rendererModelLibrary || {}).createModelLibraryController?.({
      state,
      windowRef,
      documentRef: documentRef || windowRef.document,
      appendClientLog: (...a) => callbacks.appendClientLog?.(...a),
      refreshModelPickers: () => { callbacks.refreshSnapshots?.().catch(() => null); },
      openModelTuning: (modelId, restoreFocusTo, options) => modelTuningDrawerController?.open?.(modelId, restoreFocusTo, options),
    }) || null;
    modelLibraryController?.bind?.();
    modelLibraryController?.render?.();
    registerCleanup(() => modelLibraryController?.dispose?.());

    const modelLibrarySectionController = (windowRef.rendererSettingsModelLibrarySection || {})
      .createModelLibrarySectionController?.({
        state,
        windowRef,
        documentRef: documentRef || windowRef.document,
        appendClientLog: (...a) => callbacks.appendClientLog?.(...a),
        showToastMessage: (...a) => callbacks.showToastMessage?.(...a),
        refreshModelPickers: () => Promise.resolve(callbacks.refreshSnapshots?.()).catch(() => null),
        openModelTuning: (modelId, restoreFocusTo, options) => modelTuningDrawerController?.open?.(modelId, restoreFocusTo, options),
        openSettingsSection: (...a) => callbacks.openSettingsSection?.(...a),
      }) || null;
    modelLibrarySectionController?.bind?.();
    modelLibrarySectionController?.render?.();
    registerCleanup(() => modelLibrarySectionController?.dispose?.());
    if (windowRef.jennyShell?.features?.onChanged) {
      registerCleanup(windowRef.jennyShell.features.onChanged(() => {
        modelLibraryController?.syncFeatureState?.();
      }));
    }

    // Flag-gated Settings sibling controllers (MCP servers + Knowledge folders
    // in the Tools card, Ollama engine health in the Models card): created +
    // bound in the sibling bindings file to keep this file under the line
    // ceiling. Their flags are absent from the boot seed and hydrate AFTER this
    // runs, so bootstrapAppShell re-activates them via reactivateSettingsSections
    // once the real flags land (the 0d0118d hydration-race class).
    const settingsSectionsBinding = (root.rendererAppShellBindingsMcp || {})
      .bindSettingsSectionControllers?.({
        state, windowRef, documentRef: documentRef || windowRef.document, callbacks, constants, registerCleanup, controllers,
      }) || null;
    ctx.controllers.reactivateSettingsSections = () => {
      settingsSectionsBinding?.reactivate?.();
      modelLibraryController?.syncFeatureState?.();
      modelLibrarySectionController?.syncFeatureState?.();
    };

    // Workspace-root nudge (Step 7): self-contained sibling controller, no-ops
    // entirely when workspace_root_nudge is off. No change-event API exists
    // for the workspace root (grepped), so re-evaluation piggybacks on the
    // same 15s snapshot-refresh cadence as refreshSnapshotsIntervalId above,
    // plus an explicit re-render right after the picker action resolves.
    const workspaceRootNudgeController = (windowRef.rendererWorkspaceRootNudge || {}).createWorkspaceRootNudgeController?.({
      state, windowRef,
      documentRef: documentRef || windowRef.document,
      appendClientLog: (...a) => callbacks.appendClientLog?.(...a), chooseWorkspaceRoot: (...a) => callbacks.chooseWorkspaceRoot?.(...a),
    }) || null;
    controllers.workspaceRootNudgeController = workspaceRootNudgeController; workspaceRootNudgeController?.bind?.(); workspaceRootNudgeController?.render?.();
    const workspaceRootNudgePoller = (globalThis.rendererSettingsSnapshotPoll || {}).createSnapshotPoller?.({
      windowRef,
      task: () => {
        workspaceRootNudgeController?.render?.();
        // Same tick keeps the Model library rows in sync with state.modelList
        // (refreshed by the shell's periodic refreshSnapshots) — cheap no-op
        // render-skip when nothing changed.
        modelLibraryController?.syncFromState?.();
        modelLibrarySectionController?.syncFromState?.();
      },
      intervalMs: 15000,
    }) || null;
    registerCleanup(() => workspaceRootNudgePoller?.stop());
    registerCleanup(() => workspaceRootNudgeController?.dispose?.());
  }

  async function reconcileBackendStatusAfterBindings(ctx) {
    const { state, windowRef, callbacks } = ctx;
    const {
      appendClientLog,
      applySetupBackendStatus,
      getRendererElapsedMs,
      handleLifecycleBackendStatus,
      loadSessions,
      refreshApprovedMemories,
      refreshDefaultChatTimelineBatch4Preference,
      refreshPendingMemories,
      refreshSnapshots,
      refreshSuggestions,
      renderAll,
      runStartupAuditAutoSend,
      syncBackendActivityFromStatus,
    } = callbacks;

    if (!windowRef.jennyShell?.backend?.getStatus) {
      return;
    }
    try {
      const backendStatus = await windowRef.jennyShell.backend.getStatus();
      const previousPhase = String(state.backend?.phase || '').trim().toLowerCase();
      const nextPhase = String(backendStatus?.phase || '').trim().toLowerCase();
      const previousSettled = previousPhase === 'ready' || previousPhase === 'failed';
      const nextTransient = !nextPhase || nextPhase === 'starting' || nextPhase === 'retrying';
      if (previousSettled && nextTransient) {
        return;
      }
      const phaseChanged = previousPhase !== nextPhase;
      const detailChanged = String(state.backend?.detail || '') !== String(backendStatus?.detail || '');
      const stageChanged = String(state.backend?.startupStage || '') !== String(backendStatus?.startupStage || '');
      if (!phaseChanged && !detailChanged && !stageChanged) {
        return;
      }
      state.backend = backendStatus;
      refreshDefaultChatTimelineBatch4Preference();
      syncBackendActivityFromStatus(backendStatus);
      handleLifecycleBackendStatus(backendStatus);
      try { applySetupBackendStatus(backendStatus); } catch (_setupStatusErr) { /* ignore */ }
      if (nextPhase === 'ready') {
        appendClientLog('INFO', 'renderer.backend_ready_reconciled', {
          elapsedMs: getRendererElapsedMs(),
          startupStage: backendStatus?.startupStage || '',
          startupMs: Number(backendStatus?.startupMs || 0),
          previousPhase,
        });
        state.auth = await windowRef.jennyShell.auth.getState();
        if (state.auth.authenticated) {
          // #9: only one path loads sessions/snapshots per ready transition. See the
          // backend.onStatus handler in renderer-chat-event-utils.js -- whichever
          // observes 'ready' first sets the guard; the other skips the duplicate load.
          if (!state.backendReadyLoadHandled) {
            state.backendReadyLoadHandled = true;
            await loadSessions();
            await refreshSnapshots();
          }
          Promise.allSettled([
            refreshApprovedMemories({ force: true }),
            refreshPendingMemories({ force: true }),
          ]).then((results) => {
            const rejected = results.filter((result) => result.status === 'rejected');
            if (!rejected.length) {
              return;
            }
            appendClientLog('WARN', 'chat.reconcile_memories_failed', {
              message: rejected.map((result) => String(result.reason?.message || result.reason || '')).join(' | '),
            });
          });
        }
        refreshSuggestions().catch((err) => {
          appendClientLog('WARN', 'chat.reconcile_suggestions_failed', {
            message: String(err?.message || err),
          });
        });
        await runStartupAuditAutoSend();
      }
      renderAll();
    } catch (error) {
      appendClientLog('WARN', 'renderer.backend_status_reconcile_failed', {
        message: error?.message || String(error),
      });
    }
  }

  async function bootstrapAppShell(ctx) {
    const { state, constants, controllers, callbacks, windowRef } = ctx;
    const {
      activateCometIfEnabled,
      activateSurfaceEffect,
      appendClientLog,
      applySurfaceEffect,
      bootstrap,
      ensureComposerFeatureStateLoaded,
      hydrateCachedLazyShellState,
      initSetupController,
      logSurfaceEffectFailure,
      queueDeferredStartupTask,
      queueStartupLazyHydration,
      refreshComposerToolToggles,
      refreshSuggestions,
      refreshWorkspaceRootState,
      renderAll,
      runStartupAuditAutoSend,
      showShellErrorToast,
      signalRendererReadyOnce,
      syncWorkspaceFromStore,
    } = callbacks;
    try {
      await bootstrap({ signalRendererReadyOnce });
      const hydrationResults = await Promise.allSettled([syncWorkspaceFromStore(), refreshWorkspaceRootState(), ensureComposerFeatureStateLoaded()]);
      ['workspace', 'workspace_root'].forEach((operation, index) => { if (hydrationResults[index].status !== 'rejected') { return; } // 'features' dropped: ensureComposerFeatureStateLoaded() already reports its own bootstrap_failed internally and can never reject (F3)
        appendClientLog('WARN', `${operation}.bootstrap_failed`, {
          message: String(hydrationResults[index].reason?.message || hydrationResults[index].reason || '').slice(0, 500),
        });
      });
      // Reconcile the nudge after authoritative feature/root state lands.
      controllers.workspaceRootNudgeController?.render?.();
      // Same placeholder-flag boot race: the Settings sibling controllers bound
      // in registerShellCleanups before the real knowledge_layer /
      // ollama_tray_remediation / mcp_management_ui flags landed, so their groups
      // never mounted. Re-activate now that the real flags are in state.
      controllers.reactivateSettingsSections?.();
      // The first setActiveView ran on placeholder flags (top_nav_shell absent);
      // re-apply chrome now that the real flags are in state. The startup
      // overlay still covers the workspace, so no visible double-layout.
      windowRef.rendererTopNavShellController?.applyViewChrome?.();
      // Same placeholder-flag boot race: the palette's first bind saw no
      // command_palette key and disarmed itself. Re-entrant no-op if bound.
      controllers.commandPaletteController?.bind?.();
      controllers.chatShellController?.bind?.();
      // bind() first runs in registerShellCleanups, BEFORE the feature state
      // above is loaded — so the stream subscription latches onto the
      // placeholder feature flags (no stream_envelope_v2 key). The initial
      // features.getState() pull does not fire features.onChanged, so resync
      // the subscription mode explicitly now that the real flags are in state.
      controllers.chatShellController?.resyncStreamSubscriptionMode?.();
      hydrateCachedLazyShellState();
      activateCometIfEnabled();
      await reconcileBackendStatusAfterBindings(ctx); if (['chat', 'logs', 'settings'].includes(state.ui.activeView)) { controllers.shellStatusController?.notifyBootViewReady?.(); } // F1: gate curtain dismissal on real hydration, not just first paint -- Home/IDE gate on their own hydration already
      try { await initSetupController(); } catch (_setupInitErr) { /* logged inside controller */ }
      renderAll();
      try {
        applySurfaceEffect();
        activateSurfaceEffect(state.ui.appearance.surfaceEffectId || 'none');
      } catch (err) {
        logSurfaceEffectFailure(constants.SURFACE_EFFECT_STAGES.ACTIVATE, state.ui.appearance.surfaceEffectId, err);
      }
      signalRendererReadyOnce();
      await runStartupAuditAutoSend();
      queueStartupLazyHydration();

      queueDeferredStartupTask(
        () => refreshComposerToolToggles(),
        { event: 'composer.tool_toggles_bootstrap_failed', rerender: true }
      );
      // Keep the composer tools chip in sync when tools.* config changes from
      // any surface (Settings view, chip popover, another window).
      if (windowRef.jennyShell?.features?.onChanged) {
        callbacks.registerCleanup(windowRef.jennyShell.features.onChanged(() => {
          refreshComposerToolToggles().catch(() => {});
        }));
      }
      queueDeferredStartupTask(
        () => Promise.race([
          refreshSuggestions().catch(() => {}),
          new Promise((resolve) => windowRef.setTimeout(resolve, 4000)),
        ]),
        { event: 'suggestions.bootstrap_failed', rerender: false }
      );
    } catch (error) {
      appendClientLog('ERROR', 'renderer.bootstrap_failed', {
        message: error?.message || String(error),
        stack: error?.stack || '',
      });
      try {
        windowRef.jennyShell?.diagnostics?.reportRendererError?.({
          phase: 'bootstrap',
          message: error?.message || String(error),
          stack: error?.stack || '',
        });
      } catch (_diagnosticError) {
        // Best-effort only.
      }
      try {
        showShellErrorToast('Jenny hit a startup problem, but the shell is opening so you can recover.', {
          title: 'Startup Error',
          source: constants.TOAST_SOURCE.chatStream,
          dedupeKey: `${constants.TOAST_SOURCE.chatStream}:startup-error`,
        });
      } catch (_toastError) {
        // Best-effort only.
      }
      signalRendererReadyOnce(); controllers.shellStatusController?.notifyBootViewReady?.(); // F1: never strand the curtain behind an unexpected bootstrap failure
    }
  }

  async function bindAppShell(ctx = {}) {
    const normalized = {
      windowRef: root,
      documentRef: root.document,
      constants: {},
      dom: {},
      controllers: {},
      modules: {},
      refs: {},
      callbacks: {},
      ...ctx,
    };
    normalized.callbacks = {
      appendClientLog: noop,
      registerCleanup: noop,
      ...normalized.callbacks,
    };
    bindComposerV2Decorations(normalized);
    (root.rendererAppShellBindingsOverlayManager || {}).bindOverlayManager?.(normalized);
    bindShellEventControllers(normalized);
    bindAttachments(normalized);
    (root.rendererAppShellBindingsDisplayMedia || {}).bindDisplayMediaPicker?.(normalized);
    registerShellCleanups(normalized);
    await bootstrapAppShell(normalized);
  }

  root.rendererAppShellBindings = {
    bindAppShell,
  };
})(window);
