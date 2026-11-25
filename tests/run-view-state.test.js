'use strict';

// new-test-file: the live run view's state table is a new surface (row 197, R1).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const {
  CLOSE_TIMEOUT_MS, NO_WINDOW_TIMEOUT_MS, initialRunState, transition,
} = require('../services/run-view/run-state');

function run(events, start = initialRunState()) {
  let state = start;
  const log = [];
  for (const event of events) {
    const result = transition(state, typeof event === 'function' ? event(state) : event);
    log.push(result);
    state = result.state;
  }
  return { state, log, last: log[log.length - 1] };
}

const kinds = (result) => result.effects.map((e) => e.kind);
const g = (type, extra = {}) => (state) => ({ type, generation: state.generation, ...extra });

test('a start with a build step builds first, then spawns, then shows the window', () => {
  const r = run([
    { type: 'start', chatId: 'chat-a', hasBuild: true },
    g('build_ok'),
    g('spawned', { pid: 42 }),
    g('window', { hwnd: 591824, sourceId: 'window:591824:0' }),
  ]);
  assert.deepEqual(r.log.map(kinds), [['run_build'], ['spawn'], ['arm_no_window_timer'], ['clear_timers']]);
  assert.equal(r.log[2].effects[0].ms, NO_WINDOW_TIMEOUT_MS);
  assert.equal(r.state.state, 'running');
  assert.equal(r.state.chatId, 'chat-a');
  assert.equal(r.state.generation, 1);
  assert.equal(r.state.sourceId, 'window:591824:0');
});

test('a start without a build step spawns at once', () => {
  const r = run([{ type: 'start', chatId: 'c', hasBuild: false }]);
  assert.equal(r.state.state, 'starting');
  assert.deepEqual(kinds(r.last), ['spawn']);
});

test('one run per root: a second start while live is refused and names the starting chat', () => {
  for (const live of [
    [{ type: 'start', chatId: 'chat-a', hasBuild: true }],
    [{ type: 'start', chatId: 'chat-a' }, g('spawned', { pid: 1 }), g('window', { hwnd: 5, sourceId: 'window:5:0' })],
    [{ type: 'start', chatId: 'chat-a' }, g('window', { hwnd: 5 }), { type: 'stop', mode: 'ask' }],
  ]) {
    const r = run([...live, { type: 'start', chatId: 'chat-b' }]);
    assert.equal(r.last.ok, false);
    assert.equal(r.last.reason, 'already_running');
    assert.equal(r.last.startedBy, 'chat-a');
  }
});

test('a failed build keeps the compiler tail, bounded, and the run can start again', () => {
  const r = run([
    { type: 'start', chatId: 'c', hasBuild: true },
    g('build_failed', { exitCode: 101, tail: `${'x'.repeat(9000)}error[E0425]` }),
  ]);
  assert.equal(r.state.state, 'build_failed');
  assert.equal(r.state.exitCode, 101);
  assert.ok(r.state.buildTail.endsWith('error[E0425]'));
  assert.ok(r.state.buildTail.length <= 8000);
  assert.equal(run([{ type: 'start', chatId: 'c' }], r.state).state.state, 'starting');
});

test('a program that ends before a window appears is ended_early; after a window it closed itself', () => {
  const early = run([{ type: 'start', chatId: 'c' }, g('spawned', { pid: 1 }), g('exited', { exitCode: 3 })]);
  assert.equal(early.state.state, 'ended_early');
  assert.equal(early.state.exitCode, 3);
  const closed = run([{ type: 'start', chatId: 'c' }, g('window', { hwnd: 9 }), g('exited', { exitCode: 0 })]);
  assert.equal(closed.state.state, 'closed');
});

test('no window after the timer is no_window; a later window still lands', () => {
  const r = run([{ type: 'start', chatId: 'c' }, g('spawned', { pid: 1 }), g('no_window_timeout')]);
  assert.equal(r.state.state, 'no_window');
  assert.equal(run([g('window', { hwnd: 7 })], r.state).state.state, 'running');
});

test('minimise, restore, and a destroyed window that is followed by the next one', () => {
  const r = run([
    { type: 'start', chatId: 'c' }, g('window', { hwnd: 1 }),
    g('window_state', { state: 'minimized' }),
  ]);
  assert.equal(r.state.state, 'minimized');
  const restored = run([g('window_state', { state: 'restored' })], r.state);
  assert.equal(restored.state.state, 'running');
  const splashGone = run([g('window_state', { state: 'destroyed' })], restored.state);
  assert.equal(splashGone.state.state, 'starting');
  assert.equal(splashGone.state.hwnd, null);
  assert.deepEqual(kinds(splashGone.last), ['arm_no_window_timer']);
  assert.equal(run([g('window', { hwnd: 2 })], splashGone.state).state.hwnd, 2);
});

test("the owner's Stop asks the window to close and ends the run when the program exits", () => {
  const r = run([{ type: 'start', chatId: 'c' }, g('window', { hwnd: 1 }), { type: 'stop', mode: 'ask' }]);
  assert.equal(r.state.state, 'stopping');
  assert.deepEqual(kinds(r.last), ['keep_last_frame', 'clear_timers', 'close_window', 'arm_close_timer']);
  assert.equal(r.last.effects[3].ms, CLOSE_TIMEOUT_MS);
  const done = run([g('exited', { exitCode: 0 })], r.state);
  assert.equal(done.state.state, 'idle');
  assert.equal(done.state.hwnd, null);
});

test('a program that does not close when asked waits for Show window or Force stop', () => {
  const r = run([
    { type: 'start', chatId: 'c' }, g('window', { hwnd: 1 }), { type: 'stop', mode: 'ask' }, g('close_timeout'),
  ]);
  assert.equal(r.state.state, 'close_refused');
  assert.equal(run([{ type: 'stop', mode: 'ask' }], r.state).last.ignored, true);
  const forced = run([{ type: 'stop', mode: 'force' }], r.state);
  assert.equal(forced.state.state, 'stopping');
  assert.deepEqual(kinds(forced.last), ['force_stop']);
  assert.equal(run([g('stopped', { exitCode: 1 })], forced.state).state.state, 'idle');
});

test('a stop with no window, or a force stop, ends the job at once', () => {
  const noWindow = run([{ type: 'start', chatId: 'c' }, g('spawned', { pid: 1 }), { type: 'stop', mode: 'ask' }]);
  assert.deepEqual(kinds(noWindow.last), ['keep_last_frame', 'clear_timers', 'force_stop']);
  const forced = run([{ type: 'start', chatId: 'c' }, g('window', { hwnd: 1 }), { type: 'stop', mode: 'force' }]);
  assert.deepEqual(kinds(forced.last), ['keep_last_frame', 'clear_timers', 'force_stop']);
});

test('a stop during the build cancels the build and nothing is spawned', () => {
  const r = run([{ type: 'start', chatId: 'c', hasBuild: true }, { type: 'stop', mode: 'ask' }]);
  assert.deepEqual(kinds(r.last), ['keep_last_frame', 'cancel_build']);
  const after = run([g('build_ok')], r.state);
  assert.equal(after.last.ignored, true);
  assert.equal(run([g('build_failed', { exitCode: 1 })], r.state).state.state, 'idle');
});

test('restart is a force stop, then a new generation that builds and starts', () => {
  const r = run([
    { type: 'start', chatId: 'chat-a' }, g('window', { hwnd: 1 }),
    { type: 'restart', chatId: 'chat-b', hasBuild: true },
  ]);
  assert.equal(r.state.state, 'stopping');
  assert.ok(kinds(r.last).includes('force_stop'));
  const old = r.state.generation;
  const rebuilt = run([g('stopped', { exitCode: 0 })], r.state);
  assert.equal(rebuilt.state.state, 'building');
  assert.equal(rebuilt.state.generation, old + 1);
  assert.equal(rebuilt.state.chatId, 'chat-b');
  assert.deepEqual(kinds(rebuilt.last), ['clear_timers', 'run_build']);
});

test('restart from rest just starts; restart while the owner is asked forces the stop', () => {
  assert.equal(run([{ type: 'restart', chatId: 'c' }]).state.state, 'starting');
  const r = run([
    { type: 'start', chatId: 'c' }, g('window', { hwnd: 1 }), { type: 'stop', mode: 'ask' }, g('close_timeout'),
    { type: 'restart', chatId: 'c' },
  ]);
  assert.deepEqual(kinds(r.last), ['force_stop']);
  assert.equal(run([g('stopped')], r.state).state.state, 'starting');
});

test('a stop during a restart cancels the relaunch', () => {
  const restarting = run([{ type: 'start', chatId: 'c' }, g('window', { hwnd: 1 }), { type: 'restart', chatId: 'c' }]);
  assert.equal(restarting.state.restartPending, true);
  const stopped = run([{ type: 'stop', mode: 'force' }, g('stopped', { exitCode: 0 })], restarting.state);
  assert.equal(stopped.log[0].state.restartPending, false);
  assert.equal(stopped.state.state, 'idle');
  const refused = run([
    { type: 'start', chatId: 'c' }, g('window', { hwnd: 1 }), { type: 'stop', mode: 'ask' }, g('close_timeout'),
    { type: 'restart', chatId: 'c' }, { type: 'stop', mode: 'force' }, g('stopped'),
  ]);
  assert.equal(refused.state.state, 'idle');
});

test('events from an older generation never touch the new run', () => {
  const first = run([{ type: 'start', chatId: 'c' }, g('window', { hwnd: 1 }), { type: 'restart', chatId: 'c' }, g('stopped')]);
  const stale = run([{ type: 'exited', generation: first.state.generation - 1, exitCode: 9 }], first.state);
  assert.equal(stale.last.ignored, true);
  assert.equal(stale.state.state, 'starting');
});

test('stop when nothing runs is refused; unknown events are ignored', () => {
  assert.equal(run([{ type: 'stop', mode: 'ask' }]).last.reason, 'not_running');
  assert.equal(run([{ type: 'nonsense' }]).last.ignored, true);
});

test('run is not a grant: nothing under services/run-view loads services/computer-use', () => {
  const dir = path.join(__dirname, '..', 'services', 'run-view');
  const before = new Set(Object.keys(require.cache));
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) require(path.join(dir, file));
  const loaded = Object.keys(require.cache).filter((key) => !before.has(key) || key.includes(`${path.sep}run-view${path.sep}`));
  const computerUse = `${path.sep}services${path.sep}computer-use${path.sep}`;
  assert.deepEqual(Object.keys(require.cache).filter((key) => key.includes(computerUse)), []);
  assert.ok(loaded.length > 0);
});

test('a start reply that arrives after the first window still names the process, and changes nothing else', () => {
  const r = run([
    { type: 'start', chatId: 'chat-a', hasBuild: false },
    g('window', { hwnd: 591824, sourceId: 'window:591824:0' }),
    g('spawned', { pid: 42 }),
  ]);
  assert.equal(r.state.state, 'running');
  assert.equal(r.state.pid, 42);
  assert.deepEqual(kinds(r.last), [], 'no no-window timer for a run that already shows its window');
  const again = transition(r.state, { type: 'spawned', generation: r.state.generation, pid: 7 });
  assert.equal(again.state.pid, 42, 'a second reply never replaces a known process');
});
