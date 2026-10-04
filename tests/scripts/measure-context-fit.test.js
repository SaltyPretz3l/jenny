'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function probe({ stops = true, stalled = false } = {}) {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { if (stops) child.emit('exit', 0, null); return true; };
  let now = 0;
  let fetches = 0;
  const exits = [];
  const signals = [];
  const output = [];
  const file = path.resolve(__dirname, '../../scripts/eval/dogfood/measure-context-fit.js');
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module: {}, console: { log: text => output.push(text), error() {} },
    process: { argv: ['node', file, '--model', 'model.gguf'], exit: code => exits.push(code) },
    Date: { now: () => now }, AbortController,
    AbortSignal: { timeout: ms => {
      assert.ok(ms > 0 && ms <= 240000);
      const controller = new AbortController();
      if (stalled) queueMicrotask(() => controller.abort());
      return controller.signal;
    } },
    setTimeout: (callback, ms) => { now += ms; queueMicrotask(callback); return 1; }, clearTimeout() {},
    fetch: async (_url, init) => {
      signals.push(init?.signal);
      fetches += 1;
      if (fetches === 1) throw new Error('not listening');
      if (stalled) return new Promise((_resolve, reject) => {
        init?.signal.addEventListener('abort', () => reject(new Error('deadline')), { once: true });
      });
      return { ok: true, json: async () => ({}) };
    },
    require: name => {
      if (name === 'fs') return { existsSync: () => true, writeFileSync() {} };
      if (name === './llama-runtime') return { resolveLlamaServerBinary: () => 'llama-server.exe' };
      if (name === 'child_process') return { spawn: () => child, spawnSync: () => ({ status: 0, stdout: '1,100' }) };
      throw new Error(name);
    },
  });
  for (let i = 0; i < 3000 && !exits.length; i += 1) await Promise.resolve();
  return { exits, signals, output };
}

test('VRAM probe fails unless owned server shutdown is confirmed', async () => {
  const result = await probe({ stops: false });
  assert.deepEqual(result.exits, [2]);
  assert.equal(JSON.parse(result.output[0]).stopped, false);
});

test('VRAM probe bounds every HTTP request including port preflight', async () => {
  const result = await probe({ stalled: true });
  assert.deepEqual(result.exits, [2]);
  assert.ok(result.signals.length > 1);
  assert.ok(result.signals.every(signal => signal instanceof AbortSignal));
});
