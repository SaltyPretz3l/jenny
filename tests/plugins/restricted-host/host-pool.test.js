'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { RestrictedHostPool } = require('../../../services/plugins/restricted-host/host-pool');

function descriptor() {
  return {
    publisher_id: 'jenny-official', plugin_id: 'restricted-smoke',
    contribution_id: 'restricted-main', generation_id: 'gen-1', commit_epoch: 7,
  };
}

test('dead hosts are evicted and restarted after the crash-circuit delay', async () => {
  const waits = [];
  let starts = 0;
  const first = { alive: true, identity: descriptor(), shutdown: async () => {} };
  const second = { alive: true, identity: descriptor(), shutdown: async () => {} };
  const supervisor = {
    start: async () => ({ ok: true, host: starts++ === 0 ? first : second }),
    dispose: async () => {},
  };
  const pool = new RestrictedHostPool({
    supervisor,
    loadComponentBytes: async () => ({ ok: true, bytes: Buffer.from('component') }),
    wait: async (ms) => { waits.push(ms); },
  });

  const initial = await pool.acquire(descriptor());
  assert.equal(initial.host, first);
  first.alive = false;
  first.restart_delay_ms = 500;

  const restarted = await pool.acquire(descriptor());
  assert.equal(restarted.host, second);
  assert.deepEqual(waits, [500]);
  assert.equal(starts, 2);
  await pool.dispose();
});

test('dispose during restart delay refuses to spawn a replacement', async () => {
  let releaseWait;
  let starts = 0;
  const first = { alive: true, identity: descriptor(), shutdown: async () => {} };
  const supervisor = {
    start: async () => { starts += 1; return { ok: true, host: first }; },
    dispose: async () => {},
  };
  const pool = new RestrictedHostPool({
    supervisor,
    loadComponentBytes: async () => ({ ok: true, bytes: Buffer.from('component') }),
    wait: () => new Promise((resolve) => { releaseWait = resolve; }),
  });
  await pool.acquire(descriptor());
  first.alive = false;
  first.restart_delay_ms = 100;
  const restarting = pool.acquire(descriptor());
  await Promise.resolve();
  const disposing = pool.dispose();
  releaseWait();

  assert.deepEqual(await restarting, { ok: false, reason: 'restricted_host_pool_disposed' });
  await disposing;
  assert.equal(starts, 1);
});

test('generation revocation aborts a starting host and prevents stale reuse', async () => {
  let releaseStart;
  let startupSignal;
  let shutdowns = 0;
  const host = {
    alive: true,
    identity: descriptor(),
    shutdown: async () => { shutdowns += 1; },
  };
  const supervisor = {
    start: async (_descriptor, _bytes, { signal }) => {
      startupSignal = signal;
      await new Promise((resolve) => { releaseStart = resolve; });
      return { ok: true, host };
    },
    dispose: async () => {},
  };
  const pool = new RestrictedHostPool({
    supervisor,
    loadComponentBytes: async () => ({ ok: true, bytes: Buffer.from('component') }),
  });

  const acquiring = pool.acquire(descriptor());
  while (!releaseStart) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await pool.revokeGeneration('gen-1'), 1);
  assert.equal(startupSignal.aborted, true);
  releaseStart();

  assert.deepEqual(await acquiring, { ok: false, reason: 'restricted_generation_revoked' });
  assert.equal(shutdowns, 1);
  assert.deepEqual(await pool.acquire(descriptor()), {
    ok: false,
    reason: 'restricted_generation_revoked',
  });
  await pool.dispose();
});
