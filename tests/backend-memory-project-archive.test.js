'use strict';

// Project delete archives the project's memories through the sidecar's
// memory.archive_project (memory v2, row 58 W1; it replaced the D10 move to
// General). Desktop only: the hosted project commands never learn chooseRoot
// or delete.

const assert = require('node:assert/strict');
const test = require('node:test');

const { archiveProjectMemories } = require('../services/backend/backend-memory');
const { createProjectCommands } = require('../services/host/project-commands');

function serviceWith(result) {
  const calls = [];
  const logs = [];
  return {
    calls,
    logs,
    _emitServiceLog: (level, event, details) => logs.push([level, event, details]),
    sidecarClient: {
      request: async (method, params) => {
        calls.push([method, params]);
        if (result instanceof Error) throw result;
        return result;
      },
    },
  };
}

test('archiveProjectMemories asks the sidecar to archive one project and returns the counts', async () => {
  const service = serviceWith({ ok: true, archived: 3, pending_removed: 2 });
  const result = await archiveProjectMemories(service, 'project_alpha');
  assert.deepEqual(result, { ok: true, archived: 3, pending_removed: 2 });
  // The second call pushes the moved epoch to the sidecar's apply fence (row 58 W2).
  assert.deepEqual(service.calls.map(([method]) => method), ['memory.archive_project', 'memory.policy_epoch']);
  const [method, params] = service.calls[0];
  assert.equal(method, 'memory.archive_project');
  assert.deepEqual(Object.keys(params).sort(), ['accept_version', 'project_id']);
  assert.equal(params.project_id, 'project_alpha');
  assert.equal(typeof params.accept_version, 'string');
  assert.equal(service._memoryPolicyEpoch, 1, 'an archive moves the memory policy epoch');
  assert.deepEqual(service.logs.find(([, event]) => event === 'memory.project_archived'),
    ['INFO', 'memory.project_archived', { archived: 3, pendingRemoved: 2 }]);
});

test('archiveProjectMemories refuses General and bad ids, reports a missing sidecar, and lets a sidecar failure throw', async () => {
  await assert.rejects(archiveProjectMemories(serviceWith({}), 'project_general'), /projectId is invalid/u);
  await assert.rejects(archiveProjectMemories(serviceWith({}), 'nope'), /projectId is invalid/u);
  assert.deepEqual(
    await archiveProjectMemories({ sidecarClient: null }, 'project_alpha'),
    { ok: false, reason: 'sidecar_unavailable' },
  );
  await assert.rejects(archiveProjectMemories(serviceWith(new Error('memory store unavailable')), 'project_alpha'));
});

// The delete operation rolls back on a definite answer and keeps the delete on
// no answer (DPR-008), so the two must never be confused here.
test('archiveProjectMemories returns a refusal for an answered error or a disconnected client, and throws when no answer came', async () => {
  const answered = Object.assign(new Error('memory.archive_project failed'), {
    rpc: { code: -32000, message: 'memory.archive_project failed' }, error_code: 'CMP-MEM-0001',
  });
  assert.deepEqual(
    await archiveProjectMemories(serviceWith(answered), 'project_alpha'),
    { ok: false, reason: 'CMP-MEM-0001' },
  );
  const disconnected = serviceWith({ ok: true, archived: 1 });
  disconnected.sidecarClient.connected = false;
  assert.deepEqual(
    await archiveProjectMemories(disconnected, 'project_alpha'),
    { ok: false, reason: 'sidecar_unavailable' },
  );
  assert.equal(disconnected.calls.length, 0, 'nothing is sent into a dead pipe');
  const timedOut = Object.assign(new Error('Sidecar memory.archive_project timed out after 10000ms'), { category: 'timeout' });
  await assert.rejects(archiveProjectMemories(serviceWith(timedOut), 'project_alpha'), /timed out/u);
});

test('an archive with malformed counts reports zeros', async () => {
  const result = await archiveProjectMemories(serviceWith({ ok: true, archived: -4, pending_removed: 'x' }), 'project_alpha');
  assert.deepEqual(result, { ok: true, archived: 0, pending_removed: 0 });
});

test('hosted project commands do not expose chooseRoot', () => {
  const commands = createProjectCommands({ applicationService: { chooseProjectRoot: () => ({ ok: true }) } });
  const result = commands.execute('projects.chooseRoot', { project_id: 'project_alpha', expected_root_revision: 0 });
  assert.equal(result.ok, false);
  assert.match(JSON.stringify(result), /unsupported_operation/u);
});
