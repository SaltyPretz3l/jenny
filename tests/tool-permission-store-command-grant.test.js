'use strict';

// Row 103 (security review item 2): "Always allow" on a run_command card saves
// a rule for that program + subcommand (or the exact command), never a
// whole-tool grant. The Settings path (setPolicy auto) keeps the whole tool.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { evaluatePolicy } = require('../services/tools/tool-policy-evaluator');
const { ToolPermissionStore } = require('../services/tools/tool-permission-store');
const { validatePermissionDocument } = require('../services/tools/tool-permission-migrations');
const { cleanupTrackedResources, createTrackedTempDir } = require('./helpers/resource-cleanup');

const AUTHORITY = Object.freeze({
  project_id: 'project_alpha', root_path: 'G:\\workspace\\alpha', root_id: 'root_alpha',
  root_revision: 2, device_id: '7', inode: '42',
});
const OTHER_AUTHORITY = Object.freeze({ ...AUTHORITY, project_id: 'project_beta', root_id: 'root_beta' });

function createTempStore() {
  const dir = createTrackedTempDir('jenny-perm-cmd-');
  const filePath = path.join(dir, 'tool-permissions.json');
  return { store: new ToolPermissionStore(filePath), filePath };
}

function evaluateCommand(store, command, authority = AUTHORITY) {
  return evaluatePolicy({
    descriptor: { name: 'run_command', side_effecting: true, read_only: false, tool_family: 'shell', source_kind: 'builtin' },
    args: { command },
    snapshot: store.getSnapshot(authority),
  });
}

test.afterEach(async () => {
  await cleanupTrackedResources();
});

describe('run_command Always allow grants', () => {
  test('a prefix-scoped command persists program + subcommand within the authority', () => {
    const { store, filePath } = createTempStore();
    const grant = store.grantAlwaysAllow('run_command', { command: 'npm test -- --runInBand' }, AUTHORITY);

    assert.equal(grant.scope, 'command_prefix');
    assert.equal(grant.commandPrefix, 'npm test');
    assert.match(grant.ruleId, /^grant:/u);
    const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.deepEqual(persisted.scoped_grants[0].match, { tool_id: 'run_command', command_prefix: 'npm test' });
    assert.equal(persisted.scoped_grants[0].path_prefix, null);
    assert.equal(validatePermissionDocument(persisted).ok, true);

    assert.equal(evaluateCommand(store, 'npm test').decision, 'auto');
    assert.equal(evaluateCommand(store, 'npm test -- --watch').decision, 'auto');
    assert.equal(evaluateCommand(store, 'npm run build').decision, 'ask');
    assert.equal(evaluateCommand(store, 'npm test && echo x').decision, 'ask');
    assert.equal(evaluateCommand(store, 'npm test', OTHER_AUTHORITY).decision, 'ask');
    assert.equal(store.getPolicy('run_command'), undefined);
  });

  test('a command without a safe prefix persists the exact trimmed text', () => {
    const { store } = createTempStore();
    const grant = store.grantAlwaysAllow('Bash', { command: '  python build.py --fast  ' }, AUTHORITY);

    assert.equal(grant.scope, 'command_exact');
    assert.equal(grant.commandExact, 'python build.py --fast');
    assert.deepEqual(store.listStoredDecisions().scoped_grants[0].match,
      { tool_id: 'run_command', command_exact: 'python build.py --fast' });
    assert.equal(evaluateCommand(store, 'python build.py --fast').decision, 'auto');
    assert.equal(evaluateCommand(store, 'python build.py').decision, 'ask');
    assert.equal(evaluateCommand(store, 'python other.py').decision, 'ask');
  });

  test('a chained command is refused and leaves no grant', () => {
    const { store } = createTempStore();
    for (const command of ['npm test && echo x', 'npm test > out.log', '', undefined]) {
      assert.throws(
        () => store.grantAlwaysAllow('run_command', { command }, AUTHORITY),
        (error) => error.code === 'permission_command_unscoped',
        String(command)
      );
    }
    assert.throws(
      () => store.grantAlwaysAllow('run_command', {}, AUTHORITY),
      (error) => error.code === 'permission_command_unscoped'
    );
    assert.equal(store.listStoredDecisions().scoped_grants.length, 0);
    assert.equal(evaluateCommand(store, 'echo anything').decision, 'ask');
  });

  test('the Settings path still saves the whole-tool run_command grant', () => {
    const { store } = createTempStore();
    const result = store.setPolicy('run_command', 'auto', AUTHORITY);

    assert.equal(result.scope, 'tool');
    assert.deepEqual(store.listStoredDecisions().scoped_grants[0].match, { tool_id: 'run_command' });
    assert.equal(evaluateCommand(store, 'npm test && echo x').decision, 'auto');
  });

  test('prefix and exact grants reload, stay distinct, and Remove deletes one', () => {
    const { store, filePath } = createTempStore();
    const prefix = store.grantAlwaysAllow('run_command', { command: 'git status' }, AUTHORITY);
    const exact = store.grantAlwaysAllow('run_command', { command: 'ls -la' }, AUTHORITY);
    assert.notEqual(prefix.ruleId, exact.ruleId);
    assert.deepEqual(store.grantAlwaysAllow('run_command', { command: 'git status --short' }, AUTHORITY), prefix);

    const reloaded = new ToolPermissionStore(filePath);
    assert.equal(reloaded.listStoredDecisions().read_only_reason, null);
    assert.equal(reloaded.listStoredDecisions().scoped_grants.length, 2);
    assert.equal(evaluateCommand(reloaded, 'git status --porcelain').decision, 'auto');

    assert.deepEqual(reloaded.removeRule(prefix.ruleId), { removed: true, ruleId: prefix.ruleId });
    assert.equal(evaluateCommand(reloaded, 'git status').decision, 'ask');
    assert.equal(evaluateCommand(reloaded, 'ls -la').decision, 'auto');
  });

  test('a global run_command ask clears its command grants', () => {
    const { store } = createTempStore();
    store.grantAlwaysAllow('run_command', { command: 'npm test' }, AUTHORITY);
    store.setPolicy('run_command', 'ask');
    assert.equal(store.listStoredDecisions().scoped_grants.length, 0);
    assert.equal(evaluateCommand(store, 'npm test').decision, 'ask');
  });
});

describe('permission document command match keys', () => {
  function documentWith(grant) {
    return JSON.parse(JSON.stringify({
      schema_version: 2, version: 1, legacy_policies: {}, rules: [], scoped_grants: [grant],
      pending_review: [], review_history: [], migration: { source_format: 'created', migrated_at: new Date().toISOString() },
    }));
  }
  const baseGrant = {
    id: 'grant:abc', tool_name: 'run_command', path_prefix: null, authority: { ...AUTHORITY },
    source: 'user', created_at: '2026-11-02T00:00:00.000Z',
  };

  test('accepts a canonical prefix or exact grant', () => {
    assert.equal(validatePermissionDocument(documentWith({ ...baseGrant,
      match: { tool_id: 'run_command', command_prefix: 'npm run build' } })).ok, true);
    assert.equal(validatePermissionDocument(documentWith({ ...baseGrant,
      match: { tool_id: 'run_command', command_exact: 'python build.py' } })).ok, true);
  });

  test('rejects malformed command keys and keeps unknown keys failing closed', () => {
    for (const match of [
      { tool_id: 'run_command', command_prefix: 'npm test', command_exact: 'npm test' },
      { tool_id: 'run_command', command_prefix: 'npm test -- --watch' },
      { tool_id: 'run_command', command_prefix: 'bash -c' },
      { tool_id: 'run_command', command_exact: 'npm test && rm -rf /' },
      { tool_id: 'run_command', command_exact: 'x'.repeat(1025) },
      { tool_id: 'write_file', command_prefix: 'npm test' },
      { tool_id: 'run_command', command_glob: 'npm *' },
    ]) {
      const toolName = match.tool_id;
      const result = validatePermissionDocument(documentWith({ ...baseGrant, tool_name: toolName, match }));
      assert.equal(result.ok, false, JSON.stringify(match));
    }
  });

  test('a deny rule may carry a command prefix', () => {
    const document = documentWith({ ...baseGrant, match: { tool_id: 'run_command', command_exact: 'ls' } });
    document.scoped_grants = [];
    document.rules = [{ id: 'deny-push', decision: 'deny', reason: 'No pushes',
      match: { tool_id: 'run_command', command_prefix: 'git push' } }];
    assert.equal(validatePermissionDocument(document).ok, true);
  });
});
