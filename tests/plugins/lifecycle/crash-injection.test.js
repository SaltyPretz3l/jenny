'use strict';

// The W4 crash-injection sweep: run one full durable commit against W3's REAL
// store modules (PLUG-D22 -- no simulator), crashing at EVERY write / rename /
// fsync boundary, in both "the write never landed" and "the write landed, then
// the machine died" modes, then run recovery and prove the store is never in a
// mixed state.
//
// The single property everything below reduces to, from
// PLUGIN_SYSTEM_ARCHITECTURE_AND_ROADMAP.md: "crash injection, and startup
// reconciliation must prove either the old or new complete generation, never a
// mixed graph."

const test = require('node:test');
const assert = require('node:assert/strict');

const { enumerateCrashPoints, runWithCrash } = require('../../helpers/plugins/crash-injecting-fs');
const { makeStoreFactory, commitOperation, inspect, BASE_DIR, LATER } = require('../../helpers/plugins/durability-scenario');
const { recoverStore, listReceipts } = require('../../../services/plugins/lifecycle/recovery');
const { readJournal } = require('../../../services/plugins/store/journal');

const RECOVERY_NOW = '2026-07-31T02:00:00Z';
const SEED_EPOCH = 0;
const SEED_GENERATION = 'gen-0';
const TARGET_GENERATION = 'gen-target';

function buildFactory() {
  return makeStoreFactory({ priorCommits: 1 });
}

// One crash replay + recovery, reduced to the facts every assertion needs.
async function replayAndRecover(point, mode) {
  const build = buildFactory();
  const { facade, baseDir, crashed, crashInfo } = await runWithCrash(
    build, commitOperation(TARGET_GENERATION), point, mode
  );
  // A replay in which the fault never fired proves nothing about crash safety.
  // Before the facade latched, crashing at any journal or audit boundary let
  // appendEvidence's degraded-observability try/catch swallow the fault and the
  // commit ran to completion -- 10 of 41 boundaries in each mode were counted as
  // covered while replaying an ordinary successful commit.
  assert.equal(crashed, true, `${mode}@${point}: the injected fault never fired`);
  assert.equal(crashInfo.point, point, `${mode}@${point}: fault fired at ${crashInfo.point}, not the requested boundary`);
  const { entries } = await readJournal(facade, baseDir);
  const report = await recoverStore(facade, baseDir, { now: RECOVERY_NOW });
  const state = await inspect(facade, baseDir);
  const { receipts } = await listReceipts(facade, baseDir);
  return { facade, baseDir, report, state, receipts, journalBeforeRecovery: entries };
}

test('crash-point enumeration covers every durability boundary of a commit', async () => {
  const { count, trace } = await enumerateCrashPoints(buildFactory(), commitOperation(TARGET_GENERATION));
  // A commit is 8 atomic writes (prior pointer, pointer, receipt x2, generation,
  // lease x2, journal, audit) plus the lease removal. Pinning the count means a
  // future change that adds or drops a durability step forces a conscious
  // update here rather than silently shrinking the sweep.
  assert.equal(count, 41, 'commit sequence durability-boundary count changed');
  assert.ok(trace.includes('4:renameFile'), 'the sweep must include rename boundaries');
  assert.ok(trace.filter((entry) => entry.endsWith(':fsyncFile')).length >= 8, 'fsync boundaries must be covered');
});

test('exhaustive sweep: recovery yields exactly one complete generation at every crash point', async () => {
  const { count } = await enumerateCrashPoints(buildFactory(), commitOperation(TARGET_GENERATION));
  const outcomes = [];

  for (const mode of ['before', 'after']) {
    for (let point = 1; point <= count; point += 1) {
      const { report, state } = await replayAndRecover(point, mode);
      const where = `${mode}@${point}`;

      assert.ok(
        report.classification === 'consistent' || report.classification === 'recovered',
        `${where}: recovery must reach a usable state, got ${report.classification} (${report.reason || ''})`
      );
      assert.equal(state.pointerStatus, 'ok', `${where}: an active pointer must exist after recovery`);
      assert.ok(state.generation, `${where}: the pointed-at generation must be readable (${state.generationError})`);
      assert.equal(
        state.generation.generation_id,
        state.pointer.generation_id,
        `${where}: pointer and generation must agree`
      );
      assert.ok(
        [SEED_GENERATION, TARGET_GENERATION].includes(state.pointer.generation_id),
        `${where}: committed generation must be fully-old or fully-new, got ${state.pointer.generation_id}`
      );

      // PLUG-D14/D19: an epoch never goes backwards, whatever the crash did.
      assert.ok(state.pointer.commit_epoch >= SEED_EPOCH, `${where}: epoch regressed`);
      if (state.pointer.generation_id === TARGET_GENERATION) {
        assert.ok(state.pointer.commit_epoch > SEED_EPOCH, `${where}: the new generation must carry a higher epoch`);
      }

      outcomes.push({ where, classification: report.classification, generation: state.pointer.generation_id });
    }
  }

  assert.equal(outcomes.length, count * 2, 'every crash point must be replayed in both modes');
  // Both halves of the fully-old / fully-new dichotomy must actually occur --
  // otherwise the sweep could be passing because nothing ever committed.
  const committedNew = outcomes.filter((entry) => entry.generation === TARGET_GENERATION);
  const stayedOld = outcomes.filter((entry) => entry.generation === SEED_GENERATION);
  assert.ok(committedNew.length > 0, 'some crash points must land after the pointer flip');
  assert.ok(stayedOld.length > 0, 'some crash points must land before the pointer flip');
});

test('recovery leaves no pending receipt, and settled receipts agree with the pointer', async () => {
  const { count } = await enumerateCrashPoints(buildFactory(), commitOperation(TARGET_GENERATION));

  for (const mode of ['before', 'after']) {
    for (let point = 1; point <= count; point += 1) {
      const { report, state, receipts, journalBeforeRecovery } = await replayAndRecover(point, mode);
      const where = `${mode}@${point}`;

      const stillPending = receipts.filter((receipt) => receipt.status === 'pending');
      assert.deepEqual(
        stillPending.map((receipt) => receipt.operation_id),
        [],
        `${where}: recovery must finish or abandon every staged operation`
      );

      const operationId = `op-${TARGET_GENERATION}`;
      const target = receipts.find((receipt) => receipt.operation_id === operationId);
      if (!target) continue;
      if (state.pointer.generation_id === TARGET_GENERATION) {
        // A landed commit may never be settled `failed`, whichever path settled
        // it -- the commit sequence's own step 6, or recovery afterwards.
        assert.notEqual(target.status, 'failed', `${where}: a landed commit must never settle as failed`);
        // Where RECOVERY had to classify it, landing the pointer is necessary
        // but not sufficient: a receipt records no generation_id, so an epoch is
        // only attributable to THIS operation once the journal says so.
        // Otherwise the honest answer is indeterminate rather than a guess that
        // only happens to be right while there is a single writer.
        const attributed = journalBeforeRecovery.some((entry) => entry.kind === 'pointer_commit'
          && entry.commit_epoch === target.commit_epoch
          && entry.operation_id === operationId);
        if (attributed) {
          assert.equal(target.status, 'committed', `${where}: an attributed landed commit must settle committed`);
        } else {
          assert.ok(
            ['committed', 'indeterminate'].includes(target.status),
            `${where}: unattributed landed commit settled ${target.status}`
          );
        }
      } else {
        assert.notEqual(target.status, 'committed', `${where}: an unlanded commit must never settle as committed`);
      }
      void report;
    }
  }
});

test('journal never claims a commit the pointer does not show', async () => {
  const { count } = await enumerateCrashPoints(buildFactory(), commitOperation(TARGET_GENERATION));

  for (let point = 1; point <= count; point += 1) {
    const { facade, baseDir, state } = await replayAndRecover(point, 'after');
    const { entries } = await readJournal(facade, baseDir);
    const commits = entries.filter((entry) => entry.kind === 'pointer_commit');
    for (const entry of commits) {
      assert.ok(
        entry.commit_epoch <= state.pointer.commit_epoch,
        `after@${point}: journal records epoch ${entry.commit_epoch} above the committed ${state.pointer.commit_epoch}`
      );
    }
  }
});

test('a torn write of any single file never produces a mixed graph', async () => {
  const build = buildFactory();
  const { trace } = await enumerateCrashPoints(build, commitOperation(TARGET_GENERATION));
  const writePoints = trace
    .filter((entry) => entry.endsWith(':writeFile'))
    .map((entry) => Number(entry.split(':')[0]));
  assert.ok(writePoints.length >= 8, 'expected every atomic write to be torn-testable');

  for (const point of writePoints) {
    const { facade, baseDir } = await runWithCrash(build, commitOperation(TARGET_GENERATION), point, 'torn');
    const report = await recoverStore(facade, baseDir, { now: RECOVERY_NOW });
    const state = await inspect(facade, baseDir);
    assert.ok(
      report.classification === 'consistent' || report.classification === 'recovered',
      `torn@${point}: ${report.classification} ${report.reason || ''}`
    );
    assert.ok(state.generation, `torn@${point}: generation unreadable (${state.generationError})`);
    assert.ok([SEED_GENERATION, TARGET_GENERATION].includes(state.pointer.generation_id), `torn@${point}: mixed graph`);
  }
});

test('a commit after any crash still advances the epoch strictly', async () => {
  const { count } = await enumerateCrashPoints(buildFactory(), commitOperation(TARGET_GENERATION));
  // Well past the 30s default lease, so the crashed operation's lease is
  // reclaimable rather than blocking forever (lease-owner crash recovery).
  const afterLeaseExpiry = '2026-07-31T03:00:00Z';

  for (let point = 1; point <= count; point += 1) {
    const { facade, baseDir, state } = await replayAndRecover(point, 'after');
    const epochBefore = state.pointer.commit_epoch;

    const followUp = commitOperation('gen-followup', {
      operationId: 'op-followup',
      now: afterLeaseExpiry,
    });
    const result = await followUp(facade, baseDir);
    assert.equal(result.ok, true, `after@${point}: follow-up commit failed: ${result.reason}`);
    assert.ok(
      result.commitEpoch > epochBefore,
      `after@${point}: follow-up epoch ${result.commitEpoch} did not exceed ${epochBefore}`
    );

    const post = await inspect(facade, baseDir);
    assert.equal(post.pointer.generation_id, 'gen-followup');
    void LATER;
    void BASE_DIR;
  }
});
