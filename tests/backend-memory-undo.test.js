'use strict';

// The chat chip's Undo (memory v2, row 58 W1): the renderer names only the
// session and the operation; the project sent with memory.undo comes from the
// session authority, with one retry in General for a global-scope write.

const assert = require('node:assert/strict');
const test = require('node:test');

const { undoMemoryOperation } = require('../services/backend/backend-memory');

function serviceWith(projectId, answers) {
  const calls = [];
  return {
    calls,
    _emitServiceLog: () => {},
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

test('undoMemoryOperation sends the session project, the operation and a fresh ui: undo id', async () => {
  const service = serviceWith('project_alpha', [{ status: 'saved', operation_id: 'ui:x', undoable: false, memory: { id: 4, lesson_text: 'secret' } }]);
  const result = await undoMemoryOperation(service, 'session-1', 'tool:abc');
  assert.deepEqual(result, { status: 'saved', operation_id: 'ui:x', undoable: false });
  assert.equal(service.calls.length, 1);
  const [method, params] = service.calls[0];
  assert.equal(method, 'memory.undo');
  assert.equal(params.project_id, 'project_alpha');
  assert.equal(params.operation_id, 'tool:abc');
  assert.match(params.undo_operation_id, /^ui:[0-9a-f-]{36}$/u);
});

test('undoMemoryOperation retries once in General when the project does not own the operation', async () => {
  const service = serviceWith('project_alpha', [
    { status: 'refused', reason: 'not_found' },
    { status: 'saved' },
  ]);
  assert.deepEqual(await undoMemoryOperation(service, 'session-1', 'tool:abc'), { status: 'saved' });
  assert.deepEqual(service.calls.map(([, params]) => params.project_id), ['project_alpha', 'project_general']);
  assert.equal(service.calls[0][1].undo_operation_id, service.calls[1][1].undo_operation_id);
});

test('undoMemoryOperation does not retry for General, a conflict or another refusal', async () => {
  const general = serviceWith('project_general', [{ status: 'refused', reason: 'not_found' }]);
  assert.deepEqual(await undoMemoryOperation(general, 'session-1', 'tool:abc'), { status: 'refused', reason: 'not_found' });
  assert.equal(general.calls.length, 1);
  const conflict = serviceWith('project_alpha', [{ status: 'conflict', reason: 'stale_revision' }]);
  assert.deepEqual(await undoMemoryOperation(conflict, 'session-1', 'tool:abc'), { status: 'conflict', reason: 'stale_revision' });
  assert.equal(conflict.calls.length, 1);
});

test('undoMemoryOperation validates its ids and reports a missing sidecar', async () => {
  const service = serviceWith('project_alpha', []);
  await assert.rejects(undoMemoryOperation(service, '', 'tool:abc'), /sessionId is required/u);
  await assert.rejects(undoMemoryOperation(service, 'session-1', 'bad id with spaces'), /operationId is invalid/u);
  await assert.rejects(undoMemoryOperation(service, 'session-2', 'tool:abc'), /unknown session/u);
  service.sidecarClient = null;
  assert.deepEqual(await undoMemoryOperation(service, 'session-1', 'tool:abc'), { status: 'refused', reason: 'sidecar_unavailable' });
});
