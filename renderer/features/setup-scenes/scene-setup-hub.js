/**
 * renderer/features/setup-scenes/scene-setup-hub.js
 *
 * First-run checklist hub. Every persisted setup step remains independently
 * actionable; local-engine health is a derived, non-persisted row.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.rendererSetupSceneSetupHub = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var sceneUtils = (root && root.rendererSetupSceneUtils)
    || (typeof require === 'function' ? require('./scene-utils') : null);
  var actionButton = sceneUtils && sceneUtils.resolveDependency
    ? sceneUtils.resolveDependency('inventoryActionButton', '../../inventory/action-button')
    : null;
  var registry = sceneUtils && Array.isArray(sceneUtils.SETUP_STEP_REGISTRY)
    ? sceneUtils.SETUP_STEP_REGISTRY.slice().sort(function byOrder(left, right) { return left.order - right.order; })
    : [];

  function escapeHtml(value) {
    return sceneUtils && sceneUtils.escapeHtml ? sceneUtils.escapeHtml(value) : String(value || '');
  }

  function renderButton(options) {
    return actionButton ? actionButton(options) : '';
  }

  function currentValue(stepId, state) {
    if (stepId === 'workspaceRoot') return String(state.toolsWorkspaceRoot || '').trim();
    if (stepId === 'localModel') {
      return String(state.preferredLocalModel || state.preferredModelTag
        || (state.raw && state.raw.preferred_local_model) || '').trim();
    }
    if (stepId === 'personality') {
      return String(state.assistantIdentity && state.assistantIdentity.agentName || '').trim();
    }
    return '';
  }

  function glyphMeta(status, number) {
    if (status === 'done') return { glyph: '✓', tone: 'success', label: 'Done' };
    if (status === 'skipped') return { glyph: '—', tone: 'muted', label: 'Skipped' };
    if (status === 'error') return { glyph: '!', tone: 'danger', label: 'Needs attention' };
    return { glyph: String(number), tone: 'pending', label: 'Pending' };
  }

  function buildStepRow(spec, setupState) {
    var status = String(setupState.steps && setupState.steps[spec.id] || 'pending');
    var meta = glyphMeta(status, spec.order + 1);
    var value = currentValue(spec.id, setupState);
    var openerLabel = status === 'done' ? 'Change' : status === 'skipped' ? 'Revisit' : 'Set up';
    var actions = renderButton({
      id: 'openStep', label: openerLabel, variant: status === 'pending' || status === 'error' ? 'secondary' : 'ghost',
      size: 'sm', dataset: { 'step-id': spec.id }, className: 'setup-hub-row-action',
    });
    if (status !== 'done' && status !== 'skipped') {
      actions += renderButton({
        id: 'skipStep', label: 'Skip', variant: 'ghost', size: 'sm',
        dataset: { 'step-id': spec.id }, className: 'setup-hub-row-skip',
      });
    }
    return '<li class="setup-hub-row" data-setup-step-id="' + escapeHtml(spec.id) + '">'
      + '<span class="setup-hub-glyph setup-hub-glyph--' + meta.tone + '" aria-label="' + meta.label + '">'
      + escapeHtml(meta.glyph) + '</span>'
      + '<div class="setup-hub-row-copy"><div class="setup-hub-row-title">' + escapeHtml(spec.title)
      // Endpoint is an alternative model route; one badge per requirement keeps the promised two-step model canonical.
      + (spec.id === 'workspaceRoot' || spec.id === 'localModel' ? '<span class="setup-hub-required">Required</span>' : '')
      + '</div><p class="setup-hub-row-description"' + (value ? ' title="' + escapeHtml(value) + '"' : '') + '>'
      + escapeHtml(value || spec.description) + '</p></div>'
      + '<div class="setup-hub-row-actions">'
      + (status === 'skipped' ? '<span class="setup-hub-skipped-label">Skipped</span>' : '')
      + actions + '</div></li>';
  }

  function buildEngineRow(engine) {
    var done = engine.state === 'running';
    var label = done ? ('Running' + (engine.version ? ' v' + engine.version : ''))
      : engine.state === 'upgrade' ? ('Update required' + (engine.version ? ' — v' + engine.version : ''))
        : engine.state === 'checking' ? 'Checking…'
          : engine.state === 'missing' ? 'Not running' : engine.state === 'absent' ? 'Not installed' : 'Not detected';
    return '<li class="setup-hub-row setup-hub-row--derived" data-setup-derived="local-engine">'
      + '<span class="setup-hub-glyph setup-hub-glyph--' + (done ? 'success' : 'warning')
      + '" aria-label="' + (done ? 'Running' : 'Needs attention') + '">' + (done ? '✓' : '!') + '</span>'
      + '<div class="setup-hub-row-copy"><div class="setup-hub-row-title">Local engine</div>'
      + '<p class="setup-hub-row-description">' + escapeHtml(label) + '</p></div>'
      + '<div class="setup-hub-row-actions">' + (done ? '' : renderButton({
        id: 'openStep', label: 'Set up', variant: 'secondary', size: 'sm', dataset: { 'step-id': 'localEngine' },
      })) + '</div></li>';
  }

  function firstUnresolvedRequiredStepId(setupState) {
    var health = sceneUtils.computeSetupHealth(setupState);
    var unresolved = health.pendingSteps.concat(health.skippedSteps);
    if (unresolved.indexOf('workspaceRoot') !== -1) return 'workspaceRoot';
    if (unresolved.indexOf('model') !== -1) return 'localModel';
    return '';
  }

  function warningCopy(setupState) {
    if (sceneUtils.computeSetupHealth(setupState).state === 'complete') {
      return "Jenny can't reach a model right now — start the local engine or validate an endpoint, then try again.";
    }
    var workspaceDone = setupState.steps && setupState.steps.workspaceRoot === 'done';
    return workspaceDone
      ? "No model configured — chats can't run locally."
      : 'No workspace root set — file tools will be off until you set one.';
  }

  function requiredHealthLine(setupState) {
    var health = sceneUtils.computeSetupHealth(setupState);
    var completed = 2 - health.pendingSteps.length - health.skippedSteps.length;
    return Math.max(0, completed) + ' of 2 required steps complete';
  }

  function buildWarning(setupState) {
    var healthComplete = sceneUtils.computeSetupHealth(setupState).state === 'complete';
    var stepId = healthComplete ? 'localEngine' : (firstUnresolvedRequiredStepId(setupState) || 'localModel');
    var fixLabel = healthComplete ? 'Check local engine'
      : stepId === 'workspaceRoot' ? 'Set workspace root' : 'Configure model';
    return '<div class="setup-hub-finish-warning" role="alert">'
      + '<div class="setup-hub-warning-copy"><strong>Setup is not ready</strong><p>'
      + escapeHtml(warningCopy(setupState)) + '</p></div>'
      + '<div class="setup-hub-warning-actions">'
      + renderButton({ id: 'fixRequired', label: fixLabel, variant: 'primary', dataset: { 'step-id': stepId } })
      + renderButton({ id: 'finishAnyway', label: 'Finish anyway', variant: 'ghost' })
      + renderButton({ id: 'finishGateCancel', label: 'Dismiss', variant: 'ghost', ariaLabel: 'Dismiss finish warning',
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
    var appendClientLog = typeof d.appendClientLog === 'function' ? d.appendClientLog : function () {};
    var rootEl = null;
    var unbindClicks = null;
    var focusTimer = null;
    var disposed = false;
    var detectGeneration = 0;
    var finishGateOpen = false;
    var finishInFlight = false;
    var skipInFlight = {};
    var engine = { state: 'checking', version: '' };

    function render() {
      if (!rootEl || disposed) return;
      var rows = registry.map(function renderRegistryStep(spec) { return buildStepRow(spec, setupState); });
      rows.splice(2, 0, buildEngineRow(engine));
      var body = '<div class="setup-hub"><ol class="setup-hub-list">' + rows.join('') + '</ol>'
        + (finishGateOpen ? buildWarning(setupState) : '')
        + '<p class="setup-hub-health" aria-live="polite">' + escapeHtml(requiredHealthLine(setupState)) + '</p></div>';
      rootEl.innerHTML = sceneUtils.renderStepModalHtml({
        id: 'setup-hub',
        title: 'Set up Jenny',
        summary: 'Two steps are required — everything else you can tune now or later in Settings. Do them in any order.',
        bodyHtml: body,
        actions: [
          { id: 'close', label: 'Finish later', variant: 'secondary' },
          { id: 'finishSetup', label: finishInFlight ? 'Checking…' : 'Finish setup',
            variant: 'primary', disabled: finishInFlight },
        ],
      });
    }

    function focusFirstUnresolvedRequired() {
      if (!rootEl) return;
      var stepId = firstUnresolvedRequiredStepId(setupState);
      var target = stepId
        ? rootEl.querySelector('[data-action="openStep"][data-step-id="' + stepId + '"]')
        : rootEl.querySelector('[data-step-modal-action="finishSetup"]');
      if (target && typeof target.focus === 'function') target.focus();
    }

    function renderEngineRow() {
      if (!rootEl || disposed) return;
      var current = rootEl.querySelector('[data-setup-derived="local-engine"]');
      if (!current) { render(); return; }
      current.outerHTML = buildEngineRow(engine);
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

    async function handleFinish() {
      if (sceneUtils.computeSetupHealth(setupState).state !== 'complete') {
        finishGateOpen = true;
        render();
        focusWarningFix();
        return;
      }
      if (finishInFlight) return;
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
        renderEngineRow();
      }, function applyDetectFailure(error) {
        if (disposed || generation !== detectGeneration) return;
        engine = { state: 'unknown', version: '' };
        appendClientLog('WARN', 'setup.hub_engine_detect_failed', {
          message: error && error.message ? error.message : String(error),
        });
        renderEngineRow();
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
        focusFirstUnresolvedRequired();
        focusTimer = setTimeout(focusFirstUnresolvedRequired, 0);
        detectEngine();
      },
      dispose: function dispose() {
        disposed = true;
        detectGeneration += 1;
        if (focusTimer !== null) clearTimeout(focusTimer);
        focusTimer = null;
        if (typeof unbindClicks === 'function') unbindClicks();
        unbindClicks = null;
        rootEl = null;
      },
    };
  }

  return { createScene: createScene };
});
