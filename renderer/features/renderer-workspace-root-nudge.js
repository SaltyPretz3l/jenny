/* renderer/features/renderer-workspace-root-nudge.js
 *
 * Slim dismissible hint above the composer when no workspace root is configured,
 * gated by the default-on workspace_root_nudge flag.
 *
 * Truthful "no workspace root" signal: `state.workspaceRoot.path`, populated
 * by `refreshWorkspaceRootState()` from
 * `window.jennyShell.workspaceRoot.getState()`. Status can legitimately be
 * `checking` while a persisted or newly selected directory is probed, so it
 * must not drive this one-time configuration hint. Invalid-root guidance is
 * owned by Settings rather than a misleading "No workspace root set" chip.
 *
 * "Set workspace root" reuses the existing picker seam, the same one the
 * Settings › Tools surface's "Choose folder…" button calls: does NOT build a
 * new picker or mint a new IPC channel.
 *
 * Dismiss is session-scoped (module-level variable, not persisted config):
 * it clears if the module is freshly reloaded (new window/session), and does
 * not resurrect on re-render within the same session. Re-render also happens
 * whenever the workspace root becomes configured, so the chip disappears
 * live without a page reload.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.rendererWorkspaceRootNudge = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var asyncFence = (root && root.rendererAsyncFence)
    || (typeof require === 'function' ? require('../shared/async-fence') : null);
  var CHIP_ID = 'workspaceRootNudge';
  var COMPOSER_WRAP_SELECTOR = '#composerWrap';

  function resolveActionButton() {
    return (root && root.inventoryActionButton)
      || (typeof require === 'function' ? require('../inventory/action-button') : null)
      || null;
  }

  function buildChipHtml() {
    var actionButton = resolveActionButton();
    return ''
      + '<div class="workspace-root-nudge" id="' + CHIP_ID + '" role="status" data-workspace-root-nudge>'
      + '<span class="workspace-root-nudge-icon" aria-hidden="true">⚠</span>'
      + '<span class="workspace-root-nudge-text">No workspace root set &mdash; file tools are off for this chat.</span>'
      + actionButton({
        plain: true,
        className: 'workspace-root-nudge-action',
        label: 'Set workspace root',
        dataset: { 'workspace-root-nudge-action': 'set-root' },
      })
      + actionButton({
        plain: true,
        className: 'workspace-root-nudge-dismiss',
        label: '✕',
        ariaLabel: 'Dismiss workspace root hint',
        title: 'Dismiss workspace root hint',
        dataset: { 'workspace-root-nudge-action': 'dismiss' },
      })
      + '</div>';
  }

  function createWorkspaceRootNudgeController(deps) {
    var d = deps || {};
    var state = d.state || {};
    var windowRef = d.windowRef || (typeof globalThis !== 'undefined' ? globalThis : {});
    var documentRef = d.documentRef || windowRef.document || null;
    var appendClientLog = typeof d.appendClientLog === 'function' ? d.appendClientLog : function noop() {};
    var chooseWorkspaceRoot = typeof d.chooseWorkspaceRoot === 'function' ? d.chooseWorkspaceRoot : null;
    var disposalFence = asyncFence.createDisposalFence();

    // Session-scoped dismiss: lives on the controller instance, not on
    // `state` and not persisted to config/disk. A fresh controller instance
    // (new window/session bootstrap) starts un-dismissed.
    var dismissed = false;

    function isFeatureEnabled() {
      return Boolean(
        state
        && state.features
        && state.features.featureFlags
        && state.features.featureFlags.workspace_root_nudge === true
      );
    }

    function isWorkspaceRootConfigured() {
      var workspaceRootState = state && state.workspaceRoot;
      return Boolean(String(workspaceRootState && workspaceRootState.path || '').trim());
    }

    function findComposerWrap() {
      if (!documentRef || typeof documentRef.querySelector !== 'function') {
        return null;
      }
      return documentRef.querySelector(COMPOSER_WRAP_SELECTOR);
    }

    function removeExistingChip() {
      var existing = documentRef && typeof documentRef.getElementById === 'function'
        ? documentRef.getElementById(CHIP_ID)
        : null;
      if (existing && existing.parentNode) {
        existing.parentNode.removeChild(existing);
      }
    }

    function render() {
      if (disposalFence.isDisposed()) return;
      if (!isFeatureEnabled() || dismissed || isWorkspaceRootConfigured()) {
        removeExistingChip();
        return;
      }
      var wrap = findComposerWrap();
      if (!wrap) {
        return;
      }
      var existing = documentRef.getElementById(CHIP_ID);
      if (existing) {
        // Already mounted and still applicable — leave it in place.
        return;
      }
      wrap.insertAdjacentHTML('afterbegin', buildChipHtml());
    }

    function handleSetRootClick() {
      if (typeof chooseWorkspaceRoot !== 'function') {
        appendClientLog('WARN', 'workspace_root_nudge.choose_unavailable', {});
        return;
      }
      Promise.resolve(chooseWorkspaceRoot())
        .then(disposalFence.guard(function () {
          render();
        }))
        .catch(disposalFence.guard(function (error) {
          appendClientLog('WARN', 'workspace_root_nudge.choose_failed', {
            message: error && error.message ? error.message : String(error),
          });
        }));
    }

    function handleDismissClick() {
      dismissed = true;
      render();
    }

    function handleClick(event) {
      var target = event && event.target;
      if (!target || typeof target.closest !== 'function') {
        return;
      }
      var actionEl = target.closest('[data-workspace-root-nudge-action]');
      if (!actionEl) {
        return;
      }
      var action = actionEl.getAttribute('data-workspace-root-nudge-action');
      if (action === 'set-root') {
        handleSetRootClick();
      } else if (action === 'dismiss') {
        handleDismissClick();
      }
    }

    function bind() {
      if (disposalFence.isDisposed() || !documentRef || typeof documentRef.addEventListener !== 'function') {
        return;
      }
      documentRef.addEventListener('click', handleClick);
    }

    function dispose() {
      if (!disposalFence.dispose()) return;
      if (documentRef && typeof documentRef.removeEventListener === 'function') {
        documentRef.removeEventListener('click', handleClick);
      }
      removeExistingChip();
    }

    return {
      bind: bind,
      dispose: dispose,
      render: render,
      isFeatureEnabled: isFeatureEnabled,
      isWorkspaceRootConfigured: isWorkspaceRootConfigured,
    };
  }

  return {
    createWorkspaceRootNudgeController: createWorkspaceRootNudgeController,
  };
});
