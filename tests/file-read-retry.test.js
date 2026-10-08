const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  READ_RETRY_DELAYS_MS,
  isTransientReadError,
  readFileWithRetry,
} = require('../services/backend/file-read-retry');
const { FileJsonStore } = require('../services/backend/file-json-store');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function fsError(code) {
  return Object.assign(new Error(`${code}: simulated read failure`), { code });
}

function makeFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-read-retry-'));
  trackDirectory(dir);
  const filePath = path.join(dir, 'state.json');
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

// Fails reads of `filePath` with `code` for the first `failures` attempts
// (Infinity = always); every other path reads normally.
function failReads(t, filePath, code, failures = Infinity) {
  const realRead = fs.readFileSync;
  let calls = 0;
  const mocked = t.mock.method(fs, 'readFileSync', (target, ...rest) => {
    if (String(target) === filePath) {
      calls += 1;
      if (calls <= failures) throw fsError(code);
    }
    return realRead(target, ...rest);
  });
  return { calls: () => calls, restore: () => mocked.mock.restore() };
}

test('transient read error codes are a small explicit list', () => {
  for (const code of ['EBUSY', 'EPERM', 'EACCES', 'EMFILE', 'ENFILE', 'EAGAIN']) {
    assert.equal(isTransientReadError(fsError(code)), true, code);
  }
  for (const code of ['ENOENT', 'EISDIR', 'EIO', undefined]) {
    assert.equal(isTransientReadError(fsError(code)), false, String(code));
  }
  assert.equal(isTransientReadError(null), false);
  const worstCaseMs = READ_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);
  assert.ok(worstCaseMs > 0 && worstCaseMs < 250, `worst-case backoff ${worstCaseMs} ms`);
});

test('readFileWithRetry retries a transient error and returns the bytes once it clears', (t) => {
  const filePath = makeFile('{"ok":1}');
  const reads = failReads(t, filePath, 'EBUSY', 1);
  const sleeps = [];
  assert.equal(readFileWithRetry(filePath, { sleep: (ms) => sleeps.push(ms) }), '{"ok":1}');
  assert.equal(reads.calls(), 2);
  assert.deepEqual(sleeps, [READ_RETRY_DELAYS_MS[0]]);
});

test('readFileWithRetry gives up after the backoff and does not retry other codes', (t) => {
  const busyPath = makeFile('{}');
  const busy = failReads(t, busyPath, 'EPERM');
  const sleeps = [];
  assert.throws(() => readFileWithRetry(busyPath, { sleep: (ms) => sleeps.push(ms) }), { code: 'EPERM' });
  assert.equal(busy.calls(), READ_RETRY_DELAYS_MS.length + 1);
  assert.deepEqual(sleeps, [...READ_RETRY_DELAYS_MS]);
  busy.restore();

  const ioPath = makeFile('{}');
  const io = failReads(t, ioPath, 'EIO');
  assert.throws(() => readFileWithRetry(ioPath, { sleep: () => assert.fail('EIO is not retried') }), { code: 'EIO' });
  assert.equal(io.calls(), 1);
  assert.throws(() => readFileWithRetry(path.join(path.dirname(ioPath), 'absent.json')), { code: 'ENOENT' });
});

test('readWithStatus loads the value normally when a transient lock clears on the second attempt', (t) => {
  const filePath = makeFile(JSON.stringify({ kept: 'value' }));
  const reads = failReads(t, filePath, 'EBUSY', 1);
  const logged = [];
  const status = new FileJsonStore(filePath, { logger: (level, event) => logged.push(event) })
    .readWithStatus(null);
  assert.deepEqual(status.value, { kept: 'value' });
  assert.equal(status.corrupted, false);
  assert.equal(status.missing, false);
  assert.equal(status.unreadable, undefined);
  assert.equal(reads.calls(), 2);
  assert.deepEqual(logged, []);
});

test('readWithStatus reports a persistently locked file as unreadable, never corrupted', (t) => {
  const filePath = makeFile(JSON.stringify({ kept: 'value' }));
  const reads = failReads(t, filePath, 'EBUSY');
  const logged = [];
  const store = new FileJsonStore(filePath, { logger: (level, event, data) => logged.push({ level, event, data }) });
  const status = store.readWithStatus({ fallback: true });
  assert.deepEqual(status.value, { fallback: true });
  assert.equal(status.corrupted, false);
  assert.equal(status.unreadable, true);
  assert.equal(status.missing, false);
  assert.equal(status.errorCode, 'EBUSY');
  assert.match(status.errorMessage, /EBUSY/);
  assert.equal(reads.calls(), READ_RETRY_DELAYS_MS.length + 1);
  assert.deepEqual(logged.map((entry) => [entry.level, entry.event]), [['WARN', 'store.unreadable']]);
  assert.deepEqual(logged[0].data, { filePath, errorCode: 'EBUSY', errorMessage: status.errorMessage });
  reads.restore();
  assert.deepEqual(store.readWithStatus(null).value, { kept: 'value' }, 'the failure is not cached');
});

test('readWithStatus reports any other read error code as unreadable without retrying it', (t) => {
  const filePath = makeFile('{}');
  const reads = failReads(t, filePath, 'EIO');
  const status = new FileJsonStore(filePath).readWithStatus(null);
  assert.equal(status.corrupted, false);
  assert.equal(status.unreadable, true);
  assert.equal(status.errorCode, 'EIO');
  assert.equal(reads.calls(), 1);
});

test('readWithStatus still reports bytes that do not parse as corrupted', () => {
  const filePath = makeFile('{bad json');
  const logged = [];
  const status = new FileJsonStore(filePath, { logger: (level, event) => logged.push(event) })
    .readWithStatus(null);
  assert.equal(status.value, null);
  assert.equal(status.corrupted, true);
  assert.equal(status.unreadable, undefined);
  assert.equal(status.missing, false);
  assert.equal(status.errorCode, null);
  assert.deepEqual(logged, ['store.corrupted']);
});

test('a redacting store keeps the unparsable bytes out of every log line', () => {
  const filePath = makeFile('PRIVATE-SENTINEL is not json');
  const logged = [];
  const consoleLines = [];
  const originalError = console.error;
  console.error = (line) => consoleLines.push(String(line));
  let status;
  try {
    status = new FileJsonStore(filePath, {
      logger: (level, event, details) => logged.push({ event, details }),
      redactReadErrors: true,
    }).readWithStatus(null);
  } finally {
    console.error = originalError;
  }
  assert.equal(status.corrupted, true);
  assert.equal(logged[0].event, 'store.corrupted');
  assert.equal(JSON.stringify(logged).includes('PRIVATE-SENTINEL'), false);
  assert.equal(consoleLines.join('\n').includes('PRIVATE-SENTINEL'), false);
  assert.match(logged[0].details.errorMessage, /^\[redacted: SyntaxError\]$/);
});
