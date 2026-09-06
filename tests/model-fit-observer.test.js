'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const { createModelFitObserver, POLL_TIMEOUT_MS } = require('../services/model-fit-observer');

function makeFakeClock(start = 1_000_000) {
  let clock = start;
  const timers = [];
  return {
    now: () => clock,
    advance(ms) {
      clock += ms;
      // Fire due timers in scheduled order; a fired callback may itself
      // schedule a new timer, so re-check after each pass.
      let fired = true;
      while (fired) {
        fired = false;
        for (let i = 0; i < timers.length; i += 1) {
          const t = timers[i];
          if (!t.cancelled && t.due <= clock) {
            timers.splice(i, 1);
            fired = true;
            t.cb();
            break;
          }
        }
      }
    },
    setTimeoutFn(cb, ms) {
      const handle = { cb, due: clock + ms, cancelled: false };
      timers.push(handle);
      return handle;
    },
    clearTimeoutFn(handle) {
      if (handle) handle.cancelled = true;
    },
  };
}

function makeStore() {
  const records = [];
  return {
    records,
    record(obs) {
      records.push(obs);
      return obs;
    },
  };
}

function makeBackend({ residentModelsSequence = [] } = {}) {
  const backend = new EventEmitter();
  let callIndex = 0;
  backend.getResidentModels = async () => {
    const value = residentModelsSequence[Math.min(callIndex, residentModelsSequence.length - 1)];
    callIndex += 1;
    return value;
  };
  backend.sidecarManager = { getStatus: () => ({}) };
  return backend;
}

const GPU_PROFILE = { gpu: { name: 'NVIDIA RTX 5070 Ti', vram_mb: 16384, type: 'cuda' } };

async function flush(times = 6) {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

test('triggers on ready + ollama + model, polls, and records once the model shows up resident', async () => {
  const clock = makeFakeClock();
  const store = makeStore();
  const logs = [];
  const backend = makeBackend({
    residentModelsSequence: [
      [],
      [{ name: 'llama3.1:8b', digest: 'sha256:abc', sizeBytes: 4900000000, vramBytes: 4900000000 }],
    ],
  });
  const observer = createModelFitObserver({
    backendService: backend,
    store,
    getHardwareProfile: () => GPU_PROFILE,
    logger: (level, event, data) => logs.push({ level, event, data }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  backend.emit('backend-status', { phase: 'ready', engine: 'ollama', model: 'llama3.1:8b' });
  // First poll fires synchronously (pollOnce called directly); await a tick.
  await flush();
  assert.equal(store.records.length, 0, 'no footprint yet on the first empty poll');

  clock.advance(5000);
  await flush();

  assert.equal(store.records.length, 1);
  assert.equal(store.records[0].modelId, 'llama3.1:8b');
  assert.equal(store.records[0].vramMb, Math.round(4900000000 / (1024 * 1024)));
  assert.ok(logs.some((l) => l.event === 'model_fit.observed'));

  observer.dispose();
});

test('does not record when a match is never found within the poll timeout', async () => {
  const clock = makeFakeClock();
  const store = makeStore();
  const backend = makeBackend({ residentModelsSequence: [[]] });
  const observer = createModelFitObserver({
    backendService: backend,
    store,
    getHardwareProfile: () => GPU_PROFILE,
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  backend.emit('backend-status', { phase: 'ready', engine: 'ollama', model: 'some-model' });
  await flush();

  clock.advance(POLL_TIMEOUT_MS + 5000);
  await flush();

  assert.equal(store.records.length, 0);
  observer.dispose();
});

test('ignores trigger when flag is disabled', async () => {
  const clock = makeFakeClock();
  const store = makeStore();
  const backend = makeBackend({
    residentModelsSequence: [[{ name: 'x', digest: 'd', sizeBytes: 100, vramBytes: 100 }]],
  });
  const observer = createModelFitObserver({
    backendService: backend,
    store,
    getHardwareProfile: () => GPU_PROFILE,
    flagEnabled: () => false,
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  backend.emit('backend-status', { phase: 'ready', engine: 'ollama', model: 'x' });
  await flush();
  clock.advance(5000);
  await flush();

  assert.equal(store.records.length, 0);
  observer.dispose();
});

test('ignores trigger when GPU is unknown', async () => {
  const clock = makeFakeClock();
  const store = makeStore();
  const backend = makeBackend({
    residentModelsSequence: [[{ name: 'x', digest: 'd', sizeBytes: 100, vramBytes: 100 }]],
  });
  const observer = createModelFitObserver({
    backendService: backend,
    store,
    getHardwareProfile: () => null,
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  backend.emit('backend-status', { phase: 'ready', engine: 'ollama', model: 'x' });
  await flush();
  clock.advance(5000);
  await flush();

  assert.equal(store.records.length, 0);
  observer.dispose();
});

test('ignores non-ollama engines', async () => {
  const clock = makeFakeClock();
  const store = makeStore();
  const backend = makeBackend({
    residentModelsSequence: [[{ name: 'x', digest: 'd', sizeBytes: 100, vramBytes: 100 }]],
  });
  const observer = createModelFitObserver({
    backendService: backend,
    store,
    getHardwareProfile: () => GPU_PROFILE,
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  backend.emit('backend-status', { phase: 'ready', engine: 'vllm', model: 'x' });
  await flush();
  clock.advance(5000);
  await flush();

  assert.equal(store.records.length, 0);
  observer.dispose();
});

test('stops polling when the model changes before a match is found', async () => {
  const clock = makeFakeClock();
  const store = makeStore();
  const backend = makeBackend({ residentModelsSequence: [[]] });
  const observer = createModelFitObserver({
    backendService: backend,
    store,
    getHardwareProfile: () => GPU_PROFILE,
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  backend.emit('backend-status', { phase: 'ready', engine: 'ollama', model: 'model-a' });
  await flush();
  backend.emit('backend-status', { phase: 'ready', engine: 'ollama', model: 'model-b' });
  await flush();

  clock.advance(5000);
  await flush();

  // Neither model ever matched (list stayed empty), and switching models
  // must not have caused a crash or duplicate record.
  assert.equal(store.records.length, 0);
  observer.dispose();
});

test('dispose stops polling and detaches the listener', async () => {
  const clock = makeFakeClock();
  const store = makeStore();
  const backend = makeBackend({
    residentModelsSequence: [[{ name: 'x', digest: 'd', sizeBytes: 100, vramBytes: 100 }]],
  });
  const observer = createModelFitObserver({
    backendService: backend,
    store,
    getHardwareProfile: () => GPU_PROFILE,
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  observer.dispose();
  backend.emit('backend-status', { phase: 'ready', engine: 'ollama', model: 'x' });
  await flush();
  clock.advance(5000);
  await flush();

  assert.equal(store.records.length, 0);
});

test('threads the trigger contextLength into the recorded observation', async () => {
  const clock = makeFakeClock();
  const store = makeStore();
  const backend = makeBackend({
    residentModelsSequence: [
      // No context_length on the resident entry itself: the observer must
      // fall back to the trigger's contextLength rather than recording 0.
      [{ name: 'llama3.1:8b', digest: 'sha256:abc', sizeBytes: 4900000000, vramBytes: 4900000000 }],
    ],
  });
  const observer = createModelFitObserver({
    backendService: backend,
    store,
    getHardwareProfile: () => GPU_PROFILE,
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  backend.emit('backend-status', {
    phase: 'ready', engine: 'ollama', model: 'llama3.1:8b', effective_context_length: 131072,
  });
  await flush();

  assert.equal(store.records.length, 1);
  assert.equal(store.records[0].contextLength, 131072);
  observer.dispose();
});

test('a same-model re-trigger while a poll is in flight does not double-record (monotonic run token)', async () => {
  const clock = makeFakeClock();
  const store = makeStore();
  // Neither trigger's getResidentModels() call resolves on its own — the
  // test controls exactly when each settles, so the run-token guard's
  // behavior is deterministic regardless of which promise the JS engine
  // would otherwise happen to settle first.
  const releases = [];
  const backend = new EventEmitter();
  backend.getResidentModels = () => new Promise((resolve) => { releases.push(resolve); });
  backend.sidecarManager = { getStatus: () => ({}) };
  const observer = createModelFitObserver({
    backendService: backend,
    store,
    getHardwareProfile: () => GPU_PROFILE,
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  // First trigger: pollOnce starts, calls getResidentModels(), and is now
  // suspended awaiting releases[0].
  backend.emit('backend-status', { phase: 'ready', engine: 'ollama', model: 'llama3.1:8b' });
  await flush();
  assert.equal(releases.length, 1);

  // Second, identical-model trigger with a DIFFERENT context length (so it's
  // not deduped by triggerKey) fires while the first poll is still in
  // flight — this starts a fresh run and bumps the run token, and issues
  // its own getResidentModels() call (releases[1]).
  backend.emit('backend-status', {
    phase: 'ready', engine: 'ollama', model: 'llama3.1:8b', effective_context_length: 4096,
  });
  await flush();
  assert.equal(releases.length, 2);

  // Resolve the CURRENT (second) run first — it must record.
  releases[1]([
    { name: 'llama3.1:8b', digest: 'sha256:abc', sizeBytes: 4900000000, vramBytes: 4900000000 },
  ]);
  await flush();
  assert.equal(store.records.length, 1);
  assert.equal(store.records[0].contextLength, 4096);

  // Now resolve the STALE (first) run with a match too. Without the
  // run-token guard this would record a second, duplicate observation.
  releases[0]([
    { name: 'llama3.1:8b', digest: 'sha256:abc', sizeBytes: 100, vramBytes: 100 },
  ]);
  await flush();
  assert.equal(store.records.length, 1, 'the stale poll must not produce a second record');

  observer.dispose();
});

test('invalidate(modelId) clears the trigger memo and re-triggers a fresh observation', async () => {
  const clock = makeFakeClock();
  const store = makeStore();
  const backend = makeBackend({
    residentModelsSequence: [
      [{ name: 'llama3.1:8b', digest: 'sha256:abc', sizeBytes: 4900000000, vramBytes: 4900000000 }],
    ],
  });
  // Realistic production shape: sidecarManager.getStatus() is the raw
  // child-process status and never carries engine/model. currentStatus is
  // where the managed runtime's last-observed engine/model live.
  backend.sidecarManager = { getStatus: () => ({ phase: 'stopped' }) };
  backend.currentStatus = { engine: 'ollama', model: 'llama3.1:8b' };
  const observer = createModelFitObserver({
    backendService: backend,
    store,
    getHardwareProfile: () => GPU_PROFILE,
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  backend.emit('backend-status', { phase: 'ready', engine: 'ollama', model: 'llama3.1:8b' });
  await flush();
  assert.equal(store.records.length, 1);

  // A second identical status must NOT re-trigger (dedup by trigger key).
  backend.emit('backend-status', { phase: 'ready', engine: 'ollama', model: 'llama3.1:8b' });
  await flush();
  assert.equal(store.records.length, 1);

  // invalidate() clears the memo and re-triggers via the injected status getter.
  observer.invalidate('llama3.1:8b');
  await flush();
  assert.equal(store.records.length, 2);

  observer.dispose();
});
