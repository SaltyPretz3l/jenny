'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { Readable, Writable } = require('stream');

const { SidecarClient } = require('../services/backend/sidecar-client');

function buildFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8');
  return Buffer.concat([header, body]);
}

function createMockProcess() {
  const processRef = new EventEmitter();
  processRef.stdout = new Readable({ read() {} });
  processRef.stdin = new Writable({ write(_chunk, _encoding, done) { done(); } });
  return processRef;
}

test('initialize correlates runtime.progress and removes its handler on completion', async () => {
  const client = new SidecarClient();
  const processRef = createMockProcess();
  client.attachProcess(processRef);
  const progress = [];
  const promise = client.initialize({}, {
    onProgress(message) { progress.push(message.params); },
  });
  processRef.stdout.push(buildFrame({
    jsonrpc: '2.0',
    method: 'runtime.progress',
    params: { request_id: 'initialize-1', state: 'model_acquiring', percent: 25 },
  }));
  processRef.stdout.push(buildFrame({
    jsonrpc: '2.0',
    id: 1,
    result: { active_engine: 'ollama', active_model: 'ornith:9b' },
  }));

  const result = await promise;
  assert.equal(result.active_model, 'ornith:9b');
  assert.equal(progress.length, 1);
  assert.equal(progress[0].percent, 25);
  assert.equal(client.notificationHandlers.size, 0);
});

test('initialize abort preserves a timeout reason code instead of reclassifying it', async () => {
  const client = new SidecarClient();
  const processRef = createMockProcess();
  client.attachProcess(processRef);
  const controller = new AbortController();
  const promise = client.initialize({}, { signal: controller.signal });
  const timeoutError = Object.assign(new Error('progress stalled'), {
    error_code: 'CMP-SIDECAR-0001',
    category: 'timeout',
  });
  controller.abort(timeoutError);

  await assert.rejects(promise, (error) => {
    assert.equal(error.error_code, 'CMP-SIDECAR-0001');
    assert.equal(error.category, 'timeout');
    return true;
  });
});

test('initialize cleans its progress handler when no process is attached', async () => {
  const client = new SidecarClient();

  await assert.rejects(client.initialize({}, { onProgress() {} }), /not connected/i);

  assert.equal(client.notificationHandlers.size, 0);
});
