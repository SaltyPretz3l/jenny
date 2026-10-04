'use strict';

// Review finding DPR-008: a project delete whose memory move committed in the
// sidecar while the reply was lost must not put the project back over memories
// that already sit in General. The delete is recorded in the project delete
// journal, stays deleted, and the move is re-issued once the sidecar is back.
//
// These tests drive the real mover (backend-memory.js) and a real
// SidecarClient against a fake sidecar process that owns a tiny memory table,
// so "the move committed, then the pipe dropped" is the actual sequence.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');

const { moveProjectMemories } = require('../../services/backend/backend-memory');
const { ElectronSessionStore } = require('../../services/backend/electron-session-store');
const { initializeManagedSidecar } = require('../../services/backend/managed-sidecar-lifecycle');
const { SidecarClient } = require('../../services/backend/sidecar-client');
const { encodeFrame } = require('../../services/backend/sidecar-client-transport-codec');
const { ProjectApplicationService } = require('../../services/projects/project-application-service');
const { ProjectDeleteJournal } = require('../../services/projects/project-delete-journal');
const { GENERAL_PROJECT_ID } = require('../../services/projects/project-schema');
const { ProjectService } = require('../../services/projects/project-service');
const { ProjectStore } = require('../../services/projects/project-store');
const { ProjectWorkspacePool } = require('../../services/projects/project-workspace-pool');
const { ToolPermissionStore } = require('../../services/tools/tool-permission-store');
const { cleanupTrackedResources, createTrackedTempDir } = require('../helpers/resource-cleanup');

test.afterEach(async () => cleanupTrackedResources());

const JOURNAL_FILE = 'project-delete-operations.json';

// The sidecar's side of memory.move_project: rows keyed by project. A move is
// the same convergent operation as the real store's (a second run finds no
// source rows). `mode` decides what happens to the reply.
class FakeSidecar {
  constructor() {
    this.rows = new Map();
    this.mode = 'answer';
    this.moveRequests = 0;
  }

  seed(projectId, count) {
    this.rows.set(projectId, count);
  }

  count(projectId) {
    return this.rows.get(projectId) || 0;
  }

  spawn() {
    const proc = new EventEmitter();
    proc.stdout = new Readable({ read() {} });
    let buffered = Buffer.alloc(0);
    proc.stdin = new Writable({
      write: (chunk, _encoding, done) => {
        buffered = this._drain(proc, Buffer.concat([buffered, chunk]));
        done();
      },
    });
    return proc;
  }

  _drain(proc, buffer) {
    let rest = buffer;
    for (;;) {
      const headerEnd = rest.indexOf('\r\n\r\n');
      if (headerEnd < 0) return rest;
      const length = Number(/Content-Length:\s*(\d+)/iu.exec(rest.subarray(0, headerEnd).toString('utf8'))?.[1]);
      const bodyStart = headerEnd + 4;
      if (rest.length < bodyStart + length) return rest;
      this._handle(proc, JSON.parse(rest.subarray(bodyStart, bodyStart + length).toString('utf8')));
      rest = rest.subarray(bodyStart + length);
    }
  }

  _handle(proc, message) {
    if (message.method !== 'memory.move_project') return;
    this.moveRequests += 1;
    const dropPipe = () => setImmediate(() => proc.emit('exit', 1, null));
    if (this.mode === 'drop_before_commit') return dropPipe();
    if (this.mode === 'refuse') {
      return this._reply(proc, {
        jsonrpc: '2.0', id: message.id,
        error: { code: -32000, message: 'memory.move_project failed', data: { error_code: 'CMP-MEMORY-0001' } },
      });
    }
    const source = message.params.project_id;
    const target = message.params.target_project_id;
    const moved = this.count(source);
    this.rows.set(target, this.count(target) + moved);
    this.rows.delete(source);
    if (this.mode === 'commit_then_drop') return dropPipe();
    return this._reply(proc, { jsonrpc: '2.0', id: message.id, result: { moved, merged: 0, pending_moved: 0 } });
  }

  _reply(proc, message) {
    proc.stdout.push(encodeFrame(message).frame);
  }
}

function createProfile() {
  const profile = path.join(createTrackedTempDir('jenny-project-delete-recovery-'), 'profile');
  fs.mkdirSync(profile);
  return profile;
}

// One "app run" over a profile: fresh stores, a fresh journal, and a client
// attached to the given fake sidecar.
function startApp(profile, sidecar, { moveMemories = null } = {}) {
  const projectStore = new ProjectStore(path.join(profile, 'projects.json'));
  let created = 0;
  const projectService = new ProjectService({ store: projectStore, idFactory: () => `project_recovery_${++created}` });
  const sessionStore = new ElectronSessionStore(path.join(profile, 'sessions.json'), { writeDebounceMs: 0 });
  const workspacePool = new ProjectWorkspacePool({ projectService });
  const journal = new ProjectDeleteJournal(path.join(profile, JOURNAL_FILE));
  const client = new SidecarClient();
  client.on('error', () => {});
  const service = { sidecarClient: client, _emitServiceLog: () => {} };
  const reconnect = () => client.attachProcess(sidecar.spawn());
  reconnect();
  const application = new ProjectApplicationService({
    projectService,
    projectStore,
    projectAuthority: { captureProject: (id) => workspacePool.capture(id).authority },
    sessionStore,
    permissionStore: new ToolPermissionStore(path.join(profile, 'tool-permissions.json')),
    projectDeleteJournal: journal,
    moveProjectMemories: moveMemories
      || (({ from_project_id: from, to_project_id: to }) => moveProjectMemories(service, from, to)),
    isSessionBusy: () => false,
    resolveWorkspaceRoot: () => '',
  });
  return { application, projectService, sessionStore, journal, reconnect };
}

function seedProject(app, sidecar, { memories = 3 } = {}) {
  const project = app.application.createProject({ name: 'Ascend' }).project;
  const chat = app.sessionStore.createSession({ title: 'One' });
  assert.equal(app.application.assignSessionProject({ session_id: chat.id, project_id: project.id }).ok, true);
  sidecar.seed(project.id, memories);
  return { project, chat };
}

test('a move that committed before the pipe dropped leaves the project deleted and is settled after reconnect', async () => {
  const sidecar = new FakeSidecar();
  const app = startApp(createProfile(), sidecar);
  const { project, chat } = seedProject(app, sidecar);
  sidecar.mode = 'commit_then_drop';

  const result = await app.application.deleteProject({ project_id: project.id });

  assert.equal(sidecar.count(GENERAL_PROJECT_ID), 3, 'the sidecar committed the move');
  assert.equal(app.projectService.get(project.id), null, 'the project is not restored over memories that moved to General');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.memory_outcome, 'pending');
  assert.equal(result.moved_memories, 0);
  assert.equal(app.sessionStore.getSessionSummary(chat.id).project_id, GENERAL_PROJECT_ID);
  assert.deepEqual(app.journal.list().map((operation) => operation.project_id), [project.id]);

  sidecar.mode = 'answer';
  app.reconnect();
  const settled = await app.application.reconcilePendingProjectDeletes();
  assert.deepEqual(settled, { settled: 1, discarded: 0, pending: 0 });
  assert.deepEqual(app.journal.list(), []);
  assert.equal(sidecar.count(GENERAL_PROJECT_ID), 3, 'the re-issued move changed nothing');
  assert.equal(sidecar.moveRequests, 2, 'one lost request, one re-issue; nothing was sent into the dead pipe');
});

test('a move that never ran is finished on the next start', async () => {
  const sidecar = new FakeSidecar();
  const profile = createProfile();
  const app = startApp(profile, sidecar);
  const { project } = seedProject(app, sidecar);
  sidecar.mode = 'drop_before_commit';

  const result = await app.application.deleteProject({ project_id: project.id });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.memory_outcome, 'pending');
  assert.equal(sidecar.count(project.id), 3, 'nothing moved yet');
  assert.equal(sidecar.count(GENERAL_PROJECT_ID), 0, 'recall scope did not widen while the move is pending');

  // The reconnect did not come back: a re-issue with no answer keeps the record.
  const stillDown = await app.application.reconcilePendingProjectDeletes();
  assert.deepEqual(stillDown, { settled: 0, discarded: 0, pending: 1 });
  assert.equal(app.journal.list()[0].attempts, 1);

  sidecar.mode = 'answer';
  const nextRun = startApp(profile, sidecar);
  assert.equal(nextRun.journal.list().length, 1, 'the record survived the restart');
  assert.deepEqual(await nextRun.application.reconcilePendingProjectDeletes(), { settled: 1, discarded: 0, pending: 0 });
  assert.equal(sidecar.count(project.id), 0);
  assert.equal(sidecar.count(GENERAL_PROJECT_ID), 3);
  assert.deepEqual(nextRun.journal.list(), []);
  assert.equal(fs.existsSync(path.join(profile, JOURNAL_FILE)), true);
});

test('a sidecar that answers no rolls the delete back and leaves no record', async () => {
  const sidecar = new FakeSidecar();
  const app = startApp(createProfile(), sidecar);
  const { project, chat } = seedProject(app, sidecar);
  sidecar.mode = 'refuse';

  const result = await app.application.deleteProject({ project_id: project.id });
  assert.equal(result.ok, false);
  assert.equal(result.error.reason, 'project_memories_unavailable');
  assert.equal(result.error.memory_reason, 'CMP-MEMORY-0001');
  assert.equal(result.error.memory_outcome, undefined);
  assert.equal(result.error.project_restored, true);
  assert.ok(app.projectService.get(project.id));
  assert.equal(app.sessionStore.getSessionSummary(chat.id).project_id, project.id);
  assert.equal(sidecar.count(project.id), 3);
  assert.deepEqual(app.journal.list(), []);
});

test('a delete is refused before anything is removed when the record cannot be written', async () => {
  const sidecar = new FakeSidecar();
  const profile = createProfile();
  // A journal a newer build wrote: this build must not write over it.
  const newer = JSON.stringify({ schema_version: 99, operations: {} });
  fs.writeFileSync(path.join(profile, JOURNAL_FILE), newer);
  const app = startApp(profile, sidecar);
  const { project, chat } = seedProject(app, sidecar);

  const result = await app.application.deleteProject({ project_id: project.id });
  assert.equal(result.ok, false);
  assert.equal(result.error.reason, 'project_delete_record_unavailable');
  assert.equal(result.error.record_reason, 'future_schema');
  assert.equal(sidecar.moveRequests, 0);
  assert.ok(app.projectService.get(project.id));
  assert.equal(app.sessionStore.getSessionSummary(chat.id).project_id, project.id);
  assert.equal(fs.readFileSync(path.join(profile, JOURNAL_FILE), 'utf8'), newer, 'the file is not written over');
});

test('a memory mover without a journal refuses the delete', async () => {
  const sidecar = new FakeSidecar();
  const app = startApp(createProfile(), sidecar);
  const { project } = seedProject(app, sidecar);
  const bare = new ProjectApplicationService({
    projectService: app.projectService,
    projectStore: app.projectService._store,
    projectAuthority: { captureProject: () => ({}) },
    sessionStore: app.sessionStore,
    permissionStore: new ToolPermissionStore(path.join(createProfile(), 'tool-permissions.json')),
    moveProjectMemories: async () => ({ ok: true, moved: 0 }),
    isSessionBusy: () => false,
  });
  const result = await bare.deleteProject({ project_id: project.id });
  assert.equal(result.ok, false);
  assert.equal(result.error.reason, 'project_delete_record_unavailable');
  assert.ok(app.projectService.get(project.id));
});

test('a damaged project store never reads as "the project is gone"', async () => {
  const sidecar = new FakeSidecar();
  const profile = createProfile();
  const app = startApp(profile, sidecar);
  const { project } = seedProject(app, sidecar);
  sidecar.mode = 'drop_before_commit';
  assert.equal((await app.application.deleteProject({ project_id: project.id })).ok, true);

  fs.writeFileSync(path.join(profile, 'projects.json'), '{ not json');
  sidecar.mode = 'answer';
  const nextRun = startApp(profile, sidecar);
  const before = sidecar.moveRequests;
  assert.deepEqual(await nextRun.application.reconcilePendingProjectDeletes(), { settled: 0, discarded: 0, pending: 1 });
  assert.equal(sidecar.moveRequests, before, 'no move is issued against a fallback project list');
  assert.equal(nextRun.journal.list().length, 1);
});

test('a record for a project that still exists is dropped without moving its memories', async () => {
  const sidecar = new FakeSidecar();
  const app = startApp(createProfile(), sidecar);
  const { project } = seedProject(app, sidecar);
  // A crash between writing the record and removing the project entry.
  assert.equal(app.journal.record(project.id).ok, true);

  assert.deepEqual(await app.application.reconcilePendingProjectDeletes(), { settled: 0, discarded: 1, pending: 0 });
  assert.equal(sidecar.moveRequests, 0);
  assert.equal(sidecar.count(project.id), 3);
  assert.deepEqual(app.journal.list(), []);
});

test('a reconcile during a delete never issues a second move for the delete still in flight', async () => {
  const sidecar = new FakeSidecar();
  let app = null;
  let calls = 0;
  let duringDelete = null;
  app = startApp(createProfile(), sidecar, {
    moveMemories: async () => {
      calls += 1;
      if (calls === 1) duringDelete = await app.application.reconcilePendingProjectDeletes();
      return { ok: false, reason: 'memory_unavailable' };
    },
  });
  const { project } = seedProject(app, sidecar);

  const result = await app.application.deleteProject({ project_id: project.id });
  assert.equal(result.ok, false);
  assert.deepEqual(duringDelete, { settled: 0, discarded: 0, pending: 1 });
  assert.equal(calls, 2, 'only the delete itself asked the sidecar');
  assert.ok(app.projectService.get(project.id), 'the refused delete rolled back');
  assert.deepEqual(app.journal.list(), []);
});

test('with nothing recorded, reconcile asks nothing and writes no file', async () => {
  const sidecar = new FakeSidecar();
  const profile = createProfile();
  const app = startApp(profile, sidecar);
  assert.deepEqual(await app.application.reconcilePendingProjectDeletes(), { settled: 0, discarded: 0, pending: 0 });
  assert.equal(sidecar.moveRequests, 0);
  assert.equal(fs.existsSync(path.join(profile, JOURNAL_FILE)), false);
});

// ---- The trigger: every successful sidecar initialize runs one reconcile ----

function initializeFixture({ reconcile, supersede = false } = {}) {
  const sidecarProcess = {};
  const logs = [];
  const service = {
    currentEngineType: 'mock',
    currentModel: 'mock',
    options: { userDataPath: createProfile() },
    configService: { getState: () => ({}), getToolsWorkspaceRoot: () => '' },
    sidecarManager: { process: sidecarProcess },
    sidecarClient: {
      process: sidecarProcess,
      connected: true,
      initialize: async () => {
        if (supersede) service.sidecarManager.process = {};
        return {};
      },
    },
    _emitServiceLog: (level, event, details) => logs.push([level, event, details]),
  };
  if (reconcile) service.projectApplicationService = { reconcilePendingProjectDeletes: reconcile };
  return { service, logs };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a successful sidecar initialize reconciles recorded deletes and logs what it did', async () => {
  let calls = 0;
  const { service, logs } = initializeFixture({
    reconcile: async () => { calls += 1; return { settled: 1, discarded: 0, pending: 0 }; },
  });
  await initializeManagedSidecar(service, { applyResult: false });
  await settle();
  assert.equal(calls, 1);
  assert.deepEqual(
    logs.filter(([, event]) => event === 'projects.delete_memory_move_recovery'),
    [['INFO', 'projects.delete_memory_move_recovery', { settled: 1, discarded: 0, pending: 0 }]],
  );
});

test('initialize does not wait for the reconcile, survives its failure, and skips it for a replaced process', async () => {
  const failing = initializeFixture({ reconcile: async () => { throw new Error('boom'); } });
  await initializeManagedSidecar(failing.service, { applyResult: false });
  await settle();
  assert.deepEqual(failing.logs.map(([level, event]) => [level, event]), [
    ['ERROR', 'projects.delete_memory_move_recovery_failed'],
  ]);

  let calls = 0;
  const superseded = initializeFixture({ supersede: true, reconcile: async () => { calls += 1; return {}; } });
  await initializeManagedSidecar(superseded.service, { applyResult: false });
  await settle();
  assert.equal(calls, 0, 'the process this initialize spoke to is gone');

  const bare = initializeFixture();
  await initializeManagedSidecar(bare.service, { applyResult: false });
  await settle();
  assert.deepEqual(bare.logs, [], 'a host without the project application service has nothing to reconcile');
});

test('a second delete of a project whose delete is still in flight is refused, not run twice', async () => {
  const sidecar = new FakeSidecar();
  let app = null;
  let second = null;
  let calls = 0;
  app = startApp(createProfile(), sidecar, {
    moveMemories: async ({ from_project_id: projectId }) => {
      calls += 1;
      second = await app.application.deleteProject({ project_id: projectId });
      return { ok: true, moved: 2 };
    },
  });
  const { project } = seedProject(app, sidecar);
  const first = await app.application.deleteProject({ project_id: project.id });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(second.ok, false);
  assert.equal(second.error.reason, 'project_delete_in_progress');
  assert.equal(calls, 1);
  assert.deepEqual(app.journal.list(), []);
});
