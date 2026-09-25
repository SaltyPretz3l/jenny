'use strict';

const STARTUP_RUNTIME_WAIT_MS = 30_000;

function waitForDelay(delayMs, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', done);
      resolve();
    };
    const timer = setTimeout(done, delayMs);
    timer.unref?.();
    signal?.addEventListener?.('abort', done, { once: true });
  });
}

async function waitForRuntimeSidecar(getClient, {
  timeoutMs = STARTUP_RUNTIME_WAIT_MS,
  pollMs = 50,
  now = Date.now,
  signal = null,
  wait = waitForDelay,
} = {}) {
  const deadline = now() + Math.max(1, Number(timeoutMs) || 1);
  do {
    if (signal?.aborted) return false;
    const client = getClient?.();
    if (client?.connected === true && typeof client.initialize === 'function') return true;
    await wait(
      Math.min(Math.max(1, Number(pollMs) || 1), Math.max(1, deadline - now())),
      signal
    );
  } while (now() < deadline);
  if (signal?.aborted) return false;
  const client = getClient?.();
  return client?.connected === true && typeof client.initialize === 'function';
}

function createStartupSafeRuntimeCoordinator(backendService, coordinator, { signal = null } = {}) {
  const guard = (method) => async (...args) => {
    // The backend's first handshake is a prerequisite, not a plugin apply.
    // Waiting inside the adapter spends the apply deadline before it can send
    // anything, leaving a late attestation without provider/view publication.
    if (backendService?._managedReadyOnce === false && backendService?._stopping !== true) {
      const ready = await waitForRuntimeSidecar(() => (
        backendService?._managedReadyOnce === true && backendService?._stopping !== true
          ? backendService.sidecarClient : null
      ), { signal });
      if (!ready) return { ok: false, reason: 'runtime_sidecar_unavailable', ambiguous: false };
    }
    if (signal?.aborted || backendService?._stopping === true) {
      return { ok: false, reason: 'runtime_sidecar_unavailable', ambiguous: false };
    }
    return coordinator[method](...args);
  };
  return Object.freeze({ ...coordinator, prepare: guard('prepare'), reconcile: guard('reconcile') });
}

module.exports = { waitForRuntimeSidecar, createStartupSafeRuntimeCoordinator };
