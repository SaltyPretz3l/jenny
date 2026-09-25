'use strict';

// Owner decision 2026-09-22: approval is for the user's files and commands.
// The in-session todo list and inert create_artifact documents are the
// model's own scratch state (Claude Code parity). Mirrors the sidecar's
// tests/sidecar/ai/tools/test_policy.py; the two evaluators must agree,
// because the Electron execution authority re-checks every call.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const toolManifest = require('../services/tools/tool-manifest.json');
const { evaluatePolicy, normalizePolicySnapshot } = require('../services/tools/tool-policy-evaluator');

function manifestDescriptor(name) {
  return toolManifest.tools.find(tool => tool.name === name);
}

describe('built-in defaults for the model\'s own scratch state', () => {
  test('the todo list and inert documents default to auto', () => {
    for (const [name, args] of [
      ['todo_write', { todos: [{ content: 'Outline', status: 'pending' }] }],
      ['create_artifact', { artifact_kind: 'document', title: 'Notes', content: '# Notes' }],
      ['create_artifact', { artifact_kind: 'document', title: 'Plan', content: 'a', file_name: 'plan.md' }],
    ]) {
      const result = evaluatePolicy({
        descriptor: manifestDescriptor(name),
        args,
        snapshot: normalizePolicySnapshot({}),
      });
      assert.equal(result.decision, 'auto', `${name} ${JSON.stringify(args)}`);
      assert.equal(result.stage, 'tool_default');
      assert.equal(result.matched_rule_id, null);
    }
  });

  test('executable artifacts still ask', () => {
    for (const args of [
      { artifact_kind: 'script', title: 'Run', content: 'echo hi' },
      { artifact_kind: 'document', title: 'Page', content: '<p>', file_name: 'page.html' },
      { artifact_kind: 'document', title: 'Code', content: 'x = 1', language: 'python' },
    ]) {
      const result = evaluatePolicy({
        descriptor: manifestDescriptor('create_artifact'),
        args,
        snapshot: normalizePolicySnapshot({}),
      });
      assert.equal(result.decision, 'ask', JSON.stringify(args));
    }
  });

  test('an explicit user policy still overrides the default', () => {
    for (const [name, args] of [
      ['todo_write', { todos: [] }],
      ['create_artifact', { artifact_kind: 'document', title: 'Notes', content: 'x' }],
    ]) {
      for (const stored of ['ask', 'deny']) {
        const result = evaluatePolicy({
          descriptor: manifestDescriptor(name),
          args,
          snapshot: normalizePolicySnapshot({ [name]: stored }),
        });
        assert.equal(result.decision, stored, `${name} stored ${stored}`);
      }
    }
  });
});
