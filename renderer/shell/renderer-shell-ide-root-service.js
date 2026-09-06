/* renderer/shell/renderer-shell-ide-root-service.js
 *
 * Lazy Workspace IDE composition plus the renderer's single workspace-root
 * mutation facade. Callers receive choose/clear transactions; only getState
 * delegates to the legacy read bridge for compatibility. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererShellIdeRootService = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function noop() {}

  function resolveModule(globalName, requirePath) {
    if (globalRef[globalName]) {
      return globalRef[globalName];
    }
    if (typeof require === 'function') {
      try {
        return require(requirePath);
      } catch (_error) {
        /* unavailable */
      }
    }
    return {};
  }

  // Coordinator codes for the .jenny-state-directory guard (workspace-root-
  // coordinator.js _prepareTarget / prepareChoose): a plain "Workspace switch
  // blocked" toast would be misleading here since this is a permanent
  // rejection, not a transient block, so it gets its own explanatory copy.
  const STATE_DIR_ROOT_TOAST = 'This folder is Jenny\'s own internal state directory '
    + '(.jenny) and can\'t be used as the tools workspace root. Choose the folder\'s '
    + 'parent directory instead.';
  const STATE_DIR_SEGMENT_TOAST = 'The selected folder is inside Jenny\'s own internal '
    + 'state directory (.jenny) and can\'t be used as the tools workspace root. Choose '
    + 'a folder outside .jenny.';
  const STATE_DIR_REJECTION_TOASTS = {
    workspace_root_is_state_dir: STATE_DIR_ROOT_TOAST,
    workspace_root_inside_state_dir: STATE_DIR_SEGMENT_TOAST,
  };

  function unavailableOutcome(mode) {
    return {
      committed: false,
      changed: false,
      canceled: false,
      blocked: true,
      rolledBack: false,
      mode,
      stage: 'renderer',
      code: 'transition_controller_unavailable',
    };
  }

  function wireContext(value) {
    if (!value || typeof value !== 'object') return null;
    const generation = Number(value.generation);
    if (!Number.isSafeInteger(generation) || generation < 0) return null;
    const rootPath = String(value.rootPath ?? value.root_path ?? '');
    const rawRootId = value.rootId ?? value.root_id ?? null;
    return {
      root_path: rootPath,
      root_id: rawRootId == null ? null : String(rawRootId),
      generation,
      phase: String(value.phase || 'ready'),
    };
  }

  function wireCancelResult(value) {
    if (!value || typeof value !== 'object') return null;
    return {
      canceled: value.canceled === true,
      changed: value.changed === true,
      code: String(value.code || '').slice(0, 80),
    };
  }

  function wireOutcome(value) {
    const outcome = value && typeof value === 'object' ? value : {};
    const context = wireContext(outcome.context);
    const cancelResult = wireCancelResult(outcome.cancelResult || outcome.cancel_result);
    return {
      committed: outcome.committed === true,
      changed: outcome.changed === true,
      canceled: outcome.canceled === true,
      blocked: outcome.blocked === true,
      rolled_back: outcome.rolledBack === true || outcome.rolled_back === true,
      degraded: outcome.degraded === true,
      code: String(outcome.code || '').slice(0, 80),
      ...(context ? { context } : {}),
      ...(Array.isArray(outcome.blockers)
        ? { blockers: outcome.blockers.slice(0, 16).map((entry) => ({
          id: String(entry?.id || '').slice(0, 64),
          reason: String(entry?.reason || '').slice(0, 64),
        })) }
        : {}),
      ...(outcome.rollbackIncomplete === true || outcome.rollback_incomplete === true
        ? { rollback_incomplete: true }
        : {}),
      ...(cancelResult ? { cancel_result: cancelResult } : {}),
    };
  }

  function createIdeRootService(deps) {
    const options = deps || {};
    const state = options.state || {};
    const windowRef = options.windowRef || globalRef.window || globalRef;
    const surfaceDom = options.surfaceDom || {};
    const constants = options.constants || {};
    const callbacks = options.callbacks || {};
    const registerCleanup = typeof options.registerCleanup === 'function'
      ? options.registerCleanup
      : noop;
    const ideControllerUtils = options.ideControllerUtils || {};
    const ideSendUtils = options.ideSendUtils
      || resolveModule('rendererIdeSendUtils', '../features/renderer-ide-send-utils');
    const transitionUtils = options.transitionUtils
      || resolveModule('rendererWorkspaceRootTransition', './renderer-workspace-root-transition');

    let ideController = null;
    let transitionController = null;
    let externalRequestUnsubscribe = null;

    function appendLog(...args) {
      try { callbacks.appendClientLog?.(...args); } catch (_error) { /* best-effort */ }
    }

    function getBridge() {
      return windowRef?.jennyShell?.workspaceRoot || null;
    }

    function getOpenPaths() {
      return (state.ui?.ide?.openTabs || []).map((tab) => tab?.path).filter(Boolean);
    }

    function notifyFailure(outcome) {
      const showShellErrorToast = callbacks.showShellErrorToast;
      if (typeof showShellErrorToast !== 'function') {
        return;
      }
      const stateDirToast = STATE_DIR_REJECTION_TOASTS[String(outcome?.code || '')];
      if (stateDirToast) {
        try {
          showShellErrorToast(stateDirToast, {
            title: 'Workspace',
            dedupeKey: 'workspace-root:state-dir-rejected',
          });
        } catch (_error) {
          /* feedback is best-effort */
        }
        return;
      }
      const blocked = outcome?.blocked === true;
      try {
        showShellErrorToast(
          blocked
            ? 'Workspace switch blocked. Finish the active workspace operation and try again.'
            : 'Workspace switch failed. The previous workspace remains active.',
          {
            title: 'Workspace',
            dedupeKey: blocked ? 'workspace-root:transition-blocked' : 'workspace-root:transition-failed',
          }
        );
      } catch (_error) {
        /* feedback is best-effort */
      }
    }

    function notifyDegraded(outcome) {
      try {
        appendLog('WARN', 'workspace.root_transition_degraded', {
          mode: outcome?.mode || '', code: outcome?.code || outcome?.uiError?.code || 'ui_refresh_failed',
        });
        callbacks.showShellErrorToast?.(
          'Workspace changed, but some editor views may be stale. Review open files before continuing.',
          { title: 'Workspace Refresh Incomplete', dedupeKey: 'workspace-root:transition-degraded' }
        );
      } catch (_error) {
        /* diagnostics and feedback are best-effort */
      }
    }

    function ensureIdeController() {
      if (ideController) {
        return ideController;
      }
      const ideSendController = ideSendUtils.createIdeSendToJenny?.({
        state,
        getChatInput: () => callbacks.chatInput || null,
        callbacks: {
          handleCreateSession: (...args) => callbacks.handleCreateSession?.(...args),
          setActiveView: (...args) => callbacks.setActiveView?.(...args),
          syncComposerInputHeight: (...args) => callbacks.syncComposerInputHeight?.(...args),
          renderComposerState: (...args) => callbacks.renderComposerState?.(...args),
          renderAll: (...args) => callbacks.renderAll?.(...args),
          showShellErrorToast: (...args) => callbacks.showShellErrorToast?.(...args),
          appendClientLog: (...args) => callbacks.appendClientLog?.(...args),
        },
      }) || null;
      ideController = ideControllerUtils.createIdeController?.({
        state,
        workspaceRootService,
        constants: { TOAST_SOURCE: constants.TOAST_SOURCE || {} },
        getDom() {
          return {
            ideView: surfaceDom.ide?.ideView || null,
            ...(surfaceDom.ide?.getIdeDom?.() || {}),
          };
        },
        registerCleanup,
        callbacks: {
          escapeHtml: callbacks.escapeHtml,
          appendClientLog: (...args) => callbacks.appendClientLog?.(...args),
          noteScrollProgrammaticWrite: (...args) => callbacks.noteScrollProgrammaticWrite?.(...args),
          showToastMessage: (...args) => callbacks.showToastMessage?.(...args),
          showShellErrorToast: (...args) => callbacks.showShellErrorToast?.(...args),
          toErrorMessage: callbacks.toErrorMessage,
          setActiveView: (...args) => callbacks.setActiveView?.(...args),
          getTurnViewModelsForActiveSession: (...args) => callbacks.getTurnViewModelsForActiveSession?.(...args),
          onSendToJenny: (payload) => ideSendController?.handleSendToJenny?.(payload),
          activateWorkspaceSession: (...args) => callbacks.activateWorkspaceSession?.(...args),
        },
      }) || null;
      return ideController;
    }

    function ensureTransitionController() {
      if (transitionController) {
        return transitionController;
      }
      const createController = transitionUtils.createWorkspaceRootTransitionController;
      if (typeof createController !== 'function') {
        return null;
      }
      const controller = ensureIdeController();
      const closeOrchestrator = controller?.getCloseOrchestrator?.() || null;
      if (!closeOrchestrator) {
        return null;
      }
      transitionController = createController({
        getBridge,
        closeOrchestrator,
        getOpenPaths,
        appendClientLog: (...args) => appendLog(...args),
        onFailure: notifyFailure,
        confirmProcessTermination: async () => {
          const confirmDialog = controller?.getConfirmDialog?.();
          if (typeof confirmDialog?.confirm !== 'function') return false;
          return confirmDialog.confirm({
            title: 'Stop active workspace processes?',
            message: 'Active terminals and test runs belong to the current workspace and must stop before switching workspaces.',
            confirmLabel: 'Stop and Switch',
            cancelLabel: 'Cancel',
            variant: 'danger',
          });
        },
        beforePrepare: (payload) => controller?.prepareWorkspaceRootTransition?.(payload),
        onSettled: (payload) => controller?.handleWorkspaceRootSettled?.(payload),
        async onCommitted(payload) {
          let refreshError = null;
          try {
            await controller?.handleWorkspaceRootCommitted?.(payload);
          } catch (error) {
            refreshError = error;
            appendLog('WARN', 'workspace.root_ide_rehydrate_failed', {
              code: String(error?.code || 'rehydrate_failed').slice(0, 80),
            });
          }
          try {
            await callbacks.refreshWorkspaceRootDependents?.(payload);
          } catch (error) {
            refreshError = refreshError || error;
            appendLog('WARN', 'workspace.root_dependent_refresh_failed', {
              code: String(error?.code || 'refresh_failed').slice(0, 80),
            });
          }
          if (refreshError) {
            const error = new Error('Workspace root renderer synchronization failed.');
            error.code = String(refreshError?.code || 'refresh_failed').slice(0, 80);
            throw error;
          }
        },
      }) || null;
      return transitionController;
    }

    async function run(mode, request) {
      let controller;
      try {
        controller = ensureTransitionController();
      } catch (error) {
        const outcome = {
          ...unavailableOutcome(mode),
          code: 'transition_controller_init_failed',
          error: { code: String(error?.code || 'controller_init_failed').slice(0, 80) },
        };
        appendLog('ERROR', 'workspace.root_transition_init_failed', {
          mode, code: outcome.error.code,
        });
        notifyFailure(outcome);
        return outcome;
      }
      if (typeof controller?.[mode] !== 'function') {
        const outcome = unavailableOutcome(mode);
        appendLog('WARN', 'workspace.root_transition_unavailable', { mode });
        notifyFailure(outcome);
        return outcome;
      }
      const outcome = await controller[mode](request || {});
      if (outcome?.committed === true && outcome?.degraded === true) {
        notifyDegraded(outcome);
      }
      return outcome;
    }

    const workspaceRootService = {
      choose: (request) => run('choose', request),
      clear: (request) => run('clear', request),
      async getState() {
        const bridge = getBridge();
        return typeof bridge?.getState === 'function' ? bridge.getState.call(bridge) : null;
      },
      async captureContext() {
        const bridge = getBridge();
        return typeof bridge?.captureContext === 'function'
          ? bridge.captureContext.call(bridge)
          : null;
      },
    };

    async function handleExternalTransitionRequest(payload) {
      const requestId = String(payload?.request_id || '').slice(0, 128);
      const transitionId = String(payload?.transition_id || '').slice(0, 128);
      const bridge = getBridge();
      if (!requestId || !transitionId || typeof bridge?.respondExternalTransition !== 'function') {
        appendLog('WARN', 'workspace.root_external_request_invalid', {
          has_request_id: Boolean(requestId), has_transition_id: Boolean(transitionId),
        });
        return;
      }
      let outcome;
      try {
        const controller = ensureTransitionController();
        if (typeof controller?.external !== 'function') {
          outcome = unavailableOutcome('external');
        } else {
          outcome = await controller.external(payload);
        }
      } catch (error) {
        outcome = {
          ...unavailableOutcome('external'),
          code: String(error?.code || 'external_transition_failed').slice(0, 80),
        };
      }
      try {
        const response = await bridge.respondExternalTransition({
          request_id: requestId,
          transition_id: transitionId,
          outcome: wireOutcome(outcome),
        });
        if (response?.accepted !== true) {
          appendLog('WARN', 'workspace.root_external_response_refused', {
            code: String(response?.code || 'response_refused').slice(0, 80),
          });
        }
      } catch (error) {
        appendLog('WARN', 'workspace.root_external_response_failed', {
          code: String(error?.code || 'response_failed').slice(0, 80),
        });
      }
    }

    function bindExternalTransitionRequests() {
      const bridge = getBridge();
      if (externalRequestUnsubscribe || typeof bridge?.onExternalTransitionRequested !== 'function') {
        return;
      }
      const unsubscribe = bridge.onExternalTransitionRequested(handleExternalTransitionRequest);
      externalRequestUnsubscribe = typeof unsubscribe === 'function' ? unsubscribe : noop;
      registerCleanup(() => {
        try { externalRequestUnsubscribe?.(); } catch (_error) { /* already detached */ }
        externalRequestUnsubscribe = null;
      });
    }

    bindExternalTransitionRequests();

    return {
      ensureIdeController,
      workspaceRootService,
    };
  }

  return { createIdeRootService, wireOutcome };
});
