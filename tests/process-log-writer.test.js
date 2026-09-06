const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { ProcessLogWriter, isBenignWriteError } = require('../services/process-log-writer');

test('default rotation threshold is 2 MiB', () => {
  const writer = new ProcessLogWriter({ stream: { write() { return true; } } });
  assert.equal(writer.maxBytes, 2 * 1_048_576);
});

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'process-log-writer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeFsDouble({ appendFile, appendFileSync, statSize = 0 } = {}) {
  return {
    mkdirSync() {},
    statSync() { return { size: statSize }; },
    appendFile,
    appendFileSync: appendFileSync || (() => {}),
    renameSync() {},
    unlinkSync() {},
  };
}

test('write delegates to ordered writeBatch and produces one stream write', () => {
  const writes = [];
  const writer = new ProcessLogWriter({ stream: { write: (chunk) => writes.push(chunk) } });

  assert.equal(writer.write({ level: 'INFO', event: 'first' }), true);
  assert.equal(writer.writeBatch([
    { level: 'INFO', event: 'second' },
    { level: 'WARN', event: 'third' },
  ]), true);

  assert.equal(writes.length, 2);
  assert.match(writes[0], /"event":"first"/);
  assert.ok(writes[1].indexOf('second') < writes[1].indexOf('third'));
});

test('writeBatch coalesces one renderer batch into one file append', async () => {
  const appends = [];
  const writer = new ProcessLogWriter({
    stream: { write() { return true; } },
    filePath: 'G:\\logs\\shell.log',
    fsImpl: makeFsDouble({ appendFile(_path, payload, _encoding, done) { appends.push(payload); done(); } }),
  });

  writer.writeBatch([
    { level: 'INFO', event: 'first' },
    { level: 'WARN', event: 'second' },
  ]);
  const result = await writer.flush();

  assert.equal(result.flushed, true);
  assert.equal(result.flushedCount, 2);
  assert.equal(appends.length, 1);
  assert.ok(appends[0].indexOf('first') < appends[0].indexOf('second'));
});

test('stream failures disable only that sink and never escape', () => {
  const warnings = [];
  const writer = new ProcessLogWriter({
    stream: { write() { const error = new Error('permission denied'); error.code = 'EPERM'; throw error; } },
    logger: (...args) => warnings.push(args),
  });

  assert.doesNotThrow(() => writer.write({ level: 'ERROR', event: 'chat.stream' }));
  assert.equal(writer.disabled, true);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][2].sink, 'stream');
});

test('benign write error detection matches broken pipe messages without codes', () => {
  assert.equal(isBenignWriteError(new Error('EPIPE: broken pipe, write')), true);
  assert.equal(isBenignWriteError(new Error('broken pipe')), true);
});

test('stream error events disable the stream sink once', () => {
  class FakeStream extends EventEmitter { write() { return true; } }
  const stream = new FakeStream();
  const writer = new ProcessLogWriter({ stream });
  const error = new Error('broken pipe');
  error.code = 'EPIPE';

  stream.emit('error', error);
  stream.emit('error', error);

  assert.equal(writer.disabled, true);
  assert.equal(writer.write({ level: 'INFO', event: 'delta' }), false);
});

test('non-durable writes drain asynchronously and flush persists ordered JSONL', async (t) => {
  const filePath = path.join(makeTempDir(t), 'nested', 'shell.log');
  const writer = new ProcessLogWriter({ stream: { write() { return true; } }, filePath });

  writer.write({ level: 'INFO', event: 'app.ready' });
  writer.write({ level: 'WARN', event: 'sidecar.slow' });
  assert.equal(fs.existsSync(filePath), false);
  await writer.flush();

  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map((entry) => entry.event), ['app.ready', 'sidecar.slow']);
});

test('rotation remains ordered across asynchronous drains', async (t) => {
  const filePath = path.join(makeTempDir(t), 'shell.log');
  const writer = new ProcessLogWriter({
    stream: { write() { return true; } }, filePath, maxBytes: 80, maxFiles: 2,
  });

  for (let i = 0; i < 5; i += 1) {
    writer.write({ level: 'INFO', event: 'tick', details: { i, payload: 'x'.repeat(20) } });
    await writer.flush();
  }

  assert.equal(fs.existsSync(filePath), true);
  assert.equal(fs.existsSync(`${filePath}.1`), true);
  assert.equal(fs.existsSync(`${filePath}.3`), false);
});

test('file persistence continues when stdout is disabled', async (t) => {
  const filePath = path.join(makeTempDir(t), 'shell.log');
  const writer = new ProcessLogWriter({
    stream: { write() { const error = new Error('broken pipe'); error.code = 'EPIPE'; throw error; } },
    filePath,
  });

  assert.equal(writer.write({ level: 'INFO', event: 'app.ready' }), true);
  await writer.flush();

  assert.equal(writer.disabled, true);
  assert.equal(writer.fileDisabled, false);
  assert.match(fs.readFileSync(filePath, 'utf8'), /app\.ready/);
});

test('stdout continues when file initialization fails', () => {
  const writes = [];
  const writer = new ProcessLogWriter({
    stream: { write(chunk) { writes.push(chunk); } },
    filePath: '/tmp/shell.log',
    fsImpl: { mkdirSync() { throw new Error('readonly fs'); } },
  });

  assert.equal(writer.write({ level: 'INFO', event: 'app.ready' }), true);
  assert.equal(writer.fileDisabled, true);
  assert.equal(writes.length, 1);
});

test('async file append failure disables only the file sink and warns once', async () => {
  const events = [];
  const error = new Error('file is locked');
  error.code = 'EBUSY';
  const writer = new ProcessLogWriter({
    stream: { write() { return true; } },
    filePath: 'G:\\logs\\shell.log',
    logger: (...args) => events.push(args),
    fsImpl: makeFsDouble({ appendFile(_path, _payload, _encoding, done) { done(error); } }),
  });

  writer.write({ level: 'INFO', event: 'first' });
  await writer.flush();
  writer.write({ level: 'INFO', event: 'second' });
  await writer.flush();

  assert.equal(writer.fileDisabled, true);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].slice(0, 2), ['WARN', 'logs.process_log_writer_disabled']);
  assert.equal(events[0][2].sink, 'file');
  assert.equal(events[0][2].code, 'EBUSY');
});

test('queue evicts DEBUG before INFO and reports bounded loss metadata', async () => {
  const reports = [];
  const payloads = [];
  const writer = new ProcessLogWriter({
    stream: null,
    filePath: 'G:\\logs\\shell.log',
    maxPendingEntries: 3,
    severeReserve: 1,
    maxPendingBytes: 10_000,
    drainDelayMs: 60_000,
    logger: (level, event, details) => reports.push({ level, event, details }),
    fsImpl: makeFsDouble({ appendFile(_path, payload, _encoding, done) { payloads.push(payload); done(); } }),
  });

  writer.write({ level: 'DEBUG', event: 'debug' });
  writer.write({ level: 'INFO', event: 'info-1' });
  writer.write({ level: 'INFO', event: 'info-2' });
  await writer.flush();

  assert.equal(payloads.some((payload) => payload.includes('debug')), false);
  assert.equal(payloads.some((payload) => payload.includes('info-1')), true);
  const drop = reports.find((entry) => entry.event === 'logs.process_log_queue_dropped');
  assert.equal(drop.details.droppedByLevel.DEBUG, 1);
  assert.equal(drop.details.capacityEntries, 3);
});

test('WARN and ERROR consume reserved capacity and severe-only saturation uses sync fallback', async () => {
  const syncPayloads = [];
  const writer = new ProcessLogWriter({
    stream: null,
    filePath: 'G:\\logs\\shell.log',
    maxPendingEntries: 2,
    severeReserve: 1,
    maxPendingBytes: 10_000,
    drainDelayMs: 60_000,
    fsImpl: makeFsDouble({
      appendFile(_path, _payload, _encoding, done) { done(); },
      appendFileSync(_path, payload) { syncPayloads.push(payload); },
    }),
  });

  writer.write({ level: 'WARN', event: 'warn-1' });
  writer.write({ level: 'ERROR', event: 'error-1' });
  writer.write({ level: 'ERROR', event: 'error-2' });
  const result = await writer.flush();

  assert.equal(result.droppedByLevel.WARN, 0);
  assert.equal(result.droppedByLevel.ERROR, 0);
  assert.equal(result.severeFallbackCount, 3);
  assert.equal(syncPayloads.length, 1);
  assert.ok(syncPayloads[0].indexOf('warn-1') < syncPayloads[0].indexOf('error-2'));
});

test('severe fallback stays behind an in-flight asynchronous append', async () => {
  const asyncPayloads = [];
  const callbacks = [];
  const syncPayloads = [];
  const writer = new ProcessLogWriter({
    stream: null,
    filePath: 'G:\\logs\\shell.log',
    maxPendingEntries: 1,
    severeReserve: 1,
    maxPendingBytes: 10_000,
    drainDelayMs: 0,
    fsImpl: makeFsDouble({
      appendFile(_path, payload, _encoding, done) {
        asyncPayloads.push(payload);
        callbacks.push(done);
      },
      appendFileSync(_path, payload) { syncPayloads.push(payload); },
    }),
  });

  writer.write({ level: 'WARN', event: 'warn-in-flight' });
  writer._drainPending();
  await new Promise((resolve) => setImmediate(resolve));
  writer.write({ level: 'ERROR', event: 'error-pending' });
  writer.write({ level: 'ERROR', event: 'error-fallback' });

  assert.equal(asyncPayloads.length, 1);
  assert.equal(syncPayloads.length, 0, 'sync fallback must not overtake an active append');
  callbacks.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(asyncPayloads.length, 2);
  callbacks.shift()();
  await writer.flush();

  const events = asyncPayloads.join('').trim().split('\n').map(JSON.parse).map((entry) => entry.event);
  assert.deepEqual(events, ['warn-in-flight', 'error-pending', 'error-fallback']);
});

test('entry and byte caps drop low-priority input without exceeding bounds', async () => {
  const writer = new ProcessLogWriter({
    stream: null,
    filePath: 'G:\\logs\\shell.log',
    maxPendingEntries: 2,
    severeReserve: 0,
    maxPendingBytes: 90,
    drainDelayMs: 60_000,
    fsImpl: makeFsDouble({ appendFile(_path, _payload, _encoding, done) { done(); } }),
  });

  for (let i = 0; i < 10; i += 1) writer.write({ level: 'DEBUG', event: `debug-${i}` });
  assert.ok(writer.pending.length <= 2);
  assert.ok(writer.pendingBytes <= 90);
  const result = await writer.flush();
  assert.ok(result.droppedByLevel.DEBUG >= 8);
});

test('flush returns bounded timeout counts without rejecting', async () => {
  const writer = new ProcessLogWriter({
    stream: null,
    filePath: 'G:\\logs\\shell.log',
    fsImpl: makeFsDouble({ appendFile() { /* deliberately never settles */ } }),
  });
  writer.write({ level: 'INFO', event: 'stalled' });

  const result = await writer.flush({ timeoutMs: 10 });

  assert.equal(result.flushed, false);
  assert.equal(result.timedOutCount, 1);
});

test('durable mode appends and fsyncs synchronously', () => {
  const calls = [];
  const writer = new ProcessLogWriter({
    stream: { write() { return false; } },
    filePath: 'G:\\logs\\shell.log',
    durable: true,
    maxBytes: 20,
    maxFiles: 1,
    fsImpl: {
      mkdirSync() {}, statSync() { return { size: 10 }; },
      appendFileSync() { calls.push('append'); }, renameSync() { calls.push('rename'); }, unlinkSync() {},
      openSync(target) { calls.push(`open:${target}`); return target.includes('shell.log') ? 10 : 11; },
      fsyncSync(fd) { calls.push(`fsync:${fd}`); }, closeSync() {},
    },
  });

  writer.write({ level: 'INFO', event: 'durable' });

  assert.ok(calls.includes('append'));
  assert.ok(calls.includes('rename'));
  assert.ok(calls.includes('fsync:10'));
  assert.ok(calls.includes('fsync:11'));
});

test('rotation failure disables file sink before append and does not throw', async () => {
  const events = [];
  let appendCalled = false;
  const writer = new ProcessLogWriter({
    stream: { write() { return true; } }, filePath: 'G:\\logs\\shell.log', maxBytes: 10,
    logger: (...args) => events.push(args),
    fsImpl: {
      mkdirSync() {}, statSync() { return { size: 10 }; },
      appendFile() { appendCalled = true; }, appendFileSync() { appendCalled = true; },
      renameSync() { throw new Error('rotate failed'); }, unlinkSync() {},
    },
  });

  writer.write({ level: 'INFO', event: 'rotate.disabled' });
  await writer.flush();

  assert.equal(appendCalled, false);
  assert.equal(writer.fileDisabled, true);
  assert.equal(events.length, 1);
  assert.equal(events[0][2].stage, 'rotate');
});
