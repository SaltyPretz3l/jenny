'use strict';
// new-test-file: the graphics-memory usage store and the holder's measuring and warning (row 197 R3c) are a new surface; run-view-wiring.test.js is near its line cap.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  RUN_GPU_MEMORY_FILENAME, RUN_GPU_MEMORY_SCHEMA_VERSION, createRunGpuMemoryStore,
} = require('../services/run-view/run-gpu-memory');
const runView = require('../services/run-view');
const { createLazyRunView } = require('../services/main/run-view-composition');
const { METHODS, registerRunViewIpc } = require('../services/main/run-view-ipc-registration');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-run-gpu-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const fileIn = (dir) => path.join(dir, RUN_GPU_MEMORY_FILENAME);

function fakeIpcMain() {
  const handlers = new Map();
  return { handlers, handle: (channel, fn) => handlers.set(channel, fn) };
}
const ALLOW = { authorize: () => true };
const call = (ipc, method, payload) => ipc.handlers.get(METHODS[method].channel)({}, payload);

test('a recorded amount reads back, survives a restart, and is forgotten on request', (t) => {
  const dir = tempDir(t);
  const store = createRunGpuMemoryStore({ userDataPath: dir, now: () => 1700000000000 });
  assert.equal(store.get('p1'), null);
  assert.equal(store.record('p1', 1800).ok, true);
  assert.equal(store.get('p1'), 1800);
  const onDisk = JSON.parse(fs.readFileSync(fileIn(dir), 'utf8'));
  assert.deepEqual(onDisk, { schema_version: RUN_GPU_MEMORY_SCHEMA_VERSION, projects: { p1: { mb: 1800, at: 1700000000000 } } });
  assert.equal(createRunGpuMemoryStore({ userDataPath: dir }).get('p1'), 1800);
  assert.equal(store.forget('p1').ok, true);
  assert.equal(store.get('p1'), null);
  assert.equal(createRunGpuMemoryStore({ userDataPath: dir }).get('p1'), null);
  assert.equal(store.forget('never-recorded').ok, true);
});

test('a bad id or a bad amount is refused and nothing is written', (t) => {
  const dir = tempDir(t);
  const store = createRunGpuMemoryStore({ userDataPath: dir });
  for (const id of ['', 7, null, undefined, 'x'.repeat(201)]) {
    assert.equal(store.record(id, 100).ok, false, String(id));
    assert.equal(store.get(id), null, String(id));
  }
  for (const mb of [0, -5, 1.5, NaN, Infinity, '100', null, undefined, 1048577]) {
    assert.deepEqual(store.record('p1', mb), { ok: false, reason: 'mb_invalid' }, String(mb));
  }
  assert.equal(fs.existsSync(fileIn(dir)), false);
  assert.equal(store.record('p1', 1048576).ok, true);
  assert.equal(store.record('x'.repeat(200), 1).ok, true);
});

test('the 257th project drops the one recorded longest ago', (t) => {
  const dir = tempDir(t);
  let clock = 1000;
  const store = createRunGpuMemoryStore({ userDataPath: dir, now: () => clock });
  for (let i = 0; i < 256; i += 1) {
    clock += 1;
    assert.equal(store.record(`p${i}`, 100 + i).ok, true);
  }
  clock += 1;
  assert.equal(store.record('p0', 999).ok, true, 'recording an existing project again freshens it and drops nobody');
  assert.equal(store.get('p1'), 101);
  clock += 1;
  assert.equal(store.record('extra', 5).ok, true);
  assert.equal(store.get('p1'), null, 'the oldest is gone');
  assert.equal(store.get('p0'), 999);
  assert.equal(store.get('extra'), 5);
  const kept = Object.keys(JSON.parse(fs.readFileSync(fileIn(dir), 'utf8')).projects);
  assert.equal(kept.length, 256);
});

test('a file from a newer Jenny reads as empty and is left byte for byte as it was', (t) => {
  const dir = tempDir(t);
  const newer = `${JSON.stringify({ schema_version: RUN_GPU_MEMORY_SCHEMA_VERSION + 1, projects: { p1: { mb: 5, at: 1 } }, extra: true })}\n`;
  fs.writeFileSync(fileIn(dir), newer);
  const store = createRunGpuMemoryStore({ userDataPath: dir });
  assert.equal(store.get('p1'), null);
  assert.deepEqual(store.record('p1', 100), { ok: false, reason: 'store_newer' });
  assert.equal(store.forget('p1').ok, true, 'nothing is known, so nothing is forgotten');
  assert.equal(fs.readFileSync(fileIn(dir), 'utf8'), newer);
  assert.deepEqual(fs.readdirSync(dir), [RUN_GPU_MEMORY_FILENAME], 'no temp file is left behind');
});

test('a damaged file, a wrong shape and a bad entry read as nothing', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(fileIn(dir), '{ not json');
  assert.equal(createRunGpuMemoryStore({ userDataPath: dir }).get('p1'), null);
  fs.writeFileSync(fileIn(dir), JSON.stringify({ schema_version: 1, projects: [] }));
  assert.equal(createRunGpuMemoryStore({ userDataPath: dir }).get('p1'), null);
  fs.writeFileSync(fileIn(dir), JSON.stringify({
    schema_version: 1, projects: { bad: { mb: -1, at: 1 }, worse: 'x', good: { mb: 700, at: 2 }, noat: { mb: 5 } },
  }));
  const store = createRunGpuMemoryStore({ userDataPath: dir });
  assert.equal(store.get('bad'), null);
  assert.equal(store.get('worse'), null);
  assert.equal(store.get('noat'), null);
  assert.equal(store.get('good'), 700);
  // A damaged file is replaced by the next record.
  fs.writeFileSync(fileIn(dir), 'garbage');
  const again = createRunGpuMemoryStore({ userDataPath: dir });
  assert.equal(again.record('p2', 300).ok, true);
  assert.equal(createRunGpuMemoryStore({ userDataPath: dir }).get('p2'), 300);
});

test('a write goes to a temp file and is renamed over the real one; a failed rename leaves the old file and no temp', (t) => {
  const dir = tempDir(t);
  const log = [];
  let failRename = false;
  const spy = new Proxy(fs, {
    get: (target, key) => {
      const real = target[key];
      if (typeof real !== 'function') return real;
      return (...args) => {
        if (key === 'openSync' || key === 'renameSync' || key === 'unlinkSync') log.push([key, path.basename(String(args[0])), key === 'renameSync' ? path.basename(String(args[1])) : args[1]]);
        if (key === 'renameSync' && failRename) throw new Error('disk full');
        return real.apply(target, args);
      };
    },
  });
  const store = createRunGpuMemoryStore({ userDataPath: dir, fs: spy });
  assert.equal(store.record('p1', 100).ok, true);
  const [open, rename] = log;
  assert.equal(open[0], 'openSync');
  assert.match(open[1], /^run-gpu-memory\.json\..+\.tmp$/);
  assert.equal(open[2], 'wx');
  assert.deepEqual(rename, ['renameSync', open[1], RUN_GPU_MEMORY_FILENAME]);
  failRename = true;
  assert.deepEqual(store.record('p1', 200), { ok: false, reason: 'write_failed' });
  assert.equal(store.get('p1'), 100, 'memory only changes when the file did');
  assert.deepEqual(fs.readdirSync(dir), [RUN_GPU_MEMORY_FILENAME]);
  assert.equal(JSON.parse(fs.readFileSync(fileIn(dir), 'utf8')).projects.p1.mb, 100);
});

test('the store is exported from the run view index and needs a folder', () => {
  assert.equal(runView.createRunGpuMemoryStore, createRunGpuMemoryStore);
  assert.throws(() => createRunGpuMemoryStore({}), TypeError);
});

// R3c: what a program used of the graphics card, measured twice per run and remembered for the next Run.
function gpuHarness(t, { platform = 'win32', holders = [], pid = 4242, probeFreeMb, jobPids } = {}) {
  const userDataPath = tempDir(t);
  const timers = [];
  const h = {
    userDataPath, timers, lookups: [], holders, pid, jobPids, gate: Promise.resolve(), free: probeFreeMb === undefined ? 1000 : probeFreeMb,
    fire: async (delay) => {
      for (const timer of timers.filter((entry) => entry.ms === delay && !entry.cleared && !entry.fired)) { timer.fired = true; timer.fn(); }
      await settleTurns();
    },
    pending: () => timers.filter((timer) => !timer.cleared && !timer.fired).map((timer) => timer.ms),
  };
  h.holder = createLazyRunView({
    userDataPath, platform, getBackendService: () => null,
    setTimeout: (fn, ms) => { const timer = { fn, ms, cleared: false, fired: false, unref() { timer.unrefd = true; } }; timers.push(timer); return timer; },
    clearTimeout: (timer) => { timer.cleared = true; },
    listGpuHolders: async () => { h.lookups.push('list'); await h.gate; return h.holders; },
    probeFreeMb: async () => { if (h.free instanceof Error) throw h.free; return h.free; },
    modules: () => ({
      ...runView,
      createComputerHelperHost: () => ({ stop: async () => {} }),
      createRunService: (options) => {
        h.options = options;
        return { pidOf: () => h.pid, jobPids: async () => h.jobPids, onProjectDeleted: async () => ({ ok: true }), stopAll: async () => ({ ok: true }), dispose: () => {}, livePids: () => [] };
      },
    }),
  });
  h.holder.get();
  h.push = (state, generation = 1, projectId = 'p1') => h.options.emit('run-view:state', { projectId, state, generation, chatId: 'c1', exitCode: null });
  h.stored = (projectId = 'p1') => runView.createRunGpuMemoryStore({ userDataPath }).get(projectId);
  return h;
}

async function settleTurns() {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('R3c: a run that shows its window is sampled at 20 s and 60 s; a holder whose chain has the program is summed and kept', async (t) => {
  const h = gpuHarness(t, {
    holders: [
      { pid: 4242, name: 'game.exe', mb: 1000, chain: [{ pid: 4242, name: 'game.exe' }] },
      { pid: 5555, name: 'helper.exe', mb: 300, chain: [{ pid: 5555, name: 'helper.exe' }, { pid: 4242, name: 'game.exe' }] },
      { pid: 9999, name: 'llama-server.exe', mb: 6000, chain: [{ pid: 9999, name: 'llama-server.exe' }] },
    ],
  });
  h.push('building');
  h.push('starting');
  assert.deepEqual(h.pending(), [], 'nothing is sampled before the window shows');
  h.push('running');
  h.push('running');
  assert.deepEqual(h.pending(), [20000, 60000], 'one pair per generation');
  assert.ok(h.timers.every((timer) => timer.unrefd === true));
  await h.fire(20000);
  assert.equal(h.stored(), 1300);
  h.holders = [{ pid: 4242, name: 'game.exe', mb: 1900, chain: [{ pid: 4242, name: 'game.exe' }] }];
  await h.fire(60000);
  assert.equal(h.stored(), 1900);
  h.push('minimized');
  h.push('running');
  assert.deepEqual(h.pending(), [], 'a pair is not scheduled twice for one generation');
  await h.holder.shutdown();
});

test('F12: a holder belongs to the run when its pid or anything in its chain is in the job the helper lists', async (t) => {
  const h = gpuHarness(t, {
    jobPids: [4242, 6000],
    holders: [
      { pid: 6000, name: 'child.exe', mb: 400, chain: [{ pid: 6000, name: 'child.exe' }] },
      { pid: 7000, name: 'grandchild.exe', mb: 250, chain: [{ pid: 7000, name: 'grandchild.exe' }, { pid: 6000, name: 'child.exe' }] },
      { pid: 4242, name: 'game.exe', mb: 1000, chain: [] },
      { pid: 9999, name: 'llama-server.exe', mb: 6000, chain: [{ pid: 9999, name: 'llama-server.exe' }] },
    ],
  });
  h.push('running');
  await h.fire(20000);
  assert.equal(h.stored(), 1650, 'the child the program started counts, though its chain never names the program');
  h.jobPids = undefined; // an older helper that lists no job: only the program itself
  h.push('running', 2);
  await h.fire(60000);
  assert.equal(h.stored(), 1000, 'the next run measured the program alone');
  const alone = gpuHarness(t, { jobPids: 'not a list', holders: [{ pid: 6000, mb: 400, chain: [] }, { pid: 4242, mb: 100, chain: [] }] });
  alone.push('running');
  await alone.fire(20000);
  assert.equal(alone.stored(), 100, 'a job list that is not an array reads as the program alone');
  await h.holder.shutdown();
  await alone.holder.shutdown();
});

test('R3c: a later sample that reads lower does not lower the run\'s figure; the next run replaces last time\'s', async (t) => {
  const h = gpuHarness(t, { holders: [{ pid: 4242, mb: 1800, chain: [] }] });
  h.push('running', 1);
  await h.fire(20000);
  h.holders = [{ pid: 4242, mb: 1200, chain: [] }];
  await h.fire(60000);
  assert.equal(h.stored(), 1800);
  h.push('building', 2);
  h.push('running', 2);
  assert.deepEqual(h.pending(), [20000, 60000]);
  await h.fire(20000);
  assert.equal(h.stored(), 1200, 'this generation measured less, and that is the figure for next time');
  await h.holder.shutdown();
});

test('R3c: leaving the live states, a delete or a shutdown cancels the pending samples', async (t) => {
  const h = gpuHarness(t, { holders: [{ pid: 4242, mb: 700, chain: [] }] });
  let generation = 0;
  for (const state of ['closed', 'ended_early', 'idle', 'build_failed', 'building']) {
    generation += 1;
    h.push('running', generation);
    assert.deepEqual(h.pending(), [20000, 60000], state);
    h.push(state, generation);
    assert.deepEqual(h.pending(), [], state);
  }
  h.push('stopping', 20);
  assert.deepEqual(h.pending(), [], 'stopping is not a state that starts a pair');
  h.push('running', 21);
  assert.equal(h.pending().length, 2);
  h.push('running', 22);
  assert.equal(h.pending().length, 2, 'a new generation replaces the old pair');
  await h.holder.onProjectDeleted('p1');
  assert.deepEqual(h.pending(), []);
  h.push('running', 23);
  assert.equal(h.pending().length, 2);
  await h.holder.shutdown();
  assert.deepEqual(h.pending(), []);
  assert.deepEqual(h.lookups, [], 'nothing was ever sampled');
});

test('R3c: a sample still waiting on the lookup when the run ends records nothing', async (t) => {
  const h = gpuHarness(t, { holders: [{ pid: 4242, mb: 800, chain: [] }] });
  let release;
  h.gate = new Promise((resolve) => { release = resolve; });
  h.push('running');
  await h.fire(20000);
  assert.deepEqual(h.lookups, ['list']);
  h.push('closed');
  release();
  await settleTurns();
  assert.equal(h.stored(), null);
});

test('R3c: no pid, an error or a platform that is not Windows records nothing', async (t) => {
  const none = gpuHarness(t, { holders: [{ pid: 4242, mb: 500, chain: [] }], pid: null });
  none.push('running');
  await none.fire(20000);
  assert.deepEqual(none.lookups, [], 'no pid, no lookup');
  assert.equal(none.stored(), null);
  const broken = gpuHarness(t);
  broken.holders = null; // reading it throws inside the sample
  broken.push('running');
  await broken.fire(20000);
  assert.equal(broken.stored(), null);
  const linux = gpuHarness(t, { platform: 'linux', holders: [{ pid: 4242, mb: 500, chain: [] }] });
  linux.push('running');
  assert.deepEqual(linux.pending(), []);
  assert.equal(linux.stored(), null);
});

test('R3c: the warning needs a figure from last time and less free memory than it; every failure says nothing', async (t) => {
  const h = gpuHarness(t, { probeFreeMb: 900 });
  runView.createRunGpuMemoryStore({ userDataPath: h.userDataPath }).record('p1', 1800);
  assert.equal(await h.holder.startWarning('other'), null, 'no figure for that project yet');
  assert.deepEqual(await h.holder.startWarning('p1'), { needMb: 1800, freeMb: 900 });
  h.free = 1800;
  assert.equal(await h.holder.startWarning('p1'), null, 'exactly enough is not a warning');
  h.free = 4000;
  assert.equal(await h.holder.startWarning('p1'), null);
  h.free = null;
  assert.equal(await h.holder.startWarning('p1'), null, 'a probe with no answer');
  h.free = new Error('nvidia-smi missing');
  assert.equal(await h.holder.startWarning('p1'), null, 'a probe that throws');
});

test('R3c: a probe that throws is no warning; a project delete forgets its figure, with or without a run service', async (t) => {
  const h = gpuHarness(t);
  const holder = createLazyRunView({
    userDataPath: h.userDataPath, getBackendService: () => null, modules: () => ({ ...runView }),
    probeFreeMb: async () => { throw new Error('nvidia-smi missing'); },
  });
  runView.createRunGpuMemoryStore({ userDataPath: h.userDataPath }).record('p1', 1800);
  // With no usable NVIDIA tool the probe has nothing to say, and that is not a warning (the advice fails open).
  assert.equal(await holder.startWarning('p1'), null);
  await holder.onProjectDeleted('p1');
  assert.equal(h.stored(), null);
  runView.createRunGpuMemoryStore({ userDataPath: h.userDataPath }).record('p2', 500);
  await h.holder.onProjectDeleted('p2');
  assert.equal(h.stored('p2'), null);
});

test('R3c: the holder offers the warning to the start handler, which refuses a low start until anyway is sent', async (t) => {
  const h = gpuHarness(t, { probeFreeMb: 500 });
  runView.createRunGpuMemoryStore({ userDataPath: h.userDataPath }).record('p1', 1800);
  const started = [];
  const ipc = fakeIpcMain();
  registerRunViewIpc(ipc, {
    getHolder: () => h.holder, authorization: ALLOW,
    createHandlers: (options) => {
      assert.equal(options.startWarning, h.holder.startWarning);
      return runView.createRunViewIpcHandlers({ ...options, runService: { getStatus: async () => ({ ok: true, command: { status: 'confirmed' }, run: { state: 'idle' } }), start: async (args) => { started.push(args); return { ok: true }; } } });
    },
  });
  assert.deepEqual(await call(ipc, 'runView.start', { projectId: 'p1', chatId: 'c1' }), { ok: false, reason: 'low_gpu_memory', needMb: 1800, freeMb: 500 });
  assert.deepEqual(started, []);
  assert.equal((await call(ipc, 'runView.start', { projectId: 'p1', chatId: 'c1', anyway: true })).ok, true);
  assert.deepEqual(started, [{ projectId: 'p1', chatId: 'c1', worktree: null }]);
});

test('R3c: samples that come due while a lookup runs share it, and the next sample looks again', async (t) => {
  const h = gpuHarness(t, { holders: [{ pid: 4242, mb: 900, chain: [] }] });
  let open;
  h.gate = new Promise((resolve) => { open = resolve; });
  h.push('running', 1, 'p1');
  h.push('running', 1, 'p2');
  await h.fire(20000);
  assert.deepEqual(h.lookups, ['list'], 'two projects due together ask once');
  open();
  await settleTurns();
  assert.deepEqual([h.stored('p1'), h.stored('p2')], [900, 900]);
  h.gate = Promise.resolve();
  await h.fire(60000);
  assert.deepEqual(h.lookups, ['list', 'list'], 'a finished lookup is not reused');
  await h.holder.shutdown();
});

test('helper replies: a geometry reply gives the client crop as fractions or null; a run.list row gives bounded pids', () => {
  const { cropOf, pidsOf } = require('../services/run-view/helper-replies');
  assert.deepEqual(cropOf({ bounds: { width: 1282, height: 752 }, offset: { left: 1, top: 31, right: 1, bottom: 1 } }),
    { left: 1 / 1282, top: 31 / 752, right: 1 / 1282, bottom: 1 / 752 });
  for (const bad of [null, {}, { bounds: { width: 0, height: 10 }, offset: { left: 0, top: 0, right: 0, bottom: 0 } },
    { bounds: { width: 100, height: 100 }, offset: { left: -1, top: 0, right: 0, bottom: 0 } },
    { bounds: { width: 100, height: 100 }, offset: { left: 50, top: 0, right: 0, bottom: 0 } },
    { bounds: { width: 100, height: 100 }, offset: { left: 1.5, top: 0, right: 0, bottom: 0 } }]) {
    assert.equal(cropOf(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(pidsOf({ pids: [5, 5, 'x', -1, 7] }, [4242]), [5, 7]);
  assert.deepEqual(pidsOf({ pids: [] }, [4242]), [4242], 'an empty list falls back to the program');
  assert.deepEqual(pidsOf(null, [4242]), [4242]);
  assert.equal(pidsOf({ pids: Array.from({ length: 300 }, (_, i) => i + 1) }, []).length, 256);
});
