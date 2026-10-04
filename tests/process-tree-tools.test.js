'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { enumerateDescendants, confirmAllGone, killTreeWithProof } = require('../services/backend/process-tree-tools');

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
    ok: true, pids: [11, 13, 12],
  });
  assert.deepEqual(await enumerateDescendants(10, { platform: 'win32', execFileImpl, maxPids: 2 }), {
    ok: false, pids: [11, 13],
  });
});

test('enumerates ps rows and rejects failed, malformed, or timed-out queries', async () => {
  const execFileImpl = (exe, args, _options, cb) => {
    assert.equal(exe, 'ps');
    assert.deepEqual(args, ['-eo', 'pid=,ppid=']);
    cb(null, ' 10 1\n 11 10\n 12 11\n 99 1\n');
  };
  assert.deepEqual(await enumerateDescendants(10, { platform: 'linux', execFileImpl }), {
    ok: true, pids: [11, 12],
  });
  for (const impl of [
    (_exe, _args, _opts, cb) => cb(new Error('timeout')),
    () => { throw new Error('launch'); },
    (_exe, _args, _opts, cb) => cb(null, 'not json'),
  ]) {
    assert.deepEqual(await enumerateDescendants(10, { platform: 'win32', execFileImpl: impl }), {
      ok: false, pids: [],
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
