'use strict';

// W9c: the Stage-3 exit criterion "crash-safe install/remove proven end-to-end
// against the real store", proven rather than argued.
//
// Everything else in the plugin durability packet runs against
// `createMemoryFsFacade()`. tests/plugins/store/node-fs-facade.test.js closes
// half the gap by pinning the NINE facade PRIMITIVES to memory-facade parity --
// but primitive parity is not the claim. "The nine methods behave identically"
// does not entail "the composed commit sequence leaves a correct, recoverable
// store on a real filesystem", and the difference is exactly where real-disk-
// only failure modes live:
//
//   - path composition against a real root (`baseDir: ''` -> `<root>/...`),
//   - Windows directory-fsync degradation (fsyncDir is a documented no-op-ish
//     best effort there, so directory-entry durability is a RECOVERY input),
//   - real rename-over-existing-destination semantics (MoveFileEx vs. a Map
//     key overwrite),
//   - recovery reading the bytes a real crash actually left on the device.
//
// So this file drives the REAL control-plane service
// (services/plugins/plugin-control-plane-service.js) over a REAL NodeFsFacade
// rooted at a fresh `fs.mkdtemp` directory, and observes every outcome through
// a BRAND NEW facade/service instance. That last part is the load-bearing bit:
// a fresh reader cannot see process state, so anything it reads is bytes that
// genuinely landed.
//
// Injection note: in production `readPackageBytes` / `verifyPackage` default to
// a fail-closed INTEGRITY_FAILED because no archive reader has landed. Both are
// injected here so the lifecycle actually runs; the fail-closed default is
// itself asserted below (against the real store, proving it writes nothing).
//
// Nothing here touches the real userData directory.

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');

const { createNodeFsFacade } = require('../../../services/plugins/store/node-fs-facade');
const { createPluginControlPlaneService } = require('../../../services/plugins/plugin-control-plane-service');
const { readCommittedState } = require('../../../services/plugins/lifecycle/commit-sequence');
const { recoverStore } = require('../../../services/plugins/lifecycle/recovery');
const { createCrashInjectingFs } = require('../../helpers/plugins/crash-injecting-fs');
const { PLUGIN_ERROR_CODES } = require('../../../services/backend/error-codes');
const { verifiedPackageVerdict } = require('../../helpers/plugins/durability-scenario');

// The service roots the facade at `<userData>/plugins` and then addresses every
// store path relative to that root, so baseDir is the empty string. Using the
// production value here is deliberate: a test that passed a non-empty baseDir
// would not exercise the path composition the app actually performs.
const BASE_DIR = '';

const PUBLISHER = 'acme';
const SEED_PLUGIN = 'alpha';
const TARGET_PLUGIN = 'beta';
const FOLLOW_UP_PLUGIN = 'gamma';

const T_SEED = '2026-07-31T00:00:00Z';
const T_TARGET = '2026-07-31T01:00:00Z';
// Restart/recovery, and then a follow-up mutation far enough past the 30s
// default mutation lease that a lease the crashed operation never released is
// reclaimable rather than blocking forever.
const T_RESTART = '2026-07-31T02:00:00Z';
const T_FOLLOW_UP = '2026-07-31T03:00:00Z';

// Pinned crash-point counts. Install has ten atomic artifacts after adding the
// immutable package record; uninstall has nine. Each lands as mkdir ->
// writeFile(tmp) -> fsyncFile -> renameFile -> fsyncDir, plus a lease removal
// or cleanup-state write. Pinning the totals
// means a change that adds or drops a durability step forces a conscious update
// here instead of silently shrinking the sweep.
const INSTALL_MUTATIONS = 51;
const UNINSTALL_MUTATIONS = 51;

const CRASH_MODE_OPTION = Object.freeze({
  before: 'crashAtMutation',
  after: 'crashAfterMutation',
});

const ROOTS = new Set();

function freshRoot() {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'jenny-plugin-realstore-'));
  ROOTS.add(dir);
  return dir;
}

function dropRoot(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  ROOTS.delete(dir);
}

after(() => {
  for (const dir of ROOTS) fs.rmSync(dir, { recursive: true, force: true });
  ROOTS.clear();
});

function facadeOn(rootDir) {
  return createNodeFsFacade({ rootDir });
}

const PACKAGE_SELECTIONS = new WeakMap();

// The real service with deterministic picker/verifier seams. The test changes
// the selected package through this harness closure; no package identity ever
// crosses the renderer-style install payload.
function serviceOn(facade, { now = T_TARGET, operationId = 'op-target' } = {}) {
  const selection = { pluginId: SEED_PLUGIN };
  const service = createPluginControlPlaneService({
    facade,
    baseDir: BASE_DIR,
    featureEnabled: true,
    safeMode: { active: false, source: 'none' },
    now: () => now,
    verifyPackage: async ({ bytes }) => {
      const pluginId = String(bytes).slice('real-package:'.length);
      return verifiedPackageVerdict({ packageBytes: bytes, publisherId: PUBLISHER, pluginId, now });
    },
    readPackageBytes: async () => ({
      ok: true,
      bytes: `real-package:${selection.pluginId}`,
      sourcePathDigest: 'a'.repeat(64),
    }),
    newOperationId: () => operationId,
  });
  PACKAGE_SELECTIONS.set(service, selection);
  return service;
}

function installOn(service, pluginId) {
  const selection = PACKAGE_SELECTIONS.get(service);
  if (selection) selection.pluginId = pluginId;
  return service.installLocalPackage({});
}

function uninstallOn(service, pluginId) {
  return service.uninstall({ publisher_id: PUBLISHER, plugin_id: pluginId });
}

// A fresh real store with exactly one committed generation holding SEED_PLUGIN.
async function buildSeededStore() {
  const rootDir = freshRoot();
  const service = serviceOn(facadeOn(rootDir), { now: T_SEED, operationId: 'op-seed' });
  const seeded = await installOn(service, SEED_PLUGIN);
  assert.equal(seeded.ok, true, `seed install failed: ${seeded.reason || ''}`);
  return rootDir;
}

// The committed plugin roster, as a stable string, so "fully-old vs. fully-new"
// is one comparison rather than a structural walk at every call site.
function roster(entries) {
  return (entries || []).map((entry) => entry.plugin_id).sort().join(',') || 'NONE';
}

function readDiskJson(rootDir, relative) {
  return JSON.parse(fs.readFileSync(nodePath.join(rootDir, relative), 'utf8'));
}

function listDisk(rootDir, relative) {
  const target = nodePath.join(rootDir, relative);
  return fs.existsSync(target) ? fs.readdirSync(target).sort() : [];
}

describe('real store: install commits durable bytes', () => {
  test('a committed install is readable back through a brand-new facade', async () => {
    const rootDir = freshRoot();
    const writer = facadeOn(rootDir);
    const installed = await installOn(serviceOn(writer, { now: T_SEED, operationId: 'op-seed' }), SEED_PLUGIN);
    assert.equal(installed.ok, true, `install refused: ${installed.reason || ''}`);
    assert.equal(installed.result.status, 'committed');

    // The whole point of a SECOND facade: it shares no process state with the
    // one that wrote, so everything below is bytes that actually reached disk.
    const reader = facadeOn(rootDir);
    const state = await readCommittedState(reader, BASE_DIR);
    assert.equal(state.pointerStatus, 'ok');
    assert.equal(state.pointer.generation_id, 'gen-op-seed');
    assert.equal(state.pointer.revision, 1);
    assert.equal(roster(state.generation.plugins), SEED_PLUGIN);
    // Pointer and generation must agree on the graph digest, or the store is
    // describing a generation it did not commit.
    assert.equal(state.generation.graph_hash, state.pointer.generation_digest);

    // Exactly ONE active generation on disk, and the pointer names it.
    assert.deepEqual(listDisk(rootDir, 'generations'), ['gen-op-seed']);

    // Read straight off the device, bypassing the facade entirely: this is the
    // last place a bug could hide behind the abstraction under test.
    const rawPointer = readDiskJson(rootDir, 'active-generation.json');
    assert.equal(rawPointer.generation_id, state.pointer.generation_id);
    const rawGeneration = readDiskJson(rootDir, 'generations/gen-op-seed/control-plane.json');
    assert.equal(rawGeneration.graph_hash, rawPointer.generation_digest);
    assert.deepEqual(rawGeneration.plugins.map((entry) => entry.plugin_id), [SEED_PLUGIN]);

    dropRoot(rootDir);
  });

  test('the state committed to real disk is installed_disabled, never enabled', async () => {
    const rootDir = await buildSeededStore();
    const reader = facadeOn(rootDir);
    const state = await readCommittedState(reader, BASE_DIR);

    const states = state.generation.plugins.flatMap((entry) => [entry.desired_state, entry.effective_state]);
    assert.deepEqual([...new Set(states)], ['installed_disabled'], 'a non-disabled state reached real disk');

    // The same claim through the seam the renderer sees, on a fresh service.
    const restarted = serviceOn(facadeOn(rootDir), { now: T_RESTART, operationId: 'op-read' });
    const snapshot = await restarted.getState();
    assert.equal(snapshot.installed_count, 1);
    assert.equal(snapshot.plugins[0].effective_state, 'installed_disabled');
    assert.equal(snapshot.disabled_only_state, 'installed_disabled');
    const policy = await restarted.getPolicyStatus();
    assert.equal(policy.contribution_execution_permitted, true);
    assert.equal(policy.activation_scope, 'stage5_remote_mcp');

    dropRoot(rootDir);
  });

  test('the production package-source default fails closed and writes nothing to real disk', async () => {
    const rootDir = freshRoot();
    // No readPackageBytes / verifyPackage injected: the shipping defaults.
    const service = createPluginControlPlaneService({
      facade: facadeOn(rootDir),
      baseDir: BASE_DIR,
      featureEnabled: true,
      safeMode: { active: false, source: 'none' },
      now: () => T_SEED,
      newOperationId: () => 'op-default',
    });
    const refused = await installOn(service, SEED_PLUGIN);
    assert.equal(refused.ok, false);
    assert.equal(refused.code, PLUGIN_ERROR_CODES.INTEGRITY_FAILED);
    assert.equal(refused.reason, 'package_source_unavailable');
    // Recovery ran (lazily) but committed nothing: no generation, no pointer.
    assert.deepEqual(listDisk(rootDir, 'generations'), []);
    assert.equal(fs.existsSync(nodePath.join(rootDir, 'active-generation.json')), false);

    dropRoot(rootDir);
  });
});

describe('real store: uninstall commits durable bytes', () => {
  test('a committed uninstall is readable back through a brand-new facade', async () => {
    const rootDir = await buildSeededStore();
    const removed = await uninstallOn(
      serviceOn(facadeOn(rootDir), { now: T_TARGET, operationId: 'op-remove' }),
      SEED_PLUGIN
    );
    assert.equal(removed.ok, true, `uninstall refused: ${removed.reason || ''}`);
    assert.equal(removed.result.authority_state_after, 'absent');

    const state = await readCommittedState(facadeOn(rootDir), BASE_DIR);
    assert.equal(state.pointerStatus, 'ok');
    assert.equal(state.pointer.generation_id, 'gen-op-remove');
    assert.equal(roster(state.generation.plugins), 'NONE');
    assert.equal(state.generation.graph_hash, state.pointer.generation_digest);
    assert.ok(
      state.pointer.commit_epoch > 0,
      `uninstall must advance the epoch, got ${state.pointer.commit_epoch}`
    );

    // Both generations stay on disk (Stage 3 has no retention pruning) but only
    // one is ACTIVE -- the pointer is the single authority.
    assert.deepEqual(listDisk(rootDir, 'generations'), ['gen-op-remove', 'gen-op-seed']);
    assert.equal(readDiskJson(rootDir, 'active-generation.json').generation_id, 'gen-op-remove');

    const snapshot = await serviceOn(facadeOn(rootDir), { now: T_RESTART, operationId: 'op-read' }).getState();
    assert.equal(snapshot.installed_count, 0);
    assert.deepEqual(snapshot.plugins, []);

    dropRoot(rootDir);
  });
});

// ---------------------------------------------------------------------------
// Crash safety, end-to-end, on real bytes.
//
// SWEEP SCOPE, stated explicitly so nothing is silently truncated:
//   * EVERY mutating boundary of a real install (51) and a real uninstall (46),
//     in BOTH modes -- 'before' (the write never reached the device) and
//     'after' (the write landed, then the machine died). 194 replays.
//   * EVERY install writeFile boundary again in 'torn' mode (10 atomic
//     artifacts), because the two
//     operations share the identical temp-file+rename recipe and the torn-write
//     property is a property of that recipe, not of the caller).
// NOT covered here, deliberately, because other suites own them against the
// memory facade and they are not real-disk-sensitive: concurrent operations
// (concurrency.test.js), lease expiry races (gc-lease-safety.test.js), and
// pointer/generation corruption injected by hand (epoch-recovery.test.js).
// Consequently the RECOVERED classification (pointer loss -> PLUG-D19 epoch
// high-water reconstruction) is not reached by these sweeps; what is reached,
// and asserted below, is the CONSISTENT-with-reconciliation path, where a
// crashed operation left a pending receipt that recovery must settle.
// ---------------------------------------------------------------------------

// One crash replay: fresh seeded real store, crash the operation at `point`,
// then observe through a brand-new facade AND a brand-new service (whose lazy
// startup recovery is exactly the restart path a real crash would take).
async function replayCrash(operationKind, point, mode) {
  const rootDir = await buildSeededStore();
  const injected = createCrashInjectingFs(facadeOn(rootDir), { [CRASH_MODE_OPTION[mode]]: point });
  const crashing = serviceOn(injected, { now: T_TARGET, operationId: 'op-target' });
  // The service fences every throw into a structured result, so the injected
  // StoreCrashError surfaces as a refusal rather than propagating. Either way
  // the operation is abandoned, which is what a killed process looks like.
  if (operationKind === 'install') await installOn(crashing, TARGET_PLUGIN);
  else await uninstallOn(crashing, SEED_PLUGIN);

  // crash-injecting-fs states this contract itself: a replay in which the
  // injected point was never reached is not a crash replay, and counting it as
  // one silently shrinks the sweep. Without this, a mutation-count change turns
  // replays into clean runs that still satisfy every assertion below.
  assert.ok(
    injected.crashed !== null,
    `${operationKind} replay at ${mode} point ${point} never crashed: not a crash replay`
  );
  assert.equal(injected.crashed.point, point, 'the fault fired at a different point than requested');

  const restarted = serviceOn(facadeOn(rootDir), { now: T_RESTART, operationId: 'op-restart' });
  const snapshot = await restarted.getState();
  const committed = await readCommittedState(facadeOn(rootDir), BASE_DIR);
  return { rootDir, snapshot, committed };
}

// Assertions every crash replay must satisfy, whatever the operation.
function assertSingleCompleteGeneration(where, { snapshot, committed }, allowedRosters) {
  assert.ok(
    ['consistent', 'recovered'].includes(snapshot.recovery.classification),
    `${where}: recovery must reach a usable classification, got ${snapshot.recovery.classification} (${snapshot.recovery.reason || ''})`
  );
  assert.equal(committed.pointerStatus, 'ok', `${where}: no readable active pointer after restart`);
  assert.ok(committed.generation, `${where}: pointed-at generation unreadable (${committed.generationError})`);
  assert.equal(
    committed.generation.generation_id,
    committed.pointer.generation_id,
    `${where}: pointer and generation record disagree`
  );
  assert.equal(
    committed.generation.graph_hash,
    committed.pointer.generation_digest,
    `${where}: committed digest does not match the generation on disk`
  );
  const observed = roster(committed.generation.plugins);
  assert.ok(
    allowedRosters.includes(observed),
    `${where}: mixed graph -- committed roster '${observed}' is neither fully-old nor fully-new`
  );
  // The seam's own view must agree with the raw store, or a renderer could be
  // shown a roster the store never committed.
  assert.equal(roster(snapshot.plugins), observed, `${where}: service snapshot disagrees with committed bytes`);
  return observed;
}

describe('real store: crash safety end-to-end', () => {
  test('the durability-boundary count of a real install and uninstall is pinned', async () => {
    const installRoot = await buildSeededStore();
    const installProbe = createCrashInjectingFs(facadeOn(installRoot));
    const installed = await installOn(serviceOn(installProbe, { operationId: 'op-probe' }), TARGET_PLUGIN);
    assert.equal(installed.ok, true, 'the probe run must complete uncrashed');
    assert.equal(installProbe.mutationCount, INSTALL_MUTATIONS, 'install durability-boundary count changed');
    const installTrace = installProbe.mutationTrace();
    assert.equal(installTrace.filter((entry) => entry.endsWith(':renameFile')).length, 10);
    assert.equal(installTrace.filter((entry) => entry.endsWith(':fsyncDir')).length, 10);
    dropRoot(installRoot);

    const removeRoot = await buildSeededStore();
    const removeProbe = createCrashInjectingFs(facadeOn(removeRoot));
    const removed = await uninstallOn(serviceOn(removeProbe, { operationId: 'op-probe' }), SEED_PLUGIN);
    assert.equal(removed.ok, true, 'the probe run must complete uncrashed');
    assert.equal(removeProbe.mutationCount, UNINSTALL_MUTATIONS, 'uninstall durability-boundary count changed');
    dropRoot(removeRoot);
  });

  test('install: every crash boundary leaves exactly one complete generation on real disk', async () => {
    const allowed = [SEED_PLUGIN, [SEED_PLUGIN, TARGET_PLUGIN].sort().join(',')];
    const observed = { old: 0, fresh: 0, reconciled: 0 };

    for (const mode of ['before', 'after']) {
      for (let point = 1; point <= INSTALL_MUTATIONS; point += 1) {
        const where = `install ${mode}@${point}`;
        const replay = await replayCrash('install', point, mode);
        const committedRoster = assertSingleCompleteGeneration(where, replay, allowed);
        if (committedRoster === allowed[0]) observed.old += 1;
        else observed.fresh += 1;
        if (replay.snapshot.recovery.reconciled_count > 0) observed.reconciled += 1;

        // "Usable" is not a classification, it is a capability: the store must
        // accept the NEXT real mutation after recovery. This is also what
        // proves a crashed operation's mutation lease was reclaimable.
        const followUp = await installOn(
          serviceOn(facadeOn(replay.rootDir), { now: T_FOLLOW_UP, operationId: 'op-follow-up' }),
          FOLLOW_UP_PLUGIN
        );
        assert.equal(followUp.ok, true, `${where}: store unusable after recovery (${followUp.reason || ''})`);
        dropRoot(replay.rootDir);
      }
    }

    // Both halves of the dichotomy must actually occur, or the sweep could be
    // passing because the target install never committed anywhere.
    assert.ok(observed.old > 0, 'no crash point landed before the pointer flip');
    assert.ok(observed.fresh > 0, 'no crash point landed after the pointer flip');
    assert.equal(observed.old + observed.fresh, INSTALL_MUTATIONS * 2);
    // Recovery's "finish or abandon staged operations idempotently" path must
    // actually fire on real bytes, not merely find every store already clean.
    assert.ok(
      observed.reconciled > 0,
      'no crash point left a staged operation for recovery to reconcile'
    );
  });

  test('uninstall: every crash boundary leaves exactly one complete generation on real disk', async () => {
    const allowed = [SEED_PLUGIN, 'NONE'];
    const observed = { old: 0, fresh: 0 };

    for (const mode of ['before', 'after']) {
      for (let point = 1; point <= UNINSTALL_MUTATIONS; point += 1) {
        const where = `uninstall ${mode}@${point}`;
        const replay = await replayCrash('uninstall', point, mode);
        const committedRoster = assertSingleCompleteGeneration(where, replay, allowed);
        if (committedRoster === SEED_PLUGIN) observed.old += 1;
        else observed.fresh += 1;
        dropRoot(replay.rootDir);
      }
    }

    assert.ok(observed.old > 0, 'no crash point landed before the removal committed');
    assert.ok(observed.fresh > 0, 'no crash point landed after the removal committed');
    assert.equal(observed.old + observed.fresh, UNINSTALL_MUTATIONS * 2);
  });

  test('a torn write of any atomic artifact never produces a mixed graph on real disk', async () => {
    const probeRoot = await buildSeededStore();
    const probe = createCrashInjectingFs(facadeOn(probeRoot));
    await installOn(serviceOn(probe, { operationId: 'op-probe' }), TARGET_PLUGIN);
    const writePoints = probe.mutationTrace()
      .filter((entry) => entry.endsWith(':writeFile'))
      .map((entry) => Number(entry.split(':')[0]));
    dropRoot(probeRoot);
    assert.equal(writePoints.length, 10, 'every atomic artifact must be torn-testable');

    const allowed = [SEED_PLUGIN, [SEED_PLUGIN, TARGET_PLUGIN].sort().join(',')];
    for (const point of writePoints) {
      const rootDir = await buildSeededStore();
      const injected = createCrashInjectingFs(facadeOn(rootDir), { tornWriteAtMutation: point });
      await installOn(serviceOn(injected, { operationId: 'op-target' }), TARGET_PLUGIN);
      assert.ok(
        injected.crashed !== null,
        `torn-write replay at point ${point} never fired: not a torn-write replay`
      );

      const restarted = serviceOn(facadeOn(rootDir), { now: T_RESTART, operationId: 'op-restart' });
      const snapshot = await restarted.getState();
      const committed = await readCommittedState(facadeOn(rootDir), BASE_DIR);
      assertSingleCompleteGeneration(`torn@${point}`, { snapshot, committed }, allowed);
      dropRoot(rootDir);
    }
  });

  test('recoverStore called directly on a crashed real store reports a usable outcome', async () => {
    // The sweeps above reach recovery through the service's lazy path. This
    // pins the module contract itself: recoverStore, handed the surviving bytes
    // of a crash between the generation write and the pointer flip (the single
    // most dangerous window), classifies and leaves a committed generation.
    const rootDir = await buildSeededStore();
    // Mutation 27 is the PRIOR pointer's temp write (active-generation.prior.json),
    // not the active one -- active-pointer.js stages the prior pointer first. The
    // active pointer's temp write is 32. Crashing at 27 still left the old
    // generation committed, so every assertion below passed while the test missed
    // the window it says it pins. Assert the artifact, not just the number, so the
    // next change to the write order fails here instead of drifting again.
    const pointerFlipWrite = 32;
    const injected = createCrashInjectingFs(facadeOn(rootDir), { crashAtMutation: pointerFlipWrite });
    await installOn(serviceOn(injected, { operationId: 'op-target' }), TARGET_PLUGIN);
    assert.ok(injected.crashed !== null, 'the pointer-flip crash never fired');
    assert.match(
      injected.crashed.path,
      /active-generation\.json\./,
      `crash landed on ${injected.crashed.path}, not active-generation.json's temp write`
    );
    assert.doesNotMatch(
      injected.crashed.path,
      /active-generation\.prior\.json/,
      'crash landed on the PRIOR pointer, which is not the dangerous window'
    );

    const reader = facadeOn(rootDir);
    const report = await recoverStore(reader, BASE_DIR, { now: T_RESTART });
    assert.ok(
      ['consistent', 'recovered'].includes(report.classification),
      `recoverStore returned ${report.classification} (${report.reason || ''})`
    );
    const committed = await readCommittedState(facadeOn(rootDir), BASE_DIR);
    assert.equal(committed.pointer.generation_id, 'gen-op-seed', 'a crash before the flip must keep the old generation');
    assert.equal(roster(committed.generation.plugins), SEED_PLUGIN);

    const followUp = await installOn(
      serviceOn(facadeOn(rootDir), { now: T_FOLLOW_UP, operationId: 'op-follow-up' }),
      FOLLOW_UP_PLUGIN
    );
    assert.equal(followUp.ok, true, `store unusable after recoverStore: ${followUp.reason || ''}`);
    dropRoot(rootDir);
  });
});

describe('real store: durability posture is measured, not presumed', () => {
  test('directoryFsyncReport is internally coherent after a real commit', async () => {
    const rootDir = freshRoot();
    const facade = facadeOn(rootDir);
    const before = facade.directoryFsyncReport();
    assert.equal(before.attempted, 0);
    assert.equal(before.supported, null, 'posture must be unknown before the first attempt');

    const installed = await installOn(serviceOn(facade, { now: T_SEED, operationId: 'op-seed' }), SEED_PLUGIN);
    assert.equal(installed.ok, true);

    const report = facade.directoryFsyncReport();
    // Deliberately NOT asserting `supported === true`. On Windows fsync of a
    // directory handle is unsupported (EPERM here), which is a documented,
    // recorded degradation -- directory-entry durability becomes a recovery
    // concern, and the sweeps above are what prove recovery covers it. What
    // must hold on EVERY platform is that the accounting is honest.
    assert.ok(report.attempted > 0, 'a real commit must attempt directory fsyncs');
    assert.equal(
      report.succeeded + report.degraded,
      report.attempted,
      `fsyncDir accounting does not add up: ${JSON.stringify(report)}`
    );
    assert.equal(report.supported, report.degraded === 0, 'supported must mean "no attempt degraded"');
    assert.equal(
      report.lastCode === null,
      report.degraded === 0,
      'a degraded attempt must record why, and a clean run must record nothing'
    );

    // Recorded, not asserted: the posture this machine actually has.
    console.log(`[real-store-e2e] platform=${process.platform} directoryFsyncReport=${JSON.stringify(report)}`);

    // Whatever the posture, the commit is still durable enough to read back
    // from a fresh facade -- that is the claim degradation must not break.
    const committed = await readCommittedState(facadeOn(rootDir), BASE_DIR);
    assert.equal(committed.pointer.generation_id, 'gen-op-seed');
    dropRoot(rootDir);
  });
});
