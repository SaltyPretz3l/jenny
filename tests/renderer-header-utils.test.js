const test = require('node:test');
const assert = require('node:assert/strict');

const { createHeaderController } = require('../renderer/shell/renderer-header-utils');

function createInstrumentedElement() {
  let value = '';
  let writeCount = 0;
  return {
    get innerHTML() { return value; },
    set innerHTML(next) {
      value = next;
      writeCount += 1;
    },
    getWriteCount() { return writeCount; },
  };
}

function createInteractiveElement() {
  let value = '';
  const attributes = new Map();
  const listeners = new Map();
  const classes = new Set();
  return {
    get innerHTML() { return value; },
    set innerHTML(next) { value = next; },
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
    setAttribute(name, next) { attributes.set(name, String(next)); },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
    removeAttribute(name) { attributes.delete(name); },
    // Real EventTarget semantics: multiple listeners per type accumulate, so a
    // double-attach regression is visible to listenerCount (a single-slot Map
    // fake proved blind to exactly that in mutation testing).
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    removeEventListener(type, listener) {
      const list = listeners.get(type) || [];
      const index = list.indexOf(listener);
      if (index !== -1) list.splice(index, 1);
      if (list.length === 0) listeners.delete(type);
    },
    dispatch(type, event = {}) {
      for (const listener of [...(listeners.get(type) || [])]) listener(event);
    },
    listenerCount(type) { return (listeners.get(type) || []).length; },
  };
}

function flushAsync() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createHeaderHarness(systemStats, {
  instrumented = false,
  interactive = false,
  telemetryFlagOn = false,
  refreshSystemStats,
  refreshTimeoutMs,
} = {}) {
  const state = {
    ui: { activeView: 'chat' },
    auth: { authenticated: true },
    backend: { phase: 'ready' },
    features: { featureFlags: { titlebar_gpu_telemetry: telemetryFlagOn } },
    currentSessionId: 'session-1',
    systemStats,
  };
  const dom = {
    metricList: interactive
      ? createInteractiveElement()
      : (instrumented ? createInstrumentedElement() : { innerHTML: '' }),
    sessionActionButton: null,
    newChatButton: null,
  };
  const callbacks = refreshSystemStats
    ? { refreshSystemStats, ...(refreshTimeoutMs !== undefined ? { refreshTimeoutMs } : {}) }
    : undefined;
  const controller = createHeaderController({ state, dom, callbacks });
  controller.renderHeader();
  return { dom, state, controller };
}

test('header shows VRAM metric on non-ARM when GPU sample is available', () => {
  const { dom } = createHeaderHarness({
    cpuPercent: 22.1,
    ramPercent: 41.8,
    battery: 'AC',
    arch: 'x64',
    gpuMemory: {
      available: true,
      usedMb: 3072,
      totalMb: 8192,
      gpuType: 'cuda',
      source: 'nvidia-smi',
      sampledAt: '2026-01-01T00:00:00+00:00',
    },
  });

  assert.match(dom.metricList.innerHTML, /CPU: 22\.1%/);
  assert.match(dom.metricList.innerHTML, /VRAM: 3\.0\/8\.0 GB/);
  assert.doesNotMatch(dom.metricList.innerHTML, />RAM:/);
  assert.doesNotMatch(dom.metricList.innerHTML, /BAT:/);
});

test('header keeps RAM metric on ARM even when GPU sample exists', () => {
  const { dom } = createHeaderHarness({
    cpuPercent: 5.0,
    ramPercent: 33.3,
    battery: 'AC',
    arch: 'arm64',
    gpuMemory: {
      available: true,
      usedMb: 3072,
      totalMb: 8192,
      gpuType: 'cuda',
      source: 'nvidia-smi',
      sampledAt: '2026-01-01T00:00:00+00:00',
    },
  });

  assert.match(dom.metricList.innerHTML, /RAM: 33\.3%/);
  assert.doesNotMatch(dom.metricList.innerHTML, /VRAM:/);
  assert.doesNotMatch(dom.metricList.innerHTML, /BAT:/);
});

test('header falls back to RAM metric on non-ARM when GPU sample is unavailable', () => {
  const { dom } = createHeaderHarness({
    cpuPercent: 18.4,
    ramPercent: 52.9,
    battery: 'Battery',
    arch: 'x64',
    gpuMemory: {
      available: false,
      usedMb: 0,
      totalMb: 0,
      gpuType: '',
      source: 'unavailable',
      sampledAt: '2026-01-01T00:00:00+00:00',
    },
  });

  assert.match(dom.metricList.innerHTML, /RAM: 52\.9%/);
  assert.doesNotMatch(dom.metricList.innerHTML, /VRAM:/);
  assert.doesNotMatch(dom.metricList.innerHTML, /BAT:/);
});

test('renderHeader skips innerHTML writes when state is unchanged across calls', () => {
  const stats = {
    cpuPercent: 22.1,
    ramPercent: 41.8,
    battery: 'AC',
    arch: 'x64',
    gpuMemory: {
      available: true,
      usedMb: 3072,
      totalMb: 8192,
      gpuType: 'cuda',
      source: 'nvidia-smi',
      sampledAt: '2026-01-01T00:00:00+00:00',
    },
  };
  const { dom, controller } = createHeaderHarness(stats, { instrumented: true });

  assert.equal(dom.metricList.getWriteCount(), 1);

  controller.renderHeader();
  controller.renderHeader();

  assert.equal(dom.metricList.getWriteCount(), 1, 'metric list must not be rebuilt when metrics are unchanged');
});

test('renderHeader rewrites metric list when CPU/RAM values change', () => {
  const baseStats = {
    cpuPercent: 10.0,
    ramPercent: 40.0,
    battery: 'AC',
    arch: 'x64',
    gpuMemory: { available: false, usedMb: 0, totalMb: 0 },
  };
  const { dom, state, controller } = createHeaderHarness(baseStats, { instrumented: true });

  assert.equal(dom.metricList.getWriteCount(), 1);

  state.systemStats = { ...baseStats, cpuPercent: 37.5 };
  controller.renderHeader();

  assert.equal(dom.metricList.getWriteCount(), 2);
  assert.match(dom.metricList.innerHTML, /CPU: 37\.5%/);
});

test('header renders rounded GPU utilization when telemetry is enabled and available', () => {
  const { dom } = createHeaderHarness({
    cpuPercent: 12.3,
    ramPercent: 45.6,
    arch: 'x64',
    platform: 'win32',
    gpuMemory: { available: false, utilAvailable: true, utilPercent: 54.6 },
  }, { telemetryFlagOn: true });

  assert.match(dom.metricList.innerHTML, /GPU: 55%/);
  assert.match(dom.metricList.innerHTML, /RAM: 45\.6%/);
});

test('header hides GPU utilization when the sample is unavailable', () => {
  const { dom } = createHeaderHarness({
    cpuPercent: 12.3,
    ramPercent: 45.6,
    arch: 'x64',
    platform: 'win32',
    gpuMemory: { available: false, utilAvailable: false, utilPercent: 54.6 },
  }, { telemetryFlagOn: true });

  assert.doesNotMatch(dom.metricList.innerHTML, /GPU:/);
});

test('darwin ARM renders GPU utilization with the unified-memory RAM fallback', () => {
  const { dom } = createHeaderHarness({
    cpuPercent: 5,
    ramPercent: 33.3,
    arch: 'arm64',
    platform: 'darwin',
    gpuMemory: { available: false, utilAvailable: true, utilPercent: 41.2 },
  }, { telemetryFlagOn: true });

  assert.match(dom.metricList.innerHTML, /GPU: 41%/);
  assert.match(dom.metricList.innerHTML, /RAM: 33\.3%/);
  assert.doesNotMatch(dom.metricList.innerHTML, /VRAM:/);
});

test('Windows ARM blocks GPU-derived metrics and keeps the RAM fallback', () => {
  const { dom } = createHeaderHarness({
    cpuPercent: 5,
    ramPercent: 33.3,
    arch: 'arm64',
    platform: 'win32',
    gpuMemory: {
      available: true,
      usedMb: 3072,
      totalMb: 8192,
      utilAvailable: true,
      utilPercent: 41.2,
    },
  }, { telemetryFlagOn: true });

  assert.match(dom.metricList.innerHTML, /RAM: 33\.3%/);
  assert.doesNotMatch(dom.metricList.innerHTML, /GPU:/);
  assert.doesNotMatch(dom.metricList.innerHTML, /VRAM:/);
});

test('stale GPU and VRAM spans carry a bucketed age while CPU stays unmarked', () => {
  const { dom } = createHeaderHarness({
    cpuPercent: 22.1,
    ramPercent: 41.8,
    arch: 'x64',
    platform: 'win32',
    gpuMemory: {
      available: true,
      usedMb: 3072,
      totalMb: 8192,
      utilAvailable: true,
      utilPercent: 50,
      stale: true,
      ageMs: 14900,
    },
  }, { telemetryFlagOn: true });

  assert.match(dom.metricList.innerHTML, /<span class="metric-item">CPU: 22\.1%<\/span>/);
  assert.match(dom.metricList.innerHTML, /<span class="metric-item" data-stale="true" title="GPU sample is 10s old">GPU: 50%<\/span>/);
  assert.match(dom.metricList.innerHTML, /<span class="metric-item" data-stale="true" title="GPU sample is 10s old">VRAM: 3\.0\/8\.0 GB<\/span>/);
});

test('fresh GPU metrics and RAM fallbacks never receive stale attributes', () => {
  const fresh = createHeaderHarness({
    cpuPercent: 10,
    ramPercent: 20,
    arch: 'x64',
    platform: 'win32',
    gpuMemory: { available: false, utilAvailable: true, utilPercent: 30, stale: false, ageMs: 60000 },
  }, { telemetryFlagOn: true });
  const staleWithRam = createHeaderHarness({
    cpuPercent: 10,
    ramPercent: 20,
    arch: 'arm64',
    platform: 'darwin',
    gpuMemory: { available: false, utilAvailable: true, utilPercent: 30, stale: true, ageMs: 60000 },
  }, { telemetryFlagOn: true });

  assert.doesNotMatch(fresh.dom.metricList.innerHTML, /data-stale|GPU sample is/);
  assert.match(staleWithRam.dom.metricList.innerHTML, /<span class="metric-item">CPU: 10\.0%<\/span>/);
  assert.match(staleWithRam.dom.metricList.innerHTML, /<span class="metric-item">RAM: 20\.0%<\/span>/);
  assert.doesNotMatch(staleWithRam.dom.metricList.innerHTML, /data-stale="true"[^>]*>RAM:/);
});

test('click refresh updates system stats and rerenders the metric strip', async () => {
  const payload = {
    cpuPercent: 88.8,
    ramPercent: 44.4,
    arch: 'x64',
    platform: 'win32',
    gpuMemory: { available: false, utilAvailable: true, utilPercent: 70 },
  };
  let calls = 0;
  const { dom, state } = createHeaderHarness({
    cpuPercent: 1,
    ramPercent: 2,
    arch: 'x64',
    platform: 'win32',
    gpuMemory: { available: false, utilAvailable: false },
  }, {
    interactive: true,
    telemetryFlagOn: true,
    refreshSystemStats: async () => { calls += 1; return payload; },
  });

  dom.metricList.dispatch('click');
  await flushAsync();

  assert.equal(calls, 1);
  assert.equal(state.systemStats, payload);
  assert.match(dom.metricList.innerHTML, /CPU: 88\.8%/);
  assert.match(dom.metricList.innerHTML, /GPU: 70%/);
});

test('Enter and Space activate refresh with keyboard parity', async () => {
  let calls = 0;
  const { dom } = createHeaderHarness({
    cpuPercent: 1,
    ramPercent: 2,
    arch: 'x64',
    platform: 'win32',
    gpuMemory: { available: false, utilAvailable: false },
  }, {
    interactive: true,
    telemetryFlagOn: true,
    refreshSystemStats: async () => { calls += 1; return null; },
  });
  let enterPrevented = false;
  let spacePrevented = false;

  dom.metricList.dispatch('keydown', { key: 'Enter', preventDefault() { enterPrevented = true; } });
  await flushAsync();
  dom.metricList.dispatch('keydown', { key: ' ', preventDefault() { spacePrevented = true; } });
  await flushAsync();

  assert.equal(calls, 2);
  assert.equal(enterPrevented, false);
  assert.equal(spacePrevented, true);
});

test('refresh is single-flight across repeated activation', async () => {
  let calls = 0;
  let resolveRefresh;
  const refreshPromise = new Promise((resolve) => { resolveRefresh = resolve; });
  const { dom } = createHeaderHarness({
    cpuPercent: 1,
    ramPercent: 2,
    arch: 'x64',
    platform: 'win32',
    gpuMemory: { available: false, utilAvailable: false },
  }, {
    interactive: true,
    telemetryFlagOn: true,
    refreshSystemStats: () => { calls += 1; return refreshPromise; },
  });

  dom.metricList.dispatch('click');
  dom.metricList.dispatch('click');

  assert.equal(calls, 1);
  assert.equal(dom.metricList.classList.contains('is-refreshing'), true);
  resolveRefresh(null);
  await flushAsync();
  assert.equal(dom.metricList.classList.contains('is-refreshing'), false);
});

test('a rejected refresh is contained and clears the refreshing state', async () => {
  const { dom } = createHeaderHarness({
    cpuPercent: 1,
    ramPercent: 2,
    arch: 'x64',
    platform: 'win32',
    gpuMemory: { available: false, utilAvailable: false },
  }, {
    interactive: true,
    telemetryFlagOn: true,
    refreshSystemStats: async () => { throw new Error('probe unavailable'); },
  });

  assert.doesNotThrow(() => dom.metricList.dispatch('click'));
  await flushAsync();
  assert.equal(dom.metricList.classList.contains('is-refreshing'), false);
});

test('flag-off leaves interaction absent and renders the legacy markup byte-identically', () => {
  const { dom } = createHeaderHarness({
    cpuPercent: 22.1,
    ramPercent: 41.8,
    arch: 'x64',
    platform: 'win32',
    gpuMemory: {
      available: true,
      usedMb: 3072,
      totalMb: 8192,
      utilAvailable: true,
      utilPercent: 50,
      stale: true,
      ageMs: 60000,
    },
  }, { interactive: true, telemetryFlagOn: false });
  const legacyMarkup = `
            <span class="metric-item">CPU: 22.1%</span>
          <span class="stat-divider" aria-hidden="true"></span>
            <span class="metric-item">VRAM: 3.0/8.0 GB</span>
          `;

  assert.equal(dom.metricList.innerHTML, legacyMarkup);
  assert.equal(dom.metricList.getAttribute('role'), null);
  assert.equal(dom.metricList.getAttribute('tabindex'), null);
  assert.equal(dom.metricList.listenerCount('click'), 0);
  assert.equal(dom.metricList.listenerCount('keydown'), 0);
});

test('dispose removes metric refresh listeners and injected attributes', () => {
  const { dom, controller } = createHeaderHarness({
    cpuPercent: 1,
    ramPercent: 2,
    arch: 'x64',
    platform: 'win32',
    gpuMemory: { available: false, utilAvailable: false },
  }, { interactive: true, telemetryFlagOn: true });

  assert.equal(dom.metricList.getAttribute('role'), 'button');
  assert.equal(dom.metricList.getAttribute('tabindex'), '0');
  // Deliberately no aria-label: it would override name-from-content and hide
  // the metric values from screen readers.
  assert.equal(dom.metricList.getAttribute('aria-label'), null);
  assert.equal(dom.metricList.getAttribute('title'), 'Click to refresh system stats');
  assert.equal(dom.metricList.listenerCount('click'), 1);
  assert.equal(dom.metricList.listenerCount('keydown'), 1);

  controller.dispose();

  assert.equal(dom.metricList.getAttribute('role'), null);
  assert.equal(dom.metricList.getAttribute('tabindex'), null);
  assert.equal(dom.metricList.getAttribute('aria-label'), null);
  assert.equal(dom.metricList.getAttribute('title'), null);
  assert.equal(dom.metricList.listenerCount('click'), 0);
  assert.equal(dom.metricList.listenerCount('keydown'), 0);
});

test('flag hydrating after construction attaches interaction and GPU metric on next render', () => {
  const { dom, state, controller } = createHeaderHarness({
    cpuPercent: 10,
    ramPercent: 20,
    arch: 'x64',
    platform: 'win32',
    gpuMemory: {
      available: true,
      usedMb: 1024,
      totalMb: 8192,
      utilAvailable: true,
      utilPercent: 77,
      stale: false,
      ageMs: 0,
    },
  }, { interactive: true, telemetryFlagOn: false });

  assert.equal(dom.metricList.getAttribute('role'), null);
  assert.equal(dom.metricList.listenerCount('click'), 0);
  assert.doesNotMatch(dom.metricList.innerHTML, /GPU:/);

  state.features.featureFlags.titlebar_gpu_telemetry = true;
  controller.renderHeader();

  assert.equal(dom.metricList.getAttribute('role'), 'button');
  assert.equal(dom.metricList.listenerCount('click'), 1);
  assert.match(dom.metricList.innerHTML, /GPU: 77%/);

  state.features.featureFlags.titlebar_gpu_telemetry = false;
  controller.renderHeader();

  assert.equal(dom.metricList.getAttribute('role'), null);
  assert.equal(dom.metricList.listenerCount('click'), 0);
  assert.doesNotMatch(dom.metricList.innerHTML, /GPU:/);
});

test('repeated renders never accumulate duplicate refresh listeners', () => {
  const { dom, controller } = createHeaderHarness({
    cpuPercent: 1,
    ramPercent: 2,
    arch: 'x64',
    platform: 'win32',
    gpuMemory: { available: false, utilAvailable: false },
  }, { interactive: true, telemetryFlagOn: true });

  for (let i = 0; i < 25; i += 1) controller.renderHeader();

  assert.equal(dom.metricList.listenerCount('click'), 1);
  assert.equal(dom.metricList.listenerCount('keydown'), 1);
});

test('a hung refresh invoke times out and re-arms the affordance', async () => {
  let calls = 0;
  const { dom, controller } = createHeaderHarness({
    cpuPercent: 1,
    ramPercent: 2,
    arch: 'x64',
    platform: 'win32',
    gpuMemory: { available: false, utilAvailable: false },
  }, {
    interactive: true,
    telemetryFlagOn: true,
    refreshSystemStats: () => {
      calls += 1;
      return new Promise(() => {});
    },
    refreshTimeoutMs: 5,
  });

  dom.metricList.dispatch('click');
  assert.equal(dom.metricList.classList.contains('is-refreshing'), true);

  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(dom.metricList.classList.contains('is-refreshing'), false);

  dom.metricList.dispatch('click');
  assert.equal(calls, 2);

  controller.dispose();
});

test('stale-by-failure with a fresh timestamp avoids the contradictory 0s-old copy', () => {
  const { dom } = createHeaderHarness({
    cpuPercent: 1,
    ramPercent: 2,
    arch: 'x64',
    platform: 'win32',
    gpuMemory: {
      available: true,
      usedMb: 1024,
      totalMb: 8192,
      utilAvailable: true,
      utilPercent: 40,
      stale: true,
      ageMs: 2000,
    },
  }, { interactive: true, telemetryFlagOn: true });

  assert.match(dom.metricList.innerHTML, /data-stale="true" title="GPU sample may be stale"/);
  assert.doesNotMatch(dom.metricList.innerHTML, /0s old/);
});
