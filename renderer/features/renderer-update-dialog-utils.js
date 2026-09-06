/**
 * renderer/features/renderer-update-dialog-utils.js
 *
 * Renderer helpers for update status and release-note dialogs.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.rendererUpdateDialogUtils = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var asyncFence = (root && root.rendererAsyncFence)
    || (typeof require === 'function' ? require('../shared/async-fence') : null);

  function escapeHtml(value) {
    return String(value || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function normalizeStatus(value) {
    var status = String(value || '').trim().toLowerCase();
    return status || 'idle';
  }

  function normalizeVersion(value) {
    return String(value || '').trim();
  }

  function progressText(progress) {
    var source = progress && typeof progress === 'object' ? progress : {};
    var percent = Number(source.percent);
    if (!Number.isFinite(percent)) {
      return '';
    }
    return Math.round(Math.max(0, Math.min(percent, 100))) + '%';
  }

  function deriveUpdateDialogViewModel(state) {
    var source = state && typeof state === 'object' ? state : {};
    var status = normalizeStatus(source.status);
    var latestVersion = normalizeVersion(source.latestVersion);
    var currentVersion = normalizeVersion(source.currentVersion);
    var versionLabel = latestVersion || currentVersion || 'current version';
    var summary = String(source.reason || source.lastError || '').trim();
    var releaseNotesMarkdown = String(source.releaseNotesMarkdown || '').trim();
    var closeAction = { id: 'close', label: 'Close', variant: 'secondary' };
    var actions;
    var progress = null;
    var tone = 'default';
    var title;
    var statusLabel;
    var eyebrow = currentVersion ? 'Current ' + currentVersion : 'Application update';

    if (status === 'disabled') {
      title = 'Updates unavailable';
      statusLabel = 'Disabled';
      summary = summary || 'Updates are available only in packaged Windows builds.';
      tone = 'muted';
      actions = [closeAction];
    } else if (status === 'checking') {
      title = 'Checking for updates';
      statusLabel = 'Checking';
      summary = summary || 'Looking for the latest Jenny release.';
      actions = [closeAction];
    } else if (status === 'available') {
      title = 'Jenny ' + versionLabel + ' is ready';
      statusLabel = 'Ready';
      summary = summary || 'Review the release notes before downloading.';
      actions = [
        { id: 'close', label: 'Later', variant: 'secondary' },
        { id: 'skip', label: 'Skip This Version', variant: 'secondary' },
        { id: 'download', label: 'Download Update', variant: 'primary' },
      ];
    } else if (status === 'downloading') {
      title = 'Downloading Jenny ' + versionLabel;
      statusLabel = progressText(source.downloadProgress) || 'Downloading';
      summary = summary || 'The installer is downloading in the background.';
      progress = {
        value: Number(source.downloadProgress && source.downloadProgress.percent) || 0,
        max: 100,
        label: 'Download progress',
        displayText: progressText(source.downloadProgress),
      };
      actions = [{ id: 'close', label: 'Close', variant: 'secondary' }];
    } else if (status === 'downloaded') {
      title = 'Jenny ' + versionLabel + ' is ready to install';
      statusLabel = 'Downloaded';
      summary = summary || 'Restart Jenny to finish installing the update.';
      progress = {
        value: 100,
        max: 100,
        label: 'Download complete',
        displayText: '100%',
      };
      actions = [
        { id: 'close', label: 'Later', variant: 'secondary' },
        { id: 'install', label: 'Restart and Install', variant: 'primary' },
      ];
    } else if (status === 'installing') {
      title = 'Installing Jenny ' + versionLabel;
      statusLabel = 'Installing';
      summary = summary || 'Jenny will restart when the installer takes over.';
      actions = [{ id: 'close', label: 'Close', variant: 'secondary' }];
    } else if (status === 'error') {
      title = 'Update check failed';
      statusLabel = 'Needs attention';
      tone = 'danger';
      summary = summary || 'The updater could not complete that request.';
      actions = [
        closeAction,
        { id: 'check', label: 'Try Again', variant: 'primary' },
      ];
    } else {
      title = 'Jenny is up to date';
      statusLabel = 'Idle';
      summary = summary || 'No update is waiting right now.';
      actions = [
        closeAction,
        { id: 'check', label: 'Check Again', variant: 'secondary' },
      ];
    }

    return {
      status: status,
      title: title,
      eyebrow: eyebrow,
      statusLabel: statusLabel,
      summary: summary,
      tone: tone,
      progress: progress,
      releaseNotesMarkdown: releaseNotesMarkdown,
      actions: actions,
    };
  }

  function resolveRenderStepModal(deps) {
    if (deps && typeof deps.renderStepModal === 'function') {
      return deps.renderStepModal;
    }
    if (root && root.inventory && root.inventory.stepModal && root.inventory.stepModal.renderStepModal) {
      return root.inventory.stepModal.renderStepModal;
    }
    if (root && root.inventoryStepModal && root.inventoryStepModal.renderStepModal) {
      return root.inventoryStepModal.renderStepModal;
    }
    if (typeof require === 'function') {
      try {
        return require('../inventory/step-modal').renderStepModal;
      } catch (_error) {
        return null;
      }
    }
    return null;
  }

  function resolveMarkdownRenderer(deps) {
    if (deps && typeof deps.renderMarkdown === 'function') {
      return deps.renderMarkdown;
    }
    if (root && root.markdownUtils && typeof root.markdownUtils.renderMarkdown === 'function') {
      return root.markdownUtils.renderMarkdown;
    }
    return function fallbackMarkdown(markdown) {
      return '<p>' + escapeHtml(markdown) + '</p>';
    };
  }

  function resolveStepModalLifecycleFactory(deps) {
    if (deps && typeof deps.createStepModalLifecycle === 'function') {
      return deps.createStepModalLifecycle;
    }
    if (root && root.inventoryStepModal && typeof root.inventoryStepModal.createLifecycle === 'function') {
      return root.inventoryStepModal.createLifecycle;
    }
    if (typeof require === 'function') {
      try { return require('../inventory/step-modal').createLifecycle; }
      catch (_error) { return null; }
    }
    return null;
  }

  function renderUpdateDialog(state, deps) {
    var view = deriveUpdateDialogViewModel(state);
    var renderStepModal = resolveRenderStepModal(deps || {});
    if (!renderStepModal) {
      return '';
    }
    var renderMarkdown = resolveMarkdownRenderer(deps || {});
    var releaseNotesHtml = view.releaseNotesMarkdown
      ? '<div class="update-dialog-notes">' + renderMarkdown(view.releaseNotesMarkdown) + '</div>'
      : '';
    var bodyHtml = '<p class="update-dialog-summary">' + escapeHtml(view.summary) + '</p>'
      + releaseNotesHtml;
    return renderStepModal({
      id: 'update-dialog',
      tone: view.tone,
      eyebrow: view.eyebrow,
      title: view.title,
      status: view.statusLabel,
      summary: '',
      progress: view.progress,
      bodyHtml: bodyHtml,
      actions: view.actions,
    });
  }

  function shouldAutoOpen(status) {
    return ['available', 'downloaded', 'error'].includes(normalizeStatus(status));
  }

  function createUpdateDialogController(options) {
    var opts = options && typeof options === 'object' ? options : {};
    var windowRef = opts.windowRef || root;
    var documentRef = opts.documentRef || (root && root.document);
    var jennyShell = opts.jennyShell || (root && root.jennyShell);
    var mountId = opts.mountId || 'updateDialogMount';
    var renderMarkdown = opts.renderMarkdown;
    var renderStepModal = opts.renderStepModal;
    var createStepModalLifecycle = resolveStepModalLifecycleFactory(opts);
    var showToastMessage = opts.showToastMessage;
    var reportError = typeof opts.reportError === 'function' ? opts.reportError : null;
    var preflightExit = typeof opts.preflightExit === 'function' ? opts.preflightExit : null;
    var state = null;
    var unsubscribe = null;
    var bound = false;
    var open = false;
    var disposed = false;
    var actionInFlight = false;
    var bindingGeneration = 0;
    var actionGate = asyncFence.createGenerationGate();
    var stateRevision = 0;
    var modalLifecycle = null;
    var dismissedSignature = '';

    function updateSignature(value) {
      var source = value && typeof value === 'object' ? value : {};
      return normalizeStatus(source.status) + '|' + normalizeVersion(source.latestVersion);
    }

    function getMount(createIfMissing) {
      if (!documentRef || typeof documentRef.getElementById !== 'function') {
        return null;
      }
      var mount = documentRef.getElementById(mountId);
      if (!mount && createIfMissing !== false && documentRef.body && typeof documentRef.createElement === 'function') {
        mount = documentRef.createElement('div');
        mount.id = mountId;
        documentRef.body.appendChild(mount);
      }
      return mount;
    }

    function ensureModalLifecycle(mount) {
      if (modalLifecycle || !mount || typeof mount.querySelector !== 'function'
        || typeof createStepModalLifecycle !== 'function') {
        return modalLifecycle;
      }
      modalLifecycle = createStepModalLifecycle({
        documentRef: documentRef,
        mountRoot: mount,
        getOverlayManager: function getOverlayManager() {
          return opts.overlayManager
            || (windowRef && windowRef.rendererOverlayManagerController)
            || null;
        },
        inertTargets: function getBackgroundTarget() {
          var appShell = documentRef && documentRef.getElementById && documentRef.getElementById('appShell');
          return appShell ? [appShell] : [];
        },
      });
      return modalLifecycle;
    }

    function render(nextState) {
      if (disposed) return;
      state = nextState && typeof nextState === 'object' ? nextState : (state || {});
      var mount = getMount(true);
      if (!mount) {
        return;
      }
      var mayAutoOpen = shouldAutoOpen(state.status) && dismissedSignature !== updateSignature(state);
      if (!open && !mayAutoOpen) {
        if (modalLifecycle) modalLifecycle.close();
        mount.innerHTML = '';
        return;
      }
      open = true;
      mount.innerHTML = renderUpdateDialog(state, { renderMarkdown: renderMarkdown, renderStepModal: renderStepModal });
      var lifecycle = ensureModalLifecycle(mount);
      if (lifecycle && !lifecycle.isOpen()) {
        lifecycle.open({
          id: 'update-dialog-overlay',
          onRequestClose: function requestClose() { api.close(); },
        });
      }
      if (actionInFlight && typeof mount.querySelectorAll === 'function') {
        Array.prototype.forEach.call(mount.querySelectorAll('[data-step-modal-action]'), function disableAction(button) {
          button.disabled = true;
        });
        var dialog = mount.querySelector('[role="dialog"]');
        if (dialog) dialog.setAttribute('aria-busy', 'true');
      }
    }

    // Resolve the window-exit dirty-buffer preflight: an injected fn wins
    // (tests), else the coordinator self-registered on the window global.
    function resolveExitPreflight() {
      if (preflightExit) {
        return preflightExit;
      }
      var api = windowRef && windowRef.jennyWindowExitPreflight;
      return api && typeof api.preflightExit === 'function'
        ? function runExitPreflight(action) { return api.preflightExit(action); }
        : null;
    }

    async function runAction(actionId) {
      if (disposed || actionInFlight) return;
      if (actionId === 'close') {
        dismissedSignature = updateSignature(state);
        open = false;
        render(state);
        return;
      }
      var updates = jennyShell && jennyShell.updates ? jennyShell.updates : null;
      if (!updates) {
        return;
      }
      actionInFlight = true;
      actionGate.bump();
      var actionToken = actionGate.capture();
      var startingRevision = stateRevision;
      var result = null;
      var closeAfterAction = false;
      render(state);
      try {
        if (actionId === 'download') {
          result = await updates.download();
        } else if (actionId === 'install') {
          // "Restart and Install" tears down the renderer like a native close.
          var exitPreflight = resolveExitPreflight();
          if (exitPreflight) {
            var outcome = await exitPreflight('update-restart');
            if (disposed || !actionGate.isCurrent(actionToken)) return;
            if (!outcome || outcome.proceed !== true) return;
          }
          result = await updates.install();
        } else if (actionId === 'skip') {
          result = await updates.skip((state && state.latestVersion) || '');
          closeAfterAction = true;
          if (typeof showToastMessage === 'function') {
            showToastMessage('Update skipped.', { tone: 'info' });
          }
        } else if (actionId === 'check') {
          result = await updates.check();
        }
        if (disposed || !actionGate.isCurrent(actionToken)) return;
        if (result && stateRevision === startingRevision) {
          state = result;
        }
        if (closeAfterAction) open = false;
      } finally {
        if (!disposed && actionGate.isCurrent(actionToken)) {
          actionInFlight = false;
          render(state);
        }
      }
    }

    function handleClick(event) {
      var target = event && event.target && typeof event.target.closest === 'function'
        ? event.target.closest('[data-step-modal-action]')
        : null;
      if (!target) {
        return;
      }
      if (target.disabled === true) return;
      event.preventDefault();
      runAction(target.getAttribute('data-step-modal-action')).catch(function (error) {
        var message = String(error && error.message || error || 'Update action failed.');
        /* EH-W9: route through intake when error_intake_routing is on —
         * when intake is off, use the valid danger tone so the toast store
         * cannot silently normalize a failed update into informational UI. */
        var routed = reportError
          ? reportError({ message: message, options: { title: 'Update Failed' } }, { origin: 'update-action' })
          : null;
        if (!routed && typeof showToastMessage === 'function') {
          showToastMessage(message, { tone: 'danger' });
        }
      });
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      bindingGeneration += 1;
      actionGate.bump();
      actionInFlight = false;
      var mount = getMount(false);
      if (mount && typeof mount.removeEventListener === 'function') {
        mount.removeEventListener('click', handleClick);
        mount.innerHTML = '';
      }
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
      unsubscribe = null;
      bound = false;
      open = false;
      if (modalLifecycle) modalLifecycle.dispose();
      modalLifecycle = null;
      if (windowRef && windowRef.jennyUpdateDialog === api) {
        windowRef.jennyUpdateDialog = null;
      }
    }

    function bind() {
      if (disposed || bound || !jennyShell || !jennyShell.updates) {
        return dispose;
      }
      bound = true;
      var bindGeneration = ++bindingGeneration;
      var mount = getMount(true);
      if (mount && typeof mount.addEventListener === 'function') {
        mount.addEventListener('click', handleClick);
      }
      if (typeof jennyShell.updates.onChanged === 'function') {
        unsubscribe = jennyShell.updates.onChanged(function (payload) {
          if (disposed || !bound || bindingGeneration !== bindGeneration) return;
          stateRevision += 1;
          render(payload);
        });
      }
      if (typeof jennyShell.updates.getState === 'function') {
        var hydrationRevision = stateRevision;
        jennyShell.updates.getState().then(function (payload) {
          if (disposed || !bound || bindingGeneration !== bindGeneration) return;
          // onChanged may win the race with initial hydration. Its payload is
          // newer authority; a late getState response must not roll the dialog
          // back to an earlier status/version.
          if (stateRevision !== hydrationRevision) return;
          if (shouldAutoOpen(payload && payload.status)) {
            render(payload);
          } else {
            state = payload;
          }
        }).catch(function () {});
      }
      if (windowRef) {
        windowRef.jennyUpdateDialog = api;
      }
      return dispose;
    }

    var api = {
      bind: bind,
      dispose: dispose,
      render: render,
      open: function openDialog(nextState) {
        open = true;
        render(nextState || state || {});
      },
      close: function closeDialog() {
        if (disposed) return;
        dismissedSignature = updateSignature(state);
        open = false;
        render(state);
      },
      getState: function getState() {
        return state;
      },
    };
    return api;
  }

  return {
    createUpdateDialogController: createUpdateDialogController,
    deriveUpdateDialogViewModel: deriveUpdateDialogViewModel,
    renderUpdateDialog: renderUpdateDialog,
  };
});
