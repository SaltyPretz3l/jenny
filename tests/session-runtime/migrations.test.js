'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { GENERAL_PROJECT_ID } = require('../../services/projects/project-schema');
const {
  ElectronSessionStore,
  STORE_SCHEMA_VERSION,
  normalizeSession,
} = require('../../services/backend/electron-session-store');
const { migrateStorePayload } = require('../../services/backend/session-store-migrations');
const { SessionShadowStore, STORE_SCHEMA_VERSION: SHADOW_SCHEMA_VERSION } = require('../../services/backend/session-shadow-store');
const { forkSession } = require('../../services/backend/session-branching');
const { SessionTemplateStore } = require('../../services/backend/session-templates');
const { exportSession, importSession } = require('../../services/backend/session-export-import');
const { createSession: createBackendSession } = require('../../services/backend/backend-sessions');
const { cleanupTrackedResources, trackDirectory } = require('../helpers/resource-cleanup');

test.afterEach(async () => cleanupTrackedResources());

function makeStore(prefix = 'jenny-project-session-') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trackDirectory(directory);
  return new ElectronSessionStore(path.join(directory, 'sessions.json'));
}

for (const failMigration of [false, true]) test(`legacy split summaries have project authority before deferred migration (failure: ${failMigration})`, async t => {
  const store = makeStore();
  const id = store.createSession({ title: 'Existing conversation' }).id;
  store.appendMessage(id, { id: 'existing_message', role: 'user', content: 'Preserve me' });
  const root = store._backend._rootDir; const file = store.filePath;
  store.dispose();
  const indexPath = path.join(root, '_index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const sessionPath = path.join(root, `${id}.json`);
  const body = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  index.schema_version = 20; body.schema_version = 20;
  delete index.sessions[id].project_id; delete body.session.project_id;
  fs.writeFileSync(indexPath, JSON.stringify(index)); fs.writeFileSync(sessionPath, JSON.stringify(body));
  const reopened = new ElectronSessionStore(file); t.after(() => reopened.dispose());
  assert.equal(reopened.hasPendingMigrations(), true);
  assert.equal(reopened._backend._loadedSessions.size, 0);
  assert.equal(reopened.getSessionSummary(id).project_id, GENERAL_PROJECT_ID);
  assert.equal(reopened.getSessionSummary(id).message_count, 1);
  assert.equal(reopened._backend._loadedSessions.size, 0);
  const readdir = fs.promises.readdir;
  if (failMigration) fs.promises.readdir = async () => { throw new Error('migration fixture failure'); };
  try { await reopened.runPendingMigrations(); }
  finally { fs.promises.readdir = readdir; }
  assert.equal(reopened.getSessionSummary(id).project_id, GENERAL_PROJECT_ID);
  assert.equal(reopened.getSession(id).messages[0].content, 'Preserve me');
});

test('session schema 21 migration defaults missing and malformed attribution to General', () => {
  assert.equal(STORE_SCHEMA_VERSION, 22);
  const migrated = migrateStorePayload({
    schema_version: 20,
    sessions: {
      missing: { title: 'Missing' },
      malformed: { title: 'Malformed', project_id: '../escape' },
      explicit: { title: 'Explicit', project_id: 'project_alpha' },
    },
  });
  assert.equal(migrated.sessions.missing.project_id, GENERAL_PROJECT_ID);
  assert.equal(migrated.sessions.malformed.project_id, GENERAL_PROJECT_ID);
  assert.equal(migrated.sessions.explicit.project_id, 'project_alpha');
  assert.deepEqual(migrateStorePayload(migrated), migrated);
});

test('normalization, creation, listing, and reload preserve project attribution', () => {
  assert.equal(normalizeSession('legacy', {}).project_id, GENERAL_PROJECT_ID);
  assert.equal(normalizeSession('bad', { project_id: 'bad' }).project_id, 'bad');
  const store = makeStore();
  assert.equal(store.createSession({ title: 'Invalid', projectId: '../bad' }), null);
  const created = store.createSession({ title: 'Project chat', projectId: 'project_alpha' });
  assert.equal(created.project_id, 'project_alpha');
  assert.equal(store.listSessions()[0].project_id, 'project_alpha');
  store.flush();
  const filePath = store.filePath;
  store.dispose();
  const reopened = new ElectronSessionStore(filePath);
  assert.equal(reopened.getSession(created.id).project_id, 'project_alpha');
  reopened.dispose();
});

test('public backend session creation forwards explicit trusted project identity', async () => {
  const calls = [];
  const service = {
    projectAuthority: {
      captureProject(projectId) {
        if (projectId === 'project_alpha') return Object.freeze({ project_id: projectId });
        const error = new Error('invalid');
        error.code = 'CMP-PROJECT-0001';
        throw error;
      },
    },
    sessionStore: {
      createSession(options) {
        calls.push(options);
        return { id: 'sess_created', project_id: options.projectId };
      },
    },
  };
  const result = await createBackendSession(service, { title: 'Scoped', projectId: 'project_alpha' });
  assert.equal(calls[0].projectId, 'project_alpha');
  assert.equal(result.data.project_id, 'project_alpha');
  await assert.rejects(
    createBackendSession(service, { title: 'Invalid', projectId: '../bad' }),
    (error) => error.code === 'CMP-PROJECT-0001'
  );
  assert.equal(calls.length, 1);
});

test('shadow schema 9 defaults legacy rows and roundtrips explicit project ids', () => {
  assert.equal(SHADOW_SCHEMA_VERSION, 9);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-project-shadow-'));
  trackDirectory(directory);
  const shadow = new SessionShadowStore(path.join(directory, 'session-shadow.json'));
  assert.equal(shadow.upsertSession('legacy', { title: 'Legacy' }).project_id, GENERAL_PROJECT_ID);
  assert.equal(shadow.upsertSession('explicit', { title: 'Explicit', project_id: 'project_alpha' }).project_id, 'project_alpha');
  assert.equal(shadow.summarize().explicit.project_id, 'project_alpha');
  shadow.dispose();
});

test('branches and templates preserve explicit project attribution', () => {
  const store = makeStore();
  const created = store.createSession({ title: 'Source', projectId: 'project_alpha' });
  store.appendMessage(created.id, { id: 'message-1', role: 'user', content: 'hello' });
  const branch = forkSession(store, created.id, 'message-1');
  assert.equal(branch.project_id, 'project_alpha');

  const values = new Map([['session_templates', [{ id: 'tpl', name: 'Project', project_id: 'project_alpha' }]]]);
  const templates = new SessionTemplateStore({ get: (key) => values.get(key), set: (key, value) => values.set(key, value) });
  const applied = templates.apply('tpl', store);
  assert.equal(applied.project_id, 'project_alpha');
  store.dispose();
});

test('foreign import defaults General while explicit caller remap is preserved', () => {
  const sourceStore = makeStore('jenny-project-export-');
  const source = sourceStore.createSession({ title: 'Export', projectId: 'project_alpha' });
  const payload = exportSession(sourceStore, source.id);
  assert.equal(JSON.parse(payload).session.project_id, 'project_alpha');

  const destinationStore = makeStore('jenny-project-import-');
  const imported = importSession(destinationStore, payload);
  assert.equal(imported.project_id, GENERAL_PROJECT_ID);
  const remapped = importSession(destinationStore, payload, null, { projectIdRemap: 'project_beta' });
  assert.equal(remapped.project_id, 'project_beta');
  const restored = importSession(destinationStore, payload, null, {
    trustedArchive: true,
    restoredSessionId: 'sess_restored_project',
  });
  assert.equal(restored.project_id, 'project_alpha');
  assert.throws(
    () => importSession(destinationStore, payload, null, { projectIdRemap: '../bad' }),
    (error) => error.reason === 'format_mismatch'
  );
  sourceStore.dispose();
  destinationStore.dispose();
});
