'use strict';
// new-test-file: row 197 A4 adds the restart-after-changes tracker (services/run-view/restart-after-changes.js), a new surface.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRestartAfterChanges, isChange } = require('../services/run-view/restart-after-changes');
const runView = require('../services/run-view');

function fakeService(state = 'running', { reply = { ok: true } } = {}) {
  const service = {
    state, calls: [], reply,
    peekState: () => service.state,
    restart: async (args) => { service.calls.push(args); return service.reply; },
  };
  return service;
}

function setup({ state = 'running', canStart = () => null, reply } = {}) {
  const service = fakeService(state, { reply });
  const warnings = [];
  const tracker = createRestartAfterChanges({ getRunService: () => service, canStart, logger: { warn: (m) => warnings.push(m) } });
  return { service, tracker, warnings };
}

const end = (tracker, status = 'completed', projectId = 'p1') => tracker.onTurnEnd({ projectId, chatId: 'c1', status });

test('the factory is re-exported by the run-view index', () => {
  assert.equal(runView.createRestartAfterChanges, createRestartAfterChanges);
});

test('a completed turn after a change restarts once; a second turn with no new change does not', async () => {
  const { service, tracker } = setup();
  tracker.recordChange({ projectId: 'p1', callId: 'a' });
  assert.deepEqual(await end(tracker), { restarted: true, reason: 'restarted' });
  assert.deepEqual(service.calls, [{ projectId: 'p1', chatId: 'c1', worktree: null }]);
  // The restart's own state push begins a build: the service tells the tracker through markBuild.
  tracker.markBuild('p1');
  assert.deepEqual(await end(tracker), { restarted: false, reason: 'no_changes' });
  assert.equal(service.calls.length, 1);
});

test('a stopped or failed turn never restarts, and the change stays counted for the next completed turn', async () => {
  const { service, tracker } = setup();
  tracker.recordChange({ projectId: 'p1', callId: 'a' });
  assert.deepEqual(await end(tracker, 'cancelled'), { restarted: false, reason: 'not_completed' });
  assert.deepEqual(await end(tracker, 'failed'), { restarted: false, reason: 'not_completed' });
  assert.deepEqual(service.calls, []);
  assert.deepEqual(await end(tracker), { restarted: true, reason: 'restarted' });
});

test('a restart made mid-turn moves the mark, so the turn end builds nothing twice', async () => {
  const { service, tracker } = setup();
  tracker.recordChange({ projectId: 'p1', callId: 'a' });
  tracker.markBuild('p1');
  assert.deepEqual(await end(tracker), { restarted: false, reason: 'no_changes' });
  tracker.recordChange({ projectId: 'p1', callId: 'b' });
  assert.deepEqual(await end(tracker), { restarted: true, reason: 'restarted' });
  assert.equal(service.calls.length, 1);
});

test('the switch defaults on, is per project, and off stops the restart until it is back on', async () => {
  const { service, tracker } = setup();
  assert.equal(tracker.isOn('p1'), true);
  assert.deepEqual(tracker.setOn({ projectId: 'p1', on: false }), { ok: true, on: false });
  assert.equal(tracker.isOn('p1'), false);
  assert.equal(tracker.isOn('p2'), true);
  tracker.recordChange({ projectId: 'p1', callId: 'a' });
  assert.deepEqual(await end(tracker), { restarted: false, reason: 'switch_off' });
  tracker.setOn({ projectId: 'p1', on: true });
  assert.deepEqual(await end(tracker), { restarted: true, reason: 'restarted' });
  assert.equal(service.calls.length, 1);
});

test('setOn refuses a bad project id or a non-boolean', () => {
  const { tracker } = setup();
  for (const bad of [{ projectId: '', on: true }, { projectId: 5, on: true }, { projectId: 'p1', on: 'yes' }, { projectId: 'p1' }, undefined]) {
    assert.deepEqual(tracker.setOn(bad), { ok: false, reason: 'bad_request' });
  }
  assert.equal(tracker.isOn('p1'), true);
});

test('only a program already running again is restarted: idle, closed and mid-build or mid-stop never start', async () => {
  for (const state of ['idle', 'closed', 'building', 'starting', 'stopping', 'close_refused', null]) {
    const { service, tracker } = setup({ state });
    tracker.recordChange({ projectId: 'p1', callId: 'a' });
    assert.deepEqual(await end(tracker), { restarted: false, reason: 'not_running' }, String(state));
    assert.deepEqual(service.calls, []);
  }
  for (const state of ['running', 'minimized', 'no_window', 'build_failed', 'ended_early']) {
    const { service, tracker } = setup({ state });
    tracker.recordChange({ projectId: 'p1', callId: 'a' });
    assert.deepEqual(await end(tracker), { restarted: true, reason: 'restarted' }, state);
    assert.equal(service.calls.length, 1);
  }
});

test('no run service yet answers not_running and never builds anything', async () => {
  const tracker = createRestartAfterChanges({ getRunService: () => null, canStart: () => null });
  tracker.recordChange({ projectId: 'p1', callId: 'a' });
  assert.deepEqual(await end(tracker), { restarted: false, reason: 'not_running' });
});

test('the start gate passes its reason through, and the default gate fails closed', async () => {
  const { service, tracker } = setup({ canStart: () => 'sandbox_only' });
  tracker.recordChange({ projectId: 'p1', callId: 'a' });
  assert.deepEqual(await end(tracker), { restarted: false, reason: 'sandbox_only' });
  assert.deepEqual(service.calls, []);

  const closed = createRestartAfterChanges({ getRunService: () => fakeService() });
  closed.recordChange({ projectId: 'p1', callId: 'a' });
  assert.deepEqual(await end(closed), { restarted: false, reason: 'disabled' });

  const throwing = createRestartAfterChanges({ getRunService: () => fakeService(), canStart: () => { throw new Error('x'); } });
  throwing.recordChange({ projectId: 'p1', callId: 'a' });
  assert.deepEqual(await end(throwing), { restarted: false, reason: 'disabled' });
});

test('a repeated call id counts once, a blank project is ignored', async () => {
  const { service, tracker } = setup();
  tracker.recordChange({ projectId: '', callId: 'z' });
  tracker.recordChange({ projectId: 'p1', callId: 'a' });
  assert.deepEqual(await end(tracker, 'completed', ''), { restarted: false, reason: 'no_changes' });
  tracker.recordChange({ projectId: 'p1', callId: 'a' });
  assert.deepEqual(await end(tracker), { restarted: true, reason: 'restarted' });
  tracker.markBuild('p1');
  // The canonical replay of the same call is not a second change.
  tracker.recordChange({ projectId: 'p1', callId: 'a' });
  assert.deepEqual(await end(tracker), { restarted: false, reason: 'no_changes' });
  assert.equal(service.calls.length, 1);
});

test('a failed restart leaves the mark, so the next completed turn retries', async () => {
  const { service, tracker, warnings } = setup({ reply: { ok: false, reason: 'no_command' } });
  tracker.recordChange({ projectId: 'p1', callId: 'a' });
  assert.deepEqual(await end(tracker), { restarted: false, reason: 'no_command' });
  assert.equal(warnings.length, 1);
  service.reply = { ok: false };
  assert.deepEqual(await end(tracker), { restarted: false, reason: 'restart_failed' });
  service.reply = { ok: true };
  assert.deepEqual(await end(tracker), { restarted: true, reason: 'restarted' });
  assert.equal(service.calls.length, 3);
});

test('a restart that throws is reported, never thrown', async () => {
  const { service, tracker } = setup();
  service.restart = async () => { throw new Error('host gone'); };
  tracker.recordChange({ projectId: 'p1', callId: 'a' });
  assert.deepEqual(await end(tracker), { restarted: false, reason: 'restart_failed' });
  service.restart = async () => ({ ok: true });
  assert.deepEqual(await end(tracker), { restarted: true, reason: 'restarted' });
});

test('two overlapping turn ends restart once', async () => {
  const { service, tracker } = setup();
  let release;
  service.restart = (args) => new Promise((resolve) => { service.calls.push(args); release = () => resolve({ ok: true }); });
  tracker.recordChange({ projectId: 'p1', callId: 'a' });
  const first = end(tracker);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await end(tracker), { restarted: false, reason: 'in_flight' });
  release();
  assert.deepEqual(await first, { restarted: true, reason: 'restarted' });
  assert.equal(service.calls.length, 1);
});

test('forget drops a project\'s counts and switch', async () => {
  const { tracker } = setup();
  tracker.recordChange({ projectId: 'p1', callId: 'a' });
  tracker.setOn({ projectId: 'p1', on: false });
  tracker.forget('p1');
  assert.equal(tracker.isOn('p1'), true);
  assert.deepEqual(await end(tracker), { restarted: false, reason: 'no_changes' });
});

test('memory is bounded: the least recently touched project goes after 256, and old call ids are dropped', async () => {
  const { tracker } = setup();
  tracker.setOn({ projectId: 'first', on: false });
  for (let i = 0; i < 256; i += 1) tracker.recordChange({ projectId: `p${i}`, callId: `c${i}` });
  assert.equal(tracker.isOn('first'), true, 'the oldest project was dropped, so it is back to the default');
  tracker.setOn({ projectId: 'p0', on: false });
  assert.equal(tracker.isOn('p0'), false);

  const small = setup();
  for (let i = 0; i < 600; i += 1) small.tracker.recordChange({ projectId: 'p1', callId: `x${i}` });
  small.tracker.markBuild('p1');
  small.tracker.recordChange({ projectId: 'p1', callId: 'x0' }); // forgotten id: counts as new
  assert.deepEqual(await end(small.tracker), { restarted: true, reason: 'restarted' });
  small.tracker.markBuild('p1');
  small.tracker.recordChange({ projectId: 'p1', callId: 'x599' }); // still remembered: not counted
  assert.deepEqual(await end(small.tracker), { restarted: false, reason: 'no_changes' });
});

test('isChange: file tools, and a review that shows changed paths; failures and junk are not changes', () => {
  for (const toolName of ['write_file', 'edit_file', 'apply_patch']) {
    assert.equal(isChange({ toolName, success: true, metadata: {} }), true, toolName);
    assert.equal(isChange({ toolName, metadata: undefined }), true, `${toolName} without a flag`);
    assert.equal(isChange({ toolName, success: false, metadata: {} }), false, `${toolName} failed`);
  }
  assert.equal(isChange({ toolName: 'read_file', success: true, metadata: {} }), false);
  assert.equal(isChange({ toolName: 'run_command', success: true, metadata: { review: { changed_path_count: 2 } } }), true);
  assert.equal(isChange({ toolName: 'run_command', success: true, metadata: { review: { changed_paths: ['a.rs'] } } }), true);
  assert.equal(isChange({ toolName: 'run_script', success: true, metadata: { changed_paths: ['a.rs'] } }), true);
  assert.equal(isChange({ toolName: 'run_command', success: false, metadata: { review: { changed_path_count: 2 } } }), false);
  for (const metadata of [null, 'x', 7, [], {}, { review: null }, { review: { changed_path_count: 0 } }, { review: { changed_path_count: '3' } },
    { review: { changed_path_count: -1 } }, { review: { changed_paths: [] } }, { review: { changed_paths: 'a' } }, { changed_paths: {} }]) {
    assert.equal(isChange({ toolName: 'run_command', success: true, metadata }), false, JSON.stringify(metadata));
  }
  assert.equal(isChange(), false);
  assert.equal(isChange({ toolName: 5 }), false);
});
