'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createGpuMemorySampleController,
  GPU_MEMORY_REFRESH_INTERVAL_MS,
  MANUAL_REFRESH_MIN_INTERVAL_MS,
} = require('../services/main/gpu-memory-sample');
// Use the REAL payload helpers rather than local doubles: a local fake that
// lags the payload shape (it happened with the util fields) silently weakens
// every assertion routed through it.
const {
  buildSystemStatsPayload: buildPayload,
  createUnavailableGpuMemorySample,
  isGpuTelemetrySupported,
  normalizeGpuMemorySample,
} = require('../services/system-stats-payload');

function buildSystemStatsPayload(baseStats, options = {}) {
  return buildPayload(baseStats, options);
}

function makeController(overrides = {}) {
  return createGpuMemorySampleController({
    systemArch: 'x64',
    systemPlatform: 'win32',
    createUnavailableGpuMemorySample,
    normalizeGpuMemorySample,
    buildSystemStatsPayload,
    isGpuTelemetrySupported,
    probeGpuTelemetry: async () => createUnavailableGpuMemorySample({ source: 'nvidia-smi' }),
    getBackendService: () => null,
    getStats: () => ({ cpu: 1 }),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// GPU_MEMORY_REFRESH_INTERVAL_MS default export
// ---------------------------------------------------------------------------

test('exports the default 15s refresh interval constant', () => {
  assert.equal(GPU_MEMORY_REFRESH_INTERVAL_MS, 15000);
  assert.equal(MANUAL_REFRESH_MIN_INTERVAL_MS, 1500);
});

// ---------------------------------------------------------------------------
// getCurrentSystemStatsPayload
// ---------------------------------------------------------------------------

test('getCurrentSystemStatsPayload: uses injected getStats() when no baseStats given', () => {
  const controller = makeController({ getStats: () => ({ cpu: 42 }) });
  const payload = controller.getCurrentSystemStatsPayload();
  assert.equal(payload.cpu, 42);
  assert.equal(payload.arch, 'x64');
  assert.equal(payload.platform, 'win32');
});

test('getCurrentSystemStatsPayload: prefers explicit baseStats over getStats()', () => {
  const controller = makeController({ getStats: () => ({ cpu: 42 }) });
  const payload = controller.getCurrentSystemStatsPayload({ cpu: 7 });
  assert.equal(payload.cpu, 7);
});

test('getCurrentSystemStatsPayload: requests a non-committing fresh stats sample', () => {
  let receivedOptions = null;
  const controller = makeController({
    getStats: (options) => {
      receivedOptions = options;
      return { cpu: 9 };
    },
  });
  const payload = controller.getCurrentSystemStatsPayload(null, { fresh: true });
  assert.deepEqual(receivedOptions, { fresh: true });
  assert.equal(payload.cpu, 9);
});

test('getCurrentSystemStatsPayload: reflects the last-known gpuMemorySample', async () => {
  const controller = makeController({
    probeGpuTelemetry: async () => ({ available: true, usedMb: 100, totalMb: 200, gpuType: 'cuda', source: 'nvidia-smi' }),
  });
  await controller.refreshGpuMemorySample({ force: true });
  const payload = controller.getCurrentSystemStatsPayload();
  assert.equal(payload.gpuMemory.available, true);
  assert.equal(payload.gpuMemory.usedMb, 100);
});

// ---------------------------------------------------------------------------
// ARM fallback
// ---------------------------------------------------------------------------

test('refreshGpuMemorySample: win32 ARM returns arm_fallback unavailable sample', async () => {
  let probeCalls = 0;
  const controller = makeController({
    systemArch: 'arm64',
    systemPlatform: 'win32',
    probeGpuTelemetry: async () => {
      probeCalls++;
      return { available: true, usedMb: 1, totalMb: 2 };
    },
  });
  const sample = await controller.refreshGpuMemorySample({ force: true });
  assert.equal(sample.available, false);
  assert.equal(sample.source, 'arm_fallback');
  assert.equal(probeCalls, 0, 'must not spawn a VRAM probe on ARM');
});

test('refreshGpuMemorySample: darwin ARM uses the platform telemetry probe', async () => {
  let probeCalls = 0;
  const controller = makeController({
    systemArch: 'arm64',
    systemPlatform: 'darwin',
    probeGpuTelemetry: async () => {
      probeCalls++;
      return { available: true, usedMb: 3, totalMb: 8, source: 'ioreg' };
    },
  });
  const sample = await controller.refreshGpuMemorySample({ force: true });
  assert.equal(probeCalls, 1);
  assert.equal(sample.source, 'ioreg');
  assert.notEqual(sample.source, 'arm_fallback');
});

// ---------------------------------------------------------------------------
// Throttle window (force:false)
// ---------------------------------------------------------------------------

test('refreshGpuMemorySample: force:false within the throttle window skips the probe and returns cached sample', async () => {
  let probeCalls = 0;
  const controller = makeController({
    probeGpuTelemetry: async () => {
      probeCalls++;
      return { available: true, usedMb: 10, totalMb: 20, source: 'nvidia-smi' };
    },
  });
  const first = await controller.refreshGpuMemorySample({ force: true });
  assert.equal(probeCalls, 1);
  assert.equal(first.usedMb, 10);

  // Immediately call again without force -- well inside the 15s window.
  const second = await controller.refreshGpuMemorySample({ force: false });
  assert.equal(probeCalls, 1, 'must not re-probe while inside the throttle window');
  assert.deepEqual(second, first, 'must return the cached sample unchanged');
});

test('refreshGpuMemorySample: force:false is allowed once refreshIntervalMs has elapsed', async () => {
  let probeCalls = 0;
  const controller = makeController({
    refreshIntervalMs: 5,
    probeGpuTelemetry: async () => {
      probeCalls++;
      return { available: true, usedMb: probeCalls, totalMb: 20, source: 'nvidia-smi' };
    },
  });
  await controller.refreshGpuMemorySample({ force: true });
  assert.equal(probeCalls, 1);

  await new Promise((resolve) => setTimeout(resolve, 20));

  const second = await controller.refreshGpuMemorySample({ force: false });
  assert.equal(probeCalls, 2, 'must re-probe once the throttle window has elapsed');
  assert.equal(second.usedMb, 2);
});

// ---------------------------------------------------------------------------
// force:true bypass
// ---------------------------------------------------------------------------

test('refreshGpuMemorySample: force:true bypasses the throttle window every call', async () => {
  let probeCalls = 0;
  const controller = makeController({
    probeGpuTelemetry: async () => {
      probeCalls++;
      return { available: true, usedMb: probeCalls, totalMb: 20, source: 'nvidia-smi' };
    },
  });
  await controller.refreshGpuMemorySample({ force: true });
  const second = await controller.refreshGpuMemorySample({ force: true });
  assert.equal(probeCalls, 2, 'force:true must re-probe even immediately after a prior refresh');
  assert.equal(second.usedMb, 2);
});

test('refreshGpuMemorySample: force:true advances the automatic throttle window', async () => {
  const originalNow = Date.now;
  let now = 10_000;
  let probeCalls = 0;
  Date.now = () => now;
  try {
    const controller = makeController({
      refreshIntervalMs: 100,
      probeGpuTelemetry: async () => {
        probeCalls++;
        return { available: true, usedMb: probeCalls, totalMb: 20, source: 'nvidia-smi' };
      },
    });
    await controller.refreshGpuMemorySample();
    now += 80;
    await controller.refreshGpuMemorySample({ force: true });
    now += 80;
    await controller.refreshGpuMemorySample();
    assert.equal(probeCalls, 2, 'forced refresh must delay the next automatic probe');
    now += 21;
    await controller.refreshGpuMemorySample();
    assert.equal(probeCalls, 3);
  } finally {
    Date.now = originalNow;
  }
});

test('refreshGpuMemorySample: manual refreshes are guarded for 1500ms between attempts', async () => {
  const originalNow = Date.now;
  let now = 20_000;
  let probeCalls = 0;
  Date.now = () => now;
  try {
    const controller = makeController({
      probeGpuTelemetry: async () => {
        probeCalls++;
        return { available: true, usedMb: probeCalls, totalMb: 20, source: 'nvidia-smi' };
      },
    });
    await controller.refreshGpuMemorySample({ force: true });
    now += MANUAL_REFRESH_MIN_INTERVAL_MS - 1;
    const guarded = await controller.refreshGpuMemorySample({ force: true, manual: true });
    assert.equal(probeCalls, 1);
    assert.equal(guarded.usedMb, 1);
    now += 2;
    const refreshed = await controller.refreshGpuMemorySample({ force: true, manual: true });
    assert.equal(probeCalls, 2);
    assert.equal(refreshed.usedMb, 2);
  } finally {
    Date.now = originalNow;
  }
});

// ---------------------------------------------------------------------------
// Concurrent refreshes share the in-flight promise
// ---------------------------------------------------------------------------

test('refreshGpuMemorySample: concurrent calls share a single in-flight probe', async () => {
  let probeCalls = 0;
  let resolveProbe;
  const controller = makeController({
    probeGpuTelemetry: () => {
      probeCalls++;
      return new Promise((resolve) => {
        resolveProbe = () => resolve({ available: true, usedMb: 5, totalMb: 10, source: 'nvidia-smi' });
      });
    },
  });
  const p1 = controller.refreshGpuMemorySample({ force: true });
  const p2 = controller.refreshGpuMemorySample({ force: true });
  resolveProbe();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(probeCalls, 1, 'must only spawn one probe for concurrent callers');
  assert.deepEqual(r1, r2);
});

// ---------------------------------------------------------------------------
// canUseSidecarVramPath / sidecar-vram path selection
// ---------------------------------------------------------------------------

test('refreshGpuMemorySample: uses the sidecar VRAM RPC when managed + ready', async () => {
  let sidecarCalls = 0;
  let directProbeCalls = 0;
  const backendService = {
    getBackendStatus: () => ({ phase: 'ready' }),
    getHardwareVramUsage: async () => {
      sidecarCalls++;
      return { available: true, usedMb: 999, totalMb: 1000, source: 'sidecar' };
    },
  };
  const controller = makeController({
    getBackendService: () => backendService,
    probeGpuTelemetry: async () => {
      directProbeCalls++;
      return createUnavailableGpuMemorySample({ source: 'nvidia-smi' });
    },
  });
  assert.equal(controller.canUseSidecarVramPath(), true);
  const sample = await controller.refreshGpuMemorySample({ force: true });
  assert.equal(sidecarCalls, 1);
  assert.equal(directProbeCalls, 0);
  assert.equal(sample.usedMb, 999);
});

test('refreshGpuMemorySample: sidecar null falls through to a fresh direct sample', async () => {
  let directProbeCalls = 0;
  const backendService = {
    getBackendStatus: () => ({ phase: 'ready' }),
    getHardwareVramUsage: async () => null,
  };
  const controller = makeController({
    getBackendService: () => backendService,
    probeGpuTelemetry: async () => {
      directProbeCalls++;
      return { available: true, usedMb: 444, totalMb: 1000, source: 'nvidia-smi' };
    },
  });
  const sample = await controller.refreshGpuMemorySample({ force: true });
  assert.equal(directProbeCalls, 1);
  assert.equal(sample.usedMb, 444, 'must store the fresh probe, not return the stale cache');
});

test('canUseSidecarVramPath: false when backend is missing getHardwareVramUsage', () => {
  const controller = makeController({ getBackendService: () => ({}) });
  assert.equal(controller.canUseSidecarVramPath(), false);
});

test('canUseSidecarVramPath: false when sidecar phase is not ready', () => {
  const controller = makeController({
    getBackendService: () => ({
      getHardwareVramUsage: async () => ({}),
      getBackendStatus: () => ({ phase: 'starting' }),
    }),
  });
  assert.equal(controller.canUseSidecarVramPath(), false);
});

// ---------------------------------------------------------------------------
// nvidia-smi fallback
// ---------------------------------------------------------------------------

test('refreshGpuMemorySample: falls back to nvidia-smi probe when sidecar path unavailable', async () => {
  let nvidiaSmiCalls = 0;
  const controller = makeController({
    getBackendService: () => null,
    probeGpuTelemetry: async () => {
      nvidiaSmiCalls++;
      return { available: true, usedMb: 55, totalMb: 100, source: 'nvidia-smi' };
    },
  });
  const sample = await controller.refreshGpuMemorySample({ force: true });
  assert.equal(nvidiaSmiCalls, 1);
  assert.equal(sample.usedMb, 55);
  assert.equal(sample.source, 'nvidia-smi');
});

// ---------------------------------------------------------------------------
// Error-swallow keeps the last-known sample
// ---------------------------------------------------------------------------

test('refreshGpuMemorySample: probe rejection is swallowed and keeps the last-known sample', async () => {
  let calls = 0;
  const controller = makeController({
    probeGpuTelemetry: async () => {
      calls++;
      if (calls === 1) {
        return { available: true, usedMb: 33, totalMb: 66, source: 'nvidia-smi' };
      }
      throw new Error('nvidia-smi exploded');
    },
  });
  const ok = await controller.refreshGpuMemorySample({ force: true });
  assert.equal(ok.usedMb, 33);
  const afterFailure = await controller.refreshGpuMemorySample({ force: true });
  assert.equal(afterFailure.usedMb, 33, 'must keep the last-known sample when the probe rejects');
  const payload = controller.getCurrentSystemStatsPayload();
  assert.equal(payload.gpuMemory.usedMb, 33);
  assert.equal(payload.gpuMemory.lastRefreshOk, false);
  assert.equal(payload.gpuMemory.stale, true);
});

test('refreshGpuMemorySample: a resolved unavailable probe sample keeps the last-known reading and flags the refresh failed', async () => {
  let calls = 0;
  const controller = makeController({
    probeGpuTelemetry: async () => {
      calls++;
      if (calls === 1) {
        return { available: true, usedMb: 33, totalMb: 66, source: 'nvidia-smi' };
      }
      // What probeNvidiaSmiVram actually resolves on timeout/missing binary/bad
      // output: a truthy unavailable sample, NOT a rejection.
      return createUnavailableGpuMemorySample({ source: 'nvidia-smi' });
    },
  });
  const ok = await controller.refreshGpuMemorySample({ force: true });
  assert.equal(ok.usedMb, 33);
  const afterFailure = await controller.refreshGpuMemorySample({ force: true });
  assert.equal(afterFailure.usedMb, 33, 'must not erase the last-known sample with an unavailable one');
  const payload = controller.getCurrentSystemStatsPayload();
  assert.equal(payload.gpuMemory.usedMb, 33);
  assert.equal(payload.gpuMemory.lastRefreshOk, false);
  assert.equal(payload.gpuMemory.stale, true);
});

test('refreshGpuMemorySample: unavailable-to-unavailable stays a non-stale ok refresh (no-GPU steady state)', async () => {
  const controller = makeController({
    probeGpuTelemetry: async () => createUnavailableGpuMemorySample({ source: 'nvidia-smi' }),
  });
  await controller.refreshGpuMemorySample({ force: true });
  const payload = controller.getCurrentSystemStatsPayload();
  assert.equal(payload.gpuMemory.available, false);
  assert.equal(payload.gpuMemory.lastRefreshOk, true, 'a no-GPU machine must not read as a failed refresh');
  assert.equal(payload.gpuMemory.stale, false);
});

test('refreshGpuMemorySample: sidecar RPC rejection is swallowed and keeps last-known sample', async () => {
  let sidecarCalls = 0;
  const backendService = {
    getBackendStatus: () => ({ phase: 'ready' }),
    getHardwareVramUsage: async () => {
      sidecarCalls++;
      if (sidecarCalls === 1) {
        return { available: true, usedMb: 77, totalMb: 88, source: 'sidecar' };
      }
      throw new Error('sidecar RPC failed');
    },
  };
  const controller = makeController({ getBackendService: () => backendService });
  const first = await controller.refreshGpuMemorySample({ force: true });
  assert.equal(first.usedMb, 77);
  const second = await controller.refreshGpuMemorySample({ force: true });
  assert.equal(second.usedMb, 77, 'must keep the last-known sample when the sidecar RPC rejects');
  assert.equal(sidecarCalls, 2);
});

// ---------------------------------------------------------------------------
// resetGpuMemorySample
// ---------------------------------------------------------------------------

test('resetGpuMemorySample: replaces the sample and clears the throttle window', async () => {
  let probeCalls = 0;
  const controller = makeController({
    probeGpuTelemetry: async () => {
      probeCalls++;
      return { available: true, usedMb: 10, totalMb: 20, source: 'nvidia-smi' };
    },
  });
  await controller.refreshGpuMemorySample({ force: true });
  assert.equal(probeCalls, 1);

  const resetSample = createUnavailableGpuMemorySample({ source: 'reset' });
  controller.resetGpuMemorySample(resetSample);
  const resetPayload = controller.getCurrentSystemStatsPayload().gpuMemory;
  assert.equal(resetPayload.source, 'reset');
  assert.equal(resetPayload.lastRefreshOk, true);

  // Throttle window was cleared -- a non-forced refresh right after reset must
  // still probe (gpuMemoryLastRefreshAt reset to 0).
  const afterReset = await controller.refreshGpuMemorySample({ force: false });
  assert.equal(probeCalls, 2, 'reset must clear the throttle window so the next refresh re-probes');
  assert.equal(afterReset.usedMb, 10);
});

test('resetGpuMemorySample: clears the in-flight refresh promise so the next refresh re-probes', async () => {
  let probeCalls = 0;
  const releasers = [];
  const controller = makeController({
    probeGpuTelemetry: () => new Promise((resolve) => {
      probeCalls += 1;
      releasers.push(() => resolve({ available: true, usedMb: 5, totalMb: 20, source: 'nvidia-smi' }));
    }),
  });

  // Start an in-flight probe (do not await) -- gpuMemoryRefreshPromise is now set.
  const inflight = controller.refreshGpuMemorySample({ force: true });
  assert.equal(probeCalls, 1);

  // Reset while the probe is in flight; this must null the cached in-flight promise.
  const resetSample = createUnavailableGpuMemorySample({ source: 'reset' });
  controller.resetGpuMemorySample(resetSample);
  const resetPayload = controller.getCurrentSystemStatsPayload().gpuMemory;
  assert.equal(resetPayload.source, 'reset');
  assert.equal(resetPayload.lastRefreshOk, true);

  // A subsequent forced refresh must start a NEW probe rather than returning the
  // stale shared in-flight promise (which would otherwise leave probeCalls at 1).
  const next = controller.refreshGpuMemorySample({ force: true });
  assert.equal(probeCalls, 2, 'reset must clear the in-flight promise so the next refresh re-probes');

  releasers.forEach((release) => release());
  await Promise.all([inflight, next]);
});

test('darwin never takes the sidecar VRAM path even when the sidecar is ready', async () => {
  let sidecarCalls = 0;
  let directProbeCalls = 0;
  const backendService = {
    getBackendStatus: () => ({ phase: 'ready' }),
    getHardwareVramUsage: async () => {
      sidecarCalls++;
      // What the nvidia-only sidecar probe actually returns on a Mac: a truthy
      // "unavailable" sample that would otherwise mask the ioreg probe forever.
      return createUnavailableGpuMemorySample({ source: 'nvidia-smi' });
    },
  };
  const controller = makeController({
    systemArch: 'arm64',
    systemPlatform: 'darwin',
    getBackendService: () => backendService,
    probeGpuTelemetry: async () => {
      directProbeCalls++;
      return {
        available: false,
        usedMb: 0,
        totalMb: 0,
        utilAvailable: true,
        utilPercent: 37,
        gpuType: 'metal',
        source: 'ioreg',
        sampledAt: new Date().toISOString(),
      };
    },
  });

  assert.equal(controller.canUseSidecarVramPath(), false);
  const sample = await controller.refreshGpuMemorySample({ force: true });
  assert.equal(sidecarCalls, 0);
  assert.equal(directProbeCalls, 1);
  assert.equal(sample.utilPercent, 37, 'the ioreg Metal utilization must survive');
});
