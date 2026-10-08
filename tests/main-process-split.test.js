const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const MAIN_PATH = path.join(ROOT, 'main.js');
const MAIN_OWNER_MODULES = [
  'services/main/backend-service-wiring.js',
  'services/main/ipc-handler-registration.js',
  'services/main/main-window-composition.js',
  'services/main/runtime-service-composition.js',
  'services/main/runtime-shutdown.js',
  'services/main/startup-retention-tasks.js',
  'services/main/gpu-memory-sample.js',
  'services/main/main-process-policy.js',
  'services/main/feature-settings-facade.js',
  'services/main/data-lifecycle-startup.js',
];

function readSource(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('main process root delegates coupled Electron wiring to services/main owners', () => {
  const mainSource = readSource('main.js');
  const mainLineCount = mainSource.replace(/(?:\r?\n)+$/, '').split(/\r?\n/).length;

  // Ratchet only ever moves DOWN. When main.js needs new wiring and this fails,
  // extract a cohesive block into a services/main owner and lower the number to
  // the new count -- do not raise it, and do not cram statements onto one line
  // to squeeze under it (which is how the windowIconPath wiring first landed).
  // Authority: HOTSPOT_CAPS["main.js"] in scripts/checks/check_hotspot_size.py. Keep this pin
  // equal to that cap and lower both together, so one number moves at a time (2026-09-25).
  assert.ok(
    mainLineCount <= 729,
    `main.js should be under the lowered post-window-icon-resolver-extraction ceiling, got ${mainLineCount}`
  );

  for (const modulePath of MAIN_OWNER_MODULES) {
    assert.ok(
      fs.existsSync(path.join(ROOT, modulePath)),
      `expected ${modulePath} to own part of the main-process wiring`
    );
  }

  assert.match(mainSource, /require\('\.\/services\/main\/backend-service-wiring'\)/);
  assert.match(mainSource, /require\('\.\/services\/main\/runtime-service-composition'\)/);
  assert.match(mainSource, /require\('\.\/services\/main\/ipc-handler-registration'\)/);
  assert.match(mainSource, /require\('\.\/services\/main\/main-window-composition'\)/);
  assert.match(
    mainSource,
    /windowIconPath:\s*resolveWindowIconPath\(\{[\s\S]*?isPackaged:\s*app\.isPackaged[\s\S]*?resourcesPath:\s*process\.resourcesPath/,
    'window icon resolution is delegated to main-window-composition (dev build artwork, packaged Linux resources/icon.png, embedded icon elsewhere)'
  );
  assert.match(mainSource, /require\('\.\/services\/main\/runtime-shutdown'\)/);
  assert.match(mainSource, /require\('\.\/services\/main\/startup-retention-tasks'\)/);
  assert.match(mainSource, /require\('\.\/services\/main\/gpu-memory-sample'\)/);
  assert.match(mainSource, /require\('\.\/services\/main\/main-process-policy'\)/);
  assert.match(mainSource, /require\('\.\/services\/main\/feature-settings-facade'\)/);
  assert.match(mainSource, /require\('\.\/services\/main\/data-lifecycle-startup'\)/);
  assert.match(mainSource, /workspaceProcessServices = registerIpcHandlers\(\) \|\| \{\}/);
  assert.match(mainSource, /getWorkspaceTestRunnerService: \(\) => workspaceProcessServices\.workspaceTestRunnerService \|\| null/);
  assert.match(mainSource, /stopRuntime: \(context\) => stopRuntimeBeforeQuit\(context\)/);
  assert.match(mainSource, /onEmergencyShutdown: runEmergencyRuntimeShutdownSync/);
  assert.match(mainSource, /getRuntimeShutdownController\(\)\.stopRuntimeBeforeQuit\(context\)/);

  assert.doesNotMatch(mainSource, /^function createBackendService\(/m);
  assert.doesNotMatch(mainSource, /^function createRuntimeServices\(/m);
  assert.doesNotMatch(mainSource, /^function registerIpcHandlers\(/m);
  assert.doesNotMatch(mainSource, /^function createWindow\(/m);
  assert.doesNotMatch(mainSource, /^async function startLlamaServerBeforeBackend\(/m);
  assert.doesNotMatch(mainSource, /^async function stopRuntimeBeforeQuit\(/m);
  assert.doesNotMatch(mainSource, /^function getCurrentSystemStatsPayload\(/m);
  assert.doesNotMatch(mainSource, /^function canUseSidecarVramPath\(/m);
  assert.doesNotMatch(mainSource, /^async function refreshGpuMemorySample\(/m);
  // The comet overlay companion was removed outright (sweep S9, 2026-09-25).
  assert.doesNotMatch(mainSource, /comet|overlay-window|overlayRef/i);
  assert.doesNotMatch(mainSource, /^function buildFeatureStatePayload\(/m);
  assert.doesNotMatch(mainSource, /^async function applyFeatureSettingsPatch\(/m);

  const backendWiring = readSource('services/main/backend-service-wiring.js');
  const runtimeComposition = readSource('services/main/runtime-service-composition.js');
  const ipcRegistration = readSource('services/main/ipc-handler-registration.js');
  const windowComposition = readSource('services/main/main-window-composition.js');
  const shutdownRuntime = readSource('services/main/runtime-shutdown.js');
  const gpuMemorySample = readSource('services/main/gpu-memory-sample.js');
  const featureSettingsFacade = readSource('services/main/feature-settings-facade.js');

  assert.match(backendWiring, /function createBackendServiceWithDeps\(/);
  assert.match(runtimeComposition, /function createRuntimeServicesWithDeps\(/);
  assert.match(ipcRegistration, /function registerMainIpcHandlers\(/);
  assert.match(windowComposition, /function createMainWindowWithDeps\(/);
  assert.match(shutdownRuntime, /function createRuntimeShutdownController\(/);
  assert.match(shutdownRuntime, /\['workspaceTestRunner', getWorkspaceTestRunnerService\(\)\]/);
  assert.match(gpuMemorySample, /function createGpuMemorySampleController\(/);
  assert.match(featureSettingsFacade, /function createFeatureSettingsFacade\(/);
});

test('main startup marks preserve their honest boundaries and captured sync timestamp', () => {
  const mainSource = readSource('main.js');
  assert.match(
    mainSource,
    /app\.whenReady\(\)\.then\(async \(\) => \{\s*emitStartupAuditMark\('electron-ready', \{ source: 'main' \}\);/,
    'electron-ready must be the first statement in the whenReady handler'
  );

  const syncTimestamp = mainSource.indexOf('const mainSyncInitStartedAt = Date.now();');
  const syncMark = mainSource.indexOf("emitStartupAuditMark('main-sync-init-start'");
  const runtimeComposition = mainSource.indexOf('createRuntimeServices();');
  assert.ok(syncTimestamp < syncMark && syncMark < runtimeComposition);
  assert.match(
    mainSource.slice(syncMark, runtimeComposition),
    /ts_ms:\s*mainSyncInitStartedAt/,
    'moving the mark must preserve its pre-captured timestamp'
  );

  const appReady = mainSource.indexOf("emitStartupAuditMark('app-ready', { source: 'main' });");
  const backendComposition = mainSource.indexOf('createBackendService();');
  assert.ok(runtimeComposition < appReady && appReady < backendComposition);
});

test('main defers electron-updater and overlaps managed llama-server startup with backend start', () => {
  const mainSource = readSource('main.js');
  assert.doesNotMatch(mainSource, /require\('electron-updater'\)/);
  assert.doesNotMatch(mainSource, /electronAutoUpdater/);

  const llamaStart = mainSource.indexOf('const localServerReadyPromise = startLlamaServerBeforeBackend();');
  const backendMark = mainSource.indexOf("emitStartupAuditMark('backend-start', { source: 'main' });");
  const backendStart = mainSource.indexOf('await backendService.start({');
  assert.ok(llamaStart < backendMark && backendMark < backendStart);
  assert.match(
    mainSource.slice(backendStart, mainSource.indexOf('});', backendStart) + 3),
    /localServerReadyPromise/
  );
});

function assertDeferredStartupOrder({ omitRefresh = false, schedulerThrows = false } = {}) {
  const calls = [], logs = [];
  const noop = () => {};
  const owner = new Proxy({}, { get: () => noop });
  // Evaluate the entire main module; no Electron app, timers or services start.
  const context = vm.createContext({
    __dirname: ROOT, module: { exports: {} }, process: { env: {}, arch: 'x64' },
    require(name) {
      if (name === './services/main/gpu-memory-sample') return { createGpuMemorySampleController: () => ({}) };
      if (name === './services/main/startup-audit') return { createStartupAudit: () => ({}) };
      if (name === './services/main/setup-readiness') return { createSetupReadinessProbe: () => ({}) };
      if (name === './services/main/feature-settings-facade') return { createFeatureSettingsFacade: () => ({}) };
      return owner;
    },
    recordRefresh: () => calls.push('refresh'),
    recordingScheduler: { start() { calls.push('scheduler'); if (schedulerThrows) throw new Error('scheduler failed'); } },
    recordLog: (...args) => logs.push(args),
  });
  vm.runInContext(readSource('main.js'), context, { filename: MAIN_PATH });
  vm.runInContext('startDeferredBackgroundRefreshes = recordRefresh; schedulerService = recordingScheduler; log = recordLog;', context);
  const start = omitRefresh
    ? () => context.recordingScheduler.start()
    : () => vm.runInContext('startDeferredServices();', context);
  start();
  assert.deepEqual(calls, ['refresh', 'scheduler'], 'refreshes must run before the scheduler');
  assert.equal(logs[0][0], schedulerThrows ? 'WARN' : 'INFO');
  assert.equal(logs[0][1], schedulerThrows ? 'app.deferred_services_failed' : 'app.deferred_services_started');
  start();
  assert.deepEqual(calls, ['refresh', 'scheduler'], 'deferred services start only once');
}

test('main starts deferred background refreshes before the scheduler, even when it throws', () => {
  assertDeferredStartupOrder();
  assertDeferredStartupOrder({ schedulerThrows: true });
  assert.throws(() => assertDeferredStartupOrder({ omitRefresh: true }), {
    code: 'ERR_ASSERTION', message: /refreshes must run before the scheduler/,
  });
});

// SC-2: a getter that registerMainIpcHandlers defaults to `() => null` turns its
// handler into a silent no-op when main.js forgets to pass it (getSystemStats
// left system.setStatsWatch answering {watched:false} forever).
test('main.js passes every null-defaulting getter that registerMainIpcHandlers reads', () => {
  const registration = readSource('services/main/ipc-handler-registration.js');
  const start = registration.indexOf('function registerMainIpcHandlers(');
  const signature = registration.slice(start, registration.indexOf('}) {', start));
  const nullDefaults = Array.from(signature.matchAll(/^\s*(\w+)\s*=\s*\(\)\s*=>\s*null,/gm), (match) => match[1]);
  assert.ok(nullDefaults.includes('getSystemStats'), 'the scan must see the getSystemStats default');

  const mainSource = readSource('main.js');
  const callStart = mainSource.indexOf('registerMainIpcHandlers({');
  const call = mainSource.slice(callStart, mainSource.indexOf('\n});', callStart));
  const passed = new Set(Array.from(call.matchAll(/^\s*(\w+)\s*[,:]/gm), (match) => match[1]));
  const missing = nullDefaults.filter((name) => !passed.has(name));
  assert.deepEqual(missing, []);
});
