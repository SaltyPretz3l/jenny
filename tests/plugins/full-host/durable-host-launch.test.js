'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const { FullHostCleanupReceiptStore, FILE_NAME, MAX_RECEIPTS } = require(
  '../../../services/plugins/full-host/cleanup-receipt-store'
);
const { createDurableHostLaunch } = require('../../../services/plugins/full-host/durable-host-launch');

const identity = { session_id: 'session-a', session_epoch: 2,
  publisher_id: 'publisher', plugin_id: 'plugin', contribution_id: 'host',
  authority: { active_generation_id: 'generation-a', commit_epoch: 3 } };
const proof = { ok: true, terminated: true, tree_empty: true,
  resource_cleanup: { required: true, cleanup: 'confirmed', process_tree_terminated: true,
    output_readers_terminated: true } };

function harness(supervisor) {
  const facade = createMemoryFsFacade();
  const store = new FullHostCleanupReceiptStore({ facade, baseDir: 'plugins' });
  return { facade, store, host: createDurableHostLaunch({ cleanupStore: store, supervisor }),
    restart: () => new FullHostCleanupReceiptStore({ facade, baseDir: 'plugins' }) };
}

test('launch reserves durable exact identity before producer and retains it until proven cleanup', async () => {
  const h = harness({ start: async () => {
    assert.equal((await h.restart().list()).receipts[0].session_id, identity.session_id);
    assert.deepEqual((await h.store.list()).receipts, [], 'live reservations are not cleanup candidates');
    return { ok: true };
  }, terminate: async () => proof });
  assert.equal((await h.host.start({}, identity)).ok, true);
  assert.equal((await h.restart().list()).receipts.length, 1);
  assert.equal((await h.host.terminate(identity)).ok, true);
  assert.deepEqual((await h.restart().list()).receipts, []);
});

test('full table, corrupt state and failed reservation writes refuse before launch', async () => {
  for (const mode of ['full', 'corrupt', 'write']) {
    let starts = 0;
    const h = harness({ start: async () => { starts++; return { ok: true }; } });
    await h.facade.mkdir('plugins/runtime');
    if (mode === 'full') await h.facade.writeFile(`plugins/runtime/${FILE_NAME}`, JSON.stringify({
      schema_version: 1, receipts: Array.from({ length: MAX_RECEIPTS }, (_, n) => ({
        session_id: `old-${n}`, session_epoch: 1,
      })),
    }));
    if (mode === 'corrupt') await h.facade.writeFile(`plugins/runtime/${FILE_NAME}`, '{');
    if (mode === 'write') h.facade.writeFile = async () => { throw new Error('disk unavailable'); };
    assert.equal((await h.host.start({}, identity)).no_start, true);
    assert.equal(starts, 0, mode);
  }
});

test('failed uncertain-outcome update preserves reservation and reports persistence failure', async () => {
  const h = harness({ start: async () => {
    h.facade.writeFile = async () => { throw new Error('disk unavailable'); };
    throw new Error('transport lost after spawn');
  } });
  const result = await h.host.start({}, identity);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'host_cleanup_persistence_failed');
  assert.equal(result.no_start, undefined);
  const receipts = (await h.store.list()).receipts;
  assert.equal(receipts.length, 1, 'failed update exposes original reservation for reconciliation');
  assert.equal(receipts[0].session_id, identity.session_id);
  assert.equal(receipts[0].session_epoch, identity.session_epoch);
  assert.equal((await h.restart().list()).receipts.length, 1);
});

test('uncertain termination retains launch authority and exact epoch; late proof settles once', async () => {
  let terminated = false;
  const h = harness({ start: async () => ({ ok: true }),
    terminate: async () => terminated ? proof : { ok: false, terminated: true, tree_empty: false } });
  await h.host.start({}, identity);
  const request = { session_id: identity.session_id, session_epoch: identity.session_epoch };
  await h.host.terminate(request);
  const saved = (await h.restart().list()).receipts[0];
  assert.equal(saved.publisher_id, identity.publisher_id);
  assert.equal(saved.active_generation_id, identity.authority.active_generation_id);
  terminated = true;
  await h.host.terminate({ ...request, session_epoch: 3 });
  assert.equal((await h.restart().list()).receipts.length, 1, 'wrong epoch does not settle evidence');
  await h.host.terminate(request);
  await h.host.terminate(request);
  assert.deepEqual((await h.restart().list()).receipts, []);
});

test('live reservations count against capacity and duplicate reservation cannot authorize another launch', async () => {
  let starts = 0;
  const h = harness({ start: async () => { starts++; return { ok: true }; } });
  await h.host.start({}, identity);
  assert.equal((await h.host.start({}, identity)).reason, 'cleanup_receipt_identity_exists');
  assert.equal(starts, 1);
  for (let i = 1; i < MAX_RECEIPTS; i++) {
    assert.equal((await h.store.reserve({ session: { session_id: `other-${i}`, session_epoch: 1 } })).ok, true);
  }
  assert.equal((await h.store.reserve({ session: { session_id: 'overflow', session_epoch: 1 } })).ok, false);
  assert.deepEqual((await h.store.list()).receipts, []);
  assert.equal((await h.restart().list()).receipts.length, MAX_RECEIPTS);
});

test('confirmed no-start releases reservation; failed settlement is visible and retained', async () => {
  const h = harness({ start: async () => ({ ok: false, no_start: true, reason: 'capacity' }) });
  assert.equal((await h.host.start({}, identity)).reason, 'capacity');
  assert.deepEqual((await h.restart().list()).receipts, []);
  const fault = harness({ start: async () => {
    fault.facade.writeFile = async () => { throw new Error('disk unavailable'); };
    return { ok: false, no_start: true, reason: 'capacity' };
  } });
  assert.equal((await fault.host.start({}, identity)).cleanup_persistence.ok, false);
  assert.equal((await fault.store.list()).receipts.length, 1);
});

test('native cleanup proof is acknowledged only after a durable receipt settlement succeeds', async () => {
  const acknowledgements = [];
  const h = harness({ start: async () => ({ ok: true }), terminate: async () => proof,
    acknowledgeTermination: async (value) => {
      assert.deepEqual((await h.restart().list()).receipts, []);
      acknowledgements.push(value);
    } });
  await h.host.start({}, identity);
  const write = h.facade.writeFile;
  h.facade.writeFile = async () => { throw new Error('disk unavailable'); };
  assert.equal((await h.host.terminate(identity)).cleanup_persistence.ok, false);
  assert.equal(acknowledgements.length, 0);
  assert.equal((await h.restart().list()).receipts.length, 1);
  h.facade.writeFile = write;
  assert.equal((await h.host.terminate(identity)).ok, true);
  assert.deepEqual(acknowledgements, [identity]);
});
