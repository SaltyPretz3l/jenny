'use strict';
// Helper process for tests/work-lease-stress.test.js.
//   node stress-worker.js cycle <leaseRoot> <logFile> <cycles>   take/release one exclusive key repeatedly
//   node stress-worker.js crash <leaseRoot> <logFile>            take the lease, then exit without releasing
const fs = require('node:fs');
const path = require('node:path');
const { WorkLeaseStore, waitForGrant } = require('../../../services/work-leases');

const KEY = 'tests@tree:stress';
const take = [{ key: KEY, units: 'all', capacity: 1 }];
const [mode, leaseRoot, logFile, cycles] = process.argv.slice(2);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (line) => fs.appendFileSync(logFile, `${line} ${process.pid}\n`);

async function acquire(store) {
  const { ticket, granted } = store.publish({ resources: take, owner: { app: path.basename(__filename) } });
  if (!granted && !(await waitForGrant(store, ticket.ticket))) throw new Error('wait aborted');
  return ticket.ticket;
}

async function main() {
  const store = new WorkLeaseStore({ leaseRoot });
  store.startHeartbeat(1000);
  if (mode === 'crash') {
    await acquire(store);
    log('taken');
    process.exit(0); // no release: the parent must reclaim a dead pid
  }
  for (let i = 0; i < Number(cycles); i += 1) {
    const id = await acquire(store);
    log('start');
    await pause(5);
    log('end');
    store.release(id);
  }
  store.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
