/* renderer/chat/renderer-chat-event-settings-bindings.js
 * This factory owns chat toast actions and composer settings/preferences bindings and receives dependencies through its factory arguments.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    let capability;
    try { capability = require('../shared/model-capability-utils'); } catch (_err) { capability = null; }
    module.exports = factory(capability, require('../shared/async-fence'), require('./renderer-composer-v2-state'), require('../../reasoning-effort-profiles'));
    return;
  }
  root.rendererChatEventSettingsBindings = factory(root.modelCapabilityUtils, root.rendererAsyncFence, root.rendererComposerV2State, root.reasoningEffortProfiles);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (modelCapabilityUtils, asyncFence, composerState, reasoningEffortProfiles) {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  // Acknowledges this warning copy only; backend tool permissions remain separate.
  // One acknowledgement per project (owner, 2026-09-28): v1 was one global key.
  const AUTO_RUN_WARNING_ACK_PREFIX = 'jenny.auto-run-warning-ack.v2:';
  const GENERAL_PROJECT_ID = 'project_general';
  function createSettingsEventBindings(deps) {
    const {
      // DOM
      toastViewport,
      composerModelSelect,
      composerEffortSelect,
      // state + constants
      state,
      TOAST_SOURCE,
      ACTIVITY_SCOPE,
      // callbacks
      dismissToast,
      appendClientLog,
      showShellErrorToast,
      showToastMessage,
      toErrorMessage,
      getRuntimePreferenceSnapshot,
      runRuntimePreferenceActivity,
      getCurrentRuntimePreferences,
      // Split view W2-2a: reads the record of the session a pane's rail names.
      getRuntimePreferencesFromSession,
      showComposerActionError,
      setComposerStatusNotice,
      clearComposerStatusNotice,
      // controllers
      toastActionHandlers,
      getAutoRunWarningStorage = () => globalThis.localStorage,
    } = deps || {};

    const isPlanCapableModel = modelCapabilityUtils?.isPlanCapableModel;
    const formatModelLabel = modelCapabilityUtils?.formatModelLabel;

    const PLAN_MODE_HINT_OWNER = 'plan-mode-hint';
    const runModeActivityGate = asyncFence.createGenerationGate();
    const RUN_MODE_TOAST_COPY = Object.freeze({
      ask: jt('composer.runMode.askToast', 'Run mode: Ask — Jenny asks before acting'),
      auto: jt('composer.runMode.autoToast', 'Run mode: Auto — tools run without asking'),
      plan: jt('composer.runMode.planToast', 'Run mode: Plan — read-only planning'),
      propose: jt('composer.runMode.proposeToast', 'Run mode: Propose — Jenny suggests changes for you to review'),
    });
    let runModeControlRegistered = false;
    const autoRunConfirmedProjects = new Set();
    let autoRunConfirmInFlight = null;
    let autoRunConfirmDialog = null;
    // Split view W2-2a: the preferences of the session `sessionId` names (a
    // pane's rail); no id, no reader or an unlisted session reads the current
    // (active) preferences exactly as before.
    function preferencesFor(sessionId) {
      const id = String(sessionId || '').trim();
      const session = id && typeof getRuntimePreferencesFromSession === 'function'
        ? (Array.isArray(state?.sessions) ? state.sessions : []).find((entry) => entry?.id === id)
        : null;
      return session ? getRuntimePreferencesFromSession(session) : getCurrentRuntimePreferences?.();
    }
    // An explicit target rides the preference activity; none keeps today's args.
    function withSession(activity, sessionId) {
      return sessionId ? { ...activity, sessionId } : activity;
    }

    // Effective model the next send will use, mirroring backend-chat-stream's
    // resolveModel precedence: session preferred model first, then the
    // runtime's current/active model.
    function resolvePlanModeModelName(sessionId) {
      const preferred = String(
        (preferencesFor(sessionId)?.preferredModel) || ''
      ).trim();
      if (preferred) {
        return preferred;
      }
      return String(
        state?.models?.status?.currentModel
          || state?.modelList?.active_model
          || ''
      ).trim();
    }

    function maybeShowPlanModeModelHint(planModeNext, sessionId) {
      if (
        typeof setComposerStatusNotice !== 'function'
        || typeof isPlanCapableModel !== 'function'
      ) {
        return;
      }
      if (!planModeNext) {
        if (typeof clearComposerStatusNotice === 'function') {
          clearComposerStatusNotice({ owner: PLAN_MODE_HINT_OWNER });
        }
        return;
      }
      const modelName = resolvePlanModeModelName(sessionId);
      if (isPlanCapableModel(modelName)) {
        return;
      }
      if (!state.ui.planModeHintShownModels) {
        state.ui.planModeHintShownModels = new Set();
      }
      const dedupeKey = modelName || '(unknown)';
      if (state.ui.planModeHintShownModels.has(dedupeKey)) {
        return;
      }
      state.ui.planModeHintShownModels.add(dedupeKey);
      const label = typeof formatModelLabel === 'function'
        ? formatModelLabel(modelName)
        : (modelName || jt('composer.runMode.currentModel', 'the current model'));
      setComposerStatusNotice(
        jt('composer.runMode.modelCapabilityWarning', 'Heads up — {model} may not follow a multi-step plan reliably. Plan mode works best with larger models.', { model: label }),
        { owner: PLAN_MODE_HINT_OWNER, tone: 'warning' }
      );
    }

    /* Split view W2-2a: the composer rail's three listeners -- model change,
       effort change, run-mode chip click -- on the given nodes. Pane 0 binds
       them inside bindSettingsEvents (its document nodes, the active session,
       today's listeners in today's order); a second pane binds them on its
       own rail with `getSessionId` = its session. The activity controller
       re-syncs that pane's rail around the write (renderSessionComposer). */
    function bindComposerRailEvents({ registerListener, listenerOptions, dom = {}, getSessionId = null, beforeRunMode = null } = {}) {
      const modelSelect = dom.composerModelSelect || null;
      const effortSelect = dom.composerEffortSelect || null;
      const runModeSlot = dom.composerRunModeSlot || null;
      const sessionOf = () => (typeof getSessionId === 'function' ? String(getSessionId() || '').trim() : '');

      registerListener(modelSelect, 'change', () => {
        if (modelSelect.getAttribute('aria-disabled') === 'true') return;
        // No selected option: the value names a model the carrier does not
        // hold (an unavailable catalog lists only Default plus the saved
        // model), so the select reads '' -- not a choice of Default. The
        // picker refuses such ids the same way (hasSelectOption); both panes.
        if (modelSelect.selectedIndex < 0) return;
        const sessionId = sessionOf();
        const previousValue = getRuntimePreferenceSnapshot(sessionId);
        const patch = { preferredModel: modelSelect.value };
        // A model swap changes the effort ladder, so the re-normalized effort
        // must ride in the SAME patch. The reasoning-effort-controls reconcile
        // only fixes the visible select and re-persists through a synthetic
        // change event that this binding drops while the control is
        // aria-disabled mid-save — the gap that let a qwen3.8 graded level
        // ride into ornith15 requests (CMP-AI-0005).
        const profiles = reasoningEffortProfiles || globalThis.reasoningEffortProfiles;
        if (typeof profiles?.normalizeManagedReasoningEffortForModel === 'function') {
          const currentEffort = profiles.normalizeReasoningEffort(
            preferencesFor(sessionId)?.reasoningEffort
          );
          let engineType = String(
            modelSelect.selectedOptions?.[0]?.dataset?.engineType || ''
          ).trim().toLowerCase();
          if (!engineType && Array.isArray(state.modelList?.data)) {
            const catalogModel = state.modelList.data.find((model) => (
              String(model?.id || '').trim() === patch.preferredModel
            ));
            engineType = String(
              catalogModel?.engine_type ?? catalogModel?.engineType ?? ''
            ).trim().toLowerCase();
          }
          const normalizedEffort = profiles.normalizeManagedReasoningEffortForModel(
            currentEffort,
            engineType,
            { modelId: patch.preferredModel }
          );
          if (normalizedEffort !== currentEffort) patch.reasoningEffort = normalizedEffort;
        }
        runRuntimePreferenceActivity(withSession({
          patch,
          scopes: patch.reasoningEffort
            ? [ACTIVITY_SCOPE.composerPreferredModel, ACTIVITY_SCOPE.composerReasoningEffort]
            : [ACTIVITY_SCOPE.composerPreferredModel],
          previousValue,
          failureMessage: () => jt('composer.settings.preferredModelSaveFailed', 'Could not save preferred model.'),
          successMessage: '',
        }, sessionId)).catch((error) => {
          showComposerActionError(error, jt('composer.settings.preferenceSaveFailedTitle', 'Preference Save Failed'));
        });
      }, listenerOptions);

      registerListener(effortSelect, 'change', () => {
        if (effortSelect.getAttribute('aria-disabled') === 'true') return;
        const sessionId = sessionOf();
        const previousValue = getRuntimePreferenceSnapshot(sessionId);
        runRuntimePreferenceActivity(withSession({
          patch: { reasoningEffort: effortSelect.value },
          scopes: [ACTIVITY_SCOPE.composerReasoningEffort],
          previousValue,
          failureMessage: () => jt('composer.settings.reasoningEffortSaveFailed', 'Could not save reasoning effort.'),
          successMessage: '',
        }, sessionId)).catch((error) => {
          showComposerActionError(error, jt('composer.settings.preferenceSaveFailedTitle', 'Preference Save Failed'));
        });
      }, listenerOptions);

      if (typeof beforeRunMode === 'function') beforeRunMode();

      registerListener(runModeSlot, 'click', (event) => {
        // The collapsed settings popover's Ask | Auto | Plan segments (spec
        // 2026-09-26 §4 step 4) set that exact mode; setRunMode keeps the Auto
        // confirmation and the no-op when unchanged. A disabled chip (plugin
        // read-only session) disables its segments too.
        const option = event.target.closest('[data-run-mode-option]');
        if (option) {
          if (option.disabled) return;
          const sessionId = sessionOf();
          const slotChip = runModeSlot.querySelector(sessionId ? '[data-inv-chip="composer-run-mode"]' : '#composerRunModeChip');
          if (slotChip && slotChip.disabled) return;
          setRunMode(option.getAttribute('data-run-mode-option'), { source: 'click', ...(sessionId ? { sessionId, chip: slotChip } : {}) });
          return;
        }
        const chip = event.target.closest(sessionOf() ? '[data-inv-chip="composer-run-mode"]' : '#composerRunModeChip');
        if (!chip || chip.disabled) return;
        const sessionId = sessionOf();
        cycleRunMode(sessionId ? { source: 'click', sessionId, chip } : { source: 'click' });
      }, listenerOptions);
    }

    function bindSettingsEvents(registerListener, listenerOptions) {
      registerListener(toastViewport, 'click', (event) => {
        const dismissButton = event.target.closest('[data-toast-dismiss]');
        if (dismissButton) {
          event.preventDefault();
          dismissToast(dismissButton.dataset.toastDismiss);
          return;
        }
        const actionButton = event.target.closest('[data-toast-action-id]');
        if (!actionButton) {
          return;
        }
        event.preventDefault();
        const toastId = String(actionButton.dataset.toastId || '').trim();
        const actionId = String(actionButton.dataset.toastActionId || '').trim();
        const handlers = toastActionHandlers.get(toastId);
        const handler = handlers ? handlers.get(actionId) : null;
        if (typeof handler === 'function') {
          Promise.resolve(handler()).catch((error) => {
            showShellErrorToast(toErrorMessage(error, jt('toast.actionFailedMessage', 'Toast action failed.')), {
              title: jt('chat.settings.actionFailedTitle', 'Action Failed'),
              source: TOAST_SOURCE.memory,
              dedupeKey: `${TOAST_SOURCE.memory}:action:error`,
            });
          });
        }
      }, listenerOptions);

      // The rail listeners (model, effort, run-mode chip) at today's point and
      // in today's order; the gear keeps its slot between effort and run mode.
      bindComposerRailEvents({
        registerListener,
        listenerOptions,
        dom: { composerModelSelect, composerEffortSelect, composerRunModeSlot: document.getElementById('composerRunModeSlot') },
        // Split view gate (2026-09-26): with two panes pane 0's rail writes pane
        // 0's session, not the focused one; one pane keeps today's active path.
        getSessionId: () => (Array.isArray(state.panes?.panes) && state.panes.panes.length > 1
          ? globalThis.rendererPaneVisibilityUtils?.resolvePaneSessionId?.(state, 0) || '' : ''),
      });

      // Register unconditionally: mount order between this binding pass and the
      // composer chip renderer must not matter (per-call isRunModeAvailable guards).
      globalThis.rendererRunModeControl = runModeControl;
      runModeControlRegistered = true;
      globalThis.rendererHealthPillController?.refreshRunModeFacet?.();
      listenerOptions?.signal?.addEventListener?.('abort', dispose, { once: true });

    }

    function currentRunMode(sessionId) {
      const current = preferencesFor(sessionId) || {};
      return composerState.projectRunMode(current.runMode, {
        planModeFallback: current.planMode === true,
      }).runMode;
    }

    // A pane's rail hands its own chip; the shortcuts read pane 0's.
    function isRunModeAvailable(chipEl) {
      const chip = chipEl || document.getElementById('composerRunModeChip');
      return Boolean(chip && !chip.disabled);
    }

    // The project the send's session belongs to; a session without one is in
    // the General project.
    function autoRunProjectId(sessionId) {
      const id = String(sessionId || state?.currentSessionId || '').trim();
      const session = id && Array.isArray(state?.sessions)
        ? state.sessions.find((entry) => entry?.id === id) : null;
      return String(session?.project_id || '').trim() || GENERAL_PROJECT_ID;
    }

    // Asked on the first Auto SEND in each project, never while switching
    // modes (owner, dogfood FG-003); the acknowledgement persists per project.
    async function confirmAutoRun(sessionId = '') {
      const projectId = autoRunProjectId(sessionId);
      if (autoRunConfirmedProjects.has(projectId)) return Promise.resolve(true);
      try {
        if (getAutoRunWarningStorage()?.getItem(AUTO_RUN_WARNING_ACK_PREFIX + projectId) === '1') {
          autoRunConfirmedProjects.add(projectId);
          return true;
        }
      } catch (_error) { /* Unavailable storage keeps the warning enabled. */ }
      if (autoRunConfirmInFlight) {
        if (autoRunConfirmInFlight.projectId === projectId) return autoRunConfirmInFlight.promise;
        // One dialog at a time: another project's prompt settles first.
        const other = autoRunConfirmInFlight.promise;
        return other.then(() => confirmAutoRun(sessionId));
      }
      const confirmDialogFactory = globalThis.rendererIdeConfirmDialog?.createIdeConfirmDialog;
      const helpOverlayFactory = globalThis.inventoryHelpOverlay?.createHelpOverlay;
      if (typeof confirmDialogFactory !== 'function' || typeof helpOverlayFactory !== 'function') {
        if (autoRunConfirmDialog !== false) {
          appendClientLog?.('WARN', 'run_mode.auto_confirm_unavailable', {
            confirmDialogAvailable: typeof confirmDialogFactory === 'function',
            helpOverlayAvailable: typeof helpOverlayFactory === 'function',
          });
          autoRunConfirmDialog?.dispose?.();
          autoRunConfirmDialog = false;
        }
        return Promise.resolve(false);
      }
      if (!autoRunConfirmDialog) {
        autoRunConfirmDialog = confirmDialogFactory({
          document,
          actionButton: globalThis.inventoryActionButton,
          helpOverlayFactory,
          hostId: 'composerAutoRunConfirmOverlay',
        });
      }
      let pending;
      pending = Promise.resolve(autoRunConfirmDialog.confirm({
        title: jt('runMode.autoConfirm.title', 'Turn on Auto run?'),
        message: jt('runMode.autoConfirm.bodyWithIdle', 'In Auto, tools run without asking — including commands that change files. Python and explicit denies still ask; blocked commands are refused.') + ' ' + (Number(state.unattendedGuardMinutes) > 0
          ? jt('runMode.autoConfirm.idleOn', 'Inactivity pause is enabled after {minutes} minutes without keyboard or mouse input.', { minutes: state.unattendedGuardMinutes })
          : jt('runMode.autoConfirm.idleOff', 'Inactivity pause is off: Auto continues while you are away.')) + ' ' + jt('runMode.autoConfirm.idleSettings', 'Change this in Settings > Tools > Pause Auto when you are away.'),
        confirmLabel: jt('runMode.autoConfirm.confirm', 'Turn on Auto'),
        cancelLabel: jt('common.cancel', 'Cancel'),
        variant: 'danger',
      })).then((confirmed) => {
        if (autoRunConfirmInFlight?.promise !== pending) return false;
        if (confirmed === true) {
          autoRunConfirmedProjects.add(projectId);
          try {
            getAutoRunWarningStorage()?.setItem(AUTO_RUN_WARNING_ACK_PREFIX + projectId, '1');
          } catch (_error) { /* Keep the explicit acknowledgement for this renderer. */ }
        }
        return confirmed === true;
      }, () => false).finally(() => {
        if (autoRunConfirmInFlight?.promise === pending) autoRunConfirmInFlight = null;
      });
      autoRunConfirmInFlight = { projectId, promise: pending };
      return pending;
    }

    // The send boundary's gate (renderer-send-utils startPromptSend): every send
    // path -- composer, edit-and-resend, regenerate, Resume -- asks here, so the
    // warning no longer depends on the chip having asked first (FG-003).
    // A plain `true` when nothing needs asking keeps the send synchronous (its
    // queued-context stash is atomic); a Promise only while the dialog is due.
    function confirmAutoSend(sessionId = '') {
      if (currentRunMode(sessionId) !== 'auto' || autoRunConfirmedProjects.has(autoRunProjectId(sessionId))) return true;
      return confirmAutoRun(sessionId);
    }

    function persistRunMode(next, source, activityToken, sessionId) {
      const previousValue = getRuntimePreferenceSnapshot(sessionId);
      return runRuntimePreferenceActivity(withSession({
        patch: { runMode: next },
        scopes: [ACTIVITY_SCOPE.composerRunMode],
        previousValue,
        failureMessage: () => jt('composer.settings.runModeSaveFailed', 'Could not save run mode.'),
        successMessage: '',
      }, sessionId)).then((result) => {
        if (!runModeActivityGate.isCurrent(activityToken)) return false;
        if (result?.ignored === true && result.reason === 'superseded') return false;
        const persisted = currentRunMode(sessionId);
        if (persisted !== next) return false;
        maybeShowPlanModeModelHint(persisted === 'plan', sessionId);
        const toastCopy = RUN_MODE_TOAST_COPY[persisted];
        const announcer = document.getElementById('composerModeChipsAnnouncer');
        if (announcer) announcer.textContent = toastCopy;
        showToastMessage?.(toastCopy, {
          title: jt('composer.runMode.title', 'Run mode'),
          tone: 'info',
          source: TOAST_SOURCE.composerAction,
          dedupeKey: `${TOAST_SOURCE.composerAction}:run-mode:${source}`,
        });
        globalThis.rendererHealthPillController?.refreshRunModeFacet?.();
        return true;
      }).catch((error) => {
        if (!runModeActivityGate.isCurrent(activityToken)) return false;
        maybeShowPlanModeModelHint(currentRunMode(sessionId) === 'plan', sessionId);
        showComposerActionError(error, jt('composer.settings.runModeUpdateFailedTitle', 'Run Mode Update Failed'));
        return false;
      });
    }

    // `sessionId` (a pane's rail) targets that session; omitted, the active one.
    function setRunMode(mode, { source = 'control', sessionId = '', chip = null } = {}) {
      if (!isRunModeAvailable(chip)) return false;
      const previousRunMode = currentRunMode(sessionId);
      const next = composerState.normalizeRunMode(mode);
      if (next === previousRunMode) return Promise.resolve(false);
      runModeActivityGate.bump();
      const activityToken = runModeActivityGate.capture();
      // Switching modes never asks: the first Auto send in each project does
      // (confirmAutoSend at the send boundary), so cycling Ask -> Auto ->
      // Plan no longer stops on a dialog (owner, dogfood FG-003). The one
      // exception: leaving Propose with suggestions still waiting asks Keep or
      // Discard (row 35); nothing is applied either way.
      if (previousRunMode !== 'propose') return persistRunMode(next, source, activityToken, sessionId);
      return resolveLeavePropose(sessionId).then((choice) => {
        if (choice === 'cancel' || !runModeActivityGate.isCurrent(activityToken)) return false;
        return persistRunMode(next, source, activityToken, sessionId);
      });
    }

    let leaveProposeDialog = null;
    // Resolves 'none' (nothing pending), 'keep', 'discard' (after the discard
    // landed) or 'cancel'. A failed lookup keeps the suggestions and lets the
    // switch go ahead: they stay reviewable in Changes.
    async function resolveLeavePropose(sessionId) {
      const api = globalThis.jennyShell?.suggestedChanges;
      const id = String(sessionId || state?.currentSessionId || '').trim();
      let pending;
      try {
        pending = Number((await api?.list?.({ sessionId: id }))?.pending_count) || 0;
      } catch (_error) { return 'keep'; }
      if (!id || pending <= 0) return 'none';
      const factory = globalThis.rendererIdeConfirmDialog?.createIdeConfirmDialog;
      const helpOverlayFactory = globalThis.inventoryHelpOverlay?.createHelpOverlay;
      if (typeof factory !== 'function' || typeof helpOverlayFactory !== 'function') return 'keep';
      leaveProposeDialog = leaveProposeDialog || factory({ document, actionButton: globalThis.inventoryActionButton,
        helpOverlayFactory, hostId: 'composerLeaveProposeOverlay' });
      const choice = await leaveProposeDialog.choose({
        title: jt('runMode.leavePropose.title', 'Leave Propose?'),
        message: jt('runMode.leavePropose.message', 'Some suggested changes are still waiting for your review. Nothing has been applied.'),
        choices: [
          { action: 'keep', label: jt('runMode.leavePropose.keep', 'Keep them'), variant: 'primary' },
          { action: 'discard', label: jt('runMode.leavePropose.discard', 'Discard them'), variant: 'danger' },
        ],
      });
      if (choice !== 'discard') return choice === 'keep' ? 'keep' : 'cancel';
      const result = await api.discardPending({ sessionId: id }).catch(() => null);
      if (result?.ok !== true) {
        showComposerActionError(new Error(String(result?.error || 'discard_failed')),
          jt('runMode.leavePropose.discardFailed', 'Could not discard the suggested changes'));
        return 'cancel';
      }
      return 'discard';
    }

    function cycleRunMode(options = {}) {
      if (!isRunModeAvailable(options.chip)) return false;
      const target = options.sessionId ? { sessionId: options.sessionId, chip: options.chip || null } : {};
      return setRunMode(composerState.nextRunMode(currentRunMode(options.sessionId)), {
        source: options.source || 'shortcut',
        ...target,
      });
    }

    function togglePlanMode(options = {}) {
      if (!isRunModeAvailable(options.chip)) return false;
      const current = currentRunMode(options.sessionId);
      const prefs = preferencesFor(options.sessionId) || {};
      const stored = prefs.prePlanRunMode === 'auto' || prefs.prePlanRunMode === 'ask' ? prefs.prePlanRunMode : '';
      const restore = stored || 'ask';
      const target = options.sessionId ? { sessionId: options.sessionId, chip: options.chip || null } : {};
      return setRunMode(current === 'plan' ? restore : 'plan', { source: 'shortcut-plan', ...target });
    }

    const runModeControl = {
      cycleRunMode,
      togglePlanMode,
      setRunMode,
      confirmAutoRun,
      confirmAutoSend,
      currentRunMode,
    };

    function dispose() {
      runModeActivityGate.bump();
      autoRunConfirmedProjects.clear();
      autoRunConfirmInFlight = null;
      autoRunConfirmDialog?.dispose?.();
      autoRunConfirmDialog = null;
      if (runModeControlRegistered && globalThis.rendererRunModeControl === runModeControl) {
        delete globalThis.rendererRunModeControl;
      }
      runModeControlRegistered = false;
    }

    return { bindSettingsEvents, bindComposerRailEvents, dispose, setRunMode };
  }

  return { createSettingsEventBindings };
});
