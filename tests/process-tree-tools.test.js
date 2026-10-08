'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  enumerateDescendants, selectRootSurvivors, terminatePids, confirmAllGone, killTreeWithProof,
} = require('../services/backend/process-tree-tools');

const untimed = (pids) => pids.map((pid) => ({ pid, createdMs: null }));

test('enumerates Windows rows breadth-first, cycle-safe, with safe process options', async () => {
  const rows = [
    // The System Idle Process row a real Win32_Process listing always carries.
    { ProcessId: 0, ParentProcessId: 0 },
    { ProcessId: 10, ParentProcessId: 12 },
    { ProcessId: 11, ParentProcessId: 10 },
    { ProcessId: 12, ParentProcessId: 11 },
    { ProcessId: 13, ParentProcessId: 10 },
  ];
  const execFileImpl = (exe, args, options, cb) => {
    assert.equal(exe, 'powershell');
    assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
    assert.equal(options.windowsHide, true);
    assert.equal(options.maxBuffer, 8 * 1024 * 1024);
    assert.equal(options.timeout, 5000);
    assert.ok(options.env);
    cb(null, JSON.stringify(rows));
  };
  assert.deepEqual(await enumerateDescendants(10, { platform: 'win32', execFileImpl }), {
    ok: true, pids: [11, 13, 12], processes: untimed([11, 13, 12]), rootCreatedMs: null,
  });
  assert.deepEqual(await enumerateDescendants(10, { platform: 'win32', execFileImpl, maxPids: 2 }), {
    ok: false, pids: [11, 13], processes: untimed([11, 13]), rootCreatedMs: null,
  });
});

test('enumerates ps rows and rejects failed, malformed, or timed-out queries', async () => {
  const execFileImpl = (exe, args, _options, cb) => {
    assert.equal(exe, 'ps');
    assert.deepEqual(args, ['-eo', 'pid=,ppid=']);
    cb(null, ' 10 1\n 11 10\n 12 11\n 99 1\n');
  };
  assert.deepEqual(await enumerateDescendants(10, { platform: 'linux', execFileImpl }), {
    ok: true, pids: [11, 12], processes: untimed([11, 12]), rootCreatedMs: null,
  });
  for (const impl of [
    (_exe, _args, _opts, cb) => cb(new Error('timeout')),
    () => { throw new Error('launch'); },
    (_exe, _args, _opts, cb) => cb(null, 'not json'),
  ]) {
    assert.deepEqual(await enumerateDescendants(10, { platform: 'win32', execFileImpl: impl }), {
      ok: false, pids: [], processes: [], rootCreatedMs: null,
    });
  }
});

test('confirmation polls all pids and reports only survivors at the deadline', async () => {
  let time = 0;
  const options = {
    now: () => time, sleep: async (ms) => { time += ms; }, timeoutMs: 300, pollMs: 100,
    isProcessAliveImpl: (pid) => pid === 12 || time < 100,
  };
  assert.deepEqual(await confirmAllGone([10, 11, 12], options), { confirmed: false, survivors: [12] });
  assert.deepEqual(await confirmAllGone([10, 11], options), { confirmed: true, survivors: [] });
});

test('kill enumerates first, kills root, then proves all recorded pids', async () => {
  const calls = [];
  const result = await killTreeWithProof(10, {
    platform: 'win32',
    enumerateImpl: async () => { calls.push('enumerate'); return { ok: true, pids: [11, 12] }; },
    killImpl: async (pid, opts) => {
      calls.push('kill');
      assert.equal(pid, 10);
      assert.equal(opts.force, true);
      assert.equal(opts.confirmExit, false);
      assert.equal(opts.platform, 'win32');
    },
    confirmImpl: async (pids) => {
      calls.push('confirm');
      assert.deepEqual(pids, [10, 11, 12]);
      return { confirmed: true, survivors: [] };
    },
  });
  assert.deepEqual(calls, ['enumerate', 'kill', 'confirm']);
  assert.deepEqual(result, { confirmed: true, enumerated: true, pids: [10, 11, 12], survivors: [] });
});

test('failed enumeration cannot prove clean even when root died; kill errors still confirm', async () => {
  const result = await killTreeWithProof(10, {
    enumerateImpl: async () => ({ ok: false, pids: [] }),
    killImpl: async () => { throw new Error('gone'); },
    confirmImpl: async () => ({ confirmed: true, survivors: [] }),
  });
  assert.deepEqual(result, { confirmed: false, enumerated: false, pids: [10], survivors: [] });
});

test('POSIX tree cleanup kills known descendants despite the shared helper killing only root', async () => {
  const killed = [];
  const result = await killTreeWithProof(10, { platform: 'linux',
    enumerateImpl: async () => ({ ok: true, pids: [11, 12] }),
    killImpl: async (pid) => { killed.push(pid); },
    confirmImpl: async () => ({ confirmed: true, survivors: [] }),
  });
  assert.deepEqual(killed, [10, 12, 11]);
  assert.equal(result.confirmed, true);
});

test('Windows enumeration carries creation times and skips stale parent links', async () => {
  const rows = [
    { ProcessId: 10, ParentProcessId: 1, CreatedMs: 1000 },
    { ProcessId: 11, ParentProcessId: 10, CreatedMs: 1100 },
    // Left behind by an earlier holder of pid 10: older than the current one.
    { ProcessId: 12, ParentProcessId: 10, CreatedMs: 900 },
    { ProcessId: 13, ParentProcessId: 12, CreatedMs: 950 },
  ];
  const execFileImpl = (_exe, args, _options, cb) => {
    assert.match(args[3], /CreatedMs/);
    cb(null, JSON.stringify(rows));
  };
  assert.deepEqual(await enumerateDescendants(10, { platform: 'win32', execFileImpl }), {
    ok: true, pids: [11], processes: [{ pid: 11, createdMs: 1100 }], rootCreatedMs: 1000,
  });
});

// Root 10 was spawned between 1000 and 1002 and its exit was observed at 5000.
const window10 = { rootPid: 10, spawnedAtMs: 1000, spawnReturnedAtMs: 1002, rootHeldUntilMs: 5000 };
const sortedPids = (selection) => ({ ...selection, pids: [...selection.pids].sort((a, b) => a - b) });

test('after the root exits, only children it created while holding its pid are survivors', () => {
  const selection = selectRootSurvivors({ ...window10,
    snapshot: { ok: true, processes: [], rootCreatedMs: 1001 },
    rows: [
      { pid: 10, ppid: 7, createdMs: 9000 }, // a later process reused the root pid
      { pid: 20, ppid: 10, createdMs: 9100 }, // ...and its child
      { pid: 21, ppid: 10, createdMs: 3000 }, // our orphan
      { pid: 22, ppid: 21, createdMs: 6000 }, // our orphan's later worker
      { pid: 23, ppid: 10, createdMs: 500 }, // an earlier holder's child: stale link
    ] });
  assert.deepEqual(sortedPids(selection), { ok: true, pids: [21, 22] });
});

test('a snapshot pid is a survivor only while it is still the same process', () => {
  const selection = selectRootSurvivors({ ...window10,
    snapshot: { ok: true, rootCreatedMs: 1001,
      processes: [{ pid: 30, createdMs: 1200 }, { pid: 31, createdMs: 1300 }, { pid: 32, createdMs: 1400 }] },
    rows: [
      { pid: 30, ppid: 4, createdMs: 1200 }, // orphaned grandchild, still running
      { pid: 31, ppid: 4, createdMs: 7000 }, // pid reused after our worker died
      { pid: 33, ppid: 31, createdMs: 7100 },
    ] });
  assert.deepEqual(sortedPids(selection), { ok: true, pids: [30] });
});

test('rows within the clock slack of a boundary are left alone and leave cleanup unproven', () => {
  for (const createdMs of [990, 5010]) {
    assert.deepEqual(selectRootSurvivors({ ...window10,
      snapshot: { ok: true, processes: [], rootCreatedMs: 1001 },
      rows: [{ pid: 40, ppid: 10, createdMs }] }), { ok: false, pids: [] });
  }
});

test('a snapshot that did not list our root is not trusted', () => {
  // The listing ran after the root pid was reused, so its "children" may be anyone's.
  const selection = selectRootSurvivors({ ...window10,
    snapshot: { ok: true, rootCreatedMs: 8000, processes: [{ pid: 50, createdMs: 8100 }] },
    rows: [{ pid: 10, ppid: 7, createdMs: 8000 }, { pid: 50, ppid: 10, createdMs: 8100 }] });
  assert.deepEqual(selection, { ok: false, pids: [] });
});

test('without creation times the snapshot is trusted and nothing is reaped by parent pid', () => {
  const selection = selectRootSurvivors({ ...window10,
    snapshot: { ok: true, pids: [60] },
    rows: [{ pid: 60, ppid: 1, createdMs: null }, { pid: 61, ppid: 60, createdMs: null },
      { pid: 62, ppid: 10, createdMs: null }] });
  assert.deepEqual(sortedPids(selection), { ok: true, pids: [60, 61] });
});

test('termination targets exactly the given pids and tolerates ones already gone', async () => {
  const calls = [];
  await terminatePids([70, 71], { killImpl: (pid, signal) => {
    calls.push([pid, signal]);
    if (pid === 70) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  } });
  assert.deepEqual(calls, [[70, 'SIGKILL'], [71, 'SIGKILL']]);
});
