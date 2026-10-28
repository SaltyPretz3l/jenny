'use strict';

// Row 62: service starts that first paint does not need, kept out of backend
// construction (backend-service-wiring.js).
//
// startPostWindowServices: main.js runs it right after the IPC handlers
// register, in the same synchronous block as window creation. That is still
// ahead of the first renderer IPC (PDF add-on, image engine and command sandbox
// state) and of backendService.start(), whose first managed sidecar config
// carries the semantic catalog's settings.
//
// startSidecarIdleWorkers: the Row 58 memory workers wait for a ready sidecar
// before doing anything, so they start with the deferred refreshes once the
// backend is up (main.js startDeferredServices) instead of polling through boot.

function createPostWindowServiceStarters({
  backendService,
  pdfAddon,
  imageEngine,
  wireSemanticCatalog,
}) {
  let postWindowServicesStarted = false;
  function startPostWindowServices() {
    if (postWindowServicesStarted) return;
    postWindowServicesStarted = true;
    void pdfAddon.start().catch(() => {});
    imageEngine.start();
    void backendService.commandSandbox.start().catch(() => {});
    wireSemanticCatalog();
  }

  let sidecarIdleWorkersStarted = false;
  function startSidecarIdleWorkers() {
    if (sidecarIdleWorkersStarted) return;
    sidecarIdleWorkersStarted = true;
    // Row 58 W2: background reflection ("Jenny takes notes"), idle-gated like the catalog.
    require('../backend/memory-reflection-scheduler').startMemoryReflectionScheduler({ service: backendService });
    // Row 58 W4: feed past chats into the derived conversation index, idle-gated.
    require('../backend/conversation-index-pump').startConversationIndexPump({ service: backendService });
    // Row 58 W3: once per launch, purge chat memory of chats deleted while the sidecar was away.
    backendService.memoryPurgeReconcile = require('../backend/memory-purge-reconcile')
      .startMemoryPurgeReconcile({ service: backendService });
  }

  return { startPostWindowServices, startSidecarIdleWorkers };
}

module.exports = { createPostWindowServiceStarters };
