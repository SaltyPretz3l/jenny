'use strict';

// Row 103: the backend tells a run_command card what "Always allow" covers
// (derived with services/tools/command-prefix.js), withholds it for chained
// commands, records the saved prefix on the resolution, and logs the grant.

const test = require('node:test');
const assert = require('node:assert/strict');

const { waitForToolApproval } = require('../services/backend/chat-stream-tool-handling');
const { getManagedActiveTurnState } = require('../services/backend/backend-active-turn-state');
const { approveToolCall } = require('../services/backend/backend-chat-stream');

function createService() {
  const messages = [];
  const emitted = [];
  return {
    messages,
    emitted,
    sessionStore: {
      getSessionMessages() { return messages; },
      appendMessage(_sessionId, message) { messages.push(message); },
      updateMessage(_sessionId, messageId, patch) {
        const index = messages.findIndex((message) => message.id === messageId);
        if (index !== -1) messages[index] = { ...messages[index], ...patch };
      },
    },
    emit(_event, payload) { emitted.push(payload); },
    pendingToolApprovals: new Map(),
    currentModel: 'test-model',
  };
}

function requestApproval(service, callId, params) {
  const turnEvents = [];
  const promise = waitForToolApproval(
    service, `stream-${callId}`, `session-${callId}`, `req-${callId}`,
    { tool_call_id: callId, ...params },
    new AbortController(),
    { noteEvent(event) { turnEvents.push(event); return event; } },
    { binding_id: `binding-${callId}` }
  );
  return { promise, turnEvents };
}

function pendingFor(service, callId) {
  return [...service.pendingToolApprovals.values()].find((entry) => entry.callId === callId);
}

test('a prefix-scoped command card carries its Always allow scope live and on reopen', async () => {
  const service = createService();
  service.activeStreams = new Map([['stream-call-prefix', new AbortController()]]);
  service.sessionStore.getActiveTurn = () => ({ request_id: 'stream-call-prefix', stream_id: 'stream-call-prefix', status: 'streaming' });
  const { promise, turnEvents } = requestApproval(service, 'call-prefix', {
    tool_name: 'run_command', tool_input: { command: 'npm test -- --watch', cwd: '.' },
  });

  const needed = service.emitted.find((event) => event.type === 'tool_approval_needed');
  assert.deepEqual(needed.alwaysAllowScope, { kind: 'prefix', prefix: 'npm test' });
  assert.equal(needed.oneOffOnly, undefined);
  assert.deepEqual(pendingFor(service, 'call-prefix').alwaysAllowScope, { kind: 'prefix', prefix: 'npm test' });
  const snapshot = getManagedActiveTurnState(service, 'session-call-prefix');
  assert.deepEqual(snapshot.pending_approval.always_allow_scope, { kind: 'prefix', prefix: 'npm test' });

  pendingFor(service, 'call-prefix').resolve(true, 'approved', '', undefined, 'always');
  assert.equal(await promise, true);
  const resolvedUse = service.emitted.find((event) => event.type === 'tool_use' && event.status === 'approved');
  assert.equal(resolvedUse.approvalScope, 'always');
  assert.equal(resolvedUse.alwaysAllowPrefix, 'npm test');
  const resolution = turnEvents.find((event) => event.type === 'tool_approval_resolved');
  assert.equal(resolution.payload.approval_scope, 'always');
  assert.equal(resolution.payload.always_allow_prefix, 'npm test');
});

test('an Allow once resolution records no prefix', async () => {
  const service = createService();
  const { promise, turnEvents } = requestApproval(service, 'call-once', {
    tool_name: 'run_command', tool_input: { command: 'npm test' },
  });
  pendingFor(service, 'call-once').resolve(true, 'approved', '', undefined, 'once');
  assert.equal(await promise, true);
  const resolution = turnEvents.find((event) => event.type === 'tool_approval_resolved');
  assert.equal(resolution.payload.always_allow_prefix, undefined);
});

test('an exact-scoped command card says exact', async () => {
  const service = createService();
  const { promise } = requestApproval(service, 'call-exact', {
    tool_name: 'run_command', tool_input: { command: 'python build.py' },
  });
  assert.deepEqual(service.emitted.find((event) => event.type === 'tool_approval_needed').alwaysAllowScope, { kind: 'exact' });
  pendingFor(service, 'call-exact').resolve(false, 'denied');
  assert.equal(await promise, false);
});

test('a chained command is one-off only and its card says why', async () => {
  const service = createService();
  const { promise, turnEvents } = requestApproval(service, 'call-chain', {
    tool_name: 'run_command', tool_input: { command: 'npm test && npm run build > build.log' },
  });
  const needed = service.emitted.find((event) => event.type === 'tool_approval_needed');
  assert.equal(needed.oneOffOnly, true);
  assert.deepEqual(needed.alwaysAllowScope, { kind: 'none' });
  assert.equal(pendingFor(service, 'call-chain').oneOffOnly, true);
  const requested = turnEvents.find((event) => event.type === 'tool_approval_requested');
  assert.equal(requested.payload.one_off_only, true);
  assert.equal(service.messages[0].tool_call.one_off_only, true);
  pendingFor(service, 'call-chain').resolve(false, 'denied');
  assert.equal(await promise, false);
});

test('other tools carry no command scope', async () => {
  const service = createService();
  const { promise } = requestApproval(service, 'call-write', {
    tool_name: 'write_file', tool_input: { path: 'notes.md', content: 'x' },
  });
  const needed = service.emitted.find((event) => event.type === 'tool_approval_needed');
  assert.equal(needed.alwaysAllowScope, undefined);
  assert.equal(needed.oneOffOnly, undefined);
  pendingFor(service, 'call-write').resolve(false, 'denied');
  assert.equal(await promise, false);
});

test('approving Always allow on a command logs the scoped command grant', () => {
  const logs = [];
  const resolutions = [];
  const service = {
    toolPermissionStore: {
      grantAlwaysAllow(toolName, input) {
        assert.equal(toolName, 'run_command');
        assert.deepEqual(input, { command: 'npm test -- --ci' });
        return { scope: 'command_prefix', commandPrefix: 'npm test', ruleId: 'grant:abc' };
      },
    },
    pendingToolApprovals: new Map([['approval-cmd', {
      approvalId: 'approval-cmd', callId: 'call-cmd', toolName: 'run_command',
      toolInput: { command: 'npm test -- --ci' }, resolve(...args) { resolutions.push(args); },
    }]]),
    _emitServiceLog(level, event, fields) { logs.push({ level, event, fields }); },
  };
  assert.equal(approveToolCall(service, 'approval-cmd', { alwaysAllow: true }), true);
  assert.deepEqual(resolutions, [[true, 'approved', '', undefined, 'always']]);
  assert.deepEqual(logs, [{ level: 'INFO', event: 'tool_permission.always_allow_scoped',
    fields: { toolName: 'run_command', commandPrefix: 'npm test', ruleId: 'grant:abc' } }]);
});

test('a refused command grant resolves the approval once', () => {
  const resolutions = [];
  const service = {
    toolPermissionStore: {
      grantAlwaysAllow() {
        const error = new Error('Chained commands can only be allowed once.');
        error.code = 'permission_command_unscoped';
        throw error;
      },
    },
    pendingToolApprovals: new Map([['approval-chain', {
      approvalId: 'approval-chain', callId: 'call-chain', toolName: 'run_command',
      toolInput: { command: 'a && b' }, resolve(...args) { resolutions.push(args); },
    }]]),
    _emitServiceLog() {},
  };
  assert.equal(approveToolCall(service, 'approval-chain', { alwaysAllow: true }), true);
  assert.deepEqual(resolutions, [[true, 'approved', '', undefined, 'once']]);
});
