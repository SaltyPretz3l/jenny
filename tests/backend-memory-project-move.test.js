'use strict';

// Project delete moves memories to General through the sidecar's
// memory.move_project (PO review 2026-09-27, D10). Desktop only: the hosted
// project commands never learn chooseRoot or delete.

const assert = require('node:assert/strict');
const test = require('node:test');

const { moveProjectMemories } = require('../services/backend/backend-memory');
const { createProjectCommands } = require('../services/host/project-commands');
const { resolveRequestTimeoutMs } = require('../services/backend/sidecar-request-timeouts');

function serviceWith(result) {
  const calls = [];
  return {
    calls,
    _emitServiceLog: () => {},
    sidecarClient: {
      request: async (method, params) => {
        calls.push([method, params]);
        if (result instanceof Error) throw result;
        return result;
      },
    },
  };
}

test('moveProjectMemories asks the sidecar to move one project into General and counts merged rows as moved', async () => {
  const service = serviceWith({ moved: 2, merged: 1, pending_moved: 4 });
  const result = await moveProjectMemories(service, 'project_alpha', 'project_general');
  assert.deepEqual(result, { ok: true, moved: 3 });
  assert.equal(service.calls.length, 1);
  const [method, params] = service.calls[0];
  assert.equal(method, 'memory.move_project');
  assert.equal(params.project_id, 'project_alpha');
  assert.equal(params.target_project_id, 'project_general');
  assert.equal(typeof params.accept_version, 'string');
});

test('moveProjectMemories refuses bad scopes, reports a missing sidecar, and lets a sidecar failure throw', async () => {
  await assert.rejects(moveProjectMemories(serviceWith({}), 'project_general', 'project_alpha'));
  await assert.rejects(moveProjectMemories(serviceWith({}), 'project_alpha', 'project_alpha'));
  await assert.rejects(moveProjectMemories(serviceWith({}), 'nope', 'project_general'));
  assert.deepEqual(
    await moveProjectMemories({ sidecarClient: null }, 'project_alpha', 'project_general'),
    { ok: false, reason: 'sidecar_unavailable' },
  );
  await assert.rejects(
    moveProjectMemories(serviceWith(new Error('memory store unavailable')), 'project_alpha', 'project_general'),
  );
});

// The delete operation rolls back on a definite answer and keeps the delete on
// no answer (DPR-008), so the two must never be confused here.
test('moveProjectMemories returns a refusal for an answered error or a disconnected client, and throws when no answer came', async () => {
  const answered = Object.assign(new Error('memory.move_project failed'), {
    rpc: { code: -32000, message: 'memory.move_project failed' }, error_code: 'CMP-MEMORY-0001',
  });
  assert.deepEqual(
    await moveProjectMemories(serviceWith(answered), 'project_alpha', 'project_general'),
    { ok: false, reason: 'CMP-MEMORY-0001' },
  );
  const disconnected = serviceWith({ moved: 1 });
  disconnected.sidecarClient.connected = false;
  assert.deepEqual(
    await moveProjectMemories(disconnected, 'project_alpha', 'project_general'),
    { ok: false, reason: 'sidecar_unavailable' },
  );
  assert.equal(disconnected.calls.length, 0, 'nothing is sent into a dead pipe');
  const timedOut = Object.assign(new Error('Sidecar memory.move_project timed out after 10000ms'), { category: 'timeout' });
  await assert.rejects(moveProjectMemories(serviceWith(timedOut), 'project_alpha', 'project_general'), /timed out/u);
});

test('memory.move_project has a bounded request timeout', () => {
  assert.equal(resolveRequestTimeoutMs('memory.move_project'), 10_000);
});

test('hosted project commands do not expose chooseRoot', () => {
  const commands = createProjectCommands({ applicationService: { chooseProjectRoot: () => ({ ok: true }) } });
  const result = commands.execute('projects.chooseRoot', { project_id: 'project_alpha', expected_root_revision: 0 });
  assert.equal(result.ok, false);
  assert.match(JSON.stringify(result), /unsupported_operation/u);
});
