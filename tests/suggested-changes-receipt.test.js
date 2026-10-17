'use strict';

// A19-F4: an Accept the sidecar applied (and journaled) but whose Electron
// receipt failed to save must stay discoverable: the apply attempt is recorded
// before dispatch, the unsaved receipt folds in on the next read (so History
// and Undo see the change set), and an attempt that never settled is visible.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SuggestedChangesService } = require('../services/backend/suggested-changes-service');
const records = require('../services/backend/suggested-changes-records');
const { createSuggestedChangesService } = require('../services/backend/suggested-changes-wiring');
const model = require('../renderer/features/renderer-suggested-changes-model');

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;
const CHANGE_SET_ID = '01990f9a-8c51-7ad2-a8be-41190e0e2525';

function fakeStore() {
  const sessions = new Map([['sess_1', { id: 'sess_1', suggested_changes: records.emptySuggestedChanges() }]]);
  return {
    sessions,
    failWrites: false,
    getSession(id) {
      const session = sessions.get(id);
      return session ? JSON.parse(JSON.stringify(session)) : null;
    },
    _updateSessionRecord(id, patch) {
      if (this.failWrites) return null;
      sessions.set(id, { ...sessions.get(id), ...JSON.parse(JSON.stringify(patch)) });
      return { id };
    },
    saved() {
      return sessions.get('sess_1').suggested_changes;
    },
  };
}

function makeService(store, applyRequest) {
  let tick = 0;
  return new SuggestedChangesService({
    getStore: () => store,
    projectAuthority: { captureSession: () => ({ root_path: 'C:/ws', device_id: '1', inode: '2' }) },
    applyRequest,
    now: () => new Date(Date.UTC(2026, 9, 5, 12, 0, tick++)).toISOString(),
  });
}

function capture(service) {
  return service.recordToolOutcome({
    toolName: 'propose_change', sessionId: 'sess_1', callId: 'call_1', turnId: 'turn_1',
    result: {
      isError: false,
      metadata: {
        suggested_change: {
          schema_version: 1, path: 'src/a.js', kind: 'replace', old_string: 'one', new_string: 'two',
          title: 'Use two', what: 'It says two.', why: 'Asked.', watch_for: '', revises: null, base_hash: HASH_A, diff: null,
        },
      },
    },
  });
}

const applied = (request) => ({
  schema_version: 1, status: 'applied', workspace_change_set: { change_set_id: CHANGE_SET_ID },
  items: [{ suggestion_id: request.items[0].suggestion_id, outcome: 'applied', after_hash: HASH_B, diff: null }],
});

test('the apply attempt is saved before dispatch, and an unsaved receipt folds in on the next read', async () => {
  const store = fakeStore();
  let seenBeforeDispatch = null;
  const service = makeService(store, async (request) => {
    seenBeforeDispatch = store.saved().entries[0].apply_attempt;
    store.failWrites = true; // the receipt save that follows fails
    return applied(request);
  });
  const entry = capture(service);

  const result = await service.accept({ sessionId: 'sess_1', id: entry.id, revision: 1 });

  assert.equal(seenBeforeDispatch.revision, 1);
  assert.match(seenBeforeDispatch.apply_id, /^[0-9a-f-]{36}$/);
  assert.equal(result.receipt_saved, false);
  assert.equal(store.saved().entries[0].status, 'to_review', 'nothing settled on disk yet');

  store.failWrites = false;
  const view = service.list('sess_1');
  assert.equal(view.entries[0].status, 'applied');
  assert.equal(view.entries[0].applied.change_set_id, CHANGE_SET_ID, 'History and Undo can find the change set');
  assert.equal(view.entries[0].apply_attempt, null);
  assert.equal(store.saved().entries[0].applied.change_set_id, CHANGE_SET_ID, 'the reconciled receipt is saved');
  assert.equal(service.list('sess_1').entries[0].status, 'applied', 'folding again changes nothing');
});

test('a rejected apply-attempt save stops before the sidecar writes anything', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-sc-attempt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'a.js');
  fs.writeFileSync(file, 'one\n');
  const store = fakeStore();
  let calls = 0;
  const service = makeService(store, async (request) => {
    calls += 1;
    fs.writeFileSync(file, 'two\n'); // what the sidecar would write
    return applied(request);
  });
  const entry = capture(service);
  store.failWrites = true; // the pre-dispatch attempt save is rejected

  const result = await service.accept({ sessionId: 'sess_1', id: entry.id, revision: 1 });

  assert.deepEqual(result, { ok: false, error: 'write_failed' });
  assert.equal(calls, 0, 'nothing was dispatched to the sidecar');
  assert.equal(fs.readFileSync(file, 'utf8'), 'one\n', 'workspace bytes are unchanged');
  store.failWrites = false;
  assert.equal(service.list('sess_1').entries[0].status, 'to_review');
  assert.equal(service.list('sess_1').entries[0].apply_attempt, null);
});

// The live wiring against a stub sidecar whose journal records each apply's
// session and apply id, like `owned_mutation_attribution` (turn_id = apply_id).
function wiredBackend(store) {
  const journal = [];
  const backendService = {
    sessionStore: store,
    projectAuthority: { captureSession: () => ({ root_path: path.resolve('jenny-sc-root'), device_id: '1', inode: '2' }) },
    sidecarClient: {
      sent: [],
      async request(method, params) {
        this.sent.push({ method, params });
        if (method === 'workspace.apply_suggested_changes') {
          journal.push({ change_set_id: CHANGE_SET_ID, state: 'committed', session_id: params.session_id, turn_id: params.apply_id });
          store.failWrites = true; // the receipt save that follows fails, then the app exits
          return {
            schema_version: 1, status: 'applied', workspace_change_set: { change_set_id: CHANGE_SET_ID },
            items: params.items.map((item) => ({ suggestion_id: item.suggestion_id, outcome: 'applied', reason: null, after_hash: HASH_B, diff: null, base_hash: null })),
          };
        }
        if (method === 'workspace.list_change_sets') {
          return { workspace_id: 'ws', change_sets: journal.map((item) => ({ ...item })), outside_undo_set: {} };
        }
        throw new Error(`unexpected method ${method}`);
      },
    },
  };
  return { backendService, journal };
}

async function applyThenLoseTheReceipt(store, backendService) {
  const first = createSuggestedChangesService({ backendService });
  const entry = capture(first);
  const result = await first.accept({ sessionId: 'sess_1', id: entry.id, revision: 1 });
  assert.equal(result.receipt_saved, false);
  store.failWrites = false;
  return entry;
}

test('an apply whose receipt never saved is reconciled from the journal after a restart', async () => {
  const store = fakeStore();
  const { backendService } = wiredBackend(store);
  await applyThenLoseTheReceipt(store, backendService);
  const sentApplyId = backendService.sidecarClient.sent[0].params.apply_id;
  assert.equal(store.saved().entries[0].apply_attempt.apply_id, sentApplyId, 'the saved attempt names the id the sidecar journaled');

  const restarted = createSuggestedChangesService({ backendService });
  restarted.list('sess_1');
  await restarted.reconcileApplyAttempts('sess_1');
  const view = restarted.list('sess_1');

  assert.equal(view.entries[0].status, 'applied');
  assert.equal(view.entries[0].applied.change_set_id, CHANGE_SET_ID);
  assert.equal(view.entries[0].apply_attempt, null);
  assert.equal(store.saved().entries[0].applied.change_set_id, CHANGE_SET_ID, 'the reconciled receipt is saved');
  const history = model.buildAppliedHistory(view);
  assert.equal(history.turns.length, 1, 'History shows the applied change');
  assert.deepEqual(history.turns[0].changeSetIds, [CHANGE_SET_ID], 'and Undo finds its change set');
});

// Formerly asserted `to_review` for the case above too, which pinned the
// defect; an attempt the journal does not know still stays visible.
test('an attempt the journal does not know stays visible after a restart', async () => {
  const store = fakeStore();
  const { backendService, journal } = wiredBackend(store);
  await applyThenLoseTheReceipt(store, backendService);
  journal.length = 0;

  const restarted = createSuggestedChangesService({ backendService });
  await restarted.reconcileApplyAttempts('sess_1');
  const view = restarted.list('sess_1');
  assert.equal(view.entries[0].status, 'to_review');
  assert.equal(view.entries[0].apply_attempt.revision, 1);
});

// Journals per workspace: a list without root authority reads the sidecar's
// configured folder; with it, that folder, refused while it is unavailable.
function twoWorkspaceBackend(store) {
  const rootA = path.resolve('jenny-sc-root-a');
  const rootB = path.resolve('jenny-sc-root-b');
  const journals = new Map([[rootA, []], [rootB, []]]);
  const world = { configured: rootA, available: new Set([rootA, rootB]), projectUnavailable: false, lists: [] };
  const backendService = {
    sessionStore: store,
    projectAuthority: {
      captureSession: () => {
        if (world.projectUnavailable) throw Object.assign(new Error('project unavailable'), { code: 'CMP-PROJ-0003' });
        return { root_path: rootA, device_id: '1', inode: '2' };
      },
    },
    sidecarClient: {
      async request(method, params) {
        if (method === 'workspace.apply_suggested_changes') {
          journals.get(params.workspace_root).push({ change_set_id: CHANGE_SET_ID, state: 'committed', session_id: params.session_id, turn_id: params.apply_id });
          store.failWrites = true;
          return {
            schema_version: 1, status: 'applied', workspace_change_set: { change_set_id: CHANGE_SET_ID },
            items: params.items.map((item) => ({ suggestion_id: item.suggestion_id, outcome: 'applied', reason: null, after_hash: HASH_B, diff: null, base_hash: null })),
          };
        }
        if (method === 'workspace.list_change_sets') {
          const root = params.workspace_root || world.configured;
          world.lists.push(params.workspace_root || null);
          if (params.workspace_root && !world.available.has(root)) {
            throw Object.assign(new Error('Workspace root changed.'), { rpc: { data: { reason: 'workspace_root_changed' } } });
          }
          return { workspace_id: 'ws', change_sets: journals.get(root).map((item) => ({ ...item })), outside_undo_set: {} };
        }
        throw new Error(`unexpected method ${method}`);
      },
    },
  };
  return { backendService, world, rootA, rootB };
}

test('receipt recovery asks the workspace the apply ran in, and retries once it is available again', async () => {
  const store = fakeStore();
  const { backendService, world, rootA, rootB } = twoWorkspaceBackend(store);
  await applyThenLoseTheReceipt(store, backendService);

  // Restart with project B configured and A's folder unavailable.
  world.configured = rootB;
  world.available.delete(rootA);
  const restarted = createSuggestedChangesService({ backendService });
  await restarted.reconcileApplyAttempts('sess_1');
  assert.equal(restarted.list('sess_1').entries[0].status, 'to_review'); // this read retries the lookup
  await restarted.reconcileApplyAttempts('sess_1');
  assert.ok(world.lists.length >= 2, 'a refused lookup is not remembered as a miss');
  assert.ok(world.lists.every((root) => root === rootA), 'every lookup names the apply\'s workspace, never the configured one');

  // The session's project itself is unavailable for a while: no lookup at all.
  world.projectUnavailable = true;
  const seen = world.lists.length;
  await restarted.reconcileApplyAttempts('sess_1');
  assert.equal(world.lists.length, seen);

  // Back to the original workspace: the next read recovers History and Undo.
  world.projectUnavailable = false;
  world.available.add(rootA);
  await restarted.reconcileApplyAttempts('sess_1');
  const view = restarted.list('sess_1');
  assert.equal(world.lists.length, seen + 1);
  assert.equal(view.entries[0].status, 'applied');
  assert.deepEqual(model.buildAppliedHistory(view).turns[0].changeSetIds, [CHANGE_SET_ID]);
});

// The journal lookup is held open while the person acts on the entry the
// list still shows: the decision waits, and the applied change keeps its
// History/Undo association once the committed match arrives (A19-F4).
async function restartWithHeldLookup(store, backendService) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const request = backendService.sidecarClient.request.bind(backendService.sidecarClient);
  backendService.sidecarClient.request = async (method, params) => {
    if (method === 'workspace.list_change_sets') await gate;
    return request(method, params);
  };
  const restarted = createSuggestedChangesService({ backendService });
  const recovery = restarted.reconcileApplyAttempts('sess_1');
  await new Promise((resolve) => setImmediate(resolve));
  return { restarted, recovery, release };
}

function assertAppliedInHistory(view) {
  const entry = view.entries.find((item) => item.applied);
  assert.equal(entry?.status, 'applied');
  assert.equal(entry.applied.change_set_id, CHANGE_SET_ID);
  const history = model.buildAppliedHistory(view);
  assert.equal(history.turns.length, 1, 'History shows the applied change');
  assert.deepEqual(history.turns[0].changeSetIds, [CHANGE_SET_ID], 'and Undo finds its change set');
}

test('a reject during receipt recovery waits, and the applied change stays in History with Undo', async () => {
  const store = fakeStore();
  const { backendService } = wiredBackend(store);
  const entry = await applyThenLoseTheReceipt(store, backendService);
  const { restarted, recovery, release } = await restartWithHeldLookup(store, backendService);

  assert.equal(restarted.list('sess_1').entries[0].status, 'to_review', 'the list still shows the entry');
  const decided = restarted.decide({ sessionId: 'sess_1', id: entry.id, decision: 'reject' });
  const accepted = await restarted.accept({ sessionId: 'sess_1', id: entry.id, revision: 1 });
  release();
  await recovery;

  assert.deepEqual(decided, { ok: false, error: 'busy' });
  assert.deepEqual(accepted, { ok: false, error: 'busy' });
  const view = restarted.list('sess_1');
  assertAppliedInHistory(view);
  assert.equal(view.entries[0].apply_attempt, null);
  assert.equal(store.saved().entries[0].applied.change_set_id, CHANGE_SET_ID, 'the recovered receipt is saved');
});

test('a revision arriving during receipt recovery lands after it, beside the applied change', async () => {
  const store = fakeStore();
  const { backendService } = wiredBackend(store);
  const entry = await applyThenLoseTheReceipt(store, backendService);
  const { restarted, recovery, release } = await restartWithHeldLookup(store, backendService);

  restarted.recordToolOutcome({
    toolName: 'propose_change', sessionId: 'sess_1', callId: 'call_2', turnId: 'turn_2',
    result: {
      isError: false,
      metadata: {
        suggested_change: {
          schema_version: 1, path: 'src/a.js', kind: 'replace', old_string: 'two', new_string: 'three',
          title: 'Use three', what: 'It says three.', why: 'Asked again.', watch_for: '', revises: entry.id, base_hash: HASH_B, diff: null,
        },
      },
    },
  });
  release();
  await recovery;

  const view = restarted.list('sess_1');
  assertAppliedInHistory(view);
  assert.equal(view.entries.length, 2, 'the revision is recorded as its own suggestion');
  assert.equal(view.entries.find((item) => !item.applied).new_string, 'three');
});

// w2f5-R3: the reconciliation save fails once after the committed match came
// back. The queued revision stays held (it would clear the attempt the next
// reconciliation retries), and lands beside the applied change after the retry.
test('a revision held by a recovery whose save failed waits for the retry, then lands beside the applied change', async () => {
  const store = fakeStore();
  const { backendService } = wiredBackend(store);
  const entry = await applyThenLoseTheReceipt(store, backendService);
  const { restarted, recovery, release } = await restartWithHeldLookup(store, backendService);
  restarted.recordToolOutcome({
    toolName: 'propose_change', sessionId: 'sess_1', callId: 'call_2', turnId: 'turn_2',
    result: {
      isError: false,
      metadata: {
        suggested_change: {
          schema_version: 1, path: 'src/a.js', kind: 'replace', old_string: 'two', new_string: 'three',
          title: 'Use three', what: 'It says three.', why: 'Asked again.', watch_for: '', revises: entry.id, base_hash: HASH_B, diff: null,
        },
      },
    },
  });
  const update = store._updateSessionRecord.bind(store);
  let failNext = true;
  store._updateSessionRecord = (id, patch) => {
    if (failNext) {
      failNext = false;
      return null;
    }
    return update(id, patch);
  };
  release();
  await recovery;

  assert.equal(failNext, false, 'the reconciliation save was attempted and failed');
  assert.equal(store.saved().entries.length, 1, 'the revision is still held');
  assert.equal(store.saved().entries[0].apply_attempt?.revision, 1, 'the attempt the retry needs is kept');
  assert.deepEqual(restarted.decide({ sessionId: 'sess_1', id: entry.id, decision: 'reject' }), { ok: false, error: 'busy' });

  await restarted.reconcileApplyAttempts('sess_1');

  const view = restarted.list('sess_1');
  assertAppliedInHistory(view);
  assert.equal(view.entries.length, 2, 'the revision is recorded as its own suggestion');
  assert.equal(view.entries.find((item) => !item.applied).new_string, 'three');
  assert.equal(store.saved().entries.find((item) => item.applied)?.applied.change_set_id, CHANGE_SET_ID, 'the applied association is saved');
});

// w2f6-R1: after the failed save the journal listing omits the record (a read
// error skips it). The remembered match is saved again without a lookup, so the
// applied History entry and the queued proposal both survive.
test('a recovery whose save failed is saved on retry even when the journal no longer lists the record', async () => {
  const store = fakeStore();
  const { backendService, journal } = wiredBackend(store);
  const entry = await applyThenLoseTheReceipt(store, backendService);
  const { restarted, recovery, release } = await restartWithHeldLookup(store, backendService);
  restarted.recordToolOutcome({
    toolName: 'propose_change', sessionId: 'sess_1', callId: 'call_2', turnId: 'turn_2',
    result: {
      isError: false,
      metadata: {
        suggested_change: {
          schema_version: 1, path: 'src/a.js', kind: 'replace', old_string: 'two', new_string: 'three',
          title: 'Use three', what: 'It says three.', why: 'Asked again.', watch_for: '', revises: entry.id, base_hash: HASH_B, diff: null,
        },
      },
    },
  });
  const update = store._updateSessionRecord.bind(store);
  let failNext = true;
  store._updateSessionRecord = (id, patch) => {
    if (failNext) {
      failNext = false;
      return null;
    }
    return update(id, patch);
  };
  release();
  await recovery;
  assert.equal(failNext, false, 'the reconciliation save was attempted and failed');
  assert.equal(store.saved().entries[0].apply_attempt?.revision, 1, 'the attempt is kept');

  journal.length = 0; // the record is missing from the next listing
  await restarted.reconcileApplyAttempts('sess_1');

  const view = restarted.list('sess_1');
  assertAppliedInHistory(view);
  assert.equal(view.entries.length, 2, 'the revision is recorded as its own suggestion');
  assert.equal(view.entries.find((item) => !item.applied).new_string, 'three');
  assert.equal(store.saved().entries.find((item) => item.applied)?.applied.change_set_id, CHANGE_SET_ID, 'the applied association is saved');
  assert.deepEqual(restarted.decide({ sessionId: 'sess_1', id: entry.id, decision: 'reject' }).ok, false, 'an applied entry is not decided again');
});

// Two open attempts after a restart: A's apply never answered (unknown to the
// journal), B applied but its receipt did not save. While A's lookup is held,
// B is already protected: a reject waits and a revision lands after it.
test('every attempt under recovery is protected before the first lookup, not only the one being asked', async () => {
  const store = fakeStore();
  const journal = [];
  const backendService = {
    sessionStore: store,
    projectAuthority: { captureSession: () => ({ root_path: path.resolve('jenny-sc-root'), device_id: '1', inode: '2' }) },
    sidecarClient: {
      async request(method, params) {
        if (method === 'workspace.apply_suggested_changes' && params.items[0].path === 'src/a.js') throw new Error('transport closed');
        if (method === 'workspace.apply_suggested_changes') {
          journal.push({ change_set_id: CHANGE_SET_ID, state: 'committed', session_id: params.session_id, turn_id: params.apply_id });
          store.failWrites = true;
          return {
            schema_version: 1, status: 'applied', workspace_change_set: { change_set_id: CHANGE_SET_ID },
            items: params.items.map((item) => ({ suggestion_id: item.suggestion_id, outcome: 'applied', reason: null, after_hash: HASH_B, diff: null, base_hash: null })),
          };
        }
        if (method === 'workspace.list_change_sets') return { workspace_id: 'ws', change_sets: journal.map((item) => ({ ...item })), outside_undo_set: {} };
        throw new Error(`unexpected method ${method}`);
      },
    },
  };
  const first = createSuggestedChangesService({ backendService });
  const suggest = (service, callId, file, extra = {}) => service.recordToolOutcome({
    toolName: 'propose_change', sessionId: 'sess_1', callId, turnId: 'turn_1',
    result: { isError: false, metadata: { suggested_change: {
      schema_version: 1, path: file, kind: 'replace', old_string: 'one', new_string: 'two',
      title: 'Use two', what: 'It says two.', why: 'Asked.', watch_for: '', revises: null, base_hash: HASH_A, diff: null, ...extra,
    } } },
  });
  const a = suggest(first, 'call_a', 'src/a.js');
  const b = suggest(first, 'call_b', 'src/b.js');
  assert.equal((await first.accept({ sessionId: 'sess_1', id: a.id, revision: 1 })).error, 'apply_failed');
  assert.equal((await first.accept({ sessionId: 'sess_1', id: b.id, revision: 1 })).receipt_saved, false);
  store.failWrites = false;
  assert.equal(store.saved().entries.filter((entry) => entry.apply_attempt).length, 2);

  const { restarted, recovery, release } = await restartWithHeldLookup(store, backendService);
  const decided = restarted.decide({ sessionId: 'sess_1', id: b.id, decision: 'reject' });
  suggest(restarted, 'call_b2', 'src/b.js', { revises: b.id, new_string: 'three', base_hash: HASH_B });
  release();
  await recovery;

  assert.deepEqual(decided, { ok: false, error: 'busy' });
  const view = restarted.list('sess_1');
  assertAppliedInHistory(view);
  assert.equal(view.entries.find((entry) => entry.id === b.id).status, 'applied');
  assert.equal(view.entries.find((entry) => entry.id === a.id).apply_attempt.revision, 1, 'the unknown attempt stays open');
  assert.equal(view.entries.find((entry) => entry.new_string === 'three').status, 'to_review', 'the revision is its own suggestion');
});
