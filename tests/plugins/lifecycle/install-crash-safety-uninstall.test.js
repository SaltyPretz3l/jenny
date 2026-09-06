'use strict';

// The uninstall half of the Stage-3 crash-safety sweep (split from
// install-crash-safety.test.js only to stay under the 600-line plugin-tree cap;
// the properties proven are the same set, plus one that only uninstall can
// show).
//
// The extra property: crashing anywhere in the CLEANUP tail must leave the
// uninstall COMMITTED. Authority left the moment the pointer flipped, and
// cleanup is best-effort work afterwards (PLUG-D17, invariant 20). A crash
// during cleanup is therefore indistinguishable, from an authority standpoint,
// from a cleanup that merely failed -- and neither may resurrect the plugin.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const { enumerateCrashPoints, runWithCrash } = require('../../helpers/plugins/crash-injecting-fs');
const { readCommittedState } = require('../../../services/plugins/lifecycle/commit-sequence');
const { recoverStore, listReceipts } = require('../../../services/plugins/lifecycle/recovery');
const { installPackage } = require('../../../services/plugins/lifecycle/install-operation');
const { uninstallPlugin } = require('../../../services/plugins/lifecycle/uninstall-operation');
const { STAGE_FORBIDDEN_STATES } = require('../../../services/plugins/lifecycle/stage-gate');
const { CLEANUP_ONLY_STATUSES } = require('../../../services/plugins/lifecycle/operation-result');
const { createVerifiedPackageVerifier } = require('../../helpers/plugins/durability-scenario');

const BASE_DIR = 'plugins';
const NOW = '2026-07-31T00:00:00Z';
const RECOVERY_NOW = '2026-07-31T02:00:00Z';

const SEED_GENERATION = 'gen-seed';
const TARGET_GENERATION = 'gen-target';
const TARGET_OPERATION = 'op-remove-1';
const SEED_EPOCH = 0;

// 41 commit-sequence boundaries + 5 each for the settling and terminal
// orthogonal cleanup-state writes.
const UNINSTALL_CRASH_POINTS = 51;
// The first boundary that belongs to the cleanup tail rather than to authority.
const FIRST_CLEANUP_BOUNDARY = 42;

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

async function buildStore() {
  const facade = createMemoryFsFacade();
  const seeded = await installPackage(facade, BASE_DIR, {
    packageBytes: 'seed-package-bytes',
    publisherId: 'acme',
    pluginId: 'alpha',
    verifyPackage: createVerifiedPackageVerifier({ publisherId: 'acme', pluginId: 'alpha', now: NOW }),
    requireConsent: async () => ({ ok: true }),
    newOperationId: idGenerator('op-seed'),
    now: NOW,
    lifecycleEpoch: 1,
    generationId: SEED_GENERATION,
    policyGrantRef: POLICY_GRANT_REF,
    dataSchemaRefs: DATA_SCHEMA_REFS,
  });
  if (!seeded.ok) throw new Error(`uninstall crash-safety seed failed: ${seeded.reason}`);
  return { facade, baseDir: BASE_DIR };
}

function uninstallOperation() {
  return async function operation(facade, baseDir) {
    return uninstallPlugin(facade, baseDir, {
      publisherId: 'acme',
      pluginId: 'alpha',
      requireConsent: async () => ({ ok: true }),
      newOperationId: idGenerator('op-remove'),
      now: NOW,
      lifecycleEpoch: 1,
      generationId: TARGET_GENERATION,
      policyGrantRef: POLICY_GRANT_REF,
      dataSchemaRefs: DATA_SCHEMA_REFS,
    });
  };
}

async function replayAndRecover(point, mode) {
  const { facade, baseDir } = await runWithCrash(buildStore, uninstallOperation(), point, mode);
  const report = await recoverStore(facade, baseDir, { now: RECOVERY_NOW });
  const state = await readCommittedState(facade, baseDir);
  const { receipts } = await listReceipts(facade, baseDir);
  return { facade, baseDir, report, state, receipts };
}

test('crash-point enumeration covers every durability boundary of a disabled-only uninstall', async () => {
  const { count, trace } = await enumerateCrashPoints(buildStore, uninstallOperation());

  // EXHAUSTIVE pin. A boundary added to the commit sequence OR to the cleanup
  // tail fails here instead of silently shrinking the sweep.
  assert.equal(count, UNINSTALL_CRASH_POINTS, 'uninstall durability-boundary count changed');
  assert.equal(trace.length, UNINSTALL_CRASH_POINTS);
  assert.equal(trace.filter((entry) => entry.endsWith(':writeFile')).length, 10);
  assert.equal(trace.filter((entry) => entry.endsWith(':remove')).length, 1);
  // Boundary 41 is the lease release that ends the authority-bearing work; the
  // settling and terminal cleanup-state writes are everything after it.
  assert.equal(trace[FIRST_CLEANUP_BOUNDARY - 2], '41:remove');
  assert.deepEqual(trace.slice(FIRST_CLEANUP_BOUNDARY - 1), [
    '42:mkdir', '43:writeFile', '44:fsyncFile', '45:renameFile', '46:fsyncDir',
    '47:mkdir', '48:writeFile', '49:fsyncFile', '50:renameFile', '51:fsyncDir',
  ]);
});

test('exhaustive sweep: every uninstall crash point recovers to exactly one complete generation', async () => {
  const outcomes = [];

  for (const mode of ['before', 'after']) {
    for (let point = 1; point <= UNINSTALL_CRASH_POINTS; point += 1) {
      const { report, state, receipts } = await replayAndRecover(point, mode);
      const where = `${mode}@${point}`;

      assert.ok(
        report.classification === 'consistent' || report.classification === 'recovered',
        `${where}: recovery must reach a usable state, got ${report.classification} (${report.reason || ''})`
      );
      assert.equal(state.pointerStatus, 'ok', `${where}: an active pointer must exist after recovery`);
      assert.ok(state.generation, `${where}: the pointed-at generation must be readable (${state.generationError})`);
      assert.ok(
        [SEED_GENERATION, TARGET_GENERATION].includes(state.pointer.generation_id),
        `${where}: fully-old or fully-new only, got ${state.pointer.generation_id}`
      );

      // Never a blend: alpha is either fully present or fully gone.
      const pluginIds = state.generation.plugins.map((entry) => entry.plugin_id);
      assert.deepEqual(
        pluginIds,
        state.pointer.generation_id === TARGET_GENERATION ? [] : ['alpha'],
        `${where}: mixed plugin graph ${pluginIds.join(',')}`
      );

      for (const entry of state.generation.plugins) {
        assert.ok(
          !STAGE_FORBIDDEN_STATES.includes(entry.effective_state),
          `${where}: ${entry.plugin_id} recovered into ${entry.effective_state}`
        );
      }

      assert.ok(state.pointer.commit_epoch >= SEED_EPOCH, `${where}: epoch regressed`);
      if (state.pointer.generation_id === TARGET_GENERATION) {
        assert.ok(state.pointer.commit_epoch > SEED_EPOCH, `${where}: the removal must carry a higher epoch`);
      }
      assert.deepEqual(
        receipts.filter((receipt) => receipt.status === 'pending').map((receipt) => receipt.operation_id),
        [],
        `${where}: a pending receipt survived recovery`
      );

      outcomes.push({ where, generation: state.pointer.generation_id });
    }
  }

  assert.equal(outcomes.length, UNINSTALL_CRASH_POINTS * 2);
  assert.ok(outcomes.some((item) => item.generation === TARGET_GENERATION), 'some crash points must land after the flip');
  assert.ok(outcomes.some((item) => item.generation === SEED_GENERATION), 'some crash points must land before the flip');
});

test('the uninstall receipt is decisive at every boundary: committed iff the flip landed', async () => {
  let seenCommitted = 0;
  let seenFailed = 0;

  for (const mode of ['before', 'after']) {
    for (let point = 1; point <= UNINSTALL_CRASH_POINTS; point += 1) {
      const { state, receipts } = await replayAndRecover(point, mode);
      const where = `${mode}@${point}`;
      const target = receipts.find((receipt) => receipt.operation_id === TARGET_OPERATION);
      if (!target) continue;

      if (state.pointer.generation_id === TARGET_GENERATION) {
        assert.equal(target.status, 'committed', `${where}: a landed flip must report committed`);
        seenCommitted += 1;
      } else {
        assert.equal(target.status, 'failed', `${where}: an unlanded flip must report failed, got ${target.status}`);
        seenFailed += 1;
      }
    }
  }

  assert.ok(seenCommitted > 0);
  assert.ok(seenFailed > 0);
});

test('a crash anywhere in the cleanup tail leaves the uninstall COMMITTED', async () => {
  // Authority is orthogonal to cleanup: once the pointer has flipped, losing
  // the machine mid-cleanup must not bring the plugin back.
  for (const mode of ['before', 'after']) {
    for (let point = FIRST_CLEANUP_BOUNDARY; point <= UNINSTALL_CRASH_POINTS; point += 1) {
      const { state, receipts } = await replayAndRecover(point, mode);
      const where = `cleanup ${mode}@${point}`;
      assert.equal(state.pointer.generation_id, TARGET_GENERATION, `${where}: the removal must stay committed`);
      assert.deepEqual(state.generation.plugins, [], `${where}: the plugin must stay gone`);
      const target = receipts.find((receipt) => receipt.operation_id === TARGET_OPERATION);
      assert.equal(target.status, 'committed', `${where}: the receipt must stay committed`);
    }
  }
});

test('a cleanup-only status never becomes an authority state under crash', async () => {
  // The vocabulary check, swept: nothing recovery reconstructs may put a
  // cleanup status where an authority state belongs.
  for (let point = 1; point <= UNINSTALL_CRASH_POINTS; point += 1) {
    const { state } = await replayAndRecover(point, 'after');
    for (const entry of state.generation.plugins) {
      assert.ok(
        !CLEANUP_ONLY_STATUSES.includes(entry.effective_state),
        `after@${point}: ${entry.plugin_id} carries a cleanup status as authority`
      );
      assert.ok(!CLEANUP_ONLY_STATUSES.includes(entry.desired_state));
    }
  }
});

test('a torn write at any atomic write of an uninstall never produces a mixed graph', async () => {
  const { trace } = await enumerateCrashPoints(buildStore, uninstallOperation());
  const writePoints = trace
    .filter((entry) => entry.endsWith(':writeFile'))
    .map((entry) => Number(entry.split(':')[0]));
  assert.equal(writePoints.length, 10);

  for (const point of writePoints) {
    const { facade, baseDir } = await runWithCrash(buildStore, uninstallOperation(), point, 'torn');
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
  }
});
