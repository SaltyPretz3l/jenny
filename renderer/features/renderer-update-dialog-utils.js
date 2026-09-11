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

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
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
    return status || 'unchecked';
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
    var versionLabel = latestVersion || currentVersion || jt('updates.dialog.currentVersionFallback', 'current version');
    var summary = String(source.reason || source.lastError || '').trim();
    var releaseNotesMarkdown = String(source.releaseNotesMarkdown || '').trim().slice(0, 65536);
    var closeAction = { id: 'close', label: jt('common.close', 'Close'), variant: 'secondary' };
    var actions;
    var progress = null;
    var tone = 'default';
    var title;
    var statusLabel;
    var eyebrow = currentVersion ? jt('updates.dialog.currentVersion', 'Current {version}', { version: currentVersion }) : jt('updates.dialog.applicationUpdate', 'Application update');

    if (status === 'disabled') {
      title = jt('updates.dialog.unavailableTitle', 'Updates unavailable');
      statusLabel = jt('common.disabled', 'Disabled');
      summary = summary || jt('updates.dialog.packagedWindowsOnly', 'Updates are available only in packaged Windows builds.');
      tone = 'muted';
      actions = [closeAction];
    } else if (status === 'unchecked') {
      title = jt('updates.dialog.unchecked', 'Check for a new release');
      statusLabel = jt('updates.status.unchecked', 'Not checked');
      summary = jt('updates.networkDisclosure', 'Checks GitHub when you ask. Requires internet access.');
      actions = [closeAction, { id: 'check', label: jt('updates.actions.checkAgain', 'Check Again'), variant: 'primary' }];
    } else if (['manual', 'no-package', 'no-release', 'ahead'].includes(status)) {
      title = jt('updates.dialog.manual', 'A newer Jenny release is available');
      statusLabel = latestVersion;
      summary = jt('updates.dialog.manualSummary', 'Open the releases page to download and install the update yourself.');
      if (status === 'no-package') {
        title = jt('updates.dialog.noPackage', 'No package for this platform');
        summary = jt('updates.dialog.noPackageSummary', 'The latest public release has no installer for this platform. Check the releases page for availability.');
      } else if (status === 'no-release') {
        title = jt('updates.dialog.noRelease', 'No published release');
        summary = jt('updates.dialog.noReleaseSummary', 'GitHub has no published stable release available.');
      } else if (status === 'ahead') {
        title = jt('updates.dialog.ahead', 'Newer than the public release');
        summary = jt('updates.dialog.aheadSummary', 'This installation is newer than the latest published stable release.');
      }
      actions = [closeAction];
    } else if (status === 'checking') {
      title = jt('updates.dialog.checkingTitle', 'Checking for updates');
      statusLabel = jt('updates.status.checking', 'Checking');
      summary = summary || jt('updates.dialog.checkingSummary', 'Looking for the latest Jenny release.');
      actions = [closeAction];
    } else if (status === 'available') {
      title = jt('updates.dialog.availableTitle', 'Jenny {version} is ready', { version: versionLabel });
      statusLabel = jt('updates.status.ready', 'Ready');
      summary = summary || jt('updates.dialog.reviewReleaseNotes', 'Review the release notes before downloading.');
      actions = [
        { id: 'close', label: jt('updates.actions.later', 'Later'), variant: 'secondary' },
        { id: 'download', label: jt('updates.actions.download', 'Download Update'), variant: 'primary' },
      ];
    } else if (status === 'downloading') {
      title = jt('updates.dialog.downloadingTitle', 'Downloading Jenny {version}', { version: versionLabel });
      statusLabel = progressText(source.downloadProgress) || jt('updates.status.downloading', 'Downloading');
      summary = summary || jt('updates.dialog.downloadingSummary', 'The installer is downloading in the background.');
      progress = {
        value: Number(source.downloadProgress && source.downloadProgress.percent) || 0,
        max: 100,
        label: jt('updates.dialog.downloadProgress', 'Download progress'),
        displayText: progressText(source.downloadProgress),
      };
      actions = [{ id: 'close', label: jt('common.close', 'Close'), variant: 'secondary' }];
    } else if (status === 'downloaded') {
      title = jt('updates.dialog.downloadedTitle', 'Jenny {version} is ready to install', { version: versionLabel });
      statusLabel = jt('updates.status.downloaded', 'Downloaded');
      summary = summary || jt('updates.dialog.restartToFinish', 'Restart Jenny to finish installing the update.');
      progress = {
        value: 100,
        max: 100,
        label: jt('updates.dialog.downloadComplete', 'Download complete'),
        displayText: '100%',
      };
      actions = [
        { id: 'close', label: jt('updates.actions.later', 'Later'), variant: 'secondary' },
        { id: 'install', label: jt('updates.actions.restartAndInstall', 'Restart and Install'), variant: 'primary' },
      ];
    } else if (status === 'installing') {
      title = jt('updates.dialog.installingTitle', 'Installing Jenny {version}', { version: versionLabel });
      statusLabel = jt('updates.status.installing', 'Installing');
      summary = summary || jt('updates.dialog.installingSummary', 'Jenny will restart when the installer takes over.');
      actions = [{ id: 'close', label: jt('common.close', 'Close'), variant: 'secondary' }];
    } else if (status === 'error') {
      title = jt('updates.dialog.checkFailedTitle', 'Update check failed');
      if (source.errorStage === 'download') title = jt('updates.dialog.downloadFailedTitle', 'Update download failed');
      if (source.errorStage === 'install') title = jt('updates.dialog.installFailedTitle', 'Installer handoff failed');
      statusLabel = jt('updates.dialog.needsAttention', 'Needs attention');
      tone = 'danger';
      summary = summary || jt('updates.dialog.failedSummary', 'The updater could not complete that request.');
      actions = [
        closeAction,
        { id: source.canInstall ? 'install' : source.canDownload ? 'download' : 'check', label: jt('updates.actions.tryAgain', 'Try Again'), variant: 'primary' },
      ];
    } else {
      title = jt('updates.dialog.upToDateTitle', 'Jenny is up to date');
      statusLabel = jt('updates.status.idle', 'Idle');
      summary = summary || jt('updates.dialog.noUpdateWaiting', 'No update is waiting right now.');
      actions = [
        closeAction,
        { id: 'check', label: jt('updates.actions.checkAgain', 'Check Again'), variant: 'secondary' },
      ];
    }

    if (source.releaseUrl && !['checking', 'downloading', 'installing'].includes(status)) {
      actions.push({ id: 'releases', label: jt('updates.actions.releases', 'Open GitHub Releases'), variant: 'secondary' });
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
      ? '<div class="update-dialog-notes">' + renderMarkdown(view.releaseNotesMarkdown, { images: 'omit', mermaid: 'plain', rawHtml: 'sanitize' }) + '</div>'
      : '';
    var bodyHtml = releaseNotesHtml;
    return renderStepModal({
      id: 'update-dialog',
      tone: view.tone,
      eyebrow: view.eyebrow,
      title: view.title,
      status: view.statusLabel,
      summary: view.summary,
      progress: view.progress,
      bodyHtml: bodyHtml,
      actions: view.actions,
    });
  }

  function shouldAutoOpen(status) {
    return ['available', 'manual', 'no-package', 'downloaded', 'error'].includes(normalizeStatus(status));
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
    var renderedKey = '';

    function patchProgress(mount) {
      var progress = mount.querySelector?.('[role="progressbar"]');
      if (!progress) return false;
      var percent = Math.max(0, Math.min(100, Number(state.downloadProgress?.percent) || 0));
      progress.setAttribute('aria-valuenow', String(percent));
      progress.style.setProperty('--progress', percent + '%');
      progress.classList.toggle('inv-progress--warning', percent >= 80 && percent < 95);
      progress.classList.toggle('inv-progress--danger', percent >= 95);
      var label = progressText(state.downloadProgress);
      [mount.querySelector('.inv-progress-text'), mount.querySelector('.inv-step-modal-status')].forEach(function (node) {
        if (node && node.textContent !== label) node.textContent = label;
      });
      return true;
    }

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
        renderedKey = '';
        return;
      }
      open = true;
      var key = JSON.stringify(Object.assign({}, state, { downloadProgress: null, actionInFlight: actionInFlight }));
      if (state.status === 'downloading' && renderedKey === key && patchProgress(mount)) return;
      renderedKey = key;
      var focused = documentRef?.activeElement;
      var hadFocus = mount.contains?.(focused);
      var focusedAction = hadFocus && focused?.getAttribute?.('data-step-modal-action');
      mount.innerHTML = renderUpdateDialog(state, { renderMarkdown: renderMarkdown, renderStepModal: renderStepModal });
      var lifecycle = ensureModalLifecycle(mount);
      if (lifecycle && !lifecycle.isOpen()) {
        lifecycle.open({
          id: 'update-dialog-overlay',
          onRequestClose: function requestClose() { api.close(); },
        });
      }
      var liveStatus = mount.querySelector?.('.inv-step-modal-status');
      if (liveStatus) {
        liveStatus.setAttribute('role', 'status');
        liveStatus.setAttribute('aria-live', 'polite');
      }
      if (hadFocus) {
        var nextFocus = Array.from(mount.querySelectorAll?.('[data-step-modal-action]') || [])
          .find(function (button) { return button.getAttribute('data-step-modal-action') === focusedAction; });
        (nextFocus || mount.querySelector?.('[role="dialog"]'))?.focus?.();
      }
      if (actionInFlight && typeof mount.querySelectorAll === 'function') {
        Array.prototype.forEach.call(mount.querySelectorAll('[data-step-modal-action]'), function disableAction(button) {
          button.disabled = button.getAttribute('data-step-modal-action') !== 'close';
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
      if (disposed) return;
      if (actionId === 'close') {
        dismissedSignature = updateSignature(state);
        open = false;
        render(state);
        return;
      }
      if (actionInFlight) return;
      if (actionId === 'releases') {
        windowRef?.open?.('https://github.com/SaltyPretz3l/jenny/releases', '_blank', 'noopener,noreferrer');
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
        } else if (actionId === 'check') {
          result = await updates.check();
        }
        if (disposed || !actionGate.isCurrent(actionToken)) return;
        if (result && stateRevision === startingRevision) {
          state = result;
        }
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
        var message = String(error && error.message || error || jt('updates.errors.actionFailed', 'Update action failed.'));
        /* EH-W9: route through intake when error_intake_routing is on —
         * when intake is off, use the valid danger tone so the toast store
         * cannot silently normalize a failed update into informational UI. */
        var routed = reportError
          ? reportError({ message: message, options: { title: jt('updates.titles.failed', 'Update Failed') } }, { origin: 'update-action' })
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
