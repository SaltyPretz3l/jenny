'use strict';
// SPEC: Workspace Test Runner P1 Wave A — main-process wiring.
//
// The wiring (services/main/workspace-test-runner-wiring.js) builds the service
// the workspaceTestRunner.* IPC handlers call. It owns:
//   - per-workspace-root storage in userData (config + history), keyed by a
//     stable hash of the realpath'd root, backed by FileJsonStore (S4 / S5a);
//   - storage that FOLLOWS the live root (stores memoized by root-hash and
//     rebuilt when the root changes) so configs/history never leak across roots;
//   - the `workspace_test_runner` flag gate (S8; now default-ON), mirroring
//     WorkspaceGitService's featureFlagProvider precedent — flag off => handlers
//     degrade to a disabled envelope and never spawn / persist.
//
// Real FileJsonStores in an os.tmpdir sandbox give the round-trip teeth: a run
// only greens when configs are read from, and a record is written to, the
// genuine per-root file on disk.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { resolveRealPathSafe } = require('../services/backend/path-utils');
const { getBridgeChannel } = require('../services/ipc-contract');
const { WORKSPACE_TEST_RUNNER_ERROR_CODES } = require('../services/backend/error-codes');
const { createWorkspaceTestRunnerWiring } = require('../services/main/workspace-test-runner-wiring');
const {
  registerWorkspaceTestRunnerIpcHandlers,
  registerMainIpcHandlers,
} = require('../services/main/ipc-handler-registration');

// ---------------------------------------------------------------------------
// Helpers — the per-root filename derivation mirrors the wiring's contract
// (sha256(realpath(root)).slice(0,16)); a test that wants to seed/inspect a
// root's config/history file must look where the wiring will.
// ---------------------------------------------------------------------------

function rootHash(root) {
  let real = resolveRealPathSafe(root) || root;
  // Mirror the wiring's win32 case-insensitive keying so seeded/inspected files
  // land where the wiring looks.
  if (process.platform === 'win32') {
    real = String(real).toLowerCase();
  }
  return crypto.createHash('sha256').update(String(real)).digest('hex').slice(0, 16);
}
function trDir(userDataDir) {
  return path.join(userDataDir, 'test-runner');
}
function configPathFor(userDataDir, root) {
  return path.join(trDir(userDataDir), `${rootHash(root)}.config.json`);
}
function historyPathFor(userDataDir, root) {
  return path.join(trDir(userDataDir), `${rootHash(root)}.history.json`);
}
function writeConfigs(userDataDir, root, configs) {
  const file = configPathFor(userDataDir, root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ configs }), 'utf8');
}

// An os.tmpdir workspace sandbox, auto-cleaned via t.after.
function sandbox(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-wiring-'));
  t.after(() => {
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch (_error) {
      /* best-effort cleanup */
    }
  });
  const userDataDir = path.join(base, 'userData');
  function makeRoot(name) {
    const root = path.join(base, name);
    fs.mkdirSync(root, { recursive: true });
    return root;
  }
  return { base, userDataDir, makeRoot };
}

function passingRunner() {
  const calls = [];
  return {
    calls,
    runTestCommand: (opts) => {
      calls.push(opts);
      return Promise.resolve({
        status: 'passed', exitCode: 0, durationMs: 5, startedAt: 'S', finishedAt: 'F',
      });
    },
  };
}

function flag(on) {
  return () => ({ workspace_test_runner: on });
}

// A live-mutable shellConfigService stub: the wiring re-reads the root on every
// call, so set() simulates the user switching workspace folders mid-session.
function rootRef(initial) {
  let value = initial;
  return {
    getToolsWorkspaceRoot: () => value,
    set: (next) => { value = next; },
  };
}

// ---------------------------------------------------------------------------
// 1) Real per-root FileJsonStore round-trip
// ---------------------------------------------------------------------------

test('wave-a: listConfigs/run/getState work against REAL per-root FileJsonStores', async (t) => {
  const { userDataDir, makeRoot } = sandbox(t);
  const root = makeRoot('rootA');
  writeConfigs(userDataDir, root, [{ id: 'unit', label: 'Unit', command: 'echo hi' }]);
  const runner = passingRunner();
  const wiring = createWorkspaceTestRunnerWiring({
    userDataDir,
    shellConfigService: rootRef(root),
    runner,
    featureFlagProvider: flag(true),
    now: () => new Date(1000),
    makeRunId: () => 'run1',
  });

  // listConfigs reads the per-root config FILE on disk.
  const listed = wiring.listConfigs();
  assert.deepEqual(listed.configs.map((c) => c.id), ['unit']);
  assert.equal(listed.configs[0].command, 'echo hi');

  // run() drives the injected runner and persists a record to the per-root file.
  const ran = await wiring.run({ configId: 'unit' });
  assert.equal(ran.status, 'passed');
  assert.equal(ran.runId, 'run1');
  assert.equal(ran.configId, 'unit');
  assert.equal(runner.calls.length, 1, 'the injected runner ran exactly once');
  assert.equal(runner.calls[0].command, 'echo hi', 'the config command reached the runner');

  // The history file exists on disk and holds the completed run record.
  const histFile = historyPathFor(userDataDir, root);
  assert.equal(fs.existsSync(histFile), true, 'per-root history file written to userData');
  const onDisk = JSON.parse(fs.readFileSync(histFile, 'utf8'));
  assert.equal(onDisk.byConfig.unit.length, 1);
  assert.equal(onDisk.byConfig.unit[0].status, 'passed');
  assert.equal(onDisk.byConfig.unit[0].runId, 'run1');

  // getState reflects the persisted run.
  const state = wiring.getState();
  assert.deepEqual(state.configs.map((c) => c.id), ['unit']);
  assert.equal(state.activeRun, null);
  assert.equal(state.history.byConfig.unit.length, 1);
  assert.equal(state.history.byConfig.unit[0].status, 'passed');
});

// ---------------------------------------------------------------------------
// 2) Per-root isolation — a run under root A is invisible under root B
// ---------------------------------------------------------------------------

test('wave-a: per-root isolation — root A run invisible under root B', async (t) => {
  const { userDataDir, makeRoot } = sandbox(t);
  const rootA = makeRoot('rootA');
  const rootB = makeRoot('rootB');
  writeConfigs(userDataDir, rootA, [{ id: 'unit', label: 'Unit A', command: 'echo a' }]);
  writeConfigs(userDataDir, rootB, [{ id: 'unit', label: 'Unit B', command: 'echo b' }]);
  const runner = passingRunner();
  const scs = rootRef(rootA);
  const wiring = createWorkspaceTestRunnerWiring({
    userDataDir,
    shellConfigService: scs,
    runner,
    featureFlagProvider: flag(true),
    now: () => new Date(2000),
    makeRunId: () => 'runA',
  });

  await wiring.run({ configId: 'unit' });
  assert.equal(runner.calls[0].command, 'echo a', 'root A config ran');

  // A's history file exists; B's does not — distinct per-root files.
  assert.equal(fs.existsSync(historyPathFor(userDataDir, rootA)), true);
  assert.equal(fs.existsSync(historyPathFor(userDataDir, rootB)), false, 'no cross-root history file');
  assert.notEqual(rootHash(rootA), rootHash(rootB), 'distinct roots hash to distinct filenames');

  // Switch the live root to B: getState reads B's (empty) history and B's configs.
  scs.set(rootB);
  const stateB = wiring.getState();
  assert.deepEqual(stateB.history.byConfig, {}, "root B sees none of root A's runs");
  assert.equal(stateB.configs[0].command, 'echo b', 'root B sees its own configs');

  // Switch back to A: A's run is still there.
  scs.set(rootA);
  const stateA = wiring.getState();
  assert.equal(stateA.history.byConfig.unit.length, 1);
  assert.equal(stateA.configs[0].command, 'echo a');
});

// ---------------------------------------------------------------------------
// 3) Root change mid-session — providers + persistence follow the new root
// ---------------------------------------------------------------------------

test('wave-a: root change mid-session — providers and persistence follow the new root', async (t) => {
  const { userDataDir, makeRoot } = sandbox(t);
  const rootA = makeRoot('rootA');
  const rootB = makeRoot('rootB');
  writeConfigs(userDataDir, rootA, [{ id: 'unit', label: 'A', command: 'echo a' }]);
  writeConfigs(userDataDir, rootB, [{ id: 'integration', label: 'B', command: 'echo b' }]);
  let counter = 0;
  const runner = passingRunner();
  const scs = rootRef(rootA);
  const wiring = createWorkspaceTestRunnerWiring({
    userDataDir,
    shellConfigService: scs,
    runner,
    featureFlagProvider: flag(true),
    now: () => new Date(3000),
    makeRunId: () => `run-${(counter += 1)}`,
  });

  // Before the switch, providers read root A's distinct config id.
  assert.deepEqual(wiring.listConfigs().configs.map((c) => c.id), ['unit']);

  // Switch root to B mid-session.
  scs.set(rootB);
  assert.deepEqual(wiring.listConfigs().configs.map((c) => c.id), ['integration']);

  // Root A's id is now unknown — proves the provider reads B, not a stale A.
  const missA = await wiring.run({ configId: 'unit' });
  assert.equal(missA.error.code, WORKSPACE_TEST_RUNNER_ERROR_CODES.CONFIG_NOT_FOUND);
  assert.equal(runner.calls.length, 0, 'no run for a config absent under root B');

  // Running B's config persists ONLY to B's history file; A's stays untouched.
  const ran = await wiring.run({ configId: 'integration' });
  assert.equal(ran.status, 'passed');
  assert.equal(runner.calls[0].command, 'echo b');
  assert.equal(fs.existsSync(historyPathFor(userDataDir, rootB)), true);
  assert.equal(fs.existsSync(historyPathFor(userDataDir, rootA)), false, 'root A history untouched');
});

// ---------------------------------------------------------------------------
// 4) Flag gate is live — off => inert (no run, no persistence); on => works
// ---------------------------------------------------------------------------

test('wave-a: flag-off makes the handlers inert; flipping it on re-enables (live gate)', async (t) => {
  const { userDataDir, makeRoot } = sandbox(t);
  const root = makeRoot('rootA');
  writeConfigs(userDataDir, root, [{ id: 'unit', label: 'Unit', command: 'echo hi' }]);
  const runner = passingRunner();
  let on = false;
  const wiring = createWorkspaceTestRunnerWiring({
    userDataDir,
    shellConfigService: rootRef(root),
    runner,
    featureFlagProvider: () => ({ workspace_test_runner: on }),
    now: () => new Date(4000),
    makeRunId: () => 'run1',
  });

  // Flag OFF: every handler degrades to a disabled envelope; nothing spawns/persists.
  const ranOff = await wiring.run({ configId: 'unit' });
  assert.deepEqual(ranOff, { available: false, reason: 'feature_disabled' });
  assert.equal(runner.calls.length, 0, 'flag-off must not spawn a run');
  assert.equal(fs.existsSync(historyPathFor(userDataDir, root)), false, 'flag-off persists nothing');

  assert.deepEqual(wiring.listConfigs(), { available: false, reason: 'feature_disabled' });
  assert.deepEqual(wiring.getState(), {
    configs: [], history: { byConfig: {} }, activeRun: null, activeConfigId: null, available: false, reason: 'feature_disabled',
  });

  // Flip the SAME wiring's flag ON — the gate is read per-call, so it now works.
  on = true;
  const ranOn = await wiring.run({ configId: 'unit' });
  assert.equal(ranOn.status, 'passed');
  assert.equal(runner.calls.length, 1, 'flag-on re-enables the run');
  assert.equal(fs.existsSync(historyPathFor(userDataDir, root)), true);
});

// ---------------------------------------------------------------------------
// 4g) S14 creation is flag-gated, but a live run remains teardown-capable after
//     a mid-session flag rollback.
// ---------------------------------------------------------------------------

test('wave-b/s14/wide-016: flag off blocks idle abort but cannot block live-run teardown', async (t) => {
  const { userDataDir, makeRoot } = sandbox(t);
  const root = makeRoot('rootA');
  writeConfigs(userDataDir, root, [{ id: 'unit', label: 'Unit', command: 'sleep 999' }]);
  let on = false;
  const runner = {
    calls: [],
    runTestCommand: (opts) => {
      runner.calls.push(opts);
      return new Promise((resolve) => {
        const settle = () => resolve({ status: 'aborted', exitCode: null, durationMs: 1, startedAt: 'S', finishedAt: 'F' });
        if (opts.abortSignal && opts.abortSignal.aborted) { settle(); return; }
        opts.abortSignal.addEventListener('abort', settle, { once: true });
      });
    },
  };
  const wiring = createWorkspaceTestRunnerWiring({
    userDataDir,
    shellConfigService: rootRef(root),
    runner,
    featureFlagProvider: () => ({ workspace_test_runner: on }),
    now: () => new Date(9000),
    makeRunId: () => 'run1',
  });

  // Flag OFF: abort is inert — a disabled envelope, never reaching the service.
  assert.deepEqual(wiring.abort(), { available: false, reason: 'feature_disabled' });
  assert.equal(runner.calls.length, 0, 'flag-off abort spawns nothing');

  // Flag ON: a real in-flight run is cancelled through the gated wrapper.
  on = true;
  const p = wiring.run({ configId: 'unit' });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(runner.calls.length, 1, 'the run is in flight');
  on = false;
  const disabledLiveState = wiring.getState();
  assert.equal(disabledLiveState.available, false);
  assert.equal(disabledLiveState.activeRun, 'run1', 'flag-off state still exposes the live ownership signal');
  const res = wiring.abort();
  assert.equal(res.aborted, true);
  assert.equal(runner.calls[0].abortSignal.aborted, true, 'the gated abort fired the runner signal');

  const ran = await p;
  assert.equal(ran.status, 'aborted');
  const onDisk = JSON.parse(fs.readFileSync(historyPathFor(userDataDir, root), 'utf8'));
  assert.equal(onDisk.byConfig.unit[0].status, 'aborted', 'the aborted run persisted to the per-root history');
});

// ---------------------------------------------------------------------------
// 4h) S18 config write path: saveConfigs normalizes + persists to the per-root
//     config FILE on disk; listConfigs reads it back; flag-off writes nothing.
// ---------------------------------------------------------------------------

test('wave-c/s18: saveConfigs persists to the per-root config file; flag-off writes nothing', (t) => {
  const { userDataDir, makeRoot } = sandbox(t);
  const root = makeRoot('rootA');
  let on = false;
  const wiring = createWorkspaceTestRunnerWiring({
    userDataDir,
    shellConfigService: rootRef(root),
    runner: passingRunner(),
    featureFlagProvider: () => ({ workspace_test_runner: on }),
    now: () => new Date(1000),
    makeRunId: () => 'run1',
  });

  // Flag OFF: disabled envelope; no config file is written.
  assert.deepEqual(wiring.saveConfigs([{ id: 'unit', command: 'echo hi' }]), { available: false, reason: 'feature_disabled' });
  assert.equal(fs.existsSync(configPathFor(userDataDir, root)), false, 'flag-off persists no config file');

  // Flag ON: normalizes (drops the invalid entry) + writes the per-root file.
  on = true;
  const saved = wiring.saveConfigs([
    { id: 'unit', label: 'Unit', command: 'echo hi', cwd: 'api' },
    { id: 'nope' }, // dropped (no command)
  ]);
  assert.deepEqual(saved.configs.map((c) => c.id), ['unit']);
  const onDisk = JSON.parse(fs.readFileSync(configPathFor(userDataDir, root), 'utf8'));
  assert.deepEqual(onDisk.configs.map((c) => c.id), ['unit'], 'normalized configs persisted to the per-root file');
  // listConfigs reads the freshly written config back (survives a reload).
  assert.deepEqual(wiring.listConfigs().configs.map((c) => c.id), ['unit']);
  assert.equal(wiring.listConfigs().configs[0].command, 'echo hi');
});

// ---------------------------------------------------------------------------
// 4b) A workspace-root switch DURING a run keeps the run on its originating root
//     (regression: recordStart/recordFinish must not split across two roots).
// ---------------------------------------------------------------------------

test('wave-a: a root switch DURING a run keeps start+finish on the originating root', async (t) => {
  const { userDataDir, makeRoot } = sandbox(t);
  const rootA = makeRoot('rootA');
  const rootB = makeRoot('rootB');
  writeConfigs(userDataDir, rootA, [{ id: 'unit', label: 'A', command: 'echo a' }]);
  writeConfigs(userDataDir, rootB, [{ id: 'unit', label: 'B', command: 'echo b' }]);
  const scs = rootRef(rootA);
  // The injected runner flips the LIVE root A->B while the run is in flight,
  // simulating the user picking a new workspace folder mid-run (the run started
  // under A; recordStart already landed on A, recordFinish happens after).
  const runner = {
    calls: [],
    runTestCommand: (opts) => {
      runner.calls.push(opts);
      scs.set(rootB);
      return Promise.resolve({ status: 'passed', exitCode: 0, durationMs: 5, startedAt: 'S', finishedAt: 'F' });
    },
  };
  const wiring = createWorkspaceTestRunnerWiring({
    userDataDir,
    shellConfigService: scs,
    runner,
    featureFlagProvider: flag(true),
    now: () => new Date(6000),
    makeRunId: () => 'run1',
  });

  const ran = await wiring.run({ configId: 'unit' });
  assert.equal(ran.status, 'passed');
  assert.equal(runner.calls[0].command, 'echo a', 'the run executed against the originating root');

  // The finish landed on root A: exactly one terminal record, no phantom 'running'.
  const aHist = JSON.parse(fs.readFileSync(historyPathFor(userDataDir, rootA), 'utf8'));
  assert.equal(aHist.byConfig.unit.length, 1);
  assert.equal(aHist.byConfig.unit[0].status, 'passed', 'no phantom running on the originating root');
  assert.equal(aHist.byConfig.unit[0].runId, 'run1');

  // Root B (the switched-to root) received NO spurious orphan run.
  assert.equal(fs.existsSync(historyPathFor(userDataDir, rootB)), false, 'no orphan leaked into the new root');
});

// ---------------------------------------------------------------------------
// 4c) Stores key on the REALPATH — a non-canonical alias of the same root reads
//     one store (kills the hashRoot(root) mutant that ignores resolveRealPathSafe).
// ---------------------------------------------------------------------------

test('wave-a: a non-canonical alias of the same root resolves to one store', async (t) => {
  const { userDataDir, makeRoot } = sandbox(t);
  const rootA = makeRoot('rootA');
  writeConfigs(userDataDir, rootA, [{ id: 'unit', label: 'Unit', command: 'echo hi' }]);
  // Textually different, but realpath-equal to rootA (rootA exists, so the
  // redundant `..` segment collapses under realpath). Build the alias as a RAW
  // string — path.join would normalize the `..` away before it has any teeth.
  const alias = `${rootA}${path.sep}..${path.sep}${path.basename(rootA)}`;
  assert.notEqual(alias, rootA, 'alias differs textually from the canonical root');
  const runner = passingRunner();
  const wiring = createWorkspaceTestRunnerWiring({
    userDataDir,
    shellConfigService: rootRef(alias),
    runner,
    featureFlagProvider: flag(true),
    now: () => new Date(7000),
    makeRunId: () => 'run1',
  });

  // Keyed by realpath: the alias reads rootA's seeded config (would be [] if the
  // key used the raw alias string instead of its realpath).
  assert.deepEqual(wiring.listConfigs().configs.map((c) => c.id), ['unit']);
  await wiring.run({ configId: 'unit' });
  assert.equal(fs.existsSync(historyPathFor(userDataDir, rootA)), true, 'run persisted to the canonical store');
});

// ---------------------------------------------------------------------------
// 4d) On Windows, a NON-EXISTENT root keys case-insensitively (the path.resolve
//     fallback preserves case; the win32 lowercase keying must coalesce it).
// ---------------------------------------------------------------------------

test('wave-a: a non-existent root keys case-insensitively on win32', { skip: process.platform !== 'win32' }, async (t) => {
  const { base, userDataDir } = sandbox(t);
  // Two casings of the SAME directory that does NOT exist on disk.
  const upper = path.join(base, 'GhostRoot', 'Proj');
  const lower = path.join(base, 'ghostroot', 'proj');
  // Seed under the upper-case form; the win32 keying lowercases, so the lower-case
  // form must read the very same store.
  writeConfigs(userDataDir, upper, [{ id: 'unit', label: 'Unit', command: 'echo hi' }]);
  const runner = passingRunner();
  const wiring = createWorkspaceTestRunnerWiring({
    userDataDir,
    shellConfigService: rootRef(lower),
    runner,
    featureFlagProvider: flag(true),
    now: () => new Date(8000),
    makeRunId: () => 'run1',
  });
  assert.deepEqual(wiring.listConfigs().configs.map((c) => c.id), ['unit'], 'casing variants share one store');
  const ran = await wiring.run({ configId: 'unit' });
  assert.equal(ran.status, 'passed');
});

// ---------------------------------------------------------------------------
// 4e) Switching to a root with a crash-orphaned 'running' record reconciles it
//     to 'interrupted' on first touch (S5b at the wiring seam).
// ---------------------------------------------------------------------------

test('wave-a: switching to a root with an orphaned running record reconciles it to interrupted', (t) => {
  const { userDataDir, makeRoot } = sandbox(t);
  const rootA = makeRoot('rootA');
  const rootB = makeRoot('rootB');
  writeConfigs(userDataDir, rootA, [{ id: 'unit', label: 'A', command: 'echo a' }]);
  // Seed root B's history with a crash-orphaned 'running' record (as a prior
  // session crash/reload would leave it).
  const bHistFile = historyPathFor(userDataDir, rootB);
  fs.mkdirSync(path.dirname(bHistFile), { recursive: true });
  fs.writeFileSync(bHistFile, JSON.stringify({
    byConfig: {
      unit: [{ runId: 'old', configId: 'unit', status: 'running', startedAt: 'X', exitCode: null, durationMs: null, finishedAt: null }],
    },
  }), 'utf8');

  const scs = rootRef(rootA);
  const wiring = createWorkspaceTestRunnerWiring({
    userDataDir,
    shellConfigService: scs,
    runner: passingRunner(),
    featureFlagProvider: flag(true),
    now: () => new Date(9000),
    makeRunId: () => 'run1',
  });

  // First touch of root B builds its bundle -> reconcileRunning fires.
  scs.set(rootB);
  const state = wiring.getState();
  assert.equal(state.history.byConfig.unit.length, 1);
  assert.equal(state.history.byConfig.unit[0].status, 'interrupted', 'orphaned running reconciled on switch');

  const onDisk = JSON.parse(fs.readFileSync(bHistFile, 'utf8'));
  assert.equal(onDisk.byConfig.unit[0].status, 'interrupted', 'reconcile persisted to the new root file');
});

// ---------------------------------------------------------------------------
// 4f) userData is resolved via app.getPath when userDataDir is not passed
//     (the real production path); app.getPath throwing degrades fail-closed.
// ---------------------------------------------------------------------------

test('wave-a: resolves userData via app.getPath when userDataDir is omitted', async (t) => {
  const { userDataDir, makeRoot } = sandbox(t);
  const root = makeRoot('rootA');
  writeConfigs(userDataDir, root, [{ id: 'unit', label: 'Unit', command: 'echo hi' }]);
  const runner = passingRunner();
  const wiring = createWorkspaceTestRunnerWiring({
    app: { getPath: (key) => (key === 'userData' ? userDataDir : '') },
    shellConfigService: rootRef(root),
    runner,
    featureFlagProvider: flag(true),
    now: () => new Date(1000),
    makeRunId: () => 'run1',
  });

  assert.deepEqual(wiring.listConfigs().configs.map((c) => c.id), ['unit']);
  const ran = await wiring.run({ configId: 'unit' });
  assert.equal(ran.status, 'passed');
  assert.equal(fs.existsSync(historyPathFor(userDataDir, root)), true, 'wrote through the app-resolved userData dir');
});

test('wave-a: app.getPath throwing degrades fail-closed (no crash)', () => {
  const wiring = createWorkspaceTestRunnerWiring({
    app: { getPath: () => { throw new Error('boom'); } },
    shellConfigService: rootRef('/some/root'),
    runner: passingRunner(),
    featureFlagProvider: flag(true),
    now: () => new Date(1000),
  });
  // No userData dir -> no per-root store -> empty-but-valid state, never a throw.
  assert.deepEqual(wiring.getState(), { configs: [], history: { byConfig: {} }, activeRun: null, activeConfigId: null });
});

// ---------------------------------------------------------------------------
// S13 (live push) — the wiring injects an onStateChange emitter that pushes a
// workspaceTestRunner.onStateChanged bridge event at run start + finish. The
// push is flag-gated: a flag-off run never reaches the service (no push at all).
// ---------------------------------------------------------------------------

test('wave-c/s13: a run pushes onStateChanged via sendBridgeEvent (flag on); flag-off pushes nothing', async (t) => {
  const { userDataDir, makeRoot } = sandbox(t);
  const root = makeRoot('rootA');
  writeConfigs(userDataDir, root, [{ id: 'unit', label: 'Unit', command: 'echo hi' }]);
  let on = false;
  const pushes = [];
  const wiring = createWorkspaceTestRunnerWiring({
    userDataDir,
    shellConfigService: rootRef(root),
    runner: passingRunner(),
    featureFlagProvider: () => ({ workspace_test_runner: on }),
    sendBridgeEvent: (channelPath, payload) => pushes.push({ channelPath, payload }),
    now: () => new Date(1000),
    makeRunId: () => 'run1',
  });

  // Flag OFF: the gated run never reaches the service, so nothing is pushed.
  await wiring.run({ configId: 'unit' });
  assert.equal(pushes.length, 0, 'flag-off run emits no onStateChanged push');

  // Flag ON: the run pushes start + finish on the onStateChanged path.
  on = true;
  await wiring.run({ configId: 'unit' });
  assert.deepEqual(
    pushes.map((p) => p.channelPath),
    ['workspaceTestRunner.onStateChanged', 'workspaceTestRunner.onStateChanged'],
    'both start and finish push the onStateChanged bridge path'
  );
  assert.deepEqual(pushes.map((p) => p.payload.phase), ['started', 'finished']);
  assert.equal(pushes[0].payload.configId, 'unit');
  assert.equal(pushes[0].payload.runId, 'run1');
});

// ---------------------------------------------------------------------------
// 5) Production registration fn — exactly 4 channels, round-trips the real service
// ---------------------------------------------------------------------------

test('wave-c: registerWorkspaceTestRunnerIpcHandlers wires exactly 5 channels and round-trips', async (t) => {
  const { userDataDir, makeRoot } = sandbox(t);
  const root = makeRoot('rootA');
  writeConfigs(userDataDir, root, [{ id: 'unit', label: 'Unit', command: 'echo hi' }]);
  const runner = passingRunner();
  const wiring = createWorkspaceTestRunnerWiring({
    userDataDir,
    shellConfigService: rootRef(root),
    runner,
    featureFlagProvider: flag(true),
    now: () => new Date(5000),
    makeRunId: () => 'run1',
  });

  const handlers = {};
  const ipcMain = { handle: (channel, fn) => { handlers[channel] = fn; } };
  const channels = registerWorkspaceTestRunnerIpcHandlers(ipcMain, wiring);

  const expected = [
    'workspace-test-runner:abort',
    'workspace-test-runner:get-state',
    'workspace-test-runner:list-configs',
    'workspace-test-runner:run',
    'workspace-test-runner:save-configs',
  ];
  assert.deepEqual([...channels].sort(), expected, 'returns exactly the 5 registered channels');
  assert.deepEqual(Object.keys(handlers).sort(), expected, 'registers exactly the 5 channels');

  // The abort channel round-trips a clean no-op when no run is active.
  const abortNoop = await handlers[getBridgeChannel('workspaceTestRunner.abort', 'invoke')](null);
  assert.deepEqual(abortNoop, { aborted: false });

  // Round-trip the real wiring through the registered handlers (event arg first).
  const listed = await handlers[getBridgeChannel('workspaceTestRunner.listConfigs', 'invoke')](null);
  assert.deepEqual(listed.configs.map((c) => c.id), ['unit']);

  const ran = await handlers[getBridgeChannel('workspaceTestRunner.run', 'invoke')](null, { configId: 'unit' });
  assert.equal(ran.status, 'passed');
  assert.equal(runner.calls.length, 1);

  const state = await handlers[getBridgeChannel('workspaceTestRunner.getState', 'invoke')](null);
  assert.equal(state.history.byConfig.unit.length, 1);
  assert.equal(state.activeRun, null);

  // S18: the save-configs channel persists a normalized write to the per-root
  // file (done last so it does not disturb the run/list round-trips above).
  const saved = await handlers[getBridgeChannel('workspaceTestRunner.saveConfigs', 'invoke')](null, [
    { id: 'e2e', label: 'E2E', command: 'npm run e2e' },
    { id: 'bad' },
  ]);
  assert.deepEqual(saved.configs.map((c) => c.id), ['e2e'], 'the normalized set round-trips through the channel');
  const onDiskConfig = JSON.parse(fs.readFileSync(configPathFor(userDataDir, root), 'utf8'));
  assert.deepEqual(onDiskConfig.configs.map((c) => c.id), ['e2e'], 'save-configs persisted through the channel');
});

// ---------------------------------------------------------------------------
// 6) Integration — registerMainIpcHandlers actually CALLS the registration fn
//    (guards the "defined but never wired" false-green; deps shape mirrors the
//    proven fixture in tests/ipc-handler-registration.test.js).
// ---------------------------------------------------------------------------

test('wave-a: registerMainIpcHandlers wires the workspaceTestRunner.* channels', () => {
  const invoke = new Map();
  const send = new Map();
  const ipcMain = {
    handle: (channel, handler) => invoke.set(channel, handler),
    on: (channel, handler) => send.set(channel, handler),
  };
  const backendService = new Proxy(
    { sessionStore: {}, attachmentAssetStore: null, shadowStore: {} },
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        return (...args) => ({ __method: prop, args });
      },
    }
  );
  const shellConfigService = {
    getWorkspaceState: () => ({}),
    updateWorkspaceState: () => ({}),
    getWorkspaceIdeState: () => ({}),
    updateWorkspaceIdeState: () => ({}),
    getToolsWorkspaceRoot: () => '',
    getState: () => ({}),
    getWorkspaceRootStatus: () => 'none',
    clearToolsWorkspaceRoot: () => {},
    get: () => undefined,
    set: () => {},
  };
  const deps = {
    app: { getPath: () => path.join(os.tmpdir(), 'tr-wiring-userdata') },
    ipcMain,
    backendService,
    logStore: { list: () => [] },
    updateService: {
      getState: () => ({}), check: () => ({}), download: () => ({}), install: () => ({}), skip: () => ({}),
    },
    personalityWorkspace: {
      getWorkspaceState: () => ({}), listFiles: () => [], readFile: () => ({}),
      writeFile: () => ({}), resetFile: () => ({}), openWorkspaceFolder: () => ({}),
    },
    artifactService: {},
    getProactiveStatePayload: () => ({}),
    shellConfigService,
    companionService: {},
    skillsService: { getState: () => ({}), updateSettings: () => ({}), openScopeFolder: () => ({}) },
    tipsService: { getState: () => ({}), updateSettings: () => ({}) },
    suggestionCache: {},
    offlineIntelligenceService: {},
    applyFeatureSettingsPatch: () => ({}),
    dialog: { showSaveDialog: async () => ({ canceled: true }), showOpenDialog: async () => ({ canceled: true }) },
    getMainWindow: () => null,
    processRef: process,
    clipboard: { writeText() {} },
    log: () => null,
    getMainLifecycle: () => null,
    getWindowState: () => null,
    startDeferredServices: () => {},
    toolExecutor: { registry: { getAllTools: () => [] } },
    toolPermissionStore: {},
    usageHistory: {},
    setupService: {},
    ollamaInstallService: {},
    mcpDiscoveryService: {},
    schedulerService: {},
    weatherService: {},
    linkStatusService: {},
    calendarService: {},
    chatStreamBridge: {},
    getStartupAuditConfig: () => ({ enabled: false }),
    createStartupAuditMarkHandler: () => () => ({ recorded: true }),
    createStartupAuditMarksBatchHandler: () => () => ({ recorded: true }),
    refreshGpuMemorySample: async () => null,
    getCurrentSystemStatsPayload: () => ({ cpu: 0 }),
    buildFeatureStatePayload: () => ({ flags: {} }),
    getOverlayRef: () => null,
    setOverlayRef: () => {},
    isCometOverlayEnabled: () => false,
    createCometOverlay: () => null,
    handleCometOverlayToggle: () => null,
    normalizeCometOverlayPresencePayload: (p) => p,
    getProcessLogWriter: () => null,
    getLogRedactionPrefixes: () => [],
    sendBridgeEvent: () => {},
    workspaceSnapshotStore: null,
    authorizeWorkspaceSender: () => true,
  };

  registerMainIpcHandlers(deps);

  for (const channel of [
    'workspace-test-runner:list-configs',
    'workspace-test-runner:run',
    'workspace-test-runner:abort',
    'workspace-test-runner:save-configs',
    'workspace-test-runner:get-state',
  ]) {
    assert.equal(invoke.has(channel), true, `registerMainIpcHandlers must wire ${channel}`);
  }
});
