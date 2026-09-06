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
