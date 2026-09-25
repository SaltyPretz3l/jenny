'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { BackendService } = require('../../services/backend/backend-service');
const { ElectronSessionStore } = require('../../services/backend/electron-session-store');
const { PROJECT_ERROR_CODES } = require('../../services/backend/error-codes');
const { initializeApplicationProjects } = require('../../services/projects/application-project-scope');
const { GENERAL_PROJECT_ID } = require('../../services/projects/project-schema');
const { buildLinkedSessionContext } = require('../../services/backend/linked-session-recall');
const { cleanupTrackedResources, trackDirectory } = require('../helpers/resource-cleanup');
const { createFakeSafeStorage } = require('../helpers/fake-safe-storage');
const { isSessionBusy } = require('../../services/projects/application-execution-composition');
const { RuntimeStore } = require('../../services/session-runtime/store');
const { RuntimeLaneAdmission } = require('../../services/session-runtime/lanes');
const { ResourceBroker } = require('../../services/session-runtime/resource-broker');

const trackedDisposables = [];

function trackDisposable(disposable) {
  trackedDisposables.push(disposable);
  return disposable;
}

test.afterEach(async () => {
  while (trackedDisposables.length) trackedDisposables.pop().dispose();
  await cleanupTrackedResources();
});

test('application inspection resolves the current runtime lazily and remains read-only when OFF', t => {
  const { service, userDataPath } = createService();
  const originalRuntime = service.sessionRuntime;
  t.after(() => { service.sessionRuntime = originalRuntime; service.dispose(); });
  service.sessionRuntime = null;
  assert.equal(service.runtimeApplicationService.getSnapshot().error.reason, 'runtime_unavailable');
  service.sessionStore.getSession = () => { throw new Error('inspection must not hydrate transcripts'); };
  service.sessionRuntime = {
    store: new RuntimeStore(path.join(userDataPath, 'inspection-fixture')),
    lanes: new RuntimeLaneAdmission(),
    resourceBroker: new ResourceBroker(),
    scheduler: { enabled: false, closing: false },
  };
  const snapshot = service.runtimeApplicationService.getSnapshot({ limit: 5 });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.enabled, false);
  assert.deepEqual(snapshot.work, []);
  assert.equal(snapshot.next_cursor, null);
});

test('project API composition refuses in-flight lifecycle assignment before transcript access', async t => {
  const { service } = createService();
  t.after(() => service.dispose());
  const session = (await service.createSession({})).data;
  const target = service.projectApplicationService.createProject({ name: 'Target' });
  assert.equal(target.ok, true);
  const deletion = service.sessionTurnActors.beginDeletion(session.id);
  const originalGetSession = service.sessionStore.getSession;
  service.sessionStore.getSession = () => { throw new Error('busy assignment must not hydrate history'); };
  try {
    const result = service.projectApplicationService.assignSessionProject({
      session_id: session.id, project_id: target.project.id,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.reason, 'session_busy');
  } finally {
    service.sessionStore.getSession = originalGetSession;
    service.sessionTurnActors.rollbackDeletion(deletion);
  }
  assert.equal(service.projectApplicationService.getPermissionReviewState().read_only, true);
});

test('assignment busy gate includes persisted turns and pending runtime work without reading messages', () => {
  const service = { sessionTurnActors: { hasActiveLifecycle: () => false },
    sessionStore: { listSessionRecords: () => [{ id: 'a', active_turn: { stream_id: 'live' } }] } };
  assert.equal(isSessionBusy(service, 'a'), true);
  assert.equal(isSessionBusy(service, 'b'), false);
  service.sessionRuntime = { hasSessionWork: id => id === 'b' };
  assert.equal(isSessionBusy(service, 'b'), true);
  service.sessionRuntime = {};
  assert.equal(isSessionBusy(service, 'b'), true, 'unknown runtime state cannot prove idleness');
});

function createService(prefix = 'jenny-application-scope-') {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trackDirectory(userDataPath);
  const service = trackDisposable(new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: 'mock-v1',
  }));
  return { service, userDataPath };
}

async function createProjectSession(service, name) {
  const project = service.projectService.create({ name });
  assert.equal(project.ok, true);
  const session = await service.createSession({ title: `${name} chat`, projectId: project.project.id });
  return { project: project.project, session: session.data };
}

test('application composes one project owner and captures session authority from index metadata', async (t) => {
  const { service } = createService();
  t.after(() => service.dispose());
  const { project, session } = await createProjectSession(service, 'Alpha');

  service.sessionStore.getSession = () => {
    throw new Error('transcript hydration must not be used for authority capture');
  };
  const authority = service.projectAuthority.captureSession(session.id);
  assert.equal(authority.project_id, project.id);
  assert.equal(authority.root_path, null);
  assert.equal(service.projectAuthority.requireCurrent(authority), authority);
  assert.equal(service.projectStore.getStatus().read_only, false);
  assert.equal(service.projectWorkspacePool.isCurrent(authority), true);
});

test('new sessions reject invalid and unknown projects with structured project errors', async (t) => {
  const { service } = createService();
  t.after(() => service.dispose());

  await assert.rejects(
    service.createSession({ projectId: '../invalid' }),
    (error) => error.code === PROJECT_ERROR_CODES.INVALID && error.reason === 'invalid_project_id'
  );
  await assert.rejects(
    service.createSession({ projectId: 'project_unknown' }),
    (error) => error.code === PROJECT_ERROR_CODES.NOT_FOUND && error.reason === 'project_not_found'
  );
  assert.equal(service.sessionStore.listSessions().length, 0);
});

test('corrupt project state stays preserved and rejects project-scoped operations', async (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-application-corrupt-'));
  trackDirectory(userDataPath);
  const projectPath = path.join(userDataPath, 'projects.json');
  const original = '{"schema_version":1,"projects":[]}';
  fs.writeFileSync(projectPath, original, 'utf8');
  const service = trackDisposable(new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: 'mock-v1',
  }));
  t.after(() => service.dispose());

  await assert.rejects(
    service.createSession({ title: 'Blocked' }),
    (error) => error.code === PROJECT_ERROR_CODES.UNAVAILABLE && error.reason === 'invalid_schema'
  );
  // Memory listing is cross-project metadata (scope 'all') and needs no project
  // authority; project-scoped recall still fails closed on a corrupt registry.
  await assert.rejects(
    service.recallApprovedMemories('anything', 3),
    (error) => error.code === PROJECT_ERROR_CODES.UNAVAILABLE && error.reason === 'invalid_schema'
  );
  assert.equal(fs.readFileSync(projectPath, 'utf8'), original);
});

test('session memory writes use canonical project metadata and ignore candidate scope', async (t) => {
  const { service } = createService();
  t.after(() => service.dispose());
  const { project, session } = await createProjectSession(service, 'Alpha');
  const calls = [];
  service.sidecarClient = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'memory.save') return { created: true, memory: { id: 1 } };
      if (method === 'memory.pending.delete') return { deleted: true };
      return { suggestions: [] };
    },
    dispose() {},
  };

  await service.suggestMemoriesForSession(session.id);
  await service.saveMemoryForSession(session.id, {
    title: 'Scoped',
    lesson_text: 'Keep this project local.',
    lesson_kind: 'instruction',
    content_fingerprint: 'same-fingerprint',
    project_id: 'project_attacker',
  });
  await service.deletePendingMemory(session.id, 'same-fingerprint');

  assert.deepEqual(calls.map((entry) => [entry.method, entry.params.project_id]), [
    ['memory.suggest', project.id],
    ['memory.save', project.id],
    ['memory.pending.delete', project.id],
  ]);
  assert.equal(Object.hasOwn(calls[1].params.candidate, 'project_id'), false);
});

test('global memory inspection spans every project and dismissed fingerprints stay project-local', async (t) => {
  const { service } = createService();
  t.after(() => service.dispose());
  const alpha = await createProjectSession(service, 'Alpha');
  const beta = await createProjectSession(service, 'Beta');
  const calls = [];
  service.sidecarClient = {
    async request(method, params) {
      calls.push({ method, params });
      return { memories: [], candidates: [], next_cursor: null };
    },
    dispose() {},
  };

  await service.listApprovedMemories();
  await service.listPendingMemories();
  assert.deepEqual(calls.map((entry) => [entry.method, entry.params.scope, entry.params.project_id]), [
    ['memory.list', 'all', undefined],
    ['memory.pending.list', 'all', undefined],
  ]);

  service.dismissMemorySuggestion(alpha.session.id, 'shared-fingerprint');
  assert.equal(service.isMemorySuggestionDismissed(alpha.session.id, 'shared-fingerprint'), true);
  assert.equal(service.isMemorySuggestionDismissed(beta.session.id, 'shared-fingerprint'), false);
  service.dismissMemorySuggestion('shared-fingerprint');
  assert.equal(service.isMemorySuggestionDismissed('shared-fingerprint'), true);
  assert.equal(service.isMemorySuggestionDismissed(beta.session.id, 'shared-fingerprint'), false);
});

test('malformed current session scope remains inspectable and cannot authorize General', async (t) => {
  const { service, userDataPath } = createService('jenny-malformed-current-scope-');
  const created = await service.createSession({ title: 'Current schema' });
  const sessionId = created.data.id;
  const indexPath = service.sessionStore._backend._indexPath;
  const sessionPath = service.sessionStore._backend._sessionFilePath(sessionId);
  service.dispose();

  for (const filePath of [indexPath, sessionPath]) {
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (filePath === indexPath) payload.sessions[sessionId].project_id = '../malformed';
    else payload.session.project_id = '../malformed';
    fs.writeFileSync(filePath, JSON.stringify(payload), 'utf8');
  }
  const reopened = trackDisposable(new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: 'mock-v1',
  }));
  t.after(() => reopened.dispose());

  assert.equal(reopened.sessionStore.getSessionSummary(sessionId).project_id, '../malformed');
  await assert.rejects(
    reopened.suggestMemoriesForSession(sessionId),
    (error) => error.code === PROJECT_ERROR_CODES.INVALID && error.reason === 'invalid_project_id'
  );
});

test('summary identity stays bound to the index key before linked recall', async (t) => {
  const { service } = createService();
  t.after(() => service.dispose());
  const alpha = await createProjectSession(service, 'Alpha');
  const beta = await createProjectSession(service, 'Beta');
  const linked = await service.createSession({ title: 'Alpha notes', projectId: alpha.project.id });
  const snapshot = service.sessionStore._backend.getIndexSnapshot();
  snapshot.sessions[alpha.session.id] = {
    ...snapshot.sessions[alpha.session.id], linked_session_ids: [linked.data.id],
  };
  snapshot.sessions[linked.data.id] = { ...snapshot.sessions[linked.data.id], id: beta.session.id };
  t.mock.method(service.sessionStore._backend, 'getIndexSnapshot', () => snapshot);
  const reads = [];
  t.mock.method(service.sessionStore, 'getSessionMessages', (id) => {
    reads.push(id);
    return [{ role: 'user', content: 'Keep the release plan within this project.' }];
  });
  assert.equal(service.sessionStore.getSessionSummary(linked.data.id).id, linked.data.id);
  buildLinkedSessionContext(service.sessionStore, alpha.session.id, 'release plan', []);
  assert.deepEqual(reads, [linked.data.id]);
});

test('inherited or malformed index entries never identify a session', (t) => {
  const { service } = createService();
  t.after(() => service.dispose());
  const snapshot = { sessions: { bad_array: [], bad_text: 'invalid' } };
  t.mock.method(service.sessionStore._backend, 'getIndexSnapshot', () => snapshot);
  for (const id of ['__proto__', 'constructor', 'bad_array', 'bad_text']) {
    assert.equal(service.sessionStore.getSessionSummary(id), null);
    assert.throws(() => service.projectAuthority.captureSession(id),
      (error) => error.code === PROJECT_ERROR_CODES.NOT_FOUND);
  }
  snapshot.sessions.missing_project = { title: 'Inspectable' };
  assert.throws(() => service.projectAuthority.captureSession('missing_project'),
    (error) => error.code === PROJECT_ERROR_CODES.INVALID);
});

test('future session indexes remain inspectable but cannot authorize memory operations', async (t) => {
  const { service, userDataPath } = createService('jenny-future-session-scope-');
  const created = await service.createSession({ title: 'Future history' });
  const indexPath = service.sessionStore._backend._indexPath;
  service.dispose();
  const payload = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  payload.schema_version = 999;
  const preserved = JSON.stringify(payload);
  fs.writeFileSync(indexPath, preserved, 'utf8');
  const reopened = trackDisposable(new BackendService({ userDataPath, repoRoot: process.cwd(),
    pythonExecutable: process.execPath, safeStorage: createFakeSafeStorage(), defaultModel: 'mock-v1' }));
  t.after(() => reopened.dispose());
  assert.equal(reopened.sessionStore.getSessionSummary(created.data.id).title, 'Future history');
  await assert.rejects(reopened.saveMemoryForSession(created.data.id, { title: 'Refused' }),
    (error) => error.code === PROJECT_ERROR_CODES.UNAVAILABLE && error.reason === 'session_schema_too_new');
  assert.equal(fs.readFileSync(indexPath, 'utf8'), preserved);
});

test('project store participates in the shared backend drain', (t) => {
  const { service } = createService();
  let disposed = 0;
  const originalDispose = service.projectStore.dispose.bind(service.projectStore);
  service.projectStore.dispose = () => {
    disposed += 1;
    originalDispose();
  };
  t.after(() => service.dispose());

  service.dispose();
  assert.equal(disposed, 1);
});

test('host capture rejects a persisted root outside the configured mount without hiding history', async (t) => {
  const { service, userDataPath } = createService('jenny-host-persisted-root-');
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-outside-host-mount-'));
  trackDirectory(outsideRoot);
  const created = service.projectService.create({ name: 'Desktop root' });
  assert.equal(service.projectService.bindRoot(created.project.id, outsideRoot).ok, true);
  const session = await service.createSession({ projectId: created.project.id });
  service.dispose();

  const sessionStore = trackDisposable(new ElectronSessionStore(path.join(userDataPath, 'sessions.json')));
  const hostService = { sessionStore, _emitServiceLog() {} };
  const mountedRoot = path.join(userDataPath, 'mounted-workspace');
  fs.mkdirSync(mountedRoot);
  initializeApplicationProjects(hostService, {
    userDataPath,
    hostMode: 'server',
    projectRootBoundary: mountedRoot,
  });
  trackDisposable(hostService.projectStore);
  t.after(() => {
    hostService.projectStore.dispose();
    sessionStore.dispose();
  });

  assert.equal(hostService.sessionStore.getSessionSummary(session.data.id).title, 'New Chat');
  assert.throws(
    () => hostService.projectAuthority.captureSession(session.data.id),
    (error) => error.code === PROJECT_ERROR_CODES.UNAVAILABLE
      && error.reason === 'project_root_outside_host_workspace'
  );
});
