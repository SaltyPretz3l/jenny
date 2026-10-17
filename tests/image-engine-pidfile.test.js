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


test('recovery retains source copies until render death is confirmed, then removes them',async()=>{
  const {userDataPath,pidPath,record}=setup();fs.mkdirSync(path.dirname(record.output));
  const reference=path.join(path.dirname(record.output),record.opId+'-reference.png');fs.writeFileSync(reference,'private source');
  writeRenderRecord(pidPath,record);
  const unconfirmed=await reconcileRenderRecord({userDataPath,isProcessAliveImpl:()=>true,getProcessCommandLineImpl:async()=>record.opId,killTreeImpl:async()=>({confirmed:false})});
  assert.equal(unconfirmed.confirmed,false);assert.equal(fs.existsSync(reference),true);
  await reconcileRenderRecord({userDataPath,isProcessAliveImpl:()=>false});assert.equal(fs.existsSync(reference),false);
});

// Owner-confirmed "Clear anyway": the record and the render's scratch files go
// without proof, nothing is killed, and a record that cannot be removed stays.
const { clearRenderRecordUnproven, readRenderRecordSummary, retainRenderTree } = require('../services/image-engine-pidfile');

function stuckRecord(t) {
  const { userDataPath, pidPath, record } = setup();
  const scratch = path.dirname(record.output);
  fs.mkdirSync(scratch);
  const reference = path.join(scratch, `${record.opId}-reference.png`);
  fs.writeFileSync(record.output, 'partial render');
  fs.writeFileSync(reference, 'private source');
  writeRenderRecord(pidPath, { ...record, treeSince: 1000 });
  retainRenderTree(pidPath, record.opId, { spawnedAtMs: 1000, spawnReturnedAtMs: 1001, rootHeldUntilMs: 1002,
    rootCreatedMs: null, processes: [], survivors: [], unresolved: [{ pid: 7001, createdMs: null }, { pid: 7002, createdMs: 5 }] });
  const kills = [];
  t.mock.method(process, 'kill', (...args) => { kills.push(args); });
  return { userDataPath, pidPath, record, reference, kills };
}

test('an unproven clear drops the record and its scratch files, logs the unchecked helpers and kills nothing', (t) => {
  const { userDataPath, pidPath, record, reference, kills } = stuckRecord(t);
  assert.deepEqual(readRenderRecordSummary({ userDataPath }), { started_at: 1234, unresolved: 2 });
  const logs = [];
  assert.deepEqual(clearRenderRecordUnproven({ userDataPath, log: (...entry) => logs.push(entry) }),
    { cleared: true, record: { pid: 123, startedAt: 1234, unresolved: 2 } });
  assert.equal(readRenderRecord(pidPath), null);
  assert.equal(fs.existsSync(record.output), false);
  assert.equal(fs.existsSync(reference), false);
  assert.deepEqual(logs, [['WARN', 'image_engine.cleared_unproven', { opId: record.opId, pid: 123, unresolved: 2 }]]);
  assert.deepEqual(kills, []);
  assert.equal(readRenderRecordSummary({ userDataPath }), null);
  assert.deepEqual(clearRenderRecordUnproven({ userDataPath }), { cleared: true, record: null });
});

test('an unproven clear whose record cannot be read reports it locked and touches nothing (w2h4-R3)', (t) => {
  const { userDataPath, pidPath, record, reference, kills } = stuckRecord(t);
  const before = fs.readFileSync(pidPath, 'utf8');
  const unlinks = [];
  const fsImpl = { ...fs,
    readFileSync(target, ...rest) {
      if (target === pidPath) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return fs.readFileSync(target, ...rest);
    },
    unlinkSync(target) { unlinks.push(target); return fs.unlinkSync(target); },
  };
  assert.deepEqual(clearRenderRecordUnproven({ userDataPath, fsImpl }), { cleared: false, reason: 'image_engine_record_locked' });
  assert.equal(fs.readFileSync(pidPath, 'utf8'), before);
  assert.equal(fs.existsSync(record.output), true);
  assert.equal(fs.existsSync(reference), true);
  assert.deepEqual(unlinks, []);
  assert.deepEqual(kills, []);
});

test('an unproven clear whose record cannot be removed reports it locked and keeps the record', (t) => {
  const { userDataPath, pidPath, record, reference, kills } = stuckRecord(t);
  const before = readRenderRecord(pidPath);
  const outputBytes = fs.readFileSync(record.output);
  const referenceBytes = fs.readFileSync(reference);
  const logs = [];
  const fsImpl = { ...fs, unlinkSync(target) {
    if (target === pidPath) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return fs.unlinkSync(target);
  } };
  assert.deepEqual(clearRenderRecordUnproven({ userDataPath, fsImpl, log: (...entry) => logs.push(entry) }),
    { cleared: false, reason: 'image_engine_record_locked' });
  assert.deepEqual(readRenderRecord(pidPath), before);
  // The scratch files stay with the record (w2h3-R2).
  assert.deepEqual(fs.readFileSync(record.output), outputBytes);
  assert.deepEqual(fs.readFileSync(reference), referenceBytes);
  assert.equal(logs.some(([, event]) => event === 'image_engine.cleared_unproven'), false);
  assert.deepEqual(kills, []);
});
