// Unsupported ARM platforms use an unavailable fallback. Refreshes are
// throttled and share one in-flight attempt, preferring the ready sidecar before
// falling through to direct GPU telemetry while retaining the last-known sample
// on failure. GPU probes stay decoupled from the two-second CPU/RAM stats tick.
const GPU_MEMORY_REFRESH_INTERVAL_MS = 15000;
const MANUAL_REFRESH_MIN_INTERVAL_MS = 1500;

function createGpuMemorySampleController({
  systemArch = '',
  systemPlatform = String(process.platform || ''),
  createUnavailableGpuMemorySample = () => ({}),
  normalizeGpuMemorySample = (sample) => sample,
  buildSystemStatsPayload = (baseStats) => baseStats,
  isGpuTelemetrySupported = ({ arch, platform } = {}) => (
    require('../system-stats-payload').isGpuTelemetrySupported({ arch, platform })
  ),
  probeGpuTelemetry = async () => null,
  getBackendService = () => null,
  getStats = () => null,
  refreshIntervalMs = GPU_MEMORY_REFRESH_INTERVAL_MS,
} = {}) {
  let gpuMemorySample = createUnavailableGpuMemorySample();
  let gpuMemoryRefreshPromise = null;
  let gpuMemoryLastRefreshAt = 0;
  let gpuMemoryLastRefreshOk = true;
  let gpuMemoryLastAttemptAt = 0;

  function getCurrentSystemStatsPayload(baseStats = null, { fresh = false } = {}) {
    return buildSystemStatsPayload(baseStats || getStats({ fresh }), {
      arch: systemArch,
      platform: systemPlatform,
      gpuMemorySample,
      gpuRefreshStatus: {
        ok: gpuMemoryLastRefreshOk,
        at: new Date(
          gpuMemoryLastAttemptAt || Date.parse(gpuMemorySample?.sampledAt) || Date.now()
        ).toISOString(),
      },
    });
  }

  function canUseSidecarVramPath() {
    // The sidecar's VRAM RPC is nvidia-smi-only. On macOS it "succeeds" with a
    // truthy unavailable sample, which would short-circuit the ioreg Metal
    // probe forever — so darwin always takes the direct platform probe.
    if (String(systemPlatform || '') === 'darwin') {
      return false;
    }
    const backendService = getBackendService();
    if (!backendService || typeof backendService.getHardwareVramUsage !== 'function') {
      return false;
    }
    const backendStatus = backendService.getBackendStatus?.();
    return String(backendStatus?.phase || '') === 'ready';
  }

  async function refreshGpuMemorySample({ force = false, manual = false } = {}) {
    if (!isGpuTelemetrySupported({ arch: systemArch, platform: systemPlatform })) {
      gpuMemorySample = createUnavailableGpuMemorySample({ source: 'arm_fallback' });
      return gpuMemorySample;
    }
    const now = Date.now();
    if (!force && now - gpuMemoryLastRefreshAt < refreshIntervalMs) {
      return gpuMemorySample;
    }
    if (gpuMemoryRefreshPromise) {
      return gpuMemoryRefreshPromise;
    }
    if (manual && now - gpuMemoryLastAttemptAt < MANUAL_REFRESH_MIN_INTERVAL_MS) {
      return gpuMemorySample;
    }
    gpuMemoryLastRefreshAt = now;
    gpuMemoryLastAttemptAt = now;
    gpuMemoryRefreshPromise = (async () => {
      try {
        // The sidecar RPC returns null while a chat stream is active or on RPC
        // failure. Direct probing is correct then: the GPU is already awake during
        // generation, and the cost remains bounded by the 15-second cadence.
        const sidecarSample = canUseSidecarVramPath()
          ? await getBackendService().getHardwareVramUsage()
          : null;
        const sample = sidecarSample || await probeGpuTelemetry({ platform: systemPlatform });
        if (sample && typeof sample === 'object') {
          // Probes report failure as a RESOLVED unavailable sample (no memory,
          // no utilization), not a rejection. Adopting one over a last-known
          // reading would erase it and mask the failure as a fresh ok refresh;
          // a machine with no GPU (unavailable -> unavailable) stays ok.
          const normalized = normalizeGpuMemorySample(sample);
          const sampleHasData = normalized.available || normalized.utilAvailable;
          const lastHadData = Boolean(gpuMemorySample?.available || gpuMemorySample?.utilAvailable);
          if (sampleHasData || !lastHadData) {
            gpuMemorySample = normalized;
            gpuMemoryLastRefreshOk = true;
          } else {
            gpuMemoryLastRefreshOk = false;
          }
        } else {
          gpuMemoryLastRefreshOk = false;
        }
      } catch (_error) {
        // Keep the last known sample on refresh failures.
        gpuMemoryLastRefreshOk = false;
      }
      return gpuMemorySample;
    })().finally(() => {
      gpuMemoryRefreshPromise = null;
    });
    return gpuMemoryRefreshPromise;
  }

  function resetGpuMemorySample(sample) {
    gpuMemorySample = sample;
    gpuMemoryRefreshPromise = null;
    gpuMemoryLastRefreshAt = 0;
    gpuMemoryLastRefreshOk = true;
    gpuMemoryLastAttemptAt = 0;
  }

  return {
    getCurrentSystemStatsPayload,
    canUseSidecarVramPath,
    refreshGpuMemorySample,
    resetGpuMemorySample,
  };
}

module.exports = {
  GPU_MEMORY_REFRESH_INTERVAL_MS,
  MANUAL_REFRESH_MIN_INTERVAL_MS,
  createGpuMemorySampleController,
};
