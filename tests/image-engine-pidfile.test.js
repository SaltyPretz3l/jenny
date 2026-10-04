'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTrackedTempDir, cleanupTrackedResources } = require('./helpers/resource-cleanup');
const {
  IMAGE_ENGINE_PID_FILENAME, getImageEnginePidPath, writeRenderRecord,
  readRenderRecord, clearOwnedRenderRecord, reconcileRenderRecord, killRenderRecordSync,
} = require('../services/image-engine-pidfile');

test.afterEach(cleanupTrackedResources);

function setup() {
  const userDataPath = createTrackedTempDir('jenny-image-pid-');
  const pidPath = getImageEnginePidPath(userDataPath);
  const record = { version: 1, pid: 123, exePath: path.join(userDataPath, 'sd-cli.exe'),
    opId: 'render_123', output: path.join(userDataPath, 'image-engine-scratch', 'render_123.png'), startedAt: 1234 };
  return { userDataPath, pidPath, record };
}

test('atomic record roundtrip and owned clear; live record refuses replacement', () => {
  const { pidPath, record } = setup();
  assert.equal(path.basename(pidPath), IMAGE_ENGINE_PID_FILENAME);
  writeRenderRecord(pidPath, record, { isProcessAliveImpl: () => false });
  assert.deepEqual(readRenderRecord(pidPath), record);
  assert.equal(fs.existsSync(`${pidPath}.tmp`), false);
  assert.throws(() => writeRenderRecord(pidPath, { ...record, pid: 456 }, {
    isProcessAliveImpl: () => true,
  }));
  assert.deepEqual(readRenderRecord(pidPath), record);
  clearOwnedRenderRecord(pidPath, 'other_op');
  assert.deepEqual(readRenderRecord(pidPath), record);
  writeRenderRecord(pidPath, { ...record, pid: 456 }, { isProcessAliveImpl: () => false });
  assert.equal(readRenderRecord(pidPath).pid, 456);
  clearOwnedRenderRecord(pidPath, record.opId);
  assert.equal(readRenderRecord(pidPath), null);
});

test('corrupt, mismatched version, invalid numbers, and oversized strings read as null', () => {
  const { pidPath, record } = setup();
  for (const value of ['{', { ...record, version: 2 }, { ...record, pid: -1 },
    { ...record, pid: 1.5 }, { ...record, exePath: 'x'.repeat(1025) }, { ...record, startedAt: NaN }]) {
    fs.writeFileSync(pidPath, typeof value === 'string' ? value : JSON.stringify(value));
    assert.equal(readRenderRecord(pidPath), null);
  }
});

test('a tmp left by an interrupted write is replaced instead of refusing every later render', () => {
  const { pidPath, record } = setup();
  fs.writeFileSync(`${pidPath}.tmp`, 'interrupted earlier');
  writeRenderRecord(pidPath, record);
  assert.deepEqual(readRenderRecord(pidPath), record);
  assert.equal(fs.existsSync(`${pidPath}.tmp`), false);
  // Other open failures still surface.
  assert.throws(() => writeRenderRecord(pidPath, record, { fsImpl: { ...fs, mkdirSync() {}, openSync() {
    throw Object.assign(new Error('denied'), { code: 'EACCES' });
  } } }));
});

test('reconcile absent and dead records', async () => {
  const { userDataPath, pidPath, record } = setup();
  assert.deepEqual(await reconcileRenderRecord({ userDataPath }), { confirmed: true, action: 'none' });
  writeRenderRecord(pidPath, record);
  assert.deepEqual(await reconcileRenderRecord({ userDataPath, isProcessAliveImpl: () => false }), {
    confirmed: true, action: 'cleared_stale',
  });
  assert.equal(readRenderRecord(pidPath), null);
});

test('reconcile requires the unique operation id on the command line and retains an unconfirmed kill', async () => {
  const { userDataPath, pidPath, record } = setup();
  const options = { userDataPath, isProcessAliveImpl: () => true,
    getProcessCommandLineImpl: async () => `"${record.exePath}" -o "${record.output}"` };
  writeRenderRecord(pidPath, record);
  let killed = 0;
  assert.deepEqual(await reconcileRenderRecord({ ...options, killTreeImpl: async (pid) => {
    killed = pid; return { confirmed: false };
  } }), { confirmed: false, action: 'unconfirmed' });
  assert.equal(killed, record.pid);
  assert.deepEqual(readRenderRecord(pidPath), record);
  // A confirmed kill also removes the render's own scratch output.
  fs.mkdirSync(path.dirname(record.output), { recursive: true });
  fs.writeFileSync(record.output, 'partial png');
  const foreign = path.join(userDataPath, 'user-image.png');
  fs.writeFileSync(foreign, 'user file');
  assert.deepEqual(await reconcileRenderRecord({ ...options, killTreeImpl: async () => ({ confirmed: true }) }), {
    confirmed: true, action: 'killed',
  });
  assert.equal(readRenderRecord(pidPath), null);
  assert.equal(fs.existsSync(record.output), false);
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'user file');
  // The exe path alone, a different render's output, or a tokenised variant
  // of the same path is not this render.
  for (const command of ['unrelated.exe -o other.png',
    `"${record.exePath}" -o "${path.join(userDataPath, 'image-engine-scratch', 'render_999.png')}"`,
    `"${record.exePath}" -o "${path.join(userDataPath, 'other.png')}"`]) {
    writeRenderRecord(pidPath, record);
    assert.deepEqual(await reconcileRenderRecord({ ...options,
      getProcessCommandLineImpl: async () => command,
      killTreeImpl: async () => { assert.fail('must not kill a different process'); },
    }), { confirmed: true, action: 'identity_mismatch' });
    assert.equal(readRenderRecord(pidPath), null);
  }
});

test('unknown command identity retains record without killing', async () => {
  const { userDataPath, pidPath, record } = setup();
  writeRenderRecord(pidPath, record);
  assert.deepEqual(await reconcileRenderRecord({ userDataPath, isProcessAliveImpl: () => true,
    getProcessCommandLineImpl: async () => '',
  }), { confirmed: false, action: 'unconfirmed' });
  assert.deepEqual(readRenderRecord(pidPath), record);
});

test('Windows identity normalizes casing and path separators, including paths with spaces', async () => {
  const { userDataPath, pidPath, record } = setup();
  record.exePath = 'C:\\Program Files\\engine\\sd-cli.exe';
  record.output = 'C:\\Render Files\\render_123.png';
  writeRenderRecord(pidPath, record);
  assert.deepEqual(await reconcileRenderRecord({ userDataPath, platform: 'win32', isProcessAliveImpl: () => true,
    getProcessCommandLineImpl: async () => '"c:/PROGRAM FILES/engine/SD-CLI.EXE" -o "c:/render files/RENDER_123.PNG"',
    killTreeImpl: async () => ({ confirmed: true }),
  }), { confirmed: true, action: 'killed' });
  // Case is significant elsewhere.
  writeRenderRecord(pidPath, record);
  assert.deepEqual(await reconcileRenderRecord({ userDataPath, platform: 'linux', isProcessAliveImpl: () => true,
    getProcessCommandLineImpl: async () => '/opt/engine/sd-cli -o /tmp/RENDER_123.png',
    killTreeImpl: async () => assert.fail('must not kill on a case mismatch'),
  }), { confirmed: true, action: 'identity_mismatch' });
});

test('sync emergency cleanup handles absent and stale records without a kill', () => {
  const { userDataPath, pidPath, record } = setup();
  assert.deepEqual(killRenderRecordSync({ userDataPath }), { hadState: false, killed: false });
  writeRenderRecord(pidPath, record);
  assert.deepEqual(killRenderRecordSync({ userDataPath, isProcessAliveImpl: () => false,
    spawnSyncImpl: () => assert.fail('dead pid must not be killed'),
  }), { hadState: true, killed: false });
  assert.equal(readRenderRecord(pidPath), null);
});

test('sync identity mismatches clear only the record; unknown identity retains it', () => {
  const { userDataPath, pidPath, record } = setup();
  for (const command of ['unrelated.exe -o other.png',
    `"${record.exePath}" -o "${path.join(userDataPath, 'image-engine-scratch', 'render_999.png')}"`,
    `"${record.exePath}" -o "${path.join(userDataPath, 'other.png')}"`, '']) {
    writeRenderRecord(pidPath, record);
    assert.deepEqual(killRenderRecordSync({ userDataPath, platform: 'win32', isProcessAliveImpl: () => true,
      getProcessCommandLineSyncImpl: () => command,
      spawnSyncImpl: () => assert.fail('unconfirmed identity must not be killed'),
    }), { hadState: true, killed: false });
    assert.deepEqual(readRenderRecord(pidPath), command ? null : record);
  }
});

test('sync Windows kill uses exact identity and clears only a confirmed dead pid', () => {
  const { userDataPath, pidPath, record } = setup();
  record.exePath = 'C:\\Program Files\\engine\\sd-cli.exe';
  record.output = 'C:\\Render Files\\render_123.png';
  for (const dies of [false, true]) {
    writeRenderRecord(pidPath, record, { isProcessAliveImpl: () => false });
    let alive = true;
    const calls = [];
    const result = killRenderRecordSync({ userDataPath, platform: 'win32',
      isProcessAliveImpl: () => alive,
      getProcessCommandLineSyncImpl: (pid, options) => {
        assert.equal(pid, record.pid);
        assert.equal(options.platform, 'win32');
        assert.equal(options.timeoutMs, 3000, 'the emergency lookup is bounded');
        return '"c:/PROGRAM FILES/engine/SD-CLI.EXE" -o "c:/render files/RENDER_123.PNG"';
      },
      spawnSyncImpl: (...args) => { calls.push(args); alive = !dies; },
      log: () => { throw new Error('log failure'); },
    });
    assert.deepEqual(calls, [['taskkill', ['/PID', String(record.pid), '/T', '/F'], {
      windowsHide: true, timeout: 3000, stdio: 'ignore',
    }]]);
    assert.deepEqual(result, { hadState: true, killed: dies });
    assert.deepEqual(readRenderRecord(pidPath), dies ? null : record);
  }
});

test('sync lookup and kill exceptions retain the record for later reconciliation', () => {
  const { userDataPath, pidPath, record } = setup();
  writeRenderRecord(pidPath, record);
  for (const failsLookup of [false, true]) {
    assert.deepEqual(killRenderRecordSync({ userDataPath, platform: 'win32', isProcessAliveImpl: () => true,
      getProcessCommandLineSyncImpl: () => {
        if (failsLookup) throw new Error('lookup failed');
        return `"${record.exePath}" -o "${record.output}"`;
      },
      spawnSyncImpl: () => { throw new Error('kill failed'); },
    }), { hadState: true, killed: false });
    assert.deepEqual(readRenderRecord(pidPath), record);
  }
});

test('sync non-Windows kill sends SIGKILL only after matching identity', (t) => {
  const { userDataPath, pidPath, record } = setup();
  writeRenderRecord(pidPath, record);
  let alive = true;
  const calls = [];
  t.mock.method(process, 'kill', (pid, signal) => { calls.push([pid, signal]); alive = false; });
  assert.deepEqual(killRenderRecordSync({ userDataPath, platform: 'linux', isProcessAliveImpl: () => alive,
    getProcessCommandLineSyncImpl: () => `"${record.exePath}" -o "${record.output}"`,
  }), { hadState: true, killed: true });
  assert.deepEqual(calls, [[record.pid, 'SIGKILL']]);
  assert.equal(readRenderRecord(pidPath), null);
});
