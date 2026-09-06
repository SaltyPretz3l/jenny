// Red-first: W6 adversarial-review findings F3 + F5 (Electron policy seam).
//
// F3: `normalizeRuleList` rebuilt each rule's match object from a fixed field
// list that omitted `action`, so a persisted action-scoped rule silently
// widened tool-wide after any ToolPermissionStore round trip — the exact
// widening class the Python normalizer now rejects. The Electron seam is the
// REAL producer of persisted rules, so it must preserve valid action matchers,
// reject rules whose action matcher is present but malformed, and match the
// raw call argument the same way the Python `_rule_matches` does.
//
// F5: `tool:action` composite keys are only injective while tool names stay
// colon-free — the manifest grammar pin below turns any future colon-named
// tool into a loud failure instead of a silent grant collision.
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  evaluatePolicy,
  normalizePolicySnapshot,
} = require('../services/tools/tool-policy-evaluator.js');
const manifest = require('../services/tools/tool-manifest.json');

function snapshotWith(actionMatcher) {
  return {
    version: 3,
    legacy_policies: {},
    rules: [
      {
        id: 'rule-worktree-action',
        decision: 'auto',
        reason: 'scoped grant',
        match: { tool_id: 'worktree', action: actionMatcher },
      },
    ],
  };
}

const descriptor = {
  name: 'worktree',
  tool_family: 'workspace',
  source_kind: 'builtin',
  side_effecting: true,
  read_only: false,
};

test('normalization preserves a valid action matcher', () => {
  const normalized = normalizePolicySnapshot(snapshotWith('list'));
  assert.equal(normalized.rules.length, 1);
  assert.equal(normalized.rules[0].match.action, 'list');
});

test('a present-but-invalid action matcher drops the whole rule', () => {
  // A malformed matcher must never silently widen an action-scoped rule into
  // a tool-wide one (mirrors the Python normalizer).
  assert.equal(normalizePolicySnapshot(snapshotWith(7)).rules.length, 0);
  assert.equal(normalizePolicySnapshot(snapshotWith('')).rules.length, 0);
  assert.equal(normalizePolicySnapshot(snapshotWith('   ')).rules.length, 0);
});

test('an action-scoped rule matches only its own action argument', () => {
  const snapshot = snapshotWith('list');
  const hit = evaluatePolicy({
    descriptor,
    args: { action: 'list' },
    mode: 'agent',
    snapshot,
  });
  assert.equal(hit.decision, 'auto');
  assert.equal(hit.matched_rule_id, 'rule-worktree-action');

  const miss = evaluatePolicy({
    descriptor,
    args: { action: 'delete' },
    mode: 'agent',
    snapshot,
  });
  assert.notEqual(miss.matched_rule_id, 'rule-worktree-action');
  assert.notEqual(miss.decision, 'auto');
});

test('manifest tool names stay composite-key safe (no colons, bounded grammar)', () => {
  const bad = manifest.tools
    .map((tool) => String(tool.name || ''))
    .filter((name) => !/^[a-z0-9_]{1,64}$/.test(name));
  assert.deepEqual(
    bad,
    [],
    'tool names must stay colon-free lowercase identifiers — `tool:action` ' +
      'composite permission keys are only injective under this grammar'
  );
});
