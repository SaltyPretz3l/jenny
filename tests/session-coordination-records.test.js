'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  COORDINATION_FIELDS,
  DISCLOSURE_KEYS,
  applyCoordinationDefaults,
  createWorkspaceViewStore,
  isCoordinationContainerFrozen,
  normalizeChatProposals,
  normalizeCoordinationReceipts,
  normalizeCoordinationRevision,
  normalizeSessionMail,
  normalizeSpawnedFrom,
  normalizeWorkspaceView,
  stripCoordinationFields,
  validateWorkspaceViewPatch,
} = require('../services/backend/session-coordination-records');
const { ElectronSessionStore, STORE_SCHEMA_VERSION } = require('../services/backend/electron-session-store');
const { exportSession, importSession } = require('../services/backend/session-export-import');

const SPAWNED = {
  schema_version: 1,
  parent_session_id: 'sess_parent',
  parent_session_incarnation: 'inc_parent',
  proposal_id: `proposal_${'a'.repeat(64)}`,
  created_at: '2026-10-15T10:00:00.000Z',
  child_creation_hash: 'b'.repeat(64),
  reporting_consent_id: '11111111-1111-4111-8111-111111111111',
};
const DEFAULT_VIEW = { schema_version: 1, rail_visible: null, disclosures: {}, children_expanded: null };
const DEFAULT_MAIL = {
  schema_version: 1,
  next_receive_sequence: 1,
  inbox: [],
  discarded: [],
  outbox: [],
  authorizations: [],
  report_reservations: [],
  admission_snapshots: [],
  reporting_enabled: false,
};

function tempProfile(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-coordination-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function openStore(root) {
  return new ElectronSessionStore(path.join(root, 'sessions.json'), { logger() {} });
}

// A store double with the dedicated record writer; `failFlush` models a disk error.
function createFakeStore(initial, { failFlush = false, failWrite = false, newerSchema = false } = {}) {
  const records = new Map([['sess_a', structuredClone(initial)]]);
  const calls = [];
  return {
    calls,
    records,
    peekSession: (id) => records.get(id) || null,
    getSession: (id) => (records.has(id) ? structuredClone(records.get(id)) : null),
    hasNewerSchema: () => newerSchema,
    _updateSessionRecord(id, patch, options) {
      calls.push({ op: 'update', id, patch: structuredClone(patch), options });
      if (failWrite || !records.has(id)) return null;
      records.set(id, { ...records.get(id), ...structuredClone(patch) });
      return { id };
    },
    flushSession(id) {
      calls.push({ op: 'flush', id });
      return !failFlush;
    },
  };
}

test('schema 26 is the current session store schema and names exactly the five disclosure keys', () => {
  assert.equal(STORE_SCHEMA_VERSION, 26);
  assert.deepEqual([...DISCLOSURE_KEYS], ['environment', 'context', 'outputs', 'changes', 'background_tasks']);
  assert.deepEqual([...COORDINATION_FIELDS].sort(), [
    'chat_proposals', 'coordination_receipts', 'coordination_revision',
    'session_mail', 'spawned_from', 'workspace_view',
  ]);
});

test('normalizeWorkspaceView defaults malformed values and never throws', () => {
  for (const bad of [undefined, null, 7, 'x', [], {}, { schema_version: 0 }, { schema_version: '1' },
    { schema_version: 1.5 }, { schema_version: -1 }, { rail_visible: true }]) {
    assert.deepEqual(normalizeWorkspaceView(bad), DEFAULT_VIEW, JSON.stringify(bad));
  }
});

test('normalizeWorkspaceView keeps booleans, drops unknown keys and non-boolean values', () => {
  const view = normalizeWorkspaceView({
    schema_version: 1,
    rail_visible: false,
    children_expanded: 'yes',
    unknown_top: 1,
    disclosures: { environment: true, context: false, outputs: 'open', changes: null, bogus: true, background_tasks: 1 },
  });
  assert.deepEqual(view, {
    schema_version: 1,
    rail_visible: false,
    disclosures: { environment: true, context: false },
    children_expanded: null,
  });
  assert.deepEqual(normalizeWorkspaceView({ schema_version: 1, disclosures: ['environment'] }), DEFAULT_VIEW);
});

test('normalizeWorkspaceView normalization is idempotent', () => {
  const once = normalizeWorkspaceView({
    schema_version: 1, rail_visible: true, disclosures: { changes: true }, children_expanded: false,
  });
  assert.deepEqual(normalizeWorkspaceView(once), once);
});

test('a workspace_view with an unknown future schema_version is preserved verbatim, cloned and frozen', () => {
  const future = { schema_version: 2, rail_visible: 'tri-state', extra: { deep: [1, 2] } };
  const kept = normalizeWorkspaceView(future);
  assert.deepEqual(kept, future);
  assert.notEqual(kept, future, 'preserved by value, not by shared reference');
  assert.equal(isCoordinationContainerFrozen(kept), true);
  assert.equal(isCoordinationContainerFrozen(normalizeWorkspaceView({ schema_version: 1 })), false);
  assert.equal(isCoordinationContainerFrozen(normalizeWorkspaceView('garbage')), false);
});

test('normalizeCoordinationRevision accepts only nonnegative safe integers', () => {
  assert.equal(normalizeCoordinationRevision(0), 0);
  assert.equal(normalizeCoordinationRevision(41), 41);
  for (const bad of [-1, 1.5, NaN, Infinity, '3', null, undefined, {}, Number.MAX_SAFE_INTEGER + 2]) {
    assert.equal(normalizeCoordinationRevision(bad), 0, String(bad));
  }
});

test('inert containers default when malformed and keep a well-formed v1 body as it is', () => {
  assert.equal(normalizeSpawnedFrom(undefined), null);
  assert.equal(normalizeSpawnedFrom('parent'), null);
  assert.equal(normalizeSpawnedFrom({ parent_session_id: 'p' }), null, 'missing schema_version is malformed');
  assert.equal(normalizeSpawnedFrom({ schema_version: 1, parent_session_id: 'sess_p' }), null, 'a v1 value is strict');
  assert.deepEqual(normalizeSpawnedFrom(SPAWNED), SPAWNED);

  assert.deepEqual(normalizeCoordinationReceipts('x'), []);
  assert.deepEqual(normalizeCoordinationReceipts(null), []);
  const receipts = [{ schema_version: 1, mutation_id: 'm1' }];
  assert.deepEqual(normalizeCoordinationReceipts(receipts), receipts);
  assert.notEqual(normalizeCoordinationReceipts(receipts), receipts);

  assert.deepEqual(normalizeChatProposals(null), { schema_version: 1, records: [], launch_grants: [] });
  assert.deepEqual(normalizeChatProposals({ schema_version: 1, records: 'bad' }),
    { schema_version: 1, records: [], launch_grants: [] });
  assert.deepEqual(
    normalizeChatProposals({ schema_version: 1, records: [{ id: 'p1' }], launch_grants: [{ id: 'g1' }], extra: 1 }),
    { schema_version: 1, records: [{ id: 'p1' }], launch_grants: [{ id: 'g1' }] },
    'unknown keys are dropped, arrays are kept'
  );

  assert.deepEqual(normalizeSessionMail(undefined), DEFAULT_MAIL);
  assert.deepEqual(normalizeSessionMail({ schema_version: 'one' }), DEFAULT_MAIL);
  assert.deepEqual(
    normalizeSessionMail({
      schema_version: 1, next_receive_sequence: 0, inbox: [{ id: 'i1' }], outbox: 'bad', reporting_enabled: 'yes',
    }),
    { ...DEFAULT_MAIL, inbox: [{ id: 'i1' }] },
    'sequence below 1, non-array lists and non-true flags fall back to defaults'
  );
  assert.equal(normalizeSessionMail({ schema_version: 1, next_receive_sequence: 9, reporting_enabled: true })
    .next_receive_sequence, 9);
});

test('inert containers with an unknown future nested version are preserved and report frozen', () => {
  const mail = { schema_version: 3, inbox: [{ weird: true }], novel: 'field' };
  const proposals = { schema_version: 2, records: 'future shape' };
  const spawned = { schema_version: 9, parent_session_id: 'sess_p', extra: 1 };
  assert.deepEqual(normalizeSessionMail(mail), mail);
  assert.deepEqual(normalizeChatProposals(proposals), proposals);
  assert.deepEqual(normalizeSpawnedFrom(spawned), spawned);
  assert.equal(isCoordinationContainerFrozen(normalizeSessionMail(mail)), true);
  assert.equal(isCoordinationContainerFrozen(normalizeChatProposals(proposals)), true);
  assert.equal(isCoordinationContainerFrozen(normalizeSpawnedFrom(spawned)), true);
  assert.equal(isCoordinationContainerFrozen([{ schema_version: 1 }, { schema_version: 2 }]), true);
  assert.equal(isCoordinationContainerFrozen([{ schema_version: 1 }]), false);
  assert.equal(isCoordinationContainerFrozen(null), false);
  assert.equal(isCoordinationContainerFrozen(normalizeSessionMail(undefined)), false);
});

test('applyCoordinationDefaults adds the six fields, preserves the rest and is idempotent', () => {
  const source = { id: 'sess_x', title: 'T', messages: [{ id: 'm' }] };
  const applied = applyCoordinationDefaults(source);
  assert.equal(Object.hasOwn(source, 'workspace_view'), false, 'input is not mutated');
  assert.deepEqual(applied, {
    ...source,
    spawned_from: null,
    coordination_revision: 0,
    coordination_receipts: [],
    chat_proposals: { schema_version: 1, records: [], launch_grants: [] },
    session_mail: DEFAULT_MAIL,
    workspace_view: DEFAULT_VIEW,
  });
  assert.deepEqual(applyCoordinationDefaults(applied), applied);
  assert.deepEqual(Object.keys(applyCoordinationDefaults(null)).sort(), [...COORDINATION_FIELDS].sort());
});

test('stripCoordinationFields removes only the six fields from a patch', () => {
  const patch = { title: 'keep', workspace_view: {}, coordination_revision: 9, session_mail: {}, spawned_from: {},
    chat_proposals: {}, coordination_receipts: [] };
  assert.deepEqual(stripCoordinationFields(patch), { title: 'keep' });
  assert.equal(stripCoordinationFields(null), null);
});

test('validateWorkspaceViewPatch is a closed schema', () => {
  assert.deepEqual(validateWorkspaceViewPatch({ rail_visible: false }), { ok: true, patch: { rail_visible: false } });
  assert.deepEqual(
    validateWorkspaceViewPatch({ children_expanded: true, disclosures: { outputs: true, changes: false } }),
    { ok: true, patch: { children_expanded: true, disclosures: { outputs: true, changes: false } } }
  );
  const invalid = [
    undefined, null, [], 'x', {}, { disclosures: {} },
    { rail_visible: null }, { rail_visible: 'true' }, { children_expanded: 1 },
    { rail_visible: true, extra: 1 }, { schema_version: 1 }, { coordination_revision: 3 },
    { disclosures: { bogus: true } }, { disclosures: { environment: 'open' } }, { disclosures: ['environment'] },
    { disclosures: null },
  ];
  for (const bad of invalid) {
    assert.deepEqual(validateWorkspaceViewPatch(bad), { ok: false, reason: 'invalid_patch' }, JSON.stringify(bad));
  }
  const hostile = JSON.parse('{"disclosures":{"__proto__":true}}');
  assert.deepEqual(validateWorkspaceViewPatch(hostile), { ok: false, reason: 'invalid_patch' });
});

test('a new session persists the six defaults and generic updateSession patches cannot write them', (t) => {
  const store = openStore(tempProfile(t));
  const created = store.createSession({ title: 'Plain' });
  const record = store.getSession(created.id);
  assert.deepEqual(
    Object.fromEntries(COORDINATION_FIELDS.map((key) => [key, record[key]])),
    {
      spawned_from: null,
      coordination_revision: 0,
      coordination_receipts: [],
      chat_proposals: { schema_version: 1, records: [], launch_grants: [] },
      session_mail: DEFAULT_MAIL,
      workspace_view: DEFAULT_VIEW,
    }
  );
  store.updateSession(created.id, {
    title: 'Renamed',
    workspace_view: { schema_version: 1, rail_visible: false, disclosures: {}, children_expanded: null },
    coordination_revision: 77,
    spawned_from: { schema_version: 1, parent_session_id: 'sess_evil' },
    session_mail: { schema_version: 1, reporting_enabled: true },
    chat_proposals: { schema_version: 1, records: [{ id: 'x' }], launch_grants: [] },
    coordination_receipts: [{ schema_version: 1 }],
  });
  const after = store.getSession(created.id);
  assert.equal(after.title, 'Renamed');
  assert.deepEqual(after.workspace_view, DEFAULT_VIEW);
  assert.equal(after.coordination_revision, 0);
  assert.equal(after.spawned_from, null);
  assert.equal(after.session_mail.reporting_enabled, false);
  assert.deepEqual(after.chat_proposals.records, []);
  assert.deepEqual(after.coordination_receipts, []);
  store.dispose();
});

test('workspace view store reads defaults and reports a missing session', (t) => {
  const store = openStore(tempProfile(t));
  const created = store.createSession({ title: 'Read' });
  const views = createWorkspaceViewStore(store);
  const read = views.read(created.id);
  assert.deepEqual(read, {
    ok: true,
    session_incarnation: store.getSession(created.id).session_incarnation,
    workspace_view: DEFAULT_VIEW,
    coordination_revision: 0,
  });
  assert.match(read.session_incarnation, /^inc_/);
  assert.deepEqual(views.read('sess_missing'), { ok: false, reason: 'not_found' });
  assert.deepEqual(views.read(''), { ok: false, reason: 'not_found' });
  assert.deepEqual(views.write('sess_missing', { expected_revision: 0, patch: { rail_visible: true } }),
    { ok: false, reason: 'not_found' });
  store.dispose();
});

test('workspace view writes merge disclosures, bump the revision by one, flush and survive a reopen', (t) => {
  const root = tempProfile(t);
  const store = openStore(root);
  const created = store.createSession({ title: 'Writes' });
  const updatedBefore = store.getSession(created.id).updated_at;
  const flushed = [];
  const realFlush = store.flushSession.bind(store);
  store.flushSession = (id) => { flushed.push(id); return realFlush(id); };
  const views = createWorkspaceViewStore(store);

  const first = views.write(created.id, { expected_revision: 0, patch: { disclosures: { environment: true } } });
  assert.deepEqual(first, {
    ok: true,
    workspace_view: { schema_version: 1, rail_visible: null, disclosures: { environment: true }, children_expanded: null },
    coordination_revision: 1,
  });
  const second = views.write(created.id, {
    expected_revision: 1,
    patch: { rail_visible: false, disclosures: { changes: true, environment: false } },
  });
  assert.deepEqual(second, {
    ok: true,
    workspace_view: {
      schema_version: 1,
      rail_visible: false,
      disclosures: { environment: false, changes: true },
      children_expanded: null,
    },
    coordination_revision: 2,
  });
  assert.deepEqual(flushed, [created.id, created.id], 'every accepted write is flushed before it returns');
  assert.equal(store.getSession(created.id).updated_at, updatedBefore, 'a view write does not bump recency');
  assert.equal(views.read(created.id).coordination_revision, 2);

  const reopened = openStore(root);
  const persisted = reopened.getSession(created.id);
  assert.equal(persisted.coordination_revision, 2);
  assert.deepEqual(persisted.workspace_view, second.workspace_view);
  store.dispose();
  reopened.dispose();
});

test('a stale expected_revision conflicts and reports the current revision without changing anything', (t) => {
  const store = openStore(tempProfile(t));
  const created = store.createSession({ title: 'Conflict' });
  const views = createWorkspaceViewStore(store);
  assert.equal(views.write(created.id, { expected_revision: 0, patch: { rail_visible: true } }).ok, true);
  const conflict = views.write(created.id, { expected_revision: 0, patch: { rail_visible: false } });
  assert.deepEqual(conflict, { ok: false, reason: 'revision_conflict', current_revision: 1 });
  assert.equal(views.read(created.id).workspace_view.rail_visible, true);
  assert.equal(views.read(created.id).coordination_revision, 1);
  const ahead = views.write(created.id, { expected_revision: 5, patch: { rail_visible: false } });
  assert.deepEqual(ahead, { ok: false, reason: 'revision_conflict', current_revision: 1 });
  store.dispose();
});

test('invalid requests and patches are refused before any write or flush', () => {
  const fake = createFakeStore({ coordination_revision: 3, workspace_view: DEFAULT_VIEW });
  const views = createWorkspaceViewStore(fake);
  assert.deepEqual(views.write('sess_a', { expected_revision: 3, patch: { rail_visible: 'no' } }),
    { ok: false, reason: 'invalid_patch' });
  assert.deepEqual(views.write('sess_a', { expected_revision: 3, patch: {} }),
    { ok: false, reason: 'invalid_patch' });
  for (const request of [null, 'x', [], { patch: { rail_visible: true } },
    { expected_revision: -1, patch: { rail_visible: true } },
    { expected_revision: 1.5, patch: { rail_visible: true } },
    { expected_revision: '3', patch: { rail_visible: true } }]) {
    assert.deepEqual(views.write('sess_a', request), { ok: false, reason: 'invalid_request' }, JSON.stringify(request));
  }
  assert.deepEqual(fake.calls, []);
});

test('an I/O failure at flush returns io_failed and leaves the in-memory record unchanged', (t) => {
  const store = openStore(tempProfile(t));
  const created = store.createSession({ title: 'Disk' });
  const views = createWorkspaceViewStore(store);
  assert.equal(views.write(created.id, { expected_revision: 0, patch: { disclosures: { outputs: true } } }).ok, true);
  const before = JSON.parse(JSON.stringify(store.getSession(created.id)));

  const realFlush = store.flushSession.bind(store);
  store.flushSession = () => false;
  const failed = views.write(created.id, { expected_revision: 1, patch: { rail_visible: false } });
  assert.deepEqual(failed, { ok: false, reason: 'io_failed', retryable: true, current_revision: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(store.getSession(created.id))), before);
  assert.deepEqual(views.read(created.id).workspace_view.disclosures, { outputs: true });

  store.flushSession = () => { throw new Error('EIO: disk gone'); };
  const thrown = views.write(created.id, { expected_revision: 1, patch: { rail_visible: false } });
  assert.deepEqual(thrown, { ok: false, reason: 'io_failed', retryable: true, current_revision: 1 });
  assert.equal(Object.hasOwn(thrown, 'message'), false, 'no exception prose crosses the boundary');
  assert.deepEqual(JSON.parse(JSON.stringify(store.getSession(created.id))), before);

  store.flushSession = realFlush;
  const retry = views.write(created.id, { expected_revision: 1, patch: { rail_visible: false } });
  assert.equal(retry.ok, true);
  assert.equal(retry.coordination_revision, 2);
  store.dispose();
});

test('a refused record write is io_failed, or unavailable when the store froze on a newer schema', () => {
  const view = DEFAULT_VIEW;
  const refused = createFakeStore({ coordination_revision: 4, workspace_view: view }, { failWrite: true });
  assert.deepEqual(
    createWorkspaceViewStore(refused).write('sess_a', { expected_revision: 4, patch: { rail_visible: true } }),
    { ok: false, reason: 'io_failed', retryable: true, current_revision: 4 }
  );
  assert.equal(refused.calls.some((call) => call.op === 'flush'), false);
  const frozenStore = createFakeStore({ coordination_revision: 4, workspace_view: view },
    { failWrite: true, newerSchema: true });
  assert.deepEqual(
    createWorkspaceViewStore(frozenStore).write('sess_a', { expected_revision: 4, patch: { rail_visible: true } }),
    { ok: false, reason: 'unavailable', retryable: false, current_revision: 4 }
  );
  const flushFails = createFakeStore({ coordination_revision: 4, workspace_view: view }, { failFlush: true });
  const result = createWorkspaceViewStore(flushFails)
    .write('sess_a', { expected_revision: 4, patch: { rail_visible: true } });
  assert.equal(result.reason, 'io_failed');
  assert.deepEqual(flushFails.records.get('sess_a').workspace_view, view);
  assert.equal(flushFails.records.get('sess_a').coordination_revision, 4);
  const restore = flushFails.calls.filter((call) => call.op === 'update').at(-1);
  assert.deepEqual(restore.options, { bumpUpdatedAt: false, persist: false }, 'rollback stays in memory');
});

test('a workspace_view with a future nested version is never overwritten by a write', () => {
  const future = { schema_version: 2, rail_visible: false, novel: true };
  const fake = createFakeStore({ coordination_revision: 2, workspace_view: future });
  const views = createWorkspaceViewStore(fake);
  const read = views.read('sess_a');
  assert.deepEqual(read.workspace_view, { schema_version: 1, rail_visible: false, disclosures: {}, children_expanded: null });
  assert.deepEqual(
    views.write('sess_a', { expected_revision: 2, patch: { rail_visible: true } }),
    { ok: false, reason: 'unavailable', retryable: false, current_revision: 2 }
  );
  assert.deepEqual(fake.records.get('sess_a').workspace_view, future);
  assert.deepEqual(fake.calls, []);
});

test('a real store keeps a future-version workspace_view bytes intact through normalization', (t) => {
  const root = tempProfile(t);
  const store = openStore(root);
  const created = store.createSession({ title: 'Future' });
  const future = { schema_version: 4, rail_visible: 'maybe', novel: [1, 2, 3] };
  store._updateSessionRecord(created.id, { workspace_view: future }, { bumpUpdatedAt: false });
  assert.deepEqual(store.getSession(created.id).workspace_view, future);
  assert.equal(store.flushSession(created.id), true);
  const reopened = openStore(root);
  assert.deepEqual(reopened.getSession(created.id).workspace_view, future);
  const views = createWorkspaceViewStore(reopened);
  assert.equal(views.write(created.id, { expected_revision: 0, patch: { rail_visible: true } }).reason, 'unavailable');
  store.dispose();
  reopened.dispose();
});

function writeV24Profile(root) {
  const seed = openStore(root);
  const created = seed.createSession({ title: 'Legacy chat' });
  seed.appendMessage(created.id, {
    id: 'm1', role: 'user', content: 'hello', timestamp: '2026-10-05T12:00:00.000Z',
  });
  seed.appendMessage(created.id, {
    id: 'm2', role: 'assistant', content: 'world', status: 'complete', timestamp: '2026-10-05T12:00:01.000Z',
  });
  assert.equal(seed.flushSession(created.id), true);
  seed.dispose();
  // Rewrite what a schema-24 build left on disk: version 24, none of the six fields.
  const sessionsDir = path.join(root, 'sessions');
  const sessionFile = path.join(sessionsDir, `${created.id}.json`);
  const indexFile = path.join(sessionsDir, '_index.json');
  const base = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  base.schema_version = 24;
  for (const key of COORDINATION_FIELDS) delete base.session[key];
  fs.writeFileSync(sessionFile, JSON.stringify(base));
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  index.schema_version = 24;
  fs.writeFileSync(indexFile, JSON.stringify(index));
  return { id: created.id, legacySession: base.session, sessionFile };
}

test('a schema-24 store queues the migration, adds the defaults and keeps every other field', async (t) => {
  const root = tempProfile(t);
  const { id, legacySession, sessionFile } = writeV24Profile(root);
  const logs = [];
  const store = new ElectronSessionStore(path.join(root, 'sessions.json'), {
    logger: (level, event) => logs.push(event),
  });
  assert.equal(store.hasPendingMigrations(), true);
  const outcome = await store.runPendingMigrations({ batchSize: 1 });
  assert.equal(outcome.success, true);
  assert.equal(store.hasPendingMigrations(), false);
  assert.ok(logs.includes('session_store.split_schema_migration_completed'));

  const migrated = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  assert.equal(migrated.schema_version, 26);
  const rest = { ...migrated.session };
  for (const key of COORDINATION_FIELDS) delete rest[key];
  assert.deepEqual(rest, legacySession, 'conversation content is untouched apart from the added fields');
  assert.equal(migrated.session.coordination_revision, 0);
  assert.deepEqual(migrated.session.workspace_view, DEFAULT_VIEW);
  assert.deepEqual(migrated.session.session_mail, DEFAULT_MAIL);
  assert.deepEqual(store.getSession(id).messages.map((message) => message.id), ['m1', 'm2']);

  // Replay on the migrated profile is a no-op.
  const again = new ElectronSessionStore(path.join(root, 'sessions.json'), { logger() {} });
  assert.equal(again.hasPendingMigrations(), false);
  assert.deepEqual(again.getSession(id).workspace_view, DEFAULT_VIEW);
  store.dispose();
  again.dispose();
});

test('an imported session gets default coordination fields and exports never carry them', (t) => {
  const root = tempProfile(t);
  const store = openStore(root);
  const source = store.createSession({ title: 'Source' });
  store.appendMessage(source.id, {
    id: 'u1', role: 'user', content: 'portable text', timestamp: '2026-10-05T12:00:00.000Z',
  });
  const views = createWorkspaceViewStore(store);
  assert.equal(views.write(source.id, {
    expected_revision: 0, patch: { rail_visible: false, disclosures: { context: true }, children_expanded: true },
  }).ok, true);
  assert.equal(views.read(source.id).coordination_revision, 1);

  const json = exportSession(store, source.id);
  const exported = JSON.parse(json).session;
  for (const key of COORDINATION_FIELDS) {
    assert.equal(Object.hasOwn(exported, key), false, `${key} is not exported`);
  }

  const imported = importSession(store, json, null);
  const record = store.getSession(imported.id);
  assert.notEqual(imported.id, source.id);
  assert.equal(record.messages[0].content, 'portable text');
  assert.deepEqual(record.workspace_view, DEFAULT_VIEW);
  assert.equal(record.coordination_revision, 0);
  assert.equal(record.spawned_from, null);
  assert.deepEqual(record.coordination_receipts, []);
  assert.deepEqual(record.chat_proposals, { schema_version: 1, records: [], launch_grants: [] });
  assert.deepEqual(record.session_mail, DEFAULT_MAIL);
  store.dispose();
});

test('spawned_from is strict v1: closed keys, bounded ids, reads null when malformed, future kept verbatim', () => {
  assert.deepEqual(normalizeSpawnedFrom(SPAWNED), SPAWNED);
  assert.notEqual(normalizeSpawnedFrom(SPAWNED), SPAWNED, 'a copy');
  assert.equal(normalizeSpawnedFrom(null), null);
  const bad = [
    { ...SPAWNED, extra: 1 },
    { ...SPAWNED, parent_session_id: '' },
    { ...SPAWNED, parent_session_id: 'x'.repeat(257) },
    { ...SPAWNED, parent_session_incarnation: 7 },
    { ...SPAWNED, proposal_id: 'proposal_abc' },
    { ...SPAWNED, created_at: '2026-10-15T10:00:00Z' },
    { ...SPAWNED, child_creation_hash: 'B'.repeat(64) },
    { ...SPAWNED, reporting_consent_id: 'nope' },
    { ...SPAWNED, reporting_consent_id: '11111111-1111-4111-8111-11111111111G' },
  ];
  for (const value of bad) assert.equal(normalizeSpawnedFrom(value), null, JSON.stringify(value));
  const { reporting_consent_id: _consent, ...missing } = SPAWNED;
  assert.equal(normalizeSpawnedFrom(missing), null);
  const future = { ...SPAWNED, schema_version: 2, brand_new: { keep: true } };
  assert.deepEqual(normalizeSpawnedFrom(future), future);
  assert.notEqual(normalizeSpawnedFrom(future), future);
  assert.deepEqual(applyCoordinationDefaults({ spawned_from: SPAWNED }).spawned_from, SPAWNED);
  assert.equal(applyCoordinationDefaults({ spawned_from: { ...SPAWNED, extra: 1 } }).spawned_from, null);
});

