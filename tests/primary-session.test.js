'use strict';

/* Row 69 W1: the profile's primary "Jenny" chat. One durable `session_role`
 * marker (schema 26), created on demand, never archived, deleted, swept or
 * moved out of General, and impossible to mint through sessions.create. */

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const primary = require('../services/backend/primary-session');
const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const backendSessions = require('../services/backend/backend-sessions');
const { BackendService } = require('../services/backend/backend-service');
const { ProjectApplicationService } = require('../services/projects/project-application-service');
const { initializeApplicationProjects } = require('../services/projects/application-project-scope');
const { GENERAL_PROJECT_ID } = require('../services/projects/project-schema');
const { buildSessionSummary } = require('../services/backend/session-summary-projection');
const {
  STORE_SCHEMA_VERSION, migrateStorePayload, repairSessionForV26,
} = require('../services/backend/session-store-migrations');
const {
  buildFeatureFlags, FEATURE_OVERRIDE_KEYS, INTERNAL_FEATURE_FLAG_KEYS,
} = require('../services/feature-flags');
const { cleanupTrackedResources, createTrackedTempDir } = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function buildService() {
  const base = createTrackedTempDir('jenny-primary-session-');
  const logs = [];
  const service = {
    hostMode: 'desktop',
    featureFlags: { primary_chat: true },
    logs,
    _emitServiceLog(level, event, details) { logs.push({ level, event, details }); },
    configService: { getState: () => ({ defaultRunMode: 'ask', toolsWorkspaceRoot: '' }) },
    sessionStore: new ElectronSessionStore(path.join(base, 'sessions.json'), { writeDebounceMs: 0 }),
  };
  initializeApplicationProjects(service, { userDataPath: path.join(base, 'profile'), hostMode: 'desktop' });
  return service;
}

function ensure(service, overrides = {}) {
  return primary.ensurePrimarySession({
    sessionStore: service.sessionStore,
    createSession: (options) => backendSessions.createSession(service, options),
    featureFlags: service.featureFlags,
    log: (level, event, details) => service._emitServiceLog(level, event, details),
    ...overrides,
  });
}

function roles(store) {
  return store.listSessions().map((summary) => [summary.id, summary.session_role || null]);
}

function setCreatedAt(store, sessionId, createdAt) {
  assert.ok(store._updateSessionRecord(sessionId, { created_at: createdAt }, { bumpUpdatedAt: false }));
}

test('normalizeSessionRole accepts only the exact primary token', () => {
  assert.equal(primary.PRIMARY_SESSION_ROLE, 'primary');
  assert.equal(primary.PRIMARY_SESSION_TITLE, 'Jenny');
  assert.equal(primary.normalizeSessionRole('primary'), 'primary');
  for (const value of ['Primary', ' primary', 'plugin', '', null, undefined, 1, {}, ['primary']]) {
    assert.equal(primary.normalizeSessionRole(value), null, JSON.stringify(value));
  }
});

test('findPrimarySessions keeps primaries only, oldest first, then by id', () => {
  const rows = [
    { id: 'c', session_role: 'primary', created_at: '2026-10-02T00:00:00.000Z' },
    { id: 'x', session_role: null, created_at: '2026-01-01T00:00:00.000Z' },
    { id: 'b', session_role: 'primary', created_at: '2026-10-01T00:00:00.000Z' },
    { id: 'a', session_role: 'primary', created_at: '2026-10-01T00:00:00.000Z' },
    { id: 'y', session_role: 'boss', created_at: '2026-01-01T00:00:00.000Z' },
    null,
  ];
  assert.deepEqual(primary.findPrimarySessions(rows).map((row) => row.id), ['a', 'b', 'c']);
  assert.deepEqual(primary.findPrimarySessions(null), []);
});

test('ensurePrimarySession creates one pinned Jenny chat in General, then is idempotent', async () => {
  const service = buildService();
  const store = service.sessionStore;
  const ordinary = store.createSession({ title: 'Ordinary' });
  const first = await ensure(service);
  assert.equal(first.created, true);
  assert.deepEqual(first.demoted, []);
  const summary = store.getSessionSummary(first.session_id);
  assert.equal(summary.session_role, 'primary');
  assert.equal(summary.title, 'Jenny');
  assert.equal(summary.project_id, GENERAL_PROJECT_ID);
  assert.equal(summary.pinned, true);
  assert.equal(summary.session_type, 'chat');
  assert.equal(store.getSession(first.session_id).session_role, 'primary');
  assert.equal(store.getSession(ordinary.id).session_role, null);

  const second = await ensure(service);
  assert.deepEqual(second, { session_id: first.session_id, created: false, demoted: [] });
  assert.equal(store.listSessions().length, 2);
  assert.equal(primary.isPrimarySession(store, first.session_id), true);
  assert.equal(primary.isPrimarySession(store, ordinary.id), false);
  assert.equal(primary.isPrimarySession(store, 'sess_missing'), false);

  store.flush();
  const reopened = new ElectronSessionStore(store.filePath, { writeDebounceMs: 0 });
  assert.equal(reopened.getSessionSummary(first.session_id).session_role, 'primary');
  assert.equal(reopened.getSession(first.session_id).session_role, 'primary');
  reopened.dispose();
});

test('ensurePrimarySession keeps the oldest of several primaries and demotes the rest without a recency bump', async () => {
  const service = buildService();
  const store = service.sessionStore;
  const ids = [0, 1, 2].map(() => store.createSession({ sessionRole: 'primary' }).id);
  setCreatedAt(store, ids[0], '2026-10-03T00:00:00.000Z');
  setCreatedAt(store, ids[1], '2026-10-01T00:00:00.000Z');
  setCreatedAt(store, ids[2], '2026-10-02T00:00:00.000Z');
  const updatedBefore = Object.fromEntries(ids.map((id) => [id, store.getSessionSummary(id).updated_at]));
  const result = await ensure(service);
  assert.equal(result.session_id, ids[1]);
  assert.equal(result.created, false);
  assert.deepEqual(result.demoted, [ids[2], ids[0]]);
  assert.deepEqual(primary.findPrimarySessions(store.listSessions()).map((row) => row.id), [ids[1]]);
  for (const id of [ids[0], ids[2]]) {
    assert.equal(store.getSession(id).session_role, null);
    assert.equal(store.getSessionSummary(id).updated_at, updatedBefore[id]);
  }
  assert.ok(service.logs.find((entry) => entry.event === 'primary_session.duplicates_demoted'));
  assert.equal(JSON.stringify(service.logs).includes('New Chat'), false, 'logs carry ids, never titles');
});

test('the primary_chat kill switch creates nothing and leaves existing primaries alone', async () => {
  const service = buildService();
  service.featureFlags = { primary_chat: false };
  assert.deepEqual(await ensure(service), { session_id: null, created: false, demoted: [] });
  assert.equal(service.sessionStore.listSessions().length, 0);
  const a = service.sessionStore.createSession({ sessionRole: 'primary' }).id;
  const b = service.sessionStore.createSession({ sessionRole: 'primary' }).id;
  assert.deepEqual(await ensure(service), { session_id: null, created: false, demoted: [] });
  assert.deepEqual(roles(service.sessionStore).sort(), [[a, 'primary'], [b, 'primary']].sort());
});

test('ensurePrimarySession never throws on store or create failures', async () => {
  const service = buildService();
  const broken = { listSessions() { throw new Error('index unreadable'); } };
  assert.deepEqual(await ensure(service, { sessionStore: broken }), { session_id: null, created: false, demoted: [] });
  const refused = await ensure(service, { createSession: async () => { throw new Error('read only'); } });
  assert.deepEqual(refused, { session_id: null, created: false, demoted: [] });
  const empty = await ensure(service, { createSession: async () => null });
  assert.equal(empty.session_id, null);
  assert.ok(service.logs.filter((entry) => entry.event === 'primary_session.ensure_failed').length >= 2);
});

test('the primary cannot be deleted, and the refusal comes before any stream is cancelled', async () => {
  const service = buildService();
  const { session_id: id } = await ensure(service);
  const direct = await backendSessions.deleteSession(service, id);
  assert.deepEqual([direct.deleted, direct.reason, direct.id], [false, 'primary_protected', id]);
  service.sessionTurnActors = { beginDeletion() { throw new Error('the lifecycle must not start'); } };
  service.cancelChatStream = () => { throw new Error('no stream may be cancelled'); };
  const viaService = await BackendService.prototype.deleteSession.call(service, id);
  assert.deepEqual([viaService.deleted, viaService.reason], [false, 'primary_protected']);
  assert.ok(service.sessionStore.getSession(id), 'the primary survives');
});

test('the primary cannot be archived; unarchive and pin changes stay allowed and keep the role', async () => {
  const service = buildService();
  const { session_id: id } = await ensure(service);
  const refused = await backendSessions.setSessionMeta(service, id, { archived_at: '2026-10-20T00:00:00.000Z', pinned: false });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'primary_protected');
  assert.equal(refused.id, undefined, 'no summary-shaped acknowledgement reaches the renderer');
  assert.equal(service.sessionStore.getSessionSummary(id).archived_at, null);
  assert.equal(service.sessionStore.getSessionSummary(id).pinned, true, 'a refused patch writes nothing');
  const unpinned = await backendSessions.setSessionMeta(service, id, { pinned: false });
  assert.deepEqual([unpinned.pinned, unpinned.session_role], [false, 'primary']);
  const unarchived = await backendSessions.setSessionMeta(service, id, { archived_at: null });
  assert.deepEqual([unarchived.archived_at, unarchived.session_role], [null, 'primary']);
  const ordinary = service.sessionStore.createSession({}).id;
  const archived = await backendSessions.setSessionMeta(service, ordinary, { archived_at: '2026-10-20T00:00:00.000Z' });
  assert.equal(archived.archived_at, '2026-10-20T00:00:00.000Z');
});

test('the primary cannot be moved out of General', async () => {
  const service = buildService();
  const { session_id: id } = await ensure(service);
  const fake = { _authority: { captureProject() {} }, _sessions: service.sessionStore, _isSessionBusy: () => false };
  const moved = ProjectApplicationService.prototype.assignSessionProject.call(fake, {
    project_id: 'project_elsewhere', session_id: id,
  });
  assert.equal(moved.ok, false);
  assert.equal(moved.error.reason, 'primary_protected');
  const stays = ProjectApplicationService.prototype.assignSessionProject.call(fake, {
    project_id: GENERAL_PROJECT_ID, session_id: id,
  });
  assert.deepEqual([stays.ok, stays.unchanged], [true, true]);
  assert.equal(service.sessionStore.getSessionSummary(id).project_id, GENERAL_PROJECT_ID);
});

test('the empty-chat sweep never takes the primary, even unpinned and untitled', () => {
  const service = buildService();
  const store = service.sessionStore;
  const id = store.createSession({ sessionRole: 'primary' }).id;
  assert.equal(store.getSessionSummary(id).title, 'New Chat');
  store.setSessionMeta(id, { pinned: false });
  const ordinary = store.createSession({}).id;
  const { candidateIds } = store.sweepEmptySessions({ dryRun: true });
  assert.deepEqual(candidateIds, [ordinary]);
});

test('sessions.create, sessions.setMeta and generic updates can never mint a primary', async () => {
  const service = buildService();
  const created = await BackendService.prototype.createSession.call(service, {
    title: 'From IPC', session_role: 'primary', sessionRole: 'primary',
  });
  assert.notEqual(created.data.session_role, 'primary');
  const id = created.data.id;
  service.sessionStore.setSessionMeta(id, { session_role: 'primary' });
  service.sessionStore.updateSession(id, { session_role: 'primary' });
  assert.equal(service.sessionStore.getSession(id).session_role, null);
  assert.deepEqual(primary.findPrimarySessions(service.sessionStore.listSessions()), []);
});

test('peekSessionSummary reads the index without a clone; isPrimaryRole reads the stored role', async () => {
  const service = buildService();
  const { session_id: id } = await ensure(service);
  const peeked = service.sessionStore.peekSessionSummary(id);
  assert.equal(primary.isPrimaryRole(peeked), true);
  assert.equal(service.sessionStore.peekSessionSummary(id), peeked, 'shared by reference, not cloned');
  assert.deepEqual(service.sessionStore.getSessionSummary(id), { ...peeked, id });
  assert.notEqual(service.sessionStore.getSessionSummary(id), peeked);
  assert.equal(service.sessionStore.peekSessionSummary('missing'), null);
  assert.equal(primary.isPrimarySession(service.sessionStore, id), true);
  assert.equal(primary.primaryChatEnabled({ primary_chat: false }), false);
  assert.equal(primary.primaryChatEnabled(undefined), true);
});

test('getSessionDirectory reaches the executor-owned directory and feeds the profile overview', async () => {
  const { ToolExecutor } = require('../services/tools/tool-executor');
  const { composeProfileOverviewContextBlock } = require('../services/backend/profile-overview-block');
  const directory = {
    list: async () => ({ ok: true, scope_kind: 'profile', truncated: false, rows: [{
      session_id: 'other', title: 'Grants budget', project: { id: 'project_grants', name: 'Grants' }, status: 'idle',
      last_outcome: null, updated_at: '2026-10-20T11:00:00.000Z', message_count: 4, unread_message_count: 0,
      pinned: false, archived: false, role: null, linked: { parent_session_id: null, children_count: 0 }, waiting_on_user: false,
    }] }),
  };
  let built = 0;
  const executor = new ToolExecutor({ sessionDirectoryService: () => { built += 1; return directory; } });
  assert.equal(executor.getSessionDirectoryService(), directory);
  assert.equal(new ToolExecutor({}).getSessionDirectoryService(), null, 'no directory wired -> null');
  assert.equal(new ToolExecutor({ sessionDirectoryService: () => { throw new Error('boom'); } }).getSessionDirectoryService(), null);
  const service = { toolExecutor: executor };
  assert.equal(BackendService.prototype.getSessionDirectory.call(service), directory);
  assert.equal(BackendService.prototype.getSessionDirectory.call({ toolExecutor: null }), null, 'before composition -> null');
  const block = await composeProfileOverviewContextBlock(
    { getSessionDirectory: () => BackendService.prototype.getSessionDirectory.call(service) }, 'jenny', Date.UTC(2026, 9, 20, 12));
  assert.equal(block?.kind, 'profile_overview');
  assert.match(block.content, /Grants budget/);
  assert.ok(built >= 1, 'the lazy getter ran');
});

test('the summary projects session_role as primary or null', () => {
  const service = buildService();
  const id = service.sessionStore.createSession({ sessionRole: 'primary' }).id;
  const record = service.sessionStore.getSession(id);
  assert.equal(buildSessionSummary(record).session_role, 'primary');
  assert.equal(buildSessionSummary({ ...record, session_role: undefined }).session_role, null);
  assert.equal(buildSessionSummary({ ...record, session_role: 'boss' }).session_role, null);
});

test('schema 26 fills session_role and keeps a primary through the migration', () => {
  assert.equal(STORE_SCHEMA_VERSION, 26);
  assert.equal(repairSessionForV26({}).session_role, null);
  assert.equal(repairSessionForV26({ session_role: 'primary' }).session_role, 'primary');
  assert.equal(repairSessionForV26({ session_role: 'boss', title: 'kept' }).session_role, null);
  assert.equal(repairSessionForV26({ title: 'kept' }).title, 'kept');
  const migrated = migrateStorePayload({ schema_version: 25, sessions: { a: { id: 'a' }, b: { id: 'b', session_role: 'primary' } } });
  assert.equal(migrated.schema_version, 26);
  assert.equal(migrated.sessions.a.session_role, null);
  assert.equal(migrated.sessions.b.session_role, 'primary');
});

test('primary_chat and tools_session_directory_enabled are internal default-on kill switches', () => {
  const defaults = buildFeatureFlags({});
  const off = buildFeatureFlags({ JENNY_ENABLE_PRIMARY_CHAT: '0', JENNY_ENABLE_TOOLS_SESSION_DIRECTORY_ENABLED: '0' });
  assert.deepEqual([defaults.primary_chat, defaults.tools_session_directory_enabled], [true, true]);
  assert.deepEqual([off.primary_chat, off.tools_session_directory_enabled], [false, false]);
  for (const key of ['primary_chat', 'tools_session_directory_enabled']) {
    assert.equal(INTERNAL_FEATURE_FLAG_KEYS.includes(key), true, key);
    assert.equal(FEATURE_OVERRIDE_KEYS.includes(key), false, key);
  }
});
