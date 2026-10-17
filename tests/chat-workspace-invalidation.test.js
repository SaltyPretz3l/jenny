'use strict';

/* Invalidation sources and persistence for the chat workspace service (row 59
 * checkpoint 2): the per-session coalescing notifier (at most four a second),
 * the chat-stream, workspace-watcher and Test Runner hooks, the section failure
 * boundary and the real coordination store round trip. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ChatWorkspaceService } = require('../services/chat-workspace-service');
const { createChangeNotifier } = require('../services/chat-workspace-change-notifier');
const {
  OTHER,
  ROOT,
  SESSION,
  artifact,
  authorityOf,
  fakeChanges,
  fakeStore,
  fakeViewStore,
  makeService,
  req,
} = require('./helpers/chat-workspace-fixtures');

test('the notifier emits a quiet session at once and holds a burst to at most four a second with the latest revision', () => {
  const clock = { ms: 1_000_000 };
  const timers = [];
  const emitted = [];
  let revision = 0;
  const notifier = createChangeNotifier({
    emit: (event) => emitted.push({ ...event, at: clock.ms }),
    getRevision: () => revision,
    now: () => clock.ms,
    setTimer: (fn, ms) => { const timer = { fn, due: clock.ms + ms }; timers.push(timer); return timer; },
    clearTimer: (timer) => { timer.cleared = true; },
  });
  const pump = () => {
    for (const timer of timers.filter((candidate) => !candidate.cleared && !candidate.done && candidate.due <= clock.ms)) {
      timer.done = true;
      timer.fn();
    }
  };
  for (let step = 0; step < 100; step += 1) { // 1 s of chatter, one invalidation every 10 ms
    revision += 1;
    notifier.notify('s1');
    clock.ms += 10;
    pump();
  }
  clock.ms += 300;
  pump();
  const inFirstSecond = emitted.filter((event) => event.at < 1_000_000 + 1000);
  assert.ok(inFirstSecond.length <= 4, `emitted ${inFirstSecond.length}`);
  assert.ok(emitted.length >= 4);
  assert.equal(emitted[0].at, 1_000_000, 'the first invalidation is not delayed');
  assert.equal(emitted[emitted.length - 1].revision, revision, 'a trailing emit carries the latest revision');
  assert.deepEqual(Object.keys(emitted[0]).sort(), ['at', 'revision', 'schema_version', 'session_id']);

  const before = emitted.length;
  notifier.notify('s2');
  assert.equal(emitted.length, before + 1, 'sessions are limited independently');
  notifier.notify('s2');
  notifier.dispose();
  clock.ms += 1000;
  pump();
  assert.equal(emitted.length, before + 1, 'dispose cancels the pending trailing emit');
  notifier.notify('s3');
  assert.equal(emitted.length, before + 1, 'a disposed notifier is inert');
});

test('chat-stream hooks: terminal events and artifact results invalidate; deltas and foreign events do not', async () => {
  const { service, events } = makeService();
  service.handleChatStreamEvent({ type: 'delta', sessionId: SESSION });
  service.handleChatStreamEvent({ type: 'tool_use', sessionId: SESSION });
  service.handleChatStreamEvent({ type: 'tool_result', sessionId: SESSION, generatedArtifacts: [] });
  service.handleChatStreamEvent({ type: 'complete' });
  service.handleChatStreamEvent(null);
  assert.equal(events.length, 0);
  service.handleChatStreamEvent({ type: 'complete', sessionId: SESSION });
  assert.equal(events.length, 1);
  service.handleChatStreamEvent({ type: 'tool_result', sessionId: OTHER, generatedArtifacts: [artifact('a', 'A')] });
  assert.deepEqual(events.map((event) => event.session_id), [SESSION, OTHER]);
});

test('a terminal event expires the Changes cache and a new artifact result drops the outputs cache', async () => {
  const messages = [{ tool_result: { generated_artifacts: [artifact('a1', 'One')] } }];
  const { service, store, changes } = makeService({ storeOptions: { messages }, changesFreshMs: 60_000 });
  await service.getSummary(req());
  await service.getSummary(req());
  assert.deepEqual([store.peeks.count, changes.calls.list], [1, 1]);
  service.handleChatStreamEvent({ type: 'complete', sessionId: SESSION });
  await service.getSummary(req());
  assert.deepEqual([store.peeks.count, changes.calls.list], [1, 2]);
  messages.push({ tool_result: { generated_artifacts: [artifact('a2', 'Two')] } });
  service.handleChatStreamEvent({ type: 'tool_result', sessionId: SESSION, generatedArtifacts: [artifact('a2', 'Two')] });
  const summary = (await service.getSummary(req())).summary;
  assert.equal(store.peeks.count, 2);
  assert.equal(summary.outputs.data.total_count, 2);
});

test('a change during a Git read leaves that read stale: the session is told again and the next read rescans', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const changes = fakeChanges({ list: (count) => (count === 1 ? gate.then(() => ({ state: 'available', reason: null, sampled_at: null, data: { files: [], file_count: 0, additions: 0, deletions: 0 } })) : { state: 'available', reason: null, sampled_at: null, data: { files: [], file_count: 3, additions: 3, deletions: 0 } }) });
  const { service, events } = makeService({ changes, changesFreshMs: 60_000 });
  const first = service.listChanges(req());
  await new Promise((resolve) => setImmediate(resolve));
  service.handleChatStreamEvent({ type: 'complete', sessionId: SESSION });
  assert.equal(events.length, 1, 'the change itself invalidates');
  release();
  assert.equal((await first).data.file_count, 0, 'the in-flight read answers with what it saw');
  assert.equal(events.length, 2, 'and the session is invalidated again once that read lands');
  assert.equal((await service.listChanges(req())).data.file_count, 3, 'the follow-up read is not served from the stale record');
  assert.equal(changes.calls.list, 2);
});

test('workspace fs and git-meta events invalidate only watched sessions of that root', async () => {
  const { service, events } = makeService({
    captureAuthority: (id) => authorityOf({ root_id: id === SESSION ? 'root_a' : 'root_b' }),
  });
  await service.getSummary(req());
  await service.getSummary({ schema_version: 1, session_id: OTHER });
  service.handleWorkspaceChange({ context: { rootId: 'root_a', generation: 1 }, changes: [] });
  assert.deepEqual(events.map((event) => event.session_id), [SESSION]);
  service.handleWorkspaceChange({ context: { rootId: 'root_unknown' } });
  assert.equal(events.length, 1);
  service.handleWorkspaceChange({ context: null });
  assert.equal(events.length, 3, 'an unidentified root invalidates every watched session');
  assert.doesNotThrow(() => service.handleWorkspaceChange(undefined));
});

test('Test Runner activity invalidates only the sessions whose rows changed', async () => {
  const rows = [{ runId: 'r1', state: 'running', updatedAt: 't1', scope: { session_id: SESSION, project_id: 'project_a' } }];
  let listener = null;
  const testSource = {
    getActivityRuns: () => rows,
    subscribeActivity: (fn) => { listener = fn; return () => { listener = null; }; },
  };
  const { service, events } = makeService({ activityEnabled: true, testSource });
  await service.getSummary(req());
  assert.equal(typeof listener, 'function', 'subscribed lazily on the first summary');
  listener();
  assert.deepEqual(events.map((event) => event.session_id), [SESSION]);
  listener();
  assert.equal(events.length, 1, 'no change, no invalidation');
  rows[0] = { ...rows[0], state: 'finished', updatedAt: 't2' };
  rows.push({ runId: 'r2', state: 'running', updatedAt: 't1', scope: { session_id: OTHER, project_id: 'project_a' } });
  listener();
  assert.deepEqual(events.map((event) => event.session_id), [SESSION, SESSION, OTHER]);
  service.dispose();
  assert.equal(listener, null, 'dispose unsubscribes');
});

test('without the activity flag no subscription is made', async () => {
  let subscribed = 0;
  const testSource = { getActivityRuns: () => [], subscribeActivity: () => { subscribed += 1; return () => {}; } };
  const { service } = makeService({ activityEnabled: false, testSource });
  await service.getSummary(req());
  assert.equal(subscribed, 0);
});

test('a section builder failure degrades that section only', async () => {
  const store = fakeStore();
  store.peekSessionMessages = () => { throw new Error('transcript exploded'); };
  const { service } = makeService({ store });
  const summary = (await service.getSummary(req())).summary;
  assert.deepEqual([summary.outputs.state, summary.outputs.reason], ['unavailable', 'transcript_unavailable']);
  assert.equal(summary.context.state, 'available');
  assert.equal(summary.environment.state, 'available');
});

test('real coordination store: setView persists through flush and a stale revision conflicts', async () => {
  const { ElectronSessionStore } = require('../services/backend/electron-session-store');
  const { createWorkspaceViewStore } = require('../services/backend/session-coordination-records');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-chatws-store-'));
  const store = new ElectronSessionStore(path.join(dir, 'sessions.json'));
  try {
    const created = store.createSession({ title: 'rail' });
    const id = created.id;
    const service = new ChatWorkspaceService({
      viewStore: createWorkspaceViewStore(store),
      getStore: () => store,
      captureAuthority: () => authorityOf(),
      resolveGitService: () => ({}),
      changeSummary: fakeChanges(),
      emit: () => {},
      notifierOptions: { intervalMs: 0 },
    });
    const first = await service.getSummary({ schema_version: 1, session_id: id });
    assert.equal(first.ok, true);
    assert.equal(first.coordination_revision, 0);
    const written = await service.setView({
      schema_version: 1, session_id: id, expected_revision: 0, patch: { rail_visible: false, disclosures: { changes: true } },
    });
    assert.equal(written.ok, true);
    assert.equal(written.coordination_revision, 1);
    assert.equal(written.workspace_view.rail_visible, false);
    assert.equal(written.workspace_view.disclosures.changes, true);
    const stale = await service.setView({ schema_version: 1, session_id: id, expected_revision: 0, patch: { rail_visible: true } });
    assert.deepEqual([stale.ok, stale.reason, stale.current_revision], [false, 'revision_conflict', 1]);
    const bad = await service.setView({ schema_version: 1, session_id: id, expected_revision: 1, patch: { rail_visible: 'yes' } });
    assert.deepEqual([bad.ok, bad.reason], [false, 'invalid_patch']);
    const unknownKey = await service.setView({ schema_version: 1, session_id: id, expected_revision: 1, patch: { sneaky: true } });
    assert.equal(unknownKey.ok, false);
    const reread = await service.getSummary({ schema_version: 1, session_id: id });
    assert.equal(reread.summary.revision, 1);
    assert.equal(reread.workspace_view.rail_visible, false);
  } finally {
    store.dispose?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
