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
  function createSettingsEventBindings(deps) {
    const {
      // DOM
      toastViewport,
      composerModelSelect,
      composerEffortSelect,
      composerSettingsButton,
      openComposerSettingsViewButton,
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
      showComposerActionError,
      closeComposerPopover,
      openComposerPopover,
      setActiveView,
      setComposerStatusNotice,
      clearComposerStatusNotice,
      // controllers
      toastActionHandlers,
    } = deps || {};

    const isPlanCapableModel = modelCapabilityUtils?.isPlanCapableModel;
    const formatModelLabel = modelCapabilityUtils?.formatModelLabel;

    const PLAN_MODE_HINT_OWNER = 'plan-mode-hint';
    const runModeActivityGate = asyncFence.createGenerationGate();
    const RUN_MODE_TOAST_COPY = Object.freeze({
      ask: jt('composer.runMode.askToast', 'Run mode: Ask — Jenny asks before acting'),
      auto: jt('composer.runMode.autoToast', 'Run mode: Auto — tools run without asking'),
      plan: jt('composer.runMode.planToast', 'Run mode: Plan — read-only planning'),
    });
    let runModeControlRegistered = false;
    let autoRunConfirmed = false;
    let autoRunConfirmInFlight = null;
    let autoRunConfirmDialog = null;
    // Effective model the next send will use, mirroring backend-chat-stream's
    // resolveModel precedence: session preferred model first, then the
    // runtime's current/active model.
    function resolvePlanModeModelName() {
      const preferred = String(
        (getCurrentRuntimePreferences()?.preferredModel) || ''
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

    function maybeShowPlanModeModelHint(planModeNext) {
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
      const modelName = resolvePlanModeModelName();
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

      registerListener(composerModelSelect, 'change', () => {
        if (composerModelSelect.getAttribute('aria-disabled') === 'true') return;
        const previousValue = getRuntimePreferenceSnapshot();
        const patch = { preferredModel: composerModelSelect.value };
        // A model swap changes the effort ladder, so the re-normalized effort
        // must ride in the SAME patch. The reasoning-effort-controls reconcile
        // only fixes the visible select and re-persists through a synthetic
        // change event that this binding drops while the control is
        // aria-disabled mid-save — the gap that let a qwen3.8 graded level
        // ride into ornith15 requests (CMP-AI-0005).
        const profiles = reasoningEffortProfiles || globalThis.reasoningEffortProfiles;
        if (typeof profiles?.normalizeManagedReasoningEffortForModel === 'function') {
          const currentEffort = profiles.normalizeReasoningEffort(
            getCurrentRuntimePreferences()?.reasoningEffort
          );
          let engineType = String(
            composerModelSelect.selectedOptions?.[0]?.dataset?.engineType || ''
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
        runRuntimePreferenceActivity({
          patch,
          scopes: patch.reasoningEffort
            ? [ACTIVITY_SCOPE.composerPreferredModel, ACTIVITY_SCOPE.composerReasoningEffort]
            : [ACTIVITY_SCOPE.composerPreferredModel],
          previousValue,
          failureMessage: () => jt('composer.settings.preferredModelSaveFailed', 'Could not save preferred model.'),
          successMessage: '',
        }).catch((error) => {
          showComposerActionError(error, jt('composer.settings.preferenceSaveFailedTitle', 'Preference Save Failed'));
        });
      }, listenerOptions);

      registerListener(composerEffortSelect, 'change', () => {
        if (composerEffortSelect.getAttribute('aria-disabled') === 'true') return;
        const previousValue = getRuntimePreferenceSnapshot();
        runRuntimePreferenceActivity({
          patch: { reasoningEffort: composerEffortSelect.value },
          scopes: [ACTIVITY_SCOPE.composerReasoningEffort],
          previousValue,
          failureMessage: () => jt('composer.settings.reasoningEffortSaveFailed', 'Could not save reasoning effort.'),
          successMessage: '',
        }).catch((error) => {
          showComposerActionError(error, jt('composer.settings.preferenceSaveFailedTitle', 'Preference Save Failed'));
        });
      }, listenerOptions);

      registerListener(composerSettingsButton, 'click', () => {
        if (composerSettingsButton.getAttribute('aria-disabled') === 'true') return;
        if (state.ui.composerPopoverOpen) {
          closeComposerPopover({ restoreFocus: true });
          return;
        }
        openComposerPopover();
      }, listenerOptions);

      const composerRunModeSlot = document.getElementById('composerRunModeSlot');
      registerListener(composerRunModeSlot, 'click', (event) => {
        const chip = event.target.closest('#composerRunModeChip');
        if (!chip || chip.disabled) return;
        cycleRunMode({ source: 'click' });
      }, listenerOptions);

      // Register unconditionally: mount order between this binding pass and the
      // composer chip renderer must not matter (per-call isRunModeAvailable guards).
      globalThis.rendererRunModeControl = runModeControl;
      runModeControlRegistered = true;
      globalThis.rendererHealthPillController?.refreshRunModeFacet?.();
      listenerOptions?.signal?.addEventListener?.('abort', dispose, { once: true });

      registerListener(openComposerSettingsViewButton, 'click', () => {
        closeComposerPopover();
        setActiveView('settings');
      }, listenerOptions);
    }

    function currentRunMode() {
      const current = getCurrentRuntimePreferences?.() || {};
      return composerState.projectRunMode(current.runMode, {
        planModeFallback: current.planMode === true,
      }).runMode;
    }

    function isRunModeAvailable() {
      const chip = document.getElementById('composerRunModeChip');
      return Boolean(chip && !chip.disabled);
    }

    async function confirmAutoRun() {
      if (autoRunConfirmed) return Promise.resolve(true);
      if (autoRunConfirmInFlight) return autoRunConfirmInFlight;
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
        message: jt('runMode.autoConfirm.body', 'In Auto, tools run without asking — including commands that change files. Python and explicit denies still ask; blocked commands are refused. Do not leave Jenny running unattended.'),
        confirmLabel: jt('runMode.autoConfirm.confirm', 'Turn on Auto'),
        cancelLabel: jt('common.cancel', 'Cancel'),
        variant: 'danger',
      })).then((confirmed) => {
        if (autoRunConfirmInFlight !== pending) return false;
        if (confirmed === true) autoRunConfirmed = true;
        return confirmed === true;
      }, () => false).finally(() => {
        if (autoRunConfirmInFlight === pending) autoRunConfirmInFlight = null;
      });
      autoRunConfirmInFlight = pending;
      return pending;
    }

    function persistRunMode(next, source, activityToken) {
      const previousValue = getRuntimePreferenceSnapshot();
      return runRuntimePreferenceActivity({
        patch: { runMode: next },
        scopes: [ACTIVITY_SCOPE.composerRunMode],
        previousValue,
        failureMessage: () => jt('composer.settings.runModeSaveFailed', 'Could not save run mode.'),
        successMessage: '',
      }).then((result) => {
        if (!runModeActivityGate.isCurrent(activityToken)) return false;
        if (result?.ignored === true && result.reason === 'superseded') return false;
        const persisted = currentRunMode();
        if (persisted !== next) return false;
        maybeShowPlanModeModelHint(persisted === 'plan');
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
        maybeShowPlanModeModelHint(currentRunMode() === 'plan');
        showComposerActionError(error, jt('composer.settings.runModeUpdateFailedTitle', 'Run Mode Update Failed'));
        return false;
      });
    }

    function setRunMode(mode, { source = 'control' } = {}) {
      if (!isRunModeAvailable()) return false;
      const previousRunMode = currentRunMode();
      const next = composerState.normalizeRunMode(mode);
      if (next === previousRunMode) return Promise.resolve(false);
      runModeActivityGate.bump();
      const activityToken = runModeActivityGate.capture();
      // Leaving Plan mode restores the session's pre-plan mode; that is a
      // restore, not a fresh choice of Auto, so it skips the switch-time
      // confirmation. The first Auto send is still gated by the composer.
      if (next !== 'auto' || source === 'shortcut-plan') return persistRunMode(next, source, activityToken);
      return confirmAutoRun().then((confirmed) => {
        if (!confirmed || !runModeActivityGate.isCurrent(activityToken)) return false;
        return persistRunMode(next, source, activityToken);
      });
    }

    function cycleRunMode(options = {}) {
      if (!isRunModeAvailable()) return false;
      return setRunMode(composerState.nextRunMode(currentRunMode()), {
        source: options.source || 'shortcut',
      });
    }

    function togglePlanMode() {
      if (!isRunModeAvailable()) return false;
      const current = currentRunMode();
      const prefs = getCurrentRuntimePreferences?.() || {};
      const stored = prefs.prePlanRunMode === 'auto' || prefs.prePlanRunMode === 'ask' ? prefs.prePlanRunMode : '';
      const restore = stored || 'ask';
      return setRunMode(current === 'plan' ? restore : 'plan', { source: 'shortcut-plan' });
    }

    const runModeControl = {
      cycleRunMode,
      togglePlanMode,
      setRunMode,
      confirmAutoRun,
      currentRunMode,
    };

    function dispose() {
      runModeActivityGate.bump();
      autoRunConfirmed = false;
      autoRunConfirmInFlight = null;
      autoRunConfirmDialog?.dispose?.();
      autoRunConfirmDialog = null;
      if (runModeControlRegistered && globalThis.rendererRunModeControl === runModeControl) {
        delete globalThis.rendererRunModeControl;
      }
      runModeControlRegistered = false;
    }

    return { bindSettingsEvents, dispose, setRunMode };
  }

  return { createSettingsEventBindings };
});
