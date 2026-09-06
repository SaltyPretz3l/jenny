/**
 * renderer/features/renderer-setup-hub.js
 *
 * Small navigation owner for the any-order first-run checklist hub.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSetupHub = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function noop() {}

  function createSetupHub(deps) {
    var d = deps || {};
    var renderHub = typeof d.renderHub === 'function' ? d.renderHub : noop;
    var renderStep = typeof d.renderStep === 'function' ? d.renderStep : noop;
    var onFinish = typeof d.onFinish === 'function' ? d.onFinish : noop;
    var appendClientLog = typeof d.appendClientLog === 'function' ? d.appendClientLog : noop;
    var openStepId = '';
    var disposed = false;
    var finishInFlight = null;

    function start() {
      if (disposed) return null;
      openStepId = '';
      return renderHub();
    }

    function openStep(stepId) {
      if (disposed) return null;
      openStepId = String(stepId || '');
      if (!openStepId) return null;
      return renderStep(openStepId);
    }

    function returnToHub() {
      if (disposed) return null;
      openStepId = '';
      return renderHub();
    }

    function finish(options) {
      if (disposed) return Promise.resolve();
      if (finishInFlight) return finishInFlight;
      var force = Boolean(options && options.force === true);
      finishInFlight = Promise.resolve()
        .then(function runFinish() { return onFinish({ force: force }); })
        .catch(function retainHub(error) {
          finishInFlight = null;
          appendClientLog('WARN', 'setup.hub_finish_failed', {
            message: error && error.message ? error.message : String(error),
          });
        });
      return finishInFlight;
    }

    function dispose() {
      disposed = true;
      openStepId = '';
    }

    return {
      start: start,
      openStep: openStep,
      returnToHub: returnToHub,
      finish: finish,
      dispose: dispose,
      getOpenStepId: function getOpenStepId() { return openStepId; },
    };
  }

  return { createSetupHub: createSetupHub };
});
