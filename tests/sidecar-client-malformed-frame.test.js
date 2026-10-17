'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createSidecarClient } = require('../services/backend/managed-sidecar-lifecycle');

function createMockProcess() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stdin = new EventEmitter();
  proc.stdin.write = () => true;
  return proc;
}

function frame(body) {
  const bytes = Buffer.from(body, 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${bytes.length}\r\n\r\n`, 'utf8'), bytes]);
}

test('a malformed complete frame fails the managed transport promptly without echoing the body', async (t) => {
  const logs = [];
  const service = { _emitServiceLog: (level, event, fields) => logs.push({ level, event, fields }) };
  const client = createSidecarClient(service);
  t.after(() => client.dispose());
  const proc = createMockProcess();
  client.attachProcess(proc);

  const pending = client.request('workspace.undo', { change_set_id: 'cs-1' });
  const secretBody = '{"jsonrpc":"2.0","id":1,"result":{"note":"SECRET-BODY"';
  proc.stdout.emit('data', frame(secretBody));

  const outcome = await Promise.race([
    pending.then(() => 'resolved', (error) => error),
    new Promise((resolve) => setTimeout(() => resolve('still-pending'), 1000).unref()),
  ]);
  assert.ok(outcome instanceof Error, `the pending request must reject promptly, got ${outcome}`);
  assert.equal(outcome.category, 'transport');
  assert.equal(outcome.message, 'Sidecar transport received a malformed frame.');
  assert.equal(client.connected, false);
  const errorLog = logs.find((entry) => entry.event === 'sidecar.client_error');
  assert.ok(errorLog, 'the service logs the transport failure');
  assert.equal(errorLog.level, 'ERROR');
  assert.doesNotMatch(JSON.stringify(logs), /SECRET-BODY/);
});

test('a parse-error observer still sees the malformed frame and cannot keep the transport alive', async (t) => {
  const logs = [];
  const service = { _emitServiceLog: (level, event, fields) => logs.push({ level, event, fields }) };
  const client = createSidecarClient(service);
  t.after(() => client.dispose());
  const proc = createMockProcess();
  client.attachProcess(proc);
  const parseErrors = [];
  client.on('parse-error', (error) => parseErrors.push(error));

  const pending = client.request('workspace.undo', { change_set_id: 'cs-1' });
  proc.stdout.emit('data', frame('{"jsonrpc":"2.0","id":1,"result":{"note":"SECRET-BODY"'));

  const outcome = await Promise.race([
    pending.then(() => 'resolved', (error) => error),
    new Promise((resolve) => setTimeout(() => resolve('still-pending'), 1000).unref()),
  ]);
  assert.equal(parseErrors.length, 1);
  assert.ok(parseErrors[0] instanceof SyntaxError);
  assert.ok(outcome instanceof Error, `the pending request must reject promptly, got ${outcome}`);
  assert.equal(outcome.category, 'transport');
  assert.equal(outcome.message, 'Sidecar transport received a malformed frame.');
  assert.equal(client.connected, false);
  assert.equal(client.pendingRequests.size, 0);
  assert.ok(logs.some((entry) => entry.event === 'sidecar.client_error' && entry.level === 'ERROR'));
  assert.doesNotMatch(JSON.stringify(logs), /SECRET-BODY/);
});
