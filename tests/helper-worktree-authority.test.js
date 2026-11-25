'use strict';

// Row 184 W3: Electron issues and settles the worktree a writing helper works in.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  HELPER_WORKTREE_KIND,
  HelperWorktreeAuthority,
  MAX_KEPT_HELPER_WORKTREES,
  MAX_LIVE_HELPER_WORKTREES,
} = require('../services/backend/helper-worktree-authority');

function makeState(overrides = {}) {
  return {
    authority: { root_path: 'C:\\proj' },
    requestId: 'req-1',
    sessionId: 'sess-1',
    authorityRevision: 'rev-1',
    mode: 'assist',
    proposeMode: false,
    readOnly: false,
    autoRun: true,
    closed: false,
    trustedContext: { handoffPreparation: null },
    ...overrides,
  };
}

function makeService() {
  const calls = { create: [], delete: [] };
  let next = 0;
  return {
    calls,
    async createWorktree(request) {
      calls.create.push(request);
      next += 1;
      return { success: true, worktree: {
        id: `wt_${next}`, branch: request.branch, base_ref: 'HEAD',
        worktree_path: `C:\\wt\\${request.name}`,
      } };
    },
    async deleteWorktree(request) {
      calls.delete.push(request);
      return request.worktreeId === 'wt_dirty'
        ? { success: false, reason: 'dirty_worktree' } : { success: true };
    },
  };
}

const fakeFs = {
  realpathSync: { native: (value) => value },
  statSync: () => ({ isDirectory: () => true, dev: 7n, ino: 42n }),
};

function makeAuthority(service = makeService()) {
  return {
    service,
    authority: new HelperWorktreeAuthority({
      resolveWorktreeService: () => service, fsImpl: fakeFs, randomBytes: () => Buffer.from('abcd'),
    }),
  };
}

function params(state, extra) {
  return {
    schema_version: 1, api_version: '2026-10-15', kind: HELPER_WORKTREE_KIND,
    request_id: state.requestId, session_id: state.sessionId, authority_revision: state.authorityRevision,
    operation_id: 'op-1', ...extra,
  };
}

test('create issues a worktree of the request root and returns its root identity', async () => {
  const { service, authority } = makeAuthority();
  const state = makeState();
  const result = await authority.handle(state, params(state, { action: 'create', name: 'fix-tests' }));
  assert.equal(result.status, 'granted');
  assert.equal(result.helper_worktree.id, 'wt_1');
  assert.equal(result.helper_worktree.root_path, 'C:\\wt\\fix-tests-61626364');
  assert.match(result.helper_worktree.root_id, /^root_[0-9a-f]{24}$/);
  assert.equal(result.helper_worktree.device_id, '7');
  assert.equal(result.helper_worktree.inode, '42');
  assert.equal(service.calls.create[0].workspaceRoot, 'C:\\proj');
  assert.equal(service.calls.create[0].branch, 'jenny-helper/fix-tests-61626364');
  assert.deepEqual(service.calls.create[0].owner, { session_id: 'sess-1', task_id: 'op-1' });
});

for (const [label, overrides] of [
  ['no project root', { authority: { root_path: null } }],
  ['Ask mode', { autoRun: false }],
  ['a read-only request', { readOnly: true }],
  ['Plan mode', { mode: 'plan' }],
  ['Propose mode', { proposeMode: true }],
  ['a handoff preparation turn', { trustedContext: { handoffPreparation: { proposalId: 'p' } } }],
]) {
  test(`create is refused for ${label}`, async () => {
    const { service, authority } = makeAuthority();
    const state = makeState(overrides);
    const result = await authority.handle(state, params(state, { action: 'create' }));
    assert.equal(result.status, 'rejected');
    assert.equal(result.error.reason, 'helper_worktree_refused');
    assert.equal(service.calls.create.length, 0);
  });
}

test('a request that does not match the binding is refused', async () => {
  const { authority } = makeAuthority();
  const state = makeState();
  const result = await authority.handle(state, { ...params(state, { action: 'create' }), request_id: 'req-other' });
  assert.equal(result.error.reason, 'authority_mismatch');
});

test('unknown keys and malformed actions are refused as invalid schema', async () => {
  const { authority } = makeAuthority();
  const state = makeState();
  for (const extra of [
    { action: 'create', root_path: 'C:\\elsewhere' },
    { action: 'delete' },
    { action: 'create', name: '../escape' },
    { action: 'settle', helper_worktree_id: 'wt_1' },
  ]) {
    const result = await authority.handle(state, params(state, extra));
    assert.equal(result.error.reason, 'invalid_schema', JSON.stringify(extra));
  }
});

test(`at most ${MAX_LIVE_HELPER_WORKTREES} helper worktrees are live per binding`, async () => {
  const { authority } = makeAuthority();
  const state = makeState();
  for (let index = 0; index < MAX_LIVE_HELPER_WORKTREES; index += 1) {
    assert.equal((await authority.handle(state, params(state, { action: 'create' }))).status, 'granted');
  }
  const over = await authority.handle(state, params(state, { action: 'create' }));
  assert.equal(over.error.reason, 'helper_worktree_limit');
  assert.equal(authority.liveCount(makeState()), 0, 'another binding has its own count');
});

test('settle removes an unchanged worktree and frees its slot', async () => {
  const { service, authority } = makeAuthority();
  const state = makeState();
  await authority.handle(state, params(state, { action: 'create' }));
  const settled = await authority.handle(state, params(state, { action: 'settle', helper_worktree_id: 'wt_1', keep: false }));
  assert.deepEqual(settled.helper_worktree, { id: 'wt_1', kept: false });
  assert.deepEqual(service.calls.delete[0], { workspaceRoot: 'C:\\proj', worktreeId: 'wt_1' });
  assert.equal(authority.liveCount(state), 0);
});

test('settle with keep leaves the worktree, and a refused delete reports it kept', async () => {
  const service = makeService();
  service.createWorktree = async (request) => ({ success: true, worktree: {
    id: 'wt_dirty', branch: request.branch, worktree_path: 'C:\\wt\\dirty' } });
  const { authority } = makeAuthority(service);
  const state = makeState();
  await authority.handle(state, params(state, { action: 'create' }));
  const settled = await authority.handle(state, params(state, { action: 'settle', helper_worktree_id: 'wt_dirty', keep: false }));
  assert.equal(settled.helper_worktree.kept, true);
  assert.equal(settled.helper_worktree.reason, 'dirty_worktree');
});

test('an id not issued on this binding cannot be settled', async () => {
  const { service, authority } = makeAuthority();
  const issuer = makeState();
  await authority.handle(issuer, params(issuer, { action: 'create' }));
  const other = makeState({ requestId: 'req-2', authorityRevision: 'rev-2' });
  const result = await authority.handle(other, params(other, { action: 'settle', helper_worktree_id: 'wt_1', keep: false }));
  assert.equal(result.error.reason, 'helper_worktree_unknown');
  assert.equal(service.calls.delete.length, 0);
});

test('no worktree service (a hosted server) refuses creation', async () => {
  const authority = new HelperWorktreeAuthority({ resolveWorktreeService: () => null, fsImpl: fakeFs });
  const state = makeState();
  const result = await authority.handle(state, params(state, { action: 'create' }));
  assert.equal(result.error.reason, 'helper_worktree_unavailable');
});

test('SessionExecutionAuthority routes helper worktree operations for an Auto binding only', async () => {
  const { SessionExecutionAuthority } = require('../services/backend/session-execution-authority');
  const captured = Object.freeze({ project_id: 'project_1', root_path: 'C:\\proj', root_id: 'root_x',
    root_revision: 1, device_id: null, inode: null });
  const service = makeService();
  const summary = { id: 'session_1', run_mode: 'auto', plan_mode: false };
  const sea = new SessionExecutionAuthority({
    projectAuthority: {
      _sessionStore: { getSessionSummary: () => summary },
      captureSession: () => captured, requireCurrent: (value) => value,
    },
    permissionStore: { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) },
    knowledgeService: { getSidecarConfig: () => ({ knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: () => ({}),
    resolveWorktreeService: () => service,
    randomUUID: () => 'rev_auto',
  });
  sea._helperWorktrees._fs = fakeFs;
  const op = (binding, requestId) => sea.handleHelperWorktree(binding, {
    schema_version: 1, api_version: '2026-10-15', kind: HELPER_WORKTREE_KIND, action: 'create',
    request_id: requestId, session_id: 'session_1', authority_revision: 'rev_auto', operation_id: 'op-1',
  });
  const auto = sea.captureSession('session_1', { requestId: 'request_auto', mode: 'assist', approvalMode: 'auto_run' });
  assert.equal((await op(auto, 'request_auto')).status, 'granted');
  const ask = sea.captureSession('session_1', { requestId: 'request_ask', mode: 'assist', approvalMode: 'prompt' });
  assert.equal((await op(ask, 'request_ask')).error.reason, 'helper_worktree_refused');
  sea.close(auto);
  assert.equal((await op(auto, 'request_auto')).error.reason, 'project_authority_stale');
});

test('concurrent creates cannot pass the live limit while they are still being created', async () => {
  const service = makeService();
  const create = service.createWorktree.bind(service);
  service.createWorktree = async (request) => { await new Promise((resolve) => setImmediate(resolve)); return create(request); };
  const { authority } = makeAuthority(service);
  const state = makeState();
  const results = await Promise.all(Array.from({ length: MAX_LIVE_HELPER_WORKTREES + 1 },
    () => authority.handle(state, params(state, { action: 'create' }))));
  assert.equal(results.filter((result) => result.status === 'granted').length, MAX_LIVE_HELPER_WORKTREES);
  assert.equal(results.filter((result) => result.error?.reason === 'helper_worktree_limit').length, 1);
  assert.equal(authority.liveCount(state), MAX_LIVE_HELPER_WORKTREES);
});

test(`no helper worktree is issued while ${MAX_KEPT_HELPER_WORKTREES} kept ones wait to be merged`, async () => {
  const service = makeService();
  let kept = MAX_KEPT_HELPER_WORKTREES;
  service.listWorktrees = async () => ({ success: true, worktrees: [
    { branch: 'main', status: 'available' },
    { branch: 'refs/heads/jenny-helper/old', status: 'missing' },
    ...Array.from({ length: kept }, (_, index) => ({ branch: `jenny-helper/k${index}`, status: 'available' })),
  ] });
  const { authority } = makeAuthority(service);
  const state = makeState();
  const refused = await authority.handle(state, params(state, { action: 'create' }));
  assert.equal(refused.error.reason, 'helper_worktree_backlog');
  assert.equal(service.calls.create.length, 0);
  assert.equal(authority.liveCount(state), 0, 'a refused create frees its reserved slot');
  kept -= 1;
  assert.equal((await authority.handle(state, params(state, { action: 'create' }))).status, 'granted');
});

test('a failed worktree listing does not block a create', async () => {
  const service = makeService();
  service.listWorktrees = async () => ({ success: false, reason: 'git_list_failed' });
  const { authority } = makeAuthority(service);
  const state = makeState();
  assert.equal((await authority.handle(state, params(state, { action: 'create' }))).status, 'granted');
});

test('a stale binding cannot create, but it can still settle what it issued', async () => {
  const { service, authority } = makeAuthority();
  const state = makeState();
  await authority.handle(state, params(state, { action: 'create' }));
  const stale = () => { throw new Error('Session project authority changed during the request.'); };
  const create = await authority.handle(state, params(state, { action: 'create' }), stale);
  assert.equal(create.error.reason, 'project_authority_stale');
  const settle = await authority.handle(state,
    params(state, { action: 'settle', helper_worktree_id: 'wt_1', keep: false }), stale);
  assert.deepEqual(settle.helper_worktree, { id: 'wt_1', kept: false });
  assert.equal(service.calls.delete.length, 1);
});

test('closing the binding offers every unsettled helper worktree for removal', async () => {
  const { SessionExecutionAuthority } = require('../services/backend/session-execution-authority');
  const captured = Object.freeze({ project_id: 'project_1', root_path: 'C:/proj', root_id: 'root_x',
    root_revision: 1, device_id: null, inode: null });
  const service = makeService();
  const sea = new SessionExecutionAuthority({
    projectAuthority: {
      _sessionStore: { getSessionSummary: () => ({ id: 'session_1', run_mode: 'auto', plan_mode: false }) },
      captureSession: () => captured, requireCurrent: (value) => value,
    },
    permissionStore: { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) },
    knowledgeService: { getSidecarConfig: () => ({ knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: () => ({}),
    resolveWorktreeService: () => service,
    randomUUID: () => 'rev_auto',
  });
  sea._helperWorktrees._fs = fakeFs;
  const binding = sea.captureSession('session_1', { requestId: 'request_auto', mode: 'assist', approvalMode: 'auto_run' });
  for (let index = 0; index < 2; index += 1) {
    await sea.handleHelperWorktree(binding, {
      schema_version: 1, api_version: '2026-10-15', kind: HELPER_WORKTREE_KIND, action: 'create',
      request_id: 'request_auto', session_id: 'session_1', authority_revision: 'rev_auto', operation_id: `op-${index}`,
    });
  }
  sea.close(binding);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(service.calls.delete.map((call) => call.worktreeId), ['wt_1', 'wt_2']);
});
