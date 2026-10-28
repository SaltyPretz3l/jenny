'use strict';

// The session-reference walk behind the attachment and ipc-payload prunes yields
// to the event loop in bounded slices (collectSessionReferencesAsync) and still
// fails closed: the result covers every chat as it is when the prune runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const {
  collectSessionReferencesAsync,
  scheduleStartupRetentionTasks,
} = require('../services/main/startup-retention-tasks');

function attachment(name) {
  return { attachments: [{ kind: 'image', assetPath: `C:\\assets\\${name}.png` }] };
}

// A store whose summaries are derived from mutable bodies, like the real one.
function createStore(count) {
  const bodies = new Map();
  for (let i = 0; i < count; i += 1) {
    bodies.set(`s${i}`, { updated_at: 'T0', messages: [attachment(`a${i}`)] });
  }
  const reads = [];
  return {
    bodies,
    reads,
    onRead: null,
    listSessions() {
      return [...bodies].map(([id, body]) => ({ id, updated_at: body.updated_at, message_count: body.messages.length }));
    },
    peekSession(id) {
      reads.push(id);
      if (this.onRead) this.onRead(id);
      const body = bodies.get(id);
      return body ? { messages: body.messages, turn_events: [] } : null;
    },
  };
}

function fakeClock(stepPerRead, store) {
  const clock = { t: 0, slices: [0] };
  store.onRead = () => {
    clock.t += stepPerRead;
    clock.slices[clock.slices.length - 1] += 1;
  };
  return {
    now: () => clock.t,
    yieldFn: async () => { clock.slices.push(0); },
    clock,
  };
}

test('the walk yields between slices of bounded work', async () => {
  const store = createStore(40);
  const { now, yieldFn, clock } = fakeClock(5, store);
  const result = await collectSessionReferencesAsync(store, { now, yieldFn, sliceMs: 12 });
  assert.equal(result.assetPaths.length, 40);
  assert.ok(clock.slices.length >= 13, `expected many slices, got ${clock.slices.length}`);
  // 12 ms of 5 ms reads: no slice reads more than three chats.
  assert.ok(Math.max(...clock.slices) <= 3, `a slice read ${Math.max(...clock.slices)} chats`);
});

test('other event-loop work runs while a real walk is in progress', async () => {
  const store = createStore(30);
  let interleaved = 0;
  store.onRead = () => {
    const start = performance.now();
    while (performance.now() - start < 2) { /* 2 ms of work per chat */ }
  };
  const ticker = setInterval(() => { interleaved += 1; }, 0);
  await collectSessionReferencesAsync(store, { sliceMs: 5 });
  clearInterval(ticker);
  assert.ok(interleaved > 0, 'a timer ran during the walk');
});

test('a chat changed or created mid-walk is read again before the result is returned', async () => {
  const store = createStore(6);
  let mutated = false;
  const result = await collectSessionReferencesAsync(store, {
    sliceMs: 0,
    yieldFn: async () => {
      if (mutated || store.reads.length < 3) return;
      mutated = true;
      // s0 was already read: a new reference lands in it, and a new chat appears.
      store.bodies.get('s0').messages.push(attachment('late'));
      store.bodies.get('s0').updated_at = 'T1';
      store.bodies.set('s_new', { updated_at: 'T1', messages: [attachment('fresh')] });
    },
  });
  assert.ok(result.assetPaths.includes('C:\\assets\\late.png'), 'the late reference is counted');
  assert.ok(result.assetPaths.includes('C:\\assets\\fresh.png'), 'the new chat is counted');
  assert.equal(store.reads.filter((id) => id === 's0').length, 2);
});

test('a walk that never settles fails closed', async () => {
  const store = createStore(3);
  let tick = 0;
  await assert.rejects(collectSessionReferencesAsync(store, {
    sliceMs: 0,
    maxRounds: 3,
    yieldFn: async () => {
      tick += 1;
      store.bodies.get('s1').updated_at = `T${tick}`;
    },
  }), /did not settle/);
});

test('onCollected runs in the same synchronous stretch as the settle check', async () => {
  const store = createStore(4);
  const seen = [];
  const result = await collectSessionReferencesAsync(store, {
    sliceMs: 0,
    onCollected: (collected) => {
      seen.push(collected.assetPaths.length);
      // Nothing may change between the check and this callback: the walk does
      // not yield after its final listSessions.
      assert.equal(store.listSessions().length, 4);
    },
  });
  assert.deepEqual(seen, [4]);
  assert.equal(result.assetPaths.length, 4);
});

test('an unreadable chat aborts the sweep after yielding, and nothing is pruned', async () => {
  const store = createStore(20);
  store.listSessions = ((list) => () => [...list(), { id: 'gone', updated_at: 'T0', message_count: 2 }])(
    store.listSessions.bind(store)
  );
  const backend = new EventEmitter();
  backend.getBackendStatus = () => ({ phase: 'ready' });
  backend.sessionStore = store;
  const pruned = [];
  const logs = [];
  const timers = [];
  scheduleStartupRetentionTasks({
    backendService: backend,
    attachmentAssetStore: { pruneUnreferencedAssets: (paths) => { pruned.push(paths); return { deletedCount: 0 }; } },
    setTimeoutRef: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
    setIntervalRef: () => ({ unref() {} }),
    log: (...entry) => logs.push(entry),
  });
  await timers.find((timer) => timer.ms === 8000).fn();
  assert.deepEqual(pruned, []);
  assert.deepEqual(logs.map(([level, event]) => [level, event]), [['WARN', 'attachments.asset_sweep_failed']]);
});

test('an interval tick during a running sweep does not start a second walk', async () => {
  const store = createStore(10);
  const backend = new EventEmitter();
  backend.getBackendStatus = () => ({ phase: 'ready' });
  backend.sessionStore = store;
  let prunes = 0;
  const timers = [];
  const intervals = [];
  store.onRead = () => {
    const start = performance.now();
    while (performance.now() - start < 3) { /* force several slices */ }
  };
  scheduleStartupRetentionTasks({
    backendService: backend,
    attachmentAssetStore: { pruneUnreferencedAssets: () => { prunes += 1; return { deletedCount: 0 }; } },
    setTimeoutRef: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
    setIntervalRef: (fn) => { intervals.push(fn); return { unref() {} }; },
  });
  const first = timers.find((timer) => timer.ms === 8000).fn();
  const second = intervals[0]();
  assert.equal(first, second, 'the tick joins the walk in flight');
  await first;
  assert.equal(prunes, 1);
  assert.deepEqual(store.reads.slice().sort(), [...store.bodies.keys()].sort());
});
