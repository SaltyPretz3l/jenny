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
  const stdout = new Readable({ read() {} });
  const stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  const proc = new EventEmitter();
  proc.stdout = stdout;
  proc.stdin = stdin;
  return proc;
}

test('modelsOllamaBlob sends models.ollama_blob RPC request', async () => {
  const client = new SidecarClient();
  const proc = createMockProcess();
  const writes = [];
  proc.stdin.write = (chunk) => {
    writes.push(Buffer.from(chunk));
    return true;
  };
  client.attachProcess(proc);

  const promise = client.modelsOllamaBlob('gemma4:12b-qat-ud-q4-k-xl');
  proc.stdout.push(buildFrame({
    jsonrpc: '2.0',
    id: 1,
    result: {
      model_id: 'gemma4:12b-qat-ud-q4-k-xl',
      available: true,
      blob_path: 'C:\\ollama\\sha256-model',
      mmproj_path: '',
      reason: '',
    },
  }));
  const payload = await promise;

  const written = Buffer.concat(writes).toString('utf8');
  const [, body] = written.split('\r\n\r\n');
  const request = JSON.parse(body);
  assert.equal(request.method, 'models.ollama_blob');
  assert.deepEqual(request.params, {
    accept_version: '2026-08-17',
    model_id: 'gemma4:12b-qat-ud-q4-k-xl',
  });
  assert.equal(payload.available, true);
  assert.equal(payload.blob_path, 'C:\\ollama\\sha256-model');
});
