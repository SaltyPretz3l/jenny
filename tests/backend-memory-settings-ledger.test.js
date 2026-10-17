'use strict';

// Settings memory edits go through the ledger (memory v2, row 58 W1b): update and
// delete carry the row's revision, the Settings Undo inverts the recorded delete in
// the row's own project, and pending acceptance resolves in the session's project.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  acceptPendingMemory,
  deleteApprovedMemory,
  undoApprovedMemoryChange,
  updateApprovedMemory,
} = require('../services/backend/backend-memory');

function serviceWith(answers, { projectId = 'project_alpha' } = {}) {
  const calls = [];
  const logs = [];
  return {
    calls,
    logs,
    _emitServiceLog: (...args) => logs.push(args),
    projectAuthority: {
      captureSession: (sessionId) => {
        if (sessionId !== 'session-1') throw new Error('unknown session');
        return { project_id: projectId };
      },
    },
    sidecarClient: {
      request: async (method, params) => {
        calls.push([method, params]);
        return answers.shift();
      },
    },
  };
}

const PATCH = { title: 'Tea', lesson_text: 'The user prefers tea.' };

test('updateApprovedMemory sends expected_revision only for a positive integer', async () => {
  const service = serviceWith([{ status: 'saved' }, { status: 'saved' }, { status: 'saved' }]);
  await updateApprovedMemory(service, 7, PATCH, 'project_garden', { expectedRevision: 3 });
  await updateApprovedMemory(service, 7, PATCH, 'project_garden');
  await updateApprovedMemory(service, 7, PATCH, 'project_garden', { expectedRevision: null });
  assert.equal(service.calls[0][1].expected_revision, 3);
  assert.equal(Object.hasOwn(service.calls[1][1], 'expected_revision'), false);
  assert.equal(Object.hasOwn(service.calls[2][1], 'expected_revision'), false);
  await assert.rejects(
    updateApprovedMemory(service, 7, PATCH, 'project_garden', { expectedRevision: 'x' }),
    /expectedRevision is invalid/u,
  );
  await assert.rejects(
    updateApprovedMemory(service, 7, PATCH, 'project_garden', { expectedRevision: 1.5 }),
    /expectedRevision is invalid/u,
  );
  assert.equal(service.calls.length, 3);
});

test('updateApprovedMemory reports a stale revision as a conflict with the current row', async () => {
  const current = { id: 7, revision: 4, title: 'Tea', lesson_text: 'Newer text.' };
  const service = serviceWith([
    { status: 'conflict', reason: 'stale_revision', code: 'CMP-MEM-0012', memory: current },
  ]);
  const result = await updateApprovedMemory(service, 7, PATCH, 'project_garden', { expectedRevision: 3 });
  assert.equal(result.updated, false);
  assert.equal(result.status, 'conflict');
  assert.equal(result.reason, 'stale_revision');
  assert.deepEqual(result.memory, current);
});

test('deleteApprovedMemory passes expected_revision and returns the operation id and undoability', async () => {
  const archived = { id: 9, revision: 3, status: 'archived' };
  const service = serviceWith([
    { status: 'saved', deleted: true, memory_id: 9, memory: archived, operation_id: 'rpc:del1', duplicate: false, undoable: true },
    { status: 'conflict', deleted: false, reason: 'stale_revision', code: 'CMP-MEM-0012', memory: { id: 9, revision: 5 } },
  ]);
  const deleted = await deleteApprovedMemory(service, 9, 'project_garden', { expectedRevision: 2 });
  assert.equal(service.calls[0][0], 'memory.delete');
  assert.equal(service.calls[0][1].project_id, 'project_garden');
  assert.equal(service.calls[0][1].expected_revision, 2);
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.memory_id, 9);
  assert.equal(deleted.operation_id, 'rpc:del1');
  assert.equal(deleted.undoable, true);
  assert.deepEqual(deleted.memory, archived);

  const conflict = await deleteApprovedMemory(service, 9, 'project_garden', { expectedRevision: 2 });
  assert.equal(conflict.deleted, false);
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.memory.revision, 5);

  await deleteApprovedMemory(serviceWith([{ deleted: true }]), 9, 'project_garden');
  await assert.rejects(
    deleteApprovedMemory(service, 9, 'project_garden', { expectedRevision: 0.5 }),
    /expectedRevision is invalid/u,
  );
});

test('undoApprovedMemoryChange names the row project and a fresh ui: undo id, once', async () => {
  const service = serviceWith([
    { status: 'refused', reason: 'not_found' },
    { status: 'saved', operation_id: 'ui:y', undoable: false, memory: { id: 9, lesson_text: 'secret' } },
  ]);
  const refused = await undoApprovedMemoryChange(service, 'rpc:abc', 'project_x');
  assert.deepEqual(refused, { status: 'refused', reason: 'not_found' });
  assert.equal(service.calls.length, 1, 'no General retry: Settings knows the row project');
  const [method, params] = service.calls[0];
  assert.equal(method, 'memory.undo');
  assert.equal(params.project_id, 'project_x');
  assert.equal(params.operation_id, 'rpc:abc');
  assert.match(params.undo_operation_id, /^ui:[0-9a-f-]{36}$/u);

  assert.deepEqual(
    await undoApprovedMemoryChange(service, 'rpc:abc', 'project_x'),
    { status: 'saved', operation_id: 'ui:y', undoable: false },
  );
});

test('undoApprovedMemoryChange validates its ids and reports a missing sidecar', async () => {
  const service = serviceWith([]);
  await assert.rejects(undoApprovedMemoryChange(service, 'bad id with spaces', 'project_x'), /operationId is invalid/u);
  await assert.rejects(undoApprovedMemoryChange(service, 'rpc:abc', 'not-a-project'), /projectId is invalid/u);
  assert.equal(service.calls.length, 0);
  service.sidecarClient = null;
  assert.deepEqual(
    await undoApprovedMemoryChange(service, 'rpc:abc', 'project_x'),
    { status: 'refused', reason: 'sidecar_unavailable' },
  );
});

test('acceptPendingMemory resolves the project from the session authority and returns the write summary', async () => {
  const saved = { id: 12, project_id: 'project_general', lesson_text: 'Global note.' };
  const service = serviceWith([
    { accepted: true, status: 'saved', memory: saved, operation_id: 'rpc:acc1', duplicate: false, replayed: false, undoable: true },
    { accepted: false, status: 'refused', reason: 'suppressed', code: 'CMP-MEM-0008', memory: null },
  ]);
  const accepted = await acceptPendingMemory(service, 'session-1', ' SHA256:ABC ');
  const [method, params] = service.calls[0];
  assert.equal(method, 'memory.pending.accept');
  assert.equal(params.project_id, 'project_alpha');
  assert.equal(params.session_id, 'session-1');
  assert.equal(params.content_fingerprint, 'sha256:abc');
  assert.deepEqual(accepted, {
    accepted: true,
    memory: saved,
    status: 'saved',
    operation_id: 'rpc:acc1',
    duplicate: false,
    undoable: true,
  });

  assert.deepEqual(
    await acceptPendingMemory(service, 'session-1', 'sha256:abc'),
    { accepted: false, memory: null, status: 'refused', reason: 'suppressed' },
  );
});

test('acceptPendingMemory validates its arguments and skips without a sidecar', async () => {
  const service = serviceWith([]);
  await assert.rejects(acceptPendingMemory(service, '', 'sha256:abc'), /sessionId is required/u);
  await assert.rejects(acceptPendingMemory(service, 'session-1', ' '), /contentFingerprint is required/u);
  await assert.rejects(acceptPendingMemory(service, 'session-2', 'sha256:abc'), /unknown session/u);
  service.sidecarClient = null;
  assert.deepEqual(await acceptPendingMemory(service, 'session-1', 'sha256:abc'), { accepted: false });
  assert.equal(service.logs.at(-1)[1], 'memory.pending_accept_skipped');
});
