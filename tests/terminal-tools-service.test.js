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

function harness(overrides = {}) {
  const sent = [];
  const tails = [];
  const timers = [];
  const cleared = [];
  const clock = { at: 1_000_000 };
  const state = { renderer: true, hostMode: 'desktop', flags: {}, root: 'G:\\work\\pr1', current: true };
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
  assert.deepEqual(prep(off.service), { ok: false, reason: 'disabled' });
  assert.deepEqual(await off.service.run(runArgs()), { ok: false, reason: 'disabled' });

  const server = harness();
  server.state.hostMode = 'server';
  assert.deepEqual(await server.service.readTerminal({ session_id: PRIMARY }), { ok: false, reason: 'disabled' });
  assert.deepEqual(prep(server.service), { ok: false, reason: 'disabled' });
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

test('prepareRun: only the primary chat; one plain command line; a project must be open', () => {
  const h = harness();
  assert.deepEqual(prep(h.service, 'npm test', 'call-1', PROJECT_CHAT), { ok: false, reason: 'not_allowed' });
  assert.deepEqual(prep(h.service, 'npm test', 'call-1', ''), { ok: false, reason: 'not_allowed' });
  const bad = ['a\nb', 'a\rb', 'a\tb', 'a\u202Eb', 'a\u200Bb', 'a\u2028b', '', '   ', 'x'.repeat(2001), 42, null];
  for (const command of bad) {
    assert.deepEqual(prep(h.service, command), { ok: false, reason: 'invalid_command' }, JSON.stringify(command));
  }
  assert.deepEqual(h.service.prepareRun({ session_id: PRIMARY, tool_call_id: 'call-1' }), { ok: false, reason: 'invalid_command' }, 'no command at all');
  assert.deepEqual(prep(h.service, 'x'.repeat(2000)), { ok: true, folder: 'G:\\work\\pr1' }, 'exactly the limit is fine');
  assert.deepEqual(prep(h.service, 'npm test'), { ok: true, folder: 'G:\\work\\pr1' }, 'the card names the folder');
  assert.deepEqual(prep(h.service, 'npm test', ''), { ok: false, reason: 'unavailable' });
  h.state.root = '  ';
  assert.deepEqual(prep(h.service), { ok: false, reason: 'project_not_open' });
});

test('run without a card, with another command, twice, or after the card expired is not_allowed and sends nothing', async () => {
  const h = harness();
  assert.deepEqual(await h.service.run(runArgs()), { ok: false, reason: 'not_allowed' });

  prep(h.service, 'npm test', 'call-2');
  assert.deepEqual(await h.service.run(runArgs('npm publish', 'call-2')), { ok: false, reason: 'not_allowed' });
  // The mismatch spent the card: the right command cannot ride on it afterwards.
  assert.deepEqual(await h.service.run(runArgs('npm test', 'call-2')), { ok: false, reason: 'not_allowed' });

  prep(h.service, 'npm test', 'call-3');
  assert.deepEqual(await h.service.run(runArgs('npm test', 'call-3', PROJECT_CHAT)), { ok: false, reason: 'not_allowed' });

  prep(h.service, 'npm test', 'call-4');
  h.clock.at += 4 * 60 * 60 * 1000 + 10 * 60 * 1000 + 1; // past the longest (unattended-pause) approval wait
  assert.deepEqual(await h.service.run(runArgs('npm test', 'call-4')), { ok: false, reason: 'not_allowed' });
  assert.deepEqual(h.sent, []);
});

test('a second run on the same call is not_allowed (one card, one run)', async () => {
  const h = harness();
  prep(h.service);
  const first = h.service.run(runArgs());
  const [channel, payload] = h.sent[0];
  h.service.recordRun({ request_id: payload.request_id, ok: true, session_id: 'pty-1' });
  assert.deepEqual(await first, { ok: true, terminal: 1 });
  assert.equal(channel, 'terminalTools.onRunRequest');
  assert.deepEqual(await h.service.run(runArgs()), { ok: false, reason: 'not_allowed' });
  assert.equal(h.sent.length, 1);
});

test('run: the renderer being unavailable or the project closing after the card refuses without a push', async () => {
  const gone = harness();
  prep(gone.service);
  gone.state.renderer = false;
  assert.deepEqual(await gone.service.run(runArgs()), { ok: false, reason: 'unavailable' });
  assert.deepEqual(gone.sent, []);

  const closed = harness();
  prep(closed.service);
  closed.state.root = '';
  assert.deepEqual(await closed.service.run(runArgs()), { ok: false, reason: 'project_not_open' });
  assert.deepEqual(closed.sent, []);
});

test('happy path: one push to the main window, the renderer\'s report resolves with the terminal slot', async () => {
  const h = harness();
  prep(h.service, 'npm test');
  const pending = h.service.run(runArgs('npm test'));
  assert.equal(h.sent.length, 1);
  const [channel, payload] = h.sent[0];
  assert.equal(channel, 'terminalTools.onRunRequest');
  assert.deepEqual(Object.keys(payload).sort(), ['command', 'request_id']);
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
  prep(h.service);
  const pending = h.service.run(runArgs());
  h.service.recordRun({ request_id: h.sent[0][1].request_id, ok: true, session_id: 'pty-gone' });
  assert.deepEqual(await pending, { ok: true, terminal: null });
});

test('the renderer\'s refusal reason passes through; an unknown reason is start_failed', async () => {
  for (const [reported, expected] of [['no_free_terminal', 'no_free_terminal'], ['send_failed', 'send_failed'], ['no_ide', 'no_ide'],
    ['start_failed', 'start_failed'], ['C:\\private\\path', 'start_failed'], [undefined, 'start_failed']]) {
    const h = harness();
    prep(h.service);
    const pending = h.service.run(runArgs());
    h.service.recordRun({ request_id: h.sent[0][1].request_id, ok: false, reason: reported });
    assert.deepEqual(await pending, { ok: false, reason: expected }, String(reported));
  }
  // ok:true without a session id is not a success.
  const h = harness();
  prep(h.service);
  const pending = h.service.run(runArgs());
  h.service.recordRun({ request_id: h.sent[0][1].request_id, ok: true });
  assert.deepEqual(await pending, { ok: false, reason: 'start_failed' });
});

test('no report in time resolves unconfirmed, and a late report is unknown', async () => {
  const h = harness();
  prep(h.service);
  const pending = h.service.run(runArgs());
  const requestId = h.sent[0][1].request_id;
  h.timers[0].fn();
  assert.deepEqual(await pending, { ok: false, reason: 'unconfirmed' });
  assert.deepEqual(h.service.recordRun({ request_id: requestId, ok: true, session_id: 'pty-1' }), { ok: false, reason: 'unknown_request' });
});

test('a bridge push that throws is unavailable, leaks nothing, and leaves no pending request', async () => {
  const h = harness({ sendThrows: true });
  prep(h.service);
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
    prep(h.service, `echo ${index}`, `call-${index}`);
    pendings.push(h.service.run(runArgs(`echo ${index}`, `call-${index}`)));
  }
  assert.deepEqual(await pendings[0], { ok: false, reason: 'unconfirmed' });
  assert.deepEqual(h.service.recordRun({ request_id: h.sent[0][1].request_id, ok: true, session_id: 'pty-1' }), { ok: false, reason: 'unknown_request' });
  h.service.recordRun({ request_id: h.sent.at(-1)[1].request_id, ok: true, session_id: 'pty-1' });
  assert.deepEqual(await pendings.at(-1), { ok: true, terminal: 1 });
});
