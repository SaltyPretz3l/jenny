'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setSessionPreferences } = require('../services/backend/backend-sessions');
const { denyToolCall } = require('../services/backend/backend-chat-stream');
const { buildSessionPreferencesPatch } = require('../services/backend/session-preferences-patch');
const { normalizeManagedToolPreferences } = require('../services/backend/backend-service-utils');

function createHarness({ active = true } = {}) {
  let stored = { run_mode: 'ask', plan_mode: false,
    tool_category_overrides: {}, tool_connection_overrides: {} };
  const pushed = [];
  const denied = [];
  const logs = [];
  const modes = [];
  const catalog = {
    read_file: { tool_family: 'filesystem' },
    write_file: { tool_family: 'filesystem' },
    web_search: { tool_family: 'web' },
    remote_tool: { source_kind: 'mcp', server_name: 'remote' },
    jenny_status: { tool_family: 'filesystem' },
  };
  const service = {
    sessionStore: {
      getSession: () => stored,
      setSessionPreferences: (_id, patch) => {
        stored = { ...stored, ...buildSessionPreferencesPatch(patch, stored) };
        return stored;
      },
      getActiveTurn: () => ({ stream_id: 'stream-alpha' }),
    },
    activeStreams: new Map(active ? [['stream-alpha', {}]] : []),
    currentStatus: { tools_status: catalog },
    sessionExecutionAuthority: {
      disableToolsForSession: (sessionId, names) => { pushed.push({ sessionId, names }); return 1; },
    },
    pendingToolApprovals: new Map(),
    denyToolCall: ref => denyToolCall(service, ref),
    sidecarClient: { notifySessionRunModeUpdated: value => modes.push(value) },
    _emitServiceLog: (level, event, fields) => logs.push({ level, event, fields }),
  };
  for (const [ref, sessionId, toolName] of [
    ['files-alpha', 'session-alpha', 'read_file'],
    ['files-write', 'session-alpha', 'write_file'],
    ['web-alpha', 'session-alpha', 'web_search'],
    ['remote-alpha', 'session-alpha', 'remote_tool'],
    ['status-alpha', 'session-alpha', 'jenny_status'],
    ['files-other', 'session-other', 'read_file'],
  ]) {
    service.pendingToolApprovals.set(ref, { sessionId, toolName,
      callId: 'shared-call-id', requireExactRef: true,
      resolve: (...args) => denied.push({ ref, args }) });
  }
  return { service, pushed, denied, logs, modes, catalog };
}

test('switching a family off pushes the request resolver deny-list and settles only matching approvals', async () => {
  const h = createHarness();
  const families = { files: false };
  const names = normalizeManagedToolPreferences({ families, connections: {} },
    { catalog: h.catalog }).disabled_tools;
  assert.ok(names.includes('read_file'));
  assert.ok(names.includes('create_artifact'), 'existing files/artifacts compatibility applies');
  await setSessionPreferences(h.service, 'session-alpha', { tool_category_overrides: families });
  assert.deepEqual(h.pushed, [{ sessionId: 'session-alpha', names }]);
  assert.deepEqual(h.denied, [
    { ref: 'files-alpha', args: [false, 'denied'] },
    { ref: 'files-write', args: [false, 'denied'] },
  ]);
  assert.deepEqual([...h.service.pendingToolApprovals.keys()],
    ['web-alpha', 'remote-alpha', 'status-alpha', 'files-other']);
  assert.deepEqual(h.logs, [{ level: 'INFO', event: 'session.tool_preferences_pushed',
    fields: { sessionId: 'session-alpha', streamId: 'stream-alpha',
      newlyDeniedToolCount: names.length, pendingApprovalsDenied: 2 } }]);
  assert.deepEqual(h.modes, []);
  await setSessionPreferences(h.service, 'session-alpha', { tool_category_overrides: { files: false } });
  assert.equal(h.pushed.length, 1, 'equal stored maps do not push again');
  await setSessionPreferences(h.service, 'session-alpha', { tool_category_overrides: { files: true } });
  assert.deepEqual(h.pushed[1], { sessionId: 'session-alpha', names: [] });
  assert.equal(h.logs[1].fields.newlyDeniedToolCount, 0);
});

test('connection overrides use the catalog connection resolver', async () => {
  const h = createHarness();
  await setSessionPreferences(h.service, 'session-alpha', {
    tool_connection_overrides: { 'mcp:remote': false },
  });
  assert.deepEqual(h.pushed, [{ sessionId: 'session-alpha', names: ['remote_tool'] }]);
  assert.deepEqual(h.denied, [{ ref: 'remote-alpha', args: [false, 'denied'] }]);
});

test('inactive streams and unrelated preferences never push tool preferences', async () => {
  const inactive = createHarness({ active: false });
  await setSessionPreferences(inactive.service, 'session-alpha', { tool_category_overrides: { files: false } });
  assert.deepEqual(inactive.pushed, []);
  assert.deepEqual(inactive.denied, []);
  assert.deepEqual(inactive.logs, []);
  const h = createHarness();
  await setSessionPreferences(h.service, 'session-alpha', { run_mode: 'auto' });
  assert.deepEqual(h.pushed, []);
  assert.deepEqual(h.denied, []);
  assert.deepEqual(h.modes, [{ sessionId: 'session-alpha', approvalMode: 'auto_run', readOnly: false }]);
  await setSessionPreferences(h.service, 'session-alpha', { preferred_model: 'fixture' });
  assert.deepEqual(h.pushed, []);
});

test('a missing authority skips the live push while persisting switches', async () => {
  const h = createHarness();
  delete h.service.sessionExecutionAuthority;
  await setSessionPreferences(h.service, 'session-alpha', { tool_category_overrides: { files: false } });
  assert.deepEqual(h.service.sessionStore.getSession().tool_category_overrides, { files: false });
  assert.deepEqual(h.pushed, []);
  assert.deepEqual(h.denied, []);
  assert.deepEqual(h.logs, []);
});

test('a missing tool catalog still pushes the manifest tools of the switched-off family', async () => {
  const h = createHarness();
  delete h.service.currentStatus;
  await setSessionPreferences(h.service, 'session-alpha', { tool_category_overrides: { files: false } });
  assert.equal(h.pushed.length, 1);
  assert.deepEqual(h.pushed[0].names,
    normalizeManagedToolPreferences({ families: { files: false } }).disabled_tools);
  assert.ok(h.pushed[0].names.includes('read_file'));
  assert.deepEqual(h.denied.map(entry => entry.ref).sort(), ['files-alpha', 'files-write']);
});
