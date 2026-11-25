'use strict';

// The managed-server manager getters main.js threads into the backend service,
// the runtime services (Setup's endpoint check) and the IPC registration
// (llama-server, NInfer row 54, Strata row 200). One spread in main.js, which
// sits at its hotspot line cap, so a new managed engine adds a getter here
// instead of a line there. No dependencies: main requires it early.

function managedServerGetters(getRuntimeShutdownController) {
  return {
    getLlamaServerManager: () => getRuntimeShutdownController().getLlamaServerManager(),
    getNinferManager: () => getRuntimeShutdownController().getNinferManager(),
    getStrataManager: () => getRuntimeShutdownController().getStrataManager(),
  };
}

module.exports = managedServerGetters;
