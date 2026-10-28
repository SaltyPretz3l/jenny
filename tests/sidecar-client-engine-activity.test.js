'use strict';

// SidecarClient.notifyEngineActivity — the shell half of the engine-liveness
// heartbeat (2026-07-11 CMP-LOOP-0015 RCA). Sibling of sidecar-client.test.js,
// which sits at the file-size ceiling.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { Readable, Writable } = require('stream');

const { SidecarClient } = require('../services/backend/sidecar-client');

function createMockProcess() {
  const stdout = new Readable({ read() {} });
  const stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  const proc = new EventEmitter();
  proc.stdout = stdout;
  proc.stdin = stdin;
  return proc;
}

test('notifyEngineActivity writes a fire-and-forget engine.activity notification', () => {
  const client = new SidecarClient();
  const proc = createMockProcess();
  const writes = [];
  proc.stdin.write = (chunk) => {
    writes.push(Buffer.from(chunk));
    return true;
  };
  client.attachProcess(proc);

  client.notifyEngineActivity();

  assert.equal(writes.length, 1);
  const payload = Buffer.concat(writes).toString('utf8');
  const body = JSON.parse(payload.slice(payload.indexOf('\r\n\r\n') + 4));
  assert.equal(body.method, 'engine.activity');
  assert.equal(body.id, undefined, 'a notification must carry no id (no response expected)');
  assert.deepEqual(body.params, {});

  // Batch4 transport off (older sidecar): the notification is suppressed —
  // the multiplexer is the only inbound router that understands it.
  client._setSidecarFeatureFlags({ multiplexer: false, chat_cancel: true });
  client.notifyEngineActivity();
  assert.equal(writes.length, 1, 'no engine.activity without the multiplexer transport');

  // Detached client: silent no-op, never a throw (heartbeats are best-effort).
  client._setSidecarFeatureFlags({ multiplexer: true, chat_cancel: true });
  client.detachProcess();
  client.notifyEngineActivity();
  assert.equal(writes.length, 1);
});

test('notifySessionRunModeUpdated writes the live session mode projection', () => {
  const client = new SidecarClient();
  const proc = createMockProcess();
  const writes = [];
  proc.stdin.write = (chunk) => {
    writes.push(Buffer.from(chunk));
    return true;
  };
  client.attachProcess(proc);

  client.notifySessionRunModeUpdated({
    sessionId: 'session-live-mode',
    approvalMode: 'auto_run',
    readOnly: false,
  });

  assert.equal(writes.length, 1);
  const payload = Buffer.concat(writes).toString('utf8');
  const body = JSON.parse(payload.slice(payload.indexOf('\r\n\r\n') + 4));
  assert.equal(body.method, 'session.run_mode_updated');
  assert.equal(body.id, undefined);
  assert.deepEqual(body.params, {
    session_id: 'session-live-mode',
    approval_mode: 'auto_run',
    read_only: false,
  });
});

test('notifySessionMailArrived writes the mid-turn rows for the live request and reports the hand-off', () => {
  const client = new SidecarClient();
  const proc = createMockProcess();
  const writes = [];
  proc.stdin.write = (chunk) => {
    writes.push(Buffer.from(chunk));
    return true;
  };
  client.attachProcess(proc);
  const rows = [{ role: 'context', kind: 'session_message', content: 'b', session_message: { message_id: 'm1' } }];

  assert.equal(client.notifySessionMailArrived({ sessionId: ' session-dst ', requestId: 'req-1', rows }), true);

  assert.equal(writes.length, 1);
  const payload = Buffer.concat(writes).toString('utf8');
  const body = JSON.parse(payload.slice(payload.indexOf('\r\n\r\n') + 4));
  assert.equal(body.method, 'session.mail_arrived');
  assert.equal(body.id, undefined, 'a notification: no response expected');
  assert.deepEqual(body.params, { session_id: 'session-dst', request_id: 'req-1', rows });

  for (const bad of [{ requestId: 'req-1', rows }, { sessionId: 's', rows }, { sessionId: 's', requestId: 'r', rows: [] },
    { sessionId: 's', requestId: 'r', rows: 'x' }]) {
    assert.equal(client.notifySessionMailArrived(bad), false, JSON.stringify(bad));
  }
  proc.stdin.write = () => { throw new Error('pipe closed'); };
  assert.equal(client.notifySessionMailArrived({ sessionId: 's', requestId: 'r', rows }), false, 'a throwing write is not a hand-off');
  client._setSidecarFeatureFlags({ multiplexer: false, chat_cancel: true });
  assert.equal(client.notifySessionMailArrived({ sessionId: 's', requestId: 'r', rows }), false, 'never without the multiplexer');
  client._setSidecarFeatureFlags({ multiplexer: true, chat_cancel: true });
  client.detachProcess();
  assert.equal(client.notifySessionMailArrived({ sessionId: 's', requestId: 'r', rows }), false);
  assert.equal(writes.length, 1);
});
