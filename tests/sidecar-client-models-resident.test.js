'use strict';

// Split out of tests/sidecar-client.test.js (already at the file-size
// ceiling) to keep that file under the check_file_size.py cap. Covers the
// Wave 4 model-fit self-catalog `models.resident` RPC wrapper.
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

test('modelsResident sends models.resident RPC request', async () => {
  const client = new SidecarClient();
  const proc = createMockProcess();
  const writes = [];
  proc.stdin.write = (chunk) => {
    writes.push(Buffer.from(chunk));
    return true;
  };
  client.attachProcess(proc);

  const promise = client.modelsResident();
  proc.stdout.push(buildFrame({
    jsonrpc: '2.0',
    id: 1,
    result: {
      available: true,
      reason: '',
      models: [{ name: 'llama3.1:8b', size: 4900000000, size_vram: 4900000000 }],
    },
  }));
  const payload = await promise;

  const written = Buffer.concat(writes).toString('utf8');
  const [, body] = written.split('\r\n\r\n');
  const request = JSON.parse(body);
  assert.equal(request.method, 'models.resident');
  assert.equal(request.params.accept_version, '2026-08-17');
  assert.equal(payload.available, true);
  assert.equal(payload.models.length, 1);
});
