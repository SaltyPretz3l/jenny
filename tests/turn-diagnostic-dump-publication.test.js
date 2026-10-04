const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { dumpTurnDiagnostic, mergeClientTimingIntoTurnDiagnostic } = require('../services/backend/turn-diagnostic-dump');

function makeService(t) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-publication-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  return { options: { userDataPath }, _emitServiceLog() {} };
}

test('one dump publication includes client timing received during atomic rename', async (t) => {
  const service = makeService(t);
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const originalRename = fs.promises.rename;
  let renames = 0;
  t.after(() => { release(); fs.promises.rename = originalRename; });
  fs.promises.rename = async (...args) => {
    renames += 1;
    if (renames === 1) { entered(); await gate; }
    return originalRename.call(fs.promises, ...args);
  };
  const publishing = dumpTurnDiagnostic({ service, streamId: 'one_publication' });
  await started;
  await mergeClientTimingIntoTurnDiagnostic({
    service, streamId: 'one_publication', clientTiming: { deltas_received: 3 }, attempts: 1, delayMs: 0,
  });
  release();
  const filePath = await publishing;
  const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(payload.client_timing?.deltas_received, 3);
  assert.deepEqual(fs.readdirSync(path.dirname(filePath)), ['one_publication.json']);
});

for (const late of [false, true]) {
  test(`client timing folds secret reason keys into other on ${late ? 'late merge' : 'initial publication'}`, async (t) => {
    const service = makeService(t);
    const secret = 'token=sk-test-SYNTHETIC123';
    const clientTiming = {};
    for (const field of ['full_render_reasons', 'reasoning_body_fallback_reasons', 'row_list_morph_reasons']) {
      clientTiming[field] = { [secret]: 3, other: 2 };
    }
    const filePath = await dumpTurnDiagnostic({
      service, streamId: 'secret_reasons', clientTiming: late ? null : clientTiming,
    });
    if (late) await mergeClientTimingIntoTurnDiagnostic({
      service, streamId: 'secret_reasons', clientTiming, attempts: 1, delayMs: 0,
    });
    const serialized = fs.readFileSync(filePath, 'utf8');
    assert.equal(serialized.includes(secret), false);
    const payload = JSON.parse(serialized);
    for (const field of Object.keys(clientTiming)) {
      assert.deepEqual(payload.client_timing[field], { other: 5 });
    }
  });
}

test('an early renderer report does not hold up the dump it waits for', async (t) => {
  const service = makeService(t);
  const startedAt = Date.now();
  // Default arguments: the report arrives before any dump exists.
  assert.equal(await mergeClientTimingIntoTurnDiagnostic({
    service, streamId: 'early_report', clientTiming: { deltas_received: 2 },
  }), null);
  assert.ok(Date.now() - startedAt < 500, 'the early report returns without polling for the dump');
  const filePath = await dumpTurnDiagnostic({ service, streamId: 'early_report' });
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).client_timing?.deltas_received, 2);
});

test('a failed late merge leaves the published dump reported as published', async (t) => {
  const events = [];
  const service = { ...makeService(t), _emitServiceLog(level, event) { events.push(`${level}:${event}`); } };
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const originalRename = fs.promises.rename;
  let renames = 0;
  t.after(() => { release(); fs.promises.rename = originalRename; });
  fs.promises.rename = async (...args) => {
    renames += 1;
    if (renames === 1) { entered(); await gate; return originalRename.call(fs.promises, ...args); }
    throw new Error('late merge write failed');
  };
  const publishing = dumpTurnDiagnostic({ service, streamId: 'late_failure' });
  await started;
  await mergeClientTimingIntoTurnDiagnostic({ service, streamId: 'late_failure', clientTiming: { deltas_received: 4 } });
  release();
  const filePath = await publishing;
  assert.ok(filePath);
  assert.ok(events.includes('INFO:chat.turn_diagnostic_dumped'));
  assert.ok(events.includes('WARN:chat.turn_diagnostic_client_timing_merge_failed'));
  assert.equal(events.includes('WARN:chat.turn_diagnostic_dump_failed'), false);
});
