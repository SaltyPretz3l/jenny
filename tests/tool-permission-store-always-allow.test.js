'use strict';

// F15: "Always allow" on a path-bearing call persists a tool + path_prefix
// rule instead of flipping the whole tool. Lives beside, not inside,
// tool-permission-store.test.js, so that file stays under the 600-line
// soft threshold.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ToolPermissionStore } = require('../services/tools/tool-permission-store');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');

function createTempStore() {
  const dir = createTrackedTempDir('jenny-perm-');
  const filePath = path.join(dir, 'tool-permissions.json');
  return { store: new ToolPermissionStore(filePath), dir, filePath };
}

test.afterEach(async () => {
  await cleanupTrackedResources();
});
describe('ToolPermissionStore scoped always-allow grants', () => {
  test('grantAlwaysAllow stores one idempotent path-scoped rule', () => {
    const { store, filePath } = createTempStore();

    const grant = store.grantAlwaysAllow('write_file', { path: 'docs/a.md' });
    const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    assert.equal(grant.scope, 'path');
    assert.equal(grant.toolName, 'write_file');
    assert.equal(grant.pathPrefix, 'docs/a.md');
    assert.equal(persisted.rules.length, 1);
    assert.equal(persisted.rules[0].decision, 'auto');
    assert.equal(persisted.rules[0].match.tool_id, 'write_file');
    assert.equal(persisted.rules[0].match.path_prefix, 'docs/a.md');
    assert.equal(store.getPolicy('write_file'), undefined);

    assert.deepEqual(store.grantAlwaysAllow('write_file', { path: 'docs/a.md' }), grant);
    assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).rules.length, 1);
  });
});

describe('ToolPermissionStore always-allow scope selection', () => {
  test('file_path scopes the grant and path takes precedence when both are present', () => {
    const filePathGrant = createTempStore().store.grantAlwaysAllow(
      'write_file',
      { file_path: 'src/x.js' }
    );
    const pathGrant = createTempStore().store.grantAlwaysAllow(
      'write_file',
      { path: 'p', file_path: 'q' }
    );

    assert.equal(filePathGrant.scope, 'path');
    assert.equal(filePathGrant.pathPrefix, 'src/x.js');
    assert.equal(pathGrant.scope, 'path');
    assert.equal(pathGrant.pathPrefix, 'p');
  });

  test('calls without a path target retain the whole-tool policy', () => {
    const { store, filePath } = createTempStore();

    const grant = store.grantAlwaysAllow('run_command', { command: 'ls' });
    const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    assert.deepEqual(grant, { scope: 'tool', toolName: 'run_command' });
    assert.equal(store.getPolicy('run_command'), 'auto');
    assert.equal(Array.isArray(persisted.rules) ? persisted.rules.length : 0, 0);
  });

  test('a path grant auto-allows only matching write_file paths', () => {
    const { evaluatePolicy } = require('../services/tools/tool-policy-evaluator');
    const { store } = createTempStore();
    const grant = store.grantAlwaysAllow('write_file', { path: 'docs/a.md' });
    const descriptor = {
      name: 'write_file',
      side_effecting: true,
      read_only: false,
      tool_family: 'filesystem',
      source_kind: 'builtin',
    };

    const matching = evaluatePolicy({
      descriptor,
      args: { path: 'docs/a.md' },
      snapshot: store.getSnapshot(),
    });
    const other = evaluatePolicy({
      descriptor,
      args: { path: 'docs/b.md' },
      snapshot: store.getSnapshot(),
    });

    assert.equal(matching.decision, 'auto');
    assert.equal(matching.matched_rule_id, grant.ruleId);
    assert.notEqual(other.decision, 'auto');
  });

  test('a pre-existing legacy deny still wins after a path grant', () => {
    const { evaluatePolicy } = require('../services/tools/tool-policy-evaluator');
    const { store } = createTempStore();
    store.setPolicy('write_file', 'deny');
    store.grantAlwaysAllow('write_file', { path: 'docs/a.md' });

    const result = evaluatePolicy({
      descriptor: {
        name: 'write_file',
        side_effecting: true,
        read_only: false,
        tool_family: 'filesystem',
        source_kind: 'builtin',
      },
      args: { path: 'docs/a.md' },
      snapshot: store.getSnapshot(),
    });

    assert.equal(result.decision, 'deny');
  });
});

describe('ToolPermissionStore saved decisions (Settings > Tools > Approval rules)', () => {
  test('listStoredDecisions returns only the stored policies and rules, never the synthetic deny rules', () => {
    const { store } = createTempStore();
    store.setPolicy('delete_file', 'deny');
    store.grantAlwaysAllow('write_file', { path: 'docs/a.md' });

    const saved = store.listStoredDecisions();

    assert.deepEqual(saved.policies, { delete_file: 'deny' });
    assert.equal(saved.rules.length, 1, 'the legacy deny is a policy row, not a rule row');
    assert.equal(saved.rules[0].match.tool_id, 'write_file');
    assert.equal(saved.rules[0].match.path_prefix, 'docs/a.md');
    assert.equal(store.getSnapshot().rules.length, 2, 'the evaluated snapshot still materializes the deny rule');
  });

  test('clearPolicy drops a stored per-tool policy and reports a miss otherwise', () => {
    const { store, filePath } = createTempStore();
    store.setPolicy('run_command', 'auto');

    assert.deepEqual(store.clearPolicy('Bash'), { cleared: true, toolName: 'run_command' });
    assert.equal(store.getPolicy('run_command'), undefined);
    assert.equal(store.getAllPolicies().run_command, 'ask', 'the default comes back');
    assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')).legacy_policies, {});
    assert.deepEqual(store.clearPolicy('run_command'), { cleared: false, toolName: 'run_command' });
    assert.throws(() => store.clearPolicy(''), /Tool name is required/);
  });

  test('removeRule deletes one stored rule by id and leaves the rest', () => {
    const { store } = createTempStore();
    const first = store.grantAlwaysAllow('write_file', { path: 'docs/a.md' });
    const second = store.grantAlwaysAllow('write_file', { path: 'docs/b.md' });

    assert.deepEqual(store.removeRule(first.ruleId), { removed: true, ruleId: first.ruleId });
    assert.deepEqual(store.listStoredDecisions().rules.map((rule) => rule.id), [second.ruleId]);
    assert.deepEqual(store.removeRule(first.ruleId), { removed: false, ruleId: first.ruleId });
    assert.throws(() => store.removeRule(''), /Rule id is required/);

    const { evaluatePolicy } = require('../services/tools/tool-policy-evaluator');
    const descriptor = {
      id: 'write_file', side_effecting: true, read_only: false, tool_family: 'filesystem',
    };
    const evaluated = evaluatePolicy({ descriptor, args: { path: 'docs/a.md' }, snapshot: store.getSnapshot() });
    assert.notEqual(evaluated.decision, 'auto', 'the removed grant no longer auto-approves');
  });
});
