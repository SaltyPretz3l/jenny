'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createDiskAdmission, rewriteHeadroom, DISK_RESERVE_BYTES, DELETE_RESERVE_BYTES,
} = require('../../server/resource-limits');
const { flushSessionStoresAsync } = require('../../services/backend/session-store-drain');

test('disk admission fails closed for low space and unavailable filesystem status', () => {
  const seen = [];
  const paths = ['/profile', '/workspace'];
  const logger = (...entry) => seen.push(entry);
  assert.equal(createDiskAdmission(paths, { statfs: () => ({ bavail: DISK_RESERVE_BYTES, bsize: 1 }) })(), true);
  assert.equal(createDiskAdmission(paths, { statfs: () => ({ bavail: 0, bsize: 4096 }), logger })(), false);
  assert.equal(createDiskAdmission(paths, { statfs: () => { throw new Error('private path'); }, logger })(), false);
  assert.equal(JSON.stringify(seen).includes('private path'), false);
});

test('disk admission honors a smaller deletion reserve and rejects an invalid reserve', () => {
  const paths = ['/profile', '/workspace'];
  const free = (bytes) => () => ({ bavail: bytes, bsize: 1 });
  const admit = (bytes) => createDiskAdmission(paths, { reserveBytes: DELETE_RESERVE_BYTES, statfs: free(bytes) })();
  assert.equal(DELETE_RESERVE_BYTES, 8 * 1024 * 1024);
  assert.equal(admit(DELETE_RESERVE_BYTES), true);
  assert.equal(admit(DELETE_RESERVE_BYTES - 1), false);
  assert.equal(createDiskAdmission(paths, { statfs: free(DELETE_RESERVE_BYTES) })(), false);
  for (const reserveBytes of [0, -1, 1.5, '8', Number.NaN]) {
    assert.throws(() => createDiskAdmission(paths, { reserveBytes }), { code: 'CMP-HOST-0001' });
  }
});

test('the deletion reserve grows by the rewrite headroom of the receipt store', () => {
  const paths = ['/profile'];
  const free = (bytes) => () => ({ bavail: bytes, bsize: 1 });
  const receiptBytes = 20 * 1024 * 1024;
  const extraBytes = () => rewriteHeadroom('/profile/command-receipts.json', { stat: () => ({ size: receiptBytes }) });
  const admit = (bytes) => createDiskAdmission(paths, { reserveBytes: DELETE_RESERVE_BYTES, extraBytes, statfs: free(bytes) })();
  assert.equal(admit(DELETE_RESERVE_BYTES + (2 * receiptBytes)), true);
  assert.equal(admit(DELETE_RESERVE_BYTES + (2 * receiptBytes) - 1), false);
  assert.equal(rewriteHeadroom('/profile/missing.json', { stat: () => { throw new Error('ENOENT'); } }), 0);
});

test('host shutdown rejects incomplete canonical writes while desktop retains its best-effort contract', async () => {
  const sessionStore = { flushAsync: async () => {}, hasPendingWrites: () => true };
  await assert.rejects(flushSessionStoresAsync({ hostMode: 'server', sessionStore }), /host_store_flush_incomplete/);
  await assert.doesNotReject(flushSessionStoresAsync({ hostMode: 'desktop', sessionStore }));
});
