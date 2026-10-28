'use strict';

/* shell-config `performanceTelemetry` (row 59 checkpoint 6): defaults, strict
 * booleans, a newer nested schema preserved verbatim and read-only, the key kept
 * by normalizeState/cloneState/serialization, the own change reason and no
 * CONFIG_VERSION bump. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { ShellConfigService, CONFIG_VERSION } = require('../services/shell-config-service');
const { normalizeState } = require('../services/shell-config-state');
const {
  DEFAULT_PERFORMANCE_TELEMETRY, applyPerformanceTelemetryPatch, isReadOnlyPerformanceTelemetry, normalizePerformanceTelemetry,
} = require('../services/shell-config-performance');
const {
  MANAGED_CONFIG_REFRESH_REASONS, shouldBroadcastFeatureState, shouldRefreshManagedConfigForShellConfigReason,
} = require('../services/main/main-process-policy');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

test.afterEach(async () => { await cleanupTrackedResources(); });

function tempService(seed) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-perf-'));
  trackDirectory(userDataPath);
  if (seed) fs.writeFileSync(path.join(userDataPath, 'shell-config.json'), JSON.stringify(seed));
  return { userDataPath, service: new ShellConfigService({ userDataPath, env: {} }) };
}
const readDisk = (userDataPath) => JSON.parse(fs.readFileSync(path.join(userDataPath, 'shell-config.json'), 'utf8'));

test('defaults: counter off, GPU warnings on, schema version 1', () => {
  assert.deepEqual(DEFAULT_PERFORMANCE_TELEMETRY, { schemaVersion: 1, showCounter: false, gpuWarningsEnabled: true });
  for (const value of [undefined, null, 7, 'x', [], {}, { schemaVersion: 1 }]) {
    assert.deepEqual(normalizePerformanceTelemetry(value), DEFAULT_PERFORMANCE_TELEMETRY, JSON.stringify(value));
  }
  assert.equal(Object.isFrozen(normalizePerformanceTelemetry({})), false, 'normalization returns a fresh object');
  assert.deepEqual(normalizeState({}).performanceTelemetry, DEFAULT_PERFORMANCE_TELEMETRY);
});

test('booleans are strict: anything else falls back to the default of that key', () => {
  for (const bad of ['true', 1, 0, null, {}, [], 'false']) {
    assert.deepEqual(
      normalizePerformanceTelemetry({ showCounter: bad, gpuWarningsEnabled: bad }),
      { schemaVersion: 1, showCounter: false, gpuWarningsEnabled: true },
      String(bad)
    );
  }
  assert.deepEqual(normalizePerformanceTelemetry({ showCounter: true, gpuWarningsEnabled: false }),
    { schemaVersion: 1, showCounter: true, gpuWarningsEnabled: false });
  assert.deepEqual(normalizePerformanceTelemetry({ schemaVersion: 'x', showCounter: true, extra: 1 }),
    { schemaVersion: 1, showCounter: true, gpuWarningsEnabled: true }, 'unknown keys and a bad version are dropped');
  for (const bad of [0, -1, 1.5, '2', null]) assert.equal(isReadOnlyPerformanceTelemetry({ schemaVersion: bad }), false, String(bad));
});

test('a block from a newer schema is preserved verbatim, deep-copied, and never patched', () => {
  const future = { schemaVersion: 3, showCounter: 'maybe', nested: { keep: [1, 2, { deep: true }] }, gpuWarningsEnabled: 7 };
  assert.equal(isReadOnlyPerformanceTelemetry(future), true);
  const normalized = normalizePerformanceTelemetry(future);
  assert.deepEqual(normalized, future);
  assert.notEqual(normalized, future);
  assert.notEqual(normalized.nested, future.nested);
  assert.equal(applyPerformanceTelemetryPatch(future, { showCounter: true }), future, 'the patch is a no-op');
  assert.deepEqual(applyPerformanceTelemetryPatch({ schemaVersion: 1, showCounter: false, gpuWarningsEnabled: true }, { showCounter: true }),
    { schemaVersion: 1, showCounter: true, gpuWarningsEnabled: true });
  assert.deepEqual(applyPerformanceTelemetryPatch(undefined, { gpuWarningsEnabled: false }),
    { schemaVersion: 1, showCounter: false, gpuWarningsEnabled: false });
});

test('normalizeState keeps the key, cloneState detaches it, and unrelated preferences survive', () => {
  const state = normalizeState({ performanceTelemetry: { schemaVersion: 1, showCounter: true, gpuWarningsEnabled: false }, use24HourTime: true });
  assert.deepEqual(state.performanceTelemetry, { schemaVersion: 1, showCounter: true, gpuWarningsEnabled: false });
  assert.equal(state.use24HourTime, true);
  const { service } = tempService({ performanceTelemetry: { schemaVersion: 1, showCounter: true, gpuWarningsEnabled: true } });
  const first = service.getState();
  first.performanceTelemetry.showCounter = false;
  assert.equal(service.getState().performanceTelemetry.showCounter, true, 'getState returns a detached copy');
  const future = { schemaVersion: 2, anything: { goes: true } };
  const kept = normalizeState({ performanceTelemetry: future });
  assert.deepEqual(kept.performanceTelemetry, future);
  assert.equal(kept.version, CONFIG_VERSION);
});

test('updatePerformanceTelemetry persists through the atomic store under its own reason, with no version bump', () => {
  const { userDataPath, service } = tempService();
  const events = [];
  service.on('changed', (_state, meta) => events.push(meta?.reason));
  assert.deepEqual(service.getState().performanceTelemetry, DEFAULT_PERFORMANCE_TELEMETRY);
  const afterCounter = service.updatePerformanceTelemetry({ showCounter: true });
  assert.deepEqual(afterCounter, { schemaVersion: 1, showCounter: true, gpuWarningsEnabled: true });
  assert.deepEqual(events, ['performance_telemetry_updated']);
  assert.deepEqual(readDisk(userDataPath).performanceTelemetry, afterCounter);
  assert.equal(readDisk(userDataPath).version, CONFIG_VERSION);
  // Independent toggles; an unchanged write is not a write.
  service.updatePerformanceTelemetry({ gpuWarningsEnabled: false });
  service.updatePerformanceTelemetry({ gpuWarningsEnabled: false });
  assert.equal(events.length, 2);
  assert.deepEqual(readDisk(userDataPath).performanceTelemetry, { schemaVersion: 1, showCounter: true, gpuWarningsEnabled: false });
  // The setting survives a restart.
  const reloaded = new ShellConfigService({ userDataPath, env: {} });
  assert.deepEqual(reloaded.getState().performanceTelemetry, { schemaVersion: 1, showCounter: true, gpuWarningsEnabled: false });
});

test('a newer on-disk block survives a restart, an unrelated write and a patch attempt untouched', () => {
  const future = { schemaVersion: 4, showCounter: true, gpuWarningsEnabled: false, byNewerBuild: { x: [1] } };
  const { userDataPath, service } = tempService({ performanceTelemetry: future });
  assert.deepEqual(service.getState().performanceTelemetry, future);
  const events = [];
  service.on('changed', (_state, meta) => events.push(meta?.reason));
  assert.deepEqual(service.updatePerformanceTelemetry({ showCounter: false }), future);
  assert.deepEqual(events, [], 'refused patches do not write');
  service.updateHomeConfig({ focusMode: true });
  assert.deepEqual(readDisk(userDataPath).performanceTelemetry, future, 'an unrelated write keeps the newer block');
});

test('the change reason is non-feature and never refreshes the managed sidecar config', () => {
  assert.equal(shouldRefreshManagedConfigForShellConfigReason('performance_telemetry_updated'), false);
  assert.equal(shouldRefreshManagedConfigForShellConfigReason('x', ['performance_telemetry_updated']), false);
  assert.equal(shouldBroadcastFeatureState('performance_telemetry_updated'), false);
  assert.equal(MANAGED_CONFIG_REFRESH_REASONS.has('performance_telemetry_updated'), false);
  // Row 76: the primaryChat block (pause, launch permissions) is non-feature state too.
  assert.equal(shouldBroadcastFeatureState('primary_chat_updated'), false);
  assert.equal(shouldRefreshManagedConfigForShellConfigReason('primary_chat_updated'), false);
});
