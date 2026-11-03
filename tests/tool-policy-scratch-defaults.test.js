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

  test('a revision is inert exactly when the replaced file is an inert document', () => {
    const edits = [{ old_string: '# Plan', new_string: '# Plan v2' }];
    const decide = args => evaluatePolicy({
      descriptor: manifestDescriptor('create_artifact'),
      args: { artifact_kind: 'document', title: 'Plan', ...args },
      snapshot: normalizePolicySnapshot({}),
    }).decision;
    for (const args of [
      { replaces: '.jenny/artifacts/s-1/plan.md', edits },
      { replaces: 'notes.txt', content: 'v2' },
    ]) assert.equal(decide(args), 'auto', JSON.stringify(args));
    for (const args of [
      // The replaced file's own suffix classifies the write, not the defaults.
      { replaces: '.jenny/artifacts/s-1/page.html', content: '<p>v2</p>' },
      { replaces: 'page.html', edits },
      { replaces: 'no-suffix', edits },
      { replaces: 7, edits },
      { replaces: 'notes.txt', file_name: 'notes.md', content: 'v2' },
      { edits },
      { replaces: 'plan.md', edits: [] },
      { replaces: 'plan.md', edits: [{ old_string: 'a' }] },
      { replaces: 'plan.md', edits: [{ old_string: 'a', new_string: 'x'.repeat(512 * 1024 + 1) }] },
      { replaces: 'plan.md', edits, content: 'both' },
    ]) assert.equal(decide(args), 'ask', JSON.stringify(args));
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
