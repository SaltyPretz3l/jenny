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
      ask: 'Run mode: Ask — Jenny asks before acting',
      auto: 'Run mode: Auto — tools run without asking',
      plan: 'Run mode: Plan — read-only planning',
    });
    let runModeControlRegistered = false;
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
        : (modelName || 'the current model');
      setComposerStatusNotice(
        `Heads up — ${label} may not follow a multi-step plan reliably. `
          + 'Plan mode works best with larger models.',
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
            showShellErrorToast(toErrorMessage(error, 'Toast action failed.'), {
              title: 'Action Failed',
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
          failureMessage: () => 'Could not save preferred model.',
          successMessage: '',
        }).catch((error) => {
          showComposerActionError(error, 'Preference Save Failed');
        });
      }, listenerOptions);

      registerListener(composerEffortSelect, 'change', () => {
        if (composerEffortSelect.getAttribute('aria-disabled') === 'true') return;
        const previousValue = getRuntimePreferenceSnapshot();
        runRuntimePreferenceActivity({
          patch: { reasoningEffort: composerEffortSelect.value },
          scopes: [ACTIVITY_SCOPE.composerReasoningEffort],
          previousValue,
          failureMessage: () => 'Could not save reasoning effort.',
          successMessage: '',
        }).catch((error) => {
          showComposerActionError(error, 'Preference Save Failed');
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

    function setRunMode(mode, { source = 'control' } = {}) {
      if (!isRunModeAvailable()) return false;
      const previousRunMode = currentRunMode();
      const next = composerState.normalizeRunMode(mode);
      if (next === previousRunMode) return Promise.resolve(false);
      const previousValue = getRuntimePreferenceSnapshot();
      runModeActivityGate.bump();
      const activityToken = runModeActivityGate.capture();
      return runRuntimePreferenceActivity({
        patch: { runMode: next },
        scopes: [ACTIVITY_SCOPE.composerRunMode],
        previousValue,
        failureMessage: () => 'Could not save run mode.',
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
          title: 'Run mode',
          tone: 'info',
          source: TOAST_SOURCE.composerAction,
          dedupeKey: `${TOAST_SOURCE.composerAction}:run-mode:${source}`,
        });
        return true;
      }).catch((error) => {
        if (!runModeActivityGate.isCurrent(activityToken)) return false;
        maybeShowPlanModeModelHint(currentRunMode() === 'plan');
        showComposerActionError(error, 'Run Mode Update Failed');
        return false;
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

    const runModeControl = { cycleRunMode, togglePlanMode, setRunMode };

    function dispose() {
      runModeActivityGate.bump();
      if (runModeControlRegistered && globalThis.rendererRunModeControl === runModeControl) {
        delete globalThis.rendererRunModeControl;
      }
      runModeControlRegistered = false;
    }

    return { bindSettingsEvents, dispose, setRunMode };
  }

  return { createSettingsEventBindings };
});
