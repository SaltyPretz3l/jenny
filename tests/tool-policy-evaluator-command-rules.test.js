'use strict';

// Row 103: the Electron evaluator (runtime.operation admission, the command
// bridge, the tool executor) applies command_prefix / command_exact rules
// with the same semantics as sidecar/ai/tools/policy.py.

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluatePolicy, normalizePolicySnapshot } = require('../services/tools/tool-policy-evaluator');

const RUN_COMMAND = Object.freeze({ name: 'run_command', side_effecting: true, read_only: false, tool_family: 'shell', source_kind: 'builtin' });
const MONITOR = Object.freeze({ name: 'monitor', side_effecting: true, read_only: false, tool_family: 'shell', source_kind: 'builtin' });

function snapshotWith(...rules) {
  return { version: 3, legacy_policies: {}, rules };
}

function decide(descriptor, command, snapshot) {
  return evaluatePolicy({ descriptor, args: { command }, mode: 'assist', snapshot });
}

test('a command_prefix auto rule covers the prefix with any arguments only', () => {
  const snapshot = snapshotWith({ id: 'grant:npm-test', decision: 'auto', match: { tool_id: 'run_command', command_prefix: 'npm test' } });
  assert.equal(decide(RUN_COMMAND, 'npm test', snapshot).decision, 'auto');
  assert.equal(decide(RUN_COMMAND, 'npm test -- --watch', snapshot).matched_rule_id, 'grant:npm-test');
  assert.equal(decide(RUN_COMMAND, 'npm testx', snapshot).decision, 'ask');
  assert.equal(decide(RUN_COMMAND, 'npm run build', snapshot).decision, 'ask');
  assert.equal(decide(RUN_COMMAND, 'npm test && echo x', snapshot).decision, 'ask');
  assert.equal(decide(RUN_COMMAND, 'npm test\nrm -rf x', snapshot).decision, 'ask');
  assert.equal(evaluatePolicy({ descriptor: RUN_COMMAND, args: {}, snapshot }).decision, 'ask');
});

test('a command_exact rule matches only the identical trimmed text', () => {
  const snapshot = snapshotWith({ id: 'grant:build-py', decision: 'auto', match: { tool_id: 'run_command', command_exact: 'python build.py' } });
  assert.equal(decide(RUN_COMMAND, ' python build.py ', snapshot).decision, 'auto');
  assert.equal(decide(RUN_COMMAND, 'python build.py --fast', snapshot).decision, 'ask');
  assert.equal(decide(RUN_COMMAND, 'python  build.py', snapshot).decision, 'ask');
});

test('command rules never match a tool other than run_command', () => {
  const snapshot = snapshotWith({ id: 'grant:npm-test', decision: 'auto', match: { tool_id: 'run_command', command_prefix: 'npm test' } });
  assert.equal(decide(MONITOR, 'npm test', snapshot).matched_rule_id, null);
});

test('a command deny rule outranks a broader auto rule', () => {
  const snapshot = snapshotWith(
    { id: 'shell-auto', decision: 'auto', match: { tool_id: 'run_command' } },
    { id: 'no-push', decision: 'deny', match: { tool_id: 'run_command', command_prefix: 'git push' } },
  );
  assert.equal(decide(RUN_COMMAND, 'git push --force', snapshot).decision, 'deny');
  assert.equal(decide(RUN_COMMAND, 'git pull', snapshot).decision, 'auto');
});

test('malformed command rules are dropped, never widened to the whole tool', () => {
  const normalized = normalizePolicySnapshot(snapshotWith(
    { id: 'both', decision: 'auto', match: { tool_id: 'run_command', command_prefix: 'npm test', command_exact: 'npm test' } },
    { id: 'wide', decision: 'auto', match: { tool_id: 'run_command', command_prefix: 'npm test -x' } },
    { id: 'wrapper', decision: 'auto', match: { tool_id: 'run_command', command_prefix: 'bash -c' } },
    { id: 'chained', decision: 'auto', match: { tool_id: 'run_command', command_exact: 'a && b' } },
    { id: 'number', decision: 'auto', match: { tool_id: 'run_command', command_prefix: 7 } },
    { id: 'other-tool', decision: 'auto', match: { tool_id: 'write_file', command_prefix: 'npm test' } },
    { id: 'no-tool', decision: 'auto', match: { command_prefix: 'npm test' } },
    { id: 'kept', decision: 'auto', match: { tool_id: 'run_command', command_prefix: 'npm test' } },
  ));
  assert.deepEqual(normalized.rules.map((rule) => rule.id), ['kept']);
  assert.equal(normalized.rules[0].match.command_prefix, 'npm test');
  assert.equal(Object.hasOwn(normalizePolicySnapshot(snapshotWith(
    { id: 'plain', decision: 'deny', match: { tool_id: 'write_file' } }
  )).rules[0].match, 'command_prefix'), false);
});
