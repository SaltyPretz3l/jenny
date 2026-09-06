/**
 * renderer/features/setup-scenes/scene-utils.js
 *
 * Shared setup-scene and tile helpers.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.rendererSetupSceneUtils = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  function resolveDependency(globalKey, requirePath) {
    if (root && typeof root[globalKey] !== 'undefined') {
      return root[globalKey];
    }
    if (typeof require === 'function') {
      try {
        return require(requirePath);
      } catch (_error) {
        return null;
      }
    }
    return null;
  }

  function getStringUtils() {
    return resolveDependency('stringUtils', '../../shared/string-utils');
  }
  function getStepModal() {
    return resolveDependency('inventoryStepModal', '../../inventory/step-modal');
  }

  function escapeHtml(value) {
    var utils = getStringUtils();
    if (utils && typeof utils.escapeHtml === 'function') {
      return utils.escapeHtml(value);
    }
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Canonical renderer setup registry. Tile order, persistence names, and
  // user-facing counts are projections of this one table so adding an optional
  // step cannot silently drift another surface.
  var SETUP_STEP_REGISTRY = Object.freeze([
    Object.freeze({ id: 'workspaceRoot', snake: 'workspace_root', order: 0,
      title: 'Choose workspace root', description: 'Pick the folder Jenny should treat as your working project.',
      tile: true, health: 'workspace' }),
    Object.freeze({ id: 'localModel', snake: 'local_model', order: 1,
      title: 'Pull a local model', description: 'Stream an Ollama model so chat works fully offline.',
      tile: true, health: 'model' }),
    Object.freeze({ id: 'endpoint', snake: 'endpoint', order: 2,
      title: 'Validate your endpoint', description: 'Reach a local Ollama, vLLM, or OpenAI-compatible server.',
      tile: true, health: 'model' }),
    Object.freeze({ id: 'personality', snake: 'personality', order: 3,
      title: 'Personality & name', description: 'Pick a profile, name your assistant, and add custom flavor.',
      tile: true, health: 'optional' }),
    Object.freeze({ id: 'skills', snake: 'skills', order: 4,
      title: 'Review skills & MCP', description: 'Glance at the skills and MCP tools Jenny will use.',
      tile: true, health: 'optional' }),
    Object.freeze({ id: 'capabilities', snake: 'capabilities', order: 5,
      title: 'Choose tools & permissions', description: 'Review network, workspace, and memory capabilities.',
      tile: true, health: 'optional' }),
  ]);
  var STEPS = Object.freeze(SETUP_STEP_REGISTRY.reduce(function buildStepMap(result, spec) {
    result[spec.id] = spec;
    return result;
  }, {}));
  var STEP_ORDER = Object.freeze(SETUP_STEP_REGISTRY.map(function readId(spec) { return spec.id; }));
  var STEP_SCENE = Object.freeze({
    workspaceRoot: 'workspaceRoot',
    localModel: 'modelLibrary',
    endpoint: 'endpoint',
    personality: 'personality',
    skills: 'skills',
    capabilities: 'capabilities',
    // Derived engine row -> gate scene; this is not a persisted setup step or health input.
    localEngine: 'ollamaEngine',
  });

  function snakeStepKey(camelKey) {
    var spec = STEPS[camelKey];
    return spec ? spec.snake : String(camelKey || '');
  }

  function setupStepEyebrow(stepId) {
    var spec = STEPS[stepId];
    return spec ? 'Setup · ' + (spec.order + 1) + ' of ' + STEP_ORDER.length : 'Setup';
  }

  var STATUS_META = Object.freeze({
    done: { tone: 'success', label: 'Done' },
    skipped: { tone: 'muted', label: 'Skipped' },
    error: { tone: 'danger', label: 'Needs attention' },
    pending: { tone: 'pending', label: 'Pending' },
  });

  function statusMeta(status) {
    return STATUS_META[String(status || '')] || STATUS_META.pending;
  }

  function isTerminalStatus(status) {
    return status === 'done' || status === 'skipped';
  }

  function isRequiredStep(stepId) {
    var spec = STEPS[stepId];
    return Boolean(spec && spec.health !== 'optional');
  }

  function requiredStepIds() {
    return STEP_ORDER.filter(isRequiredStep);
  }

  function countCompletedSteps(steps) {
    var done = 0;
    for (var i = 0; i < STEP_ORDER.length; i += 1) {
      if (isTerminalStatus(steps && steps[STEP_ORDER[i]])) done += 1;
    }
    return done;
  }

  // UIUX-005: renderer-side twin of services/shell-config-setup-state.js's
  // computeSetupHealth (that module runs in the main process / Node tests
  // only -- it is never script-tagged into the browser renderer). Required
  // for HEALTH (distinct from the wizard's optional steps) is workspaceRoot
  // plus model access via EITHER localModel or endpoint; a required step that
  // is merely 'skipped' still falls short of 'complete'.
  function requiredModelStepStatus(steps) {
    var localModel = (steps && steps.localModel) || 'pending';
    var endpoint = (steps && steps.endpoint) || 'pending';
    if (localModel === 'done' || endpoint === 'done') return 'done';
    var localTerminal = isTerminalStatus(localModel);
    var endpointTerminal = isTerminalStatus(endpoint);
    if (localTerminal && endpointTerminal) return 'skipped';
    return 'pending';
  }

  function computeSetupHealth(setup) {
    var steps = (setup && setup.steps && typeof setup.steps === 'object' && !Array.isArray(setup.steps))
      ? setup.steps
      : {};
    var required = {
      workspaceRoot: steps.workspaceRoot || 'pending',
      model: requiredModelStepStatus(steps),
    };
    var pendingSteps = [];
    var skippedSteps = [];
    Object.keys(required).forEach(function (key) {
      var status = required[key];
      if (status === 'done') return;
      if (status === 'skipped') { skippedSteps.push(key); return; }
      pendingSteps.push(key);
    });
    var state = 'complete';
    if (pendingSteps.length > 0) {
      state = 'pending';
    } else if (skippedSteps.length > 0) {
      state = 'degraded';
    }
    return { state: state, pendingSteps: pendingSteps, skippedSteps: skippedSteps };
  }

  function renderStepModalHtml(opts) {
    var stepModal = getStepModal();
    if (stepModal && typeof stepModal.renderStepModal === 'function') {
      return stepModal.renderStepModal(opts || {});
    }
    return '';
  }

  function bindActionDelegation(rootEl, handlers) {
    if (!rootEl || !handlers) return function noop() {};
    function onClick(event) {
      if (!event || !event.target || typeof event.target.closest !== 'function') return;
      var target = event.target.closest('[data-step-modal-action]')
        || event.target.closest('[data-action]');
      if (!target) return;
      var actionId = target.getAttribute('data-step-modal-action')
        || target.getAttribute('data-action');
      if (!actionId || typeof handlers[actionId] !== 'function') return;
      if (target.disabled === true) return;
      event.preventDefault();
      try {
        Promise.resolve(handlers[actionId](event, target)).catch(function logHandlerError(error) {
          if (typeof handlers.__onError === 'function') {
            handlers.__onError(error, actionId);
          }
        });
      } catch (error) {
        if (typeof handlers.__onError === 'function') {
          handlers.__onError(error, actionId);
        }
      }
    }
    rootEl.addEventListener('click', onClick);
    return function off() {
      rootEl.removeEventListener('click', onClick);
    };
  }

  return {
    escapeHtml: escapeHtml,
    resolveDependency: resolveDependency,
    renderStepModalHtml: renderStepModalHtml,
    bindActionDelegation: bindActionDelegation,
    STEPS: STEPS,
    SETUP_STEP_REGISTRY: SETUP_STEP_REGISTRY,
    STEP_ORDER: STEP_ORDER,
    STEP_SCENE: STEP_SCENE,
    STATUS_META: STATUS_META,
    statusMeta: statusMeta,
    snakeStepKey: snakeStepKey,
    setupStepEyebrow: setupStepEyebrow,
    isTerminalStatus: isTerminalStatus,
    isRequiredStep: isRequiredStep,
    requiredStepIds: requiredStepIds,
    countCompletedSteps: countCompletedSteps,
    computeSetupHealth: computeSetupHealth,
  };
});
