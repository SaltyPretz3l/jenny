'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCommand, hostFailure } = require('../../server/api-contract');

function send(params = { prompt: 'hello' }) {
  return { api_version: 1, operation: 'chat.send', request_id: 'request-1',
    client_id: 'client-1', boot_epoch: 'epoch-1', session_id: 'sess_1', params };
}

test('browser command validation refuses arbitrary IPC and privilege-bearing fields', () => {
  assert.equal(validateCommand(send()).ok, true);
  for (const params of [
    { prompt: 'hello', approvalMode: 'auto' },
    { prompt: 'hello', tool_preferences: { shell: true } },
    { prompt: 'hello', attachments: [{ path: '/run/secrets/key' }] },
  ]) assert.equal(validateCommand(send(params)).ok, false);
  assert.equal(validateCommand({ ...send(), operation: 'system.exec' }).ok, false);
  assert.equal(validateCommand({ ...send(), session_id: '../secrets' }).ok, false);
  assert.equal(validateCommand({ ...send(), api_version: 2 }).ok, false);
  assert.equal(validateCommand({ ...send(), control_generation: '1' }).ok, false);
});

test('session-bound commands cannot omit session identity', () => {
  const command = send();
  delete command.session_id;
  assert.equal(validateCommand(command).reason, 'session_required');
  assert.equal(validateCommand({ ...command, operation: 'sessions.create', params: {} }).ok, true);
});

test('project and permission review schemas are closed and scope assignment to a session', () => {
  const base = send({});
  delete base.session_id;
  assert.equal(validateCommand({ ...base, operation: 'projects.list' }).ok, true);
  assert.equal(validateCommand({
    ...base,
    operation: 'projects.bindRoot',
    params: {
      project_id: 'project_alpha', root_path: '/workspace/alpha', expected_root_revision: 2,
    },
  }).ok, true);
  assert.equal(validateCommand({
    ...base,
    operation: 'projects.bindRoot',
    params: {
      project_id: 'project_alpha', root_path: 'C:\\workspace', expected_root_revision: 2,
    },
  }).ok, false);
  assert.equal(validateCommand({
    ...base,
    operation: 'projects.create',
    params: { name: 'Alpha', root_path: '/forged' },
  }).ok, false);
  assert.equal(validateCommand({ ...base, operation: 'projects.assignSession', params: {
    project_id: 'project_alpha',
  } }).reason, 'session_required');
  assert.equal(validateCommand({
    ...base,
    operation: 'permissionReview.resolve',
    params: {
      review_id: 'review_1', decision: 'auto', project_id: 'project_alpha',
      expected_root_revision: 2, expected_authority_key: `authority_${'a'.repeat(64)}`,
    },
  }).ok, true);
  assert.equal(validateCommand({
    ...base,
    operation: 'permissionReview.resolve',
    params: { review_id: 'review_1', decision: 'auto', project_id: 'project_alpha' },
  }).ok, false);
});

test('host failures never expose exception text as a reason', () => {
  assert.deepEqual(hostFailure('persistence', 'Failed at /data/private'), {
    ok: false, error: { code: 'CMP-HOST-0006', reason: 'host_unavailable', retryable: false },
  });
});
