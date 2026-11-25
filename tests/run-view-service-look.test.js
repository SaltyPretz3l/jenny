'use strict';

// new-test-file: tests/run-view-service.test.js is near its line cap and these methods (look, restartAndWait, and the window crop and job process ids that read the helper the same way) are a different lane (row 197, T1).

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
const settleAll = async () => { for (let i = 0; i < 5; i += 1) await flush(); };
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG = Buffer.concat([PNG_HEAD, Buffer.from('pixels')]).toString('base64');
const frame = (patch = {}) => ({ png_base64: PNG, width: 640, height: 480, scale: 1, signature: 'aaaaaaaaaaaaaaaa', ...patch });

function tempDir(t, label) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `jenny-look-${label}-`)));
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
    'run.output': (args) => ({ run_id: args.run_id, lines: ['one', 'two'], dropped_bytes: 0 }),
    capture: () => frame(),
    'window.geometry': () => ({ bounds: { x: 100, y: 100, width: 1282, height: 752 }, offset: { left: 1, top: 31, right: 1, bottom: 1 } }),
    'run.list': () => ({ runs: [] }),
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

function makeHarness(t) {
  const root = tempDir(t, 'root');
  fs.mkdirSync(path.join(root, 'bin'));
  fs.writeFileSync(path.join(root, 'bin', 'game.exe'), 'x');
  const store = createRunCommandStore({ userDataPath: tempDir(t, 'store') });
  const host = fakeHost();
  const timers = createFakeTimers();
  const builds = [];
  const killed = [];
  const emitted = [];
  const binding = { rootId: 'root-a', rootRevision: 1, rootPath: root };
  const service = createRunService({
    host,
    commandStore: store,
    getProjectBinding: (projectId) => {
      if (projectId === 'nope') return null;
      return h.bindingGate ? h.bindingGate.then(() => binding) : binding;
    },
    armWindowCapture: async () => ({ ok: true }),
    emit: (channel, payload) => emitted.push({ channel, payload }),
    env: { PATH: 'C:\\bin' },
    spawnBuild: (cmd) => {
      const child = fakeBuildChild(9000 + builds.length);
      builds.push({ cmd, child });
      return child;
    },
    killTree: (pid) => killed.push(pid),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    randomId: (() => { let n = 0; return () => { n += 1; return `id${n}`; }; })(),
  });
  t.after(() => service.dispose());
  const h = {
    host, timers, builds, killed, service, emitted, bindingGate: null,
    confirm(patch = {}, projectId = 'p1') {
      const command = { build: '', program: path.join('bin', 'game.exe'), args: [], cwd: '', env: {}, watch: [], ...patch };
      return store.confirm({ projectId, rootId: 'root-a', rootRevision: 1, worktree: null, command });
    },
    snap: async (projectId = 'p1') => (await service.getStatus({ projectId, worktree: null })).run,
    runId: () => host.ops('run.start').at(-1).args.run_id,
    window: async (hwnd = 591824) => {
      host.fire('run.window', { run_id: h.runId(), hwnd, source_id: `window:${hwnd}` });
      await settleAll();
    },
    async running(chatId = 'chat-a') {
      h.confirm();
      assert.equal((await service.start({ projectId: 'p1', chatId, worktree: null })).ok, true);
      await settleAll();
      await h.window();
    },
  };
  return h;
}

// A restartAndWait whose result is read later; `state.done` flips when it settles.
function startWait(h, args = {}) {
  const state = { done: false, result: null };
  state.promise = h.service.restartAndWait({ projectId: 'p1', chatId: 'chat-m', worktree: null, ...args })
    .then((result) => { state.done = true; state.result = result; return result; });
  return state;
}

test('look returns the picture, and changed is null, then false for a still frame, then true for a new one', async (t) => {
  const h = makeHarness(t);
  await h.running();
  const first = await h.service.look({ projectId: 'p1' });
  assert.deepEqual(first, {
    ok: true, pngBase64: PNG, width: 640, height: 480, signature: 'aaaaaaaaaaaaaaaa', generation: 1, changed: null,
  });
  assert.deepEqual(h.host.ops('capture')[0].args, { hwnd: 591824, max_long_edge: 1568, max_bytes: 2000000, area: 'client' });
  assert.equal((await h.service.look({ projectId: 'p1' })).changed, false);
  h.host.replies.capture = () => frame({ signature: 'bbbbbbbbbbbbbbbb' });
  assert.equal((await h.service.look({ projectId: 'p1' })).changed, true);
  assert.equal((await h.service.look({ projectId: 'p1' })).changed, false);
});

test('a new generation forgets the last frame', async (t) => {
  const h = makeHarness(t);
  await h.running();
  await h.service.look({ projectId: 'p1' });
  const restarted = await h.service.restart({ projectId: 'p1', chatId: 'chat-a', worktree: null });
  assert.equal(restarted.ok, true);
  await settleAll();
  await h.window(77);
  const again = await h.service.look({ projectId: 'p1' });
  assert.equal(again.generation, 2);
  assert.equal(again.changed, null);
});

test('look says why there is no picture: no run, a run with no window, a minimised window', async (t) => {
  const h = makeHarness(t);
  assert.deepEqual(await h.service.look({ projectId: 'p9' }), { ok: false, reason: 'not_running' });
  assert.deepEqual(await h.service.look({}), { ok: false, reason: 'bad_request' });
  h.confirm();
  await h.service.start({ projectId: 'p1', chatId: 'c', worktree: null });
  await settleAll();
  assert.deepEqual(await h.service.look({ projectId: 'p1' }), { ok: false, reason: 'not_running' });
  await h.window();
  h.host.fire('run.window_state', { run_id: h.runId(), state: 'minimized' });
  await settleAll();
  assert.deepEqual(await h.service.look({ projectId: 'p1' }), { ok: false, reason: 'minimized' });
  h.host.fire('run.window_state', { run_id: h.runId(), state: 'restored' });
  await settleAll();
  assert.equal((await h.service.look({ projectId: 'p1' })).ok, true);
  assert.equal(h.host.ops('capture').length, 1);
});

test('a capture reply that is too big, not a PNG or malformed is bad_capture', async (t) => {
  const h = makeHarness(t);
  await h.running();
  const huge = Buffer.concat([PNG_HEAD, Buffer.alloc(2 * 1024 * 1024)]).toString('base64');
  const replies = [
    frame({ png_base64: huge }),
    frame({ png_base64: Buffer.from('GIF89a not a png at all').toString('base64') }),
    frame({ png_base64: 42 }),
    frame({ png_base64: '' }),
    frame({ signature: 'AAAAAAAAAAAAAAAA' }),
    frame({ signature: 'abc' }),
    frame({ signature: null }),
    frame({ width: 0 }),
    frame({ height: 1.5 }),
    frame({ width: '640' }),
    null,
  ];
  for (const reply of replies) {
    h.host.replies.capture = () => reply;
    assert.deepEqual(await h.service.look({ projectId: 'p1' }), { ok: false, reason: 'bad_capture' }, JSON.stringify(reply)?.slice(0, 80));
  }
  h.host.replies.capture = () => frame();
  assert.equal((await h.service.look({ projectId: 'p1' })).changed, null);
});

test('a helper rejection keeps its code, and a run replaced during the capture is not_running', async (t) => {
  const h = makeHarness(t);
  await h.running();
  h.host.replies.capture = Object.assign(new Error('gone'), { code: 'no_such_window' });
  assert.deepEqual(await h.service.look({ projectId: 'p1' }), { ok: false, reason: 'no_such_window' });
  h.host.replies.capture = new Error('plain');
  assert.deepEqual(await h.service.look({ projectId: 'p1' }), { ok: false, reason: 'capture_failed' });
  let release;
  h.host.replies.capture = () => new Promise((resolve) => { release = () => resolve(frame()); });
  const pending = h.service.look({ projectId: 'p1' });
  await settleAll();
  await h.service.restart({ projectId: 'p1', chatId: 'chat-a', worktree: null });
  await settleAll();
  assert.equal((await h.snap()).generation, 2);
  release();
  assert.deepEqual(await pending, { ok: false, reason: 'not_running' });
});

test('restartAndWait builds, starts, waits the settle time and answers running', async (t) => {
  const h = makeHarness(t);
  h.confirm({ build: 'make all' });
  const wait = startWait(h);
  await settleAll();
  assert.equal(wait.done, false);
  assert.equal((await h.snap()).state, 'building');
  h.builds[0].child.finish(0);
  await settleAll();
  await h.window();
  assert.equal(wait.done, false, 'the settle time has not passed');
  h.timers.tick(499);
  await settleAll();
  assert.equal(wait.done, false);
  h.timers.tick(1);
  const result = await wait.promise;
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'running');
  assert.equal(result.run.state, 'running');
  assert.equal(result.run.generation, 1);
});

test('restartAndWait from a live run stops it and answers for the new generation', async (t) => {
  const h = makeHarness(t);
  await h.running();
  const wait = startWait(h, { settleMs: 100 });
  await settleAll();
  assert.equal(wait.done, false);
  assert.equal((await h.snap()).generation, 2);
  await h.window(88);
  h.timers.tick(100);
  const result = await wait.promise;
  assert.equal(result.outcome, 'running');
  assert.equal(result.run.generation, 2);
  assert.equal(result.run.hwnd, 88);
});

test('a refusal from restart is returned unchanged', async (t) => {
  const h = makeHarness(t);
  assert.deepEqual(await h.service.restartAndWait({ projectId: 'p1', chatId: 'c', worktree: null }), { ok: false, reason: 'no_command' });
  assert.deepEqual(await h.service.restartAndWait({ projectId: 'nope', chatId: 'c', worktree: null }), { ok: false, reason: 'no_project' });
  assert.deepEqual(await h.service.restartAndWait({}), { ok: false, reason: 'bad_request' });
  assert.equal(h.timers.pending(), 0);
});

test('a failed build answers build_failed with its tail', async (t) => {
  const h = makeHarness(t);
  h.confirm({ build: 'make all' });
  const wait = startWait(h);
  await settleAll();
  h.builds[0].child.stderr.emit('data', 'error: nothing compiles');
  h.builds[0].child.finish(2);
  const result = await wait.promise;
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'build_failed');
  assert.equal(result.exitCode, 2);
  assert.equal(result.buildTail, 'error: nothing compiles');
  assert.equal(result.run.state, 'build_failed');
  assert.equal(h.host.ops('run.start').length, 0);
});

test('a program that exits during the settle time answers ended_early with its last lines', async (t) => {
  const h = makeHarness(t);
  h.confirm();
  const wait = startWait(h);
  await settleAll();
  await h.window();
  h.host.fire('run.exited', { run_id: h.runId(), exit_code: 3 });
  const result = await wait.promise;
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'ended_early');
  assert.equal(result.exitCode, 3);
  assert.deepEqual(result.lines, ['one', 'two']);
  assert.deepEqual(h.host.ops('run.output').at(-1).args, { run_id: h.runId(), max_lines: 40 });
  assert.equal(h.timers.pending(), 0);
});

test('a program that ends before any window answers ended_early; unreadable output gives no lines', async (t) => {
  const h = makeHarness(t);
  h.confirm();
  h.host.replies['run.output'] = new Error('no output');
  const wait = startWait(h);
  await settleAll();
  h.host.fire('run.exited', { run_id: h.runId(), exit_code: 1 });
  const result = await wait.promise;
  assert.equal(result.outcome, 'ended_early');
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.lines, []);
});

test('only the last 40 output lines come back, each bounded', async (t) => {
  const h = makeHarness(t);
  h.confirm();
  h.host.replies['run.output'] = () => ({ lines: Array.from({ length: 60 }, (_, i) => `line ${i} ${'x'.repeat(1000)}`).concat([7, null]) });
  const wait = startWait(h);
  await settleAll();
  h.host.fire('run.exited', { run_id: h.runId(), exit_code: 1 });
  const { lines } = await wait.promise;
  assert.equal(lines.length, 40);
  assert.ok(lines.at(-1).startsWith('line 59 '));
  assert.ok(lines.every((line) => line.length <= 400));
});

test('a program that shows no window answers no_window; the owner stopping it answers stopped', async (t) => {
  const h = makeHarness(t);
  h.confirm();
  const first = startWait(h);
  await settleAll();
  h.timers.tick(15000);
  const noWindow = await first.promise;
  assert.equal(noWindow.ok, true);
  assert.equal(noWindow.outcome, 'no_window');
  await h.service.stop({ projectId: 'p1', mode: 'force' });
  await settleAll();
  h.confirm({ build: 'make all' });
  const second = startWait(h);
  await settleAll();
  await h.service.stop({ projectId: 'p1', mode: 'force' });
  h.builds[0].child.finish(0);
  const stopped = await second.promise;
  assert.equal(stopped.ok, false);
  assert.equal(stopped.outcome, 'stopped');
});

test('aborting during the build cancels the build, ends the run and answers cancelled', async (t) => {
  const h = makeHarness(t);
  h.confirm({ build: 'make all' });
  const abort = new AbortController();
  const wait = startWait(h, { signal: abort.signal });
  await settleAll();
  abort.abort();
  const result = await wait.promise;
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'cancelled');
  assert.deepEqual(h.killed, [9000]);
  h.builds[0].child.finish(null);
  await settleAll();
  assert.equal((await h.snap()).state, 'idle');
  assert.equal(h.host.ops('run.start').length, 0);
});

test('aborting while the program starts stops it; aborting before the call starts nothing', async (t) => {
  const h = makeHarness(t);
  h.confirm();
  const abort = new AbortController();
  const wait = startWait(h, { signal: abort.signal });
  await settleAll();
  abort.abort();
  assert.equal((await wait.promise).outcome, 'cancelled');
  await settleAll();
  assert.equal(h.host.ops('run.stop').length, 1);
  assert.equal((await h.snap()).state, 'idle');
  const before = h.host.calls.length;
  const spent = AbortSignal.abort();
  const none = await h.service.restartAndWait({ projectId: 'p1', chatId: 'c', worktree: null, signal: spent });
  assert.equal(none.outcome, 'cancelled');
  assert.equal(h.host.calls.length, before);
});

test('a program that never comes up times out', async (t) => {
  const h = makeHarness(t);
  h.confirm({ build: 'make all' });
  const wait = startWait(h, { timeoutMs: 1000 });
  await settleAll();
  h.timers.tick(1000);
  const result = await wait.promise;
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'timeout');
  assert.equal(result.run.state, 'building');
});

test('a finished wait leaves nothing behind: later events and an abort touch nothing', async (t) => {
  const h = makeHarness(t);
  h.confirm();
  const abort = new AbortController();
  const timedOut = startWait(h, { timeoutMs: 1000, signal: abort.signal });
  await settleAll();
  h.timers.tick(1000);
  assert.equal((await timedOut.promise).outcome, 'timeout');
  await h.window();
  assert.equal((await h.snap()).state, 'running');
  assert.equal(h.timers.pending(), 0, 'no settle timer was armed by the finished wait');
  abort.abort();
  await settleAll();
  assert.equal((await h.snap()).state, 'running', 'the abort does not stop a finished wait\'s run');
  assert.equal(h.host.ops('run.stop').length, 0);
});

test('the answer for a run that is up is not disturbed by a later abort', async (t) => {
  const h = makeHarness(t);
  h.confirm();
  const abort = new AbortController();
  const wait = startWait(h, { settleMs: 10, signal: abort.signal });
  await settleAll();
  await h.window();
  h.timers.tick(10);
  assert.equal((await wait.promise).outcome, 'running');
  abort.abort();
  await settleAll();
  assert.equal((await h.snap()).state, 'running');
  assert.equal(h.host.ops('run.stop').length, 0);
});

test('the owner stopping the new run while it waits on the program ends the wait as stopped, not at the timeout', async (t) => {
  const h = makeHarness(t);
  h.confirm();
  const wait = startWait(h);
  await settleAll();
  await h.service.stop({ projectId: 'p1', mode: 'ask' });
  await settleAll();
  const result = await wait.promise;
  assert.equal(result.outcome, 'stopped');
});

// ---- row 197 review fixes: the window crop (F6), job process ids (F12) and an abort while a restart prepares (F8) ----

const geometry = (bounds, offset) => ({ bounds: { x: 0, y: 0, ...bounds }, offset });
const fractions = (width, height, o) => ({ left: o.left / width, top: o.top / height, right: o.right / width, bottom: o.bottom / height });
const lastPush = (h) => h.emitted.filter((e) => e.channel === 'run-view:state').at(-1).payload;

test('F6: the run view carries the client area as fractions of the drawn window, refreshed when the window moves or is restored', async (t) => {
  const h = makeHarness(t);
  h.confirm();
  assert.equal((await h.snap()).crop, null);
  await h.running();
  assert.deepEqual(h.host.ops('window.geometry').map((c) => c.args), [{ hwnd: 591824 }]);
  const first = fractions(1282, 752, { left: 1, top: 31, right: 1, bottom: 1 });
  assert.deepEqual((await h.snap()).crop, first);
  assert.deepEqual(lastPush(h).crop, first, 'the push carries it too');
  h.host.replies['window.geometry'] = () => geometry({ width: 800, height: 600 }, { left: 8, top: 40, right: 8, bottom: 8 });
  h.host.fire('run.window_state', { run_id: h.runId(), hwnd: 591824, state: 'moved' });
  await settleAll();
  const moved = fractions(800, 600, { left: 8, top: 40, right: 8, bottom: 8 });
  assert.deepEqual((await h.snap()).crop, moved);
  assert.deepEqual(lastPush(h).crop, moved);
  h.host.replies['window.geometry'] = () => geometry({ width: 1000, height: 500 }, { left: 0, top: 30, right: 0, bottom: 0 });
  h.host.fire('run.window_state', { run_id: h.runId(), hwnd: 591824, state: 'restored' });
  await settleAll();
  assert.deepEqual((await h.snap()).crop, { left: 0, top: 0.06, right: 0, bottom: 0 });
  const asks = h.host.ops('window.geometry').length;
  h.host.fire('run.window_state', { run_id: h.runId(), hwnd: 591824, state: 'minimized' });
  await settleAll();
  assert.equal(h.host.ops('window.geometry').length, asks, 'only moved and restored ask again');
});

test('F6: a reply that does not add up, or a failed lookup, keeps the crop it had and never changes the run state', async (t) => {
  const h = makeHarness(t);
  await h.running();
  const sane = { left: 1, top: 31, right: 1, bottom: 1 };
  const bad = [
    geometry({ width: 0, height: 100 }, sane), geometry({ width: 100, height: -1 }, sane), geometry({ width: 100.5, height: 100 }, sane),
    geometry({ width: 100, height: 100 }, { ...sane, left: -1 }), geometry({ width: 100, height: 100 }, { ...sane, top: 1.5 }),
    geometry({ width: 100, height: 100 }, { ...sane, right: '1' }), geometry({ width: 100, height: 100 }, { left: 50, top: 0, right: 50, bottom: 0 }),
    geometry({ width: 100, height: 100 }, { left: 0, top: 60, right: 0, bottom: 40 }),
    geometry({ width: 100, height: 100 }, { left: 60, top: 0, right: 0, bottom: 0 }),
    { bounds: { width: 100, height: 100 } }, { offset: sane }, null, 'x',
  ];
  for (const reply of bad) {
    const had = (await h.snap()).crop;
    h.host.replies['window.geometry'] = () => reply;
    h.host.fire('run.window_state', { run_id: h.runId(), hwnd: 591824, state: 'moved' });
    await settleAll();
    const run = await h.snap();
    assert.deepEqual(run.crop, had, JSON.stringify(reply));
    assert.equal(run.state, 'running');
    h.host.replies['window.geometry'] = () => geometry({ width: 100, height: 100 }, { left: 1, top: 2, right: 3, bottom: 4 });
    h.host.fire('run.window_state', { run_id: h.runId(), hwnd: 591824, state: 'moved' });
    await settleAll();
    assert.deepEqual((await h.snap()).crop, { left: 0.01, top: 0.02, right: 0.03, bottom: 0.04 });
  }
  h.host.replies['window.geometry'] = new Error('no such window');
  h.host.fire('run.window_state', { run_id: h.runId(), hwnd: 591824, state: 'restored' });
  await settleAll();
  const run = await h.snap();
  assert.equal(run.state, 'running');
  assert.deepEqual(run.crop, { left: 0.01, top: 0.02, right: 0.03, bottom: 0.04 });
});

test('F6: a geometry reply that arrives after the window changed or the run was replaced is dropped, and a new generation starts with no crop', async (t) => {
  const h = makeHarness(t);
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  h.host.replies['window.geometry'] = () => slow.then(() => geometry({ width: 100, height: 100 }, { left: 1, top: 1, right: 1, bottom: 1 }));
  h.confirm();
  assert.equal((await h.service.start({ projectId: 'p1', chatId: 'c', worktree: null })).ok, true);
  await settleAll();
  await h.window(111);
  h.host.fire('run.window_state', { run_id: h.runId(), hwnd: 111, state: 'destroyed' });
  await settleAll();
  await h.window(222); // the program's next window
  release();
  await settleAll();
  assert.equal((await h.snap()).hwnd, 222);
  assert.deepEqual((await h.snap()).crop, { left: 0.01, top: 0.01, right: 0.01, bottom: 0.01 }, 'the newest lookup answers');
  // an answer for a window that is gone
  const calls = [];
  const gates = [];
  h.host.replies['window.geometry'] = (args) => {
    calls.push(args.hwnd);
    return new Promise((resolve) => gates.push(() => resolve(geometry({ width: 100, height: 100 }, { left: 5, top: 5, right: 5, bottom: 5 }))));
  };
  h.host.fire('run.window_state', { run_id: h.runId(), hwnd: 222, state: 'moved' });
  await settleAll();
  assert.deepEqual((await h.snap()).crop, { left: 0.01, top: 0.01, right: 0.01, bottom: 0.01 }, 'the old crop stays until the lookup answers');
  await h.service.stop({ projectId: 'p1', mode: 'force' });
  await settleAll();
  gates.forEach((open) => open());
  await settleAll();
  assert.equal((await h.snap()).crop, null, 'a run at rest has no crop, whatever a late answer says');
  assert.deepEqual(calls, [222]);
  h.confirm();
  await h.service.start({ projectId: 'p1', chatId: 'c', worktree: null });
  await settleAll();
  assert.equal((await h.snap()).crop, null, 'the next generation starts with none');
});

test('F12: jobPids reads the program and what it started from the helper list, and livePids keeps them until the run rests', async (t) => {
  const h = makeHarness(t);
  await h.running();
  assert.deepEqual(h.service.livePids(), [4242]);
  h.host.replies['run.list'] = () => ({ runs: [
    { run_id: 'someone-else', pid: 9, pids: [9] },
    { run_id: h.runId(), pid: 4242, pids: [4242, 5000, 5001, 5000] },
  ] });
  assert.deepEqual(await h.service.jobPids('p1'), [4242, 5000, 5001]);
  assert.deepEqual(h.service.livePids().sort(), [4242, 5000, 5001]);
  assert.equal(h.service.projectForPid(5001), 'p1');
  assert.equal(h.service.projectForPid(9), '');
  // a missing, malformed or empty list means the program's own id
  for (const pids of [undefined, 'x', [], [0, -3, 1.5, '7', null]]) {
    h.host.replies['run.list'] = () => ({ runs: [{ run_id: h.runId(), pid: 4242, pids }] });
    assert.deepEqual(await h.service.jobPids('p1'), [4242], JSON.stringify(pids));
  }
  h.host.replies['run.list'] = () => ({ runs: [{ run_id: h.runId(), pids: [0, 6000, 'x', 6001] }] });
  assert.deepEqual(await h.service.jobPids('p1'), [6000, 6001], 'bad entries are dropped');
  h.host.replies['run.list'] = () => ({ runs: [{ run_id: h.runId(), pids: Array.from({ length: 300 }, (_, i) => 1000 + i) }] });
  assert.equal((await h.service.jobPids('p1')).length, 256);
  h.host.replies['run.list'] = new Error('helper busy');
  assert.deepEqual(await h.service.jobPids('p1'), [4242], 'a failed list falls back to the program');
  assert.equal(h.service.livePids().length, 1);
  assert.deepEqual(await h.service.jobPids('nobody'), []);
  h.host.replies['run.list'] = () => ({ runs: [{ run_id: h.runId(), pids: [4242, 7000] }] });
  await h.service.jobPids('p1');
  await h.service.stop({ projectId: 'p1', mode: 'force' });
  await settleAll();
  assert.deepEqual(h.service.livePids(), [], 'a run at rest names no process');
  assert.equal(h.service.projectForPid(7000), '');
  assert.deepEqual(await h.service.jobPids('p1'), []);
});

test('F8: an abort while the restart is still checking its command stops nothing and starts nothing', async (t) => {
  const h = makeHarness(t);
  await h.running();
  let open;
  h.bindingGate = new Promise((resolve) => { open = resolve; });
  const abort = new AbortController();
  const wait = startWait(h, { signal: abort.signal });
  await settleAll();
  assert.equal(wait.done, false);
  abort.abort();
  open();
  const result = await wait.promise;
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'cancelled');
  assert.equal(result.run.state, 'running');
  assert.equal(result.run.generation, 1);
  await settleAll();
  assert.equal(h.host.ops('run.stop').length, 0);
  assert.equal(h.host.ops('run.close').length, 0);
  assert.equal(h.host.ops('run.start').length, 1, 'no new generation began');
  assert.equal((await h.snap()).state, 'running');
});
