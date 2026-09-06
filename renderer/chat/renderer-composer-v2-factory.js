/* renderer/chat/renderer-composer-v2-factory.js - Composer V2 factory bundle. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-composer-v2-state'),
      require('./renderer-composer-v2-flow')
    );
    return;
  }
  root.rendererComposerV2Factory = factory(root.rendererComposerV2State || {}, root.rendererComposerV2Flow || {});
})(typeof globalThis !== 'undefined' ? globalThis : this, function (composerV2State, composerV2Flow) {
  'use strict';

  const { ensureComposerV2State } = composerV2State || {};
  const { createComposerV2FlowController } = composerV2Flow || {};
  const COMPOSER_V2_DECORATION_MARKER = Object.freeze({ decorationsEnabled: true });

  function createComposerV2Factory(deps) {
    const sendUtils = deps && deps.sendUtils;
    if (!sendUtils || typeof sendUtils.createSendController !== 'function') {
      throw new Error('createComposerV2Factory: deps.sendUtils.createSendController is required');
    }
    if (typeof ensureComposerV2State !== 'function') {
      throw new Error('createComposerV2Factory: composer-v2-state is not loaded');
    }
    if (typeof createComposerV2FlowController !== 'function') {
      throw new Error('createComposerV2Factory: composer-v2-flow is not loaded');
    }
    const wrappedSendUtils = {
      ...sendUtils,
      createSendController(args) {
        const legacyController = sendUtils.createSendController(args);
        if (!legacyController || typeof legacyController !== 'object') {
          return legacyController;
        }
        if (!ensureComposerV2State(args && args.state)) {
          throw new Error('createComposerV2Factory: createSendController args.state is required');
        }
        return { ...legacyController, composerV2: COMPOSER_V2_DECORATION_MARKER };
      },
    };

    return { ...deps, composerFlowUtils: composerV2Flow, sendUtils: wrappedSendUtils };
  }

  return {
    createComposerV2Factory,
  };
});
