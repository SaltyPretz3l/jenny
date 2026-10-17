'use strict';

// Preemptible background auxiliary inference (agentic memory v2, W2). A chat
// turn must never wait behind background work: chat admission asks the sidecar
// to cancel every running preemptible auxiliary request, waits up to a budget
// for each to settle (lease released or quarantined), and aborts the rest
// locally. An abandoned request whose provider attempt never confirmed cleanup
// stays quarantined, so its capacity stays charged (lanes.js uncertain-producer
// rule); preemption never fabricates a settlement.

const DEFAULT_BUDGET_MS = 2000;
const CANCEL_REASON = 'preempted';
const registries = new WeakMap();

function createPreemptionError(cause) {
  const error = new Error('Auxiliary inference was preempted by a foreground chat turn.');
  error.reason = 'auxiliary_preempted';
  error.retryable = true;
  error.cause = cause;
  return error;
}

// Registers one in-flight request before it is sent. The returned signal
// aborts on the caller's signal or a local abandonment; settle() is called once
// the request's lease is released or quarantined.
function registerPreemptibleAuxiliary(service, { requestId, method, sessionId = null, signal = null }) {
  const registry = registries.get(service) || new Map();
  registries.set(service, registry);
  const controller = new AbortController();
  const forward = () => controller.abort(signal.reason);
  if (signal?.aborted) forward();
  else signal?.addEventListener('abort', forward, { once: true });
  let resolveSettled;
  const entry = { requestId, method, sessionId, state: 'running', controller,
    settled: new Promise(resolve => { resolveSettled = resolve; }) };
  registry.set(requestId, entry);
  return {
    signal: controller.signal,
    // Preempted: the sidecar's auxiliary_cancelled answer or our local abort,
    // never a caller's own abort or an unrelated failure.
    mapError(error) {
      if (entry.state === 'running' || signal?.aborted) return error;
      const preemptedAbort = entry.state === 'abandoned' && controller.signal.aborted;
      return preemptedAbort || error?.rpc?.data?.reason === 'auxiliary_cancelled'
        ? createPreemptionError(error) : error;
    },
    // Chat admission asked this request to stop: work still to do after the
    // sidecar's answer (reflection's apply) must not start.
    assertNotPreempted() {
      if (entry.state !== 'running') throw createPreemptionError(null);
    },
    // The request ended without the sidecar's answer (a timeout or the caller's
    // abort): its producer may still be generating, and once settle() drops this
    // entry chat admission can no longer cancel it, so cancel it now.
    cancelProducer(cancelReason) {
      if (entry.state !== 'running') return;
      entry.state = 'cancel_requested';
      try {
        service.sidecarClient?._sendBestEffortChatCancel?.({ requestId, sessionId, cancelReason });
      } catch (_error) { /* Best effort, like preemption's own cancel. */ }
    },
    settle() {
      signal?.removeEventListener('abort', forward);
      if (registry.get(requestId) === entry) registry.delete(requestId);
      resolveSettled();
    },
  };
}

function preemptibleAuxiliaryCount(service) {
  return registries.get(service)?.size || 0;
}

async function preemptAuxiliaryInference(service, {
  reason = 'unspecified', budgetMs = DEFAULT_BUDGET_MS, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  const registry = registries.get(service);
  if (!registry?.size) return { preempted: 0, settled: 0, abandoned: 0, elapsed_ms: 0 };
  const startedAt = now();
  // A concurrent admission also waits on entries an earlier call already cancelled.
  const entries = [...registry.values()];
  for (const entry of entries) {
    if (entry.state !== 'running') continue;
    entry.state = 'cancel_requested';
    try {
      service.sidecarClient?._sendBestEffortChatCancel?.({ requestId: entry.requestId,
        sessionId: entry.sessionId, cancelReason: CANCEL_REASON });
    } catch (_error) { /* Best effort: the deadline below still bounds the wait. */ }
  }
  const settledEntries = new Set();
  let timer = null;
  await Promise.race([
    Promise.all(entries.map(entry => entry.settled.then(() => settledEntries.add(entry)))),
    new Promise(resolve => { timer = setTimer(resolve, budgetMs); timer?.unref?.(); }),
  ]);
  clearTimer(timer);
  let abandoned = 0;
  for (const entry of entries) {
    if (settledEntries.has(entry)) continue;
    abandoned += 1;
    entry.state = 'abandoned';
    if (registry.get(entry.requestId) === entry) registry.delete(entry.requestId);
    entry.controller.abort(new Error('auxiliary_preempted'));
  }
  const result = { preempted: entries.length, settled: entries.length - abandoned, abandoned,
    elapsed_ms: Math.max(0, now() - startedAt) };
  service._emitServiceLog?.('INFO', 'runtime.auxiliary_preempted', { reason, ...result });
  return result;
}

module.exports = { preemptAuxiliaryInference, preemptibleAuxiliaryCount, registerPreemptibleAuxiliary };
