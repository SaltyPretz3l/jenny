'use strict';

// Coverage for services/backend/backend-session-migration-scheduler.js
// Exercises schedulePendingSessionMigrations, clearPendingSessionMigrationSchedule,
// and runPendingMigrations with hand-built fakes — no Electron mock required.

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const sched = require('../services/backend/backend-session-migration-scheduler'); // exports: schedulePendingSessionMigrations, clearPendingSessionMigrationSchedule, runPendingMigrations
const {
  schedulePendingSessionMigrations,
  clearPendingSessionMigrationSchedule,
  runPendingMigrations,
} = sched;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal fake service whose stores and log calls are fully recorded. */
function makeService(overrides = {}) {
  const logs = [];
  const service = {
    _disposed: false,
    _stopping: false,
    _pendingSessionMigrationScheduled: false,
    _pendingSessionMigrationImmediate: null,
    sessionStore: null,
    shadowStore: null,
    _emitServiceLog(level, event, data) {
      logs.push({ level, event, data });
    },
    runPendingMigrations() {
      // Thin delegator — the real class calls the extracted fn.
      return runPendingMigrations(this);
    },
    _logs: logs,
    ...overrides,
  };
  return service;
}

/** Build a fake store that optionally has pending migrations. */
function makeStore({ hasPending = true, migrationResult = { success: true, sessionCount: 3 }, throws = null } = {}) {
  const calls = [];
  return {
    _calls: calls,
    hasPendingMigrations() {
      calls.push('hasPendingMigrations');
      return hasPending;
    },
    async runPendingMigrations() {
      calls.push('runPendingMigrations');
      if (throws) throw throws;
      return migrationResult;
    },
  };
}

/** Wait for all enqueued setImmediate callbacks to flush. */
function flushImmediates() {
  return new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// schedulePendingSessionMigrations
// ---------------------------------------------------------------------------

describe('schedulePendingSessionMigrations', () => {
  test('does nothing when _disposed is true', (t) => {
    const service = makeService({ _disposed: true, sessionStore: makeStore() });
    schedulePendingSessionMigrations(service);
    assert.equal(service._pendingSessionMigrationScheduled, false);
    assert.equal(service._pendingSessionMigrationImmediate, null);
    assert.equal(service._logs.length, 0);
  });

  test('does nothing when _stopping is true', (t) => {
    const service = makeService({ _stopping: true, sessionStore: makeStore() });
    schedulePendingSessionMigrations(service);
    assert.equal(service._pendingSessionMigrationScheduled, false);
    assert.equal(service._pendingSessionMigrationImmediate, null);
  });

  test('does nothing when already scheduled', (t) => {
    const store = makeStore();
    const service = makeService({ _pendingSessionMigrationScheduled: true, sessionStore: store });
    schedulePendingSessionMigrations(service);
    // hasPendingMigrations should NOT be called — guard fires before filter
    assert.deepEqual(store._calls, []);
    assert.equal(service._pendingSessionMigrationImmediate, null);
  });

  test('does nothing when no store has pending migrations', (t) => {
    const store = makeStore({ hasPending: false });
    const service = makeService({ sessionStore: store, shadowStore: makeStore({ hasPending: false }) });
    schedulePendingSessionMigrations(service);
    assert.equal(service._pendingSessionMigrationScheduled, false);
    assert.equal(service._pendingSessionMigrationImmediate, null);
    assert.equal(service._logs.length, 0);
  });

  test('does nothing when stores are null/undefined (no hasPendingMigrations fn)', (t) => {
    const service = makeService(); // sessionStore and shadowStore are null
    schedulePendingSessionMigrations(service);
    assert.equal(service._pendingSessionMigrationScheduled, false);
    assert.equal(service._pendingSessionMigrationImmediate, null);
  });

  test('sets scheduled flag, emits queued log with correct store names, and sets an immediate', (t) => {
    const store = makeStore({ hasPending: true });
    const service = makeService({ sessionStore: store });
    schedulePendingSessionMigrations(service);

    // Flag must be set synchronously
    assert.equal(service._pendingSessionMigrationScheduled, true);
    // Immediate handle must be set
    assert.notEqual(service._pendingSessionMigrationImmediate, null);

    // Log emitted with correct store name
    assert.equal(service._logs.length, 1);
    assert.equal(service._logs[0].level, 'INFO');
    assert.equal(service._logs[0].event, 'backend.session_migrations_queued');
    assert.deepEqual(service._logs[0].data.stores, ['session_store']);

    // Clean up
    clearImmediate(service._pendingSessionMigrationImmediate);
  });

  test('includes shadow store name in queued log when shadow store has pending migrations', (t) => {
    const service = makeService({
      sessionStore: makeStore({ hasPending: true }),
      shadowStore: makeStore({ hasPending: true }),
    });
    schedulePendingSessionMigrations(service);

    assert.equal(service._logs[0].event, 'backend.session_migrations_queued');
    assert.deepEqual(service._logs[0].data.stores, ['session_store', 'session_shadow_store']);

    clearImmediate(service._pendingSessionMigrationImmediate);
  });

  test('second call while scheduled is a no-op (double-schedule guard)', (t) => {
    const store = makeStore({ hasPending: true });
    const service = makeService({ sessionStore: store });
    schedulePendingSessionMigrations(service);
    const firstHandle = service._pendingSessionMigrationImmediate;
    const logCountAfterFirst = service._logs.length;

    schedulePendingSessionMigrations(service); // should be guarded
    assert.strictEqual(service._pendingSessionMigrationImmediate, firstHandle);
    assert.equal(service._logs.length, logCountAfterFirst); // no extra log

    clearImmediate(firstHandle);
  });

  test('immediate fires and calls runPendingMigrations on healthy service', async (t) => {
    const store = makeStore({ hasPending: true });
    const service = makeService({ sessionStore: store });
    // Replace runPendingMigrations with a recorder
    const runCalls = [];
    service.runPendingMigrations = () => {
      runCalls.push('called');
      return Promise.resolve([]);
    };

    schedulePendingSessionMigrations(service);
    await flushImmediates();

    assert.deepEqual(runCalls, ['called']);
    assert.equal(service._pendingSessionMigrationImmediate, null);
  });

  test('immediate fires and skips runPendingMigrations when disposed before fire', async (t) => {
    const store = makeStore({ hasPending: true });
    const service = makeService({ sessionStore: store });
    const runCalls = [];
    service.runPendingMigrations = () => {
      runCalls.push('called');
      return Promise.resolve([]);
    };

    schedulePendingSessionMigrations(service);
    // Dispose before immediate fires
    service._disposed = true;
    await flushImmediates();

    assert.deepEqual(runCalls, []); // must NOT have been called
    assert.equal(service._pendingSessionMigrationScheduled, false);
    // Should emit the skipped log with reason=disposed
    const skippedLog = service._logs.find((l) => l.event === 'backend.session_migrations_skipped');
    assert.ok(skippedLog, 'expected a session_migrations_skipped log entry');
    assert.equal(skippedLog.data.reason, 'disposed');
  });

  test('immediate fires and skips runPendingMigrations when stopping before fire', async (t) => {
    const store = makeStore({ hasPending: true });
    const service = makeService({ sessionStore: store });
    const runCalls = [];
    service.runPendingMigrations = () => {
      runCalls.push('called');
      return Promise.resolve([]);
    };

    schedulePendingSessionMigrations(service);
    service._stopping = true;
    await flushImmediates();

    assert.deepEqual(runCalls, []);
    assert.equal(service._pendingSessionMigrationScheduled, false);
    const skippedLog = service._logs.find((l) => l.event === 'backend.session_migrations_skipped');
    assert.ok(skippedLog);
    assert.equal(skippedLog.data.reason, 'stopping');
  });
});

// ---------------------------------------------------------------------------
// clearPendingSessionMigrationSchedule
// ---------------------------------------------------------------------------

describe('clearPendingSessionMigrationSchedule', () => {
  test('clears an outstanding immediate and resets both flags', (t) => {
    const store = makeStore({ hasPending: true });
    const service = makeService({ sessionStore: store });
    schedulePendingSessionMigrations(service); // sets handle + flag

    assert.equal(service._pendingSessionMigrationScheduled, true);
    assert.notEqual(service._pendingSessionMigrationImmediate, null);

    clearPendingSessionMigrationSchedule(service);

    assert.equal(service._pendingSessionMigrationImmediate, null);
    assert.equal(service._pendingSessionMigrationScheduled, false);
  });

  test('is idempotent when called with no outstanding immediate', (t) => {
    const service = makeService();
    // No immediate set — should not throw
    clearPendingSessionMigrationSchedule(service);
    assert.equal(service._pendingSessionMigrationImmediate, null);
    assert.equal(service._pendingSessionMigrationScheduled, false);
  });

  test('calling clear prevents the immediate from invoking runPendingMigrations', async (t) => {
    const store = makeStore({ hasPending: true });
    const service = makeService({ sessionStore: store });
    const runCalls = [];
    service.runPendingMigrations = () => {
      runCalls.push('called');
      return Promise.resolve([]);
    };

    schedulePendingSessionMigrations(service);
    clearPendingSessionMigrationSchedule(service); // cancel before it fires
    await flushImmediates();

    assert.deepEqual(runCalls, []); // must be empty — callback was cancelled
    assert.equal(service._pendingSessionMigrationScheduled, false);
  });
});

// ---------------------------------------------------------------------------
// runPendingMigrations
// ---------------------------------------------------------------------------

describe('runPendingMigrations', () => {
  test('returns [] and clears flag immediately when _disposed', async (t) => {
    const store = makeStore({ hasPending: true });
    const service = makeService({ _disposed: true, sessionStore: store });
    service._pendingSessionMigrationScheduled = true;

    const results = await runPendingMigrations(service);

    assert.deepEqual(results, []);
    assert.equal(service._pendingSessionMigrationScheduled, false);
    // Store should never have been consulted
    assert.deepEqual(store._calls, []);
  });

  test('skips stores that have no hasPendingMigrations method', async (t) => {
    const service = makeService({
      sessionStore: { /* no hasPendingMigrations */ },
      shadowStore: null,
    });
    const results = await runPendingMigrations(service);
    assert.deepEqual(results, []);
    assert.equal(service._pendingSessionMigrationScheduled, false);
  });

  test('skips stores that return false from hasPendingMigrations', async (t) => {
    const store = makeStore({ hasPending: false });
    const service = makeService({ sessionStore: store });
    const results = await runPendingMigrations(service);
    assert.deepEqual(results, []);
    assert.equal(store._calls.includes('runPendingMigrations'), false);
  });

  test('happy path: calls runPendingMigrations on the store and returns shaped result', async (t) => {
    const store = makeStore({ hasPending: true, migrationResult: { success: true, sessionCount: 5 } });
    const service = makeService({ sessionStore: store });

    const results = await runPendingMigrations(service);

    // store.runPendingMigrations was invoked
    assert.ok(store._calls.includes('runPendingMigrations'), 'runPendingMigrations should have been called on the store');

    // Result has correct shape and values
    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'session_store');
    assert.equal(results[0].success, true);
    assert.equal(results[0].sessionCount, 5);

    // Log was emitted with correct level and event
    const log = service._logs.find((l) => l.event === 'backend.session_migration_completed');
    assert.ok(log, 'expected session_migration_completed log');
    assert.equal(log.level, 'INFO');
    assert.equal(log.data.store, 'session_store');
    assert.equal(log.data.success, true);
    assert.equal(log.data.sessionCount, 5);

    assert.equal(service._pendingSessionMigrationScheduled, false);
  });

  test('WARN log emitted when store result has success=false', async (t) => {
    const store = makeStore({ hasPending: true, migrationResult: { success: false, sessionCount: 0 } });
    const service = makeService({ sessionStore: store });

    const results = await runPendingMigrations(service);

    assert.equal(results[0].success, false);
    const log = service._logs.find((l) => l.event === 'backend.session_migration_completed');
    assert.ok(log);
    assert.equal(log.level, 'WARN');
    assert.equal(log.data.success, false);
  });

  test('catch branch: error from store.runPendingMigrations is caught and recorded', async (t) => {
    const err = new Error('disk full');
    const store = makeStore({ hasPending: true, throws: err });
    const service = makeService({ sessionStore: store });

    const results = await runPendingMigrations(service);

    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'session_store');
    assert.equal(results[0].success, false);
    assert.equal(results[0].error, 'disk full');

    const log = service._logs.find((l) => l.event === 'backend.session_migration_failed');
    assert.ok(log, 'expected session_migration_failed log');
    assert.equal(log.level, 'WARN');
    assert.equal(log.data.store, 'session_store');
    assert.equal(log.data.message, 'disk full');

    assert.equal(service._pendingSessionMigrationScheduled, false);
  });

  test('catch branch: string error (non-Error) is stringified correctly', async (t) => {
    const store = makeStore({ hasPending: true, throws: 'string error' });
    const service = makeService({ sessionStore: store });

    const results = await runPendingMigrations(service);

    assert.equal(results[0].error, 'string error');
    const log = service._logs.find((l) => l.event === 'backend.session_migration_failed');
    assert.ok(log);
    assert.equal(log.data.message, 'string error');
  });

  test('processes both session_store and shadow_store when both have pending migrations', async (t) => {
    const sessionStore = makeStore({ hasPending: true, migrationResult: { success: true, sessionCount: 2 } });
    const shadowStore = makeStore({ hasPending: true, migrationResult: { success: true, sessionCount: 7 } });
    const service = makeService({ sessionStore, shadowStore });

    const results = await runPendingMigrations(service);

    assert.equal(results.length, 2);
    assert.equal(results[0].name, 'session_store');
    assert.equal(results[0].sessionCount, 2);
    assert.equal(results[1].name, 'session_shadow_store');
    assert.equal(results[1].sessionCount, 7);

    assert.ok(sessionStore._calls.includes('runPendingMigrations'));
    assert.ok(shadowStore._calls.includes('runPendingMigrations'));
  });

  test('does not start another store migration after disposal during an awaited migration', async () => {
    let releaseSessionMigration;
    const sessionStore = makeStore();
    sessionStore.runPendingMigrations = () => new Promise((resolve) => {
      releaseSessionMigration = resolve;
    });
    const shadowStore = makeStore();
    const service = makeService({ sessionStore, shadowStore });
    service._pendingSessionMigrationScheduled = true;

    const pending = runPendingMigrations(service);
    await flushImmediates();
    service._disposed = true;
    releaseSessionMigration({ success: true, sessionCount: 1 });
    await pending;

    assert.equal(shadowStore._calls.includes('runPendingMigrations'), false);
    assert.equal(service._pendingSessionMigrationScheduled, false);
  });

  test('missing sessionCount field defaults to 0 in log', async (t) => {
    const store = makeStore({ hasPending: true, migrationResult: { success: true } });
    const service = makeService({ sessionStore: store });

    await runPendingMigrations(service);

    const log = service._logs.find((l) => l.event === 'backend.session_migration_completed');
    assert.ok(log);
    assert.equal(log.data.sessionCount, 0);
  });

  test('always clears _pendingSessionMigrationScheduled after run, even with errors', async (t) => {
    const err = new Error('boom');
    const sessionStore = makeStore({ hasPending: true, throws: err });
    const shadowStore = makeStore({ hasPending: true, throws: err });
    const service = makeService({ sessionStore, shadowStore });
    service._pendingSessionMigrationScheduled = true;

    await runPendingMigrations(service);

    assert.equal(service._pendingSessionMigrationScheduled, false);
  });
});
