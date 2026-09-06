const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GPU_SAMPLE_STALE_AFTER_MS,
  buildSystemStatsPayload,
  isArmArchitecture,
  isGpuTelemetrySupported,
  normalizeGpuMemorySample,
} = require('../services/system-stats-payload');

const SAMPLED_AT = '2026-01-01T00:00:00.000Z';
const SAMPLED_AT_MS = Date.parse(SAMPLED_AT);

function availableSample(overrides = {}) {
  return {
    available: true,
    usedMb: 2048,
    totalMb: 8192,
    utilAvailable: true,
    utilPercent: 42,
    gpuType: 'cuda',
    source: 'nvidia-smi',
    sampledAt: SAMPLED_AT,
    ...overrides,
  };
}

test('isArmArchitecture detects ARM and ARM64 tokens', () => {
  assert.equal(isArmArchitecture('arm'), true);
  assert.equal(isArmArchitecture('arm64'), true);
  assert.equal(isArmArchitecture('x64'), false);
});

test('isGpuTelemetrySupported permits macOS ARM and rejects other ARM platforms', () => {
  assert.equal(isGpuTelemetrySupported({ arch: 'arm64', platform: 'darwin' }), true);
  assert.equal(isGpuTelemetrySupported({ arch: 'arm64', platform: 'win32' }), false);
  assert.equal(isGpuTelemetrySupported({ arch: 'arm64', platform: 'linux' }), false);
  assert.equal(isGpuTelemetrySupported({ arch: 'x64', platform: 'linux' }), true);
});

test('normalizeGpuMemorySample maps snake_case fields to camelCase', () => {
  const sample = normalizeGpuMemorySample({
    available: true,
    used_mb: 1024,
    total_mb: 4096,
    util_available: true,
    util_percent: 73,
    gpu_type: 'cuda',
    source: 'nvidia-smi',
    sampled_at: '2026-01-01T00:00:00+00:00',
  });

  assert.deepEqual(sample, {
    available: true,
    usedMb: 1024,
    totalMb: 4096,
    utilAvailable: true,
    utilPercent: 73,
    gpuType: 'cuda',
    source: 'nvidia-smi',
    sampledAt: '2026-01-01T00:00:00+00:00',
  });
});

test('normalizeGpuMemorySample disables invalid or unflagged utilization', () => {
  assert.deepEqual(
    normalizeGpuMemorySample({
      utilAvailable: true,
      utilPercent: 101,
      sampledAt: SAMPLED_AT,
    }),
    {
      available: false,
      usedMb: 0,
      totalMb: 0,
      utilAvailable: false,
      utilPercent: 0,
      gpuType: '',
      source: 'unavailable',
      sampledAt: SAMPLED_AT,
    }
  );
});

test('buildSystemStatsPayload includes platform and enriched gpuMemory fields for non-ARM', () => {
  const payload = buildSystemStatsPayload(
    {
      cpuPercent: 10,
      ramPercent: 25,
      battery: 'AC',
      sampledAt: SAMPLED_AT,
    },
    {
      arch: 'x64',
      platform: 'win32',
      gpuMemorySample: availableSample(),
      now: SAMPLED_AT_MS,
    }
  );

  assert.equal(payload.arch, 'x64');
  assert.equal(payload.platform, 'win32');
  assert.deepEqual(payload.gpuMemory, {
    available: true,
    usedMb: 2048,
    totalMb: 8192,
    utilAvailable: true,
    utilPercent: 42,
    gpuType: 'cuda',
    source: 'nvidia-smi',
    sampledAt: SAMPLED_AT,
    lastRefreshOk: true,
    lastRefreshAt: SAMPLED_AT,
    ageMs: 0,
    stale: false,
  });
});

test('buildSystemStatsPayload passes through gpu telemetry on darwin ARM64', () => {
  const payload = buildSystemStatsPayload({}, {
    arch: 'arm64',
    platform: 'darwin',
    gpuMemorySample: availableSample({
      available: false,
      usedMb: 0,
      totalMb: 0,
      gpuType: 'metal',
      source: 'ioreg',
    }),
    now: SAMPLED_AT_MS,
  });

  assert.equal(payload.gpuMemory.source, 'ioreg');
  assert.equal(payload.gpuMemory.utilAvailable, true);
  assert.equal(payload.gpuMemory.utilPercent, 42);
});

test('buildSystemStatsPayload forces unavailable gpuMemory on win32 ARM64', () => {
  const payload = buildSystemStatsPayload(
    {
      cpuPercent: 10,
      ramPercent: 25,
      battery: 'AC',
      sampledAt: SAMPLED_AT,
    },
    {
      arch: 'arm64',
      platform: 'win32',
      gpuMemorySample: availableSample(),
      now: SAMPLED_AT_MS,
    }
  );

  assert.equal(payload.arch, 'arm64');
  assert.equal(payload.platform, 'win32');
  assert.deepEqual(payload.gpuMemory, {
    available: false,
    usedMb: 0,
    totalMb: 0,
    utilAvailable: false,
    utilPercent: 0,
    gpuType: '',
    source: 'arm_fallback',
    sampledAt: SAMPLED_AT,
    lastRefreshOk: true,
    lastRefreshAt: SAMPLED_AT,
    ageMs: 0,
    stale: false,
  });
});

test('buildSystemStatsPayload computes sample age and staleness from injected now', () => {
  const fresh = buildSystemStatsPayload({}, {
    arch: 'x64',
    platform: 'linux',
    gpuMemorySample: availableSample(),
    now: SAMPLED_AT_MS + GPU_SAMPLE_STALE_AFTER_MS,
  });
  const stale = buildSystemStatsPayload({}, {
    arch: 'x64',
    platform: 'linux',
    gpuMemorySample: availableSample(),
    now: SAMPLED_AT_MS + GPU_SAMPLE_STALE_AFTER_MS + 1,
  });

  assert.equal(fresh.gpuMemory.ageMs, GPU_SAMPLE_STALE_AFTER_MS);
  assert.equal(fresh.gpuMemory.stale, false);
  assert.equal(stale.gpuMemory.ageMs, GPU_SAMPLE_STALE_AFTER_MS + 1);
  assert.equal(stale.gpuMemory.stale, true);
});

test('failed gpu refresh marks retained sample values stale', () => {
  const payload = buildSystemStatsPayload({}, {
    arch: 'x64',
    platform: 'win32',
    gpuMemorySample: availableSample(),
    gpuRefreshStatus: { ok: false, at: '2026-01-01T00:00:05.000Z' },
    now: SAMPLED_AT_MS + 5000,
  });

  assert.equal(payload.gpuMemory.usedMb, 2048);
  assert.equal(payload.gpuMemory.utilPercent, 42);
  assert.equal(payload.gpuMemory.lastRefreshOk, false);
  assert.equal(payload.gpuMemory.lastRefreshAt, '2026-01-01T00:00:05.000Z');
  assert.equal(payload.gpuMemory.stale, true);
});

test('omitted gpu refresh status defaults to a successful fresh sample', () => {
  const sample = availableSample();
  const payload = buildSystemStatsPayload({}, {
    arch: 'x64',
    platform: 'win32',
    gpuMemorySample: sample,
    now: SAMPLED_AT_MS,
  });

  assert.equal(payload.gpuMemory.lastRefreshOk, true);
  assert.equal(payload.gpuMemory.lastRefreshAt, SAMPLED_AT);
  assert.equal(payload.gpuMemory.stale, false);
  assert.equal(Object.hasOwn(sample, 'stale'), false);
});
