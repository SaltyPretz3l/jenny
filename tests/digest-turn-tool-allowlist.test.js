'use strict';

/* Row 86: a "While you were away" digest turn is offered, and may call, only the digest's read tools. The offer is
 * narrowed by managedToolPreferenceInput (direct path) and executionOptionsFor (session-runtime path); the
 * execution authority refuses any other tool at call time and treats the turn as read-only. */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  APPLICATION_TURN_DIGEST, DIGEST_NO_TOOLS_MARKER, DIGEST_TURN_TOOLS, narrowDigestToolPreferences, normalizeRequestApplicationTurn,
} = require('../services/backend/application-turns');
const { managedToolPreferenceInput } = require('../services/backend/managed-sidecar-chat-helpers');
const { executionOptionsFor } = require('../services/backend/session-runtime-chat-operations');
const { SessionExecutionAuthority, getTrustedExecutionBinding } = require('../services/backend/session-execution-authority');

const ROOT = Object.freeze({
  project_id: 'project_alpha', root_path: 'G:\\projects\\alpha', root_id: 'root-alpha', root_revision: 3, device_id: '7', inode: '11',
});
const REVISION = '8f04ce56-3fd5-4f3f-907c-3a0a6ea83580';

function operation(toolName, args = {}) {
  return {
    api_version: '2026-10-15', schema_version: 1, request_id: 'request-alpha', session_id: 'session-alpha',
    authority_revision: REVISION, operation_id: `call-${toolName}`, phase: 'check', tool_name: toolName, arguments: args,
  };
}

function authority() {
  return new SessionExecutionAuthority({
    projectAuthority: { captureSession: () => ROOT, requireCurrent: () => ROOT },
    permissionStore: { getSnapshot: () => ({ version: 3,
      legacy_policies: { read_file: 'auto', sessions_list: 'auto', jenny_help: 'auto' }, rules: [] }) },
    knowledgeService: { getSidecarConfig: () => ({ knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: () => ({}),
    randomUUID: () => REVISION,
  });
}

test('digest is a request application turn and its allowlist is never empty', () => {
  assert.equal(normalizeRequestApplicationTurn(APPLICATION_TURN_DIGEST), 'digest');
  assert.deepEqual(narrowDigestToolPreferences({ disabled_tools: ['jenny_help'], enabled_tools: ['run_command'] }), {
    disabled_tools: ['jenny_help'], enabled_tools: DIGEST_TURN_TOOLS.filter((name) => name !== 'jenny_help'),
  });
  assert.deepEqual(narrowDigestToolPreferences({ disabled_tools: [...DIGEST_TURN_TOOLS] }).enabled_tools, [DIGEST_NO_TOOLS_MARKER]);
  assert.deepEqual(narrowDigestToolPreferences(null).enabled_tools, [...DIGEST_TURN_TOOLS]);
});

test('managedToolPreferenceInput narrows only a digest turn', () => {
  const ordinary = managedToolPreferenceInput({ disabled_tools: ['write_file'] }, {});
  assert.equal(ordinary.enabled_tools, undefined);
  const digest = managedToolPreferenceInput({ disabled_tools: ['write_file'] }, { applicationTurn: 'digest' });
  assert.deepEqual(digest.enabled_tools, [...DIGEST_TURN_TOOLS]);
  assert.ok(digest.disabled_tools.includes('write_file'));
  assert.equal(managedToolPreferenceInput({}, { applicationTurn: 'scheduled_check' })?.enabled_tools, undefined);
});

test('executionOptionsFor: a digest turn is read-only and narrowed; other turns are unchanged', () => {
  const plain = executionOptionsFor({ toolPreferences: { disabled_tools: [] }, approvalMode: 'prompt' }, null);
  assert.equal(plain.readOnly, false);
  assert.deepEqual(plain.toolPreferences, { disabled_tools: [] });
  const digest = executionOptionsFor({ applicationTurn: 'digest', toolPreferences: { disabled_tools: [] }, approvalMode: 'prompt' }, null);
  assert.equal(digest.readOnly, true);
  assert.deepEqual(digest.toolPreferences.enabled_tools, [...DIGEST_TURN_TOOLS]);
});

test('the execution authority refuses a tool outside a request allowlist at call time', () => {
  const auth = authority();
  const options = executionOptionsFor({ applicationTurn: 'digest', toolPreferences: {}, approvalMode: 'prompt' }, null);
  const binding = auth.captureSession('session-alpha', { requestId: 'request-alpha', ...options });
  assert.equal(getTrustedExecutionBinding(binding).readOnly, true);
  const denied = auth.checkRuntimeOperation(binding, operation('read_file', { path: 'README.md' }));
  assert.equal(denied.status, 'rejected');
  assert.equal(denied.error.reason, 'tool_disabled');
  assert.equal(auth.checkRuntimeOperation(binding, operation('jenny_help', { action: 'search', query: 'digest' })).status, 'granted');
  // Without an allowlist the same tool is granted, so the refusal above is the allowlist's.
  const open = auth.captureSession('session-alpha', { requestId: 'request-alpha', toolPreferences: {} });
  assert.equal(auth.checkRuntimeOperation(open, operation('read_file', { path: 'README.md' })).status, 'granted');
});
