/**
 * renderer/features/setup-scenes/scene-setup-hub.js
 *
 * First-run setup hub with one model-route decision and optional file setup.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.rendererSetupSceneSetupHub = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var sceneUtils = (root && root.rendererSetupSceneUtils)
    || (typeof require === 'function' ? require('./scene-utils') : null);
  var actionButton = sceneUtils && sceneUtils.resolveDependency
    ? sceneUtils.resolveDependency('inventoryActionButton', '../../inventory/action-button')
    : null;
  var inventoryCheckbox = sceneUtils && sceneUtils.resolveDependency
    ? sceneUtils.resolveDependency('inventoryCheckbox', '../../inventory/checkbox')
    : null;
  var registry = sceneUtils && Array.isArray(sceneUtils.SETUP_STEP_REGISTRY)
    ? sceneUtils.SETUP_STEP_REGISTRY.slice().sort(function byOrder(left, right) { return left.order - right.order; })
    : [];

  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../../shared/string-utils') : null)).escapeHtml;

  function renderButton(options) {
    return actionButton ? actionButton(options) : '';
  }

  function currentValue(stepId, state) {
    if (stepId === 'workspaceRoot') return String(state.toolsWorkspaceRoot || '').trim();
    if (stepId === 'personality') {
      return String(state.assistantIdentity && state.assistantIdentity.agentName || '').trim();
    }
    return '';
  }

  function glyphMeta(status, number) {
    if (status === 'done') return { glyph: '✓', tone: 'success', label: jt('common.done', 'Done') };
    if (status === 'skipped') return { glyph: '—', tone: 'muted', label: jt('setup.hub.skipped', 'Skipped') };
    if (status === 'error') return { glyph: '!', tone: 'danger', label: jt('setup.hub.needsAttention', 'Needs attention') };
    return { glyph: String(number), tone: 'pending', label: jt('setup.hub.pending', 'Pending') };
  }

  function buildStepRow(spec, setupState, number) {
    var status = String(setupState.steps && setupState.steps[spec.id] || 'pending');
    var meta = glyphMeta(status, number);
    var value = currentValue(spec.id, setupState);
    var title = spec.id === 'workspaceRoot' ? jt('setup.hub.workspaceFolder', 'Workspace folder')
      : spec.id === 'personality' ? jt('setup.hub.personalityAndName', 'Personality and name') : spec.title;
    var suffix = spec.id === 'workspaceRoot' ? jt('setup.hub.forFileTools', ' \u00b7 for file tools')
      : value ? jt('setup.hub.currentValue', ' \u00b7 {value}', { value: value }) : jt('setup.hub.optional', ' \u00b7 optional');
    var openerLabel = status === 'done' ? jt('setup.hub.change', 'Change') : status === 'skipped' ? jt('setup.hub.revisit', 'Revisit') : jt('setup.hub.setUp', 'Set up');
    if (spec.id === 'workspaceRoot' && status !== 'done' && status !== 'skipped') openerLabel = jt('setup.hub.chooseFolder', 'Choose');
    var actions = renderButton({
      id: 'openStep', label: openerLabel, variant: status === 'pending' || status === 'error' ? 'secondary' : 'ghost',
      size: 'sm', dataset: { 'step-id': spec.id }, className: 'setup-hub-row-action',
    });
    if (status !== 'done' && status !== 'skipped') {
      actions += renderButton({
        id: 'skipStep', label: spec.id === 'workspaceRoot' ? jt('setup.hub.folderLater', 'Later') : jt('setup.hub.skip', 'Skip'), variant: 'ghost', size: 'sm',
        dataset: { 'step-id': spec.id }, className: 'setup-hub-row-skip',
      });
    }
    return '<li class="setup-hub-row" data-setup-step-id="' + escapeHtml(spec.id) + '">'
      + '<span class="setup-hub-glyph setup-hub-glyph--' + meta.tone + '" aria-label="' + escapeHtml(meta.label) + '">'
      + escapeHtml(meta.glyph) + '</span>'
      + '<div class="setup-hub-row-copy"><div class="setup-hub-row-title">' + escapeHtml(title)
      + '<span class="setup-hub-row-suffix">' + escapeHtml(suffix) + '</span>'
      + '</div><p class="setup-hub-row-description"' + (value ? ' title="' + escapeHtml(value) + '"' : '') + '>'
      + escapeHtml(spec.id === 'workspaceRoot' ? value || spec.description : spec.description) + '</p></div>'
      + '<div class="setup-hub-row-actions">'
      + (status === 'skipped' ? '<span class="setup-hub-skipped-label">' + escapeHtml(jt('setup.hub.skipped', 'Skipped')) + '</span>' : '')
      + actions + '</div></li>';
  }

  function routeRadio(value, selectedRoute) {
    return inventoryCheckbox ? inventoryCheckbox.radio({ name: 'setup-hub-model-route', value: value, checked: selectedRoute === value }) : '';
  }

  function buildModelRouteRow(setupState, selectedRoute, engine, modelStepId) {
    var done = engine.state === 'running';
    var label = done ? (jt('setup.hub.running', 'Running') + (engine.version ? ' v' + engine.version : ''))
      : engine.state === 'upgrade' ? (engine.version ? jt('setup.hub.updateRequiredVersion', 'Update required — v{version}', { version: engine.version }) : jt('setup.hub.updateRequired', 'Update required'))
        : engine.state === 'checking' ? jt('setup.hub.checking', 'Checking…')
          : engine.state === 'missing' ? jt('setup.hub.notRunning', 'Not running') : engine.state === 'absent' ? jt('setup.hub.notInstalled', 'Not installed') : jt('setup.hub.notDetected', 'Not detected');
    var health = sceneUtils.computeSetupHealth(setupState);
    var modelDone = health.pendingSteps.concat(health.skippedSteps).indexOf('model') === -1;
    var steps = setupState.steps || {};
    var meta = glyphMeta(modelDone ? 'done'
      : steps.localModel === 'error' || steps.endpoint === 'error' ? 'error' : 'pending', 1);
    return '<li class="setup-hub-row" data-setup-model-route>'
      + '<span class="setup-hub-glyph setup-hub-glyph--' + meta.tone + '" aria-label="' + escapeHtml(meta.label) + '">'
      + escapeHtml(meta.glyph) + '</span>'
      + '<div class="setup-hub-row-copy"><div class="setup-hub-row-title" id="setup-hub-model-route-title">'
      + escapeHtml(jt('setup.hub.modelRoute', 'Model route')) + '</div>'
      + '<div class="setup-hub-model-routes" role="radiogroup" aria-labelledby="setup-hub-model-route-title">'
      + '<label class="setup-hub-model-option">' + routeRadio('ollama', selectedRoute) + '<span>'
      + escapeHtml(jt('setup.hub.ollamaRoute', 'Ollama on this computer')) + '</span>'
      + (selectedRoute === 'ollama' ? '<span class="setup-hub-engine-status">' + escapeHtml(label) + '</span>' : '') + '</label>'
      + '<label class="setup-hub-model-option">' + routeRadio('endpoint', selectedRoute) + '<span>'
      + escapeHtml(jt('setup.hub.existingServerRoute', 'An existing server (local or private network)')) + '</span></label>'
      + '</div></div><div class="setup-hub-row-actions">' + renderButton({
        id: 'openStep', label: modelDone ? jt('setup.hub.change', 'Change') : jt('setup.hub.setUp', 'Set up'),
        variant: modelDone ? 'ghost' : 'secondary', size: 'sm', dataset: { 'step-id': modelStepId },
        className: 'setup-hub-row-action',
      }) + '</div></li>';
  }

  function firstUnresolvedRequiredStepId(setupState, modelStepId) {
    var health = sceneUtils.computeSetupHealth(setupState);
    var unresolved = health.pendingSteps.concat(health.skippedSteps);
    if (unresolved.indexOf('workspaceRoot') !== -1) return 'workspaceRoot';
    if (unresolved.indexOf('model') !== -1) return modelStepId;
    return '';
  }

  function usesExistingServer(setupState) {
    var endpoint = setupState.readiness && setupState.readiness.endpoint || {};
    if (endpoint.engineType === 'ollama') return false;
    return endpoint.engineType === 'vllm' || endpoint.engineType === 'openai-compatible'
      || (setupState.steps && (setupState.steps.endpoint === 'done' || setupState.steps.localModel === 'skipped'));
  }

  function warningCopy(setupState) {
    if (sceneUtils.computeSetupHealth(setupState).state === 'complete') {
      return jt('setup.hub.modelUnavailable', "Jenny can't reach a model right now — start the local engine or validate an endpoint, then try again.");
    }
    var workspaceDone = setupState.steps && setupState.steps.workspaceRoot === 'done';
    return workspaceDone
      ? jt('setup.hub.noModelConfigured', "No model configured — chats can't run locally.")
      : jt('setup.hub.noWorkspaceRoot', 'No workspace root set — file tools will be off until you set one.');
  }

  function requiredHealthLine(setupState, selectedRoute, engine) {
    var health = sceneUtils.computeSetupHealth(setupState);
    var modelDone = health.pendingSteps.concat(health.skippedSteps).indexOf('model') === -1;
    var workspaceDone = setupState.steps && setupState.steps.workspaceRoot === 'done';
    if (!modelDone) return workspaceDone
      ? jt('setup.hub.chooseRouteToChat', 'Choose a model route to start chatting')
      : jt('setup.hub.chooseRouteAndFolder', 'Choose a model route to start chatting \u00b7 file tools need a folder');
    if (selectedRoute === 'ollama' && ['missing', 'absent', 'upgrade'].indexOf(engine.state) !== -1) return workspaceDone
      ? jt('setup.hub.startOllamaToChat', 'Start Ollama to chat')
      : jt('setup.hub.startOllamaAndFolder', 'Start Ollama to chat \u00b7 file tools need a folder');
    if (selectedRoute === 'ollama' && engine.state === 'checking') return jt('setup.hub.checkingOllama', 'Checking Ollama…');
    if (selectedRoute === 'ollama' && engine.state !== 'running') return workspaceDone
      ? jt('setup.hub.routeSet', 'Model route set')
      : jt('setup.hub.routeSetNeedsFolder', 'Model route set · file tools need a folder');
    return workspaceDone ? jt('setup.hub.readyChatAndFiles', 'Ready to chat and use file tools')
      : jt('setup.hub.readyChatNeedsFolder', 'Ready to chat \u00b7 file tools need a folder');
  }

  function buildWarning(setupState, modelStepId) {
    var healthComplete = sceneUtils.computeSetupHealth(setupState).state === 'complete';
    var stepId = healthComplete ? (modelStepId === 'endpoint' ? 'endpoint' : 'localEngine')
      : (firstUnresolvedRequiredStepId(setupState, modelStepId) || modelStepId);
    var health = sceneUtils.computeSetupHealth(setupState);
    var onlyFolderLeft = !healthComplete && health.pendingSteps.concat(health.skippedSteps).join() === 'workspaceRoot';
    var fixLabel = stepId === 'endpoint' ? jt("sceneSetupHub.checkExistingServer", "Check existing server") : healthComplete ? jt("sceneSetupHub.checkOllama", "Check Ollama")
      : stepId === 'workspaceRoot' ? jt('setup.hub.setWorkspaceRoot', 'Set workspace root') : jt('setup.hub.configureModel', 'Configure model');
    return '<div class="setup-hub-finish-warning" role="alert">'
      + '<div class="setup-hub-warning-copy"><strong>' + escapeHtml(onlyFolderLeft ? jt('setup.hub.finishWithoutFolder', 'Finish without a folder?') : jt('setup.hub.notReady', 'Setup is not ready')) + '</strong><p>'
      + escapeHtml(warningCopy(setupState)) + '</p></div>'
      + '<div class="setup-hub-warning-actions">'
      + renderButton({ id: 'fixRequired', label: fixLabel, variant: 'primary', dataset: { 'step-id': stepId } })
      + renderButton({ id: 'finishAnyway', label: jt('setup.hub.finishAnyway', 'Finish anyway'), variant: 'ghost' })
      + renderButton({ id: 'finishGateCancel', label: jt('common.dismiss', 'Dismiss'), variant: 'ghost', ariaLabel: jt('setup.hub.dismissFinishWarning', 'Dismiss finish warning'),
        dataset: { 'step-modal-action': 'finishGateCancel' }, className: 'setup-hub-warning-dismiss' })
      + '</div></div>';
  }

  function createScene(deps) {
    var d = deps || {};
    var setupState = d.state || {};
    var markStep = typeof d.markStep === 'function' ? d.markStep : function () { return Promise.resolve(setupState); };
    var setupService = d.setupService || null;
    var openStep = typeof d.openStep === 'function' ? d.openStep : function () {};
    var finish = typeof d.finish === 'function' ? d.finish : function () { return Promise.resolve(); };
    var attemptComplete = typeof d.attemptComplete === 'function' ? d.attemptComplete : null;
    var refreshState = typeof d.refreshState === 'function' ? d.refreshState : null;
    var appendClientLog = typeof d.appendClientLog === 'function' ? d.appendClientLog : function () {};
    var rootEl = null;
    var unbindClicks = null;
    var focusTimer = null;
    var disposed = false;
    var detectGeneration = 0;
    var refreshGeneration = 0;
    var finishGateOpen = false;
    var finishInFlight = false;
    var skipInFlight = {};
    var engine = { state: 'checking', version: '' };
    var selectedRoute = usesExistingServer(setupState) ? 'endpoint' : 'ollama';
    var modelStepId = selectedRoute === 'endpoint' ? 'endpoint' : 'localModel';

    function render() {
      if (!rootEl || disposed) return;
      var selector = focusedControlSelector();
      modelStepId = selectedRoute === 'endpoint' ? 'endpoint'
        : ['missing', 'absent', 'upgrade'].indexOf(engine.state) !== -1 ? 'localEngine' : 'localModel';
      var rows = [buildModelRouteRow(setupState, selectedRoute, engine, modelStepId)].concat(registry
        .filter(function hubStep(spec) { return spec.health !== 'model'; })
        .map(function renderRegistryStep(spec, index) { return buildStepRow(spec, setupState, index + 2); }));
      var body = '<div class="setup-hub"><ol class="setup-hub-list">' + rows.join('') + '</ol>'
        + (finishGateOpen ? buildWarning(setupState, modelStepId) : '')
        + '<p class="setup-hub-health" aria-live="polite">' + escapeHtml(requiredHealthLine(setupState, selectedRoute, engine)) + '</p></div>';
      rootEl.innerHTML = sceneUtils.renderStepModalHtml({
        id: 'setup-hub',
        title: jt('setup.hub.title', 'Set up Jenny'),
        summary: jt('setup.hub.routeAndFolderSummary', 'Pick how Jenny runs models. A folder is only needed for file work.'),
        bodyHtml: body,
        actions: [
          { id: 'close', label: jt('setup.hub.finishLater', 'Finish later'), variant: 'secondary' },
          { id: 'finishSetup', label: finishInFlight ? jt('setup.hub.checking', 'Checking…') : jt('setup.hub.finishSetup', 'Finish setup'),
            variant: 'primary', disabled: finishInFlight },
        ],
      });
      var target = selector && rootEl.querySelector(selector);
      if (target && typeof target.focus === 'function') target.focus();
      else if (selector) focusFirstUnresolvedRequired();
    }

    function focusFirstUnresolvedRequired() {
      if (!rootEl) return;
      var stepId = firstUnresolvedRequiredStepId(setupState, modelStepId);
      var target = stepId
        ? rootEl.querySelector('[data-action="openStep"][data-step-id="' + stepId + '"]')
        : rootEl.querySelector('[data-step-modal-action="finishSetup"]');
      if (target && typeof target.focus === 'function') target.focus();
    }

    function handleRouteChange(event) {
      var target = event.target;
      if (!target || target.name !== 'setup-hub-model-route' || !target.checked) return;
      selectedRoute = target.value;
      detectGeneration += 1;
      if (focusTimer !== null) clearTimeout(focusTimer);
      focusTimer = null;
      if (selectedRoute === 'ollama') engine = { state: 'checking', version: '' };
      render();
      rootEl.querySelector('input[name="setup-hub-model-route"][value="' + selectedRoute + '"]').focus();
      detectEngine();
    }

    function handleOpen(_event, target) {
      return openStep(target.getAttribute('data-step-id'));
    }

    function handleSkip(_event, target) {
      var stepId = target.getAttribute('data-step-id');
      if (!stepId || skipInFlight[stepId]) return Promise.resolve();
      skipInFlight[stepId] = true;
      return Promise.resolve(markStep(stepId, 'skipped')).then(function rerender(snapshot) {
        delete skipInFlight[stepId];
        if (snapshot) setupState = snapshot;
        render();
      }, function retainRow(error) {
        delete skipInFlight[stepId];
        throw error;
      });
    }

    function focusWarningFix() {
      var target = rootEl && rootEl.querySelector('[data-action="fixRequired"]');
      if (target && typeof target.focus === 'function') target.focus();
    }

    function stepsSignature(state) {
      return JSON.stringify(state && state.steps || {});
    }

    // The hub's snapshot dates from when it opened, and the backend readiness
    // cache can predate a model that finished loading since. A fresh probe
    // backfills the steps an active model already satisfies.
    function refreshSetupState() {
      if (!refreshState) return Promise.resolve(false);
      var generation = ++refreshGeneration;
      var before = stepsSignature(setupState);
      return Promise.resolve().then(refreshState).then(function applyRefreshed(next) {
        if (disposed || generation !== refreshGeneration || !next) return false;
        setupState = next;
        return stepsSignature(next) !== before;
      }, function logRefreshFailure(error) {
        if (!disposed) {
          appendClientLog('WARN', 'setup.hub_refresh_failed', {
            message: error && error.message ? error.message : String(error),
          });
        }
        return false;
      });
    }

    // A rerender replaces every control, so return focus to the same action the
    // user was on; Enter must not land on a different button.
    function focusedControlSelector() {
      var doc = rootEl && rootEl.ownerDocument;
      var active = doc && doc.activeElement;
      if (!active || !rootEl.contains(active)) return null;
      if (active.name === 'setup-hub-model-route') return 'input[name="setup-hub-model-route"][value="' + active.value + '"]';
      var modalAction = active.getAttribute('data-step-modal-action');
      if (modalAction) return '[data-step-modal-action="' + modalAction + '"]';
      var action = active.getAttribute('data-action');
      if (!action) return '';
      if (action === 'openStep' && active.closest('[data-setup-model-route]')) return '[data-setup-model-route] [data-action="openStep"]';
      var stepId = active.getAttribute('data-step-id');
      return '[data-action="' + action + '"]' + (stepId ? '[data-step-id="' + stepId + '"]' : '');
    }

    function refreshAfterMount() {
      void refreshSetupState().then(function rerenderChangedSteps(changed) {
        if (!changed || disposed || !rootEl || finishInFlight) return;
        var selector = focusedControlSelector();
        render();
        if (selector === null) return;
        var target = selector ? rootEl.querySelector(selector) : null;
        if (target && typeof target.focus === 'function') target.focus();
        else focusFirstUnresolvedRequired();
      });
    }

    async function handleFinish() {
      if (finishInFlight) return;
      if (sceneUtils.computeSetupHealth(setupState).state !== 'complete' && refreshState) {
        finishInFlight = true;
        render();
        await refreshSetupState();
        if (disposed) return;
        finishInFlight = false;
      }
      if (sceneUtils.computeSetupHealth(setupState).state !== 'complete') {
        finishGateOpen = true;
        render();
        focusWarningFix();
        return;
      }
      if (!attemptComplete) return finish({ force: false });
      finishInFlight = true;
      render();
      var result;
      try {
        result = await attemptComplete();
      } catch (error) {
        if (disposed) return;
        appendClientLog('WARN', 'setup.hub_finish_attempt_failed', {
          message: error && error.message ? error.message : String(error),
        });
        finishInFlight = false;
        finishGateOpen = true;
        render();
        focusWarningFix();
        return;
      }
      if (disposed) return;
      if (result && result.setupComplete === true) {
        finishInFlight = false;
        return finish({ force: true });
      }
      setupState = result || setupState;
      finishInFlight = false;
      finishGateOpen = true;
      render();
      focusWarningFix();
    }

    function detectEngine() {
      if (selectedRoute !== 'ollama') return;
      var generation = ++detectGeneration;
      if (!setupService || typeof setupService.detectOllama !== 'function') {
        engine = { state: 'unknown', version: '' };
        render();
        return;
      }
      Promise.resolve(setupService.detectOllama()).then(function applyDetected(result) {
        if (disposed || generation !== detectGeneration) return;
        engine = result && result.installed === true && result.running === true && result.upgradeRequired !== true
          ? { state: 'running', version: String(result.version || '') }
          : result && result.installed === true && result.upgradeRequired === true
            ? { state: 'upgrade', version: String(result.version || '') }
            : result && result.installed === true
              ? { state: 'missing', version: '' }
              : { state: 'absent', version: '' };
        render();
      }, function applyDetectFailure(error) {
        if (disposed || generation !== detectGeneration) return;
        engine = { state: 'unknown', version: '' };
        appendClientLog('WARN', 'setup.hub_engine_detect_failed', {
          message: error && error.message ? error.message : String(error),
        });
        render();
      });
    }

    return {
      mount: function mount(rootElement) {
        rootEl = rootElement;
        disposed = false;
        render();
        unbindClicks = sceneUtils.bindActionDelegation(rootEl, {
          openStep: handleOpen,
          skipStep: handleSkip,
          close: function finishLater() { return finish({ force: true }); },
          finishSetup: handleFinish,
          fixRequired: handleOpen,
          finishAnyway: function finishAnyway() { return finish({ force: true }); },
          finishGateCancel: function dismissWarning() { finishGateOpen = false; render(); },
          __onError: function onError(error, action) {
            appendClientLog('WARN', 'setup.hub_action_failed', {
              action: action,
              message: error && error.message ? error.message : String(error),
            });
          },
        });
        rootEl.addEventListener('change', handleRouteChange);
        focusFirstUnresolvedRequired();
        focusTimer = setTimeout(focusFirstUnresolvedRequired, 0);
        detectEngine();
        refreshAfterMount();
      },
      dispose: function dispose() {
        disposed = true;
        detectGeneration += 1;
        refreshGeneration += 1;
        if (focusTimer !== null) clearTimeout(focusTimer);
        focusTimer = null;
        if (typeof unbindClicks === 'function') unbindClicks();
        unbindClicks = null;
        if (rootEl) rootEl.removeEventListener('change', handleRouteChange);
        rootEl = null;
      },
    };
  }

  return { createScene: createScene };
});
