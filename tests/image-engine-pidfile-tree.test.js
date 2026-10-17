'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createTrackedTempDir, cleanupTrackedResources } = require('./helpers/resource-cleanup');
const { runImageGeneration } = require('../services/image-engine-runner');
const pidfile = require('../services/image-engine-pidfile');
const processTools = require('../services/backend/process-tree-tools');
const { createChatGpuHandoff } = require('../services/backend/chat-gpu-handoff');
const { ExclusiveGpuCoordinator, STATE_CHAT_RESIDENT, STATE_PRIVILEGED_RESIDENT } = require('../services/backend/exclusive-gpu-coordinator');

test.afterEach(cleanupTrackedResources);

const ROOT = 42001;
const WORKER = 42002;

function fakeChild() {
  const child = new EventEmitter();
  child.pid = ROOT;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

// A simulated process table: the root exits, its worker keeps running (Windows
// keeps the dead root's pid as the worker's parent) and ignores termination.
// Untimed tables model POSIX `ps`, which reports no creation times.
function simulatedTree({ timed = true } = {}) {
  const table = { spawnMs: 0, rootAlive: true, workerAlive: true, killed: [] };
  const at = (offset) => (timed ? table.spawnMs + offset : null);
  const rows = () => [
    ...(table.rootAlive ? [{ pid: ROOT, ppid: 7, createdMs: at(0) }] : []),
    ...(table.workerAlive ? [{ pid: WORKER, ppid: ROOT, createdMs: at(5) }] : []),
  ];
  const isAlive = (pid) => (pid === ROOT ? table.rootAlive : pid === WORKER && table.workerAlive);
  table.isAlive = isAlive;
  table.tools = {
    enumerateDescendants: async () => ({ ok: true, pids: [WORKER],
      processes: [{ pid: WORKER, createdMs: at(5) }], rootCreatedMs: at(0) }),
    listProcessRows: async () => ({ ok: true, rows: rows() }),
    selectRootSurvivors: processTools.selectRootSurvivors,
    terminatePids: async (pids) => { table.killed.push(...pids); },
    confirmAllGone: (pids) => processTools.confirmAllGone(pids, { isProcessAliveImpl: isAlive, timeoutMs: 0 }),
    killTreeWithProof: async () => ({ confirmed: false, pids: [ROOT], survivors: [ROOT] }),
  };
  return table;
}

async function renderWithSurvivingWorker(table = simulatedTree(), { fsImpl } = {}) {
  const userDataPath = createTrackedTempDir('jenny-image-tree-');
  const scratch = path.join(userDataPath, 'image-engine-scratch');
  fs.mkdirSync(scratch);
  const outputPath = path.join(scratch, 'render_tree_1.png');
  const child = fakeChild();
  const pending = runImageGeneration({ exePath: process.execPath, argv: ['-o', outputPath], outputPath, scratchDir: scratch,
    opId: 'render_tree_1', userDataPath, deadlineMs: 10000, expectedWidth: 2, expectedHeight: 3, fsImpl,
    spawnImpl: () => { table.spawnMs = Date.now(); return child; },
    sleep: async () => {}, processTools: table.tools });
  await new Promise((resolve) => setTimeout(resolve, 20));
  table.rootAlive = false;
  child.emit('exit', 0, null);
  const result = await pending;
  return { userDataPath, table, result, pidPath: pidfile.getImageEnginePidPath(userDataPath) };
}

test('an exited root with a surviving worker keeps its record and the GPU lease until the tree is proven dead', async () => {
  const { userDataPath, table, result, pidPath } = await renderWithSurvivingWorker();
  assert.equal(result.status, 'unconfirmed', JSON.stringify(result));
  assert.ok(pidfile.readRenderRecord(pidPath), 'the runner retains the record');

  const coordinator = new ExclusiveGpuCoordinator();
  const reconcileOptions = { userDataPath, isProcessAliveImpl: table.isAlive, processTools: table.tools,
    getProcessCommandLineImpl: async () => assert.fail('the dead root is never inspected'),
    killTreeImpl: async () => assert.fail('the dead root is never killed') };
  const handoff = createChatGpuHandoff({ backendService: { activeStreams: new Map() }, coordinator,
    reconcileRenderProcesses: () => pidfile.reconcileRenderRecord(reconcileOptions) });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    table.killed.length = 0;
    assert.deepEqual(await handoff.reconcile(), { confirmed: false, released: false });
    assert.deepEqual(table.killed, [WORKER], 'the recorded worker is targeted, never the dead root pid');
    assert.ok(pidfile.readRenderRecord(pidPath), 'repeated reconciliation keeps the record');
    assert.equal(coordinator.getState().state, STATE_PRIVILEGED_RESIDENT, 'GPU admission stays retained');
  }

  table.workerAlive = false;
  assert.deepEqual(await handoff.reconcile(), { confirmed: true, released: true });
  assert.equal(pidfile.readRenderRecord(pidPath), null);
  assert.deepEqual(coordinator.getState(), { state: STATE_CHAT_RESIDENT, leaseId: null });
});

test('a recorded worker whose pid now names another process is not ours and does not block clearing', async () => {
  const { userDataPath, table, pidPath } = await renderWithSurvivingWorker();
  table.workerAlive = false;
  const reused = { ...table.tools, listProcessRows: async () => ({ ok: true,
    rows: [{ pid: WORKER, ppid: 9, createdMs: table.spawnMs + 60_000 }] }) };
  assert.deepEqual(await pidfile.reconcileRenderRecord({ userDataPath, isProcessAliveImpl: () => false,
    processTools: { ...reused, terminatePids: async (pids) => assert.deepEqual(pids, [], 'a stranger is never killed') } }),
  { confirmed: true, action: 'cleared_stale' });
  assert.equal(pidfile.readRenderRecord(pidPath), null);
});

test('an unavailable process table keeps the tree record unconfirmed; the sync path never clears it', async () => {
  const { userDataPath, table, pidPath } = await renderWithSurvivingWorker();
  const record = pidfile.readRenderRecord(pidPath);
  assert.deepEqual(await pidfile.reconcileRenderRecord({ userDataPath, isProcessAliveImpl: () => false,
    processTools: { ...table.tools, listProcessRows: async () => ({ ok: false, rows: [] }) } }),
  { confirmed: false, action: 'unconfirmed' });
  assert.deepEqual(killRenderRecordSyncDead(userDataPath), { hadState: true, killed: false });
  assert.deepEqual(pidfile.readRenderRecord(pidPath), record);
});

function killRenderRecordSyncDead(userDataPath) {
  return pidfile.killRenderRecordSync({ userDataPath, isProcessAliveImpl: () => false,
    spawnSyncImpl: () => assert.fail('a dead root is never killed') });
}

test('a malformed tree record reads as null like any corrupt record', () => {
  const userDataPath = createTrackedTempDir('jenny-image-tree-');
  const pidPath = pidfile.getImageEnginePidPath(userDataPath);
  const base = { version: 1, pid: 5, exePath: 'x', opId: 'render_tree_2', output: 'y', startedAt: 1 };
  const tree = { spawnedAtMs: 1, spawnReturnedAtMs: 2, rootHeldUntilMs: 3, rootCreatedMs: null,
    processes: [], survivors: [{ pid: 6, createdMs: null }] };
  fs.writeFileSync(pidPath, JSON.stringify({ ...base, tree }));
  assert.deepEqual(pidfile.readRenderRecord(pidPath), { ...base, tree });
  for (const bad of [{ ...tree, survivors: [{ pid: -1, createdMs: null }] }, { ...tree, spawnedAtMs: 'x' },
    { ...tree, processes: Array.from({ length: 129 }, (_, i) => ({ pid: i + 1, createdMs: null })) }, 7]) {
    fs.writeFileSync(pidPath, JSON.stringify({ ...base, tree: bad }));
    assert.equal(pidfile.readRenderRecord(pidPath), null);
  }
});

function retainingHandoff(reconcileOptions) {
  const coordinator = new ExclusiveGpuCoordinator();
  const handoff = createChatGpuHandoff({ backendService: { activeStreams: new Map() }, coordinator,
    reconcileRenderProcesses: () => pidfile.reconcileRenderRecord(reconcileOptions) });
  return { coordinator, handoff };
}

test('a retained worker without a creation time is never killed once its pid may name a stranger', async () => {
  const { userDataPath, table, result, pidPath } = await renderWithSurvivingWorker(simulatedTree({ timed: false }));
  assert.equal(result.status, 'unconfirmed', JSON.stringify(result));
  assert.deepEqual(pidfile.readRenderRecord(pidPath).tree.survivors, [{ pid: WORKER, createdMs: null }]);
  // The worker exited and an unrelated process with another parent now holds its pid; it would die if signalled.
  const stranger = { alive: true, killed: [] };
  const tools = { ...table.tools,
    listProcessRows: async () => ({ ok: true, rows: stranger.alive ? [{ pid: WORKER, ppid: 9, createdMs: null }] : [] }),
    terminatePids: async (pids) => { stranger.killed.push(...pids); if (pids.includes(WORKER)) stranger.alive = false; },
    confirmAllGone: (pids) => processTools.confirmAllGone(pids,
      { isProcessAliveImpl: (pid) => pid === WORKER && stranger.alive, timeoutMs: 0 }) };
  const options = { userDataPath, isProcessAliveImpl: () => false, processTools: tools };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.deepEqual(await pidfile.reconcileRenderRecord(options), { confirmed: false, action: 'unconfirmed' });
    assert.deepEqual(stranger.killed, [], 'a pid without identity evidence is never terminated');
    assert.ok(pidfile.readRenderRecord(pidPath), 'the record stays until identity is resolved');
  }
  stranger.alive = false;
  assert.deepEqual(await pidfile.reconcileRenderRecord(options), { confirmed: true, action: 'cleared_stale' });
  assert.equal(pidfile.readRenderRecord(pidPath), null);
});

async function renderWithFailedEnrichment() {
  let renames = 0;
  const fsImpl = { ...fs, renameSync(from, to) {
    renames += 1;
    if (renames > 1) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    return fs.renameSync(from, to);
  } };
  const rendered = await renderWithSurvivingWorker(simulatedTree(), { fsImpl });
  assert.equal(rendered.result.status, 'unconfirmed', JSON.stringify(rendered.result));
  assert.equal(rendered.result.recorded, true);
  assert.equal(pidfile.readRenderRecord(rendered.pidPath).tree, undefined, 'the tree evidence never reached the disk');
  return rendered;
}

// What the table can show once the root has exited and its tree evidence never landed.
const UNTRACKED_SURVIVORS = {
  'a worker still listed under the dead root (Windows)': (spawnMs) => [{ pid: WORKER, ppid: ROOT, createdMs: spawnMs + 5 }],
  'a worker reparented to init (POSIX ps)': () => [{ pid: WORKER, ppid: 1, createdMs: null }],
  'a worker that exited, leaving its child under it (Windows)': (spawnMs) => [{ pid: 42003, ppid: WORKER, createdMs: spawnMs + 40 }],
  'nothing listed: an absent link is not proof': () => [],
};

for (const [name, survivors] of Object.entries(UNTRACKED_SURVIVORS)) {
  test(`a failed tree-evidence write keeps the record and the GPU retained: ${name}`, async () => {
    const { userDataPath, table, pidPath } = await renderWithFailedEnrichment();
    const tools = { ...table.tools, listProcessRows: async () => ({ ok: true, rows: survivors(table.spawnMs) }),
      terminatePids: async (pids) => assert.deepEqual(pids, [], 'nothing is killed without identity evidence') };
    const { coordinator, handoff } = retainingHandoff({ userDataPath, isProcessAliveImpl: () => false, processTools: tools,
      getProcessCommandLineImpl: async () => assert.fail('the dead root is never inspected') });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.deepEqual(await handoff.reconcile(), { confirmed: false, released: false });
      assert.ok(pidfile.readRenderRecord(pidPath), 'repeated reconciliation keeps the record');
      assert.equal(coordinator.getState().state, STATE_PRIVILEGED_RESIDENT, 'GPU admission stays retained');
    }
  });
}

test('a marked record clears on the kill-with-proof pass over its live root, never on a dead root', async () => {
  const userDataPath = createTrackedTempDir('jenny-image-tree-');
  const pidPath = pidfile.getImageEnginePidPath(userDataPath);
  const record = { pid: ROOT, exePath: process.execPath, opId: 'render_tree_3', output: path.join(userDataPath, 'x.png'),
    startedAt: 1, treeSince: 1 };
  const empty = { listProcessRows: async () => ({ ok: true, rows: [] }) };
  pidfile.writeRenderRecord(pidPath, record, { isProcessAliveImpl: () => false });
  assert.deepEqual(await pidfile.reconcileRenderRecord({ userDataPath, isProcessAliveImpl: () => false, processTools: empty }),
    { confirmed: false, action: 'unconfirmed' });
  assert.deepEqual(await pidfile.reconcileRenderRecord({ userDataPath, isProcessAliveImpl: () => true, processTools: empty,
    getProcessCommandLineImpl: async () => `sd-cli -o ${record.opId}.png`, killTreeImpl: async () => ({ confirmed: true }) }),
  { confirmed: true, action: 'killed' });
  assert.equal(pidfile.readRenderRecord(pidPath), null);
});

test('an early cancellation keeps the surviving grandchild the kill helper reported', async () => {
  const userDataPath = createTrackedTempDir('jenny-image-tree-');
  const scratch = path.join(userDataPath, 'image-engine-scratch');
  fs.mkdirSync(scratch);
  const outputPath = path.join(scratch, 'render_tree_4.png');
  const table = simulatedTree();
  const GRANDCHILD = 42003;
  const controller = new AbortController();
  const tools = { ...table.tools,
    enumerateDescendants: async () => assert.fail('the early snapshot never starts'),
    killTreeWithProof: async () => ({ confirmed: false, enumerated: true, pids: [ROOT, WORKER, GRANDCHILD],
      survivors: [GRANDCHILD] }) };
  const pending = runImageGeneration({ exePath: process.execPath, argv: ['-o', outputPath], outputPath, scratchDir: scratch,
    opId: 'render_tree_4', userDataPath, deadlineMs: 10000, expectedWidth: 2, expectedHeight: 3, abortSignal: controller.signal,
    spawnImpl: () => { table.spawnMs = Date.now(); return fakeChild(); }, processTools: tools });
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  assert.equal((await pending).status, 'unconfirmed');
  const pidPath = pidfile.getImageEnginePidPath(userDataPath);
  const grandchild = { alive: true, killed: [] };
  const reconcileTools = { ...tools, terminatePids: async (pids) => { grandchild.killed.push(...pids); },
    listProcessRows: async () => ({ ok: true,
      rows: grandchild.alive ? [{ pid: GRANDCHILD, ppid: WORKER, createdMs: table.spawnMs + 40 }] : [] }) };
  const options = { userDataPath, isProcessAliveImpl: () => false, processTools: reconcileTools };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.deepEqual(await pidfile.reconcileRenderRecord(options), { confirmed: false, action: 'unconfirmed' });
    assert.deepEqual(grandchild.killed, [], 'a survivor without a creation time is never terminated');
    assert.ok(pidfile.readRenderRecord(pidPath));
  }
  grandchild.alive = false;
  assert.deepEqual(await pidfile.reconcileRenderRecord(options), { confirmed: true, action: 'cleared_stale' });
});

test('a recorded worker that exits leaves its surviving descendants blocking clearing and GPU admission', async () => {
  const { userDataPath, table, pidPath } = await renderWithSurvivingWorker();
  assert.deepEqual(pidfile.readRenderRecord(pidPath).tree.survivors.map(({ pid }) => pid), [WORKER]);
  // The worker started C and exited; Windows keeps the dead worker's pid as C's parent.
  // Later C starts D and exits, so D is listed only under C.
  table.workerAlive = false;
  let rows = [{ pid: 42003, ppid: WORKER, createdMs: table.spawnMs + 40 }];
  const tools = { ...table.tools, listProcessRows: async () => ({ ok: true, rows }) };
  const { coordinator, handoff } = retainingHandoff({ userDataPath, isProcessAliveImpl: table.isAlive, processTools: tools });
  const blocked = async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.deepEqual(await handoff.reconcile(), { confirmed: false, released: false });
      assert.ok(pidfile.readRenderRecord(pidPath), 'repeated reconciliation keeps the record');
      assert.equal(coordinator.getState().state, STATE_PRIVILEGED_RESIDENT, 'GPU admission stays retained');
    }
  };
  await blocked();
  rows = [{ pid: 42004, ppid: 42003, createdMs: table.spawnMs + 80 }];
  await blocked();
  rows = [];
  assert.deepEqual(await handoff.reconcile(), { confirmed: true, released: true });
  assert.equal(pidfile.readRenderRecord(pidPath), null);
});

test('a failed write of newly observed descendants keeps the reconciliation unconfirmed', async () => {
  const { userDataPath, table, pidPath } = await renderWithSurvivingWorker();
  const before = pidfile.readRenderRecord(pidPath);
  table.workerAlive = false;
  const tools = { ...table.tools, listProcessRows: async () => ({ ok: true,
    rows: [{ pid: 42003, ppid: WORKER, createdMs: table.spawnMs + 40 }] }) };
  const fsImpl = { ...fs, renameSync() { throw Object.assign(new Error('rename failed'), { code: 'EPERM' }); } };
  assert.deepEqual(await pidfile.reconcileRenderRecord({ userDataPath, fsImpl, isProcessAliveImpl: () => false, processTools: tools }),
    { confirmed: false, action: 'unconfirmed' });
  assert.deepEqual(pidfile.readRenderRecord(pidPath), before, 'the record is never cleared on a failed update');
});
