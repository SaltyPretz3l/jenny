const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable, Writable } = require('node:stream');
const { SidecarClient } = require('../services/backend/sidecar-client');
function buildFrame(message) {
  const body = Buffer.from(JSON.stringify(message));
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}
function createMockProcess() {
  const proc = new EventEmitter();
  proc.stdout = new Readable({ read() {} });
  proc.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  return proc;
}


test('canonical notifications route by physical stream and reject conflicting request identity', async () => {
  const client = new SidecarClient();
  const proc = createMockProcess(); client.attachProcess(proc);
  const seen = { first: [], second: [] };
  const first = client.chatSend({ request_id: 'physical_1', messages: [] }, { onNotification: event => seen.first.push(event) });
  const second = client.chatSend({ request_id: 'physical_2', messages: [] }, { onNotification: event => seen.second.push(event) });
  const send = params => proc.stdout.push(buildFrame({ jsonrpc: '2.0', method: 'turn.event', params }));
  send({ stream_id: 'physical_1', turn_id: 'logical_turn', seq: 1 });
  send({ stream_id: 'physical_2', turn_id: 'logical_turn', seq: 2 });
  send({ stream_id: 'physical_2', request_id: 'physical_1', turn_id: 'logical_turn', seq: 3 });
  send({ turn_id: 'physical_1', seq: 4 });
  send({ stream_id: 'unknown', turn_id: 'physical_1', seq: 5 });
  send({ request_id: 'physical_1', seq: 6 });
  proc.stdout.push(buildFrame({ jsonrpc: '2.0', method: 'chat.token', params: { stream_id: 'physical_1', seq: 7 } }));
  proc.stdout.push(buildFrame({ jsonrpc: '2.0', id: 1, result: {} }));
  proc.stdout.push(buildFrame({ jsonrpc: '2.0', id: 2, result: {} }));
  await Promise.all([first, second]);
  assert.deepEqual(seen.first.map(event => event.params.seq), [1, 6]);
  assert.deepEqual(seen.second.map(event => event.params.seq), [2]);
  client.detachProcess();
});


test('canonical late notifications and handler failures retain physical request correlation', async () => {
  const logs = []; const late = []; const delivered = [];
  const client = new SidecarClient({ logger: (level, event, fields) => logs.push({ level, event, fields }) });
  const proc = createMockProcess(); client.attachProcess(proc);
  client.on('late-notification', event => late.push(event));
  const controller = new AbortController();
  const cancelled = client.chatSend({ request_id: 'cancelled_stream', messages: [] }, {
    signal: controller.signal, onNotification: event => delivered.push(event) });
  const active = client.chatSend({ request_id: 'live_stream', messages: [] }, {
    onNotification() { throw new Error('fixture handler failed'); } });
  controller.abort(new Error('fixture cancellation'));
  await assert.rejects(cancelled, /fixture cancellation/);
  for (const params of [{ stream_id: 'cancelled_stream' }, { stream_id: 'live_stream' },
    { stream_id: 'live_stream', request_id: 'cancelled_stream' }]) {
    proc.stdout.push(buildFrame({ jsonrpc: '2.0', method: 'turn.event', params }));
  }
  proc.stdout.push(buildFrame({ jsonrpc: '2.0', id: 2, result: {} }));
  await active;
  assert.equal(delivered.length, 0);
  assert.equal(late.length, 1);
  const failures = logs.filter(entry => entry.event === 'sidecar.notification_listener_failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].fields.request_id, 'live_stream');
  assert.equal(failures[0].fields.trace_id, 'live_stream');
  client.detachProcess();
});
