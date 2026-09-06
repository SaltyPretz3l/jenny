'use strict';

// PLUG-D19: "`commit_epoch` recovery after pointer loss derives from the maximum
// durable epoch across receipts, journal, and retained generations plus a
// recorded safety increment; pointer corruption never resets epoch
// monotonicity."
//
// The acceptance-matrix row this suite discharges: "active-pointer loss with
// epoch high-water recovery (proving recovered epochs never collide with
// previously minted epochs)". Collision is the actual danger -- a reused epoch
// revives tokens, approvals, views, and progress streams that were fenced when
// their epoch was retired -- so every test below asserts strict dominance over
// EVERY epoch the store ever minted, not merely over the last one seen.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMemoryFsFacade, joinPath } = require('../../../services/plugins/store/fs-facade');
const { runCommitSequence } = require('../../../services/plugins/lifecycle/commit-sequence');
const { recoverStore, gatherEpochEvidence } = require('../../../services/plugins/lifecycle/recovery');
const { readActivePointer, POINTER_FILE, PRIOR_POINTER_FILE } = require('../../../services/plugins/store/active-pointer');
const { writeGeneration } = require('../../../services/plugins/store/generation-store');
const { JOURNAL_FILE } = require('../../../services/plugins/store/journal');
const { createPendingReceipt, OPERATIONS_DIR } = require('../../../services/plugins/store/operation-receipts');
const { commitInput, BASE_DIR } = require('../../helpers/plugins/durability-scenario');

const RECOVERY_NOW = '2026-07-31T05:00:00Z';

// Builds a store with `commits` sequential generations and returns every epoch
// that was actually minted, so tests can assert against the full history.
async function buildHistory(commits) {
  const facade = createMemoryFsFacade();
  const mintedEpochs = [];
  for (let index = 0; index < commits; index += 1) {
    const result = await runCommitSequence(facade, BASE_DIR, commitInput(`gen-${index}`, {
      operationId: `op-${index}`,
      now: `2026-07-31T0${index}:00:00Z`,
    }));
    assert.equal(result.ok, true, `seed commit ${index} failed: ${result.reason}`);
    mintedEpochs.push(result.commitEpoch);
  }
  return { facade, mintedEpochs };
}

async function deletePointer(facade) {
  await facade.remove(joinPath(BASE_DIR, POINTER_FILE));
}

async function corruptPointer(facade) {
  await facade.writeFile(joinPath(BASE_DIR, POINTER_FILE), '{"registry_schema_version": 1, truncated');
}

test('a deleted pointer recovers to an epoch strictly above every minted epoch', async () => {
  const { facade, mintedEpochs } = await buildHistory(4);
  assert.deepEqual(mintedEpochs, [0, 1, 2, 3]);

  await deletePointer(facade);
  assert.equal((await readActivePointer(facade, BASE_DIR)).status, 'missing');

  const report = await recoverStore(facade, BASE_DIR, { now: RECOVERY_NOW });
  assert.equal(report.classification, 'recovered', report.reason || '');

  const recovered = report.pointer.commit_epoch;
  for (const minted of mintedEpochs) {
    assert.ok(recovered > minted, `recovered epoch ${recovered} must exceed minted epoch ${minted}`);
  }
  // max evidence (3) + 1 + default safety increment (1) = 5.
  assert.equal(recovered, 5);
  assert.equal(report.epochEvidence.recoveredEpoch, 5);
});

test('a corrupted pointer recovers identically -- corruption never resets monotonicity', async () => {
  const { facade, mintedEpochs } = await buildHistory(3);
  await corruptPointer(facade);
  assert.equal((await readActivePointer(facade, BASE_DIR)).status, 'corrupted');

  const report = await recoverStore(facade, BASE_DIR, { now: RECOVERY_NOW });
  assert.equal(report.classification, 'recovered', report.reason || '');
  assert.ok(report.pointer.commit_epoch > Math.max(...mintedEpochs));
});

test('pointer loss with a corrupt receipt never promotes an uncommitted retained generation', async () => {
  const facade = createMemoryFsFacade();
  const committed = await runCommitSequence(facade, BASE_DIR,
    commitInput('gen-old', { operationId: 'op-old', now: '2026-07-31T01:00:00Z' }));
  assert.equal(committed.ok, true);
  const staged = commitInput('gen-uncommitted-new', {
    operationId: 'op-new', now: '2026-07-31T02:00:00Z', createdAt: '2026-07-31T02:00:00Z',
  });
  assert.equal((await createPendingReceipt(facade, BASE_DIR, {
    operationId: staged.operationId,
    requestFingerprint: staged.requestFingerprint,
    generationId: staged.generationId,
    lifecycleEpoch: staged.lifecycleEpoch,
    commitEpoch: committed.commitEpoch + 1,
    now: staged.now,
  })).ok, true);
  assert.equal((await writeGeneration(facade, BASE_DIR, staged)).ok, true);
  await facade.writeFile(joinPath(BASE_DIR, OPERATIONS_DIR, 'op-new.json'), '{corrupt');
  await deletePointer(facade);

  const report = await recoverStore(facade, BASE_DIR, { now: RECOVERY_NOW });
  assert.equal(report.classification, 'plugins_disabled_required');
  assert.equal(report.reason, 'operation_receipt_corrupted');
  assert.equal(report.pointer, null);
  assert.equal(report.epochEvidence.corruptReceiptCount, 1);
});

test('the recovered revision advances past every revision in evidence', async () => {
  const { facade } = await buildHistory(4);
  const evidenceBefore = await gatherEpochEvidence(facade, BASE_DIR);
  await deletePointer(facade);

  const report = await recoverStore(facade, BASE_DIR, { now: RECOVERY_NOW });
  assert.equal(report.classification, 'recovered');
  assert.ok(
    report.pointer.revision > evidenceBefore.maxRevision,
    `revision ${report.pointer.revision} must exceed observed max ${evidenceBefore.maxRevision}`
  );
});

test('recovery still dominates when the journal is destroyed (receipts carry the high-water)', async () => {
  const { facade, mintedEpochs } = await buildHistory(4);
  await deletePointer(facade);
  await facade.remove(joinPath(BASE_DIR, JOURNAL_FILE));

  const evidence = await gatherEpochEvidence(facade, BASE_DIR);
  assert.equal(evidence.sources.journal, 0, 'journal evidence must be gone');
  assert.ok(evidence.sources.receipts > 0, 'receipts must still carry epochs');

  const report = await recoverStore(facade, BASE_DIR, { now: RECOVERY_NOW });
  assert.equal(report.classification, 'recovered', report.reason || '');
  assert.ok(report.pointer.commit_epoch > Math.max(...mintedEpochs));
});

test('recovery still dominates when every receipt is destroyed (journal carries the high-water)', async () => {
  const { facade, mintedEpochs } = await buildHistory(4);
  await deletePointer(facade);
  for (const name of await facade.list(joinPath(BASE_DIR, OPERATIONS_DIR))) {
    await facade.remove(joinPath(BASE_DIR, OPERATIONS_DIR, name));
  }

  const evidence = await gatherEpochEvidence(facade, BASE_DIR);
  assert.equal(evidence.sources.receipts, 0, 'receipt evidence must be gone');
  assert.ok(evidence.sources.journal > 0, 'journal must still carry epochs');

  const report = await recoverStore(facade, BASE_DIR, { now: RECOVERY_NOW });
  assert.equal(report.classification, 'recovered', report.reason || '');
  assert.ok(report.pointer.commit_epoch > Math.max(...mintedEpochs));
});

test('recovery still dominates when only the retained prior pointer survives', async () => {
  const { facade, mintedEpochs } = await buildHistory(4);
  await deletePointer(facade);
  await facade.remove(joinPath(BASE_DIR, JOURNAL_FILE));
  for (const name of await facade.list(joinPath(BASE_DIR, OPERATIONS_DIR))) {
    await facade.remove(joinPath(BASE_DIR, OPERATIONS_DIR, name));
  }

  const evidence = await gatherEpochEvidence(facade, BASE_DIR);
  assert.equal(evidence.sources.priorPointer, 1, 'only the prior pointer should remain');
  assert.equal(evidence.sources.receipts + evidence.sources.journal, 0);

  const report = await recoverStore(facade, BASE_DIR, { now: RECOVERY_NOW });
  assert.equal(report.classification, 'recovered', report.reason || '');
  // The prior pointer records epoch 2 (the generation superseded by epoch 3),
  // so the safety increment is what keeps the result above the lost epoch 3.
  assert.ok(
    report.pointer.commit_epoch > Math.max(...mintedEpochs),
    `recovered ${report.pointer.commit_epoch} must exceed all of ${mintedEpochs.join(',')}`
  );
});

test('total epoch-evidence loss fails closed instead of minting a colliding epoch', async () => {
  // A retained generation proves epochs WERE minted; losing every source that
  // records how high they climbed makes the high-water unreconstructable. The
  // only safe move is the plugins-disabled generation -- guessing low would
  // revive authority fenced under a previously minted epoch.
  const { facade } = await buildHistory(4);
  await deletePointer(facade);
  await facade.remove(joinPath(BASE_DIR, PRIOR_POINTER_FILE));
  await facade.remove(joinPath(BASE_DIR, JOURNAL_FILE));
  for (const name of await facade.list(joinPath(BASE_DIR, OPERATIONS_DIR))) {
    await facade.remove(joinPath(BASE_DIR, OPERATIONS_DIR, name));
  }

  const evidence = await gatherEpochEvidence(facade, BASE_DIR);
  assert.equal(evidence.epochs.length, 0, 'the scenario requires zero epoch evidence');

  const report = await recoverStore(facade, BASE_DIR, { now: RECOVERY_NOW });
  assert.equal(report.classification, 'plugins_disabled_required');
  assert.equal(report.reason, 'epoch_evidence_lost');
  assert.equal(report.pointer, null, 'no pointer may be minted without an epoch high-water');
});

test('repeated pointer loss never regresses below an epoch a prior recovery minted', async () => {
  // Regression guard. Recovery used to publish its recovered pointer without
  // refreshing the retained prior pointer, so a SECOND loss that left only the
  // prior pointer as evidence derived its high-water from the stale pre-
  // recovery epoch: the sequence minted 0,1,2,3 then recovered to 5, and a
  // second loss recovered to 4 -- below an epoch already handed out.
  const { facade, mintedEpochs } = await buildHistory(4);
  const minted = [...mintedEpochs];

  await deletePointer(facade);
  const first = await recoverStore(facade, BASE_DIR, { now: RECOVERY_NOW });
  assert.equal(first.classification, 'recovered');
  minted.push(first.pointer.commit_epoch);

  // Second loss, with every witness except the retained prior pointer gone.
  await deletePointer(facade);
  await facade.remove(joinPath(BASE_DIR, JOURNAL_FILE));
  for (const name of await facade.list(joinPath(BASE_DIR, OPERATIONS_DIR))) {
    await facade.remove(joinPath(BASE_DIR, OPERATIONS_DIR, name));
  }

  const second = await recoverStore(facade, BASE_DIR, { now: '2026-07-31T07:00:00Z' });
  assert.equal(second.classification, 'recovered', second.reason || '');
  for (const epoch of minted) {
    assert.ok(
      second.pointer.commit_epoch > epoch,
      `second recovery minted ${second.pointer.commit_epoch}, colliding with previously minted ${epoch}`
    );
  }
});

test('a larger safety increment is honoured and recorded', async () => {
  const { facade, mintedEpochs } = await buildHistory(3);
  await deletePointer(facade);

  const report = await recoverStore(facade, BASE_DIR, { now: RECOVERY_NOW, safetyIncrement: 100 });
  assert.equal(report.classification, 'recovered');
  assert.equal(report.pointer.commit_epoch, Math.max(...mintedEpochs) + 1 + 100);
  assert.equal(report.epochEvidence.recoveredEpoch, report.pointer.commit_epoch);
});

test('recovery refuses to overwrite an intact pointer', async () => {
  const { facade } = await buildHistory(2);
  const before = await readActivePointer(facade, BASE_DIR);
  const report = await recoverStore(facade, BASE_DIR, { now: RECOVERY_NOW });
  assert.equal(report.classification, 'consistent');
  const after = await readActivePointer(facade, BASE_DIR);
  assert.deepEqual(after.pointer, before.pointer, 'a healthy pointer must be left exactly as-is');
});

test('a further commit after recovery keeps advancing from the recovered epoch', async () => {
  const { facade, mintedEpochs } = await buildHistory(3);
  await deletePointer(facade);
  const report = await recoverStore(facade, BASE_DIR, { now: RECOVERY_NOW });
  assert.equal(report.classification, 'recovered');

  const next = await runCommitSequence(facade, BASE_DIR, commitInput('gen-post-recovery', {
    operationId: 'op-post-recovery',
    now: '2026-07-31T06:00:00Z',
  }));
  assert.equal(next.ok, true, next.reason);
  assert.equal(next.commitEpoch, report.pointer.commit_epoch + 1);
  for (const minted of mintedEpochs) {
    assert.ok(next.commitEpoch > minted);
  }
});
