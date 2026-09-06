'use strict';

/**
 * Dark-path coverage for services/backend/backend-service.js
 *
 * Targets uncovered regions:
 *   310-311, 391-392, 399-400, 407-409, 457-458, 470-471,
 *   501-502, 526-527, 550-551, 566-567, 570-571, 574-575,
 *   614-615, 626-630, 657-658, 661-662, 669-670, 685-686,
 *   692-693, 751-800, 852-859, 882-883
 *
 * Strategy: direct import + hand-built injectable fakes.
 * Each test verifies that a delegator method (a) passes the right args to the
 * injected collaborator AND (b) returns the collaborator's result.  Assertions
 * are non-vacuous: every test would fail if the call or return were removed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { BackendService } = require('../services/backend/backend-service');
const { createFakeSafeStorage } = require('./helpers/fake-safe-storage');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

// ---------------------------------------------------------------------------
// Shared minimal-fixture factory (avoids hitting real disk repeatedly).
// Injects lightweight fakes for the collaborator services that are under test.
// ---------------------------------------------------------------------------

function createMinimalService(overrides = {}) {
  const userDataPath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jenny-bs-dark-')
  );
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    safeStorage: createFakeSafeStorage(),
    ...overrides,
  });
  return { service, userDataPath };
}

// Lines 391-392 — _attemptAutoReconnect delegates to injected collaborator

test('_attemptAutoReconnect drives the real collaborator: emits retrying status + forwards failedStatus.detail', async () => {
  // REAL delegator _attemptAutoReconnectManaged: emits a retrying backend-status +
  // a backend.auto_reconnect_start log carrying failedStatus.detail. retryStart is
  // stubbed NON-ready so the process-spawning ready-branches never run.
  const { service } = createMinimalService();
  const fakeStatus = { phase: 'failed', detail: 'net-timeout-sample' };

  const statusEvents = [];
  const serviceLogs = [];
  service.on('backend-status', (evt) => statusEvents.push(evt));
  service.on('service-log', (evt) => serviceLogs.push(evt));
  // Non-ready return → collaborator's ready-gated spawn branches are all skipped.
  service.sidecarManager.retryStart = async () => ({ phase: 'failed' });

  await service._attemptAutoReconnect(fakeStatus);

  const retrying = statusEvents.find((e) => e.phase === 'retrying');
  assert.ok(retrying, 'collaborator must emit a retrying backend-status (only the real path does this)');
  const startLog = serviceLogs.find((e) => e.event === 'backend.auto_reconnect_start');
  assert.ok(startLog, 'collaborator must emit backend.auto_reconnect_start');
  assert.equal(startLog.details.detail, 'net-timeout-sample',
    'failedStatus.detail must be forwarded into the collaborator log (pins arg passing)');
  service.dispose();
});

// Lines 399-400 — _handleSidecarLog delegates to _handleLocalEngineSidecarLog

test('_handleSidecarLog drives the real collaborator: forwards a structured sidecar record', () => {
  const { service } = createMinimalService();
  const entries = [];
  service.on('diagnostic-entry', (entry) => entries.push(entry));

  service._handleSidecarLog(JSON.stringify({
    level: 'INFO',
    event: 'sidecar.starting',
    message: 'Sidecar is starting.',
  }));

  assert.equal(entries.length, 1);
  assert.equal(entries[0].event, 'sidecar.starting');
  assert.equal(entries[0].message, 'Sidecar is starting.');
  assert.equal(entries[0].layer, 'sidecar');
  assert.equal(entries[0].source, 'sidecar');
  assert.equal(entries[0].redaction_mode, 'redacted');

  const before = entries.length;
  service._handleSidecarLog('   ');
  assert.equal(entries.length, before, 'whitespace-only input must be ignored');
  service.dispose();
});

test('sidecarManager log event drives the wired listener through to the real side-effect', () => {
  // The constructor wires _handleSidecarLog as the sidecarManager 'log' listener.
  // Emitting 'log' must run it end-to-end into the canonical diagnostic stream.
  const { service } = createMinimalService();

  assert.ok(
    service.sidecarManager.listenerCount('log') > 0,
    'sidecarManager must have at least one log listener wired in the constructor'
  );

  // Force a non-ready phase so the mirror branch fires deterministically.
  const entries = [];
  service.on('diagnostic-entry', (entry) => entries.push(entry));

  service.sidecarManager.emit('log', JSON.stringify({
    level: 'DEBUG',
    event: 'sidecar.wired',
    message: 'Wired structured record.',
  }));

  assert.equal(entries.length, 1, 'the wired log listener must reach the diagnostic stream');
  assert.equal(entries[0].event, 'sidecar.wired');
  assert.equal(entries[0].message, 'Wired structured record.');

  service.dispose();
});

// Lines 407-409 — _removeManagedListeners fallback path via removeListener
// (fires when sidecarManager.off is NOT a function)

test('_removeManagedListeners uses removeListener when off is not a function', () => {
  const { service } = createMinimalService();
  const removedListeners = [];

  // EventEmitter.off is on the prototype; we must set the instance property
  // to undefined (not delete) to shadow the prototype method.
  service.sidecarManager.off = undefined;

  // Now override removeListener to record calls
  const origRemoveListener = service.sidecarManager.removeListener.bind(service.sidecarManager);
  service.sidecarManager.removeListener = function (event, listener) {
    removedListeners.push({ event, listener });
    origRemoveListener(event, listener); // forward so listeners are actually removed
  };

  service._removeManagedListeners();

  assert.equal(removedListeners.length, 2, 'removeListener must be called for both status and log');
  const events = removedListeners.map((r) => r.event);
  assert.ok(events.includes('status'), 'removeListener must be called for status');
  assert.ok(events.includes('log'), 'removeListener must be called for log');

  // Restore off so dispose() works cleanly (don't use off path since we're done)
  service.sidecarManager.off = origRemoveListener;
  service._disposed = true; // short-circuit dispose so we don't double-call listeners
});

// Lines 457-458 — runPendingMigrations delegates to _runPendingMigrations

test('runPendingMigrations drives the real collaborator: runs pending stores and aggregates results', async () => {
  // REAL delegator _runPendingMigrations: walks [sessionStore, shadowStore], runs
  // each with hasPendingMigrations()===true, returns one tagged result per store.
  const { service } = createMinimalService();
  const sessionRunCalls = [];

  service.sessionStore = {
    hasPendingMigrations: () => true,
    runPendingMigrations: async () => { sessionRunCalls.push('run'); return { success: true, sessionCount: 4 }; },
  };
  // shadowStore reports no pending work → must be skipped by the collaborator.
  service.shadowStore = {
    hasPendingMigrations: () => false,
    runPendingMigrations: async () => { throw new Error('shadow must not be migrated'); },
  };

  const result = await service.runPendingMigrations();

  assert.equal(sessionRunCalls.length, 1, 'collaborator must run the session store exactly once');
  assert.equal(Array.isArray(result), true, 'collaborator must return an array of results');
  assert.equal(result.length, 1, 'only the session store (pending) must be migrated, not the shadow store');
  assert.equal(result[0].name, 'session_store', 'result must be tagged with the migrated store name');
  assert.equal(result[0].success, true, 'collaborator must propagate the store result');
  assert.equal(result[0].sessionCount, 4, 'collaborator must propagate the migrated sessionCount');
  // _disposed short-circuit was never set; mark disposed before teardown of injected fakes.
  service._disposed = true;
});

// Lines 470-471 — dispose() double-call guard (already disposed noop)

test('dispose is idempotent: second call is a no-op (already-disposed guard)', () => {
  const { service } = createMinimalService();

  service.dispose();
  assert.equal(service._disposed, true);

  // Second call must not throw and must not change any state further
  let threw = false;
  try {
    service.dispose();
  } catch (_) {
    threw = true;
  }
  assert.equal(threw, false, 'second dispose() must not throw');
  assert.equal(service._disposed, true, '_disposed must still be true');
});

// Lines 501-502 — retryStart delegates to _retryStartBackendService

test('retryStart drives the real collaborator: returns sidecarManager.retryStart() status', async () => {
  // REAL delegator _retryStartBackendService: calls sidecarManager.retryStart() and
  // returns its status. NON-ready return skips all process-spawning ready-branches.
  const { service } = createMinimalService();
  const retryCalls = [];
  const managerStatus = { phase: 'failed', detail: 'retry-sample' };
  service.sidecarManager.retryStart = async () => { retryCalls.push('retry'); return managerStatus; };

  const result = await service.retryStart();

  assert.equal(retryCalls.length, 1, 'collaborator must call sidecarManager.retryStart once');
  assert.equal(result, managerStatus, 'collaborator must return the manager status object as-is');
  assert.equal(result.phase, 'failed', 'the returned status phase must be propagated unchanged');
  service.dispose();
});

// Lines 526-527 — setFeatureFlags calls skillsService.setFeatureEnabled

test('setFeatureFlags calls skillsService.setFeatureEnabled with correct boolean', async () => {
  const enabledCalls = [];
  const { service } = createMinimalService();

  service.skillsService = {
    setFeatureEnabled: (val) => enabledCalls.push(val),
  };

  const result = await service.setFeatureFlags({ skills_system: true });

  assert.ok(enabledCalls.length >= 1, 'skillsService.setFeatureEnabled must be called');
  assert.equal(enabledCalls[enabledCalls.length - 1], true,
    'setFeatureEnabled must be called with true when skills_system is true');
  assert.equal(result.skills_system, true, 'setFeatureFlags must return the merged flags');
  service.dispose();
});

test('setFeatureFlags calls skillsService.setFeatureEnabled with false when flag is absent', async () => {
  const enabledCalls = [];
  const { service } = createMinimalService();

  service.skillsService = {
    setFeatureEnabled: (val) => enabledCalls.push(val),
  };

  await service.setFeatureFlags({});

  assert.ok(enabledCalls.length >= 1, 'skillsService.setFeatureEnabled must be called');
  assert.equal(enabledCalls[enabledCalls.length - 1], false,
    'setFeatureEnabled must be called with false when skills_system is absent');
  service.dispose();
});

// Lines 574-575 — _getManagedReasoningSupportForModel delegates

test('_getManagedReasoningSupportForModel drives the real collaborator: forwarded model selects the engine_fallback path', () => {
  // REAL delegator _getManagedReasoningSupportForModel: infers the engine FROM the
  // forwarded model, so the result depends on the model. Two cases prove it's used.
  const { service } = createMinimalService();

  // Case A: engine_fallback.requested_engine === 'mock'. A 'mock-model' infers
  // engineType 'mock' → matches the fallback → short-circuits to 'unsupported'.
  service.currentStatus = { engine_fallback: { requested_engine: 'mock' } };
  const mockResult = service._getManagedReasoningSupportForModel('mock-model');
  assert.equal(mockResult, 'unsupported',
    'a model inferring the fallback engine must short-circuit to unsupported (model is used)');

  // Case B: no fallback, but provider_capabilities declares ollama 'supported'.
  // 'qwen3:8b' infers engineType 'ollama' → declared support is honored.
  // If the model were NOT forwarded, engineType would default off currentStatus
  // and this declared-support lookup could not key on 'ollama'.
  service.currentStatus = {
    provider_capabilities: { ollama: { reasoning_effort_support: 'supported' } },
  };
  const ollamaResult = service._getManagedReasoningSupportForModel('qwen3:8b');
  assert.equal(ollamaResult, 'supported',
    'forwarding an ollama model must resolve declared ollama support (model drives the engine key)');
  service.dispose();
});

// Lines 614-615 — getHardwareVramUsage delegates

test('getHardwareVramUsage drives the real collaborator: forwards to client + normalizes payload', async () => {
  // REAL delegator _getHardwareVramUsage: gates on managed + no active streams +
  // ready phase + sidecarClient, then calls hardwareVramUsage() and NORMALIZES the
  // snake_case payload to camelCase. We assert the normalized shape (passthrough fails).
  const { service } = createMinimalService();
  const clientCalls = [];
  service.activeStreams = new Map();
  service.sidecarManager.getStatus = () => ({ phase: 'ready' });
  service.sidecarClient = {
    hardwareVramUsage: async () => {
      clientCalls.push('vram');
      return { available: true, used_mb: 8192, total_mb: 16384, gpu_type: 'sample-gpu', source: 'nvml' };
    },
    dispose: () => {},
    off: () => {},
  };

  const result = await service.getHardwareVramUsage();

  assert.equal(clientCalls.length, 1, 'collaborator must call sidecarClient.hardwareVramUsage once');
  assert.equal(result.usedMb, 8192, 'collaborator must normalize used_mb -> usedMb');
  assert.equal(result.totalMb, 16384, 'collaborator must normalize total_mb -> totalMb');
  assert.equal(result.available, true, 'available must reflect a positive totalMb');
  assert.equal(result.gpuType, 'sample-gpu', 'collaborator must normalize gpu_type -> gpuType');

  // Guard branch: a non-ready phase must short-circuit to null without calling the client.
  clientCalls.length = 0;
  service.sidecarManager.getStatus = () => ({ phase: 'starting' });
  const guarded = await service.getHardwareVramUsage();
  assert.equal(guarded, null, 'non-ready phase must return null');
  assert.equal(clientCalls.length, 0, 'client must not be called when not ready');

  service.sidecarClient = null;
  service.dispose();
});

// Lines 626-630 — getSessionSummariesForScheduler delegates to the store

test('getSessionSummariesForScheduler returns sessionStore.listSessions()', () => {
  const { service } = createMinimalService();
  const fakeSessions = [{ id: 'sess-a' }, { id: 'sess-b' }];
  service.sessionStore = { listSessions: () => fakeSessions };

  const result = service.getSessionSummariesForScheduler();

  assert.deepEqual(result, fakeSessions, 'must delegate to sessionStore.listSessions() (line 629)');
  service.dispose();
});

// Lines 657-658 — setSessionMeta delegates to _setSessionMeta

test('setSessionMeta drives the real collaborator: forwards sessionId+meta to sessionStore, guards empty id', async () => {
  // REAL delegator _setSessionMeta (managed mode): forwards to
  // sessionStore.setSessionMeta; empty sessionId short-circuits to null.
  const { service } = createMinimalService();
  const calls = [];
  const expectedResult = { ok: true, applied: true };
  service.sessionStore = {
    setSessionMeta: (sessionId, meta) => { calls.push({ sessionId, meta }); return expectedResult; },
  };

  const result = await service.setSessionMeta('sess-1', { title: 'sample' });

  assert.equal(calls.length, 1, 'collaborator must call sessionStore.setSessionMeta once');
  assert.equal(calls[0].sessionId, 'sess-1', 'sessionId must be forwarded as-is');
  assert.deepEqual(calls[0].meta, { title: 'sample' }, 'meta must be forwarded as-is');
  assert.equal(result, expectedResult, 'collaborator must return the store result');

  // Empty-id guard: must return null and must NOT call the store again.
  const guarded = await service.setSessionMeta('', { title: 'x' });
  assert.equal(guarded, null, 'empty sessionId must return null');
  assert.equal(calls.length, 1, 'empty sessionId must not reach the store');
  service.dispose();
});

// Lines 661-662 — sweepEmptySessions delegates to _sweepEmptySessions

test('sweepEmptySessions drives the real collaborator with normalized options', async () => {
  // REAL delegator _sweepEmptySessions normalizes { dryRun,
  // currentSessionId } and forwards to the store.
  const { service } = createMinimalService();
  const calls = [];
  const expectedResult = { candidateIds: ['c1'], deleted: 2 };
  service.sessionStore = {
    sweepEmptySessions: (options) => { calls.push(options); return expectedResult; },
  };

  const result = await service.sweepEmptySessions({ dryRun: true, currentSessionId: 42 });

  assert.equal(calls.length, 1, 'collaborator must call sessionStore.sweepEmptySessions once');
  assert.equal(calls[0].dryRun, true, 'dryRun must be forwarded (normalized to boolean true)');
  assert.equal(calls[0].currentSessionId, '42', 'currentSessionId must be normalized to a string');
  assert.equal(result, expectedResult, 'collaborator must return the store result');
  service.dispose();
});

// Lines 669-670 — editUserMessageAndTruncate delegates

test('editUserMessageAndTruncate drives the real collaborator: forwards id+content into truncateAfterMessage', async () => {
  // REAL delegator _editUserMessageAndTruncate (managed mode): forwards (sid, mid,
  // { replaceMessageContent }) to sessionStore.truncateAfterMessage; empty ids → null.
  const { service } = createMinimalService();
  const calls = [];
  const summary = { id: 'sess-x', message_count: 1 };
  service.sessionStore = {
    conversationStore: {
      getRollbackSnapshot: () => ({ session: summary, index: {} }),
      truncateAfterMessage: (sid, mid, options) => {
        calls.push({ sid, mid, options });
        return {
          ok: true, applied: true, durable: true, reason: null,
          commitEpoch: 1, dirtyEpoch: 1, durableEpoch: 1,
          value: { session: summary, survivingTurnIds: [] },
        };
      },
    },
  };
  // No shadow mirror / journal purge needed for this assertion.
  service.shadowStore = {};
  service.turnEventJournal = {};

  const result = await service.editUserMessageAndTruncate('sess-x', 'msg-y', { content: 'edited-sample' });

  assert.equal(calls.length, 1, 'collaborator must call sessionStore.truncateAfterMessage once');
  assert.equal(calls[0].sid, 'sess-x', 'sessionId must be forwarded as-is');
  assert.equal(calls[0].mid, 'msg-y', 'messageId must be forwarded as-is');
  assert.equal(calls[0].options.replaceMessageContent, 'edited-sample',
    'payload.content must be mapped into options.replaceMessageContent');
  assert.equal(result.id, summary.id, 'collaborator must return the store summary');

  // Empty messageId guard → null, store untouched.
  const guarded = await service.editUserMessageAndTruncate('sess-x', '', { content: 'x' });
  assert.equal(guarded, null, 'empty messageId must return null');
  assert.equal(calls.length, 1, 'empty messageId must not reach the store');
  service.dispose();
});

// Lines 685-686 — runBackgroundTask delegates to _runBackgroundTask

test('runBackgroundTask drives the real collaborator: forwards normalized task+params to sidecarClient.backgroundRun', async () => {
  // REAL delegator _runBackgroundTask: lowercases the task, forwards (task, params)
  // to sidecarClient.backgroundRun, normalizes the result; no client → skipped shape.
  const { service } = createMinimalService();
  const calls = [];
  service.sidecarClient = {
    backgroundRun: async (task, params) => {
      calls.push({ task, params });
      return { status: 'completed', task, run_id: 'run-1', summary: 'done' };
    },
    dispose: () => {},
    off: () => {},
  };

  const result = await service.runBackgroundTask('Summarize', { sessionId: 'sess-sample' });

  assert.equal(calls.length, 1, 'collaborator must call sidecarClient.backgroundRun once');
  assert.equal(calls[0].task, 'summarize', 'task must be lowercased before forwarding');
  assert.deepEqual(calls[0].params, { sessionId: 'sess-sample' }, 'params must be forwarded as-is');
  assert.equal(result.status, 'completed', 'collaborator must propagate the normalized status');
  assert.equal(result.run_id, 'run-1', 'collaborator must propagate run_id');

  // Empty task → real collaborator throws.
  await assert.rejects(() => service.runBackgroundTask('', {}), /task is required/,
    'empty task must be rejected by the real collaborator');

  // No sidecarClient → skipped shape, backgroundRun not called.
  service.sidecarClient = null;
  const skipped = await service.runBackgroundTask('summarize', {});
  assert.equal(skipped.status, 'skipped', 'missing sidecarClient must yield a skipped result');
  assert.equal(skipped.reason, 'sidecar_unavailable', 'skip reason must reflect the missing sidecar');
  service.dispose();
});

// Lines 692-693 — trimDismissedMemoryFingerprints trims when over limit

test('trimDismissedMemoryFingerprints removes oldest entries when over MAX_DISMISSED_MEMORY_FINGERPRINTS', () => {
  const { MAX_DISMISSED_MEMORY_FINGERPRINTS } = require('../services/backend/backend-service');
  const { service } = createMinimalService();

  // Fill to MAX + 2 so trimming fires twice
  for (let i = 0; i < MAX_DISMISSED_MEMORY_FINGERPRINTS + 2; i++) {
    service._dismissedMemoryFingerprints.add(`fp-${i}`);
  }

  const beforeSize = service._dismissedMemoryFingerprints.size;
  assert.equal(beforeSize, MAX_DISMISSED_MEMORY_FINGERPRINTS + 2);

  service.trimDismissedMemoryFingerprints();

  // After trim: size must be <= MAX_DISMISSED_MEMORY_FINGERPRINTS
  assert.ok(
    service._dismissedMemoryFingerprints.size <= MAX_DISMISSED_MEMORY_FINGERPRINTS,
    `size after trim must be <= ${MAX_DISMISSED_MEMORY_FINGERPRINTS}, got ${service._dismissedMemoryFingerprints.size}`
  );
  // Oldest entries (fp-0, fp-1) must have been deleted
  assert.equal(service._dismissedMemoryFingerprints.has('fp-0'), false,
    'oldest fingerprint fp-0 must have been trimmed');
  assert.equal(service._dismissedMemoryFingerprints.has('fp-1'), false,
    'oldest fingerprint fp-1 must have been trimmed');
  service.dispose();
});

test('trimDismissedMemoryFingerprints is a no-op when under MAX_DISMISSED_MEMORY_FINGERPRINTS', () => {
  const { MAX_DISMISSED_MEMORY_FINGERPRINTS } = require('../services/backend/backend-service');
  const { service } = createMinimalService();

  service._dismissedMemoryFingerprints.add('fp-only');
  service.trimDismissedMemoryFingerprints();

  assert.equal(service._dismissedMemoryFingerprints.size, 1, 'size must be unchanged when under limit');
  assert.equal(service._dismissedMemoryFingerprints.has('fp-only'), true,
    'only entry must be preserved when under limit');
  service.dispose();
});

// Lines 779-780 — getCodexCliState delegates to codexCliRuntimeService.getState

test('getCodexCliState forwards call to codexCliRuntimeService.getState and returns result', () => {
  const { service } = createMinimalService();
  const fakeState = { authenticated: false, status: 'idle' };
  const calls = [];

  service.codexCliRuntimeService = {
    getState: () => { calls.push('getState'); return fakeState; },
  };

  const result = service.getCodexCliState();

  assert.equal(calls.length, 1, 'codexCliRuntimeService.getState must be called once');
  assert.equal(result, fakeState, 'getCodexCliState must return the service state');
  service.dispose();
});

// Lines 783-784 — refreshCodexCliState delegates to codexCliRuntimeService.refresh

test('refreshCodexCliState forwards call to codexCliRuntimeService.refresh and returns result', () => {
  const { service } = createMinimalService();
  const calls = [];
  const expectedResult = { refreshed: true };

  service.codexCliRuntimeService = {
    refresh: () => { calls.push('refresh'); return expectedResult; },
  };

  const result = service.refreshCodexCliState();

  assert.equal(calls.length, 1, 'codexCliRuntimeService.refresh must be called once');
  assert.equal(result, expectedResult, 'refreshCodexCliState must return the service result');
  service.dispose();
});

// Lines 787-788 — openCodexCliLoginTerminal delegates

test('openCodexCliLoginTerminal forwards call to codexCliRuntimeService.openLoginTerminal', () => {
  const { service } = createMinimalService();
  const calls = [];
  const expectedResult = { opened: true };

  service.codexCliRuntimeService = {
    openLoginTerminal: () => { calls.push('openLoginTerminal'); return expectedResult; },
  };

  const result = service.openCodexCliLoginTerminal();

  assert.equal(calls.length, 1, 'codexCliRuntimeService.openLoginTerminal must be called once');
  assert.equal(result, expectedResult, 'openCodexCliLoginTerminal must return the service result');
  service.dispose();
});

// Lines 790-792 — getPhasePercentilesSnapshot delegates to
//                  phasePercentilesAggregator.snapshot()

test('getPhasePercentilesSnapshot forwards call to phasePercentilesAggregator.snapshot and returns result', async () => {
  const { service } = createMinimalService();
  const fakeSnapshot = { p50: 100, p95: 400 };
  const calls = [];

  service.phasePercentilesAggregator = {
    snapshot: () => { calls.push('snapshot'); return fakeSnapshot; },
  };

  const result = await service.getPhasePercentilesSnapshot();

  assert.equal(calls.length, 1, 'phasePercentilesAggregator.snapshot must be called once');
  assert.equal(result, fakeSnapshot, 'getPhasePercentilesSnapshot must return the aggregator result');
  service.dispose();
});

// Lines 794-796 — getToolObservabilitySnapshot delegates

test('getToolObservabilitySnapshot forwards call to toolObservabilityAggregator.snapshot and returns result', () => {
  const { service } = createMinimalService();
  const fakeSnapshot = { totalCalls: 10, failedCalls: 1 };
  const calls = [];

  service.toolObservabilityAggregator = {
    snapshot: () => { calls.push('snapshot'); return fakeSnapshot; },
  };

  const result = service.getToolObservabilitySnapshot();

  assert.equal(calls.length, 1, 'toolObservabilityAggregator.snapshot must be called once');
  assert.equal(result, fakeSnapshot, 'getToolObservabilitySnapshot must return the aggregator result');
  service.dispose();
});

// Lines 798-800 — resetPhasePercentiles delegates to
//                  phasePercentilesAggregator.reset()

test('resetPhasePercentiles forwards call to phasePercentilesAggregator.reset and returns result', async () => {
  const { service } = createMinimalService();
  const calls = [];
  const expectedResult = { reset: true };

  service.phasePercentilesAggregator = {
    reset: () => { calls.push('reset'); return expectedResult; },
  };

  const result = await service.resetPhasePercentiles();

  assert.equal(calls.length, 1, 'phasePercentilesAggregator.reset must be called once');
  assert.equal(result, expectedResult, 'resetPhasePercentiles must return the aggregator result');
  service.dispose();
});

// compactContextNow coverage lives in tests/backend-service-compact-context.test.js
// (kept out of this file to stay under the file-size ceiling).

// Lines 882-883 — _restartManagedSidecar delegates

test('_restartManagedSidecar drives the real collaborator and forwards the restart reason', async () => {
  // REAL delegator _restartManagedSidecar emits a
  // sidecar.restart_requested log carrying the reason, calls sidecarManager.retryStart();
  // a non-ready status → catch path → false (no real process spawned).
  const { service } = createMinimalService();
  const serviceLogs = [];
  service.on('service-log', (evt) => serviceLogs.push(evt));
  service.sidecarManager.retryStart = async () => ({ phase: 'failed' });

  const result = await service._restartManagedSidecar('config_reload');

  const restartLog = serviceLogs.find((e) => e.event === 'sidecar.restart_requested');
  assert.ok(restartLog, 'collaborator must emit sidecar.restart_requested');
  assert.equal(restartLog.details.reason, 'config_reload',
    'the reason must be forwarded into the restart log (pins arg passing)');
  assert.equal(result, false, 'a non-ready retry must resolve to false');
  service.dispose();
});

// Lines 495-496 — dispose ollamaManager._forceKillAnyRemainingLocalOllamaSync
// error path: even when it throws, dispose must complete without propagating

test('dispose swallows errors from ollamaManager._forceKillAnyRemainingLocalOllamaSync', () => {
  const { service } = createMinimalService();
  let killAttempted = false;

  service.ollamaManager = {
    _platform: 'win32',
    _log: () => {},
    _isProcessAlive: () => false,
    _forceKillAnyRemainingLocalOllamaSync: () => {
      killAttempted = true;
      throw new Error('kill failed — sample error');
    },
  };

  // Must not throw even though kill throws
  assert.doesNotThrow(() => service.dispose(), 'dispose must swallow ollamaManager kill errors');
  assert.equal(killAttempted, true, 'kill must have been attempted');
  assert.equal(service._disposed, true, '_disposed must be true after dispose');
});

// Lines 495-508 — dispose skips the force-kill sweep when the manager reports
// no possible local-ollama residue (never spawned this run, no owned-state
// record on disk). The sweep's synchronous process scan costs ~1s on win32,
// so an unconditional sweep taxes every dispose — including every test that
// constructs a BackendService.

test('dispose skips the ollama force-kill sweep when mightHaveLocalOllamaResidue is false', () => {
  const { service } = createMinimalService();
  let killAttempted = false;
  service.ollamaManager._forceKillAnyRemainingLocalOllamaSync = () => {
    killAttempted = true;
  };

  // Fresh mkdtemp userDataPath + nothing spawned: the REAL manager must report
  // no residue, and dispose must therefore skip the sweep entirely.
  assert.equal(service.ollamaManager.mightHaveLocalOllamaResidue(), false,
    'a never-spawned manager with no owned-state record must report no residue');
  service.dispose();
  assert.equal(killAttempted, false, 'dispose must not run the sweep when there is no residue');
  assert.equal(service._disposed, true, '_disposed must be true after dispose');
});

test('dispose runs the ollama force-kill sweep when residue is possible (spawn latch)', () => {
  const { service } = createMinimalService();
  let killAttempted = false;
  service.ollamaManager._forceKillAnyRemainingLocalOllamaSync = () => {
    killAttempted = true;
  };

  // The latch stays true even after stop() clears _ownedProcess -- pin the
  // latch directly: once a spawn happened this run, dispose must sweep.
  service.ollamaManager._everOwnedProcess = true;
  assert.equal(service.ollamaManager.mightHaveLocalOllamaResidue(), true,
    'the spawn latch must force residue=true even with _ownedProcess false');
  service.dispose();
  assert.equal(killAttempted, true, 'dispose must sweep when a spawn happened this run');
});
