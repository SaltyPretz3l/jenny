const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { BackendService } = require('../services/backend/backend-service');
const {
  handleSidecarStatus,
  handleSidecarLog,
  markManagedSidecarInitialized,
} = require('../services/backend/local-engine-lifecycle');
const { buildObservedBackendStatus } = require('../services/backend/local-engine-status');
const { createFakeSafeStorage } = require('./helpers/fake-safe-storage');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeService(overrides) {
  const emits = [];
  const logs = [];
  const base = {
    emits,
    logs,
    emit(ev, payload) { emits.push([ev, payload]); },
    _emitServiceLog(lvl, ev, data) { logs.push([lvl, ev, data]); },
    _managedReadyOnce: false,
    _disposed: false,
    _stopping: false,
    _autoReconnectPending: false,
    _autoReconnectAttempted: false,
    sidecarManager: {
      isStopping: false,
      getStatus() { return { phase: 'ready' }; },
    },
  };
  // Allow nested sidecarManager overrides via a "sidecarManagerOverride" key
  if (overrides && overrides.sidecarManagerOverride) {
    Object.assign(base.sidecarManager, overrides.sidecarManagerOverride);
    delete overrides.sidecarManagerOverride;
  }
  return Object.assign(base, overrides);
}

// ---------------------------------------------------------------------------
// handleSidecarStatus — phase "ready" + managed: startup log
// ---------------------------------------------------------------------------

test('handleSidecarStatus emits INFO log for managed_sidecar_spawn_ready when phase is ready', () => {
  const svc = makeService();
  handleSidecarStatus(svc, { phase: 'ready', baseUrl: 'http://localhost:8080', pid: 42 });

  const found = svc.logs.find(([lvl, ev]) => lvl === 'INFO' && ev === 'backend.managed_sidecar_spawn_ready');
  assert.ok(found, 'expected backend.managed_sidecar_spawn_ready log entry');
  assert.equal(found[2].baseUrl, 'http://localhost:8080');
  assert.equal(found[2].pid, 42);
});

// ---------------------------------------------------------------------------
// handleSidecarStatus — ALWAYS emits backend-status
// ---------------------------------------------------------------------------

test('handleSidecarStatus always emits backend-status for any status object', () => {
  const svc = makeService();
  handleSidecarStatus(svc, { phase: 'starting' });

  const found = svc.emits.find(([ev]) => ev === 'backend-status');
  assert.ok(found, 'expected backend-status emit');
  assert.equal(found[1].phase, 'starting');
});

test('handleSidecarStatus emits backend-status even for ready phase', () => {
  const svc = makeService();
  handleSidecarStatus(svc, { phase: 'ready' });

  const found = svc.emits.find(([ev]) => ev === 'backend-status');
  assert.ok(found, 'expected backend-status emit for ready phase');
  assert.equal(found[1].phase, 'sidecar_spawned');
  assert.equal(found[1].sidecar_state, 'sidecar_spawned');
  assert.equal(found[1].model_state, 'unloaded');
});

test('initialized sidecar without a startup model is ready for lazy model loading', () => {
  const svc = makeService({
    _managedReadyOnce: true,
    _modelLifecycle: { state: 'unloaded', requested_model: '' },
  });

  const status = buildObservedBackendStatus(svc);

  assert.equal(status.phase, 'ready');
  assert.equal(status.sidecar_state, 'sidecar_spawned');
  assert.equal(status.model_state, 'unloaded');
});

test('observed status does not leak the sidecar spawn detail into lifecycle-driven phases', () => {
  const spawnReadyStatus = {
    getStatus() {
      return { phase: 'ready', detail: 'Managed sidecar process is ready.' };
    },
  };

  // Loading phases surface the model lifecycle status so the banner shows
  // real progress instead of the stale spawn detail. A 'loading' lifecycle
  // only exists while an initialize flight is live (progress writes happen
  // inside it) — without the flight marker, presentModelLifecycle heals the
  // state as a stale latch (GUI finding 2026-07-20).
  const loading = makeService({
    _modelLifecycle: { state: 'loading', requested_model: 'ornith:9b', status: 'Loading model' },
    _managedInitializeFlight: { generation: 1 },
    sidecarManagerOverride: spawnReadyStatus,
  });
  const loadingStatus = buildObservedBackendStatus(loading);
  assert.equal(loadingStatus.phase, 'model_loading');
  assert.equal(loadingStatus.detail, 'Loading model');

  // model_unavailable blanks the detail so the renderer's phase copy
  // ("send a message to retry") wins instead of "process is ready".
  const unavailable = makeService({
    _modelLifecycle: { state: 'unavailable', requested_model: 'ornith:9b', status: 'Model unavailable' },
    sidecarManagerOverride: spawnReadyStatus,
  });
  const unavailableStatus = buildObservedBackendStatus(unavailable);
  assert.equal(unavailableStatus.phase, 'model_unavailable');
  assert.equal(unavailableStatus.detail, '');

  // The lazy-ready path keeps the raw sidecar detail (banner is hidden).
  const ready = makeService({
    _managedReadyOnce: true,
    _modelLifecycle: { state: 'unloaded', requested_model: '' },
    sidecarManagerOverride: spawnReadyStatus,
  });
  const readyStatus = buildObservedBackendStatus(ready);
  assert.equal(readyStatus.phase, 'ready');
  assert.equal(readyStatus.detail, 'Managed sidecar process is ready.');
});

test('observed status preserves a loaded runtime without masking an active initialization', () => {
  const loaded = makeService({ currentStatus: { model_loaded: true, model: 'ready:1b', engine: 'ollama' } });
  assert.equal(buildObservedBackendStatus(loaded).phase, 'ready');

  const switching = makeService({
    currentStatus: { model_loaded: true, model: 'old:1b', engine: 'ollama' },
    _managedInitializeFlight: { requestedModel: 'new:2b' },
    _modelLifecycle: { state: 'unloaded', requested_model: 'new:2b' },
  });
  const switchingStatus = buildObservedBackendStatus(switching);
  assert.equal(switchingStatus.phase, 'sidecar_spawned');
  assert.equal(switchingStatus.model_state, 'unloaded');
});

// ---------------------------------------------------------------------------
// handleSidecarStatus — crash branch: sidecar-crash + _attemptAutoReconnect call
// ---------------------------------------------------------------------------

test('handleSidecarStatus crash branch: emits sidecar-crash and calls _attemptAutoReconnect', () => {
  const reconnectCalls = [];
  const svc = makeService({
    _managedReadyOnce: true,
    _attemptAutoReconnect(status) { reconnectCalls.push(status); },
  });
  // sidecarManager.isStopping stays false (default)

  const status = { phase: 'failed', detail: 'process exited' };
  handleSidecarStatus(svc, status);

  // sidecar-crash must be emitted
  const crashEmit = svc.emits.find(([ev]) => ev === 'sidecar-crash');
  assert.ok(crashEmit, 'expected sidecar-crash emit');
  assert.equal(crashEmit[1].detail, 'process exited');
  assert.deepEqual(crashEmit[1].status, { phase: 'failed', detail: 'process exited' });

  // _attemptAutoReconnect must have been called
  assert.equal(reconnectCalls.length, 1, '_attemptAutoReconnect should be called exactly once');
  assert.equal(reconnectCalls[0].phase, 'failed');
});

test('handleSidecarStatus crash branch: does NOT call _attemptAutoReconnect when _autoReconnectPending is true', () => {
  const reconnectCalls = [];
  const svc = makeService({
    _managedReadyOnce: true,
    _autoReconnectPending: true,
    _attemptAutoReconnect(status) { reconnectCalls.push(status); },
  });

  handleSidecarStatus(svc, { phase: 'failed', detail: 'x' });

  assert.equal(reconnectCalls.length, 0, '_attemptAutoReconnect must not be called when _autoReconnectPending');
});

test('handleSidecarStatus crash branch: sidecar-crash NOT emitted when _managedReadyOnce is false', () => {
  const svc = makeService({ _managedReadyOnce: false });
  handleSidecarStatus(svc, { phase: 'failed', detail: 'never ready' });

  const crashEmit = svc.emits.find(([ev]) => ev === 'sidecar-crash');
  assert.ok(!crashEmit, 'sidecar-crash must not be emitted when _managedReadyOnce is false');
});

test('handleSidecarStatus crash branch: sidecar-crash NOT emitted when sidecarManager.isStopping', () => {
  const svc = makeService({
    _managedReadyOnce: true,
    sidecarManagerOverride: { isStopping: true },
  });
  handleSidecarStatus(svc, { phase: 'failed', detail: 'stopping' });

  const crashEmit = svc.emits.find(([ev]) => ev === 'sidecar-crash');
  assert.ok(!crashEmit, 'sidecar-crash must not be emitted when sidecarManager is stopping');
});

// ---------------------------------------------------------------------------
// handleSidecarLog — whitespace/empty: no log entry
// ---------------------------------------------------------------------------

test('handleSidecarLog: empty text produces no startup-log entry', () => {
  const svc = makeService();
  handleSidecarLog(svc, '');
  assert.equal(svc.logs.length, 0, 'no logs for empty text');
});

test('handleSidecarLog: whitespace-only text produces no startup-log entry', () => {
  const svc = makeService();
  handleSidecarLog(svc, '   \t  ');
  assert.equal(svc.logs.length, 0, 'no logs for whitespace text');
});

// ---------------------------------------------------------------------------
// handleSidecarLog — phase "starting": non-empty line IS logged
// ---------------------------------------------------------------------------

test('handleSidecarLog: valid structured record enters the canonical diagnostic stream', () => {
  const svc = makeService({
    sidecarManagerOverride: { isStopping: false, getStatus: () => ({ phase: 'starting' }) },
  });
  handleSidecarLog(svc, JSON.stringify({ level: 'INFO', event: 'sidecar.starting', message: 'Booting' }));
  const found = svc.emits.find(([event]) => event === 'diagnostic-entry');
  assert.ok(found);
  assert.equal(found[1].event, 'sidecar.starting');
  assert.equal(found[1].layer, 'sidecar');
});

// ---------------------------------------------------------------------------
// handleSidecarLog — phase "ready" + plain line: NOT logged
// ---------------------------------------------------------------------------

test('handleSidecarLog: phase ready + plain line (no startup keywords) -> no startup-log entry', () => {
  const svc = makeService({
    sidecarManagerOverride: { isStopping: false, getStatus: () => ({ phase: 'ready' }) },
  });
  handleSidecarLog(svc, 'Some random runtime log line');

  const found = svc.logs.find(([lvl, ev]) => ev === 'backend.sidecar_startup_log');
  assert.ok(!found, 'startup-log entry must NOT be present for a plain line when phase is ready');
});

// ---------------------------------------------------------------------------
// handleSidecarLog — phase "ready" + keyword "model loaded:": IS logged
// ---------------------------------------------------------------------------

test('handleSidecarLog: malformed records produce a bounded synthetic warning without raw text', () => {
  const svc = makeService({
    sidecarManagerOverride: { isStopping: false, getStatus: () => ({ phase: 'ready' }) },
  });
  handleSidecarLog(svc, 'secret raw malformed payload');
  handleSidecarLog(svc, 'another malformed payload');
  const found = svc.emits.filter(([event]) => event === 'diagnostic-entry');
  const drops = svc.emits.filter(([event]) => event === 'diagnostic-drop');
  assert.equal(found.length, 1, 'malformed warning is rate-limited');
  assert.equal(drops.length, 2, 'every discarded record contributes to integrity accounting');
  assert.ok(drops.every(([, drop]) => drop.source === 'sidecar' && drop.count === 1));
  assert.equal(found[0][1].event, 'sidecar.diagnostics.malformed_record');
  assert.doesNotMatch(JSON.stringify(found[0][1]), /secret raw|another malformed/);
});

// ---------------------------------------------------------------------------
// markManagedSidecarInitialized — not managed: returns early
// ---------------------------------------------------------------------------

// markManagedSidecarInitialized sets the ready flag and emits an INFO log.

test('markManagedSidecarInitialized: managed mode -> _managedReadyOnce becomes true + INFO log', () => {
  const svc = makeService({
    sidecarManagerOverride: {
      isStopping: false,
      getStatus: () => ({ baseUrl: 'http://localhost:8080', pid: 1, phase: 'ready' }),
    },
  });

  assert.equal(svc._managedReadyOnce, false, 'precondition: _managedReadyOnce starts false');
  markManagedSidecarInitialized(svc);

  assert.equal(svc._managedReadyOnce, true, '_managedReadyOnce must be set to true');

  const found = svc.logs.find(([lvl, ev]) => lvl === 'INFO' && ev === 'backend.managed_sidecar_initialized');
  assert.ok(found, 'expected backend.managed_sidecar_initialized log entry');
  assert.equal(found[2].baseUrl, 'http://localhost:8080');
  assert.equal(found[2].pid, 1);
  assert.equal(found[2].phase, 'ready');
});
