const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const {
  collectReferencedAttachmentAssetPaths,
  scheduleStartupRetentionTasks,
  runInitialRetentionTaskWhenReady,
} = require('../services/main/startup-retention-tasks');

function payloadToolCallMessage(name) {
  return { tool_call: { external_payloads: { arg: { path: name } } } };
}

function payloadToolResultMessage(name) {
  return { tool_result: { external_payloads: { out: { path: name } } } };
}

function createFakePayloadStore() {
  const calls = [];
  const options = [];
  return {
    calls,
    options,
    pruneUnreferencedPayloads(referenced, opts) {
      calls.push([...referenced].sort());
      options.push(opts);
      return { deleted: 0 };
    },
  };
}

// Drives the REAL scheduleStartupRetentionTasks entry point with only the
// payload branch wired, then fires the staggered startup timer it arms.
function runPayloadSweep(sessionStore, { fire = true } = {}) {
  const backend = createFakeBackend('ready');
  backend.sessionStore = sessionStore;
  // The store reaches the sweep the same way production delivers it: hung on the
  // BackendService by backend-service-wiring, not passed in beside it.
  const ipcPayloadStore = createFakePayloadStore();
  backend.ipcPayloadStore = ipcPayloadStore;
  const timers = [];
  const intervals = [];
  const logs = [];
  scheduleStartupRetentionTasks({
    backendService: backend,
    setTimeoutRef: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
    setIntervalRef: (fn, ms) => { intervals.push(ms); return { unref() {} }; },
    log: (level, event, payload) => { logs.push([level, event, payload]); },
  });
  if (fire) {
    for (const timer of timers) timer.fn();
  }
  return { ipcPayloadStore, timers, intervals, logs };
}

function createFakeSessionStore(sessions) {
  // sessions: [{ id, updated_at, message_count, messages }]
  const reads = [];
  return {
    reads,
    sessions,
    listSessions: () => sessions.map(({ id, updated_at, message_count }) => ({
      id,
      updated_at,
      message_count,
    })),
    peekSession(sessionId) {
      reads.push(sessionId);
      const session = sessions.find((entry) => entry.id === sessionId);
      return session ? { id: session.id, messages: session.messages } : null;
    },
  };
}

function attachmentMessage(name) {
  return {
    attachments: [{
      id: `att_${name}`,
      kind: 'image',
      displayName: `${name}.png`,
      assetPath: `C:\\assets\\${name}.png`,
    }],
  };
}

function createFakeBackend(initialPhase = 'starting') {
  const emitter = new EventEmitter();
  emitter._phase = initialPhase;
  emitter.getBackendStatus = () => ({ phase: emitter._phase });
  emitter.sessionStore = { listSessions: () => [] };
  return emitter;
}

test('runInitialRetentionTaskWhenReady defers the task until the backend reports ready', () => {
  const backend = createFakeBackend('starting');
  const timers = [];
  const setTimeoutRef = (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; };
  let ran = 0;

  runInitialRetentionTaskWhenReady(backend, () => { ran += 1; }, { setTimeoutRef, staggerMs: 0 });

  // Not ready yet -> task must not have run, but a fallback timer is armed.
  assert.equal(ran, 0);
  assert.equal(timers.length, 1); // fallback only

  backend._phase = 'ready';
  backend.emit('backend-status', { phase: 'ready' });
  assert.equal(ran, 1);

  // A second ready signal must not re-run the initial task.
  backend.emit('backend-status', { phase: 'ready' });
  assert.equal(ran, 1);
});

test('runInitialRetentionTaskWhenReady runs immediately when the backend is already ready', () => {
  const backend = createFakeBackend('ready');
  let ran = 0;
  runInitialRetentionTaskWhenReady(backend, () => { ran += 1; }, { setTimeoutRef: () => ({ unref() {} }) });
  assert.equal(ran, 1);
});

test('runInitialRetentionTaskWhenReady falls back when ready never fires', () => {
  const backend = createFakeBackend('starting');
  let fallbackFn = null;
  const setTimeoutRef = (fn) => { fallbackFn = fn; return { unref() {} }; };
  let ran = 0;
  runInitialRetentionTaskWhenReady(backend, () => { ran += 1; }, { setTimeoutRef, fallbackMs: 60000 });
  assert.equal(ran, 0);
  fallbackFn(); // simulate the fallback timer firing
  assert.equal(ran, 1);
});

test('collectReferencedAttachmentAssetPaths prefers peekSession over getSessionMessages', () => {
  const store = createFakeSessionStore([
    { id: 's1', updated_at: 'T1', message_count: 1, messages: [attachmentMessage('one')] },
  ]);
  store.getSessionMessages = () => {
    throw new Error('must not fall back to getSessionMessages when peekSession exists');
  };
  const referenced = collectReferencedAttachmentAssetPaths(store);
  assert.deepEqual(referenced, ['C:\\assets\\one.png']);
  assert.deepEqual(store.reads, ['s1']);
});

test('collectReferencedAttachmentAssetPaths falls back to getSessionMessages without peekSession', () => {
  const store = {
    listSessions: () => [{ id: 's1', updated_at: 'T1', message_count: 1 }],
    getSessionMessages: () => [attachmentMessage('legacy')],
  };
  assert.deepEqual(collectReferencedAttachmentAssetPaths(store), ['C:\\assets\\legacy.png']);
});

test('sweep memo cache skips unchanged sessions, re-reads changed ones, and drops deleted ids', () => {
  const store = createFakeSessionStore([
    { id: 's1', updated_at: 'T1', message_count: 1, messages: [attachmentMessage('one')] },
    { id: 's2', updated_at: 'T1', message_count: 1, messages: [attachmentMessage('two')] },
  ]);
  const cache = new Map();

  // First sweep reads everything once and fills the cache.
  const first = collectReferencedAttachmentAssetPaths(store, { cache });
  assert.deepEqual([...first].sort(), ['C:\\assets\\one.png', 'C:\\assets\\two.png']);
  assert.equal(store.reads.length, 2);

  // Unchanged stamps: second sweep reads nothing but reports the same set.
  const second = collectReferencedAttachmentAssetPaths(store, { cache });
  assert.deepEqual([...second].sort(), ['C:\\assets\\one.png', 'C:\\assets\\two.png']);
  assert.equal(store.reads.length, 2, 'unchanged sessions must be served from the memo cache');

  // A message mutation bumps the stamp -> only that session is re-read.
  store.sessions[1] = {
    id: 's2',
    updated_at: 'T2',
    message_count: 2,
    messages: [attachmentMessage('two'), attachmentMessage('three')],
  };
  const third = collectReferencedAttachmentAssetPaths(store, { cache });
  assert.deepEqual(
    [...third].sort(),
    ['C:\\assets\\one.png', 'C:\\assets\\three.png', 'C:\\assets\\two.png']
  );
  assert.deepEqual(store.reads.slice(2), ['s2']);

  // Deleted sessions leave the cache so their assets become prunable.
  store.sessions.splice(0, 1);
  const fourth = collectReferencedAttachmentAssetPaths(store, { cache });
  assert.deepEqual([...fourth].sort(), ['C:\\assets\\three.png', 'C:\\assets\\two.png']);
  assert.equal(cache.has('s1'), false, 'stale cache entries must be pruned');
});

test('scheduleStartupRetentionTasks gates both retention passes behind backend-ready', () => {
  const backend = createFakeBackend('starting');
  const immediate = [];
  const setTimeoutRef = (fn, ms) => { immediate.push({ fn, ms }); return { unref() {} }; };
  const setIntervalRef = () => ({ unref() {} });
  let pruned = 0;
  let swept = 0;

  scheduleStartupRetentionTasks({
    artifactService: { pruneOrphanedArtifacts: async () => { pruned += 1; } },
    attachmentAssetStore: { pruneUnreferencedAssets: () => { swept += 1; return { deletedCount: 0 }; } },
    backendService: backend,
    setTimeoutRef,
    setIntervalRef,
  });

  // Before ready: neither initial pass ran (only fallback timers were armed).
  assert.equal(pruned, 0);
  assert.equal(swept, 0);

  backend._phase = 'ready';
  backend.emit('backend-status', { phase: 'ready' });

  // After ready, the staggered timers were scheduled; fire them.
  const staggered = immediate.filter((t) => t.ms === 1000 || t.ms === 8000);
  assert.equal(staggered.length, 2);
  for (const t of staggered) { t.fn(); }
  assert.equal(pruned, 1);
  assert.equal(swept, 1);
});

test('scheduleStartupRetentionTasks runs the WIDE-010 artifact retention sweep on ready and on the interval', () => {
  const backend = createFakeBackend('ready');
  const immediate = [];
  const intervals = [];
  const setTimeoutRef = (fn, ms) => { immediate.push({ fn, ms }); return { unref() {} }; };
  const setIntervalRef = (fn, ms) => { intervals.push({ fn, ms }); return { unref() {} }; };
  let sweeps = 0;

  scheduleStartupRetentionTasks({
    artifactService: {
      pruneOrphanedArtifacts: async () => {},
      getWorkspaceRoot: () => 'C:/ws',
    },
    backendService: backend,
    artifactRetentionService: { sweep: async () => { sweeps += 1; return { ok: true }; } },
    setTimeoutRef,
    setIntervalRef,
  });

  // Ready already: the sweep is staggered behind the orphan prune (4000ms).
  const staggeredSweep = immediate.find((t) => t.ms === 4000);
  assert.ok(staggeredSweep, 'retention sweep is scheduled with its own stagger');
  staggeredSweep.fn();
  assert.equal(sweeps, 1);

  // And re-runs on the periodic interval (prune interval first, sweep second).
  assert.equal(intervals.length, 2, 'both the prune and the sweep have periodic intervals');
  assert.ok(intervals.every((entry) => entry.ms === 30 * 60 * 1000));
  intervals[1].fn();
  assert.equal(sweeps, 2, 'the sweep interval re-invokes the retention pass');
});

test('the ipc-payload sweep counts references from every session, on tool_call AND tool_result', () => {
  // external_payloads lives on BOTH carriers; a scan that walks only tool
  // results under-counts and would delete a file a live tool_use still needs.
  const { ipcPayloadStore } = runPayloadSweep(createFakeSessionStore([
    { id: 's1', updated_at: 'T1', message_count: 1, messages: [payloadToolCallMessage('a.json')] },
    { id: 's2', updated_at: 'T1', message_count: 1, messages: [payloadToolResultMessage('b.json')] },
  ]));
  assert.deepEqual(ipcPayloadStore.calls, [['a.json', 'b.json']]);
});

test('a session that cannot be read aborts the ipc-payload sweep instead of pruning', () => {
  // peekSession returns null for an unreadable file, a quarantined corrupt one,
  // AND a future-schema freeze. Contributing [] for any of those would mark
  // every payload of that session an orphan, so the sweep must prune NOTHING.
  const sessionStore = createFakeSessionStore([
    { id: 's1', updated_at: 'T1', message_count: 1, messages: [payloadToolCallMessage('a.json')] },
  ]);
  sessionStore.listSessions = () => [
    { id: 's1', updated_at: 'T1', message_count: 1 },
    { id: 's2', updated_at: 'T1', message_count: 1 },
  ];

  const { ipcPayloadStore, logs } = runPayloadSweep(sessionStore);

  assert.deepEqual(ipcPayloadStore.calls, []);
  const warnings = logs.filter(([level]) => level === 'WARN');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][1], 'ipc_payloads.orphan_sweep_failed');
});

test('the ipc-payload sweep runs once at startup and arms no repeating interval', () => {
  // Crash orphans are a per-launch concern and session deletion collects the
  // referenced ones live, so a 30-minute interval would re-read every session
  // body to find nothing.
  const { intervals, timers } = runPayloadSweep(createFakeSessionStore([
    { id: 's1', updated_at: 'T1', message_count: 1, messages: [payloadToolCallMessage('a.json')] },
  ]), { fire: false });
  assert.deepEqual(intervals, []);
  assert.deepEqual(timers.map((timer) => timer.ms), [8000]);
});

test('the ipc-payload sweep is inert without a payload store', () => {
  const backend = createFakeBackend('ready');
  backend.sessionStore = createFakeSessionStore([]);
  const timers = [];
  scheduleStartupRetentionTasks({
    backendService: backend,
    setTimeoutRef: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
    setIntervalRef: () => ({ unref() {} }),
  });
  assert.deepEqual(timers, []);
});

test('a quarantined session that came back as an empty stub aborts the sweep', () => {
  // THE case a null check misses. A corrupt session file is quarantined and
  // re-seeded as a stub with messages: [] -- peekSession returns that record
  // successfully, so a guard that only rejects null accepts a zero-reference
  // answer for a session whose payloads are still live in the quarantined bytes.
  // The index summary still carries the pre-quarantine message_count, which is
  // the only evidence available that the read was incomplete.
  const sessionStore = createFakeSessionStore([
    { id: 's1', updated_at: 'T1', message_count: 1, messages: [payloadToolCallMessage('a.json')] },
    { id: 'quarantined', updated_at: 'T1', message_count: 4, messages: [] },
  ]);

  const { ipcPayloadStore, logs } = runPayloadSweep(sessionStore);

  assert.deepEqual(ipcPayloadStore.calls, []);
  assert.equal(logs.filter(([level]) => level === 'WARN').length, 1);
});

test('a genuinely empty session does not abort the sweep', () => {
  // The stub guard keys on the index DISAGREEING with the body. A session the
  // index also reports as empty is a normal new session and must not wedge
  // retention forever.
  const { ipcPayloadStore } = runPayloadSweep(createFakeSessionStore([
    { id: 's1', updated_at: 'T1', message_count: 1, messages: [payloadToolCallMessage('a.json')] },
    { id: 'fresh', updated_at: 'T1', message_count: 0, messages: [] },
  ]));
  assert.deepEqual(ipcPayloadStore.calls, [['a.json']]);
});

test('the startup sweep keeps the default grace window', () => {
  // Opposite of the delete path, which passes graceMs: 0. Here a payload may
  // have been written moments ago by a turn still in flight, so the store's
  // default one-hour grace must reach it -- asserted because the fake would
  // otherwise swallow any options regression silently.
  const { ipcPayloadStore } = runPayloadSweep(createFakeSessionStore([
    { id: 's1', updated_at: 'T1', message_count: 1, messages: [payloadToolCallMessage('a.json')] },
  ]));
  assert.deepEqual(ipcPayloadStore.options, [undefined]);
});

test('an unreadable session aborts the ATTACHMENT prune too, not just the payload one', () => {
  // Same asymmetry, same data: deleting an attachment a live session still
  // references destroys user data exactly as deleting a payload does. The
  // reader used to return [] here, so the attachment sweep pruned against an
  // under-counted set.
  const sessionStore = createFakeSessionStore([
    { id: 's1', updated_at: 'T1', message_count: 1, messages: [attachmentMessage('one')] },
  ]);
  sessionStore.listSessions = () => [
    { id: 's1', updated_at: 'T1', message_count: 1 },
    { id: 'gone', updated_at: 'T1', message_count: 2 },
  ];
  const backend = createFakeBackend('ready');
  backend.sessionStore = sessionStore;
  const pruned = [];
  const timers = [];
  scheduleStartupRetentionTasks({
    backendService: backend,
    attachmentAssetStore: {
      pruneUnreferencedAssets(referenced) {
        pruned.push(referenced);
        return { deletedCount: 0 };
      },
    },
    setTimeoutRef: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
    setIntervalRef: () => ({ unref() {} }),
  });
  for (const timer of timers) timer.fn();
  assert.deepEqual(pruned, []);
});

test('both prunes ride one walk of the session bodies', () => {
  // They were two staggered tasks, each doing a full cache-neutral read of every
  // session. `reads` records one entry per peekSession call, so a second walk
  // shows up as a duplicated id.
  const sessionStore = createFakeSessionStore([
    { id: 's1', updated_at: 'T1', message_count: 1, messages: [payloadToolCallMessage('a.json')] },
    { id: 's2', updated_at: 'T1', message_count: 1, messages: [attachmentMessage('one')] },
  ]);
  const backend = createFakeBackend('ready');
  backend.sessionStore = sessionStore;
  backend.ipcPayloadStore = createFakePayloadStore();
  const timers = [];
  scheduleStartupRetentionTasks({
    backendService: backend,
    attachmentAssetStore: { pruneUnreferencedAssets: () => ({ deletedCount: 0 }) },
    setTimeoutRef: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
    setIntervalRef: () => ({ unref() {} }),
  });
  for (const timer of timers) timer.fn();
  assert.deepEqual(sessionStore.reads, ['s1', 's2']);
});
