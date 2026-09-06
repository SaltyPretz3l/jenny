'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');

const { SidecarClient } = require('../services/backend/sidecar-client');

function createCapturingMockProcess() {
  const frames = [];
  const stdout = new Readable({ read() {} });
  const stdin = new Writable({ write(chunk, _encoding, callback) {
    const bytes = Buffer.from(chunk);
    const separator = bytes.indexOf('\r\n\r\n');
    frames.push(JSON.parse(bytes.subarray(separator + 4).toString('utf8')));
    callback();
  } });
  const process = new EventEmitter();
  process.stdout = stdout;
  process.stdin = stdin;
  return { process, frames };
}

async function withImmediateTimeouts(callback) {
  const previousSetTimeout = global.setTimeout;
  const previousClearTimeout = global.clearTimeout;
  global.setTimeout = (handler) => {
    queueMicrotask(handler);
    return { unref() {} };
  };
  global.clearTimeout = () => {};
  try { await callback(); }
  finally {
    global.setTimeout = previousSetTimeout;
    global.clearTimeout = previousClearTimeout;
  }
}

function assertCancellationFrames(frames) {
  assert.deepEqual(frames.map((frame) => frame.method), ['mcp.inspect', '$/cancelRequest']);
  assert.deepEqual(frames[1].params, { id: frames[0].id });
  assert.equal(Object.hasOwn(frames[1], 'id'), false);
}

test('aborting mcp.inspect sends a best-effort JSON-RPC cancellation notification', async () => {
  const client = new SidecarClient();
  const { process, frames } = createCapturingMockProcess();
  client.attachProcess(process);
  const controller = new AbortController();
  const promise = client.request('mcp.inspect', { accept_version: '2026-08-17' }, {
    signal: controller.signal, timeoutMs: null,
  });
  controller.abort(new Error('inspection replaced'));
  await assert.rejects(promise, /inspection replaced/);
  assertCancellationFrames(frames);
});

test('timing out mcp.inspect sends a best-effort cancellation notification', async () => {
  await withImmediateTimeouts(async () => {
    const client = new SidecarClient();
    const { process, frames } = createCapturingMockProcess();
    client.attachProcess(process);
    await assert.rejects(client.request('mcp.inspect', {}, { timeoutMs: 50 }), (error) => {
      assert.equal(error.category, 'timeout');
      return true;
    });
    assertCancellationFrames(frames);
  });
});
