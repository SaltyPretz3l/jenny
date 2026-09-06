function createDefaultBackendStatus() {
  return { phase: 'ready', detail: '', mode: 'managed-dev' };
}

async function emitBackendStatus(listeners, state, payload) {
  const nextBackendStatus = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload
    : createDefaultBackendStatus();
  state.backendStatus = nextBackendStatus;
  await Promise.all((listeners.backend || []).map((listener) => listener(nextBackendStatus)));
}

function createBackendStub(options, state, listeners, addListener) {
  return {
    async getStatus() {
      if (typeof options.backend?.getStatus === 'function') {
        return options.backend.getStatus({
          state,
          emitBackendStatus: (payload) => emitBackendStatus(listeners, state, payload),
        });
      }
      return state.backendStatus;
    },
    async retryStart() {
      if (typeof options.backend?.retryStart === 'function') {
        return options.backend.retryStart({
          state,
          emitBackendStatus: (payload) => emitBackendStatus(listeners, state, payload),
        });
      }
      return { ok: true };
    },
    onStatus(listener) {
      return addListener('backend', listener);
    },
  };
}

module.exports = {
  createBackendStub,
  createDefaultBackendStatus,
  emitBackendStatus,
};
