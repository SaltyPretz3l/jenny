'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { ElectronSessionStore } = require('../../services/backend/electron-session-store');
const { SessionShadowStore } = require('../../services/backend/session-shadow-store');
const {
  ApplicationProjectAuthority,
  createProjectRootCanonicalizer,
} = require('../../services/projects/application-project-scope');
const {
  ProjectApplicationService,
  projectAuthorityKey,
} = require('../../services/projects/project-application-service');
const { GENERAL_PROJECT_ID } = require('../../services/projects/project-schema');
const { ProjectService } = require('../../services/projects/project-service');
const { ProjectStore } = require('../../services/projects/project-store');
const { ProjectWorkspacePool } = require('../../services/projects/project-workspace-pool');
const {
  sanitizePermissionDocumentForImport,
} = require('../../services/tools/tool-permission-migrations');
const { ToolPermissionStore } = require('../../services/tools/tool-permission-store');
const { cleanupTrackedResources, createTrackedTempDir } = require('../helpers/resource-cleanup');

test.afterEach(async () => cleanupTrackedResources());

function createFixture({ canonicalizeRoot, writeDebounceMs = 0 } = {}) {
  const root = createTrackedTempDir('jenny-project-application-');
  const profile = path.join(root, 'profile');
  fs.mkdirSync(profile);
  const projectStore = new ProjectStore(path.join(profile, 'projects.json'), {
    now: () => '2026-09-09T12:00:00.000Z',
  });
  let idCounter = 0;
  const projectService = new ProjectService({
    store: projectStore,
    idFactory: () => `project_created_${++idCounter}`,
    canonicalizeRoot,
    now: () => '2026-09-09T12:01:00.000Z',
  });
  const sessionStore = new ElectronSessionStore(path.join(profile, 'sessions.json'), { writeDebounceMs });
  const shadowStore = new SessionShadowStore(
    path.join(profile, 'session-shadow.json'),
    { writeDebounceMs }
  );
  const workspacePool = new ProjectWorkspacePool({ projectService });
  let physicalInode = '101';
  const projectAuthority = {
    captureProject(projectId) {
      const captured = workspacePool.capture(projectId);
      if (!captured.ok) {
        throw Object.assign(new Error('Project authority unavailable.'), {
          code: captured.reason === 'project_not_found' ? 'CMP-PROJECT-0002' : 'CMP-PROJECT-0003',
          reason: captured.reason,
        });
      }
      return captured.authority.root_path
        ? { ...captured.authority, device_id: '11', inode: physicalInode }
        : captured.authority;
    },
    requireCurrent(authority) {
      const current = this.captureProject(authority.project_id);
      if (projectAuthorityKey(current) !== projectAuthorityKey(authority)) {
        throw Object.assign(new Error('Project authority is stale.'), {
          code: 'CMP-PROJECT-0004', reason: 'project_authority_stale',
        });
      }
      return authority;
    },
  };
  let permissionStore = new ToolPermissionStore(path.join(profile, 'tool-permissions.json'));
  const busySessions = new Set();
  const createApplication = (overrides = {}) => new ProjectApplicationService({
    projectService,
    projectStore,
    projectAuthority,
    sessionStore,
    shadowStore,
    permissionStore,
    isSessionBusy: (sessionId) => busySessions.has(sessionId),
    now: () => '2026-09-09T12:02:00.000Z',
    ...overrides,
  });
  return {
    root,
    profile,
    projectStore,
    projectService,
    sessionStore,
    shadowStore,
    projectAuthority,
    busySessions,
    createApplication,
    replacePhysicalRoot: () => { physicalInode = String(Number(physicalInode) + 1); },
    replacePermissionStore(next) { permissionStore = next; },
  };
}

function installImportedReviews(fixture, authority) {
  const permissionPath = path.join(fixture.profile, 'tool-permissions.json');
  const source = new ToolPermissionStore(permissionPath);
  source.grantAlwaysAllow('read_file', {}, authority);
  source.grantAlwaysAllow('write_file', {}, authority);
  const imported = sanitizePermissionDocumentForImport(
    JSON.parse(fs.readFileSync(permissionPath, 'utf8')),
    { now: '2026-09-09T12:03:00.000Z' }
  );
  assert.equal(imported.ok, true);
  fs.writeFileSync(permissionPath, JSON.stringify(imported.document, null, 2));
  const store = new ToolPermissionStore(permissionPath);
  fixture.replacePermissionStore(store);
  return store;
}

test('project operations are closed, revisioned, root-contained, and expose opaque authority keys', () => {
  const fixture = createFixture();
  const application = fixture.createApplication();
  const initial = application.listProjects();
  assert.equal(initial.ok, true);
  assert.equal(initial.projects[0].id, GENERAL_PROJECT_ID);
  assert.equal(initial.projects[0].root_path, null);
  assert.match(initial.projects[0].authority_key, /^authority_[a-f0-9]{64}$/u);
  assert.equal(application.listProjects({ unexpected: true }).error.code, 'CMP-PROJECT-0001');

  assert.equal(application.createProject({ name: 'Alpha', unexpected: true }).ok, false);
  const created = application.createProject({ name: 'Alpha' });
  assert.equal(created.project.id, 'project_created_1');
  assert.equal(application.renameProject({
    project_id: created.project.id,
    name: 'Renamed Alpha',
  }).project.name, 'Renamed Alpha');
  assert.equal(application.bindProjectRoot({
    project_id: GENERAL_PROJECT_ID,
    root_path: fixture.root,
    expected_root_revision: 0,
  }).error.reason, 'general_root_reserved');

  const workspace = path.join(fixture.root, 'workspace');
  fs.mkdirSync(workspace);
  const bound = application.bindProjectRoot({
    project_id: created.project.id,
    root_path: workspace,
    expected_root_revision: 0,
  });
  assert.equal(bound.ok, true);
  assert.equal(bound.project.root_revision, 1);
  assert.match(bound.project.authority_key, /^authority_[a-f0-9]{64}$/u);
  assert.equal(application.bindProjectRoot({
    project_id: created.project.id,
    root_path: null,
    expected_root_revision: 0,
  }).error.reason, 'stale_root_revision');
});

test('host root containment remains enforced through the shared application service', () => {
  const hostRoot = createTrackedTempDir('jenny-host-root-');
  const outside = createTrackedTempDir('jenny-outside-root-');
  const canonicalizeRoot = createProjectRootCanonicalizer({
    restrictRoots: true,
    rootBoundary: fs.realpathSync(hostRoot),
  });
  const fixture = createFixture({ canonicalizeRoot });
  const application = fixture.createApplication();
  const project = application.createProject({ name: 'Hosted' }).project;
  const result = application.bindProjectRoot({
    project_id: project.id,
    root_path: outside,
    expected_root_revision: 0,
  });
  assert.equal(result.error.code, 'CMP-PROJECT-0001');
  assert.equal(result.error.reason, 'invalid_root');
  assert.equal(fixture.projectService.get(project.id).root_path, null);
});

test('session assignment rejects actor-busy work and persists canonical plus shadow state', () => {
  const fixture = createFixture();
  const application = fixture.createApplication();
  const project = application.createProject({ name: 'Session project' }).project;
  const session = fixture.sessionStore.createSession({ title: 'Move me' });
  fixture.busySessions.add(session.id);
  assert.equal(application.assignSessionProject({
    session_id: session.id,
    project_id: project.id,
  }).error.reason, 'session_busy');
  assert.equal(fixture.sessionStore.getSessionSummary(session.id).project_id, GENERAL_PROJECT_ID);

  const indeterminate = fixture.createApplication({ isSessionBusy: () => undefined });
  assert.equal(indeterminate.assignSessionProject({
    session_id: session.id,
    project_id: project.id,
  }).error.reason, 'session_busy');

  fixture.busySessions.clear();
  const assigned = application.assignSessionProject({
    session_id: session.id,
    project_id: project.id,
  });
  assert.equal(assigned.ok, true);
  assert.equal(assigned.session.project_id, project.id);
  assert.equal(fixture.sessionStore.getSessionSummary(session.id).project_id, project.id);
  assert.equal(fixture.shadowStore.getSession(session.id).project_id, project.id);
});

test('an idle chat adopts the Workspace folder project; busy or folderless chats are refused legibly', () => {
  const fixture = createFixture();
  const workspace = path.join(fixture.root, 'Ascend');
  fs.mkdirSync(workspace);
  let resolved = { ok: false, reason: 'workspace_root_unset' };
  const application = fixture.createApplication({ resolveWorkspaceProject: () => resolved });
  const session = fixture.sessionStore.createSession({ title: 'Adopt me' });

  assert.equal(application.adoptWorkspaceSession({ session_id: session.id, extra: 1 }).error.reason,
    'invalid_project_request');
  const unset = application.adoptWorkspaceSession({ session_id: session.id });
  assert.equal(unset.error.reason, 'workspace_root_unset');
  assert.equal(unset.error.code, 'CMP-PROJECT-0001');
  assert.equal(fixture.createApplication().adoptWorkspaceSession({ session_id: session.id })
    .error.reason, 'workspace_project_unavailable');

  resolved = { ok: false, reason: 'root_unavailable' };
  const unavailable = application.adoptWorkspaceSession({ session_id: session.id });
  assert.equal(unavailable.error.reason, 'workspace_project_unavailable');
  assert.equal(unavailable.error.provisioning_reason, 'root_unavailable');

  const project = application.createProject({ name: 'Ascend' }).project;
  assert.equal(application.bindProjectRoot({
    project_id: project.id, root_path: workspace, expected_root_revision: 0,
  }).ok, true);
  resolved = { ok: true, project: fixture.projectService.get(project.id), created: false };
  fixture.busySessions.add(session.id);
  assert.equal(application.adoptWorkspaceSession({ session_id: session.id }).error.reason, 'session_busy');
  assert.equal(fixture.sessionStore.getSessionSummary(session.id).project_id, GENERAL_PROJECT_ID);

  fixture.busySessions.clear();
  const adopted = application.adoptWorkspaceSession({ session_id: session.id });
  assert.equal(adopted.ok, true);
  assert.equal(adopted.session.project_id, project.id);
  assert.equal(adopted.project.id, project.id);
  assert.match(adopted.project.authority_key, /^authority_[a-f0-9]{64}$/u);
  assert.equal(fixture.sessionStore.getSessionSummary(session.id).project_id, project.id);
  assert.equal(fixture.shadowStore.getSession(session.id).project_id, project.id);
  assert.equal(application.adoptWorkspaceSession({ session_id: session.id }).unchanged, true);
});

test('session assignment preflights both stores and reports durable rollback outcomes', async (t) => {
  function assignmentFixture(options) {
    const fixture = createFixture(options);
    const application = fixture.createApplication();
    const project = application.createProject({ name: 'Durable project' }).project;
    const session = fixture.sessionStore.createSession({ title: 'Durable move' });
    return { fixture, application, project, session };
  }

  await t.test('a future canonical schema prevents either mutation', () => {
    const { fixture, application, project, session } = assignmentFixture();
    let shadowMutations = 0;
    fixture.sessionStore.hasNewerSchema = () => true;
    fixture.shadowStore.upsertSession = () => { shadowMutations += 1; return null; };
    const result = application.assignSessionProject({ session_id: session.id, project_id: project.id });
    assert.equal(result.error.reason, 'session_store_future_schema');
    assert.equal(shadowMutations, 0);
    assert.equal(fixture.sessionStore.getSession(session.id).project_id, GENERAL_PROJECT_ID);
  });

  await t.test('a future shadow schema prevents the canonical mutation', () => {
    const { fixture, application, project, session } = assignmentFixture();
    let canonicalMutations = 0;
    const originalUpdate = fixture.sessionStore.updateSession.bind(fixture.sessionStore);
    fixture.sessionStore.updateSession = (...args) => {
      canonicalMutations += 1;
      return originalUpdate(...args);
    };
    fixture.shadowStore.hasNewerSchema = () => true;
    const result = application.assignSessionProject({ session_id: session.id, project_id: project.id });
    assert.equal(result.error.repair.failure_store, 'shadow');
    assert.equal(canonicalMutations, 0);
    assert.equal(fixture.sessionStore.getSession(session.id).project_id, GENERAL_PROJECT_ID);
  });

  await t.test('a refused canonical mutation never reaches the shadow', () => {
    const { fixture, application, project, session } = assignmentFixture();
    let shadowMutations = 0;
    fixture.sessionStore.updateSession = () => null;
    fixture.shadowStore.upsertSession = () => { shadowMutations += 1; return null; };
    const result = application.assignSessionProject({ session_id: session.id, project_id: project.id });
    assert.equal(result.error.repair.failure_store, 'canonical');
    assert.equal(result.error.repair.repair_required, false);
    assert.equal(shadowMutations, 0);
  });

  await t.test('a canonical throw after mutation restores the exact snapshot', () => {
    const { fixture, application, project, session } = assignmentFixture();
    const before = fixture.sessionStore.getSession(session.id);
    const originalUpdate = fixture.sessionStore.updateSession.bind(fixture.sessionStore);
    fixture.sessionStore.updateSession = (...args) => {
      originalUpdate(...args);
      throw new Error('throw after canonical mutation');
    };
    const result = application.assignSessionProject({ session_id: session.id, project_id: project.id });
    assert.equal(result.error.repair.failure_store, 'canonical');
    assert.equal(result.error.repair.canonical_restored, true);
    assert.deepEqual(fixture.sessionStore.getSession(session.id), before);
    assert.equal(fixture.shadowStore.getSession(session.id), null);
  });

  await t.test('canonical durability failure restores its exact snapshot', () => {
    const { fixture, application, project, session } = assignmentFixture({ writeDebounceMs: 60_000 });
    const before = fixture.sessionStore.getSession(session.id);
    fixture.sessionStore.flushSession = () => false;
    const result = application.assignSessionProject({ session_id: session.id, project_id: project.id });
    assert.equal(result.error.repair.failure_store, 'canonical');
    assert.equal(result.error.repair.canonical_restored, true);
    assert.deepEqual(fixture.sessionStore.getSession(session.id), before);
    assert.equal(fixture.shadowStore.getSession(session.id), null);
  });

  await t.test('shadow refusal restores the canonical snapshot', () => {
    const { fixture, application, project, session } = assignmentFixture();
    const before = fixture.sessionStore.getSession(session.id);
    fixture.shadowStore.upsertSession = () => null;
    const result = application.assignSessionProject({ session_id: session.id, project_id: project.id });
    assert.equal(result.error.repair.failure_store, 'shadow');
    assert.equal(result.error.repair.repair_required, false);
    assert.deepEqual(fixture.sessionStore.getSession(session.id), before);
  });

  await t.test('a shadow throw after mutation restores both stores', () => {
    const { fixture, application, project, session } = assignmentFixture();
    const canonicalBefore = fixture.sessionStore.getSession(session.id);
    const originalUpsert = fixture.shadowStore.upsertSession.bind(fixture.shadowStore);
    fixture.shadowStore.upsertSession = (...args) => {
      originalUpsert(...args);
      throw new Error('throw after shadow mutation');
    };
    const result = application.assignSessionProject({ session_id: session.id, project_id: project.id });
    assert.equal(result.error.repair.failure_store, 'shadow');
    assert.equal(result.error.repair.canonical_restored, true);
    assert.equal(result.error.repair.shadow_restored, true);
    assert.deepEqual(fixture.sessionStore.getSession(session.id), canonicalBefore);
    assert.equal(fixture.shadowStore.getSession(session.id), null);
  });

  await t.test('failed canonical rollback is exposed as required repair', () => {
    const { fixture, application, project, session } = assignmentFixture();
    fixture.shadowStore.upsertSession = () => null;
    fixture.sessionStore._backend.restoreSessionSnapshot = () => false;
    const result = application.assignSessionProject({ session_id: session.id, project_id: project.id });
    assert.equal(result.error.repair.failure_store, 'shadow');
    assert.equal(result.error.repair.canonical_restored, false);
    assert.equal(result.error.repair.repair_required, true);
    assert.equal(fixture.sessionStore.getSession(session.id).project_id, project.id);
  });
});

test('automatic permission review binds revision and physical authority while dismiss never grants', () => {
  const fixture = createFixture();
  let application = fixture.createApplication();
  const project = application.createProject({ name: 'Reviewed project' }).project;
  const workspace = path.join(fixture.root, 'reviewed-workspace');
  fs.mkdirSync(workspace);
  const bound = application.bindProjectRoot({
    project_id: project.id,
    root_path: workspace,
    expected_root_revision: 0,
  }).project;
  const permissionStore = installImportedReviews(
    fixture,
    fixture.projectAuthority.captureProject(project.id)
  );
  let refreshes = 0;
  application = fixture.createApplication({
    permissionStore,
    onPermissionChanged: () => { refreshes += 1; },
  });
  const state = application.getPermissionReviewState();
  assert.equal(state.pending_count, 2);
  assert.equal(
    application.getPermissionReviewState({ unexpected: true }).error.reason,
    'permission_review_request_invalid'
  );
  const [automatic, dismissed] = state.pending;

  fixture.replacePhysicalRoot();
  const stale = application.resolvePermissionReview({
    review_id: automatic.id,
    decision: 'auto',
    project_id: project.id,
    expected_root_revision: bound.root_revision,
    expected_authority_key: bound.authority_key,
  });
  assert.equal(stale.error.code, 'CMP-PROJECT-0004');
  assert.equal(permissionStore.getReviewState().pending_count, 2);

  const currentProject = application.listProjects().projects.find((item) => item.id === project.id);
  const approved = application.resolvePermissionReview({
    review_id: automatic.id,
    decision: 'auto',
    project_id: project.id,
    expected_root_revision: currentProject.root_revision,
    expected_authority_key: currentProject.authority_key,
  });
  assert.equal(approved.ok, true);
  const decisionsAfterAuto = permissionStore.listStoredDecisions();
  assert.equal(decisionsAfterAuto.scoped_grants.length, 1);
  assert.equal(decisionsAfterAuto.scoped_grants[0].authority.inode, '102');

  const dismissedResult = application.resolvePermissionReview({
    review_id: dismissed.id,
    decision: 'dismiss',
  });
  assert.equal(dismissedResult.ok, true);
  assert.equal(permissionStore.listStoredDecisions().scoped_grants.length, 1);
  assert.equal(permissionStore.getReviewState().history.at(-1).decision, 'dismiss');
  assert.equal(refreshes, 2);
});

test('application authority remains store-backed and never accepts caller-provided authority', () => {
  const fixture = createFixture();
  const application = fixture.createApplication();
  const state = application.getPermissionReviewState();
  assert.equal(state.pending_count, 0);
  const result = application.resolvePermissionReview({
    review_id: 'forged',
    decision: 'dismiss',
    authority: { project_id: GENERAL_PROJECT_ID },
  });
  assert.equal(result.error.reason, 'permission_review_request_invalid');
});
