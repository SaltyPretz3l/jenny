'use strict';
// new-test-file: row 197 R2 wires the Live tab into main (holder, gates, bridge descriptors); no existing file covers that surface.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

const { JENNY_SHELL_BRIDGE_DESCRIPTORS } = require('../services/ipc-contract');
const { RUN_VIEW_CHANNELS } = require('../services/run-view');
const runView = require('../services/run-view');
const { createLazyRunView, PUSH_METHODS } = require('../services/main/run-view-composition');
const { METHODS, registerRunViewIpc } = require('../services/main/run-view-ipc-registration');
const { removeTreeSync } = require('../services/fs-remove-no-follow');

function fakeIpcMain() {
  const handlers = new Map();
  return { handlers, handle: (channel, fn) => handlers.set(channel, fn) };
}

const ALLOW = { authorize: () => true };
const call = (ipc, method, payload) => ipc.handlers.get(METHODS[method].channel)({}, payload);

function fakeHost() {
  const host = new EventEmitter();
  host.calls = [];
  host.request = async (op, args) => { host.calls.push([op, args]); return {}; };
  host.stop = async () => { host.calls.push(['stop']); };
  return host;
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-run-view-wiring-'));
  t.after(() => removeTreeSync(dir));
  return dir;
}

test('every run-view request channel has a bridge method of the same channel, and the pushes subscribe', () => {
  const requests = Object.entries(RUN_VIEW_CHANNELS).filter(([key]) => key !== 'state' && key !== 'keepLastFrame');
  const mapped = Object.values(METHODS).map((m) => m.channel).sort();
  assert.deepEqual(mapped, requests.map(([, channel]) => channel).sort());
  for (const [name, { channel }] of Object.entries(METHODS)) {
    assert.deepEqual(JENNY_SHELL_BRIDGE_DESCRIPTORS[name], { kind: 'invoke', channel }, name);
  }
  assert.deepEqual(JENNY_SHELL_BRIDGE_DESCRIPTORS['runView.onState'], { kind: 'subscribe', channel: RUN_VIEW_CHANNELS.state });
  assert.deepEqual(JENNY_SHELL_BRIDGE_DESCRIPTORS['runView.onKeepLastFrame'], { kind: 'subscribe', channel: RUN_VIEW_CHANNELS.keepLastFrame });
  assert.deepEqual(PUSH_METHODS, {
    [RUN_VIEW_CHANNELS.state]: 'runView.onState', [RUN_VIEW_CHANNELS.keepLastFrame]: 'runView.onKeepLastFrame',
  });
});

function gatedSetup({ enabled = true, hosted = false, sandbox = false, platform = 'win32', state = null } = {}) {
  const ipc = fakeIpcMain();
  const service = { peekState: () => state };
  const built = [];
  const holder = {
    platform: () => platform, peek: () => service,
    get: () => { built.push('get'); return service; },
  };
  const seen = [];
  const createHandlers = () => Object.fromEntries(Object.values(METHODS).map(({ channel }) => [channel, async (payload) => {
    seen.push([channel, payload]);
    return { ok: true };
  }]));
  registerRunViewIpc(ipc, {
    getHolder: () => holder, authorization: ALLOW, isEnabled: () => enabled, isHostedServer: () => hosted,
    isSandboxOnly: () => sandbox, createHandlers,
  });
  return { ipc, built, seen };
}

test('the gates answer before anything is built: flag off, hosted server, not Windows', async () => {
  for (const [options, reason] of [
    [{ enabled: false }, 'disabled'], [{ hosted: true }, 'disabled'], [{ platform: 'linux' }, 'unsupported_platform'],
  ]) {
    const { ipc, built, seen } = gatedSetup(options);
    assert.deepEqual(await call(ipc, 'runView.start', { projectId: 'p', chatId: 'c' }), { ok: false, reason });
    assert.deepEqual(await call(ipc, 'runView.get', { projectId: 'p' }), { ok: false, reason });
    assert.deepEqual(built, []);
    assert.deepEqual(seen, []);
  }
});

test('sandbox-only refuses what starts a program but still lets a live run be seen and stopped', async () => {
  const idle = gatedSetup({ sandbox: true });
  for (const method of ['runView.start', 'runView.restart', 'runView.confirmCommand', 'runView.get']) {
    assert.deepEqual(await call(idle.ipc, method, { projectId: 'p' }), { ok: false, reason: 'sandbox_only' }, method);
  }
  assert.deepEqual(await call(idle.ipc, 'runView.stop', { projectId: 'p', mode: 'ask' }), { ok: true });

  const live = gatedSetup({ sandbox: true, state: 'running' });
  assert.deepEqual(await call(live.ipc, 'runView.get', { projectId: 'p' }), { ok: true });
  assert.deepEqual(await call(live.ipc, 'runView.start', { projectId: 'p', chatId: 'c' }), { ok: false, reason: 'sandbox_only' });
  for (const method of ['runView.showWindow', 'runView.armCapture', 'runView.output']) {
    assert.deepEqual(await call(live.ipc, method, { projectId: 'p' }), { ok: true }, method);
  }
});

test('a call that passes the gates reaches the run service handler with its payload', async () => {
  const { ipc, built, seen } = gatedSetup();
  assert.deepEqual(await call(ipc, 'runView.stop', { projectId: 'p', mode: 'force' }), { ok: true });
  assert.deepEqual(seen, [['run-view:stop', { projectId: 'p', mode: 'force' }]]);
  assert.deepEqual(built, ['get']);
});

test('an unauthorized sender never reaches the holder', async () => {
  const ipc = fakeIpcMain();
  let touched = false;
  registerRunViewIpc(ipc, {
    getHolder: () => { touched = true; return null; },
    authorization: { authorize: () => false, unauthorizedResult: () => ({ ok: false, reason: 'unauthorized' }) },
  });
  assert.deepEqual(await call(ipc, 'runView.get', { projectId: 'p' }), { ok: false, reason: 'unauthorized' });
  assert.equal(touched, false);
});

function fakeModules(log) {
  return () => ({
    createRunCommandStore: () => { log.push('store'); return { deleteProject: (id) => { log.push(`store.delete:${id}`); return { ok: true }; } }; },
    createComputerHelperHost: () => { log.push('host'); return { stop: async () => { log.push('host.stop'); } }; },
    createRunService: (options) => {
      log.push('service');
      log.options = options;
      return {
        onProjectDeleted: async (id) => { log.push(`service.delete:${id}`); return { ok: true }; },
        stopAll: async () => { log.push('stopAll'); if (log.failStop) throw new Error('stop failed'); return { ok: true }; },
        dispose: () => log.push('dispose'),
        livePids: () => [42],
      };
    },
  });
}

test('the holder builds nothing until used, and a delete before first use touches only the store', async () => {
  const log = [];
  const holder = createLazyRunView({ userDataPath: 'x', modules: fakeModules(log), getBackendService: () => null });
  assert.equal(holder.peek(), null);
  assert.deepEqual(holder.livePids(), []);
  await holder.shutdown();
  assert.deepEqual(log, []);
  await holder.onProjectDeleted('p1');
  assert.deepEqual(log, ['store', 'store.delete:p1']);
  const service = holder.get();
  assert.equal(holder.get(), service);
  assert.deepEqual(log.slice(2), ['host', 'service']);
  await holder.onProjectDeleted('p2');
  assert.equal(log.at(-1), 'service.delete:p2');
  assert.deepEqual(holder.livePids(), [42]);
});

test('the run service is told whether this is a packaged build', () => {
  for (const given of [true, false]) {
    const log = [];
    createLazyRunView({ userDataPath: 'x', modules: fakeModules(log), getBackendService: () => null, isPackaged: given }).get();
    assert.equal(log.options.isPackaged, given);
  }
  const log = [];
  createLazyRunView({ userDataPath: 'x', modules: fakeModules(log), getBackendService: () => null }).get();
  assert.equal(typeof log.options.isPackaged, 'boolean', 'an unset option is read, never left unknown');
});

test('shutdown stops every run, then disposes and stops the helper even when stopping fails', async () => {
  const log = [];
  log.failStop = true;
  const holder = createLazyRunView({ userDataPath: 'x', modules: fakeModules(log), getBackendService: () => null });
  holder.get();
  await assert.rejects(holder.shutdown(), /stop failed/);
  assert.deepEqual(log.slice(-3), ['stopAll', 'dispose', 'host.stop']);
});

test('the holder maps pushes to bridge events, capture to the display-media handler, and projects to their root', async () => {
  const log = [];
  const sent = [];
  const authority = { p: { root_path: 'G:/game', root_id: 'r1', root_revision: 3 }, general: { root_path: null, root_id: null, root_revision: 0 } };
  const holder = createLazyRunView({
    userDataPath: 'x', modules: fakeModules(log), sendBridgeEvent: (method, payload) => sent.push([method, payload]),
    getBackendService: () => ({ projectAuthority: { captureProject: (id) => { if (!authority[id]) throw new Error('no project'); return authority[id]; } } }),
  });
  holder.get();
  const { emit, armWindowCapture, getProjectBinding } = log.options;
  emit('run-view:state', { state: 'running' });
  emit('run-view:keep-last-frame', { generation: 2 });
  emit('run-view:other', {});
  assert.deepEqual(sent, [['runView.onState', { state: 'running' }], ['runView.onKeepLastFrame', { generation: 2 }]]);

  assert.deepEqual(await armWindowCapture('window:1:0'), { ok: false, reason: 'unavailable' });
  const armed = [];
  holder.setCaptureSource(() => ({ armWindowCapture: (id) => { armed.push(id); return { ok: true }; } }));
  assert.deepEqual(await armWindowCapture('window:1:0'), { ok: true });
  assert.deepEqual(armed, ['window:1:0']);

  assert.deepEqual(await getProjectBinding('p'), { rootPath: 'G:/game', rootId: 'r1', rootRevision: 3 });
  assert.equal(await getProjectBinding('general'), null);
  assert.equal(await getProjectBinding('missing'), null);
  // Worktree roots are not resolved yet, so a worktree answers no project instead of the main root.
  assert.deepEqual(await getProjectBinding('p', null), { rootPath: 'G:/game', rootId: 'r1', rootRevision: 3 });
  assert.equal(await getProjectBinding('p', 'wt-a'), null);
});

test('end to end through the real run service and store: a project with a folder and no command yet', async (t) => {
  const userDataPath = tempDir(t);
  const host = fakeHost();
  const sent = [];
  const holder = createLazyRunView({
    userDataPath, sendBridgeEvent: (method, payload) => sent.push([method, payload]),
    getBackendService: () => ({ projectAuthority: { captureProject: () => ({ root_path: userDataPath, root_id: 'root-1', root_revision: 1 }) } }),
    modules: () => ({ ...runView, createComputerHelperHost: () => host }),
  });
  const ipc = fakeIpcMain();
  registerRunViewIpc(ipc, { getHolder: () => holder, authorization: ALLOW });
  const got = await call(ipc, 'runView.get', { projectId: 'proj-1' });
  assert.equal(got.ok, true, JSON.stringify(got));
  assert.equal(got.command.status, 'none');
  assert.deepEqual(await call(ipc, 'runView.start', { projectId: 'proj-1', chatId: 'chat-1' }), { ok: false, reason: 'no_command' });
  assert.deepEqual(await call(ipc, 'runView.stop', { projectId: 'proj-1', mode: 'sideways' }), { ok: false, reason: 'bad_request' });
  assert.deepEqual(host.calls, []);
  await holder.shutdown();
  assert.deepEqual(host.calls, [['stop']]);
});

// --- row 197 A4: restart after Jenny's changes ---------------------------------------------------

const { startGateFor } = require('../services/main/run-view-ipc-registration');
const { handleToolNotification } = require('../services/backend/chat-stream-tool-handling');

// A holder over a fake run service that reports `state` and records restarts.
function restartHolder({ state = 'running', sessions = { s1: 'p1' } } = {}) {
  const log = [];
  const service = {
    peekState: () => state,
    restarts: [],
    restart: async (args) => { service.restarts.push(args); return { ok: true }; },
    onProjectDeleted: async () => ({ ok: true }), stopAll: async () => ({ ok: true }), dispose: () => {}, livePids: () => [],
  };
  const backend = {
    projectAuthority: { captureSession: (id) => { if (!sessions[id]) throw new Error('no session'); return { project_id: sessions[id] }; } },
    featureFlags: { session_offline_lockdown: true },
    configService: { getChatUiState: () => ({ safetyMode: 'normal' }) },
    summaries: { s1: { id: 's1' } },
    messages: [{ role: 'user', content: 'go' }],
  };
  backend.sessionStore = { getSessionSummary: (id) => backend.summaries[id] || null, getSessionMessages: () => backend.messages };
  const modules = () => ({
    createRunCommandStore: () => ({ deleteProject: () => ({ ok: true }) }),
    createComputerHelperHost: () => ({ stop: async () => {} }),
    createRunService: (options) => { log.options = options; log.push('service'); return service; },
  });
  const sent = [];
  const holder = createLazyRunView({
    userDataPath: 'x', modules, sendBridgeEvent: (method, payload) => sent.push([method, payload]),
    getBackendService: () => backend,
  });
  return { holder, service, log, sent, backend };
}

const change = { sessionId: 's1', toolName: 'write_file', success: true, metadata: {} };

test('the start gate fails closed until one is set, and a gate that throws or is not a function refuses', () => {
  const { holder } = restartHolder();
  assert.equal(holder.startRefusal(), 'disabled');
  holder.setStartGate(() => null);
  assert.equal(holder.startRefusal(), null);
  holder.setStartGate(() => { throw new Error('x'); });
  assert.equal(holder.startRefusal(), 'disabled');
  holder.setStartGate(() => null);
  holder.setStartGate('nope');
  assert.equal(holder.startRefusal(), 'disabled');
});

test('a tool change and a completed turn restart a running program, resolving the project from the session', async () => {
  const { holder, service, log } = restartHolder();
  holder.setStartGate(() => null);
  holder.noteToolResult({ ...change, callId: 'early' });
  assert.deepEqual(log, [], 'a change before the Live tab was used builds nothing');
  assert.deepEqual(await holder.onTurnEnd({ sessionId: 's1', projectId: '', status: 'completed' }), { restarted: false, reason: 'no_changes' });
  assert.deepEqual(log, [], 'a turn end never builds it either');
  holder.get();
  holder.noteToolResult({ ...change, callId: 'a' });
  assert.deepEqual(await holder.onTurnEnd({ sessionId: 's1', status: 'completed' }), { restarted: true, reason: 'restarted' });
  assert.deepEqual(service.restarts, [{ projectId: 'p1', chatId: 's1', worktree: null }]);
});

test('the turn-end restart keeps the restart tool turn rules: safety mode, Plan and read-only mode, offline lockdown, a turn a person started', async () => {
  const cases = [
    ['safety_mode', (b) => { b.configService.getChatUiState = () => ({ safetyMode: 'strict' }); }],
    ['plan_mode', (b) => { b.summaries.s1 = { id: 's1', plan_mode: true }; }],
    ['plan_mode', (b) => { b.summaries.s1 = { id: 's1', run_mode: 'plan' }; }],
    ['read_only', (b) => { b.summaries.s1 = { id: 's1', run_mode: 'Propose' }; }],
    ['lockdown', (b) => { b.summaries.s1 = { id: 's1', lockdown: true }; }],
    ['unattended', (b) => { b.messages = [{ role: 'user', content: 'check', application_turn: 'scheduled_check' }]; }],
    ['no_session', (b) => { b.summaries = {}; }],
    ['safety_mode', (b) => { b.configService.getChatUiState = () => { throw new Error('x'); }; }], // unreadable counts as strict
    ['turn_unreadable', (b) => { b.summaries = null; }],
  ];
  for (const [reason, arrange] of cases) {
    const { holder, service, backend } = restartHolder();
    holder.setStartGate(() => null);
    holder.get();
    holder.noteToolResult({ ...change, callId: 'a' });
    arrange(backend);
    assert.deepEqual(await holder.onTurnEnd({ sessionId: 's1', status: 'completed' }), { restarted: false, reason }, reason);
    assert.deepEqual(service.restarts, [], reason);
  }
});

test('a state push with a newer generation moves the build mark, whoever caused it; the push is still forwarded', async () => {
  const { holder, service, log, sent } = restartHolder();
  holder.setStartGate(() => null);
  holder.get();
  const push = (generation) => log.options.emit('run-view:state', { projectId: 'p1', state: 'running', generation });
  holder.noteToolResult({ ...change, callId: 'a' });
  push(1);
  assert.deepEqual(await holder.onTurnEnd({ sessionId: 's1', status: 'completed' }), { restarted: false, reason: 'no_changes' });
  holder.noteToolResult({ ...change, callId: 'b' });
  push(1); // the same generation again is not a new build
  assert.deepEqual(await holder.onTurnEnd({ sessionId: 's1', projectId: 'p1', status: 'completed' }), { restarted: true, reason: 'restarted' });
  push(2);
  assert.deepEqual(await holder.onTurnEnd({ sessionId: 's1', status: 'completed' }), { restarted: false, reason: 'no_changes' });
  assert.equal(service.restarts.length, 1);
  assert.equal(sent.length, 3);
  assert.equal(sent[0][0], 'runView.onState');
});

test('nothing is counted while the gate says disabled or unsupported_platform; a refusal like sandbox_only is counted but not acted on', async () => {
  for (const reason of ['disabled', 'unsupported_platform']) {
    const { holder, service } = restartHolder();
    holder.setStartGate(() => reason);
    holder.get();
    holder.noteToolResult({ ...change, callId: 'a' });
    holder.setStartGate(() => null);
    assert.deepEqual(await holder.onTurnEnd({ sessionId: 's1', status: 'completed' }), { restarted: false, reason: 'no_changes' }, reason);
    assert.deepEqual(service.restarts, []);
  }
  const { holder, service } = restartHolder();
  holder.setStartGate(() => 'sandbox_only');
  holder.get();
  holder.noteToolResult({ ...change, callId: 'a' });
  assert.deepEqual(await holder.onTurnEnd({ sessionId: 's1', status: 'completed' }), { restarted: false, reason: 'sandbox_only' });
  assert.deepEqual(service.restarts, []);
});

test('noteToolResult counts only changes and survives an unknown session; onTurnEnd never throws', async () => {
  const { holder, service } = restartHolder();
  holder.setStartGate(() => null);
  holder.get();
  holder.noteToolResult({ sessionId: 's1', callId: 'r', toolName: 'read_file', success: true, metadata: {} });
  holder.noteToolResult({ ...change, callId: 'f', success: false });
  holder.noteToolResult({ ...change, callId: 'x', sessionId: 'unknown' });
  holder.noteToolResult();
  assert.deepEqual(await holder.onTurnEnd({ sessionId: 's1', status: 'completed' }), { restarted: false, reason: 'no_changes' });
  assert.deepEqual(await holder.onTurnEnd(), { restarted: false, reason: 'not_completed' });
  holder.noteToolResult({ sessionId: 's1', callId: 'cmd', toolName: 'run_command', success: true, metadata: { review: { changed_path_count: 1 } } });
  service.restart = async () => { throw new Error('host gone'); };
  assert.deepEqual(await holder.onTurnEnd({ sessionId: 's1', status: 'completed' }), { restarted: false, reason: 'restart_failed' });
});

test('the switch is per project and defaults on; a project delete forgets its counts and its switch', async () => {
  const { holder, service } = restartHolder();
  holder.setStartGate(() => null);
  holder.get();
  assert.equal(holder.restartSwitch.isOn('p1'), true);
  assert.deepEqual(holder.restartSwitch.setOn({ projectId: 'p1', on: false }), { ok: true, on: false });
  assert.equal(holder.restartSwitch.isOn('p1'), false);
  holder.noteToolResult({ ...change, callId: 'a' });
  assert.deepEqual(await holder.onTurnEnd({ sessionId: 's1', status: 'completed' }), { restarted: false, reason: 'switch_off' });
  await holder.onProjectDeleted('p1');
  assert.equal(holder.restartSwitch.isOn('p1'), true);
  assert.deepEqual(await holder.onTurnEnd({ sessionId: 's1', status: 'completed' }), { restarted: false, reason: 'no_changes' });
  assert.deepEqual(service.restarts, []);
});

test('startGateFor answers the starting rules once and fails closed on a throwing read', () => {
  const holder = { platform: () => 'win32' };
  const gate = (options) => startGateFor({ getHolder: () => holder, ...options })();
  assert.equal(gate({}), null);
  assert.equal(gate({ isEnabled: () => false }), 'disabled');
  assert.equal(gate({ isEnabled: () => { throw new Error('x'); } }), 'disabled');
  assert.equal(gate({ isHostedServer: () => true }), 'disabled');
  assert.equal(gate({ isHostedServer: () => { throw new Error('x'); } }), 'disabled');
  assert.equal(startGateFor({ getHolder: () => null })(), 'disabled');
  assert.equal(startGateFor({ getHolder: () => { throw new Error('x'); } })(), 'disabled');
  assert.equal(startGateFor({ getHolder: () => ({ platform: () => 'linux' }) })(), 'unsupported_platform');
  assert.equal(gate({ isSandboxOnly: () => true }), 'sandbox_only');
  assert.equal(gate({ isSandboxOnly: () => { throw new Error('x'); } }), 'sandbox_only');
});

test('the restart switch method reaches the handlers with the holder switch and is not a starting call', async () => {
  const ipc = fakeIpcMain();
  const restartSwitch = { isOn: () => true, setOn: () => ({ ok: true }) };
  const holder = { platform: () => 'win32', peek: () => null, get: () => ({}), restartSwitch };
  const created = [];
  registerRunViewIpc(ipc, {
    getHolder: () => holder, authorization: ALLOW, isSandboxOnly: () => true,
    createHandlers: (options) => { created.push(options); return { 'run-view:set-restart-after-changes': async (payload) => ({ ok: true, payload }) }; },
  });
  assert.equal(METHODS['runView.setRestartAfterChanges'].starts, false);
  assert.deepEqual(await call(ipc, 'runView.setRestartAfterChanges', { projectId: 'p', on: false }), { ok: true, payload: { projectId: 'p', on: false } });
  assert.equal(created[0].restartSwitch, restartSwitch);
});

test('a tool result tells the holder about itself, with the call id and the tool metadata; a holder that throws changes nothing', () => {
  const messages = [];
  const calls = [];
  const service = {
    sessionStore: {
      getSessionMessages: () => messages,
      appendMessage: (_sessionId, message) => { messages.push(message); return message; },
      updateMessage() {},
    },
    emit() {},
    options: { userDataPath: '' },
    runView: { noteToolResult: (args) => { calls.push(args); if (args.callId === 'boom') throw new Error('holder broke'); } },
  };
  const context = {
    seenToolCalls: new Set(), toolSummaries: new Map(), model: 'test-model', resolvedSessionId: 'session-1', streamId: 'stream-1',
    eventBase: { sessionId: 'session-1', streamId: 'stream-1' }, turnEventCollector: { noteEvent() {} },
  };
  const result = (id, params) => handleToolNotification(service, context, {
    method: 'tool.result', params: { tool_call_id: id, tool_name: 'run_command', output: 'ok', ...params },
  });
  result('call-1', { success: true, metadata: { review: { changed_paths: ['a.rs'], changed_path_count: 1 } } });
  result('call-2', { success: false });
  assert.doesNotThrow(() => result('boom', { success: true }));
  assert.equal(calls.length, 3);
  assert.equal(calls[0].sessionId, 'session-1');
  assert.equal(calls[0].callId, 'call-1');
  assert.equal(calls[0].toolName, 'run_command');
  assert.equal(calls[0].success, true);
  assert.deepEqual(calls[0].metadata.review, { changed_paths: ['a.rs'], changed_path_count: 1 });
  assert.equal(calls[1].success, false);
  assert.equal(messages.filter((message) => message.kind === 'tool_result').length, 3, 'every result still persisted');
});

test('hasConfirmedCommand reads the real store for the project root and never builds the run service', async (t) => {
  const userDataPath = tempDir(t);
  const host = fakeHost();
  const roots = { p1: { root_path: userDataPath, root_id: 'root-1', root_revision: 1 }, bare: { root_path: null, root_id: null, root_revision: 0 } };
  const holder = createLazyRunView({
    userDataPath, getBackendService: () => ({ projectAuthority: { captureProject: (id) => {
      if (!roots[id]) throw new Error('no project');
      return roots[id];
    } } }),
    modules: () => ({ ...runView, createComputerHelperHost: () => host }),
  });
  assert.equal(holder.hasConfirmedCommand('p1'), false);
  assert.equal(holder.hasConfirmedCommand('bare'), false);
  assert.equal(holder.hasConfirmedCommand('missing'), false);
  assert.equal(holder.peek(), null, 'asking built nothing');
  const ipc = fakeIpcMain();
  registerRunViewIpc(ipc, { getHolder: () => holder, authorization: ALLOW });
  const saved = await call(ipc, 'runView.confirmCommand', { projectId: 'p1', command: { program: 'game.exe' } });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(holder.hasConfirmedCommand('p1'), true);
  roots.p1 = { ...roots.p1, root_revision: 2 };
  assert.equal(holder.hasConfirmedCommand('p1'), false, 'a rebound root needs the command confirmed again');
  await holder.shutdown();
});

test('R3 seams: the chat that started a run lists it, every push refetches that chat, and a pid names its project', async (t) => {
  const userDataPath = tempDir(t);
  const host = fakeHost();
  host.request = async (op, args) => { host.calls.push([op, args]); return op === 'run.start' ? { pid: 4242 } : {}; };
  const notified = [];
  let clock = 1000;
  const backend = {
    captures: 0,
    projectAuthority: { captureProject: () => { backend.captures += 1; return { root_path: userDataPath, root_id: 'root-1', root_revision: 1 }; } },
    chatWorkspace: { notifyCoordinationChanged: (id) => notified.push(id) },
  };
  fs.writeFileSync(path.join(userDataPath, 'game.exe'), '');
  const holder = createLazyRunView({
    userDataPath, getBackendService: () => backend, now: () => clock,
    modules: () => ({ ...runView, createComputerHelperHost: () => host }),
  });
  assert.deepEqual(holder.runsForChat('chat-1'), [], 'nothing pushed, nothing listed, nothing built');
  assert.equal(holder.projectForPid(4242), '');
  assert.equal(holder.peek(), null);
  const ipc = fakeIpcMain();
  registerRunViewIpc(ipc, { getHolder: () => holder, authorization: ALLOW });
  assert.equal((await call(ipc, 'runView.confirmCommand', { projectId: 'p1', command: { program: 'bin/game.exe', cwd: '' } })).ok, true);
  fs.mkdirSync(path.join(userDataPath, 'bin'));
  fs.writeFileSync(path.join(userDataPath, 'bin', 'game.exe'), '');
  const started = await call(ipc, 'runView.start', { projectId: 'p1', chatId: 'chat-1' });
  assert.equal(started.ok, true, JSON.stringify(started));
  await new Promise((resolve) => setImmediate(resolve));
  const [row] = holder.runsForChat('chat-1');
  assert.equal(row.projectId, 'p1');
  assert.equal(row.label, 'game.exe');
  assert.equal(row.generation, 1);
  assert.equal(row.startedAtMs, 1000);
  assert.equal(row.endedAtMs, 0);
  assert.deepEqual(holder.runsForChat('chat-2'), [], 'another chat does not list it');
  const captures = backend.captures;
  assert.equal(holder.runsForChat('chat-1')[0].label, 'game.exe');
  assert.equal(backend.captures, captures, 'the label is read once per run, not on every list');
  assert.ok(notified.length > 0 && notified.every((id) => id === 'chat-1'), JSON.stringify(notified));
  assert.equal(holder.projectForPid(4242), 'p1');
  assert.equal(holder.projectForPid(7), '');
  assert.equal(holder.projectForPid('4242'), '');
  clock = 5000;
  await call(ipc, 'runView.stop', { projectId: 'p1', mode: 'force' });
  await new Promise((resolve) => setImmediate(resolve));
  const [after] = holder.runsForChat('chat-1');
  assert.ok(['closed', 'ended_early', 'idle'].includes(after.state) || after.state === 'stopping', after.state);
  notified.length = 0;
  await holder.onProjectDeleted('p1');
  assert.deepEqual(holder.runsForChat('chat-1'), [], 'a deleted project is forgotten');
  assert.deepEqual(notified, ['chat-1'], 'and its chat refetches once');
  await holder.shutdown();
});

test('R3 seams: a chat workspace that throws never blocks a push, and the row still reads', () => {
  const pushed = [];
  const log = [];
  const holder = createLazyRunView({
    userDataPath: 'x', sendBridgeEvent: (method) => pushed.push(method), now: () => 77,
    getBackendService: () => { throw new Error('not ready'); },
    modules: fakeModules(log),
  });
  holder.get();
  log.options.emit('run-view:state', { projectId: 'p1', state: 'building', generation: 1, chatId: 'chat-1', exitCode: null });
  assert.deepEqual(pushed, ['runView.onState']);
  assert.deepEqual(holder.runsForChat('chat-1').map((row) => [row.state, row.label, row.startedAtMs]), [['building', '', 77]]);
  log.options.emit('run-view:state', { projectId: 'p1', state: 'build_failed', generation: 1, chatId: 'chat-1', exitCode: 2 });
  const [failed] = holder.runsForChat('chat-1');
  assert.equal(failed.endedAtMs, 77);
  assert.equal(failed.exitCode, 2);
  assert.deepEqual(holder.runsForChat(''), []);
});
