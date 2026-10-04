'use strict';

// Deleting a project moves its memories and knowledge folders to General in
// the same all-or-nothing operation as its chats (PO review 2026-09-27, D10):
// Memory must never show a raw `project_…` id afterwards. Any definite failure
// puts every chat, folder and the project entry back; a memory move that got
// no answer keeps the delete and is finished later (DPR-008, see
// project-delete-memory-recovery.test.js). Scoped permission grants are
// keyed by the project's captured authority, so they can never match again and
// are dropped after the delete succeeds.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { ElectronSessionStore } = require('../../services/backend/electron-session-store');
const { KnowledgeService } = require('../../services/knowledge-service');
const { ProjectApplicationService } = require('../../services/projects/project-application-service');
const { ProjectDeleteJournal } = require('../../services/projects/project-delete-journal');
const { GENERAL_PROJECT_ID } = require('../../services/projects/project-schema');
const { ProjectService } = require('../../services/projects/project-service');
const { ProjectStore } = require('../../services/projects/project-store');
const { ProjectWorkspacePool } = require('../../services/projects/project-workspace-pool');
const { ToolPermissionStore } = require('../../services/tools/tool-permission-store');
const { cleanupTrackedResources, createTrackedTempDir } = require('../helpers/resource-cleanup');

test.afterEach(async () => cleanupTrackedResources());

function createFixture({ moveMemories, isSessionBusy = () => false } = {}) {
  const root = createTrackedTempDir('jenny-project-delete-moves-');
  const profile = path.join(root, 'profile');
  fs.mkdirSync(profile);
  const folder = path.join(root, 'Ascend');
  fs.mkdirSync(folder);
  const docs = path.join(root, 'Docs');
  fs.mkdirSync(docs);
  const sharedDocs = path.join(root, 'SharedDocs');
  fs.mkdirSync(sharedDocs);
  const projectStore = new ProjectStore(path.join(profile, 'projects.json'), { now: () => '2026-09-27T12:00:00.000Z' });
  let idCounter = 0;
  const projectService = new ProjectService({
    store: projectStore,
    idFactory: () => `project_created_${++idCounter}`,
    now: () => '2026-09-27T12:01:00.000Z',
  });
  const sessionStore = new ElectronSessionStore(path.join(profile, 'sessions.json'), { writeDebounceMs: 0 });
  const workspacePool = new ProjectWorkspacePool({ projectService });
  const projectAuthority = {
    captureProject(projectId) {
      const captured = workspacePool.capture(projectId);
      if (!captured.ok) {
        throw Object.assign(new Error('Project authority unavailable.'), { code: 'CMP-PROJECT-0002', reason: captured.reason });
      }
      return captured.authority;
    },
  };
  const knowledgeService = new KnowledgeService({
    userDataPath: profile,
    featureFlagProvider: () => ({ knowledge_layer: true }),
    isSensitivePathImpl: () => false,
  });
  const permissionStore = new ToolPermissionStore(path.join(profile, 'tool-permissions.json'));
  const memoryCalls = [];
  const journal = new ProjectDeleteJournal(path.join(profile, 'project-delete-operations.json'));
  const application = new ProjectApplicationService({
    projectService,
    projectStore,
    projectAuthority,
    sessionStore,
    permissionStore,
    knowledgeService,
    projectDeleteJournal: journal,
    moveProjectMemories: async (request) => {
      memoryCalls.push(request);
      return moveMemories ? moveMemories(request, memoryCalls.length) : { ok: true, moved: 3 };
    },
    isSessionBusy: (sessionId) => isSessionBusy(sessionId),
    resolveWorkspaceRoot: () => '',
    now: () => '2026-09-27T12:02:00.000Z',
  });
  const project = application.createProject({ name: 'Ascend' }).project;
  assert.equal(application.bindProjectRoot({
    project_id: project.id, root_path: folder, expected_root_revision: 0,
  }).ok, true);
  const chat = sessionStore.createSession({ title: 'One' });
  assert.equal(application.assignSessionProject({ session_id: chat.id, project_id: project.id }).ok, true);
  assert.equal(knowledgeService.addFolder({ path: docs, projectId: project.id }).ok, true);
  // The same folder is registered under General too: the move merges it.
  assert.equal(knowledgeService.addFolder({ path: sharedDocs, projectId: project.id }).ok, true);
  assert.equal(knowledgeService.addFolder({ path: sharedDocs, projectId: GENERAL_PROJECT_ID }).ok, true);
  return {
    application, projectService, sessionStore, knowledgeService, permissionStore, memoryCalls, journal,
    project: projectService.get(project.id), chat, docs, sharedDocs, workspacePool,
  };
}

function knowledgePaths(knowledgeService, projectId) {
  return knowledgeService.getStateSnapshot({ projectId }).roots.map((root) => root.path).sort();
}

test('delete moves chats, memories and knowledge folders to General and reports each count', async () => {
  const fixture = createFixture();
  const result = await fixture.application.deleteProject({ project_id: fixture.project.id });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.moved_sessions, 1);
  assert.equal(result.moved_memories, 3);
  assert.equal(result.moved_knowledge, 2, 'both folders now live in General (one merged)');
  assert.deepEqual(fixture.memoryCalls, [{ from_project_id: fixture.project.id, to_project_id: GENERAL_PROJECT_ID }]);
  assert.deepEqual(knowledgePaths(fixture.knowledgeService, fixture.project.id), []);
  assert.deepEqual(
    knowledgePaths(fixture.knowledgeService, GENERAL_PROJECT_ID),
    [fs.realpathSync.native(fixture.docs), fs.realpathSync.native(fixture.sharedDocs)].sort(),
  );
  assert.equal(fixture.sessionStore.getSessionSummary(fixture.chat.id).project_id, GENERAL_PROJECT_ID);
  assert.equal(fixture.projectService.get(fixture.project.id), null);
});

test('a refused memory move puts the project, its chats and its knowledge folders back', async () => {
  const fixture = createFixture({ moveMemories: async () => ({ ok: false, reason: 'sidecar_unavailable' }) });
  const before = knowledgePaths(fixture.knowledgeService, fixture.project.id);
  const generalBefore = knowledgePaths(fixture.knowledgeService, GENERAL_PROJECT_ID);
  const result = await fixture.application.deleteProject({ project_id: fixture.project.id });
  assert.equal(result.ok, false);
  assert.equal(result.error.reason, 'project_memories_unavailable');
  assert.equal(result.error.moved_sessions, 0, 'no chat is left in General');
  assert.equal(result.error.restored_sessions, 1);
  assert.equal(result.error.project_restored, true);
  assert.deepEqual(fixture.projectService.get(fixture.project.id), fixture.project, 'the exact entry is back');
  assert.equal(fixture.sessionStore.getSessionSummary(fixture.chat.id).project_id, fixture.project.id);
  assert.deepEqual(knowledgePaths(fixture.knowledgeService, fixture.project.id), before);
  assert.deepEqual(knowledgePaths(fixture.knowledgeService, GENERAL_PROJECT_ID), generalBefore);
  assert.deepEqual(fixture.journal.list(), [], 'a rolled-back delete leaves no record');
});

test('a memory mover that answers ok:false is a failure too', async () => {
  const fixture = createFixture({ moveMemories: async () => ({ ok: false, reason: 'memory_unavailable' }) });
  const result = await fixture.application.deleteProject({ project_id: fixture.project.id });
  assert.equal(result.ok, false);
  assert.equal(result.error.reason, 'project_memories_unavailable');
  assert.ok(fixture.projectService.get(fixture.project.id));
});

test('an unreadable knowledge registry refuses the delete before anything moves', async () => {
  const fixture = createFixture();
  fixture.knowledgeService._readOnlyReason = 'malformed_json';
  const result = await fixture.application.deleteProject({ project_id: fixture.project.id });
  assert.equal(result.ok, false);
  assert.equal(result.error.reason, 'project_knowledge_unavailable');
  assert.equal(fixture.memoryCalls.length, 0);
  assert.equal(fixture.sessionStore.getSessionSummary(fixture.chat.id).project_id, fixture.project.id);
  assert.ok(fixture.projectService.get(fixture.project.id));
});

test('a failed project-store write puts knowledge folders and chats back and never touches memories', async () => {
  const fixture = createFixture();
  const before = knowledgePaths(fixture.knowledgeService, fixture.project.id);
  fixture.projectService.remove = () => ({ ok: false, reason: 'write_failed' });
  const result = await fixture.application.deleteProject({ project_id: fixture.project.id });
  assert.equal(result.ok, false);
  assert.equal(fixture.memoryCalls.length, 0);
  assert.deepEqual(knowledgePaths(fixture.knowledgeService, fixture.project.id), before);
  assert.equal(fixture.sessionStore.getSessionSummary(fixture.chat.id).project_id, fixture.project.id);
  assert.deepEqual(fixture.journal.list(), [], 'the record written before the removal is cleared');
});

test('scoped permission grants captured for the deleted project are dropped; other grants stay', async () => {
  const fixture = createFixture();
  fixture.permissionStore.grantAlwaysAllow('read_file', {}, fixture.workspacePool.capture(fixture.project.id).authority);
  fixture.permissionStore.grantAlwaysAllow('read_file', {}, fixture.workspacePool.capture(GENERAL_PROJECT_ID).authority);
  assert.equal(fixture.permissionStore.listStoredDecisions().scoped_grants.length, 2);
  const result = await fixture.application.deleteProject({ project_id: fixture.project.id });
  assert.equal(result.ok, true);
  assert.equal(result.dropped_grants, 1);
  const remaining = fixture.permissionStore.listStoredDecisions().scoped_grants;
  assert.deepEqual(remaining.map((grant) => grant.authority.project_id), [GENERAL_PROJECT_ID]);
});

test('hosts without a memory or knowledge backend still delete, reporting zero moves', async () => {
  const fixture = createFixture();
  const bare = new ProjectApplicationService({
    projectService: fixture.projectService,
    projectStore: fixture.projectService._store,
    projectAuthority: { captureProject: (id) => fixture.workspacePool.capture(id).authority },
    sessionStore: fixture.sessionStore,
    permissionStore: fixture.permissionStore,
    isSessionBusy: () => false,
  });
  const result = await bare.deleteProject({ project_id: fixture.project.id });
  assert.equal(result.ok, true);
  assert.equal(result.moved_memories, 0);
  assert.equal(result.moved_knowledge, 0);
});

test('an unanswered memory move is retried once: a move that committed before its reply was lost completes the delete', async () => {
  // The first reply is lost after the sidecar committed; the idempotent retry finds nothing left to move.
  const fixture = createFixture({ moveMemories: async (_request, call) => {
    if (call === 1) throw new Error('Sidecar memory.move_project timed out after 10000ms');
    return { ok: true, moved: 0 };
  } });
  const result = await fixture.application.deleteProject({ project_id: fixture.project.id });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(fixture.memoryCalls.length, 2);
  assert.equal(fixture.projectService.get(fixture.project.id), null, 'the project is not restored over moved memories');
  assert.equal(fixture.sessionStore.getSessionSummary(fixture.chat.id).project_id, GENERAL_PROJECT_ID);
  assert.equal(result.memory_outcome, undefined);
  assert.deepEqual(fixture.journal.list(), []);
});

test('two unanswered memory moves keep the delete, its knowledge move and a record to finish from', async () => {
  const fixture = createFixture({ moveMemories: async () => { throw new Error('timed out'); } });
  fixture.permissionStore.grantAlwaysAllow('read_file', {}, fixture.workspacePool.capture(fixture.project.id).authority);
  const result = await fixture.application.deleteProject({ project_id: fixture.project.id });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.memory_outcome, 'pending');
  assert.equal(result.moved_memories, 0);
  assert.equal(result.moved_sessions, 1);
  assert.equal(result.moved_knowledge, 2);
  assert.equal(result.dropped_grants, 1);
  assert.equal(fixture.memoryCalls.length, 2);
  assert.equal(fixture.projectService.get(fixture.project.id), null);
  assert.deepEqual(knowledgePaths(fixture.knowledgeService, fixture.project.id), []);
  assert.deepEqual(fixture.journal.list().map((operation) => operation.project_id), [fixture.project.id]);
});

test('an unanswered move followed by a refusal is still unknown: the delete is kept', async () => {
  // The first request may have committed; the refusal only describes the second.
  const fixture = createFixture({ moveMemories: async (_request, call) => {
    if (call === 1) throw new Error('timed out');
    return { ok: false, reason: 'CMP-MEMORY-0001' };
  } });
  const result = await fixture.application.deleteProject({ project_id: fixture.project.id });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.memory_outcome, 'pending');
  assert.equal(fixture.projectService.get(fixture.project.id), null);
  assert.equal(fixture.journal.list().length, 1);
});

test('a refused delete whose project entry cannot be put back keeps its record', async () => {
  const fixture = createFixture({ moveMemories: async () => ({ ok: false, reason: 'memory_unavailable' }) });
  fixture.projectService.restore = () => ({ ok: false, reason: 'write_failed' });
  const result = await fixture.application.deleteProject({ project_id: fixture.project.id });
  assert.equal(result.ok, false);
  assert.equal(result.error.project_restored, false);
  assert.equal(fixture.projectService.get(fixture.project.id), null);
  assert.equal(fixture.journal.list().length, 1, 'the memories still follow the deleted project to General');
});

test('a definite memory refusal rolls back without claiming an unknown outcome', async () => {
  const fixture = createFixture({ moveMemories: async () => ({ ok: false, reason: 'memory_unavailable' }) });
  const result = await fixture.application.deleteProject({ project_id: fixture.project.id });
  assert.equal(result.ok, false);
  assert.equal(result.error.memory_outcome, undefined);
  assert.equal(result.error.memory_reason, 'memory_unavailable');
});

test('rollback leaves a chat the user moved elsewhere during the memory move where the user put it', async () => {
  let fixture = null;
  fixture = createFixture({ moveMemories: async () => {
    const other = fixture.application.createProject({ name: 'Other' }).project;
    assert.equal(fixture.application.assignSessionProject({ session_id: fixture.chat.id, project_id: other.id }).ok, true);
    fixture.otherId = other.id;
    return { ok: false, reason: 'sidecar_unavailable' };
  } });
  const result = await fixture.application.deleteProject({ project_id: fixture.project.id });
  assert.equal(result.ok, false);
  assert.equal(result.error.project_restored, true);
  assert.equal(result.error.restored_sessions, 0);
  assert.equal(result.error.moved_sessions, 1, 'the chat is reported as not put back');
  assert.equal(fixture.sessionStore.getSessionSummary(fixture.chat.id).project_id, fixture.otherId, 'the newer assignment wins');
});

test('rollback never reassigns a chat that started work during the memory move', async () => {
  let busy = false;
  const fixture = createFixture({
    isSessionBusy: () => busy,
    moveMemories: async () => { busy = true; return { ok: false, reason: 'sidecar_unavailable' }; },
  });
  const result = await fixture.application.deleteProject({ project_id: fixture.project.id });
  assert.equal(result.ok, false);
  assert.equal(result.error.restored_sessions, 0);
  assert.equal(fixture.sessionStore.getSessionSummary(fixture.chat.id).project_id, GENERAL_PROJECT_ID, 'a busy chat is never moved');
});
