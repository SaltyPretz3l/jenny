'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { registerWorkspaceRecoveryIpcHandlers } = require('../services/workspace-recovery-ipc-handlers');
const { getBridgeChannel } = require('../services/ipc-contract');
const { API_VERSION } = require('../services/backend/sidecar-client');

const CHANGE_SET_ID = '01990f9a-8c51-7ad2-a8be-41190e0e2525';
const MISSING_SIGNATURE = {
  kind: 'missing', byte_size: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
};

function outsideUndoSet(overrides = {}) {
  return {
    shell_mutations: 'not_journaled_approval_gated',
    explorer_rename: 'not_journaled_until_wo_27_item_2',
    known_unjournaled_events: [],
    warning: 'Approved shell mutations and Explorer renames may be outside this recovery set.',
    ...overrides,
  };
}

function listResult(overrides = {}) {
  return {
    workspace_id: 'root_abc',
    change_sets: [changeSetSummary()],
    outside_undo_set: outsideUndoSet(),
    ...overrides,
  };
}

function changeSetSummary(overrides = {}) {
  return {
    change_set_id: CHANGE_SET_ID,
    state: 'committed',
    restore_status: 'not_requested',
    operation_count: 1,
    updated_at: '2026-09-04T00:00:00Z',
    partially_undoable: false,
    warning: '',
    ...overrides,
  };
}

function preflightResult(overrides = {}) {
  return {
    change_set_id: CHANGE_SET_ID,
    status: 'preflight',
    conflicts: [],
    inverse_plan: [{
      sequence: 1,
      inverse_step_id: '1.1',
      kind: 'remove_created',
      from_relative_path: 'created.txt',
      to_relative_path: null,
      expected_current_signature: MISSING_SIGNATURE,
    }],
    staging_entries: [],
    outside_undo_set: outsideUndoSet(),
    ...overrides,
  };
}

function undoReceipt(overrides = {}) {
  return {
    change_set_id: CHANGE_SET_ID,
    status: 'committed',
    restored: [{ inverse_step_id: '1.1', relative_path: 'a.txt' }],
    skipped: [],
    renamed_to: [],
    protected: [],
    outside_undo_set: outsideUndoSet(),
    ...overrides,
  };
}

function trashReceipt(overrides = {}) {
  return {
    name: '20260904T150311.401Z',
    status: 'committed',
    restored: [{ relative_path: 'deleted-note.md' }],
    skipped: [],
    renamed_to: [],
    protected: [],
    outside_undo_set: outsideUndoSet(),
    recovery_retained: true,
    ...overrides,
  };
}

function buildRegistry() {
  const handlers = new Map();
  const ipcMainLike = {
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  };
  return { handlers, ipcMainLike };
}

function stubBackendService(request) {
  return { sidecarClient: { request } };
}

function invoke(handlers, methodPath, ...args) {
  const handler = handlers.get(getBridgeChannel(methodPath, 'invoke'));
  assert.ok(handler, `expected a registered handler for ${methodPath}`);
  return handler({}, ...args);
}

test('registers all five workspaceRecovery invoke channels', () => {
  const { handlers, ipcMainLike } = buildRegistry();
  registerWorkspaceRecoveryIpcHandlers({
    ipcMainLike,
    backendService: stubBackendService(async () => ({})),
    ipcAuthorization: {},
  });
  for (const methodPath of [
    'workspaceRecovery.listChangeSets',
    'workspaceRecovery.preflightUndo',
    'workspaceRecovery.undoChangeSet',
    'workspaceRecovery.restoreTrashEntry',
    'workspaceRecovery.abandonRestore',
  ]) {
    assert.ok(handlers.has(getBridgeChannel(methodPath, 'invoke')));
  }
});

test('listChangeSets forwards accept_version and passes the sidecar result through', async () => {
  const calls = [];
  const { handlers, ipcMainLike } = buildRegistry();
  registerWorkspaceRecoveryIpcHandlers({
    ipcMainLike,
    backendService: stubBackendService(async (method, params) => {
      calls.push({ method, params });
      return listResult();
    }),
    ipcAuthorization: {},
  });

  const result = await invoke(handlers, 'workspaceRecovery.listChangeSets', {});

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'workspace.list_change_sets');
  assert.equal(calls[0].params.accept_version, API_VERSION);
  assert.deepEqual(result, {
    ok: true,
    ...listResult(),
  });
});

test('preflightUndo rejects a missing/invalid change set id before calling the sidecar', async () => {
  const calls = [];
  const { handlers, ipcMainLike } = buildRegistry();
  registerWorkspaceRecoveryIpcHandlers({
    ipcMainLike,
    backendService: stubBackendService(async (method, params) => { calls.push({ method, params }); return {}; }),
    ipcAuthorization: {},
  });

  const missing = await invoke(handlers, 'workspaceRecovery.preflightUndo', { changeSetId: '' });
  const withSlash = await invoke(handlers, 'workspaceRecovery.preflightUndo', { changeSetId: 'a/b' });

  assert.equal(calls.length, 0, 'the sidecar is never called for an invalid id');
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'change_set_id_invalid');
  assert.equal(withSlash.ok, false);
  assert.equal(withSlash.reason, 'change_set_id_invalid');
});

test('preflightUndo converts camelCase changeSetId to snake_case on the wire', async () => {
  const calls = [];
  const { handlers, ipcMainLike } = buildRegistry();
  registerWorkspaceRecoveryIpcHandlers({
    ipcMainLike,
    backendService: stubBackendService(async (method, params) => {
      calls.push({ method, params });
      return preflightResult({ change_set_id: params.change_set_id });
    }),
    ipcAuthorization: {},
  });

  const result = await invoke(handlers, 'workspaceRecovery.preflightUndo', { changeSetId: CHANGE_SET_ID.toUpperCase() });

  assert.equal(calls[0].method, 'workspace.preflight_undo');
  assert.equal(calls[0].params.change_set_id, CHANGE_SET_ID);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'preflight');
});

test('undoChangeSet bounds decisions: an unknown outcome is refused before the sidecar sees it', async () => {
  const calls = [];
  const { handlers, ipcMainLike } = buildRegistry();
  registerWorkspaceRecoveryIpcHandlers({
    ipcMainLike,
    backendService: stubBackendService(async (method, params) => { calls.push({ method, params }); return {}; }),
    ipcAuthorization: {},
  });

  const result = await invoke(handlers, 'workspaceRecovery.undoChangeSet', {
    changeSetId: CHANGE_SET_ID,
    decisions: { '1.1': 'delete_everything' },
  });

  assert.equal(calls.length, 0);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'decisions_invalid');

  const invalidStep = await invoke(handlers, 'workspaceRecovery.undoChangeSet', {
    changeSetId: CHANGE_SET_ID,
    decisions: { step1: 'skip' },
  });
  assert.equal(calls.length, 0);
  assert.equal(invalidStep.reason, 'decisions_invalid');
});

test('unexpected payload keys and oversized sidecar arrays fail closed at the Electron edge', async () => {
  const calls = [];
  const { handlers, ipcMainLike } = buildRegistry();
  registerWorkspaceRecoveryIpcHandlers({
    ipcMainLike,
    backendService: stubBackendService(async (method, params) => {
      calls.push({ method, params });
      return listResult({ change_sets: Array.from({ length: 201 }, () => listResult().change_sets[0]) });
    }),
    ipcAuthorization: {},
  });

  const extraKey = await invoke(handlers, 'workspaceRecovery.preflightUndo', {
    changeSetId: CHANGE_SET_ID,
    workspaceRoot: 'C:\\outside',
  });
  const oversized = await invoke(handlers, 'workspaceRecovery.listChangeSets', {});

  assert.equal(extraKey.reason, 'payload_invalid');
  assert.equal(calls.length, 1, 'only the well-shaped list request reaches the sidecar');
  assert.equal(oversized.ok, false);
  assert.equal(oversized.reason, 'recovery_response_invalid');
  assert.equal(Object.hasOwn(oversized, 'change_sets'), false);
});

test('undoChangeSet forwards a valid decisions map and the receipt through unchanged', async () => {
  const calls = [];
  const { handlers, ipcMainLike } = buildRegistry();
  registerWorkspaceRecoveryIpcHandlers({
    ipcMainLike,
    backendService: stubBackendService(async (method, params) => {
      calls.push({ method, params });
      return undoReceipt({
        restored: [{ inverse_step_id: '2.1', relative_path: 'a.txt' }],
        renamed_to: [{ inverse_step_id: '1.1', relative_path: 'b.txt', restored_relative_path: 'b.jenny-restored-01990f9a-1.txt' }],
        outside_undo_set: outsideUndoSet({ warning: 'shell mutations excluded' }),
      });
    }),
    ipcAuthorization: {},
  });

  const result = await invoke(handlers, 'workspaceRecovery.undoChangeSet', {
    changeSetId: CHANGE_SET_ID,
    decisions: { '1.1': 'alternate_name' },
  });

  assert.equal(calls[0].method, 'workspace.undo_change_set');
  assert.deepEqual(calls[0].params.decisions, { '1.1': 'alternate_name' });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'committed');
  assert.equal(result.renamed_to[0].restored_relative_path, 'b.jenny-restored-01990f9a-1.txt');
  assert.deepEqual(result.outside_undo_set, outsideUndoSet({ warning: 'shell mutations excluded' }));
});

test('undoChangeSet with no decisions omits the field rather than sending null/empty', async () => {
  const calls = [];
  const { handlers, ipcMainLike } = buildRegistry();
  registerWorkspaceRecoveryIpcHandlers({
    ipcMainLike,
    backendService: stubBackendService(async (method, params) => { calls.push({ method, params }); return undoReceipt(); }),
    ipcAuthorization: {},
  });

  await invoke(handlers, 'workspaceRecovery.undoChangeSet', { changeSetId: CHANGE_SET_ID });

  assert.equal(Object.prototype.hasOwnProperty.call(calls[0].params, 'decisions'), false);
});

test('restoreTrashEntry rejects a path-separator name before calling the sidecar', async () => {
  const calls = [];
  const { handlers, ipcMainLike } = buildRegistry();
  registerWorkspaceRecoveryIpcHandlers({
    ipcMainLike,
    backendService: stubBackendService(async (method, params) => { calls.push({ method, params }); return {}; }),
    ipcAuthorization: {},
  });

  const result = await invoke(handlers, 'workspaceRecovery.restoreTrashEntry', { name: '../escape' });

  assert.equal(calls.length, 0);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'trash_entry_name_invalid');
});

test('restoreTrashEntry forwards a valid name and decision', async () => {
  const calls = [];
  const { handlers, ipcMainLike } = buildRegistry();
  registerWorkspaceRecoveryIpcHandlers({
    ipcMainLike,
    backendService: stubBackendService(async (method, params) => {
      calls.push({ method, params });
      return trashReceipt({ name: params.name });
    }),
    ipcAuthorization: {},
  });

  const result = await invoke(handlers, 'workspaceRecovery.restoreTrashEntry', {
    name: '20260904T150311.401Z',
    decision: 'protect_then_replace',
  });

  assert.equal(calls[0].method, 'workspace.restore_trash_entry');
  assert.equal(calls[0].params.name, '20260904T150311.401Z');
  assert.equal(calls[0].params.decision, 'protect_then_replace');
  assert.equal(result.ok, true);
  assert.equal(result.recovery_retained, true);
});

test('abandonRestore forwards both ids and returns the updated change-set summary', async () => {
  const calls = [];
  const { handlers, ipcMainLike } = buildRegistry();
  registerWorkspaceRecoveryIpcHandlers({
    ipcMainLike,
    backendService: stubBackendService(async (method, params) => {
      calls.push({ method, params });
      return changeSetSummary({ restore_status: 'not_requested' });
    }),
    ipcAuthorization: {},
  });

  const result = await invoke(handlers, 'workspaceRecovery.abandonRestore', {
    workspaceId: 'root_abc',
    changeSetId: CHANGE_SET_ID.toUpperCase(),
  });

  assert.deepEqual(calls, [{
    method: 'workspace.abandon_restore',
    params: {
      accept_version: API_VERSION,
      workspace_id: 'root_abc',
      change_set_id: CHANGE_SET_ID,
    },
  }]);
  assert.deepEqual(result, { ok: true, ...changeSetSummary() });
});

test('abandonRestore rejects a bad change-set id before calling the sidecar', async () => {
  const calls = [];
  const { handlers, ipcMainLike } = buildRegistry();
  registerWorkspaceRecoveryIpcHandlers({
    ipcMainLike,
    backendService: stubBackendService(async (...args) => { calls.push(args); return {}; }),
    ipcAuthorization: {},
  });

  const result = await invoke(handlers, 'workspaceRecovery.abandonRestore', {
    workspaceId: 'root_abc',
    changeSetId: '../bad',
  });

  assert.equal(calls.length, 0);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'change_set_id_invalid');
});

test('abandonRestore rejects an unauthorized sender before calling the sidecar', async () => {
  const calls = [];
  const { handlers, ipcMainLike } = buildRegistry();
  registerWorkspaceRecoveryIpcHandlers({
    ipcMainLike,
    backendService: stubBackendService(async (...args) => { calls.push(args); return {}; }),
    ipcAuthorization: { authorize: (event) => event?.trusted === true },
  });
  const handler = handlers.get(getBridgeChannel('workspaceRecovery.abandonRestore', 'invoke'));

  const result = await handler({ trusted: false }, {
    workspaceId: 'root_abc',
    changeSetId: CHANGE_SET_ID,
  });

  assert.deepEqual(result, {
    ok: false,
    authorized: false,
    code: 'ipc_sender_unauthorized',
  });
  assert.equal(calls.length, 0);
});

test('a missing sidecar client fails closed with a structured, non-throwing result', async () => {
  const { handlers, ipcMainLike } = buildRegistry();
  registerWorkspaceRecoveryIpcHandlers({
    ipcMainLike,
    backendService: {},
    ipcAuthorization: {},
  });

  const result = await invoke(handlers, 'workspaceRecovery.listChangeSets', {});

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'sidecar_unavailable');
  assert.equal(typeof result.error_code, 'string');
});

test('a structured sidecar RPC rejection (needs_review) surfaces its reason and status honestly', async () => {
  const rpcError = new Error('Interrupted restore requires manual review.');
  rpcError.rpc = {
    code: -32004,
    message: rpcError.message,
    data: {
      error_code: 'CMP-TOOL-0008',
      reason: 'restore_needs_review',
      status: 'needs_review',
    },
  };
  const { handlers, ipcMainLike } = buildRegistry();
  registerWorkspaceRecoveryIpcHandlers({
    ipcMainLike,
    backendService: stubBackendService(async () => { throw rpcError; }),
    ipcAuthorization: {},
  });

  const result = await invoke(handlers, 'workspaceRecovery.preflightUndo', { changeSetId: CHANGE_SET_ID });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'restore_needs_review');
  assert.equal(result.status, 'needs_review');
  assert.equal(result.message, 'Interrupted restore requires manual review.');
});

test('undoChangeSet surfaces the incomplete-decisions error with the required step ids', async () => {
  const rpcError = new Error('Every restore conflict requires one explicit outcome.');
  rpcError.rpc = {
    code: -32004,
    message: rpcError.message,
    data: {
      error_code: 'CMP-TOOL-0008',
      reason: 'restore_decisions_incomplete',
      required_inverse_step_ids: ['1.1', '2.1'],
    },
  };
  const { handlers, ipcMainLike } = buildRegistry();
  registerWorkspaceRecoveryIpcHandlers({
    ipcMainLike,
    backendService: stubBackendService(async () => { throw rpcError; }),
    ipcAuthorization: {},
  });

  const result = await invoke(handlers, 'workspaceRecovery.undoChangeSet', { changeSetId: CHANGE_SET_ID, decisions: { '1.1': 'skip' } });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'restore_decisions_incomplete');
  assert.deepEqual(result.required_inverse_step_ids, ['1.1', '2.1']);
});

test('preflightUndo rejects duplicate conflict identities instead of returning an unusable review', async () => {
  const conflict = {
    inverse_step_id: '1.1',
    sequence: 1,
    kind: 'remove_created',
    relative_path: 'created.txt',
    reasons: ['current_path_changed'],
    expected_signature: MISSING_SIGNATURE,
    current_signature: MISSING_SIGNATURE,
    allowed_outcomes: ['skip', 'alternate_name', 'protect_then_replace'],
  };
  const malformed = preflightResult({ conflicts: [conflict, { ...conflict }] });
  const { handlers, ipcMainLike } = buildRegistry();
  registerWorkspaceRecoveryIpcHandlers({
    ipcMainLike,
    backendService: stubBackendService(async () => malformed),
    ipcAuthorization: {},
  });

  const result = await invoke(handlers, 'workspaceRecovery.preflightUndo', { changeSetId: CHANGE_SET_ID });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'recovery_response_invalid');
  assert.equal(result.error_code, 'CMP-TOOL-0008');
});

test('registered handlers respect the shared trusted-sender authorizer', async () => {
  const { handlers, ipcMainLike } = buildRegistry();
  registerWorkspaceRecoveryIpcHandlers({
    ipcMainLike,
    backendService: stubBackendService(async () => listResult({ change_sets: [] })),
    ipcAuthorization: {
      authorize: (event) => event?.trusted === true,
    },
  });

  const handler = handlers.get(getBridgeChannel('workspaceRecovery.listChangeSets', 'invoke'));
  assert.deepEqual(await handler({ trusted: false }), {
    ok: false,
    authorized: false,
    code: 'ipc_sender_unauthorized',
  });
  const allowed = await handler({ trusted: true });
  assert.equal(allowed.ok, true);
});

test('an abandoned restore status passes the summary validator on the abandon path', async () => {
  const { handlers, ipcMainLike } = buildRegistry();
  registerWorkspaceRecoveryIpcHandlers({
    ipcMainLike,
    backendService: stubBackendService(async () => changeSetSummary({ restore_status: 'abandoned' })),
    ipcAuthorization: {},
  });

  const result = await invoke(handlers, 'workspaceRecovery.abandonRestore', {
    workspaceId: 'root_abc',
    changeSetId: CHANGE_SET_ID,
  });

  assert.equal(result.ok, true);
  assert.equal(result.restore_status, 'abandoned');
});

test('a worker-family cap rejection keeps the CMP code the sidecar reports under data.code', async () => {
  const rpcError = new Error('Workspace recovery is busy.');
  rpcError.rpc = {
    code: -32005,
    message: rpcError.message,
    data: { code: 'CMP-TOOL-0003', reason: 'worker_family_saturated' },
  };
  const { handlers, ipcMainLike } = buildRegistry();
  registerWorkspaceRecoveryIpcHandlers({
    ipcMainLike,
    backendService: stubBackendService(async () => { throw rpcError; }),
    ipcAuthorization: {},
  });

  const result = await invoke(handlers, 'workspaceRecovery.preflightUndo', { changeSetId: CHANGE_SET_ID });

  assert.equal(result.ok, false);
  assert.equal(result.error_code, 'CMP-TOOL-0003');
  assert.equal(result.reason, 'worker_family_saturated');
  assert.equal(result.message, 'Workspace recovery is busy.');
});
