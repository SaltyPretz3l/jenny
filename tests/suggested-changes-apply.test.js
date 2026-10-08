'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const moduleExports = require('../services/backend/suggested-changes-apply');
const { API_VERSION } = require('../services/backend/sidecar-client');
const { REQUEST_TIMEOUT_MS_BY_METHOD } = require('../services/backend/sidecar-request-timeouts');

const { applySuggestedChanges } = moduleExports;
const METHOD = 'workspace.apply_suggested_changes';
const ROOT = process.platform === 'win32' ? 'C:\\work\\project' : '/work/project';
const AUTHORITY = Object.freeze({ root_path: ROOT, root_id: 'root_abc', device_id: 42, inode: '7' });
const BASE = `sha256:${'a'.repeat(64)}`;
const HEAD = `sha256:${'b'.repeat(64)}`;
const AFTER = `sha256:${'c'.repeat(64)}`;
const CHANGE_SET_ID = '01990f9a-8c51-7ad2-a8be-41190e0e2525';
const REFUSED_EMPTY = { schema_version: 1, status: 'refused', workspace_change_set: null, items: [] };

function replaceItem(overrides = {}) {
  return {
    suggestion_id: 'sug-1', path: 'src/a.js', kind: 'replace',
    old_string: 'const a = 1;', new_string: 'const a = 2;', expected_hash: BASE, ...overrides,
  };
}

function createItem(overrides = {}) {
  return {
    suggestion_id: 'sug-2', path: 'src/new.js', kind: 'create',
    old_string: null, new_string: 'export {};\n', expected_hash: null, ...overrides,
  };
}

function appliedResult(items) {
  return {
    schema_version: 1,
    status: 'applied',
    workspace_change_set: { change_set_id: CHANGE_SET_ID },
    items: items.map((item) => ({
      suggestion_id: item.suggestion_id, outcome: 'applied', reason: null,
      after_hash: AFTER, diff: { status: 'modified', hunks: [] }, base_hash: item.expected_hash,
    })),
  };
}

function recorder(reply) {
  const calls = [];
  const request = async (method, params, options) => {
    calls.push({ method, params, options });
    return typeof reply === 'function' ? reply(params) : reply;
  };
  return { calls, request };
}

test('module exports exactly applySuggestedChanges', () => {
  assert.deepEqual(Object.keys(moduleExports), ['applySuggestedChanges']);
});

test('the method has a recovery-lane timeout budget', () => {
  assert.equal(REQUEST_TIMEOUT_MS_BY_METHOD[METHOD], 120_000);
});

test('params carry the explicit root authority and the wire items', async () => {
  const { calls, request } = recorder((params) => appliedResult(params.items));
  const items = [replaceItem({ expected_hash: HEAD }), createItem()];
  const result = await applySuggestedChanges({
    request, authority: AUTHORITY, sessionId: 'session-1', items, applyId: 'apply-1',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, METHOD);
  assert.deepEqual(calls[0].options, { timeoutMs: 120_000 });
  assert.deepEqual(calls[0].params, {
    accept_version: API_VERSION,
    schema_version: 1,
    workspace_root: ROOT,
    device_id: '42',
    inode: '7',
    session_id: 'session-1',
    apply_id: 'apply-1',
    items: [
      { suggestion_id: 'sug-1', path: 'src/a.js', kind: 'replace', old_string: 'const a = 1;',
        new_string: 'const a = 2;', expected_hash: HEAD },
      { suggestion_id: 'sug-2', path: 'src/new.js', kind: 'create', old_string: null,
        new_string: 'export {};\n', expected_hash: null },
    ],
  });
  assert.deepEqual(result, appliedResult(calls[0].params.items));
});

test('an apply id is generated when none is supplied', async () => {
  const { calls, request } = recorder((params) => appliedResult(params.items));
  await applySuggestedChanges({ request, authority: AUTHORITY, sessionId: 's', items: [createItem()] });
  assert.match(calls[0].params.apply_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('invalid inputs throw before the sidecar is called', async () => {
  const cases = [
    [{ authority: { root_path: null, device_id: null, inode: null } }, 'workspace_required'],
    [{ authority: { ...AUTHORITY, inode: null } }, 'workspace_required'],
    [{ authority: { ...AUTHORITY, root_path: 'relative' } }, 'workspace_required'],
    [{ sessionId: '' }, 'session_required'],
    [{ items: [] }, 'items_invalid'],
    [{ items: Array.from({ length: 21 }, (_, index) => replaceItem({ suggestion_id: `s-${index}` })) },
      'too_many_items'],
    [{ items: [replaceItem(), replaceItem()] }, 'duplicate_suggestion_id'],
    [{ items: [replaceItem({ kind: 'delete' })] }, 'item_invalid'],
    [{ items: [replaceItem({ old_string: '' })] }, 'item_invalid'],
    [{ items: [replaceItem({ expected_hash: null })] }, 'item_invalid'],
    [{ items: [createItem({ expected_hash: BASE })] }, 'item_invalid'],
    [{ items: [replaceItem({ path: '' })] }, 'item_invalid'],
  ];
  for (const [overrides, reason] of cases) {
    const { calls, request } = recorder(REFUSED_EMPTY);
    await assert.rejects(
      applySuggestedChanges({
        request, authority: AUTHORITY, sessionId: 's', items: [replaceItem()], ...overrides,
      }),
      (error) => error.reason === reason,
      reason,
    );
    assert.equal(calls.length, 0, reason);
  }
});

test('refused results with a moved revision pass through unchanged', async () => {
  const reply = {
    schema_version: 1,
    status: 'refused',
    workspace_change_set: null,
    items: [{
      suggestion_id: 'sug-1', outcome: 'moved', reason: 'hash_changed',
      after_hash: null, diff: { status: 'modified', hunks: [] }, base_hash: HEAD,
    }],
  };
  const { request } = recorder(reply);
  const result = await applySuggestedChanges({
    request, authority: AUTHORITY, sessionId: 's', items: [replaceItem()], applyId: 'a',
  });
  assert.deepEqual(result, reply);
});

test('rolled-back results carry the reverted change set', async () => {
  const reply = {
    ...appliedResult([replaceItem()]),
    status: 'rolled_back',
  };
  reply.items[0] = { ...reply.items[0], outcome: 'refused', reason: 'write_failed', after_hash: null, diff: null };
  const { request } = recorder(reply);
  const result = await applySuggestedChanges({
    request, authority: AUTHORITY, sessionId: 's', items: [replaceItem()], applyId: 'a',
  });
  assert.equal(result.status, 'rolled_back');
});

test('malformed sidecar replies become an empty refusal', async () => {
  const good = appliedResult([replaceItem()]);
  const cases = [
    null,
    { ...good, schema_version: 2 },
    { ...good, status: 'done' },
    appliedResult([replaceItem({ suggestion_id: 'other' })]),
    { ...good, items: [] },
    { ...good, workspace_change_set: { change_set_id: 'not-a-uuid' } },
    { ...good, workspace_change_set: null },
    { ...good, items: [{ ...good.items[0], outcome: 'exploded' }] },
    { ...good, items: [{ ...good.items[0], after_hash: 'md5:x' }] },
  ];
  for (const reply of cases) {
    const { request } = recorder(reply);
    const result = await applySuggestedChanges({
      request, authority: AUTHORITY, sessionId: 's', items: [replaceItem()], applyId: 'a',
    });
    assert.deepEqual(result, REFUSED_EMPTY, JSON.stringify(reply));
  }
});

test('transport errors propagate', async () => {
  const error = new Error('Sidecar process is not connected.');
  await assert.rejects(
    applySuggestedChanges({
      request: async () => { throw error; },
      authority: AUTHORITY, sessionId: 's', items: [replaceItem()], applyId: 'a',
    }),
    (thrown) => thrown === error,
  );
});
