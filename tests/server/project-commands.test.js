'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createProjectCommands } = require('../../services/host/project-commands');

function fixture() {
  const calls = [];
  const project = {
    id: 'project_alpha', name: 'Alpha', root_path: '/workspace/alpha', root_revision: 3,
    authority_key: `authority_${'a'.repeat(64)}`, internal: 'hidden',
  };
  const applicationService = {
    listProjects: () => ({ ok: true, projects: [project], storage: { read_only: false } }),
    createProject: (params) => { calls.push(['create', params]); return { ok: true, project }; },
    renameProject: (params) => { calls.push(['rename', params]); return { ok: true, project }; },
    bindProjectRoot: (params) => { calls.push(['bind', params]); return { ok: true, project }; },
    assignSessionProject: (params) => {
      calls.push(['assign', params]);
      return { ok: true, session: { id: params.session_id, project_id: params.project_id } };
    },
    getPermissionReviewState: () => ({
      pending_count: 1, pending: [{ id: 'review_1' }], history: [], read_only: false,
    }),
    resolvePermissionReview: (params) => {
      calls.push(['resolve', params]);
      return { ok: true, review: { id: params.review_id }, review_state: { pending_count: 0 } };
    },
  };
  return { calls, commands: createProjectCommands({ applicationService }), project };
}

test('host project adapter exposes only closed application projections for all operations', () => {
  const { calls, commands, project } = fixture();
  assert.deepEqual(commands.execute('projects.list', {}, { requestId: 'request_1' }), {
    ok: true,
    projects: [{
      id: project.id, name: project.name, root_path: project.root_path,
      root_revision: 3, authority_key: project.authority_key,
    }],
    storage: { read_only: false, reason: null },
  });
  assert.equal(commands.execute('projects.create', { name: 'Alpha' }).ok, true);
  assert.equal(commands.execute('projects.rename', { project_id: project.id, name: 'Beta' }).ok, true);
  assert.equal(commands.execute('projects.bindRoot', {
    project_id: project.id, root_path: project.root_path, expected_root_revision: 2,
  }).ok, true);
  assert.equal(commands.execute('projects.assignSession', { project_id: project.id }, {
    sessionId: 'session_1',
  }).session.project_id, project.id);
  assert.equal(commands.execute('permissionReview.getState', {}).pending_count, 1);
  const resolved = commands.execute('permissionReview.resolve', {
    review_id: 'review_1', decision: 'dismiss',
  });
  assert.deepEqual(resolved, {
    ok: true, resolved: true, review_id: 'review_1', decision: 'dismiss',
  });
  assert.ok(JSON.stringify(resolved).length < 4096);
  assert.deepEqual(calls.map(([name]) => name), ['create', 'rename', 'bind', 'assign', 'resolve']);
  assert.deepEqual(calls[3][1], { session_id: 'session_1', project_id: project.id });
  assert.equal(Object.hasOwn(commands.execute('projects.list').projects[0], 'internal'), false);
});

test('permission review mutation acknowledgements stay bounded when review history is large', () => {
  const commands = createProjectCommands({
    applicationService: {
      resolvePermissionReview: (params) => ({
        ok: true,
        review: { pending_id: params.review_id, original_record: 'x'.repeat(5000) },
        review_state: { history: Array.from({ length: 40 }, () => 'x'.repeat(200)) },
      }),
    },
  });
  const result = commands.execute('permissionReview.resolve', {
    review_id: 'review_large', decision: 'dismiss',
  });
  assert.deepEqual(result, {
    ok: true, resolved: true, review_id: 'review_large', decision: 'dismiss',
  });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 4096);
});

test('host project adapter maps application failures and rejects malformed projections', () => {
  const failed = createProjectCommands({
    applicationService: {
      createProject: () => ({
        ok: false, error: { code: 'CMP-PROJECT-0004', reason: 'stale_root_revision' },
      }),
    },
  }).execute('projects.create', { name: 'Alpha' }, { requestId: 'request_2' });
  assert.equal(failed.error.code, 'CMP-HOST-0004');
  assert.equal(failed.error.reason, 'stale_root_revision');
  assert.equal(failed.error.request_id, 'request_2');

  const malformed = createProjectCommands({
    applicationService: {
      listProjects: () => ({
        ok: true,
        projects: [{
          id: 'project_alpha', name: 'Alpha', root_path: '/workspace', root_revision: -1,
          authority_key: '',
        }],
        storage: {},
      }),
    },
  }).execute('projects.list');
  assert.deepEqual(malformed.projects, []);
});
