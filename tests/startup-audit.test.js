'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createStartupAudit } = require('../services/main/startup-audit');

// ---------------------------------------------------------------------------
// DISABLED mode (no env flag)
// ---------------------------------------------------------------------------

test('disabled: enabled===false when JENNY_COLD_START_AUDIT is absent', (t) => {
  const audit = createStartupAudit({ env: {} });
  assert.equal(audit.enabled, false);
});

test('disabled: getStartupAuditConfig returns { enabled:false }', (t) => {
  const audit = createStartupAudit({ env: {} });
  assert.deepEqual(audit.getStartupAuditConfig(), { enabled: false });
});

test('disabled: emitStartupAuditMark is a no-op (nothing logged)', (t) => {
  const logs = [];
  const log = (...a) => logs.push(a);
  const audit = createStartupAudit({ env: {}, log });
  audit.emitStartupAuditMark('boot', { x: 1 });
  assert.equal(logs.length, 0);
});

test('disabled: handleStartupAuditMarkPayload returns { ok:false, ignored:true }', (t) => {
  const audit = createStartupAudit({ env: {} });
  const result = audit.handleStartupAuditMarkPayload({ mark: 'm' });
  assert.deepEqual(result, { ok: false, ignored: true });
});

// ---------------------------------------------------------------------------
// ENABLED mode
// ---------------------------------------------------------------------------

function makeEnabledAudit(logs) {
  return createStartupAudit({
    env: {
      JENNY_COLD_START_AUDIT: '1',
      JENNY_COLD_START_AUDIT_RUN_ID: 'rid',
      JENNY_COLD_START_AUDIT_MODEL: 'gemma',
    },
    log: (...a) => logs.push(a),
    getStartupElapsedMs: () => 123,
  });
}

test('enabled: enabled===true', (t) => {
  const logs = [];
  const audit = makeEnabledAudit(logs);
  assert.equal(audit.enabled, true);
});

test('enabled: getStartupAuditConfig returns full config with each field', (t) => {
  const logs = [];
  const audit = makeEnabledAudit(logs);
  const cfg = audit.getStartupAuditConfig();
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.runId, 'rid');
  assert.equal(cfg.model, 'gemma');
  assert.equal(cfg.prompt, '');
  assert.equal(cfg.reasoningEffort, 'high');
});

test('enabled: emitStartupAuditMark logs one entry with correct shape', (t) => {
  const logs = [];
  const audit = makeEnabledAudit(logs);
  audit.emitStartupAuditMark('boot', { foo: 'bar' });
  assert.equal(logs.length, 1);
  const entry = logs[0];
  // level
  assert.equal(entry[0], 'INFO');
  // channel
  assert.equal(entry[1], 'startup.audit.mark');
  // payload fields
  assert.equal(entry[2].mark, 'boot');
  assert.equal(entry[2].foo, 'bar');
  assert.equal(entry[2].audit_run_id, 'rid');
  // startupMs comes from injected getStartupElapsedMs (details.startupMs was absent)
  assert.equal(entry[2].startupMs, 123);
});

test('enabled: handleStartupAuditMarkPayload returns { ok:true } for valid payload', (t) => {
  const logs = [];
  const audit = makeEnabledAudit(logs);
  const result = audit.handleStartupAuditMarkPayload({ name: 'm2' });
  assert.deepEqual(result, { ok: true });
});

test('enabled: handleStartupAuditMarkPayload sets source===renderer when not supplied', (t) => {
  const logs = [];
  const audit = makeEnabledAudit(logs);
  audit.handleStartupAuditMarkPayload({ name: 'm2' });
  assert.equal(logs.length, 1);
  assert.equal(logs[0][2].source, 'renderer');
});

// ---------------------------------------------------------------------------
// Batch handler
// ---------------------------------------------------------------------------

function makeBatchAudit() {
  const logs = [];
  const audit = createStartupAudit({
    env: {
      JENNY_COLD_START_AUDIT: '1',
      JENNY_COLD_START_AUDIT_RUN_ID: 'batch-run',
    },
    log: (...a) => logs.push(a),
    getStartupElapsedMs: () => 0,
  });
  return { audit, logs };
}

test('batch: 3-element array with 2 valid marks -> count===2, ok===true', (t) => {
  const { audit } = makeBatchAudit();
  const handler = audit.createStartupAuditMarksBatchHandler();
  // second entry has empty mark and no name -> ignored
  const result = handler(null, { marks: [{ mark: 'a' }, { mark: '' }, { name: 'c' }] });
  assert.equal(result.count, 2);
  assert.equal(result.ok, true);
});

test('batch: 250-element array is capped at 200 count with ignored_count>=50', (t) => {
  const { audit } = makeBatchAudit();
  const handler = audit.createStartupAuditMarksBatchHandler();
  const marks = Array.from({ length: 250 }, (_, i) => ({ mark: `m${i}` }));
  const result = handler(null, { marks });
  assert.equal(result.count, 200);
  assert.ok(
    result.ignored_count >= 50,
    `expected ignored_count >= 50 but got ${result.ignored_count}`,
  );
});

// ---------------------------------------------------------------------------
// emitMainEntryMark — launcher-to-main attribution
// ---------------------------------------------------------------------------

test('emitMainEntryMark: emits main-entry with module load cost and launcher attribution', (t) => {
  const logs = [];
  const audit = createStartupAudit({
    env: {
      JENNY_COLD_START_AUDIT: '1',
      JENNY_LAUNCHER_STARTED_AT_MS: '1000',
      JENNY_LAUNCH_PATH: 'dev',
    },
    log: (...a) => logs.push(a),
    getStartupElapsedMs: () => 5,
  });
  audit.emitMainEntryMark({ mainModuleEntryAt: 1500, appStartupStartedAt: 1900 });
  assert.equal(logs.length, 1);
  const [, event, details] = logs[0];
  assert.equal(event, 'startup.audit.mark');
  assert.equal(details.mark, 'main-entry');
  assert.equal(details.ts_ms, 1500);
  assert.equal(details.module_load_ms, 400);
  assert.equal(details.launcher_to_main_ms, 500);
  assert.equal(details.launch_path, 'dev');
});

test('emitMainEntryMark: omits launcher fields when the launcher exported nothing', (t) => {
  const logs = [];
  const audit = createStartupAudit({
    env: { JENNY_COLD_START_AUDIT: '1' },
    log: (...a) => logs.push(a),
    getStartupElapsedMs: () => 5,
  });
  audit.emitMainEntryMark({ mainModuleEntryAt: 1500, appStartupStartedAt: 1900 });
  assert.equal(logs.length, 1);
  const details = logs[0][2];
  assert.equal(details.module_load_ms, 400);
  assert.equal('launcher_to_main_ms' in details, false);
  assert.equal('launch_path' in details, false);
});

test('emitMainEntryMark: no-op when the audit is disabled', (t) => {
  const logs = [];
  const audit = createStartupAudit({
    env: { JENNY_LAUNCHER_STARTED_AT_MS: '1000', JENNY_LAUNCH_PATH: 'dev' },
    log: (...a) => logs.push(a),
  });
  audit.emitMainEntryMark({ mainModuleEntryAt: 1500, appStartupStartedAt: 1900 });
  assert.equal(logs.length, 0);
});

test('early main marks retain their captured timestamps until logging is ready', () => {
  const logs = [];
  let logReady = false;
  const audit = createStartupAudit({
    env: { JENNY_COLD_START_AUDIT: '1' },
    log: (...args) => logs.push(args),
    canLog: () => logReady,
    getStartupElapsedMs: () => 99,
  });

  audit.emitStartupAuditMark('electron-ready', { source: 'main', ts_ms: 1234 });
  audit.emitStartupAuditMark('main-sync-init-start', { source: 'main', ts_ms: 1250 });
  assert.deepEqual(logs, []);

  logReady = true;
  audit.emitStartupAuditMark('app-ready', { source: 'main', ts_ms: 1400 });
  assert.deepEqual(logs.map((entry) => entry[2].mark), [
    'electron-ready',
    'main-sync-init-start',
    'app-ready',
  ]);
  assert.deepEqual(logs.map((entry) => entry[2].ts_ms), [1234, 1250, 1400]);
});

// ---------------------------------------------------------------------------
// F1: buffered marks flush in chronological (ts_ms) order, not push order
// ---------------------------------------------------------------------------

test('buffered marks flush in chronological order even when pushed out of order', () => {
  const logs = [];
  let logReady = false;
  const audit = createStartupAudit({
    env: { JENNY_COLD_START_AUDIT: '1' },
    log: (...args) => logs.push(args),
    canLog: () => logReady,
    getStartupElapsedMs: () => 0,
  });

  // Mirrors the real bug: 'electron-ready' is pushed first with a later
  // Date.now()-derived timestamp, then 'main-entry' is pushed second but
  // carries an earlier, previously-captured timestamp.
  audit.emitStartupAuditMark('electron-ready', { source: 'main', ts_ms: 5000 });
  audit.emitStartupAuditMark('main-entry', { source: 'main', ts_ms: 1000 });
  audit.emitStartupAuditMark('main-sync-init-start', { source: 'main', ts_ms: 3000 });
  assert.deepEqual(logs, []);

  logReady = true;
  audit.emitStartupAuditMark('app-ready', { source: 'main', ts_ms: 6000 });

  assert.deepEqual(logs.map((entry) => entry[2].mark), [
    'main-entry',
    'main-sync-init-start',
    'electron-ready',
    'app-ready',
  ]);
  assert.deepEqual(logs.map((entry) => entry[2].ts_ms), [1000, 3000, 5000, 6000]);
});

// ---------------------------------------------------------------------------
// F2: pendingMarks is capped, and drops are counted rather than unbounded
// ---------------------------------------------------------------------------

test('pendingMarks is capped and reports a single dropped-marks warning on flush', () => {
  const logs = [];
  let logReady = false;
  const audit = createStartupAudit({
    env: { JENNY_COLD_START_AUDIT: '1' },
    log: (...args) => logs.push(args),
    canLog: () => logReady,
    getStartupElapsedMs: () => 0,
  });

  // Push well past any reasonable cap while logging is not ready.
  for (let i = 0; i < 50; i += 1) {
    audit.emitStartupAuditMark(`mark-${i}`, { source: 'main', ts_ms: i });
  }
  assert.deepEqual(logs, []);

  logReady = true;
  audit.emitStartupAuditMark('app-ready', { source: 'main', ts_ms: 1000 });

  const marksLogged = logs.filter((entry) => entry[2].mark && entry[2].mark !== undefined && entry[1] === 'startup.audit.mark');
  // Buffer must not have grown to hold all 50 pending marks.
  assert.ok(marksLogged.length < 51, `expected the pending buffer to be capped, but flushed ${marksLogged.length} marks`);
  const dropWarning = logs.find((entry) => entry[1] === 'startup.audit.marks_dropped');
  assert.ok(dropWarning, 'expected a warning about dropped pending marks');
  assert.equal(dropWarning[0], 'WARN');
  assert.ok(dropWarning[2].count > 0, 'expected a positive dropped-mark count');
});

// ---------------------------------------------------------------------------
// F3: flushStartupAuditMarks() forces an early flush without waiting on the
// next mark
// ---------------------------------------------------------------------------

test('flushStartupAuditMarks flushes buffered marks once logging becomes ready, with no further mark required', () => {
  const logs = [];
  let logReady = false;
  const audit = createStartupAudit({
    env: { JENNY_COLD_START_AUDIT: '1' },
    log: (...args) => logs.push(args),
    canLog: () => logReady,
    getStartupElapsedMs: () => 0,
  });

  audit.emitStartupAuditMark('electron-ready', { source: 'main', ts_ms: 100 });
  audit.emitStartupAuditMark('main-entry', { source: 'main', ts_ms: 50 });
  assert.deepEqual(logs, []);

  logReady = true;
  audit.flushStartupAuditMarks();

  assert.deepEqual(logs.map((entry) => entry[2].mark), ['main-entry', 'electron-ready']);
});

test('flushStartupAuditMarks is a no-op while logging is still not ready', () => {
  const logs = [];
  const audit = createStartupAudit({
    env: { JENNY_COLD_START_AUDIT: '1' },
    log: (...args) => logs.push(args),
    canLog: () => false,
    getStartupElapsedMs: () => 0,
  });

  audit.emitStartupAuditMark('electron-ready', { source: 'main', ts_ms: 100 });
  audit.flushStartupAuditMarks();

  assert.deepEqual(logs, []);
});

test('a logger failure is swallowed and does not wedge later marks', () => {
  // Startup marks are emitted from lifecycle handlers (app.whenReady, window
  // lifecycle, the renderer IPC batch handler). A logger failure there would
  // otherwise escape into the handler and bypass its structured failure path.
  const logged = [];
  let failNextLog = true;
  let logReady = false;
  const audit = createStartupAudit({
    env: { JENNY_COLD_START_AUDIT: '1' },
    log: (_level, _event, payload) => {
      if (failNextLog) {
        failNextLog = false;
        throw new Error('log store exploded');
      }
      logged.push(payload.mark);
    },
    canLog: () => logReady,
    getStartupElapsedMs: () => 0,
  });

  audit.emitStartupAuditMark('electron-ready', { source: 'main', ts_ms: 100 });
  assert.deepEqual(logged, [], 'buffered while logging is not ready');

  // The flush drains the buffer and then hits the throwing logger.
  logReady = true;
  audit.flushStartupAuditMarks();
  assert.deepEqual(logged, [], 'the failed log recorded nothing');

  // The real assertions: the emitter survived the failure and still works, and
  // the drained buffer is not replayed (no duplicate 'electron-ready').
  audit.emitStartupAuditMark('app-ready', { source: 'main' });
  assert.deepEqual(logged, ['app-ready']);
});
