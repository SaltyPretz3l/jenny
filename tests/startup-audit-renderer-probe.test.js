const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const PROBE_PATH = path.resolve(__dirname, '../renderer/shared/startup-audit-renderer-probe.js');

async function flushMicrotasks(count = 4) {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

function loadProbe({ diagnostics = {}, phase = 'mark' } = {}) {
  const previousDocument = global.document;
  const previousJennyShell = global.jennyShell;
  const previousAudit = global.__jennyStartupAudit;
  const previousPerformance = global.performance;

  global.document = {
    currentScript: { dataset: { startupAuditPhase: phase } },
    readyState: 'loading',
    scripts: [],
  };
  global.jennyShell = { diagnostics };
  global.__jennyStartupAudit = undefined;
  global.performance = {
    now: () => 12.5,
    timeOrigin: 1000,
    mark() {},
  };
  delete require.cache[PROBE_PATH];
  require(PROBE_PATH);

  return {
    audit: global.__jennyStartupAudit,
    cleanup() {
      delete require.cache[PROBE_PATH];
      global.document = previousDocument;
      global.jennyShell = previousJennyShell;
      global.__jennyStartupAudit = previousAudit;
      global.performance = previousPerformance;
    },
  };
}

test('startup audit probe flushes pending marks through the batch bridge when available', async () => {
  const batches = [];
  const singles = [];
  const harness = loadProbe({
    diagnostics: {
      reportStartupMarksBatch(payload) {
        batches.push(payload);
        return Promise.resolve({ ok: true, count: payload.marks.length });
      },
      reportStartupMark(payload) {
        singles.push(payload);
        return Promise.resolve({ ok: true });
      },
    },
  });

  try {
    harness.audit.mark('renderer-bootstrap-started');
    harness.audit.mark('renderer-bootstrap-complete');
    harness.audit.enable({ enabled: true, runId: 'audit-run-a' });
    await flushMicrotasks();

    assert.equal(singles.length, 0);
    assert.equal(batches.length, 1);
    assert.deepEqual(
      batches[0].marks.map((entry) => ({ mark: entry.mark, runId: entry.runId })),
      [
        { mark: 'renderer-bootstrap-started', runId: 'audit-run-a' },
        { mark: 'renderer-bootstrap-complete', runId: 'audit-run-a' },
      ]
    );
  } finally {
    harness.cleanup();
  }
});

test('startup audit probe falls back to single-mark bridge when batch bridge is unavailable', async () => {
  const singles = [];
  const harness = loadProbe({
    diagnostics: {
      reportStartupMark(payload) {
        singles.push(payload);
        return Promise.resolve({ ok: true });
      },
    },
  });

  try {
    harness.audit.mark('renderer-ready');
    harness.audit.enable({ enabled: true, runId: 'audit-run-b' });
    await flushMicrotasks();

    assert.deepEqual(
      singles.map((entry) => ({ mark: entry.mark, runId: entry.runId })),
      [{ mark: 'renderer-ready', runId: 'audit-run-b' }]
    );
  } finally {
    harness.cleanup();
  }
});

test('startup audit probe falls back to single marks when batch bridge rejects', async () => {
  const singles = [];
  const harness = loadProbe({
    diagnostics: {
      reportStartupMarksBatch() {
        return Promise.reject(new Error('batch channel unavailable'));
      },
      reportStartupMark(payload) {
        singles.push(payload);
        return Promise.resolve({ ok: true });
      },
    },
  });

  try {
    harness.audit.mark('renderer-ready');
    harness.audit.enable({ enabled: true, runId: 'audit-run-c' });
    await flushMicrotasks();

    assert.deepEqual(
      singles.map((entry) => ({ mark: entry.mark, runId: entry.runId })),
      [{ mark: 'renderer-ready', runId: 'audit-run-c' }]
    );
  } finally {
    harness.cleanup();
  }
});

test('startup audit probe serializes batches and flushes marks queued during delivery', async () => {
  const calls = [];
  const harness = loadProbe({
    diagnostics: {
      reportStartupMarksBatch(payload) {
        let resolve;
        const promise = new Promise((settle) => { resolve = settle; });
        calls.push({ marks: payload.marks.map((entry) => entry.mark), resolve });
        return promise;
      },
    },
  });

  try {
    harness.audit.enable({ enabled: true });
    harness.audit.mark('A');
    await flushMicrotasks();
    harness.audit.mark('B');
    await flushMicrotasks();

    assert.equal(calls.length, 1, 'only one startup-mark batch may be in flight');
    assert.deepEqual(calls[0].marks, ['A']);

    calls[0].resolve({ ok: true });
    await flushMicrotasks(8);
    assert.equal(calls.length, 2, 'settlement schedules the marks queued behind the first batch');
    assert.deepEqual(calls[1].marks, ['B']);
    calls[1].resolve({ ok: true });
    await flushMicrotasks();
  } finally {
    harness.cleanup();
  }
});
