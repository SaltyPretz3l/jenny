'use strict';

// new-test-file: the live run view's IPC handlers are a new surface (row 197, R1-service).

const test = require('node:test');
const assert = require('node:assert/strict');

const { RUN_VIEW_CHANNELS, createRunViewIpcHandlers } = require('../services/run-view/run-view-ipc');
const runView = require('../services/run-view');

// `status` is what getStatus answers when given; every other method (and getStatus without it) echoes its name.
function fakeService(status = null) {
  const calls = [];
  const service = new Proxy({}, {
    get: (_target, method) => async (args) => {
      calls.push({ method, args });
      if (method === 'getStatus' && status) {
        if (status instanceof Error) throw status;
        return status;
      }
      return { ok: true, echoed: method };
    },
  });
  return { service, calls };
}

const READY = { ok: true, command: { status: 'confirmed' }, run: { state: 'idle' } };

test('the channel names are fixed and frozen', () => {
  assert.deepEqual({ ...RUN_VIEW_CHANNELS }, {
    get: 'run-view:get',
    confirmCommand: 'run-view:confirm-command',
    start: 'run-view:start',
    stop: 'run-view:stop',
    restart: 'run-view:restart',
    showWindow: 'run-view:show-window',
    armCapture: 'run-view:arm-capture',
    output: 'run-view:output',
    setRestartAfterChanges: 'run-view:set-restart-after-changes',
    state: 'run-view:state',
    keepLastFrame: 'run-view:keep-last-frame',
  });
  assert.equal(Object.isFrozen(RUN_VIEW_CHANNELS), true);
  assert.equal(runView.RUN_VIEW_CHANNELS, RUN_VIEW_CHANNELS);
  assert.equal(typeof runView.createRunService, 'function');
});

test('there is one handler for each request channel and none for the pushed ones', () => {
  const { service } = fakeService();
  const handlers = createRunViewIpcHandlers({ runService: service });
  assert.deepEqual(Object.keys(handlers).sort(), [
    'run-view:arm-capture', 'run-view:confirm-command', 'run-view:get', 'run-view:output',
    'run-view:restart', 'run-view:set-restart-after-changes', 'run-view:show-window', 'run-view:start', 'run-view:stop',
  ]);
});

test('a valid payload reaches the matching service method with a null worktree by default', async () => {
  const { service, calls } = fakeService();
  const handlers = createRunViewIpcHandlers({ runService: service });
  const command = { program: 'bin\\game.exe' };
  const cases = [
    ['get', { projectId: 'p1' }, 'getStatus', { projectId: 'p1', worktree: null }],
    ['get', { projectId: 'p1', worktree: 'wt-a' }, 'getStatus', { projectId: 'p1', worktree: 'wt-a' }],
    ['confirmCommand', { projectId: 'p1', command }, 'confirmCommand', { projectId: 'p1', worktree: null, command }],
    ['start', { projectId: 'p1', chatId: 'c1' }, 'start', { projectId: 'p1', chatId: 'c1', worktree: null }],
    ['restart', { projectId: 'p1', chatId: 'c1', worktree: null }, 'restart', { projectId: 'p1', chatId: 'c1', worktree: null }],
    ['stop', { projectId: 'p1', mode: 'force' }, 'stop', { projectId: 'p1', mode: 'force' }],
    ['showWindow', { projectId: 'p1', place: 'behind' }, 'showWindow', { projectId: 'p1', place: 'behind' }],
    ['armCapture', { projectId: 'p1' }, 'armCapture', { projectId: 'p1' }],
    ['output', { projectId: 'p1' }, 'output', { projectId: 'p1' }],
  ];
  for (const [channel, payload, method, args] of cases) {
    const result = await handlers[RUN_VIEW_CHANNELS[channel]](payload);
    // With no switch handed in, `get` still says the restart switch is on.
    assert.deepEqual(result, { ok: true, echoed: method, ...(channel === 'get' ? { restartAfterChanges: true } : {}) }, channel);
    assert.deepEqual(calls.at(-1), { method, args }, channel);
  }
});

test('an invalid payload is refused as bad_request without calling the service', async () => {
  const { service, calls } = fakeService();
  const handlers = createRunViewIpcHandlers({ runService: service });
  const long = 'x'.repeat(201);
  const bad = [
    ['get', undefined], ['get', null], ['get', 'p1'], ['get', ['p1']], ['get', {}],
    ['get', { projectId: '' }], ['get', { projectId: 7 }], ['get', { projectId: long }],
    ['get', { projectId: 'p1', extra: 1 }], ['get', { projectId: 'p1', worktree: 5 }],
    ['get', { projectId: 'p1', worktree: '' }], ['get', { projectId: 'p1', worktree: undefined, root: 'C:\\' }],
    ['confirmCommand', { projectId: 'p1' }], ['confirmCommand', { projectId: 'p1', command: 'cmd /c x' }],
    ['confirmCommand', { projectId: 'p1', command: [] }], ['confirmCommand', { projectId: 'p1', command: null }],
    ['start', { projectId: 'p1' }], ['start', { projectId: 'p1', chatId: '' }],
    ['start', { projectId: 'p1', chatId: long }], ['restart', { projectId: 'p1', chatId: 3 }],
    ['stop', { projectId: 'p1' }], ['stop', { projectId: 'p1', mode: 'kill' }],
    ['showWindow', { projectId: 'p1' }], ['showWindow', { projectId: 'p1', place: 'minimize' }],
    ['armCapture', { projectId: 'p1', sourceId: 'window:1:0' }], ['output', { projectId: 'p1', maxLines: 5 }],
    ['setRestartAfterChanges', { projectId: 'p1' }], ['setRestartAfterChanges', { on: true }],
    ['setRestartAfterChanges', { projectId: 'p1', on: 'yes' }], ['setRestartAfterChanges', { projectId: 'p1', on: 1 }],
    ['setRestartAfterChanges', { projectId: 'p1', on: true, extra: 1 }], ['setRestartAfterChanges', { projectId: '', on: true }],
  ];
  for (const [channel, payload] of bad) {
    const result = await handlers[RUN_VIEW_CHANNELS[channel]](payload);
    assert.deepEqual(result, { ok: false, reason: 'bad_request' }, `${channel} ${JSON.stringify(payload)}`);
  }
  assert.deepEqual(calls, []);
});

test('the restart switch is answered by the switch, never the run service, and get carries its value', async () => {
  const { service, calls } = fakeService();
  const seen = [];
  const restartSwitch = { setOn: (args) => { seen.push(args); return { ok: true, on: args.on }; }, isOn: (projectId) => projectId === 'p1' };
  const handlers = createRunViewIpcHandlers({ runService: service, restartSwitch });
  assert.deepEqual(await handlers['run-view:set-restart-after-changes']({ projectId: 'p1', on: false }), { ok: true, on: false });
  assert.deepEqual(seen, [{ projectId: 'p1', on: false }]);
  assert.deepEqual(calls, []);
  assert.deepEqual(await handlers['run-view:get']({ projectId: 'p1' }), { ok: true, echoed: 'getStatus', restartAfterChanges: true });
  assert.deepEqual(await handlers['run-view:get']({ projectId: 'p2' }), { ok: true, echoed: 'getStatus', restartAfterChanges: false });
  const failing = createRunViewIpcHandlers({ runService: { getStatus: async () => ({ ok: false, reason: 'no_project' }) }, restartSwitch });
  assert.deepEqual(await failing['run-view:get']({ projectId: 'p1' }), { ok: false, reason: 'no_project' });
  const bare = createRunViewIpcHandlers({ runService: service });
  assert.deepEqual(await bare['run-view:set-restart-after-changes']({ projectId: 'p1', on: true }), { ok: false, reason: 'unavailable' });
});

test('an object with a polluted prototype is not a payload', async () => {
  const { service, calls } = fakeService();
  const handlers = createRunViewIpcHandlers({ runService: service });
  class Payload { constructor() { this.projectId = 'p1'; } }
  assert.deepEqual(await handlers['run-view:get'](new Payload()), { ok: false, reason: 'bad_request' });
  assert.deepEqual(calls, []);
});

test('a service that throws is answered as an internal error', async () => {
  const handlers = createRunViewIpcHandlers({ runService: { getStatus: async () => { throw new Error('boom'); } } });
  assert.deepEqual(await handlers['run-view:get']({ projectId: 'p1' }), { ok: false, reason: 'internal_error' });
});

test('start takes an optional boolean anyway; anything else is refused before the service is called', async () => {
  const { service, calls } = fakeService();
  const handlers = createRunViewIpcHandlers({ runService: service });
  const start = handlers[RUN_VIEW_CHANNELS.start];
  for (const anyway of ['true', 1, 0, null, {}, []]) {
    assert.deepEqual(await start({ projectId: 'p1', chatId: 'c1', anyway }), { ok: false, reason: 'bad_request' }, JSON.stringify(anyway));
  }
  assert.deepEqual(calls, []);
  for (const anyway of [true, false, undefined]) {
    assert.equal((await start({ projectId: 'p1', chatId: 'c1', anyway })).ok, true);
  }
  assert.deepEqual(calls.map((call) => call.args), Array(3).fill({ projectId: 'p1', chatId: 'c1', worktree: null }), 'the service never sees anyway');
  assert.deepEqual(await handlers[RUN_VIEW_CHANNELS.restart]({ projectId: 'p1', chatId: 'c1', anyway: true }), { ok: false, reason: 'bad_request' });
});

test('a start into less free graphics memory than last time is answered low_gpu_memory and starts nothing; anyway starts', async () => {
  const { service, calls } = fakeService(READY);
  const asked = [];
  const startWarning = async (projectId) => { asked.push(projectId); return { needMb: 1800, freeMb: 900 }; };
  const handlers = createRunViewIpcHandlers({ runService: service, startWarning });
  const start = handlers[RUN_VIEW_CHANNELS.start];
  assert.deepEqual(await start({ projectId: 'p1', chatId: 'c1' }), { ok: false, reason: 'low_gpu_memory', needMb: 1800, freeMb: 900 });
  assert.deepEqual(await start({ projectId: 'p1', chatId: 'c1', anyway: false }), { ok: false, reason: 'low_gpu_memory', needMb: 1800, freeMb: 900 });
  assert.deepEqual(calls.map((call) => call.method), ['getStatus', 'getStatus']);
  assert.deepEqual(calls[0].args, { projectId: 'p1', worktree: null });
  assert.deepEqual(asked, ['p1', 'p1']);
  assert.equal((await start({ projectId: 'p1', chatId: 'c1', anyway: true })).ok, true);
  assert.deepEqual(calls.map((call) => call.method), ['getStatus', 'getStatus', 'start']);
  assert.deepEqual(asked, ['p1', 'p1'], 'anyway does not ask again');
});

test('no warning, or a warning check that throws, lets the start through; restart never asks', async () => {
  const { service, calls } = fakeService(READY);
  const asked = [];
  const quiet = createRunViewIpcHandlers({ runService: service, startWarning: async (id) => { asked.push(id); return null; } });
  assert.equal((await quiet[RUN_VIEW_CHANNELS.start]({ projectId: 'p1', chatId: 'c1' })).ok, true);
  const broken = createRunViewIpcHandlers({ runService: service, startWarning: async () => { throw new Error('probe broke'); } });
  assert.equal((await broken[RUN_VIEW_CHANNELS.start]({ projectId: 'p1', chatId: 'c1' })).ok, true);
  assert.deepEqual(calls.map((call) => call.method), ['getStatus', 'start', 'getStatus', 'start']);
  asked.length = 0;
  const warns = createRunViewIpcHandlers({ runService: service, startWarning: async (id) => { asked.push(id); return { needMb: 5, freeMb: 1 }; } });
  assert.equal((await warns[RUN_VIEW_CHANNELS.restart]({ projectId: 'p1', chatId: 'c1' })).ok, true);
  assert.deepEqual(asked, []);
  assert.deepEqual(calls.map((call) => call.method), ['getStatus', 'start', 'getStatus', 'start', 'restart']);
});

test('F10: the graphics-memory check runs only when the start would go ahead; otherwise the service refusal is returned', async () => {
  const asked = [];
  const startWarning = async (id) => { asked.push(id); return { needMb: 1800, freeMb: 900 }; };
  const refusals = [
    [{ ok: false, reason: 'no_project' }],
    [{ ok: true, command: { status: 'none' }, run: { state: 'idle' } }],
    [{ ok: true, command: { status: 'needs_confirmation' }, run: { state: 'idle' } }],
    [{ ok: true, command: { status: 'confirmed' }, run: { state: 'running' } }],
    [{ ok: true, command: { status: 'confirmed' }, run: { state: 'building' } }],
    [{ ok: true, command: { status: 'confirmed' }, run: { state: 'stopping' } }],
    [{ ok: true, command: { status: 'confirmed' } }],
    [new Error('status failed')],
  ];
  for (const [status] of refusals) {
    const { service, calls } = fakeService(status);
    const start = createRunViewIpcHandlers({ runService: service, startWarning })[RUN_VIEW_CHANNELS.start];
    assert.deepEqual(await start({ projectId: 'p1', chatId: 'c1' }), { ok: true, echoed: 'start' }, String(status.message || JSON.stringify(status)));
    assert.deepEqual(calls.map((call) => call.method), ['getStatus', 'start']);
  }
  assert.deepEqual(asked, [], 'no graphics-memory probe for a start the service would refuse');
  for (const state of ['idle', 'build_failed', 'ended_early', 'closed']) {
    const { service } = fakeService({ ok: true, command: { status: 'confirmed' }, run: { state } });
    const start = createRunViewIpcHandlers({ runService: service, startWarning })[RUN_VIEW_CHANNELS.start];
    assert.equal((await start({ projectId: 'p1', chatId: 'c1' })).reason, 'low_gpu_memory', state);
  }
  assert.equal(asked.length, 4);
});

test('creating the handlers needs a run service', () => {
  assert.throws(() => createRunViewIpcHandlers({}), TypeError);
});
