'use strict';

// Receipt generation attribution is the recovery authority. Epoch equality is
// insufficient because a competitor can land the same intended epoch; the
// required generation_id makes the distinction durable without inferring it
// from a bounded journal.

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeStoreFactory, commitOperation, LATER } = require('../../helpers/plugins/durability-scenario');
const { recoverStore } = require('../../../services/plugins/lifecycle/recovery');
const { readActivePointer } = require('../../../services/plugins/store/active-pointer');
const { createPendingReceipt, getReceipt } = require('../../../services/plugins/store/operation-receipts');

const RECOVERY_NOW = '2026-07-31T09:00:00Z';
const LOSER_FINGERPRINT = 'd'.repeat(64);

// A store whose pointer sits at a genuinely landed commit, with the journal
// row that attributes that epoch to the operation which landed it.
async function storeWithLandedCommit() {
  const { facade, baseDir } = await makeStoreFactory({ priorCommits: 1 })();
  const result = await commitOperation('gen-target', { operationId: 'op-winner' })(facade, baseDir);
  assert.equal(result.ok, true, `setup: the winning commit must land (${result.reason || ''})`);

  const pointer = await readActivePointer(facade, baseDir);
  assert.equal(pointer.status, 'ok', 'setup: the pointer must be readable');
  return { facade, baseDir, epoch: pointer.pointer.commit_epoch };
}

test('a pending receipt naming another generation settles failed even at the pointer epoch', async () => {
  const { facade, baseDir, epoch } = await storeWithLandedCommit();

  // op-loser intended exactly the epoch op-winner actually landed, then died
  // before writing anything of its own. Epoch equality alone calls this
  // committed; the journal says the epoch belongs to someone else.
  const pending = await createPendingReceipt(facade, baseDir, {
    operationId: 'op-loser',
    requestFingerprint: LOSER_FINGERPRINT,
    lifecycleEpoch: 1,
    commitEpoch: epoch,
    generationId: 'gen-loser',
    now: LATER,
  });
  assert.equal(pending.ok, true, 'setup: the pending receipt must be written');

  const report = await recoverStore(facade, baseDir, { now: RECOVERY_NOW });

  const loser = report.reconciled.find((item) => item.operationId === 'op-loser');
  assert.ok(loser, 'the pending receipt must be reconciled');
  assert.equal(
    loser.status,
    'failed',
    'an epoch the journal attributes to a competitor must never report committed',
  );

  // And the verdict must be durable, not just reported: a caller that re-reads
  // the receipt has to see the same answer.
  const settled = await getReceipt(facade, baseDir, 'op-loser');
  assert.equal(settled.found, true);
  assert.equal(settled.receipt.status, 'failed');
});

test('generation attribution matches exactly, not by prefix', async () => {
  const { facade, baseDir, epoch } = await storeWithLandedCommit();

  // `op-winner-retry` has the attributed id as a strict prefix. A membership
  // check written with `startsWith`, or a journal scan comparing truncated
  // ids, would hand this receipt the winner's verdict -- which is the same
  // false "you committed" the epoch-equality bug produced, just reached a
  // different way.
  const pending = await createPendingReceipt(facade, baseDir, {
    operationId: 'op-winner-retry',
    requestFingerprint: LOSER_FINGERPRINT,
    lifecycleEpoch: 1,
    commitEpoch: epoch,
    generationId: 'gen-target-retry',
    now: LATER,
  });
  assert.equal(pending.ok, true, 'setup: the pending receipt must be written');

  const report = await recoverStore(facade, baseDir, { now: RECOVERY_NOW });
  const other = report.reconciled.find((item) => item.operationId === 'op-winner-retry');
  assert.ok(other, 'the pending receipt must be reconciled');
  assert.equal(
    other.status,
    'failed',
    'an id absent from the epoch attribution is a competitor, however it is spelled',
  );
});
