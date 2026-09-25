'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { evaluatePolicy } = require('../services/tools/tool-policy-evaluator');
const { ToolPermissionStore } = require('../services/tools/tool-permission-store');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');

const AUTHORITY = Object.freeze({
  project_id: 'project_alpha',
  root_path: 'G:\\workspace\\alpha',
  root_id: 'root_alpha',
  root_revision: 2,
  device_id: '7',
  inode: '42',
});

function createTempStore() {
  const dir = createTrackedTempDir('jenny-perm-');
  const filePath = path.join(dir, 'tool-permissions.json');
  return { store: new ToolPermissionStore(filePath), filePath };
}

function evaluateWrite(store, targetPath, authority = AUTHORITY) {
  return evaluatePolicy({
    descriptor: {
      name: 'write_file', side_effecting: true, read_only: false,
      tool_family: 'filesystem', source_kind: 'builtin',
    },
    args: { path: targetPath },
    snapshot: store.getSnapshot(authority),
  });
}

test.afterEach(async () => {
  await cleanupTrackedResources();
});

describe('ToolPermissionStore scoped always-allow grants', () => {
  test('grantAlwaysAllow durably stores one idempotent authority-scoped grant', () => {
    const { store, filePath } = createTempStore();
    const grant = store.grantAlwaysAllow('write_file', { path: 'docs/a.md' }, AUTHORITY);
    const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    assert.equal(persisted.schema_version, 2);
    assert.equal(persisted.scoped_grants.length, 1);
    assert.deepEqual(persisted.scoped_grants[0].authority, AUTHORITY);
    assert.equal(persisted.scoped_grants[0].path_prefix, 'docs/a.md');
    assert.equal(store.getSnapshot().rules.some((rule) => rule.id === grant.ruleId), false);
    assert.equal(store.getSnapshot(AUTHORITY).rules.some((rule) => rule.id === grant.ruleId), true);

    assert.deepEqual(
      store.grantAlwaysAllow('write_file', { path: 'docs/a.md' }, AUTHORITY),
      grant
    );
    assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).scoped_grants.length, 1);
  });

  test('auto decisions require a valid captured authority', () => {
    const { store } = createTempStore();
    assert.throws(
      () => store.grantAlwaysAllow('write_file', { path: 'docs/a.md' }),
      (error) => error.code === 'permission_scope_required'
    );
    assert.throws(
      () => store.setPolicy('run_command', 'auto'),
      (error) => error.code === 'permission_scope_required'
    );
    assert.equal(store.listStoredDecisions().scoped_grants.length, 0);
  });

  test('path and whole-tool grants are scoped to the captured authority', () => {
    const { store } = createTempStore();
    const pathGrant = store.grantAlwaysAllow(
      'write_file', { file_path: 'src/x.js' }, AUTHORITY
    );
    const toolGrant = store.grantAlwaysAllow('run_command', { command: 'ls' }, AUTHORITY);

    assert.equal(pathGrant.scope, 'path');
    assert.equal(pathGrant.pathPrefix, 'src/x.js');
    assert.equal(toolGrant.scope, 'tool');
    assert.equal(store.getPolicy('run_command'), undefined);
    assert.notEqual(evaluateWrite(store, 'src/y.js').decision, 'auto');
    assert.equal(evaluateWrite(store, 'src/x.js').decision, 'auto');
  });

  test('a global deny outranks a matching scoped allow', () => {
    const { store } = createTempStore();
    store.setPolicy('write_file', 'deny');
    store.grantAlwaysAllow('write_file', { path: 'docs/a.md' }, AUTHORITY);
    assert.equal(evaluateWrite(store, 'docs/a.md').decision, 'deny');
  });
});

describe('ToolPermissionStore saved decisions', () => {
  test('listStoredDecisions exposes scoped grants without synthetic deny rules', () => {
    const { store } = createTempStore();
    store.setPolicy('delete_file', 'deny');
    store.grantAlwaysAllow('write_file', { path: 'docs/a.md' }, AUTHORITY);

    const saved = store.listStoredDecisions();
    assert.deepEqual(saved.policies, { delete_file: 'deny' });
    assert.deepEqual(saved.rules, []);
    assert.equal(saved.scoped_grants.length, 1);
    assert.equal(store.getSnapshot(AUTHORITY).rules.length, 2);
  });

  test('clearPolicy restores a default and removeRule removes a scoped grant', () => {
    const { store } = createTempStore();
    store.setPolicy('run_command', 'deny');
    const grant = store.grantAlwaysAllow('write_file', { path: 'docs/a.md' }, AUTHORITY);

    assert.deepEqual(store.clearPolicy('Bash'), { cleared: true, toolName: 'run_command' });
    assert.equal(store.getAllPolicies().run_command, 'ask');
    assert.deepEqual(store.removeRule(grant.ruleId), { removed: true, ruleId: grant.ruleId });
    assert.notEqual(evaluateWrite(store, 'docs/a.md').decision, 'auto');
    assert.deepEqual(store.removeRule(grant.ruleId), { removed: false, ruleId: grant.ruleId });
  });
});
