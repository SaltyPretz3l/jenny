'use strict';

// The Stage-3 exit proof: crash-safe DISABLED-ONLY install.
//
// This sweeps a crash at EVERY durability boundary of a full installPackage --
// content-store put plus the whole commit sequence -- in both "the write never
// landed" and "the write landed, then the machine died" modes, runs recoverStore
// after each one, and proves:
//
//   * the store is never in a mixed state (fully-old or fully-new, never a
//     blend), which is the architecture's own words for the property;
//   * commit_epoch never regresses across the crash + recovery, INCLUDING a
//     second crash after a recovery -- W4 found a real defect exactly there,
//     which is why commitRecoveredPointer writes the retained prior-pointer
//     slot BEFORE publishing the active pointer (active-pointer.js);
//   * an operation whose pointer flip landed is reported committed, and one
//     whose flip did not land is reported NOT committed -- never
//     "indeterminate" at a boundary where the evidence is decisive;
//   * no crash at any boundary leaves a plugin in `active` or `preparing`.
//
// Counts are pinned EXHAUSTIVELY (assert.equal, not assert.ok(n > k)): a floor
// catches neither an enumerator early-exit nor a silently changed boundary set.
//
// The uninstall half of the sweep lives in install-crash-safety-uninstall.js's
// sibling file to stay under the 600-line plugin-tree cap.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const {
  enumerateCrashPoints,
  runWithCrash,
  createCrashInjectingFs,
  isStoreCrash,
} = require('../../helpers/plugins/crash-injecting-fs');
const { readCommittedState } = require('../../../services/plugins/lifecycle/commit-sequence');
const { recoverStore, listReceipts } = require('../../../services/plugins/lifecycle/recovery');
const { installPackage } = require('../../../services/plugins/lifecycle/install-operation');
const { STAGE_FORBIDDEN_STATES } = require('../../../services/plugins/lifecycle/stage-gate');
const { POINTER_FILE, readActivePointer } = require('../../../services/plugins/store/active-pointer');
const { joinPath } = require('../../../services/plugins/store/fs-facade');
const { createVerifiedPackageVerifier } = require('../../helpers/plugins/durability-scenario');

const BASE_DIR = 'plugins';
const NOW = '2026-07-31T00:00:00Z';
const RECOVERY_NOW = '2026-07-31T02:00:00Z';
// Well past the 30s default lease, so a crashed operation's lease is
// reclaimable rather than blocking the follow-up commit forever.
const AFTER_LEASE_EXPIRY = '2026-07-31T03:00:00Z';

const SEED_GENERATION = 'gen-seed';
const TARGET_GENERATION = 'gen-target';
const TARGET_OPERATION = 'op-target-1';
const SEED_EPOCH = 0;

// One putContent, one immutable package-record write (five boundaries each),
// plus the 41-boundary commit sequence that crash-injection.test.js pins.
const INSTALL_CRASH_POINTS = 51;

const POLICY_GRANT_REF = Object.freeze({
  policy_snapshot_digest: 'b'.repeat(64),
  policy_revision: 1,
  grant_set_digest: 'c'.repeat(64),
});
const DATA_SCHEMA_REFS = Object.freeze([{ domain: 'alpha_state', schema_version: 1 }]);

function idGenerator(prefix) {
  let index = 0;
  return () => {
    index += 1;
    return `${prefix}-${index}`;
  };
}

function installArgs(overrides = {}) {
  const publisherId = overrides.publisherId || 'acme';
  const pluginId = overrides.pluginId || 'alpha';
  return {
    packageBytes: 'seed-package-bytes',
    verifyPackage: createVerifiedPackageVerifier({ publisherId, pluginId, now: overrides.now || NOW }),
    requireConsent: async () => ({ ok: true }),
    newOperationId: idGenerator('op-seed'),
    now: NOW,
    lifecycleEpoch: 1,
    generationId: SEED_GENERATION,
    policyGrantRef: POLICY_GRANT_REF,
    dataSchemaRefs: DATA_SCHEMA_REFS,
    ...overrides,
  };
}

// A FRESH store with one committed generation, rebuilt for every replay so each
// crash point starts from an identical pre-state.
async function buildStore() {
  const facade = createMemoryFsFacade();
  const seeded = await installPackage(facade, BASE_DIR, installArgs());
  if (!seeded.ok) throw new Error(`crash-safety seed install failed: ${seeded.reason}`);
  return { facade, baseDir: BASE_DIR };
}

// The operation under test: a full disabled-only install of a SECOND plugin.
function installOperation(overrides = {}) {
  return async function operation(facade, baseDir) {
    return installPackage(facade, baseDir, installArgs({
      pluginId: 'beta',
      packageBytes: 'beta-package-bytes',
      generationId: TARGET_GENERATION,
      newOperationId: idGenerator('op-target'),
      ...overrides,
    }));
  };
}

async function replayAndRecover(point, mode) {
  const { facade, baseDir } = await runWithCrash(buildStore, installOperation(), point, mode);
  const report = await recoverStore(facade, baseDir, { now: RECOVERY_NOW });
  const state = await readCommittedState(facade, baseDir);
  const { receipts } = await listReceipts(facade, baseDir);
  return { facade, baseDir, report, state, receipts };
}

test('crash-point enumeration covers every durability boundary of a disabled-only install', async () => {
  const { count, trace } = await enumerateCrashPoints(buildStore, installOperation());

  // EXHAUSTIVE pin, not a floor: a boundary added or removed anywhere in
  // putContent or the commit sequence fails here and forces a conscious update.
  assert.equal(count, INSTALL_CRASH_POINTS, 'install durability-boundary count changed');
  assert.equal(trace.length, INSTALL_CRASH_POINTS);

  // The content-store put is boundaries 1-5 and therefore strictly BEFORE the
  // generation record that references the digest -- the ordering rule this
  // operation exists to keep.
  assert.deepEqual(trace.slice(0, 5), ['1:mkdir', '2:writeFile', '3:fsyncFile', '4:renameFile', '5:fsyncDir']);
  assert.deepEqual(trace.slice(5, 10), ['6:mkdir', '7:writeFile', '8:fsyncFile', '9:renameFile', '10:fsyncDir']);
  assert.equal(trace.filter((entry) => entry.endsWith(':writeFile')).length, 10);
  assert.equal(trace.filter((entry) => entry.endsWith(':renameFile')).length, 10);
  assert.equal(trace.filter((entry) => entry.endsWith(':fsyncFile')).length, 10);
  assert.equal(trace.filter((entry) => entry.endsWith(':remove')).length, 1);
});

test('exhaustive sweep: every crash point recovers to exactly one complete generation', async () => {
  const outcomes = [];

  for (const mode of ['before', 'after']) {
    for (let point = 1; point <= INSTALL_CRASH_POINTS; point += 1) {
      const { report, state, receipts } = await replayAndRecover(point, mode);
      const where = `${mode}@${point}`;

      assert.ok(
        report.classification === 'consistent' || report.classification === 'recovered',
        `${where}: recovery must reach a usable state, got ${report.classification} (${report.reason || ''})`
      );
      assert.equal(state.pointerStatus, 'ok', `${where}: an active pointer must exist after recovery`);
      assert.ok(state.generation, `${where}: the pointed-at generation must be readable (${state.generationError})`);
      assert.equal(state.generation.generation_id, state.pointer.generation_id, `${where}: pointer/generation disagree`);
      assert.ok(
        [SEED_GENERATION, TARGET_GENERATION].includes(state.pointer.generation_id),
        `${where}: fully-old or fully-new only, got ${state.pointer.generation_id}`
      );

      // Never a blend: the committed plugin set is exactly one of the two.
      const pluginIds = state.generation.plugins.map((entry) => entry.plugin_id).sort();
      assert.deepEqual(
        pluginIds,
        state.pointer.generation_id === TARGET_GENERATION ? ['alpha', 'beta'] : ['alpha'],
        `${where}: mixed plugin graph ${pluginIds.join(',')}`
      );

      // No crash may leave a plugin activation-adjacent.
      for (const entry of state.generation.plugins) {
        assert.ok(
          !STAGE_FORBIDDEN_STATES.includes(entry.effective_state),
          `${where}: ${entry.plugin_id} recovered into ${entry.effective_state}`
        );
        assert.equal(entry.effective_state, 'installed_disabled', `${where}: not disabled-only`);
      }

      // Epoch never regresses, and a landed commit always carries a higher one.
      assert.ok(state.pointer.commit_epoch >= SEED_EPOCH, `${where}: epoch regressed`);
      if (state.pointer.generation_id === TARGET_GENERATION) {
        assert.ok(state.pointer.commit_epoch > SEED_EPOCH, `${where}: the new generation must carry a higher epoch`);
      }

      // Recovery finishes or abandons every staged operation.
      assert.deepEqual(
        receipts.filter((receipt) => receipt.status === 'pending').map((receipt) => receipt.operation_id),
        [],
        `${where}: a pending receipt survived recovery`
      );

      outcomes.push({ where, generation: state.pointer.generation_id });
    }
  }

  assert.equal(outcomes.length, INSTALL_CRASH_POINTS * 2, 'every crash point must be replayed in both modes');
  // Both halves of the dichotomy must actually occur, or the sweep could be
  // passing because nothing ever committed.
  assert.ok(outcomes.some((item) => item.generation === TARGET_GENERATION), 'some crash points must land after the flip');
  assert.ok(outcomes.some((item) => item.generation === SEED_GENERATION), 'some crash points must land before the flip');
});

test('the target receipt is decisive at every boundary: committed iff the flip landed', async () => {
  let seenCommitted = 0;
  let seenFailed = 0;

  for (const mode of ['before', 'after']) {
    for (let point = 1; point <= INSTALL_CRASH_POINTS; point += 1) {
      const { state, receipts } = await replayAndRecover(point, mode);
      const where = `${mode}@${point}`;
      const target = receipts.find((receipt) => receipt.operation_id === TARGET_OPERATION);
      if (!target) continue;

      if (state.pointer.generation_id === TARGET_GENERATION) {
        assert.equal(target.status, 'committed', `${where}: a landed flip must report committed`);
        seenCommitted += 1;
      } else {
        // Decisive, not "indeterminate": the pointer's epoch is strictly below
        // the epoch this receipt intended, which proves the flip never landed.
        assert.equal(target.status, 'failed', `${where}: an unlanded flip must report failed, got ${target.status}`);
        seenFailed += 1;
      }
    }
  }

  assert.ok(seenCommitted > 0, 'the sweep must observe landed commits');
  assert.ok(seenFailed > 0, 'the sweep must observe unlanded commits');
});

test('a second crash after a recovery still never regresses the epoch', async () => {
  for (let point = 1; point <= INSTALL_CRASH_POINTS; point += 1) {
    const first = await replayAndRecover(point, 'after');
    const epochAfterFirst = first.state.pointer.commit_epoch;

    // A follow-up install that ALSO crashes, at the same boundary index, and is
    // then recovered a second time. This is the double-fault case: one recovery
    // must not leave evidence a later recovery can read as a LOWER high-water.
    const injecting = createCrashInjectingFs(first.facade, { crashAfterMutation: point });
    let result = null;
    try {
      result = await installPackage(injecting, first.baseDir, installArgs({
        pluginId: 'gamma',
        packageBytes: 'gamma-package-bytes',
        generationId: 'gen-followup',
        newOperationId: idGenerator('op-followup'),
        now: AFTER_LEASE_EXPIRY,
      }));
    } catch (error) {
      if (!isStoreCrash(error)) throw error;
    }

    const report = await recoverStore(first.facade, first.baseDir, { now: AFTER_LEASE_EXPIRY });
    const after = await readCommittedState(first.facade, first.baseDir);
    assert.ok(
      report.classification === 'consistent' || report.classification === 'recovered',
      `after@${point}: second recovery classified ${report.classification}`
    );
    assert.ok(
      after.pointer.commit_epoch >= epochAfterFirst,
      `after@${point}: epoch regressed ${epochAfterFirst} -> ${after.pointer.commit_epoch}`
    );
    if (result && result.ok) {
      assert.ok(
        result.commitEpoch > epochAfterFirst,
        `after@${point}: a successful follow-up must advance the epoch`
      );
    }
  }
});

test('a double pointer loss never regresses the epoch (retained prior-pointer slot)', async () => {
  // The exact shape of W4's memoized defect: recovery must leave the prior-
  // pointer witness HIGH, so a SECOND loss cannot derive a high-water below an
  // epoch the first recovery already minted.
  const { facade, baseDir } = await buildStore();
  await installPackage(facade, baseDir, installArgs({
    pluginId: 'beta',
    packageBytes: 'beta-package-bytes',
    generationId: TARGET_GENERATION,
    newOperationId: idGenerator('op-target'),
  }));

  const beforeLoss = (await readActivePointer(facade, baseDir)).pointer.commit_epoch;

  await facade.remove(joinPath(baseDir, POINTER_FILE));
  const firstRecovery = await recoverStore(facade, baseDir, { now: RECOVERY_NOW });
  assert.equal(firstRecovery.classification, 'recovered', firstRecovery.reason || '');
  const afterFirst = firstRecovery.pointer.commit_epoch;
  assert.ok(afterFirst > beforeLoss, `first recovery must advance the epoch (${beforeLoss} -> ${afterFirst})`);

  await facade.remove(joinPath(baseDir, POINTER_FILE));
  const secondRecovery = await recoverStore(facade, baseDir, { now: AFTER_LEASE_EXPIRY });
  assert.equal(secondRecovery.classification, 'recovered', secondRecovery.reason || '');
  assert.ok(
    secondRecovery.pointer.commit_epoch > afterFirst,
    `second recovery regressed ${afterFirst} -> ${secondRecovery.pointer.commit_epoch}`
  );

  const state = await readCommittedState(facade, baseDir);
  for (const entry of state.generation.plugins) {
    assert.equal(entry.effective_state, 'installed_disabled', 'recovery must never activate a plugin');
  }
});

test('a torn write at any atomic write never produces a mixed graph', async () => {
  const { trace } = await enumerateCrashPoints(buildStore, installOperation());
  const writePoints = trace
    .filter((entry) => entry.endsWith(':writeFile'))
    .map((entry) => Number(entry.split(':')[0]));
  assert.equal(writePoints.length, 10, 'every atomic write must be torn-testable');

  for (const point of writePoints) {
    const { facade, baseDir } = await runWithCrash(buildStore, installOperation(), point, 'torn');
    const report = await recoverStore(facade, baseDir, { now: RECOVERY_NOW });
    const state = await readCommittedState(facade, baseDir);
    assert.ok(
      report.classification === 'consistent' || report.classification === 'recovered',
      `torn@${point}: ${report.classification} ${report.reason || ''}`
    );
    assert.ok(state.generation, `torn@${point}: generation unreadable (${state.generationError})`);
    assert.ok(
      [SEED_GENERATION, TARGET_GENERATION].includes(state.pointer.generation_id),
      `torn@${point}: mixed graph`
    );
    for (const entry of state.generation.plugins) {
      assert.equal(entry.effective_state, 'installed_disabled', `torn@${point}: not disabled-only`);
    }
  }
});
