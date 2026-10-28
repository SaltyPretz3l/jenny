'use strict';

// Row 62 Wave B main-process boot order, observed by running the real main.js
// in a child process against a recording Electron stub (helpers/main-boot-probe.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { createTrackedTempDir, cleanupTrackedResources } = require('./helpers/resource-cleanup');

const ROOT = path.resolve(__dirname, '..');
const PROBE = path.join(__dirname, 'helpers', 'main-boot-probe.js');

test.afterEach(cleanupTrackedResources);

function runProbe(mode) {
  const userDataDir = createTrackedTempDir(`jenny-main-boot-${mode}-`);
  const result = spawnSync(process.execPath, [PROBE, mode, userDataDir], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 90_000,
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
  });
  const lines = String(result.stdout || '').trim().split(/\r?\n/).filter((line) => line.startsWith('{"events"'));
  assert.equal(lines.length, 1, `probe printed no report (status ${result.status}): ${String(result.stderr).slice(-800)}`);
  return JSON.parse(lines[0]);
}

test('a second launch locks and exits before main.js loads its module graph', () => {
  const report = runProbe('second');
  assert.deepEqual(report.events, ['lock', 'quit']);
  assert.equal(report.exitCode, 0);
  assert.equal(report.fellThrough, undefined);
  assert.ok(report.modulesLoaded < 40, `second launch loaded ${report.modulesLoaded} modules before exiting`);
});

test('the window is created before backend construction and every IPC handler registers in the same tick', () => {
  const report = runProbe('primary');
  const { events } = report;
  assert.equal(report.syncEndReached, true);
  assert.deepEqual(events.slice(0, 2), ['lock', 'when-ready']);
  const windowAt = events.indexOf('window');
  assert.ok(windowAt > 0, 'the main window must be created before main-sync-init-end');
  const handlesAfterWindow = events.slice(windowAt).filter((event) => event === 'handle').length;
  assert.ok(handlesAfterWindow > 100, `main IPC handlers register after the window (saw ${handlesAfterWindow})`);
  assert.ok(!events.includes('handle-after-yield'), 'no IPC handler may register after the window tick yields');
  const guardAt = events.indexOf('exit-guard-attached');
  assert.ok(guardAt > events.lastIndexOf('handle'), 'the exit guard attaches once its handlers exist');
});

test('a failed unpackaged preload check shows why and exits before Electron is ready', () => {
  const report = runProbe('preload-fail');
  assert.equal(report.exitCode, 1);
  assert.ok(!report.events.includes('when-ready'));
  assert.ok(report.events.some((event) => event.startsWith('error-box:') && event.includes('probe build failed')));
});

test('main.js keeps the boot gate ahead of every heavy require', () => {
  const source = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const gate = source.indexOf('const mainBootMode = resolveMainBootMode(');
  assert.ok(gate > 0);
  const requiresBeforeGate = source.slice(0, gate).match(/require\('[^']+'\)/g);
  assert.deepEqual(requiresBeforeGate, [
    "require('electron')",
    "require('path')",
    "require('./services/main/main-boot-gate')",
    "require('./services/main/packaged-smoke')",
  ]);
});

test('main.js loads backend wiring, IPC registration and runtime shutdown only after the window exists', () => {
  const source = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const lazyModules = ['backend-service-wiring', 'ipc-handler-registration', 'runtime-shutdown'];
  for (const name of lazyModules) {
    const call = `require('./services/main/${name}')`;
    const topLevelLine = source.split(/\r?\n/).find((line) => /^(?:const|let|var)\s[^=]*=\s*require\(/.test(line) && line.includes(call));
    assert.equal(topLevelLine, undefined, `${name} must not be a top-level require of main.js`);
    assert.ok(source.includes(call), `${name} is still required lazily`);
  }
});

test('main.js enables the compile cache under userData after the boot gate, before the module graph', () => {
  const source = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const gate = source.indexOf('const mainBootMode = resolveMainBootMode(');
  const cache = source.indexOf('enableCompileCache(');
  const firstHeavyRequire = source.indexOf("require('./services/apply-single-instance')");
  assert.ok(gate > 0 && gate < cache && cache < firstHeavyRequire, 'compile cache sits between the gate and the module graph');
  assert.match(source.slice(gate, firstHeavyRequire), /typeof nodeModule\.enableCompileCache === 'function'/);
  assert.match(source.slice(gate, firstHeavyRequire), /app\.getPath\('userData'\), 'compile-cache'/);
  const bootGate = fs.readFileSync(path.join(ROOT, 'services', 'main', 'main-boot-gate.js'), 'utf8');
  assert.doesNotMatch(bootGate, /enableCompileCache/);
});
