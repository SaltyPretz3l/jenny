'use strict';

const { registerIpcInvokeHandlers } = require('./ipc-contract');

function getWorkspaceRootStatePayload(configService, coordinator = null) {
  const state = configService.getState();
  return {
    workspaceRoot: state.toolsWorkspaceRoot || '',
    workspaceRootStatus: configService.getWorkspaceRootStatus(),
    ...(coordinator ? { context: coordinator.captureContext() } : {}),
  };
}

function registerWorkspaceRootIpcHandlers(
  ipcMainLike,
  {
    getState,
    captureContext,
    prepareChoose,
    prepareClear,
    commit,
    cancel,
    respondExternalTransition = () => ({
      accepted: false, code: 'external_transition_broker_unavailable',
    }),
    authorization = {},
  } = {}
) {
  registerIpcInvokeHandlers(ipcMainLike, {
    'workspaceRoot.getState': () => getState(),
    'workspaceRoot.captureContext': () => captureContext(),
    'workspaceRoot.prepareChoose': () => prepareChoose(),
    'workspaceRoot.prepareClear': () => prepareClear(),
    'workspaceRoot.commit': (_event, payload) => commit(payload),
    'workspaceRoot.cancel': (_event, payload) => cancel(payload),
    'workspaceRoot.respondExternalTransition': (_event, payload) => respondExternalTransition(payload),
  }, authorization);
}

module.exports = {
  getWorkspaceRootStatePayload,
  registerWorkspaceRootIpcHandlers,
};
