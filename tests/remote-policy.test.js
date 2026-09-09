'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const policy = require('../services/remote/remote-policy');

function chatSession(overrides = {}) {
  return {
    id: 'session_1',
    session_type: 'chat',
    lockdown: false,
    archived_at: null,
    ...overrides,
  };
}

test('list policy excludes lockdown, non-chat, and archived sessions', () => {
  const lockdownFlags = { session_offline_lockdown: true };
  assert.equal(policy.canListSession(chatSession({ lockdown: true }), lockdownFlags), false);
  assert.equal(policy.canListSession(chatSession({ session_type: 'plugin' }), {}), false);
  assert.equal(policy.canListSession(chatSession({ session_type: 'image' }), {}), false);
  assert.equal(policy.canListSession(chatSession({ archived_at: '2026-09-05T00:00:00Z' }), {}), false);
  assert.equal(policy.canListSession(chatSession(), {}), true);
});

test('read and send authority bind the grant, lease, session, and device', () => {
  const session = chatSession();
  const grant = { session_id: 'session_1' };
  const lease = { session_id: 'session_1', device_id: 'device_1' };
  assert.equal(policy.canReadSession(session, {}, grant), true);
  assert.equal(policy.canReadSession(session, {}, { session_id: 'session_2' }), false);
  assert.equal(policy.canReadSession(session, {}, null), false);
  assert.equal(policy.canSend(session, {}, lease, 'device_1'), true);
  assert.equal(policy.canSend(session, {}, { ...lease, session_id: 'session_2' }, 'device_1'), false);
  assert.equal(policy.canSend(session, {}, lease, 'device_2'), false);
  assert.equal(policy.canSend(chatSession({ lockdown: true }), {
    session_offline_lockdown: true,
  }, lease, 'device_1'), false);
});

test('decision classification needs affirmative one-off authority and complete facts', () => {
  const safe = { toolName: 'read_file', factsComplete: true, authority: 'one_off' };
  assert.equal(policy.classifyDecision(safe), 'phone_ok');
  // Consequence/scope text is presentation, not authority.
  assert.equal(policy.classifyDecision({
    ...safe, policyConsequence: 'May read data in this scope.', policyScope: 'workspace',
  }), 'phone_ok');
  const desktopOnlyCases = [
    null,
    [],
    {},
    { toolName: '   ', factsComplete: true, authority: 'one_off' },
    { toolName: 'read_file' },
    { ...safe, factsComplete: false },
    { ...safe, factsComplete: 'true' },
    { ...safe, authority: 'desktop_only' },
    { ...safe, authority: 'always_allow' },
    { ...safe, authority: undefined },
  ];
  for (const pending of desktopOnlyCases) {
    assert.equal(policy.classifyDecision(pending), 'desktop_only');
  }
});

test('decision option table exposes only the phone-authorized choices', () => {
  assert.deepEqual(policy.allowedDecisionOptions('tool'), ['approve_once', 'deny']);
  assert.deepEqual(policy.allowedDecisionOptions('question'), ['answer', 'decline']);
  assert.deepEqual(policy.allowedDecisionOptions('plan'), ['approve', 'revise']);
  assert.deepEqual(policy.allowedDecisionOptions('unknown'), []);
  assert.equal(Object.isFrozen(policy.allowedDecisionOptions('tool')), true);
});

test('forbidden backend options are frozen and stripped without losing safe fields', () => {
  const source = { safe: 'preserved' };
  for (const key of policy.FORBIDDEN_BACKEND_OPTIONS) source[key] = `blocked:${key}`;
  const result = policy.stripForbiddenBackendOptions(source);

  assert.equal(Object.isFrozen(policy.FORBIDDEN_BACKEND_OPTIONS), true);
  assert.equal(policy.FORBIDDEN_BACKEND_OPTIONS.length, 14);
  assert.deepEqual(result, { safe: 'preserved' });
  assert.equal(source.alwaysAllow, 'blocked:alwaysAllow');
  for (const key of policy.FORBIDDEN_BACKEND_OPTIONS) {
    assert.equal(Object.hasOwn(result, key), false, `${key} should be stripped`);
  }
});

test('tool authority is one-off only for manifest builtins outside desktop-only classes', () => {
  assert.deepEqual([...policy.DESKTOP_ONLY_TOOLS], [
    'delete_file', 'move_file', 'run_command', 'run_temp_script', 'python_execute',
    'worktree_delete',
  ]);
  for (const toolName of policy.DESKTOP_ONLY_TOOLS) {
    assert.equal(policy.authorityForTool(toolName), 'desktop_only', toolName);
  }
  assert.equal(policy.authorityForTool('read_file'), 'one_off');
  assert.equal(policy.authorityForTool('exit_plan_mode'), 'one_off');
  assert.equal(policy.authorityForTool('plugin_custom_tool'), 'desktop_only');
  assert.equal(policy.authorityForTool('mcp.server/tool'), 'desktop_only');
  assert.equal(policy.authorityForTool(''), 'desktop_only');
  assert.equal(policy.authorityForTool(null), 'desktop_only');
  assert.equal(Object.isFrozen(policy.PHONE_ONE_OFF_TOOLS), true);
  for (const toolName of policy.DESKTOP_ONLY_TOOLS) {
    assert.equal(policy.PHONE_ONE_OFF_TOOLS.includes(toolName), false, toolName);
  }
  assert.equal(policy.PHONE_ONE_OFF_TOOLS.includes('read_file'), true);
});
