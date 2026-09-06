const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const MAIN_PATH = path.join(ROOT, 'main.js');
const MAIN_OWNER_MODULES = [
  'services/main/backend-service-wiring.js',
  'services/main/ipc-handler-registration.js',
  'services/main/comet-overlay-controller.js',
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
  assert.ok(
    mainLineCount <= 729,
    `main.js should be under the lowered post-feature-settings-facade-extraction ceiling, got ${mainLineCount}`
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
  assert.match(mainSource, /require\('\.\/services\/main\/comet-overlay-controller'\)/);
  assert.match(mainSource, /require\('\.\/services\/main\/main-window-composition'\)/);
  assert.match(
    mainSource,
    /windowIconPath:\s*app\.isPackaged[\s\S]*?require\('path'\)\.join\(__dirname,\s*'build',[\s\S]*?'icon\.ico'[\s\S]*?'icon\.png'/,
    'development window wiring should supply Jenny icons while packaged executables use their embedded icon'
  );
  assert.match(mainSource, /require\('\.\/services\/main\/runtime-shutdown'\)/);
  assert.match(mainSource, /require\('\.\/services\/main\/startup-retention-tasks'\)/);
  assert.match(mainSource, /require\('\.\/services\/main\/gpu-memory-sample'\)/);
  assert.match(mainSource, /require\('\.\/services\/main\/main-process-policy'\)/);
  assert.match(mainSource, /require\('\.\/services\/main\/feature-settings-facade'\)/);
  assert.match(mainSource, /require\('\.\/services\/main\/data-lifecycle-startup'\)/);
  assert.match(mainSource, /workspaceProcessServices = registerIpcHandlers\(\) \|\| \{\}/);
  assert.match(mainSource, /getWorkspaceTestRunnerService: \(\) => workspaceProcessServices\.workspaceTestRunnerService \|\| null/);

  assert.doesNotMatch(mainSource, /^function createBackendService\(/m);
  assert.doesNotMatch(mainSource, /^function createRuntimeServices\(/m);
  assert.doesNotMatch(mainSource, /^function registerIpcHandlers\(/m);
  assert.doesNotMatch(mainSource, /^function createWindow\(/m);
  assert.doesNotMatch(mainSource, /^async function startLlamaServerBeforeBackend\(/m);
  assert.doesNotMatch(mainSource, /^async function stopRuntimeBeforeQuit\(/m);
  assert.doesNotMatch(mainSource, /^function getCurrentSystemStatsPayload\(/m);
  assert.doesNotMatch(mainSource, /^function canUseSidecarVramPath\(/m);
  assert.doesNotMatch(mainSource, /^async function refreshGpuMemorySample\(/m);
  assert.doesNotMatch(mainSource, /^function isCometOverlayEnabled\(/m);
  assert.doesNotMatch(mainSource, /^function closeCometOverlayIfDisabled\(/m);
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

test('main starts the deferred background refreshes it wires from the backend service', () => {
  const mainSource = readSource('main.js');
  const backendWiring = readSource('services/main/backend-service-wiring.js');

  // The refreshes shipped exported-but-uncalled: the Home weather tile and the
  // ICS calendar stayed blank for ~15 minutes after every launch, and the model
  // catalog (which has no interval at all) only refreshed when the offline
  // surface opened. Assert the whole chain, not just the export.
  assert.match(backendWiring, /startDeferredBackgroundRefreshes,/);
  assert.match(mainSource, /startDeferredBackgroundRefreshes = created\.startDeferredBackgroundRefreshes;/);

  const deferredStart = mainSource.indexOf('function startDeferredServices() {');
  assert.ok(deferredStart > -1, 'startDeferredServices must still own the deferred-startup step');
  const deferredBody = mainSource.slice(deferredStart, mainSource.indexOf('\n}', deferredStart));
  const refreshCall = deferredBody.indexOf('startDeferredBackgroundRefreshes();');
  const schedulerCall = deferredBody.indexOf('schedulerService.start();');
  assert.ok(refreshCall > -1, 'startDeferredServices must kick the deferred background refreshes');
  // Ordering is load-bearing: both sit in one try block, so a scheduler throw
  // must not be able to suppress the refreshes the way it would if it ran first.
  assert.ok(refreshCall < schedulerCall, 'refreshes must run before schedulerService.start()');
});
