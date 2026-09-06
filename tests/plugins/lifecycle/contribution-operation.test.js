'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { deriveContributionStates } = require('../../../services/plugins/lifecycle/contribution-operation');

function contribution(contributionId, kind, desiredEnabled = true) {
  return {
    contribution_id: contributionId,
    kind,
    content_digest: 'a'.repeat(64),
    desired_enabled: desiredEnabled,
    effective_enabled: false,
    blocked_reason: 'master_disabled',
    settings_ref: { kind: 'absent' },
  };
}

test('derived contribution state preserves desire across dependency toggles', () => {
  const entry = {
    effective_state: 'active',
    contributions: [
      contribution('prompt-main', 'prompt', false),
      contribution('workflow-main', 'workflow'),
      contribution('command-main', 'command'),
    ],
  };
  const dependencies = new Map([
    ['workflow-main', ['prompt-main']],
    ['command-main', ['workflow-main']],
  ]);

  const blocked = deriveContributionStates(entry, dependencies);
  assert.deepEqual(blocked.map((item) => [
    item.contribution_id, item.desired_enabled, item.effective_enabled, item.blocked_reason,
  ]), [
    ['prompt-main', false, false, 'none'],
    ['workflow-main', true, false, 'dependency_disabled'],
    ['command-main', true, false, 'dependency_disabled'],
  ]);

  blocked[0].desired_enabled = true;
  const restored = deriveContributionStates({ ...entry, contributions: blocked }, dependencies);
  assert.equal(restored.every((item) => item.effective_enabled), true);
});

test('master disable retains desired state for Stage 5 MCP descriptors', () => {
  const disabled = deriveContributionStates({
    effective_state: 'installed_disabled',
    contributions: [contribution('theme-main', 'theme'), contribution('mcp-main', 'mcp_descriptor')],
  });
  assert.deepEqual(disabled.map((item) => [item.effective_enabled, item.blocked_reason]), [
    [false, 'master_disabled'], [false, 'master_disabled'],
  ]);
  assert.equal(disabled.every((item) => item.desired_enabled), true);
});
