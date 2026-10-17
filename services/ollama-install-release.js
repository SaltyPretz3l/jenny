'use strict';

// A Linux install first stops Jenny's own engine to free port 11434. A cancel can publish
// the terminal response while that stop is still running, so the operation keeps its
// lifecycle latch until the release AND the engine's restoration settle; a release that
// settles after the terminal response restores the engine (exactly once) before the latch is freed.
async function releaseOwnedEngine(service, entry) {
  entry.releasing = true;
  entry.ownedReleased = await Promise.resolve()
    .then(service.releaseOwnedImpl).then((value) => value === true, () => true);
  entry.releasing = false;
  if (entry.finished) {
    if (entry.ownedReleased && !entry.restartAttempted && service.restartImpl) await restoreOwnedEngine(service, entry);
    else releaseInstallLatch(service, entry);
  }
  return entry.ownedReleased;
}

// Restarts the released engine of a finished operation; its latch is freed once that settles.
async function restoreOwnedEngine(service, entry) {
  entry.restoring = true;
  try {
    await service._restartEngine(entry);
  } finally {
    entry.restoring = false;
  }
  releaseInstallLatch(service, entry);
}

// Frees the operation's latch unless a release or restoration is still in flight (it frees it).
function releaseInstallLatch(service, entry) {
  if (entry.releasing || entry.restoring) return;
  service._active.delete(entry.requestId);
  if (service._activeOperation === entry) service._activeOperation = null;
}

module.exports = { releaseInstallLatch, releaseOwnedEngine, restoreOwnedEngine };
