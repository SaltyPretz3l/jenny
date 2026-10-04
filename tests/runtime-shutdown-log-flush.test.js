const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRuntimeShutdownController } = require('../services/main/runtime-shutdown');
const { ProcessLogWriter } = require('../services/process-log-writer');

function controllerFor(writer, log) {
  return createRuntimeShutdownController({
    app: { getPath: () => '' }, clearSuggestionCache() {},
    getBackendService: () => ({ async stop() {} }),
    getProcessLogWriter: () => writer,
    llamaServerManager: { async stop() {}, stopSync() {} },
    shutdownManagedSidecarSyncImpl: () => ({ hadState: false }),
    shutdownLlamaServerSyncImpl: () => ({ hadState: false }),
    shutdownAnyLocalOllamaSyncImpl: () => ({ skipped: 'no_owned_state' }),
    log,
  });
}

for (const outcome of [
  { flushed: false, timedOutCount: 2 },
  { flushed: false, timedOutCount: 0 },
]) {
  test(`shutdown does not confirm incomplete flush ${JSON.stringify(outcome)}`, async () => {
    const logs = [];
    await controllerFor({ async flush() { return outcome; } },
      (level, event, fields) => logs.push({ level, event, fields })).stopRuntimeBeforeQuit();
    const stage = logs.find(({ fields }) => fields.stage === 'process_log_flush');
    assert.equal(stage.fields.confirmed, false);
    assert.equal(stage.fields.status, 'bounded');
    assert.equal(stage.level, 'WARN');
  });
}

test('a completed drain is confirmed even when the writer timed out earlier in the process', async () => {
  const logs = [];
  // timedOutCount is the writer's lifetime total, not this drain's.
  await controllerFor({ async flush() { return { flushed: true, timedOutCount: 2 }; } },
    (level, event, fields) => logs.push({ level, event, fields })).stopRuntimeBeforeQuit();
  const stage = logs.find(({ fields }) => fields.stage === 'process_log_flush');
  assert.equal(stage.fields.confirmed, true);
  assert.equal(stage.fields.status, 'ok');
});

test('shutdown final lifecycle records are drained or explicitly reported as not flushed', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shutdown-log-drain-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'electron.log');
  const writer = new ProcessLogWriter({ stream: null, filePath, drainDelayMs: 60_000 });
  const records = [];
  let persistedAtFlush;
  let flushCalls = 0;
  const controller = controllerFor({ async flush(options) {
    flushCalls += 1;
    const result = await writer.flush(options);
    persistedAtFlush = fs.readFileSync(filePath, 'utf8');
    return result;
  } }, (level, event, fields) => {
    const record = { level, event, data: fields };
    records.push(record);
    writer.write(record);
  });
  await controller.stopRuntimeBeforeQuit();
  // The confirmed drain, then a best-effort drain for the outcome records.
  assert.equal(flushCalls, 2);
  const persisted = fs.readFileSync(filePath, 'utf8');
  for (const stage of ['process_log_flush', 'total']) {
    assert.ok(persisted.includes(`"stage":"${stage}"`), `${stage} outcome record reaches the file`);
  }
  for (const record of records.filter(({ data }) => ['process_log_flush', 'total'].includes(data.stage))) {
    assert.ok(persistedAtFlush.includes(JSON.stringify(record)) || record.data.recordFlushed === false,
      `${record.data.stage} must be persisted by the last flush or report recordFlushed=false`);
  }
  // Clean up any explicitly unflushed outcome records after checking shutdown.
  await writer.flush();
});

test('a real writer that lost its file sink never confirms the shutdown flush', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shutdown-enospc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const enospc = () => Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
  const fsImpl = {
    ...fs,
    promises: { ...fs.promises, appendFile: async () => { throw enospc(); } },
    appendFile: (_file, _data, _encoding, callback) => callback(enospc()),
    appendFileSync: () => { throw enospc(); },
  };
  const writer = new ProcessLogWriter({ stream: null, filePath: path.join(dir, 'shell.log'), fsImpl, drainDelayMs: 0 });
  const logs = [];
  const log = (level, event, fields) => {
    logs.push({ level, event, fields });
    writer.write({ level, event, ...fields });
  };
  log('INFO', 'app.ready', { message: 'ready' });
  await controllerFor(writer, log).stopRuntimeBeforeQuit();
  const stage = logs.find(({ fields }) => fields.stage === 'process_log_flush');
  assert.equal(stage.fields.status, 'failed');
  assert.equal(stage.fields.confirmed, false);
  assert.equal(logs.find(({ fields }) => fields.stage === 'total').fields.status, 'bounded');
});
