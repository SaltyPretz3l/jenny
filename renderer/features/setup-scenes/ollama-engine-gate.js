/**
 * renderer/features/setup-scenes/ollama-engine-gate.js
 *
 * Standalone setup scene for the Ollama engine lifecycle. Model selection and
 * pulling remain owned by their model scenes.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.rendererSetupSceneOllamaEngineGate = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var sceneUtils = (root && root.rendererSetupSceneUtils)
    || (typeof require === 'function' ? require('./scene-utils') : null);
  var asyncFence = (root && root.rendererAsyncFence)
    || (typeof require === 'function' ? require('../../shared/async-fence') : null);
  var stepModal = sceneUtils && sceneUtils.resolveDependency
    ? sceneUtils.resolveDependency('inventoryStepModal', '../../inventory/step-modal')
    : null;

  if (!sceneUtils || typeof sceneUtils.renderStepModalHtml !== 'function'
    || typeof sceneUtils.bindActionDelegation !== 'function'
    || !stepModal || typeof stepModal.renderStepModal !== 'function') {
    throw new Error('Ollama engine gate requires scene-utils and the step-modal inventory primitive.');
  }
  if (!asyncFence || typeof asyncFence.createGenerationGate !== 'function') {
    throw new Error('Ollama engine gate requires the renderer async-fence.');
  }

  function generateRequestId(prefix) {
    if (typeof globalThis !== 'undefined'
      && globalThis.crypto
      && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
    return (prefix || 'req') + '_' + Date.now().toString(16) + '_' + Math.random().toString(16).slice(2, 10);
  }

  function formatBytesGb(bytes) {
    var value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return '';
    return (Math.round((value / (1024 * 1024 * 1024)) * 10) / 10) + ' GB';
  }

  function createScene(deps) {
    var d = deps || {};
    var setupService = d.setupService || null;
    var appendClientLog = typeof d.appendClientLog === 'function' ? d.appendClientLog : function () {};
    var closeModal = typeof d.closeModal === 'function' ? d.closeModal : function () {};
    var openExternal = typeof d.openExternal === 'function' ? d.openExternal : null;
    var rootEl = null;
    var unbindClicks = null;
    var unsubscribeProgress = null;
    var disposed = true;
    var lifecycleGate = asyncFence.createGenerationGate();
    var detectGeneration = 0;
    var installCompletionPromise = null;

    var view = {
      phase: 'checking',
      ollama: { installed: false, running: false, version: '' },
      installPlan: { available: false, url: '', sizeBytes: 0, sha256: '', manualFallbackUrl: '' },
      trayStatus: null,
      optInInstall: false,
      progressPercent: 0,
      progressLabel: '',
      errorText: '',
      installRequestId: '',
      cancelFailed: false,
      cancelFailureText: '',
    };

    function staleGeneration(token) {
      return disposed || !rootEl || !lifecycleGate.isCurrent(token);
    }

    function escapeHtml(value) {
      return sceneUtils.escapeHtml(value);
    }

    function installOptInLabel(actionLabel, size) {
      return '<label class="setup-hw-optin"><input type="checkbox" id="setup-hw-optin"'
        + (view.optInInstall ? ' checked' : '') + ' /><span>' + actionLabel
        + size + '</span></label>';
    }

    function trayWarning() {
      // Production tray status exposes `detected`; renderer-ollama-health.js is the canonical consumer.
      if (!view.trayStatus || view.trayStatus.detected !== true) return '';
      return ''
        + '<div class="setup-hw-ollama setup-hw-ollama--missing" role="status">'
        + '<p>The Ollama tray app or Startup shortcut can interrupt Jenny’s managed engine.</p>'
        + '<div class="setup-scene-actions">'
        + '<a href="#" class="inv-action-button inv-action-button--secondary" data-action="quitTrayApp">Quit tray app</a>'
        + '<a href="#" class="inv-action-button inv-action-button--secondary" data-action="disableTrayStartup">Disable Startup shortcut</a>'
        + '<a href="#" class="inv-action-button inv-action-button--secondary" data-action="restartManagedEngine">Restart Jenny engine</a>'
        + '</div></div>';
    }

    function engineStatusBody() {
      if (view.phase === 'upgradeRequired') {
        var upgradeSize = view.installPlan.sizeBytes ? ' (' + escapeHtml(formatBytesGb(view.installPlan.sizeBytes)) + ')' : '';
        return '<div class="setup-hw-ollama setup-hw-ollama--missing">'
          + '<p>Ollama ' + escapeHtml(view.ollama.version || '') + ' is too old. Version '
          + escapeHtml(view.ollama.minimumVersion || view.installPlan.minimumVersion || '0.30.10') + '+ is required.</p>'
          + (view.installPlan.available ? installOptInLabel('Download &amp; upgrade Ollama', upgradeSize) : '')
          + '</div>';
      }
      if (view.phase === 'stopped') {
        return '<div class="setup-hw-ollama setup-hw-ollama--missing setup-hw-ollama--stopped">'
          + '<p>Ollama is installed but not running. Start Ollama, then re-check.</p></div>';
      }
      if (view.phase === 'unverified') {
        return '<div class="setup-hw-ollama setup-hw-ollama--missing">'
          + '<p>Jenny could not verify the running Ollama version. Restart or upgrade Ollama, then re-check.</p></div>';
      }
      if (view.phase === 'running') {
        return '<p class="setup-hw-ollama setup-hw-ollama--ok">Ollama detected'
          + (view.ollama.version ? ' (v' + escapeHtml(view.ollama.version) + ')' : '') + '.</p>';
      }
      if (view.phase === 'missingInstallable') {
        var size = view.installPlan.sizeBytes ? ' (' + escapeHtml(formatBytesGb(view.installPlan.sizeBytes)) + ')' : '';
        return '<div class="setup-hw-ollama setup-hw-ollama--missing">'
          + '<p>Ollama isn’t installed yet — it runs the model on your machine.</p>'
          + installOptInLabel('Download &amp; install Ollama', size)
          + '<p class="setup-hw-provenance">Official installer from <code>' + escapeHtml(view.installPlan.url) + '</code>'
          + (view.installPlan.sha256 ? '<br/>SHA-256 verified before running.' : '') + '</p></div>';
      }
      var manualUrl = view.installPlan.manualFallbackUrl || 'https://ollama.com/download';
      return '<div class="setup-hw-ollama setup-hw-ollama--manual">'
        + '<p>Ollama isn’t installed. Install it from '
        + '<a href="#" class="setup-hw-ollama-link" data-action="openManualUrl">' + escapeHtml(manualUrl) + '</a>'
        + ', then re-check.</p></div>';
    }

    function buildBody() {
      var body;
      if (view.phase === 'checking') {
        body = '<div class="setup-scene-body setup-hw-scanning"><p>Checking the local engine…</p></div>';
      } else if (view.phase === 'installing') {
        body = '<div class="setup-scene-body setup-hw-progress">'
          + '<p class="setup-hw-progress-label">' + escapeHtml(view.progressLabel || 'Installing Ollama…') + '</p>'
          + '<div class="setup-hw-progress-bar"><div class="setup-hw-progress-fill" style="width:'
          + Number(view.progressPercent || 0) + '%"></div></div>'
          + '<p class="setup-hw-progress-pct">' + Number(view.progressPercent || 0) + '%</p>'
          + (view.cancelFailed
            ? '<p class="setup-hw-cancel-failed" role="status">'
              + escapeHtml(view.cancelFailureText || 'Cancel failed. Try again, or wait for the operation to finish.') + '</p>'
            : '')
          + '</div>';
      } else if (view.phase === 'error') {
        body = '<div class="setup-scene-body setup-hw-error"><p>'
          + escapeHtml(view.errorText || 'Jenny could not check the local engine.') + '</p></div>';
      } else {
        body = '<div class="setup-scene-body setup-hw-scanned">' + engineStatusBody() + '</div>'
          + trayWarning();
      }
      return body;
    }

    function buildActions() {
      var close = { id: 'close', label: 'Close', variant: 'secondary' };
      if (view.phase === 'installing') {
        return [{ id: 'cancel', label: view.cancelFailed ? 'Retry cancel' : 'Cancel', variant: 'primary' }];
      }
      if ((view.phase === 'missingInstallable' || view.phase === 'upgradeRequired') && view.installPlan.available) {
        return [close, {
          id: 'install',
          label: view.phase === 'upgradeRequired' ? 'Upgrade Ollama' : 'Install Ollama',
          variant: 'primary',
          disabled: !view.optInInstall,
        }];
      }
      return [close, {
        id: 'recheck',
        label: 'Re-check',
        variant: 'primary',
      }];
    }

    function render() {
      if (!rootEl || disposed) return;
      rootEl.innerHTML = sceneUtils.renderStepModalHtml({
        id: 'ollama-engine',
        eyebrow: 'Local setup',
        title: 'Local engine',
        summary: 'Jenny uses Ollama to run local models on your machine.',
        bodyHtml: buildBody(),
        actions: buildActions(),
      });
    }

    function updateProgressInPlace() {
      if (!rootEl || disposed) return;
      var fill = rootEl.querySelector('.setup-hw-progress-fill');
      if (!fill) { render(); return; }
      var value = Number(view.progressPercent || 0);
      fill.style.width = value + '%';
      var pct = rootEl.querySelector('.setup-hw-progress-pct');
      if (pct) pct.textContent = value + '%';
      var label = rootEl.querySelector('.setup-hw-progress-label');
      if (label && view.progressLabel) label.textContent = view.progressLabel;
    }

    function teardownProgress() {
      if (typeof unsubscribeProgress === 'function') {
        try { unsubscribeProgress(); } catch (_error) { /* ignore */ }
      }
      unsubscribeProgress = null;
    }

    function detectPhase(ollama, plan) {
      if (ollama.installed === true && ollama.upgradeRequired === true) return 'upgradeRequired';
      if (ollama.installed === true && ollama.running !== true) return 'stopped';
      if (ollama.installed === true && ollama.running === true && ollama.versionSupported === false) return 'unverified';
      if (ollama.installed === true) return 'running';
      return plan.available === true ? 'missingInstallable' : 'missingManual';
    }

    function settleDetectionStep(label, call) {
      return Promise.resolve().then(call).then(function success(value) {
        return { ok: true, value: value };
      }, function failure(error) {
        appendClientLog('WARN', 'setup.ollama_engine_detect_step_failed', {
          step: label,
          message: error && error.message ? error.message : String(error),
        });
        return { ok: false, value: null };
      });
    }

    async function detect() {
      if (!rootEl || disposed) return;
      var myGeneration = lifecycleGate.capture();
      var myDetectGeneration = ++detectGeneration;
      view.phase = 'checking';
      view.errorText = '';
      render();
      var results = await Promise.all([
        settleDetectionStep('ollama_detection', function () {
          return setupService && typeof setupService.detectOllama === 'function'
            ? setupService.detectOllama() : null;
        }),
        settleDetectionStep('ollama_install_plan', function () {
          return setupService && typeof setupService.getOllamaInstallPlan === 'function'
            ? setupService.getOllamaInstallPlan() : null;
        }),
        settleDetectionStep('ollama_tray', function () {
          return root && root.jennyShell && root.jennyShell.ollamaTray
            && typeof root.jennyShell.ollamaTray.status === 'function'
            ? root.jennyShell.ollamaTray.status() : null;
        }),
      ]);
      if (staleGeneration(myGeneration) || myDetectGeneration !== detectGeneration) return;
      view.trayStatus = results[2].value;
      if (!results[0].ok) {
        view.phase = 'error';
        view.errorText = 'Jenny could not check Ollama. Try again.';
        render();
        return;
      }
      view.ollama = results[0].value || { installed: false, running: false, version: '' };
      view.installPlan = results[1].value || view.installPlan;
      view.optInInstall = false;
      view.cancelFailed = false;
      view.cancelFailureText = '';
      view.phase = detectPhase(view.ollama, view.installPlan);
      render();
    }

    function completeInstall() {
      if (!installCompletionPromise) {
        view.installRequestId = '';
        teardownProgress();
        installCompletionPromise = Promise.resolve(detect());
      }
      return installCompletionPromise;
    }

    function applyInstallFailure(payload) {
      view.phase = 'error';
      view.errorText = (payload.summary || 'Ollama install did not complete.')
        + (payload.manualFallbackUrl ? ' Install manually from ' + payload.manualFallbackUrl + '.' : '');
      view.installRequestId = '';
      teardownProgress();
      render();
    }

    async function installOllama() {
      if (!view.optInInstall || !view.installPlan.available || view.phase === 'installing') return;
      var myGeneration = lifecycleGate.capture();
      view.phase = 'installing';
      view.progressPercent = 0;
      view.progressLabel = 'Preparing download…';
      view.cancelFailed = false;
      view.cancelFailureText = '';
      view.installRequestId = generateRequestId('install');
      var myRequestId = view.installRequestId;
      installCompletionPromise = null;
      render();
      teardownProgress();
      if (setupService && typeof setupService.subscribeOllamaInstallProgress === 'function') {
        unsubscribeProgress = setupService.subscribeOllamaInstallProgress(function onProgress(payload) {
          if (staleGeneration(myGeneration)) return;
          if (!payload || payload.requestId !== view.installRequestId) return;
          if (Number.isFinite(payload.percent)) view.progressPercent = payload.percent;
          view.progressLabel = payload.summary || (payload.phase ? payload.phase : view.progressLabel);
          if (payload.status === 'completed') {
            completeInstall().catch(function ignoreDetectFailure() {});
            return;
          }
          if (payload.status === 'failed' || payload.status === 'cancelled') {
            applyInstallFailure(payload);
            return;
          }
          updateProgressInPlace();
        });
      }
      try {
        var result = await setupService.installOllama({ confirmed: true, requestId: view.installRequestId });
        if (staleGeneration(myGeneration)) return;
        var requestIsCurrent = view.installRequestId === myRequestId;
        var completedByStream = view.installRequestId === '' && installCompletionPromise !== null;
        if (result && result.requestId && view.phase === 'installing' && requestIsCurrent) {
          view.installRequestId = result.requestId;
        }
        if (result && result.status === 'completed' && (requestIsCurrent || completedByStream)) {
          if (completedByStream) {
            await installCompletionPromise;
          } else if (view.phase === 'installing') {
            await completeInstall();
          }
        } else if (result && view.phase === 'installing'
          && (requestIsCurrent || completedByStream)
          && (result.status === 'failed' || result.status === 'cancelled')) {
          applyInstallFailure(result);
        }
      } catch (error) {
        if (staleGeneration(myGeneration)) return;
        appendClientLog('WARN', 'setup.flow_install_failed', {
          message: error && error.message ? error.message : String(error),
        });
        view.phase = 'error';
        view.errorText = 'Could not install Ollama.';
        view.installRequestId = '';
        teardownProgress();
        render();
      }
    }

    async function handleCancel() {
      if (view.phase !== 'installing') return;
      var myGeneration = lifecycleGate.capture();
      var result = { cancelled: false, code: 'bridge_unavailable' };
      try {
        if (setupService && typeof setupService.cancelOllamaInstall === 'function') {
          result = await setupService.cancelOllamaInstall({ requestId: view.installRequestId });
        }
      } catch (_error) {
        result = { cancelled: false, code: 'request_failed' };
      }
      if (staleGeneration(myGeneration)) return;
      if (!result || result.cancelled !== true) {
        view.cancelFailed = true;
        view.cancelFailureText = result && result.code === 'termination_failed'
          ? 'Cancel failed — Jenny could not confirm that the owned process stopped. Retry cancellation or wait for it to finish.'
          : result && result.code === 'bridge_unavailable'
            ? 'Cancel failed — the setup bridge is unavailable.'
            : 'Cancel failed — the request did not complete. Try again, or wait for the operation to finish.';
        render();
        return;
      }
      view.installRequestId = '';
      view.cancelFailed = false;
      view.cancelFailureText = '';
      teardownProgress();
      await detect();
    }

    function handleOpenManualUrl() {
      var url = (view.installPlan && view.installPlan.manualFallbackUrl) || 'https://ollama.com/download';
      if (typeof openExternal === 'function') {
        openExternal(url);
        return;
      }
      // window.open is denied-and-routed to shell.openExternal by the main
      // window navigation guard, so this opens the system browser.
      if (root && typeof root.open === 'function') {
        root.open(url, '_blank');
      }
    }

    async function remediateTray(methodName) {
      var bridge = root && root.jennyShell && root.jennyShell.ollamaTray;
      if (!bridge || typeof bridge[methodName] !== 'function') return;
      var myGeneration = lifecycleGate.capture();
      try {
        await bridge[methodName]();
        if (staleGeneration(myGeneration)) return;
        detect();
      } catch (error) {
        if (staleGeneration(myGeneration)) return;
        appendClientLog('WARN', 'setup.ollama_tray_remediation_failed', {
          action: methodName,
          message: error && error.message ? error.message : String(error),
        });
      }
    }

    function handleRootChange(event) {
      var target = event && event.target;
      if (!target || target.id !== 'setup-hw-optin') return;
      view.optInInstall = target.checked === true;
      render();
    }

    return {
      mount: function mount(rootElement) {
        rootEl = rootElement;
        disposed = false;
        lifecycleGate.bump();
        render();
        unbindClicks = sceneUtils.bindActionDelegation(rootEl, {
          close: closeModal,
          recheck: detect,
          install: installOllama,
          cancel: handleCancel,
          openManualUrl: handleOpenManualUrl,
          quitTrayApp: function () { return remediateTray('quitTrayApp'); },
          disableTrayStartup: function () { return remediateTray('disableStartupShortcut'); },
          restartManagedEngine: function () { return remediateTray('restartEngine'); },
          __onError: function onError(error, action) {
            appendClientLog('WARN', 'setup.ollama_engine_action_failed', {
              action: action,
              message: error && error.message ? error.message : String(error),
            });
          },
        });
        rootEl.addEventListener('change', handleRootChange);
        detect();
      },
      dispose: function dispose() {
        disposed = true;
        lifecycleGate.bump();
        detectGeneration += 1;
        teardownProgress();
        view.installRequestId = '';
        if (typeof unbindClicks === 'function') unbindClicks();
        unbindClicks = null;
        if (rootEl && typeof rootEl.removeEventListener === 'function') {
          rootEl.removeEventListener('change', handleRootChange);
        }
        rootEl = null;
      },
    };
  }

  return { createScene: createScene };
});
