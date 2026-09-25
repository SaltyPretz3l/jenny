"use strict";
const { randomUUID } = require('node:crypto');
const { stableJson } = require('../session-runtime/contracts');
function fail() { throw new Error('runtime_electron_start_invalid'); }
function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}
// One physical request owns all gates. Ready and start use separate RPC IDs;
// the producer runs only after the sidecar has acknowledged its execution event.
function createElectronStartGate({ execute, enabled, signal, timeoutMs = 30000 }) {
  const entries = new Map();
  const settled = new Set();
  return async params => {
    if (!Object.hasOwn(params || {}, 'runtime_resource_gate')) return execute(params, null);
    if (enabled(params) !== true || signal?.aborted) fail();
    const { runtime_resource_gate: gate, ...input } = params;
    if (!gate || gate.schema_version !== 1 || !['prepare', 'start'].includes(gate.phase)
      || Object.keys(gate).sort().join(',') !== (gate.phase === 'prepare' ? 'phase,schema_version' : 'phase,schema_version,token')
      || typeof input.tool_call_id !== 'string' || !input.tool_call_id) fail();
    const key = input.tool_call_id;
    const fingerprint = stableJson(input);
    if (gate.phase === 'start') {
      const entry = entries.get(key);
      if (!entry || entry.state !== 'ready' || entry.token !== gate.token || entry.fingerprint !== fingerprint) fail();
      entry.state = 'started'; clearTimeout(entry.timer); entry.start.resolve();
      return entry.result;
    }
    if (entries.has(key) || settled.has(key) || entries.size >= 256) fail();
    const ready = deferred(); const start = deferred();
    const entry = { state: 'preparing', token: randomUUID(), fingerprint, start, result: null, timer: null };
    entries.set(key, entry);
    const abort = () => {
      entry.state = 'cancelled';
      const error = Object.assign(new Error('runtime_electron_start_cancelled'), { reason: 'runtime_electron_start_cancelled' });
      start.reject(error); ready.reject(error);
    };
    signal?.addEventListener('abort', abort, { once: true });
    entry.result = Promise.resolve().then(() => execute(input, async () => {
      if (signal?.aborted || entry.state !== 'preparing') fail();
      entry.state = 'ready';
      entry.timer = setTimeout(abort, timeoutMs); entry.timer.unref?.();
      ready.resolve({ runtime_resource_ready: { schema_version: 1, operation_id: key, token: entry.token } });
      await start.promise;
      if (signal?.aborted || entry.state !== 'started') fail();
    })).finally(() => {
      entry.state = 'settled'; clearTimeout(entry.timer); signal?.removeEventListener('abort', abort);
      entries.delete(key);
      settled.add(key);
      if (settled.size > 256) settled.delete(settled.values().next().value);
    });
    entry.result.catch(() => {});
    return Promise.race([ready.promise, entry.result]);
  };
}
module.exports = { createElectronStartGate };
