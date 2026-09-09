'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDiskAdmission, DISK_RESERVE_BYTES } = require('../../server/resource-limits');
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

test('host shutdown rejects incomplete canonical writes while desktop retains its best-effort contract', async () => {
  const sessionStore = { flushAsync: async () => {}, hasPendingWrites: () => true };
  await assert.rejects(flushSessionStoresAsync({ hostMode: 'server', sessionStore }), /host_store_flush_incomplete/);
  await assert.doesNotReject(flushSessionStoresAsync({ hostMode: 'desktop', sessionStore }));
});
