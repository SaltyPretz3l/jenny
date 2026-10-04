'use strict';

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

module.exports = {
  verifyGpuEvictedForEngine,
  verifyOllamaGpuEvicted,
};
