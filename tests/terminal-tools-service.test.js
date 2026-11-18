'use strict';

// Row 94 P4: the port behind the Jenny chat's `terminal_read` and `terminal_run` tools. A fake pty service and fake
// ports stand in for the IDE: no pty, no Electron.
const test = require('node:test');
const assert = require('node:assert/strict');
const { LIMITS, createTerminalToolsService } = require('../services/terminal-tools-service');

const PRIMARY = 'p1';
const PROJECT_CHAT = 'c1';
const SECRET = 'sk-proj-secretsecretsecretsecret';
const PROJECT = { project_id: 'pr1', root_path: 'G:\\work\\pr1' };
const DOWNLOADS = 'C:\\Users\\me\\Downloads';

function harness(overrides = {}) {
  const sent = [];
  const tails = [];
  const timers = [];
  const cleared = [];
  const clock = { at: 1_000_000 };
  const state = { renderer: true, hostMode: 'desktop', flags: {}, root: 'G:\\work\\pr1', current: true, start: DOWNLOADS };
  const pty = overrides.pty === undefined ? {
    readTail(request) {
      tails.push(request);
      return { ok: true, slot: request.slot ?? 1, lines: ['one', 'two'], truncated: false, last_output_at: 1_700_000_000_000 };
    },
    liveTerminals: () => [{ slot: 1, session_id: 'pty-1' }, { slot: 2, session_id: 'pty-2' }],
  } : overrides.pty;
  const service = createTerminalToolsService({
    ptyService: () => pty,
    featureFlags: () => state.flags,
    primarySessionId: () => PRIMARY,
    hostMode: () => state.hostMode,
    workspaceRoot: () => state.root,
    startFolder: () => (state.start ? { ok: true, folder: state.start, source: 'downloads' } : { ok: false, reason: 'start_folder_unavailable' }),
    sessionSummary: () => (id) => (id === PROJECT_CHAT ? { project_id: overrides.projectId === undefined ? 'pr1' : overrides.projectId } : null),
    projectService: () => ({ get: (id) => (id === 'pr1' ? (overrides.project === undefined ? PROJECT : overrides.project) : null) }),
    projectApplicationService: () => ({
      isCurrentProject: async () => {
        if (overrides.currentThrows) throw new Error('boom');
        return state.current;
      },
    }),
    sendBridgeEvent: (channel, payload) => {
      if (overrides.sendThrows) throw new Error('C:\\private\\bridge');
      sent.push([channel, payload]);
    },
    isRendererAvailable: () => state.renderer,
    now: () => clock.at,
    setTimer: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearTimer: (timer) => { cleared.push(timer); },
  });
  return { service, state, sent, tails, timers, cleared, clock };
}

const prep = (service, command = 'npm test', callId = 'call-1', session = PRIMARY) => service.prepareRun({ session_id: session, tool_call_id: callId, command });
const runArgs = (command = 'npm test', callId = 'call-1', session = PRIMARY) => ({ caller_session_id: session, tool_call_id: callId, command });
// `run` awaits its gate before it pushes, so a test reads the push only after the gate has settled.
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the primary chat reads: slot and line count pass through, last_output_at becomes an ISO string', async () => {
  const h = harness();
  const answer = await h.service.readTerminal({ session_id: PRIMARY, terminal: 3, lines: 10 });
  assert.deepEqual(answer, { ok: true, terminal: 3, lines: ['one', 'two'], truncated: false, last_output_at: new Date(1_700_000_000_000).toISOString() });
  assert.deepEqual(h.tails, [{ slot: 3, lines: 10 }]);
  await h.service.readTerminal({ session_id: PRIMARY });
  assert.deepEqual(h.tails.at(-1), { slot: null, lines: 80 }, 'defaults: any live terminal, 80 lines');
});

test('a project chat reads only while its project is the IDE\'s current one', async () => {
  const open = harness();
  assert.equal((await open.service.readTerminal({ session_id: PROJECT_CHAT })).ok, true);

  const closed = harness();
  closed.state.current = false;
  assert.deepEqual(await closed.service.readTerminal({ session_id: PROJECT_CHAT }), { ok: false, reason: 'not_in_project' });

  assert.deepEqual(await harness({ projectId: null }).service.readTerminal({ session_id: PROJECT_CHAT }), { ok: false, reason: 'not_in_project' });
  assert.deepEqual(await harness({ project: { project_id: 'pr1', root_path: '' } }).service.readTerminal({ session_id: PROJECT_CHAT }), { ok: false, reason: 'not_in_project' });
  assert.deepEqual(await harness({ project: null }).service.readTerminal({ session_id: PROJECT_CHAT }), { ok: false, reason: 'not_in_project' });
  assert.deepEqual(await harness({ currentThrows: true }).service.readTerminal({ session_id: PROJECT_CHAT }), { ok: false, reason: 'not_in_project' });
  assert.deepEqual(await harness().service.readTerminal({ session_id: 'unknown-chat' }), { ok: false, reason: 'not_in_project' });
});

test('a refused project chat never touches the pty tail', async () => {
  const h = harness();
  h.state.current = false;
  await h.service.readTerminal({ session_id: PROJECT_CHAT });
  assert.deepEqual(h.tails, []);
});

test('the kill switch and server host mode disable both operations', async () => {
  const off = harness();
  off.state.flags = { terminal_tools: false };
  assert.deepEqual(await off.service.readTerminal({ session_id: PRIMARY }), { ok: false, reason: 'disabled' });
  assert.deepEqual(await prep(off.service), { ok: false, reason: 'disabled' });
  assert.deepEqual(await off.service.run(runArgs()), { ok: false, reason: 'disabled' });

  const server = harness();
  server.state.hostMode = 'server';
  assert.deepEqual(await server.service.readTerminal({ session_id: PRIMARY }), { ok: false, reason: 'disabled' });
  assert.deepEqual(await prep(server.service), { ok: false, reason: 'disabled' });
  assert.deepEqual(server.tails, []);
});

test('read: pty refusals map to stable reasons; a missing pty service is unavailable; no caller is not_allowed', async () => {
  const none = harness({ pty: { readTail: () => ({ ok: false, reason: 'no_terminal' }) } });
  assert.deepEqual(await none.service.readTerminal({ session_id: PRIMARY, terminal: 4 }), { ok: false, reason: 'no_terminal' });
  const invalid = harness({ pty: { readTail: () => ({ ok: false, reason: 'invalid_input' }) } });
  assert.deepEqual(await invalid.service.readTerminal({ session_id: PRIMARY }), { ok: false, reason: 'invalid_input' });
  const other = harness({ pty: { readTail: () => ({ ok: false, reason: 'weird' }) } });
  assert.deepEqual(await other.service.readTerminal({ session_id: PRIMARY }), { ok: false, reason: 'no_terminal' });
  assert.deepEqual(await harness({ pty: null }).service.readTerminal({ session_id: PRIMARY }), { ok: false, reason: 'unavailable' });
  assert.deepEqual(await harness().service.readTerminal({}), { ok: false, reason: 'not_allowed' });
});

test('read: secret-looking values in terminal lines are redacted', async () => {
  const h = harness({ pty: { readTail: () => ({ ok: true, slot: 1, lines: [`export OPENAI_API_KEY=${SECRET}`, `token ${SECRET} end`, 'plain'] }) } });
  const answer = await h.service.readTerminal({ session_id: PRIMARY });
  assert.equal(answer.ok, true);
  assert.equal(answer.lines.join('\n').includes(SECRET), false);
  assert.equal(answer.lines[2], 'plain');
  assert.equal(answer.last_output_at, null, 'no timestamp from the pty: null, not a made-up date');
});

test('read: env-style secret assignments are redacted (printenv, cat .env)', async () => {
  const values = ['hunter2hunter2', 'abcd1234efgh5678', 'abcdef1234567890', 'wJalrXUtnFEMI/K7MDENG', 'sk_live_51Hxyz'];
  const lines = [`DB_PASSWORD=${values[0]}`, `OPENAI_API_KEY=${values[1]}`, `NPM_TOKEN=${values[2]}`,
    `AWS_SECRET_ACCESS_KEY=${values[3]}`, `STRIPE_SECRET_KEY: ${values[4]}`, 'PATH=C:\\bin'];
  const h = harness({ pty: { readTail: () => ({ ok: true, slot: 1, lines }) } });
  const text = (await h.service.readTerminal({ session_id: PRIMARY })).lines.join('\n');
  for (const value of values) assert.equal(text.includes(value), false, value);
  assert.match(text, /PATH=C:\\bin/, 'a non-secret name stays readable');
});

test('read: a newest line longer than the whole budget keeps its end instead of reading as empty', async () => {
  const long = `${'x'.repeat(LIMITS.read_chars * 2)}END`;
  const h = harness({ pty: { readTail: () => ({ ok: true, slot: 1, lines: ['older', long] }) } });
  const answer = await h.service.readTerminal({ session_id: PRIMARY });
  assert.equal(answer.truncated, true);
  assert.equal(answer.lines.length, 1);
  assert.ok(answer.lines[0].endsWith('END'));
  assert.ok(answer.lines[0].length < LIMITS.read_chars);
});

test('read: output over the character budget keeps the newest lines and says truncated', async () => {
  const lines = ['a', 'b', 'c', 'd', 'e'].map((letter) => letter.repeat(5000));
  const h = harness({ pty: { readTail: () => ({ ok: true, slot: 1, lines, truncated: false }) } });
  const answer = await h.service.readTerminal({ session_id: PRIMARY });
  assert.equal(answer.truncated, true);
  assert.deepEqual(answer.lines, lines.slice(-3));
  assert.ok(answer.lines.join('\n').length <= LIMITS.read_chars);
  const small = harness({ pty: { readTail: () => ({ ok: true, slot: 1, lines: ['x'], truncated: true }) } });
  assert.equal((await small.service.readTerminal({ session_id: PRIMARY })).truncated, true, 'the pty\'s own truncation passes through');
});

test('prepareRun: the primary chat or a project chat; one plain command line; the start folder by default', async () => {
  const h = harness();
  assert.deepEqual(await prep(h.service, 'npm test', 'call-1', 'unknown-chat'), { ok: false, reason: 'not_allowed' });
  assert.deepEqual(await prep(h.service, 'npm test', 'call-1', ''), { ok: false, reason: 'not_allowed' });
  const bad = ['a\nb', 'a\rb', 'a\tb', 'a\u202Eb', 'a\u200Bb', 'a\u2028b', '', '   ', 'x'.repeat(2001), 42, null];
  for (const command of bad) {
    assert.deepEqual(await prep(h.service, command), { ok: false, reason: 'invalid_command' }, JSON.stringify(command));
  }
  assert.deepEqual(await h.service.prepareRun({ session_id: PRIMARY, tool_call_id: 'call-1' }), { ok: false, reason: 'invalid_command' }, 'no command at all');
  assert.deepEqual(await prep(h.service, 'x'.repeat(2000)), { ok: true, folder: DOWNLOADS, where: 'start_folder' }, 'exactly the limit is fine');
  assert.deepEqual(await prep(h.service, 'npm test'), { ok: true, folder: DOWNLOADS, where: 'start_folder' }, 'the card names the start folder');
  assert.deepEqual(await prep(h.service, 'npm test', ''), { ok: false, reason: 'unavailable' });
  // 2026-11-17: the Jenny chat needs no project; `where: project` asks for the IDE's project.
  const asProject = (callId) => h.service.prepareRun({ session_id: PRIMARY, tool_call_id: callId, command: 'npm test', where: 'project' });
  h.state.root = '  ';
  assert.deepEqual(await prep(h.service), { ok: true, folder: DOWNLOADS, where: 'start_folder' }, 'no project open: still runs');
  assert.deepEqual(await asProject('call-p'), { ok: false, reason: 'project_not_open' });
  h.state.root = 'G:\\work\\pr1';
  assert.deepEqual(await asProject('call-p'), { ok: true, folder: 'G:\\work\\pr1', where: 'project' });
  assert.deepEqual(await h.service.prepareRun({ session_id: PRIMARY, tool_call_id: 'call-q', command: 'npm test', where: 'elsewhere' }),
    { ok: false, reason: 'invalid_input' }, 'an unknown where is refused before a card, never the start folder');
  h.state.start = null;
  assert.deepEqual(await prep(h.service), { ok: false, reason: 'start_folder_unavailable' });
});

// 2026-11-17 (row 178, owner decision D4): a project chat runs terminal_run on its own project only, always carded.
const projectRun = (command = 'npm test', callId = 'call-1', where) => ({ session_id: PROJECT_CHAT, tool_call_id: callId, command, ...(where === undefined ? {} : { where }) });
const projectRunArgs = (command = 'npm test', callId = 'call-1') => ({ caller_session_id: PROJECT_CHAT, tool_call_id: callId, command });

test('a project chat on the open project gets its project folder from prepareRun, with or without where', async () => {
  const h = harness();
  assert.deepEqual(await h.service.prepareRun(projectRun()), { ok: true, folder: 'G:\\work\\pr1', where: 'project' });
  assert.deepEqual(await h.service.prepareRun(projectRun('npm test', 'call-2', 'project')), { ok: true, folder: 'G:\\work\\pr1', where: 'project' });
  assert.deepEqual(await h.service.prepareRun(projectRun('a\nb', 'call-3')), { ok: false, reason: 'invalid_command' });
  assert.deepEqual(await h.service.prepareRun(projectRun('npm test', 'call-4', 'elsewhere')), { ok: false, reason: 'invalid_input' });
  h.state.root = '';
  assert.deepEqual(await h.service.prepareRun(projectRun('npm test', 'call-5')), { ok: false, reason: 'project_not_open' });
});

test('a project chat on another project, or whose project cannot be read, is not_in_project before any card', async () => {
  const other = harness();
  other.state.current = false;
  assert.deepEqual(await other.service.prepareRun(projectRun()), { ok: false, reason: 'not_in_project' });
  assert.deepEqual(await harness({ currentThrows: true }).service.prepareRun(projectRun()), { ok: false, reason: 'not_in_project' });
  assert.deepEqual(await harness({ project: null }).service.prepareRun(projectRun()), { ok: false, reason: 'not_in_project' });
  assert.deepEqual(await harness({ project: { project_id: 'pr1', root_path: '' } }).service.prepareRun(projectRun()), { ok: false, reason: 'not_in_project' });
  assert.deepEqual(await other.service.run(projectRunArgs()), { ok: false, reason: 'not_in_project' });
  assert.deepEqual(other.sent, []);
});

test('a chat without a project is not_allowed, and the kill switch still wins', async () => {
  const none = harness({ projectId: null });
  assert.deepEqual(await none.service.prepareRun(projectRun()), { ok: false, reason: 'not_allowed' });
  assert.deepEqual(await none.service.run(projectRunArgs()), { ok: false, reason: 'not_allowed' });
  assert.deepEqual(await harness().service.prepareRun({ ...projectRun(), session_id: 'unknown-chat' }), { ok: false, reason: 'not_allowed' });
  // The General bucket is no project: never offered a run in the IDE's folder.
  assert.deepEqual(await harness({ projectId: 'project_general' }).service.prepareRun(projectRun()), { ok: false, reason: 'not_allowed' });
  assert.deepEqual(await harness().service.prepareRun({ ...projectRun(), session_id: '' }), { ok: false, reason: 'not_allowed' });
  const off = harness();
  off.state.flags = { terminal_tools: false };
  assert.deepEqual(await off.service.prepareRun(projectRun()), { ok: false, reason: 'disabled' });
});

test('a project chat that asks for the start folder is refused before the card', async () => {
  const h = harness();
  assert.deepEqual(await h.service.prepareRun(projectRun('npm test', 'call-1', 'start_folder')), { ok: false, reason: 'project_chat_runs_in_project' });
  assert.deepEqual(await h.service.run({ ...projectRunArgs(), where: 'start_folder' }), { ok: false, reason: 'not_allowed' }, 'no card was made for it');
  assert.deepEqual(h.sent, []);
});

test('a project chat run sends one push with no place, and resolves with the terminal slot', async () => {
  const h = harness();
  await h.service.prepareRun(projectRun());
  const pending = h.service.run(projectRunArgs());
  await settle();
  assert.equal(h.sent.length, 1);
  assert.deepEqual(Object.keys(h.sent[0][1]).sort(), ['command', 'request_id']);
  h.service.recordRun({ request_id: h.sent[0][1].request_id, ok: true, session_id: 'pty-2' });
  assert.deepEqual(await pending, { ok: true, terminal: 2 });
});

test('a project switch between the card and the run is not_in_project and sends nothing', async () => {
  const h = harness();
  assert.equal((await h.service.prepareRun(projectRun())).ok, true);
  h.state.current = false;
  assert.deepEqual(await h.service.run(projectRunArgs()), { ok: false, reason: 'not_in_project' });
  assert.deepEqual(h.sent, []);
  // The folder the card named still gates the run when the project is the open one but the root moved.
  const moved = harness();
  await moved.service.prepareRun(projectRun());
  moved.state.root = 'G:\\work\\elsewhere';
  assert.deepEqual(await moved.service.run(projectRunArgs()), { ok: false, reason: 'folder_changed' });
});

test('the Jenny chat is unchanged: the start folder by default, project on request, never gated by the open project', async () => {
  const h = harness();
  h.state.current = false;
  assert.deepEqual(await prep(h.service), { ok: true, folder: DOWNLOADS, where: 'start_folder' });
  assert.deepEqual(await h.service.prepareRun({ session_id: PRIMARY, tool_call_id: 'call-p', command: 'npm test', where: 'project' }),
    { ok: true, folder: 'G:\\work\\pr1', where: 'project' });
});

test('a run must keep the card\'s place; a project run sends no place, a start-folder run only the closed word', async () => {
  const h = harness();
  await h.service.prepareRun({ session_id: PRIMARY, tool_call_id: 'call-p', command: 'npm test', where: 'project' });
  assert.deepEqual(await h.service.run(runArgs('npm test', 'call-p')), { ok: false, reason: 'not_allowed' }, 'place changed after the card');
  assert.deepEqual(h.sent, []);
  await h.service.prepareRun({ session_id: PRIMARY, tool_call_id: 'call-q', command: 'npm test', where: 'project' });
  const pending = h.service.run({ ...runArgs('npm test', 'call-q'), where: 'project' });
  await settle();
  assert.deepEqual(Object.keys(h.sent[0][1]).sort(), ['command', 'request_id']);
  h.service.recordRun({ request_id: h.sent[0][1].request_id, ok: true, session_id: 'pty-1' });
  assert.deepEqual(await pending, { ok: true, terminal: 1 });
});

test('run without a card, with another command, twice, or after the card expired is not_allowed and sends nothing', async () => {
  const h = harness();
  assert.deepEqual(await h.service.run(runArgs()), { ok: false, reason: 'not_allowed' });

  await prep(h.service, 'npm test', 'call-2');
  assert.deepEqual(await h.service.run(runArgs('npm publish', 'call-2')), { ok: false, reason: 'not_allowed' });
  // The mismatch spent the card: the right command cannot ride on it afterwards.
  assert.deepEqual(await h.service.run(runArgs('npm test', 'call-2')), { ok: false, reason: 'not_allowed' });

  await prep(h.service, 'npm test', 'call-3');
  assert.deepEqual(await h.service.run(runArgs('npm test', 'call-3', PROJECT_CHAT)), { ok: false, reason: 'not_allowed' });

  await prep(h.service, 'npm test', 'call-4');
  h.clock.at += 4 * 60 * 60 * 1000 + 10 * 60 * 1000 + 1; // past the longest (unattended-pause) approval wait
  assert.deepEqual(await h.service.run(runArgs('npm test', 'call-4')), { ok: false, reason: 'not_allowed' });
  assert.deepEqual(h.sent, []);
});

test('a second run on the same call is not_allowed (one card, one run)', async () => {
  const h = harness();
  await prep(h.service);
  const first = h.service.run(runArgs());
  await settle();
  const [channel, payload] = h.sent[0];
  h.service.recordRun({ request_id: payload.request_id, ok: true, session_id: 'pty-1' });
  assert.deepEqual(await first, { ok: true, terminal: 1 });
  assert.equal(channel, 'terminalTools.onRunRequest');
  assert.deepEqual(await h.service.run(runArgs()), { ok: false, reason: 'not_allowed' });
  assert.equal(h.sent.length, 1);
});

test('run: the renderer going, the project closing, or the start folder going or changing after the card refuses without a push', async () => {
  const gone = harness();
  await prep(gone.service);
  gone.state.renderer = false;
  assert.deepEqual(await gone.service.run(runArgs()), { ok: false, reason: 'unavailable' });
  assert.deepEqual(gone.sent, []);

  const closed = harness();
  await closed.service.prepareRun({ session_id: PRIMARY, tool_call_id: 'call-1', command: 'npm test', where: 'project' });
  closed.state.root = '';
  assert.deepEqual(await closed.service.run({ ...runArgs(), where: 'project' }), { ok: false, reason: 'project_not_open' });
  assert.deepEqual(closed.sent, []);

  const gone2 = harness();
  await prep(gone2.service);
  gone2.state.start = null;
  assert.deepEqual(await gone2.service.run(runArgs()), { ok: false, reason: 'start_folder_unavailable' });
  assert.deepEqual(gone2.sent, []);

  // The card named one folder; the run never starts in another (a changed setting, a removed folder's fallback).
  const moved = harness();
  await prep(moved.service);
  moved.state.start = 'D:\\Installs';
  assert.deepEqual(await moved.service.run(runArgs()), { ok: false, reason: 'folder_changed' });
  assert.deepEqual(moved.sent, []);
  assert.deepEqual(await moved.service.run(runArgs()), { ok: false, reason: 'not_allowed' }, 'the card is spent');
});

test('happy path: one push to the main window, the renderer\'s report resolves with the terminal slot', async () => {
  const h = harness();
  await prep(h.service, 'npm test');
  const pending = h.service.run(runArgs('npm test'));
  await settle();
  assert.equal(h.sent.length, 1);
  const [channel, payload] = h.sent[0];
  assert.equal(channel, 'terminalTools.onRunRequest');
  assert.deepEqual(Object.keys(payload).sort(), ['command', 'place', 'request_id']);
  assert.equal(payload.place, 'start_folder', 'the closed word, never the path');
  assert.equal(payload.command, 'npm test');
  assert.match(payload.request_id, /^trm-[a-z0-9]+-\d+$/);
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, 30_000);

  assert.deepEqual(h.service.recordRun({ request_id: payload.request_id, ok: true, session_id: 'pty-2' }), { ok: true });
  assert.deepEqual(await pending, { ok: true, terminal: 2 });
  assert.deepEqual(h.cleared, [h.timers[0]], 'the timeout timer is cleared');
  assert.deepEqual(h.service.recordRun({ request_id: payload.request_id, ok: true, session_id: 'pty-2' }), { ok: false, reason: 'unknown_request' }, 'a report is single use');
});

test('a success whose pty session is no longer live still resolves, with a null terminal', async () => {
  const h = harness();
  await prep(h.service);
  const pending = h.service.run(runArgs());
  await settle();
  h.service.recordRun({ request_id: h.sent[0][1].request_id, ok: true, session_id: 'pty-gone' });
  assert.deepEqual(await pending, { ok: true, terminal: null });
});

test('the renderer\'s refusal reason passes through; an unknown reason is start_failed', async () => {
  for (const [reported, expected] of [['no_free_terminal', 'no_free_terminal'], ['send_failed', 'send_failed'], ['no_ide', 'no_ide'],
    ['root_missing', 'root_missing'], ['start_folder_unavailable', 'start_folder_unavailable'], ['start_failed', 'start_failed'], ['C:\\private\\path', 'start_failed'], [undefined, 'start_failed']]) {
    const h = harness();
    await prep(h.service);
    const pending = h.service.run(runArgs());
    await settle();
    h.service.recordRun({ request_id: h.sent[0][1].request_id, ok: false, reason: reported });
    assert.deepEqual(await pending, { ok: false, reason: expected }, String(reported));
  }
  // ok:true without a session id is not a success.
  const h = harness();
  await prep(h.service);
  const pending = h.service.run(runArgs());
  await settle();
  h.service.recordRun({ request_id: h.sent[0][1].request_id, ok: true });
  assert.deepEqual(await pending, { ok: false, reason: 'start_failed' });
});

test('no report in time resolves unconfirmed, and a late report is unknown', async () => {
  const h = harness();
  await prep(h.service);
  const pending = h.service.run(runArgs());
  await settle();
  const requestId = h.sent[0][1].request_id;
  h.timers[0].fn();
  assert.deepEqual(await pending, { ok: false, reason: 'unconfirmed' });
  assert.deepEqual(h.service.recordRun({ request_id: requestId, ok: true, session_id: 'pty-1' }), { ok: false, reason: 'unknown_request' });
});

test('a bridge push that throws is unavailable, leaks nothing, and leaves no pending request', async () => {
  const h = harness({ sendThrows: true });
  await prep(h.service);
  const answer = await h.service.run(runArgs());
  assert.deepEqual(answer, { ok: false, reason: 'unavailable' });
  assert.equal(JSON.stringify(answer).includes('private'), false);
  assert.equal(h.cleared.length, 1, 'the timeout timer is cleared');
  assert.deepEqual(h.service.recordRun({ request_id: 'trm-x-1', ok: true, session_id: 'pty-1' }), { ok: false, reason: 'unknown_request' });
});

test('recordRun rejects unknown and malformed request ids', () => {
  const h = harness();
  for (const payload of [undefined, null, {}, { request_id: 7 }, { request_id: 'nope' }, { request_id: 'trm-abc-1' },
    { request_id: 'trm-ABC-1' }, { request_id: 'trm-abc-1; drop' }]) {
    assert.deepEqual(h.service.recordRun(payload), { ok: false, reason: 'unknown_request' }, JSON.stringify(payload));
  }
});

test('only the newest 16 pending requests stay tracked; the oldest resolves unconfirmed', async () => {
  const h = harness();
  const pendings = [];
  for (let index = 0; index < LIMITS.tracked_max + 1; index += 1) {
    await prep(h.service, `echo ${index}`, `call-${index}`);
    pendings.push(h.service.run(runArgs(`echo ${index}`, `call-${index}`)));
    await settle();
  }
  assert.deepEqual(await pendings[0], { ok: false, reason: 'unconfirmed' });
  assert.deepEqual(h.service.recordRun({ request_id: h.sent[0][1].request_id, ok: true, session_id: 'pty-1' }), { ok: false, reason: 'unknown_request' });
  h.service.recordRun({ request_id: h.sent.at(-1)[1].request_id, ok: true, session_id: 'pty-1' });
  assert.deepEqual(await pendings.at(-1), { ok: true, terminal: 1 });
});

// 2026-11-17: the start folder itself (services/terminal-start-folder.js). A fake fs stands in for the disk.
const { cleanTerminalStartFolder, resolveTerminalStartFolder, terminalStartFolderPreference } = require('../services/terminal-start-folder');

test('the start folder setting keeps only a bounded local absolute path', () => {
  const abs = process.platform === 'win32' ? 'D:\\Installs' : '/home/me/dl';
  assert.equal(cleanTerminalStartFolder(` ${abs} `), abs);
  for (const bad of ['relative', '', '   ', '\\\\server\\share', '//server/share', `${abs}\0x`, `${abs}${'x'.repeat(513)}`, 7, null]) {
    assert.equal(cleanTerminalStartFolder(bad), '', JSON.stringify(bad));
  }
  assert.equal(terminalStartFolderPreference({ getState: () => ({ workspaceIde: { preferences: { terminalStartFolder: abs } } }) }), abs);
  assert.equal(terminalStartFolderPreference({ getState: () => { throw new Error('boom'); } }), '');
  assert.equal(terminalStartFolderPreference(null), '');
});

test('resolve: the chosen folder, else Downloads, else unavailable; a file or a missing folder never counts', () => {
  const chosen = process.platform === 'win32' ? 'D:\\Installs' : '/srv/installs';
  const downloads = process.platform === 'win32' ? 'C:\\Users\\me\\Downloads' : '/home/me/Downloads';
  const disk = new Map([[chosen, 'dir'], [downloads, 'dir']]);
  const fsImpl = {
    realpathSync: (p) => { if (!disk.has(p)) throw new Error(`ENOENT ${p}`); return p; },
    statSync: (p) => ({ isDirectory: () => disk.get(p) === 'dir' }),
  };
  const resolve = (preference) => resolveTerminalStartFolder({ preference: () => preference, downloadsDir: () => downloads, fsImpl });
  assert.deepEqual(resolve(chosen), { ok: true, folder: chosen, source: 'setting' });
  assert.deepEqual(resolve(''), { ok: true, folder: downloads, source: 'downloads' });
  disk.set(chosen, 'file');
  assert.deepEqual(resolve(chosen), { ok: true, folder: downloads, source: 'downloads' }, 'a file is not a folder');
  disk.delete(chosen);
  assert.deepEqual(resolve(chosen), { ok: true, folder: downloads, source: 'downloads' }, 'a removed folder falls back');
  disk.delete(downloads);
  assert.deepEqual(resolve(''), { ok: false, reason: 'start_folder_unavailable' });
  assert.deepEqual(resolveTerminalStartFolder({ preference: () => { throw new Error('x'); }, downloadsDir: () => { throw new Error('y'); }, fsImpl }),
    { ok: false, reason: 'start_folder_unavailable' });
});
