'use strict';
// Cross-process behavior of the work-lease store with the real pid probe: mutual exclusion under
// contention from four processes, and reclaim of a lease whose owner crashed.
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { removeTreeSync } = require('../services/fs-remove-no-follow');
const { WorkLeaseStore, waitForGrant } = require('../services/work-leases');

const WORKER = path.join(__dirname, 'fixtures', 'work-leases', 'stress-worker.js');
const WORKERS = 4;
const CYCLES = 15;

function runWorker(args) {
  return new Promise((resolve, reject) => {
    const child = fork(WORKER, args, { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true });
    const timer = setTimeout(() => { child.kill(); reject(new Error('worker timed out')); }, 50_000);
    child.once('error', reject);
    child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-lease-stress-'));
  t.after(() => removeTreeSync(dir));
  return { leaseRoot: path.join(dir, 'leases'), logFile: path.join(dir, 'events.log') };
}

test('four processes never hold one exclusive lease at the same time', async (t) => {
  const { leaseRoot, logFile } = fixture(t);
  fs.writeFileSync(logFile, '');
  const codes = await Promise.all(Array.from({ length: WORKERS }, () => runWorker(['cycle', leaseRoot, logFile, String(CYCLES)])));
  assert.deepEqual(codes, new Array(WORKERS).fill(0));

  const events = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((line) => line.split(' '));
  assert.equal(events.length, WORKERS * CYCLES * 2);
  let holder = null;
  for (const [event, pid] of events) {
    if (event === 'start') {
      assert.equal(holder, null, `${pid} started while ${holder} still held the lease`);
      holder = pid;
    } else {
      assert.equal(holder, pid, `${pid} ended a lease held by ${holder}`);
      holder = null;
    }
  }
  assert.equal(holder, null);
  assert.deepEqual(fs.readdirSync(path.join(leaseRoot, 'tickets')), [], 'every ticket was released');
});

test('a lease whose owner exited without releasing is reclaimed within 5 s', async (t) => {
  const { leaseRoot, logFile } = fixture(t);
  assert.equal(await runWorker(['crash', leaseRoot, logFile]), 0);
  assert.match(fs.readFileSync(logFile, 'utf8'), /^taken \d+/u);
  assert.equal(fs.readdirSync(path.join(leaseRoot, 'tickets')).length, 1, 'the dead worker left its ticket behind');

  const store = new WorkLeaseStore({ leaseRoot });
  t.after(() => store.close());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  t.after(() => clearTimeout(timer));
  const { ticket, granted } = store.publish({
    resources: [{ key: 'tests@tree:stress', units: 'all', capacity: 1 }], owner: { app: 'stress-parent' },
  });
  assert.equal(granted || await waitForGrant(store, ticket.ticket, { signal: controller.signal }), true);
  store.release(ticket.ticket);
});
