const { registerIpcInvokeHandlers } = require('../../ipc-contract');
const { CONTEXT_LENGTH_STEPS } = require('../../shell-config-compaction-tuning');
const { buildNextTurnContextSummary } = require('../../backend/next-turn-context-summary');
const { previewContext } = require('../../backend/context-preview');

// Tuning and context domain IPC: model tuning, engine tuning, compaction tuning
// and the next-turn context summary. Every tuning channel answers through one
// never-throwing bridge shape.

function registerTuningIpcHandlers(ipcMainLike, {
  backendService,
  shellConfigService,
  modelTuningService,
  engineTuningService,
  log,
  ipcAuthorization,
}) {
  const emitTuningIpcFailure = (event, reason) => {
    try {
      log?.('WARN', event, { reason });
    } catch (_error) {
      // IPC fallback shapes must not depend on diagnostics availability.
    }
  };
  const getFallbackModelTuningState = () => {
    try {
      return shellConfigService?.getModelTuning?.() || {};
    } catch (_error) {
      emitTuningIpcFailure('model_tuning.ipc_failed', 'config_read_failed');
      return {};
    }
  };
  const getFallbackCompactionTuningState = () => {
    try {
      return {
        ...(shellConfigService?.getCompactionTuning?.() || {}),
        contextLengthSteps: CONTEXT_LENGTH_STEPS,
      };
    } catch (_error) {
      emitTuningIpcFailure('model_tuning.ipc_failed', 'config_read_failed');
      return { ratioByModel: {}, contextLengthByModel: {}, customPrompt: '', contextLengthSteps: CONTEXT_LENGTH_STEPS };
    }
  };
  // ONE bridge shape for every tuning service (model, compaction, engine): never
  // throw across the bridge, and always answer with the same {status, reason,
  // state} contract the renderer branches on - a bare rejection would leave the
  // field spinning. `fallbackState` may be overridden per call because the
  // compaction channel rides on the model-tuning service with its own state shape.
  const createTuningIpcBridge = ({ service, eventPrefix, fallbackState }) => {
    const readState = () => {
      try {
        return service?.getState?.() || fallbackState();
      } catch (_error) {
        emitTuningIpcFailure(`${eventPrefix}.ipc_failed`, 'service_read_failed');
        return fallbackState();
      }
    };
    const call = async (method, payload, fallbackStateOverride = fallbackState) => {
      if (!service?.[method]) {
        return {
          status: 'rejected',
          reason: `${eventPrefix}_service_unavailable`,
          state: fallbackStateOverride(),
        };
      }
      try {
        const result = await service[method](payload);
        if (!result || typeof result !== 'object' || Array.isArray(result)) {
          emitTuningIpcFailure(`${eventPrefix}.ipc_failed`, 'malformed_service_result');
          return { status: 'rejected', reason: 'malformed_service_result', state: fallbackStateOverride() };
        }
        return result;
      } catch (_error) {
        emitTuningIpcFailure(`${eventPrefix}.ipc_failed`, `service_${method}_failed`);
        return { status: 'rejected', reason: 'request_failed', state: fallbackStateOverride() };
      }
    };
    return { readState, call };
  };
  const modelTuningBridge = createTuningIpcBridge({
    service: modelTuningService,
    eventPrefix: 'model_tuning',
    fallbackState: getFallbackModelTuningState,
  });
  const engineTuningBridge = createTuningIpcBridge({
    service: engineTuningService,
    eventPrefix: 'engine_tuning',
    fallbackState: () => ({ values: {}, fields: [], groups: [], pending: false, activeStream: false }),
  });
  registerIpcInvokeHandlers(ipcMainLike, {
    'modelTuning.getState': () => modelTuningBridge.readState(),
    'modelTuning.update': (_, payload) => modelTuningBridge.call('update', payload),
    'engineTuning.getState': () => engineTuningBridge.readState(),
    'engineTuning.update': (_, payload) => engineTuningBridge.call('update', payload),
    'engineTuning.reset': (_, payload) => engineTuningBridge.call('reset', payload),
    'compaction.getTuning': () => getFallbackCompactionTuningState(),
    'compaction.setTuning': (_, payload = {}) => (
      modelTuningBridge.call('update', payload, getFallbackCompactionTuningState)
    ),
    'chat.getNextTurnContextSummary': async (_, sessionId, draftMetadata = {}) => ({
      ...buildNextTurnContextSummary(backendService?.sessionStore, sessionId, draftMetadata),
      preview: await previewContext(backendService, sessionId),
    }),
  }, ipcAuthorization);
}

module.exports = {
  registerTuningIpcHandlers,
};
