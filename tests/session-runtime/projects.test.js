'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { workspaceRootId } = require('../../services/workspace-root-identity');
const {
  GENERAL_PROJECT_ID,
  MAX_PROJECTS,
  PROJECT_STORE_SCHEMA_VERSION,
  createGeneralProject,
} = require('../../services/projects/project-schema');
const { ProjectStore } = require('../../services/projects/project-store');
const { ProjectService } = require('../../services/projects/project-service');
const { ProjectWorkspacePool } = require('../../services/projects/project-workspace-pool');
const { cleanupTrackedResources, trackDirectory } = require('../helpers/resource-cleanup');

test.afterEach(async () => cleanupTrackedResources());

function fixture(prefix = 'jenny-projects-') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trackDirectory(directory);
  const filePath = path.join(directory, 'projects.json');
  const timestamps = [
    '2026-09-09T12:00:00.000Z',
    '2026-09-09T12:00:01.000Z',
    '2026-09-09T12:00:02.000Z',
    '2026-09-09T12:00:03.000Z',
  ];
  const store = new ProjectStore(filePath, { now: () => timestamps[0] });
  const service = new ProjectService({
    store,
    idFactory: () => 'project_alpha',
    now: () => timestamps.shift() || '2026-09-09T12:00:04.000Z',
  });
  return { directory, filePath, store, service };
}

test('new stores durably create one unbound General project', () => {
  const { filePath, service } = fixture();
  const general = service.get(GENERAL_PROJECT_ID);
  assert.equal(general.name, 'General');
  assert.equal(general.root_path, null);
  assert.equal(general.root_id, null);
  assert.equal(general.root_revision, 0);
  const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(persisted.schema_version, PROJECT_STORE_SCHEMA_VERSION);
  assert.deepEqual(persisted.projects[GENERAL_PROJECT_ID], general);
});

test('explicit project creation is durable and survives reload', () => {
  const { filePath, service } = fixture();
  const created = service.create({ name: ' Alpha ', runtimePreferences: { provider_id: 'local' } });
  assert.equal(created.ok, true);
  assert.equal(created.durable, true);
  assert.equal(created.project.id, 'project_alpha');
  assert.deepEqual(created.project.runtime_preferences, { provider_id: 'local' });

  const reopened = new ProjectStore(filePath);
  assert.deepEqual(reopened.getSnapshot().projects.project_alpha, created.project);
});

test('invalid creation and ambiguous relative roots are rejected without mutation', () => {
  const { service } = fixture();
  assert.equal(service.create(null).reason, 'invalid_name');
  assert.equal(service.create({ name: 'Alpha' }).ok, true);
  assert.equal(service.bindRoot('project_alpha', 'relative/root').reason, 'invalid_root');
  assert.equal(service.get('project_alpha').root_revision, 0);
});

test('root binding is canonical, revisioned, idempotent, nullable, and durable', () => {
  const { directory, filePath, service } = fixture();
  assert.equal(service.create({ name: 'Alpha' }).ok, true);
  const root = fs.mkdtempSync(path.join(directory, 'root-'));
  const canonicalRoot = fs.realpathSync(root);

  const bound = service.bindRoot('project_alpha', root, { expectedRevision: 0 });
  assert.equal(bound.ok, true);
  assert.equal(bound.project.root_path, canonicalRoot);
  assert.equal(bound.project.root_id, workspaceRootId(canonicalRoot));
  assert.equal(bound.project.root_revision, 1);

  const unchanged = service.bindRoot('project_alpha', root, { expectedRevision: 1 });
  assert.equal(unchanged.unchanged, true);
  assert.equal(unchanged.project.root_revision, 1);
  assert.equal(service.bindRoot('project_alpha', null, { expectedRevision: 0 }).reason, 'stale_root_revision');

  const unbound = service.bindRoot('project_alpha', null, { expectedRevision: 1 });
  assert.equal(unbound.project.root_path, null);
  assert.equal(unbound.project.root_id, null);
  assert.equal(unbound.project.root_revision, 2);
  const reopened = new ProjectStore(filePath);
  assert.equal(reopened.getSnapshot().projects.project_alpha.root_revision, 2);
  assert.equal(reopened.getSnapshot().projects.project_alpha.root_path, null);
});

test('workspace pool captures null roots and invalidates stale bound authority', () => {
  const { directory, service } = fixture();
  const pool = new ProjectWorkspacePool({ projectService: service });
  const general = pool.capture(GENERAL_PROJECT_ID);
  assert.deepEqual(general, {
    ok: true,
    authority: {
      project_id: GENERAL_PROJECT_ID,
      root_path: null,
      root_id: null,
      root_revision: 0,
      device_id: null,
      inode: null,
    },
  });
  assert.equal(pool.isCurrent(general.authority), true);

  service.create({ name: 'Alpha' });
  const root = fs.mkdtempSync(path.join(directory, 'workspace-'));
  service.bindRoot('project_alpha', root);
  const captured = pool.capture('project_alpha');
  assert.equal(captured.ok, true);
  assert.equal(pool.isCurrent(captured.authority), true);
  service.bindRoot('project_alpha', null, { expectedRevision: 1 });
  assert.equal(pool.isCurrent(captured.authority), false);
});

test('workspace pool invalidates authority when the directory at a bound path is replaced', (t) => {
  const { directory, service } = fixture();
  service.create({ name: 'Alpha' });
  const root = path.join(directory, 'replaceable-root');
  const moved = path.join(directory, 'original-root');
  fs.mkdirSync(root);
  service.bindRoot('project_alpha', root);
  const pool = new ProjectWorkspacePool({ projectService: service });
  const captured = pool.capture('project_alpha');
  assert.equal(captured.ok, true);
  if (captured.authority.inode === null) {
    t.skip('filesystem does not expose a stable device/inode identity');
    return;
  }
  fs.renameSync(root, moved);
  fs.mkdirSync(root);
  assert.equal(pool.isCurrent(captured.authority), false);
});

test('workspace pool uses resolved path fallback when device/inode are unavailable', () => {
  const root = path.resolve(os.tmpdir(), 'zero-inode-project-root');
  const projectService = { get: () => ({
    id: 'project_zero',
    root_path: root,
    root_id: workspaceRootId(root),
    root_revision: 4,
  }) };
  const stat = { dev: 0n, ino: 0n, isDirectory: () => true };
  const fsImpl = { realpathSync: (value) => value, statSync: () => stat };
  const pool = new ProjectWorkspacePool({ projectService, fsImpl });
  const captured = pool.capture('project_zero');
  assert.equal(captured.ok, true);
  assert.equal(captured.authority.device_id, null);
  assert.equal(captured.authority.inode, null);
  assert.equal(pool.isCurrent(captured.authority), true);
});

test('root binding rejects a benign-named junction that resolves inside .jenny', (t) => {
  const { directory, service } = fixture();
  service.create({ name: 'Alpha' });
  const target = path.join(directory, '.jenny', 'target');
  const junction = path.join(directory, 'benign-workspace');
  fs.mkdirSync(target, { recursive: true });
  try {
    fs.symlinkSync(target, junction, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.skip(`directory link unavailable: ${error.code || error.message}`);
    return;
  }
  assert.equal(service.bindRoot('project_alpha', junction).reason, 'invalid_root');
  assert.equal(service.get('project_alpha').root_revision, 0);
});

test('future and malformed project documents stay read-only and preserve their bytes', () => {
  for (const [name, payload, reason] of [
    ['future', { schema_version: 99, projects: { future: { opaque: true } } }, 'future_schema'],
    ['invalid', { schema_version: 1, projects: [] }, 'invalid_schema'],
  ]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `jenny-project-${name}-`));
    trackDirectory(directory);
    const filePath = path.join(directory, 'projects.json');
    const original = JSON.stringify(payload);
    fs.writeFileSync(filePath, original, 'utf8');
    const store = new ProjectStore(filePath);
    const service = new ProjectService({ store, idFactory: () => 'project_new' });
    assert.equal(store.getStatus().reason, reason);
    assert.equal(service.create({ name: 'No write' }).reason, reason);
    assert.equal(fs.readFileSync(filePath, 'utf8'), original);
  }
});

test('lossy schema-1 rows stay read-only without rewriting roots or preferences', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-project-lossy-'));
  trackDirectory(directory);
  const filePath = path.join(directory, 'projects.json');
  const now = '2026-09-09T12:00:00.000Z';
  const root = path.join(directory, 'preserved-root');
  const payload = {
    schema_version: 1,
    projects: {
      [GENERAL_PROJECT_ID]: createGeneralProject(now),
      project_alpha: {
        id: 'project_mismatched',
        name: 'Alpha',
        root_path: root,
        root_id: workspaceRootId(root),
        root_revision: 7,
        runtime_preferences: { provider_id: 'keep-me' },
        created_at: now,
        updated_at: now,
      },
    },
  };
  const original = JSON.stringify(payload);
  fs.writeFileSync(filePath, original, 'utf8');
  const store = new ProjectStore(filePath);
  assert.equal(store.getStatus().reason, 'invalid_schema');
  assert.equal(store.getSnapshot().projects[GENERAL_PROJECT_ID].id, GENERAL_PROJECT_ID);
  assert.equal(store.getSnapshot().projects.project_alpha, undefined);
  assert.equal(fs.readFileSync(filePath, 'utf8'), original);
});

test('unknown fields and overflow are incompatible instead of silently discarded', () => {
  const now = '2026-09-09T12:00:00.000Z';
  const general = createGeneralProject(now);
  const overflowProjects = { [GENERAL_PROJECT_ID]: general };
  for (let index = 0; index < MAX_PROJECTS; index += 1) {
    const id = `project_overflow_${index}`;
    overflowProjects[id] = { ...general, id, name: `Project ${index}` };
  }
  for (const payload of [
    { schema_version: 1, projects: { [GENERAL_PROJECT_ID]: general }, unknown: true },
    { schema_version: 1, projects: {
      [GENERAL_PROJECT_ID]: { ...general, unknown: true },
    } },
    { schema_version: 1, projects: overflowProjects },
  ]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-project-incompatible-'));
    trackDirectory(directory);
    const filePath = path.join(directory, 'projects.json');
    const original = JSON.stringify(payload);
    fs.writeFileSync(filePath, original, 'utf8');
    const store = new ProjectStore(filePath);
    assert.equal(store.getStatus().reason, 'invalid_schema');
    assert.equal(fs.readFileSync(filePath, 'utf8'), original);
  }
});

test('replace rejects future, lossy, and overflow documents without partial publication', () => {
  const { filePath, store } = fixture();
  const before = store.getSnapshot();
  const beforeBytes = fs.readFileSync(filePath, 'utf8');
  const general = before.projects[GENERAL_PROJECT_ID];
  const overflowProjects = { ...before.projects };
  for (let index = 0; index < MAX_PROJECTS; index += 1) {
    const id = `project_replace_${index}`;
    overflowProjects[id] = { ...general, id, name: `Project ${index}` };
  }
  assert.equal(store.replace({ schema_version: 2, projects: before.projects }).reason, 'future_schema');
  assert.equal(store.replace({ ...before, unknown: true }).reason, 'invalid_schema');
  assert.equal(store.replace({ schema_version: 1, projects: overflowProjects }).reason, 'invalid_schema');
  assert.deepEqual(store.getSnapshot(), before);
  assert.equal(fs.readFileSync(filePath, 'utf8'), beforeBytes);
});

test('failed persistence does not publish a new project in memory', () => {
  const now = '2026-09-09T12:00:00.000Z';
  const general = {
    id: GENERAL_PROJECT_ID, name: 'General', root_path: null, root_id: null,
    root_revision: 0, runtime_preferences: {}, created_at: now, updated_at: now,
  };
  const fileStore = {
    readWithStatus: () => ({
      value: { schema_version: 1, projects: { [GENERAL_PROJECT_ID]: general } },
      missing: false,
      corrupted: false,
    }),
    write: () => { throw new Error('disk full'); },
    flush: () => false,
    dispose: () => {},
  };
  const store = new ProjectStore('projects.json', { store: fileStore, now: () => now });
  const service = new ProjectService({ store, idFactory: () => 'project_failed', now: () => now });
  assert.equal(service.create({ name: 'Failed' }).reason, 'write_failed');
  assert.equal(service.get('project_failed'), null);
  assert.deepEqual(service.list().map((project) => project.id), [GENERAL_PROJECT_ID]);
});
