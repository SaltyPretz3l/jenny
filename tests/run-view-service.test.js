'use strict';

// new-test-file: the live run view's run service is a new surface (row 197, R1-service).

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunService } = require('../services/run-view/run-service');
const { createRunCommandStore } = require('../services/run-view/run-command-store');
const { removeTreeSync } = require('../services/fs-remove-no-follow');
const { createFakeTimers } = require('./helpers/fake-timers');

const flush = () => new Promise((resolve) => setImmediate(resolve));
const settleAll = async () => { for (let i = 0; i < 4; i += 1) await flush(); };

function tempDir(t, label) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `jenny-run-${label}-`)));
  t.after(() => removeTreeSync(dir));
  return dir;
}

function fakeHost() {
  const events = new EventEmitter();
  const calls = [];
  const replies = {
    'run.start': (args) => ({ run_id: args.run_id, pid: 4242 }),
    'run.close': (args) => ({ run_id: args.run_id, asked: true }),
    'run.stop': (args) => ({ run_id: args.run_id, how: 'ended', exit_code: 0 }),
    'run.output': (args) => ({ run_id: args.run_id, lines: ['one', 'two'], dropped_bytes: 7 }),
    'window.show': () => ({}),
  };
  return {
    calls,
    replies,
    request: async (op, args) => {
      calls.push({ op, args });
      const reply = replies[op];
      if (reply instanceof Error) throw reply;
      return reply(args);
    },
    on: (name, listener) => events.on(name, listener),
    off: (name, listener) => events.off(name, listener),
    fire: (name, fields) => events.emit(name, fields),
    listenerCount: (name) => events.listenerCount(name),
    ops: (op) => calls.filter((c) => c.op === op),
  };
}

function fakeBuildChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.finish = (code) => child.emit('close', code, null);
  return child;
}

function makeHarness(t, { env, command } = {}) {
  const root = tempDir(t, 'root');
  const outside = tempDir(t, 'outside');
  fs.mkdirSync(path.join(root, 'bin'));
  fs.writeFileSync(path.join(root, 'bin', 'game.exe'), 'x');
  fs.writeFileSync(path.join(outside, 'evil.exe'), 'x');
  const store = createRunCommandStore({ userDataPath: tempDir(t, 'store') });
  const host = fakeHost();
  const timers = createFakeTimers();
  const emitted = [];
  const builds = [];
  const killed = [];
  const armed = [];
  const binding = { rootId: 'root-a', rootRevision: 1, rootPath: root };
  let idCounter = 0;
  const service = createRunService({
    host,
    commandStore: store,
    getProjectBinding: (projectId) => (projectId === 'nope' ? null : { ...binding }),
    armWindowCapture: async (sourceId) => { armed.push(sourceId); return h.armResult; },
    emit: (channel, payload) => emitted.push({ channel, payload }),
    env: env || { PATH: 'C:\\bin', KEEP: 'k' },
    spawnBuild: (cmd, options) => {
      const child = fakeBuildChild(9000 + builds.length);
      builds.push({ cmd, options, child });
      return child;
    },
    killTree: (pid) => killed.push(pid),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    randomId: () => { idCounter += 1; return `id${idCounter}`; },
  });
  t.after(() => service.dispose());
  const h = {
    root, outside, store, host, timers, emitted, builds, killed, armed, binding, service,
    armResult: { ok: true },
    confirm(patch = {}, projectId = 'p1') {
      const cmd = { build: '', program: path.join('bin', 'game.exe'), args: ['--x'], cwd: '', env: {}, watch: [], ...(command || {}), ...patch };
      return store.confirm({ projectId, rootId: 'root-a', rootRevision: binding.rootRevision, worktree: null, command: cmd });
    },
    states: () => emitted.filter((e) => e.channel === 'run-view:state').map((e) => e.payload.state),
    snap: async (projectId = 'p1') => (await service.getStatus({ projectId, worktree: null })).run,
    async running(projectId = 'p1', chatId = 'chat-a') {
      h.confirm({}, projectId);
      const started = await service.start({ projectId, chatId, worktree: null });
      assert.equal(started.ok, true, JSON.stringify(started));
      await settleAll();
      const runId = h.host.ops('run.start').at(-1).args.run_id;
      h.host.fire('run.window', { run_id: runId, hwnd: 591824, source_id: `window:591824:${projectId}` });
      await settleAll();
      return runId;
    },
  };
  return h;
}

test('start is refused before any generation when the project or command is not ready', async (t) => {
  const h = makeHarness(t);
  assert.deepEqual(await h.service.start({ projectId: 'nope', chatId: 'c', worktree: null }), { ok: false, reason: 'no_project' });
  assert.equal((await h.service.start({ projectId: 'p1', chatId: 'c', worktree: null })).reason, 'no_command');
  h.confirm();
  h.binding.rootRevision = 2;
  const stale = await h.service.start({ projectId: 'p1', chatId: 'c', worktree: null });
  assert.equal(stale.reason, 'needs_confirmation');
  assert.equal(stale.confirmReason, 'rebind');
  assert.equal((await h.snap()).generation, 0);
  assert.deepEqual(h.host.calls, []);
  assert.deepEqual(h.emitted, []);
});

test('start is refused for a program or working folder that leaves the root, or a missing program', async (t) => {
  const h = makeHarness(t);
  fs.symlinkSync(h.outside, path.join(h.root, 'link'), 'junction');
  const attempts = [
    [{ program: path.join('..', 'x.exe') }, 'program_outside_root'],
    [{ program: path.join('link', 'evil.exe') }, 'program_outside_root'],
    [{ cwd: 'link' }, 'cwd_outside_root'],
    [{ program: path.join('bin', 'absent.exe') }, 'program_missing'],
    [{ program: 'bin' }, 'program_missing'],
  ];
  for (const [patch, reason] of attempts) {
    h.confirm(patch);
    const result = await h.service.start({ projectId: 'p1', chatId: 'c', worktree: null });
    assert.equal(result.ok, false, JSON.stringify(patch));
    assert.equal(result.reason, reason, JSON.stringify(patch));
  }
  assert.equal((await h.snap()).generation, 0);
  assert.deepEqual(h.host.calls, []);
  assert.deepEqual(h.builds, []);
});

test('an absolute program outside the root is allowed (the owner confirmed it)', async (t) => {
  const h = makeHarness(t);
  h.confirm({ program: path.join(h.outside, 'evil.exe') });
  assert.equal((await h.service.start({ projectId: 'p1', chatId: 'c', worktree: null })).ok, true);
  await settleAll();
  assert.equal(h.host.ops('run.start')[0].args.program, path.join(h.outside, 'evil.exe'));
});

test('a build runs first, then the program starts, then its window arrives', async (t) => {
  const h = makeHarness(t);
  h.confirm({ build: 'make all' });
  const started = await h.service.start({ projectId: 'p1', chatId: 'chat-a', worktree: null });
  assert.equal(started.ok, true);
  assert.equal(started.run.state, 'building');
  assert.equal(h.builds.length, 1);
  assert.equal(h.builds[0].cmd, 'make all');
  assert.equal(h.builds[0].options.shell, true);
  assert.equal(h.builds[0].options.windowsHide, true);
  assert.equal(h.builds[0].options.cwd, h.root);
  assert.equal(h.host.ops('run.start').length, 0);
  h.builds[0].child.finish(0);
  await settleAll();
  const [startCall] = h.host.ops('run.start');
  assert.match(startCall.args.run_id, /^r-1-[A-Za-z0-9_-]+$/);
  assert.equal(startCall.args.program, path.join(h.root, 'bin', 'game.exe'));
  assert.deepEqual(startCall.args.args, ['--x']);
  assert.equal(startCall.args.cwd, h.root);
  assert.equal((await h.snap()).state, 'starting');
  assert.deepEqual(h.timers.delays(), [15000]);
  h.host.fire('run.window', { run_id: startCall.args.run_id, hwnd: 77, source_id: 'window:77:0' });
  await settleAll();
  const run = await h.snap();
  assert.equal(run.state, 'running');
  assert.equal(run.hwnd, 77);
  assert.equal(run.sourceId, 'window:77:0');
  assert.equal(h.timers.pending(), 0);
  assert.deepEqual(h.states(), ['building', 'starting', 'running']);
});

test('a failed build keeps only a bounded tail and a later start works again', async (t) => {
  const h = makeHarness(t);
  h.confirm({ build: 'make all' });
  await h.service.start({ projectId: 'p1', chatId: 'chat-a', worktree: null });
  const { child } = h.builds[0];
  for (let i = 0; i < 30; i += 1) child.stdout.emit('data', Buffer.from(`${'a'.repeat(999)}\n`));
  child.stderr.emit('data', 'error: the very last line');
  child.finish(2);
  await settleAll();
  const run = await h.snap();
  assert.equal(run.state, 'build_failed');
  assert.equal(run.exitCode, 2);
  assert.equal(run.buildTail.length, 8000);
  assert.ok(run.buildTail.endsWith('error: the very last line'));
  assert.equal(h.host.ops('run.start').length, 0);
  assert.equal((await h.service.start({ projectId: 'p1', chatId: 'chat-b', worktree: null })).ok, true);
  assert.equal(h.builds.length, 2);
});

test('a build that outlives ten minutes is killed and fails', async (t) => {
  const h = makeHarness(t);
  h.confirm({ build: 'make all' });
  await h.service.start({ projectId: 'p1', chatId: 'chat-a', worktree: null });
  assert.ok(h.timers.delays().includes(600000));
  h.timers.tick(600000);
  assert.deepEqual(h.killed, [9000]);
  h.builds[0].child.finish(null);
  await settleAll();
  assert.equal((await h.snap()).state, 'build_failed');
});

test('stopping during a build kills the build tree and the run returns to idle', async (t) => {
  const h = makeHarness(t);
  h.confirm({ build: 'make all' });
  await h.service.start({ projectId: 'p1', chatId: 'chat-a', worktree: null });
  const stopped = await h.service.stop({ projectId: 'p1', mode: 'ask' });
  assert.equal(stopped.ok, true);
  assert.deepEqual(h.killed, [9000]);
  h.builds[0].child.finish(0);
  await settleAll();
  assert.equal((await h.snap()).state, 'idle');
  assert.equal(h.host.ops('run.start').length, 0);
});

test('a second start is refused and names the chat that started the run', async (t) => {
  const h = makeHarness(t);
  await h.running('p1', 'chat-a');
  const second = await h.service.start({ projectId: 'p1', chatId: 'chat-b', worktree: null });
  assert.deepEqual(second, { ok: false, reason: 'already_running', startedBy: 'chat-a' });
  assert.equal(h.host.ops('run.start').length, 1);
});

test('Stop asks the window to close, then offers force, which ends the job with no wait', async (t) => {
  const h = makeHarness(t);
  const runId = await h.running();
  const stopped = await h.service.stop({ projectId: 'p1', mode: 'ask' });
  assert.equal(stopped.run.state, 'stopping');
  await settleAll();
  assert.deepEqual(h.host.ops('run.close').map((c) => c.args), [{ run_id: runId }]);
  assert.equal(h.host.ops('run.stop').length, 0);
  assert.ok(h.emitted.some((e) => e.channel === 'run-view:keep-last-frame'));
  assert.deepEqual(h.timers.delays(), [2000]);
  h.timers.tick(2000);
  await settleAll();
  assert.equal((await h.snap()).state, 'close_refused');
  await h.service.stop({ projectId: 'p1', mode: 'force' });
  await settleAll();
  assert.deepEqual(h.host.ops('run.stop').map((c) => c.args), [{ run_id: runId, close_timeout_ms: 0 }]);
  assert.equal((await h.snap()).state, 'idle');
});

test('a program that closes on its own request ends the run as idle', async (t) => {
  const h = makeHarness(t);
  const runId = await h.running();
  await h.service.stop({ projectId: 'p1', mode: 'ask' });
  await settleAll();
  h.host.fire('run.exited', { run_id: runId, exit_code: 0 });
  await settleAll();
  assert.equal((await h.snap()).state, 'idle');
  assert.equal(h.timers.pending(), 0);
});

test('restart force-stops with the 2000 ms wait, starts a new generation and ignores the old run', async (t) => {
  const h = makeHarness(t);
  const oldRunId = await h.running();
  const result = await h.service.restart({ projectId: 'p1', chatId: 'chat-b', worktree: null });
  assert.equal(result.ok, true);
  await settleAll();
  assert.deepEqual(h.host.ops('run.stop')[0].args, { run_id: oldRunId, close_timeout_ms: 2000 });
  const [, second] = h.host.ops('run.start');
  assert.match(second.args.run_id, /^r-2-/);
  assert.notEqual(second.args.run_id, oldRunId);
  let run = await h.snap();
  assert.equal(run.generation, 2);
  assert.equal(run.state, 'starting');
  assert.equal(run.chatId, 'chat-b');
  h.host.fire('run.exited', { run_id: oldRunId, exit_code: 1 });
  h.host.fire('run.window', { run_id: oldRunId, hwnd: 1, source_id: 'stale' });
  await settleAll();
  run = await h.snap();
  assert.equal(run.state, 'starting');
  assert.equal(run.sourceId, null);
  h.host.fire('run.window', { run_id: second.args.run_id, hwnd: 2, source_id: 'fresh' });
  await settleAll();
  assert.equal((await h.snap()).sourceId, 'fresh');
});

test('restart is refused like start when the command no longer checks out', async (t) => {
  const h = makeHarness(t);
  await h.running();
  h.confirm({ program: path.join('..', 'x.exe') });
  const result = await h.service.restart({ projectId: 'p1', chatId: 'chat-a', worktree: null });
  assert.equal(result.reason, 'program_outside_root');
  assert.equal((await h.snap()).state, 'running');
  assert.equal(h.host.ops('run.stop').length, 0);
});

test('the helper exiting ends the run; the program exiting reports its code', async (t) => {
  const h = makeHarness(t);
  const runId = await h.running();
  h.host.fire('helper_exited', { runIds: ['someone-else'] });
  await settleAll();
  assert.equal((await h.snap()).state, 'running');
  h.host.fire('helper_exited', { runIds: [runId] });
  await settleAll();
  let run = await h.snap();
  assert.equal(run.state, 'closed');
  assert.equal(run.exitCode, null);
  await h.service.start({ projectId: 'p1', chatId: 'chat-a', worktree: null });
  await settleAll();
  const second = h.host.ops('run.start')[1].args.run_id;
  h.host.fire('run.exited', { run_id: second, exit_code: 3 });
  await settleAll();
  run = await h.snap();
  assert.equal(run.state, 'ended_early');
  assert.equal(run.exitCode, 3);
});

test('a program that shows no window in 15 seconds moves to no_window, and a late window still counts', async (t) => {
  const h = makeHarness(t);
  h.confirm({});
  await h.service.start({ projectId: 'p1', chatId: 'chat-a', worktree: null });
  await settleAll();
  h.timers.tick(15000);
  assert.equal((await h.snap()).state, 'no_window');
  h.host.fire('run.window', { run_id: h.host.ops('run.start')[0].args.run_id, hwnd: 5, source_id: 's5' });
  await settleAll();
  assert.equal((await h.snap()).state, 'running');
});

test('a refused or failed helper start ends the run early with the reason', async (t) => {
  const h = makeHarness(t);
  h.confirm({});
  h.host.replies['run.start'] = Object.assign(new Error('nope'), { code: 'start_failed' });
  await h.service.start({ projectId: 'p1', chatId: 'chat-a', worktree: null });
  await settleAll();
  const run = await h.snap();
  assert.equal(run.state, 'ended_early');
  assert.equal(run.reason, 'start_failed');
});

test('a program a build was meant to make is checked again at spawn time', async (t) => {
  const h = makeHarness(t);
  h.confirm({ build: 'make all', program: path.join('bin', 'later.exe') });
  assert.equal((await h.service.start({ projectId: 'p1', chatId: 'chat-a', worktree: null })).ok, true);
  h.builds[0].child.finish(0);
  await settleAll();
  const run = await h.snap();
  assert.equal(run.state, 'ended_early');
  assert.equal(run.reason, 'program_missing');
  assert.equal(h.host.ops('run.start').length, 0);
});

test('Show window and capture arming work only for the live run own window', async (t) => {
  const h = makeHarness(t);
  assert.deepEqual(await h.service.showWindow({ projectId: 'p1', place: 'front' }), { ok: false, reason: 'not_running' });
  assert.deepEqual(await h.service.armCapture({ projectId: 'p1' }), { ok: false, reason: 'not_running' });
  await h.running();
  assert.deepEqual(await h.service.showWindow({ projectId: 'p1', place: 'behind' }), { ok: true });
  assert.deepEqual(h.host.ops('window.show')[0].args, { hwnd: 591824, mode: 'behind' });
  assert.deepEqual(await h.service.armCapture({ projectId: 'p1' }), { ok: true, sourceId: 'window:591824:p1' });
  assert.deepEqual(h.armed, ['window:591824:p1']);
  h.armResult = { ok: false, reason: 'not_a_window' };
  assert.deepEqual(await h.service.armCapture({ projectId: 'p1' }), { ok: false, reason: 'not_a_window' });
  await h.service.stop({ projectId: 'p1', mode: 'force' });
  await settleAll();
  assert.deepEqual(await h.service.armCapture({ projectId: 'p1' }), { ok: false, reason: 'not_running' });
  assert.equal((await h.service.showWindow({ projectId: 'p1', place: 'front' })).reason, 'not_running');
});

test('the run output comes from the helper for the current run', async (t) => {
  const h = makeHarness(t);
  assert.equal((await h.service.output({ projectId: 'p1' })).ok, false);
  const runId = await h.running();
  assert.deepEqual(await h.service.output({ projectId: 'p1' }), { ok: true, lines: ['one', 'two'], droppedBytes: 7 });
  assert.deepEqual(h.host.ops('run.output')[0].args, { run_id: runId, max_lines: 200 });
});

test('the program gets the app environment minus JENNY_ and ELECTRON_ keys, plus the command pairs', async (t) => {
  const h = makeHarness(t, {
    env: { PATH: 'C:\\bin', KEEP: 'k', JENNY_SECRET: 'x', ELECTRON_RUN_AS_NODE: '1', jenny_lower: 'y', Electron_Mixed: 'z' },
  });
  h.confirm({ env: { GAME_DIR: 'saves', KEEP: 'over' }, build: 'make' });
  await h.service.start({ projectId: 'p1', chatId: 'c', worktree: null });
  const expected = { PATH: 'C:\\bin', KEEP: 'over', GAME_DIR: 'saves' };
  assert.deepEqual(h.builds[0].options.env, expected);
  h.builds[0].child.finish(0);
  await settleAll();
  assert.deepEqual(h.host.ops('run.start')[0].args.env, expected);
});

test('the command cannot be replaced while a run is live', async (t) => {
  const h = makeHarness(t);
  await h.running();
  const refused = await h.service.confirmCommand({ projectId: 'p1', worktree: null, command: { program: 'other.exe' } });
  assert.deepEqual(refused, { ok: false, reason: 'run_active' });
  await h.service.stop({ projectId: 'p1', mode: 'force' });
  await settleAll();
  const saved = await h.service.confirmCommand({ projectId: 'p1', worktree: null, command: { program: 'other.exe' } });
  assert.equal(saved.ok, true);
  assert.equal(saved.command.status, 'confirmed');
  assert.equal(saved.run.state, 'idle');
  assert.equal((await h.service.confirmCommand({ projectId: 'p1', worktree: null, command: { nonsense: 1 } })).ok, false);
});

test('getStatus returns the stored command and the run snapshot', async (t) => {
  const h = makeHarness(t);
  assert.equal((await h.service.getStatus({ projectId: 'nope', worktree: null })).ok, false);
  const none = await h.service.getStatus({ projectId: 'p1', worktree: null });
  assert.equal(none.ok, true);
  assert.equal(none.command.status, 'none');
  assert.deepEqual(none.run, {
    projectId: 'p1', state: 'idle', generation: 0, chatId: null, sourceId: null, hwnd: null,
    exitCode: null, buildTail: '', reason: null, crop: null,
  });
});

test('deleting a project stops its run and deletes its command', async (t) => {
  const h = makeHarness(t);
  const runId = await h.running();
  await h.service.onProjectDeleted('p1');
  assert.deepEqual(h.host.ops('run.stop')[0].args, { run_id: runId, close_timeout_ms: 2000 });
  assert.equal(h.store.get({ projectId: 'p1', rootId: 'root-a', rootRevision: 1, worktree: null }).status, 'none');
  assert.equal((await h.snap()).state, 'idle');
});

test('correctness review 8: deleting a project whose program ended by itself releases its record in the helper', async (t) => {
  const h = makeHarness(t);
  h.confirm();
  await h.service.start({ projectId: 'p1', chatId: 'chat-a', worktree: null });
  await settleAll();
  const runId = h.host.ops('run.start')[0].args.run_id;
  h.host.fire('run.exited', { run_id: runId, exit_code: 3 });
  await settleAll();
  assert.equal((await h.snap()).state, 'ended_early');
  assert.equal(h.host.ops('run.stop').length, 0, 'an ended run keeps its output until the next run');
  await h.service.onProjectDeleted('p1');
  await settleAll();
  assert.deepEqual(h.host.ops('run.stop').map((c) => c.args), [{ run_id: runId, close_timeout_ms: 0 }]);
});

test('stopAll stops every live project in parallel', async (t) => {
  const h = makeHarness(t);
  await h.running('p1', 'chat-a');
  await h.running('p2', 'chat-b');
  await h.service.stopAll();
  assert.equal(h.host.ops('run.stop').length, 2);
  assert.equal((await h.snap('p1')).state, 'idle');
  assert.equal((await h.snap('p2')).state, 'idle');
});

test('stopProject gives up after 12 seconds when the helper never answers', async (t) => {
  const h = makeHarness(t);
  await h.running();
  h.host.replies['run.stop'] = () => new Promise(() => {});
  let result = null;
  const pending = h.service.stopProject('p1').then((value) => { result = value; });
  await settleAll();
  assert.equal(result, null);
  h.timers.tick(12000);
  await pending;
  assert.deepEqual(result, { ok: false, reason: 'timeout' });
});

test('a restart still pending when the project is stopped does not launch again', async (t) => {
  const h = makeHarness(t, { command: { build: 'make' } });
  const oldRun = await (async () => {
    h.confirm({});
    await h.service.start({ projectId: 'p1', chatId: 'chat-a', worktree: null });
    h.builds[0].child.finish(0);
    await settleAll();
    return h.host.ops('run.start')[0].args.run_id;
  })();
  h.host.fire('run.window', { run_id: oldRun, hwnd: 9, source_id: 's9' });
  await settleAll();
  let release = () => {};
  h.host.replies['run.stop'] = () => new Promise((resolve) => { release = () => resolve({ exit_code: 0 }); });
  await h.service.restart({ projectId: 'p1', chatId: 'chat-b', worktree: null });
  const stopping = h.service.stopProject('p1');
  await settleAll();
  release();
  assert.deepEqual(await stopping, { ok: true });
  assert.equal(h.builds.length, 1);
  assert.equal(h.host.ops('run.start').length, 1);
  // The table cancels the pending restart on the stop, so the project rests at idle.
  assert.equal((await h.snap()).state, 'idle');
});

test('dispose removes the helper listeners', async (t) => {
  const h = makeHarness(t);
  assert.equal(h.host.listenerCount('run.window'), 1);
  h.service.dispose();
  for (const name of ['run.window', 'run.window_state', 'run.exited', 'helper_exited']) {
    assert.equal(h.host.listenerCount(name), 0, name);
  }
});

test('pidOf names the program\'s process id while one runs, and null with no run or a resting one', async (t) => {
  const h = makeHarness(t);
  assert.equal(h.service.pidOf('p1'), null);
  assert.equal(h.service.pidOf(7), null);
  await h.running();
  assert.equal(h.service.pidOf('p1'), 4242);
  assert.equal(h.service.pidOf('p2'), null);
  await h.service.stop({ projectId: 'p1', mode: 'force' });
  await settleAll();
  assert.equal(h.service.pidOf('p1'), null, 'a stopped run keeps no pid');
});

test('review fixes: a Run retries a helper that was unavailable, nothing starts after dispose, and bad helper events are dropped', async (t) => {
  const h = makeHarness(t);
  let resets = 0;
  h.host.state = () => (resets === 0 ? 'unavailable' : 'ready');
  h.host.reset = () => { resets += 1; };
  await h.running();
  assert.equal(resets, 1, 'the Run asked the host to try again');
  const runId = h.host.ops('run.start').at(-1).args.run_id;
  const before = (await h.snap()).hwnd;
  h.host.fire('run.window', { run_id: runId, hwnd: 'not-a-handle', source_id: 'window:1:0' });
  h.host.fire('run.window', { run_id: runId, hwnd: -5, source_id: 'window:1:0' });
  assert.equal((await h.snap()).hwnd, before, 'a window event without a real handle is ignored');
  h.host.fire('run.exited', { run_id: runId, exit_code: 'boom' });
  await settleAll();
  assert.equal((await h.snap()).exitCode, null, 'a non-integer exit code reads as unknown');
  h.service.dispose();
  h.confirm({}, 'p2');
  assert.deepEqual(await h.service.start({ projectId: 'p2', chatId: 'chat-b', worktree: null }), { ok: false, reason: 'shutting_down' });
});

test('review fixes: a build whose leftover process holds its output still finishes after it exits', async (t) => {
  const h = makeHarness(t);
  h.confirm({ build: 'make all' });
  assert.equal((await h.service.start({ projectId: 'p1', chatId: 'chat-a', worktree: null })).ok, true);
  await settleAll();
  h.builds[0].child.emit('exit', 0, null); // no 'close': something it started keeps the pipes open
  await settleAll();
  assert.equal((await h.snap()).state, 'building', 'the output may still arrive for a moment');
  h.timers.tick(3000);
  await settleAll();
  assert.notEqual((await h.snap()).state, 'building', 'the exit and a short grace end the build');
});

test('review fixes: on Windows a command PATH replaces the app Path instead of sitting beside it', () => {
  const { buildEnvBlock } = require('../services/run-view/build-step');
  assert.deepEqual(buildEnvBlock({ Path: 'C:/app', KEEP: 'k' }, { PATH: 'C:/mine' }, 'win32'), { KEEP: 'k', PATH: 'C:/mine' });
  assert.deepEqual(buildEnvBlock({ Path: 'a' }, { PATH: 'b' }, 'linux'), { Path: 'a', PATH: 'b' });
});

test('F4: a program that exits before the helper answers its start keeps its output and sends no stop', async (t) => {
  const h = makeHarness(t);
  h.confirm();
  h.host.replies['run.start'] = (args) => {
    h.host.fire('run.exited', { run_id: args.run_id, exit_code: 3 });
    return { run_id: args.run_id, pid: 4242 };
  };
  assert.equal((await h.service.start({ projectId: 'p1', chatId: 'chat-a', worktree: null })).ok, true);
  await settleAll();
  const run = await h.snap();
  assert.equal(run.state, 'ended_early');
  assert.equal(run.exitCode, 3);
  assert.equal(h.host.ops('run.stop').length, 0, 'the helper keeps the record and the crash output');
  assert.deepEqual(await h.service.output({ projectId: 'p1' }), { ok: true, lines: ['one', 'two'], droppedBytes: 7 });
  const first = h.host.ops('run.start')[0].args.run_id;
  assert.equal((await h.service.start({ projectId: 'p1', chatId: 'chat-a', worktree: null })).ok, true);
  await settleAll();
  assert.deepEqual(h.host.ops('run.stop').map((c) => c.args.run_id), [first], 'the next generation clears the old record');
});

test('F11.2: ending a build process tree starts taskkill by its full path without waiting, and never uses spawnSync', () => {
  const { killTreeDetached } = require('../services/run-view/build-step');
  const spawned = [];
  const child = new EventEmitter();
  child.unref = () => spawned.push('unref');
  const spawn = (command, args, options) => { spawned.push({ command, args, options }); return child; };
  killTreeDetached(1234, { platform: 'win32', spawn, env: { SystemRoot: 'D:\\Win' } });
  assert.deepEqual(spawned, [
    { command: path.join('D:\\Win', 'System32', 'taskkill.exe'), args: ['/PID', '1234', '/T', '/F'], options: { windowsHide: true, stdio: 'ignore' } },
    'unref',
  ]);
  assert.equal(child.listenerCount('error'), 1);
  assert.doesNotThrow(() => child.emit('error', new Error('no taskkill')));
  spawned.length = 0;
  killTreeDetached(5, { platform: 'win32', spawn, env: {} });
  assert.equal(spawned[0].command, path.join('C:\\Windows', 'System32', 'taskkill.exe'));
  const signalled = [];
  killTreeDetached(77, { platform: 'linux', spawn, kill: (pid) => signalled.push(pid) });
  assert.deepEqual(signalled, [-77]);
});
