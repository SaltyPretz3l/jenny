'use strict';

const { settlementPromise } = require('./active-stream-shutdown-drain');

const DEFAULT_OLLAMA_PS_URL = 'http://127.0.0.1:11434/api/ps';
const DEFAULT_TIMEOUT_MS = 3_000;
const GPU_FREE_BY_DESIGN_ENGINES = new Set(['chatgpt', 'codex-cli', 'mock', 'replay']);

function errorCode(error) {
  return String(error?.code || error?.cause?.code || '').trim().toUpperCase();
}

async function verifyOllamaGpuEvicted({ fetchImpl = globalThis.fetch,
  url = DEFAULT_OLLAMA_PS_URL, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'gpu_eviction_unverifiable' };
  try {
    const response = await fetchImpl(url, {
      method: 'GET', signal: AbortSignal.timeout(Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS)),
    });
    if (!response?.ok || typeof response.json !== 'function') {
      return { ok: false, reason: 'gpu_eviction_probe_failed' };
    }
    const payload = await response.json();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || !Array.isArray(payload.models)) {
      return { ok: false, reason: 'gpu_eviction_probe_failed' };
    }
    const resident = payload.models.length;
    return resident === 0 ? { ok: true } : {
      ok: false, reason: 'gpu_model_still_resident', resident_count: resident,
    };
  } catch (error) {
    return errorCode(error) === 'ECONNREFUSED'
      ? { ok: true, daemon_absent: true }
      : { ok: false, reason: 'gpu_eviction_probe_failed' };
  }
}

async function verifyGpuEvictedForEngine({ engineType, ...options } = {}) {
  const normalized = String(engineType || '').trim().toLowerCase();
  if (normalized === 'ollama') return verifyOllamaGpuEvicted(options);
  if (GPU_FREE_BY_DESIGN_ENGINES.has(normalized)) {
    const ollama = await verifyOllamaGpuEvicted(options);
    return ollama.ok === true
      ? { ...ollama, proof: 'engine_has_no_local_gpu_runtime' }
      : ollama;
  }
  return { ok: false, reason: 'gpu_eviction_unverifiable' };
}

async function drainActiveChatStreams({ activeStreams, cancelStream,
  getPendingLeaseSettlementBarriers,
  timeoutMs = 10_000, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  const snapshot = activeStreams && typeof activeStreams.entries === 'function'
    ? [...activeStreams.entries()] : [];
  for (const [streamId] of snapshot) {
    try { cancelStream?.(streamId); } catch (_error) {
      return { ok: false, reason: 'chat_drain_unverified' };
    }
  }
  const pending = snapshot.map(([, controller]) => settlementPromise(controller));
  if (pending.some((candidate) => !candidate)) {
    return { ok: false, reason: 'chat_drain_unverified' };
  }
  if (typeof getPendingLeaseSettlementBarriers !== 'function') {
    if (!pending.length) return { ok: true, stream_count: snapshot.length };
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeoutFn(() => resolve(false), Math.max(1, Number(timeoutMs) || 10_000));
      timer?.unref?.();
    });
    const drained = await Promise.race([Promise.allSettled(pending).then(() => true), timeout]);
    if (timer) clearTimeoutFn(timer);
    return drained
      ? { ok: true, stream_count: snapshot.length }
      : { ok: false, reason: 'chat_drain_unverified' };
  }
  if (!activeStreams || typeof activeStreams.entries !== 'function') {
    return { ok: false, reason: 'chat_drain_unverified' };
  }
  let leaseBarriers;
  try {
    leaseBarriers = getPendingLeaseSettlementBarriers();
  } catch (_error) {
    return { ok: false, reason: 'chat_drain_unverified' };
  }
  if (!Array.isArray(leaseBarriers)
    || leaseBarriers.some((candidate) => !candidate || typeof candidate.then !== 'function')) {
    return { ok: false, reason: 'chat_drain_unverified' };
  }
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeoutFn(() => resolve(false), Math.max(1, Number(timeoutMs) || 10_000));
    timer?.unref?.();
  });
  const initialDrained = await Promise.race([
    Promise.allSettled([...pending, ...leaseBarriers]).then(() => true), timeout,
  ]);
  if (!initialDrained) {
    if (timer) clearTimeoutFn(timer);
    return { ok: false, reason: 'chat_drain_unverified' };
  }
  let followupSnapshot;
  try {
    followupSnapshot = activeStreams && typeof activeStreams.entries === 'function'
      ? [...activeStreams.entries()] : [];
  } catch (_error) {
    if (timer) clearTimeoutFn(timer);
    return { ok: false, reason: 'chat_drain_unverified' };
  }
  for (const [streamId] of followupSnapshot) {
    try { cancelStream?.(streamId); } catch (_error) {
      if (timer) clearTimeoutFn(timer);
      return { ok: false, reason: 'chat_drain_unverified' };
    }
  }
  const followupPending = followupSnapshot.map(([, controller]) => settlementPromise(controller));
  if (followupPending.some((candidate) => !candidate)) {
    if (timer) clearTimeoutFn(timer);
    return { ok: false, reason: 'chat_drain_unverified' };
  }
  const drained = !followupPending.length || await Promise.race([
    Promise.allSettled(followupPending).then(() => true), timeout,
  ]);
  if (timer) clearTimeoutFn(timer);
  return drained
    ? { ok: true, stream_count: snapshot.length + followupSnapshot.length }
    : { ok: false, reason: 'chat_drain_unverified' };
}

module.exports = {
  drainActiveChatStreams,
  verifyGpuEvictedForEngine,
  verifyOllamaGpuEvicted,
};
