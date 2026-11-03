'use strict';

// Row 94 P4: the renderer half of `terminal_run` (createTerminalRunHandler in renderer-app-view-controller.js).
// Main pushes the command only after the user approved it; the handler runs it in the IDE and reports back.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTerminalRunHandler } = require('../renderer/shell/renderer-app-view-controller');

const settle = () => new Promise((resolve) => setImmediate(resolve));

function harness({ answer = { ok: true, session_id: 'pty-2' }, runInTerminal, bridge } = {}) {
  const reports = [];
  const ran = [];
  const logs = [];
  let push = null;
  let unsubscribed = 0;
  const fakeBridge = bridge === undefined ? {
    onRunRequest: (fn) => { push = fn; return () => { push = null; unsubscribed += 1; }; },
    reportRun: (payload) => { reports.push(payload); return Promise.resolve({ ok: true }); },
  } : bridge;
  const handler = createTerminalRunHandler({
    getBridge: () => fakeBridge,
    runInTerminal: runInTerminal || (async (command) => { ran.push(command); return typeof answer === 'function' ? answer(command) : answer; }),
    appendClientLog: (...args) => logs.push(args),
  });
  return { handler, reports, ran, logs, send: (payload) => push && push(payload), subscribed: () => push !== null, unsubscribed: () => unsubscribed };
}

test('it subscribes through the bridge; a valid push runs the command and reports the terminal session', async () => {
  const h = harness();
  assert.equal(h.subscribed(), true);
  await h.send({ request_id: 'trm-abc-1', command: 'npm test' });
  assert.deepEqual(h.ran, ['npm test']);
  assert.deepEqual(h.reports, [{ request_id: 'trm-abc-1', ok: true, session_id: 'pty-2' }]);
});

test('a refusal answer reports its reason; an unknown reason, false or a throw reports no_ide', async () => {
  for (const [answer, reason] of [[{ ok: false, reason: 'no_free_terminal' }, 'no_free_terminal'], [{ ok: false, reason: 'start_failed' }, 'start_failed'],
    [{ ok: false, reason: 'send_failed' }, 'send_failed'], [{ ok: false, reason: 'C:\\private' }, 'no_ide'], [{ ok: false }, 'no_ide'],
    [false, 'no_ide'], [null, 'no_ide'], [{ ok: true }, 'no_ide'], [{ ok: true, session_id: 'bad id!' }, 'no_ide']]) {
    const h = harness({ answer });
    await h.send({ request_id: 'trm-abc-1', command: 'npm test' });
    assert.deepEqual(h.reports, [{ request_id: 'trm-abc-1', ok: false, reason }], JSON.stringify(answer));
  }
  const throwing = harness({ runInTerminal: async () => { throw new Error('C:\\private\\boom'); } });
  await throwing.send({ request_id: 'trm-abc-2', command: 'npm test' });
  assert.deepEqual(throwing.reports, [{ request_id: 'trm-abc-2', ok: false, reason: 'no_ide' }]);
  assert.equal(JSON.stringify(throwing.logs).includes('private'), false);
});

test('a refusal is logged with its reason only', async () => {
  const h = harness({ answer: { ok: false, reason: 'no_free_terminal' } });
  await h.send({ request_id: 'trm-abc-1', command: 'npm test' });
  assert.deepEqual(h.logs, [['WARN', 'terminal_run.refused', { reason: 'no_free_terminal' }]]);
});

test('a malformed request id, an empty or over-long command never reaches the terminal', async () => {
  const h = harness();
  const bad = [undefined, null, 'x', {}, { command: 'npm test' }, { request_id: '', command: 'npm test' }, { request_id: 'bad id!', command: 'npm test' },
    { request_id: 'trm-abc-1' }, { request_id: 'trm-abc-1', command: '' },
    { request_id: 'trm-abc-1', command: '   ' }, { request_id: 'trm-abc-1', command: 42 }, { request_id: 'trm-abc-1', command: 'x'.repeat(2001) }];
  for (const payload of bad) await h.send(payload);
  assert.deepEqual(h.ran, []);
  assert.deepEqual(h.reports, []);
  await h.send({ request_id: 'trm-abc-1', command: 'x'.repeat(2000) });
  assert.equal(h.ran.length, 1, 'exactly the limit still runs');
});

test('a bridge that rejects or throws on report does not break the handler', async () => {
  const rejecting = harness({ bridge: { onRunRequest: () => () => {}, reportRun: () => Promise.reject(new Error('gone')) } });
  await assert.doesNotReject(rejecting.handler.handleRunRequest({ request_id: 'trm-abc-1', command: 'ls' }));
  const throwing = harness({ bridge: { onRunRequest: () => () => {}, reportRun: () => { throw new Error('gone'); } } });
  await assert.doesNotReject(throwing.handler.handleRunRequest({ request_id: 'trm-abc-1', command: 'ls' }));
  await settle();
  assert.deepEqual(rejecting.ran, ['ls'], 'the command still ran before the failed report');
  assert.deepEqual(throwing.ran, ['ls']);
  const ranWithoutBridge = [];
  const none = createTerminalRunHandler({ getBridge: () => null, runInTerminal: async (command) => { ranWithoutBridge.push(command); return { ok: true, session_id: 'pty-1' }; } });
  await assert.doesNotReject(none.handleRunRequest({ request_id: 'trm-abc-1', command: 'ls' }));
  assert.deepEqual(ranWithoutBridge, ['ls']);
  none.dispose();
});

test('without a runInTerminal opener the answer is no_ide', async () => {
  const reports = [];
  const handler = createTerminalRunHandler({ getBridge: () => ({ onRunRequest: () => () => {}, reportRun: (p) => { reports.push(p); } }) });
  await handler.handleRunRequest({ request_id: 'trm-abc-1', command: 'ls' });
  assert.deepEqual(reports, [{ request_id: 'trm-abc-1', ok: false, reason: 'no_ide' }]);
});

test('dispose unsubscribes, once safely, and a throwing unsubscribe is swallowed', () => {
  const h = harness();
  h.handler.dispose();
  assert.equal(h.subscribed(), false);
  assert.equal(h.unsubscribed(), 1);
  const angry = createTerminalRunHandler({ getBridge: () => ({ onRunRequest: () => () => { throw new Error('x'); } }) });
  assert.doesNotThrow(() => angry.dispose());
});
