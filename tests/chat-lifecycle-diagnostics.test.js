'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  recordLifecycleDiagnostic,
  getLifecycleDiagnosticCounts,
  resetLifecycleDiagnosticCounts,
} = require('../services/backend/chat-lifecycle-diagnostics');

test.beforeEach(() => {
  resetLifecycleDiagnosticCounts();
});

test('recordLifecycleDiagnostic increments the named counter and emits a structured lifecycle event', () => {
  const logs = [];
  recordLifecycleDiagnostic(
    (level, event, details) => logs.push({ level, event, details }),
    'lease_conflict',
    { path: 'external', sessionId: 'session-1' }
  );

  assert.deepEqual(getLifecycleDiagnosticCounts(), { lease_conflict: 1 });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'WARN');
  assert.equal(logs[0].event, 'lifecycle.lease_conflict');
  assert.deepEqual(logs[0].details, { count: 1, path: 'external', sessionId: 'session-1' });
});

test('recordLifecycleDiagnostic uses WARN for durability_degrade', () => {
  const logs = [];
  recordLifecycleDiagnostic(
    (level, event, details) => logs.push({ level, event, details }),
    'durability_degrade',
    { reason: 'write_failed' }
  );
  assert.equal(logs[0].level, 'WARN');
  assert.equal(logs[0].event, 'lifecycle.durability_degrade');
});

test('recordLifecycleDiagnostic defaults an unrecognized counter to INFO', () => {
  const logs = [];
  recordLifecycleDiagnostic(
    (level, event, details) => logs.push({ level, event, details }),
    'some_future_counter',
    {}
  );
  assert.equal(logs[0].level, 'INFO');
  assert.equal(logs[0].event, 'lifecycle.some_future_counter');
});

test('recordLifecycleDiagnostic count is monotonic across repeated calls', () => {
  const logs = [];
  const emitLog = (level, event, details) => logs.push({ level, event, details });
  recordLifecycleDiagnostic(emitLog, 'lease_conflict', {});
  recordLifecycleDiagnostic(emitLog, 'lease_conflict', {});
  recordLifecycleDiagnostic(emitLog, 'lease_conflict', {});

  assert.deepEqual(getLifecycleDiagnosticCounts(), { lease_conflict: 3 });
  assert.deepEqual(logs.map((entry) => entry.details.count), [1, 2, 3]);
});

test('recordLifecycleDiagnostic tracks independent counters separately', () => {
  const emitLog = () => {};
  recordLifecycleDiagnostic(emitLog, 'lease_conflict', {});
  recordLifecycleDiagnostic(emitLog, 'durability_degrade', {});
  recordLifecycleDiagnostic(emitLog, 'durability_degrade', {});

  assert.deepEqual(getLifecycleDiagnosticCounts(), {
    lease_conflict: 1,
    durability_degrade: 2,
  });
});

test('resetLifecycleDiagnosticCounts clears every counter', () => {
  recordLifecycleDiagnostic(() => {}, 'lease_conflict', {});
  resetLifecycleDiagnosticCounts();
  assert.deepEqual(getLifecycleDiagnosticCounts(), {});
});

test('recordLifecycleDiagnostic still increments the counter when no emitLog is supplied', () => {
  recordLifecycleDiagnostic(undefined, 'lease_conflict', {});
  assert.deepEqual(getLifecycleDiagnosticCounts(), { lease_conflict: 1 });
});

test('recordLifecycleDiagnostic never throws when emitLog itself throws', () => {
  assert.doesNotThrow(() => {
    recordLifecycleDiagnostic(
      () => {
        throw new Error('logger exploded');
      },
      'durability_degrade',
      {}
    );
  });
  assert.deepEqual(getLifecycleDiagnosticCounts(), { durability_degrade: 1 });
});

test('recordLifecycleDiagnostic ignores an empty/blank counter name', () => {
  recordLifecycleDiagnostic(() => {}, '', {});
  recordLifecycleDiagnostic(() => {}, '   ', {});
  assert.deepEqual(getLifecycleDiagnosticCounts(), {});
});
