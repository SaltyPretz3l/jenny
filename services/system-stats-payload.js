function isArmArchitecture(arch) {
  const token = String(arch || '').trim().toLowerCase();
  return token === 'arm' || token === 'arm64';
}

function isGpuTelemetrySupported({ arch, platform } = {}) {
  return !(isArmArchitecture(arch) && String(platform || '') !== 'darwin');
}

// GPU samples refresh every 15 seconds; expire them after 2.5 refresh intervals.
const GPU_SAMPLE_STALE_AFTER_MS = 37500;

function createUnavailableGpuMemorySample({
  source = 'unavailable',
  sampledAt = new Date().toISOString(),
} = {}) {
  return {
    available: false,
    usedMb: 0,
    totalMb: 0,
    utilAvailable: false,
    utilPercent: 0,
    gpuType: '',
    source: String(source || 'unavailable').trim() || 'unavailable',
    sampledAt: String(sampledAt || '').trim() || new Date().toISOString(),
  };
}

function normalizeGpuMemorySample(sample = {}) {
  const usedMb = Number(sample.usedMb ?? sample.used_mb ?? 0);
  const totalMb = Number(sample.totalMb ?? sample.total_mb ?? 0);
  const utilPercent = Number(sample.utilPercent ?? sample.util_percent ?? 0);
  const utilAvailableFlag = sample.utilAvailable ?? sample.util_available;
  const available =
    sample.available === true &&
    Number.isFinite(totalMb) &&
    totalMb > 0;
  const utilAvailable =
    utilAvailableFlag === true &&
    Number.isFinite(utilPercent) &&
    utilPercent >= 0 &&
    utilPercent <= 100;
  return {
    available,
    usedMb: Number.isFinite(usedMb) ? Math.max(usedMb, 0) : 0,
    totalMb: Number.isFinite(totalMb) ? Math.max(totalMb, 0) : 0,
    utilAvailable,
    utilPercent: utilAvailable ? Math.max(Math.min(utilPercent, 100), 0) : 0,
    gpuType: String(sample.gpuType ?? sample.gpu_type ?? '').trim(),
    source: String(sample.source || '').trim() || 'unavailable',
    sampledAt: String(sample.sampledAt ?? sample.sampled_at ?? '').trim() || new Date().toISOString(),
  };
}

function buildSystemStatsPayload(
  baseStats = {},
  { arch, platform, gpuMemorySample, gpuRefreshStatus, now = Date.now() } = {}
) {
  const normalizedArch = String(arch || '').trim().toLowerCase();
  const normalizedPlatform = String(platform || '');
  const effectiveGpuSample = !isGpuTelemetrySupported({ arch: normalizedArch, platform: normalizedPlatform })
    ? createUnavailableGpuMemorySample({ source: 'arm_fallback', sampledAt: baseStats.sampledAt })
    : normalizeGpuMemorySample(gpuMemorySample || createUnavailableGpuMemorySample({ sampledAt: baseStats.sampledAt }));
  const refreshStatus = gpuRefreshStatus == null
    ? { ok: true, at: effectiveGpuSample.sampledAt }
    : gpuRefreshStatus;
  const lastRefreshOk = refreshStatus.ok === true;
  const lastRefreshAt = String(refreshStatus.at || '');
  const sampledAtMs = Date.parse(effectiveGpuSample.sampledAt);
  const currentTimeMs = Number(now);
  const ageMs = Number.isFinite(sampledAtMs) && Number.isFinite(currentTimeMs)
    ? Math.max(currentTimeMs - sampledAtMs, 0)
    : 0;

  return {
    ...baseStats,
    arch: normalizedArch,
    platform: normalizedPlatform,
    gpuMemory: {
      ...effectiveGpuSample,
      lastRefreshOk,
      lastRefreshAt,
      ageMs,
      stale: !lastRefreshOk || ageMs > GPU_SAMPLE_STALE_AFTER_MS,
    },
  };
}

module.exports = {
  GPU_SAMPLE_STALE_AFTER_MS,
  buildSystemStatsPayload,
  createUnavailableGpuMemorySample,
  isArmArchitecture,
  isGpuTelemetrySupported,
  normalizeGpuMemorySample,
};
