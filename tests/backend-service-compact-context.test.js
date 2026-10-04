'use strict';

/**
 * Coverage for BackendService#compactContextNow (Compaction Tunability +
 * Manual Compact): delegates to backend-chat-stream.js's
 * compactContextNow(service, sessionId). The guards mirror getActiveTurnState
 * (see tests/backend-service-dark-paths.test.js), plus the message-mapping +
 * snapshot-persistence step (JCA-003) this file covers in isolation to keep
 * both files under the file-size ceiling. End-to-end "next chat.send uses the
 * snapshot" coverage lives in tests/backend-service-compact-snapshot.test.js.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { BackendService } = require('../services/backend/backend-service');
const { buildCompactPayload } = require('../services/backend/backend-compact-payload');
const { createFakeSafeStorage } = require('./helpers/fake-safe-storage');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function createMinimalService(overrides = {}) {
  const userDataPath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jenny-bs-compact-')
  );
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    safeStorage: createFakeSafeStorage(),
    ...overrides,
  });
  return { service, userDataPath };
}

test('compactContextNow returns sidecar_unavailable when not in managed sidecar mode', async () => {
  const { service } = createMinimalService();

  const result = await service.compactContextNow('sess-sample');

  assert.deepEqual(result, { status: 'error', reason: 'sidecar_unavailable' });
  service.dispose();
});

test('compactContextNow returns sidecar_unavailable when sidecarClient is null', async () => {
  const { service } = createMinimalService();
  service.sidecarClient = null;
  service.sidecarManager.getStatus = () => ({ phase: 'ready' });

  const result = await service.compactContextNow('sess-sample');

  assert.deepEqual(result, { status: 'error', reason: 'sidecar_unavailable' });
  service.dispose();
});

test('compactContextNow returns sidecar_unavailable when sidecar phase is not ready', async () => {
  const { service } = createMinimalService();
  service.sidecarClient = {
    chatCompact: async () => ({ status: 'ok', compacted: true }),
    dispose: () => {},
    off: () => {},
  };
  service.sidecarManager.getStatus = () => ({ phase: 'starting' });

  const result = await service.compactContextNow('sess-sample');

  assert.deepEqual(result, { status: 'error', reason: 'sidecar_unavailable' });
  service.sidecarClient = null;
  service.dispose();
});

test('compactContextNow maps plain canonical messages to exact {role, content} rows and persists the returned snapshot (JCA-003)', async () => {
  const { service } = createMinimalService();
  const calls = [];
  const fakeResult = {
    status: 'ok',
    compacted: true,
    strategy: 'full',
    tokens_before: 4000,
    tokens_after: 1100,
    // The sidecar's shape: the summary, then the latest round copied verbatim.
    messages: [
      { role: 'system', content: '## Compacted Conversation Summary\nHello was exchanged.' },
      { role: 'assistant', content: 'hi there' },
    ],
  };

  service.sidecarManager.getStatus = () => ({ phase: 'ready' });
  service.sidecarClient = {
    chatCompact: async (sessionId, messages) => {
      calls.push({ sessionId, messages });
      return fakeResult;
    },
    dispose: () => {},
    off: () => {},
  };
  service.sessionStore.createSessionWithId('sess-map', { title: 'Map' });
  service.sessionStore.appendMessage('sess-map', {
    id: 'm1', role: 'user', content: 'hello', attachments: [{ id: 'a1' }], timestamp: '2026-01-01T00:00:00.000Z',
  });
  service.sessionStore.appendMessage('sess-map', {
    id: 'm2', role: 'assistant', content: 'hi there', attachments: [],
  });

  const result = await service.compactContextNow('sess-map');

  assert.equal(calls.length, 1, 'chatCompact must be called once');
  assert.equal(calls[0].sessionId, 'sess-map', 'sessionId must be forwarded as-is');
  assert.deepEqual(
    calls[0].messages,
    [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ],
    'messages must be mapped to plain {role, content}, dropping ids/attachments/timestamps'
  );
  assert.deepEqual(
    calls[0].messages.map((message) => Object.keys(message).sort()),
    [['content', 'role'], ['content', 'role']],
    'plain messages must not leak extra canonical-store fields'
  );
  // The (large) compacted messages stay in the store, off the IPC payload; the
  // renderer sees the outcome plus whether future turns will use the snapshot.
  assert.deepEqual(result, {
    status: 'ok',
    compacted: true,
    strategy: 'full',
    tokens_before: 4000,
    tokens_after: 1100,
    snapshot_persisted: true,
  });
  const session = service.sessionStore.getSession('sess-map');
  assert.ok(session.compaction_snapshot, 'a successful compaction must persist a session-owned snapshot');
  // The copied tail stays canonical: the snapshot covers only what precedes it.
  assert.equal(session.compaction_snapshot.boundary_message_id, 'm1');
  assert.equal(session.compaction_snapshot.boundary_message_count, 1);
  assert.deepEqual(session.compaction_snapshot.messages, fakeResult.messages.slice(0, 1));
  service.sidecarClient = null;
  service.dispose();
});

test('compactContextNow carries chat.send-shaped tool identity without leaking canonical-store fields', async () => {
  assert.equal(typeof buildCompactPayload, 'function');
  const { service } = createMinimalService();
  const calls = [];

  service.sidecarManager.getStatus = () => ({ phase: 'ready' });
  service.sidecarClient = {
    chatCompact: async (sessionId, messages) => {
      calls.push({ sessionId, messages });
      return { status: 'ok', compacted: false };
    },
    dispose: () => {},
    off: () => {},
  };
  service.sessionStore.createSessionWithId('sess-tools', { title: 'Tools' });
  service.sessionStore.appendMessage('sess-tools', {
    id: 'm1', role: 'assistant', kind: 'tool_use', content: 'Inspecting the file.',
    tool_call: {
      call_id: 'call-1', tool_name: 'read_file', input: { path: 'src/app.js' },
      input_json: '{"path":"src/app.js"}', secret: 'must-not-leak',
    },
    timestamp: '2026-01-01T00:00:00.000Z', secret: 'must-not-leak',
  });
  service.sessionStore.appendMessage('sess-tools', {
    id: 'm2', role: 'tool', kind: 'tool_result', content: 'file contents',
    tool_result: {
      call_id: 'call-1', tool_name: 'read_file', output_text: 'file contents',
      is_error: true, error_code: 'CMP-TOOL-0001', secret: 'must-not-leak',
    },
    timestamp: '2026-01-01T00:00:01.000Z', secret: 'must-not-leak',
  });
  // W3-F11: rows are the send path's prepared rows, so a tool call carries no
  // stored label text and an orphaned result is dropped exactly as chat.send
  // drops it; call-2 therefore has its tool_use.
  service.sessionStore.appendMessage('sess-tools', {
    id: 'm2b', role: 'assistant', kind: 'tool_use', content: 'write_file',
    tool_call: { call_id: 'call-2', tool_name: 'write_file', input_json: '{}' },
  });
  service.sessionStore.appendMessage('sess-tools', {
    id: 'm3', role: 'tool', kind: 'tool_result', content: 'write_file',
    tool_result: {
      call_id: 'call-2', tool_name: 'write_file', output_text: 'write complete',
      is_error: false, secret: 'must-not-leak',
    },
    secret: 'must-not-leak',
  });

  await service.compactContextNow('sess-tools');

  assert.deepEqual(calls[0].messages, [
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"src/app.js"}' },
      }],
    },
    {
      role: 'tool',
      content: 'file contents',
      tool_call_id: 'call-1',
      name: 'read_file',
      is_error: true,
      error_code: 'CMP-TOOL-0001',
    },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call-2', type: 'function', function: { name: 'write_file', arguments: '{}' } }],
    },
    {
      role: 'tool',
      content: 'write complete',
      tool_call_id: 'call-2',
      name: 'write_file',
    },
  ]);
  assert.deepEqual(
    calls[0].messages.map((message) => Object.keys(message).sort()),
    [
      ['content', 'role', 'tool_calls'],
      ['content', 'error_code', 'is_error', 'name', 'role', 'tool_call_id'],
      ['content', 'role', 'tool_calls'],
      ['content', 'name', 'role', 'tool_call_id'],
    ],
    'tool messages must carry only the compact semantic whitelist'
  );
  service.sidecarClient = null;
  service.dispose();
});

test('compactContextNow forwards an empty messages array when the session has no canonical messages', async () => {
  const { service } = createMinimalService();
  const calls = [];

  service.sidecarManager.getStatus = () => ({ phase: 'ready' });
  service.sidecarClient = {
    chatCompact: async (sessionId, messages) => {
      calls.push({ sessionId, messages });
      return { status: 'error', reason: 'no_active_turn' };
    },
    dispose: () => {},
    off: () => {},
  };

  const result = await service.compactContextNow('sess-empty');

  assert.deepEqual(calls[0].messages, []);
  assert.deepEqual(result, { status: 'error', reason: 'no_active_turn' });
  service.sidecarClient = null;
  service.dispose();
});

test('compactContextNow reports snapshot_persisted=false when the ok-result carries no usable messages', async () => {
  const { service } = createMinimalService();

  service.sidecarManager.getStatus = () => ({ phase: 'ready' });
  service.sidecarClient = {
    // A malformed/legacy sidecar result: compacted but no replacement history.
    chatCompact: async () => ({ status: 'ok', compacted: true, strategy: 'full', tokens_before: 900, tokens_after: 300 }),
    dispose: () => {},
    off: () => {},
  };
  service.sessionStore.createSessionWithId('sess-no-msgs', { title: 'NoMsgs' });
  service.sessionStore.appendMessage('sess-no-msgs', { id: 'm1', role: 'user', content: 'hello' });

  const result = await service.compactContextNow('sess-no-msgs');

  assert.equal(result.status, 'ok');
  assert.equal(result.snapshot_persisted, false, 'no usable messages -> nothing persisted, reported honestly');
  assert.equal(service.sessionStore.getSession('sess-no-msgs').compaction_snapshot, null);
  service.sidecarClient = null;
  service.dispose();
});

test('compactContextNow catches a throwing guard accessor and returns a structured error (never throws)', async () => {
  const { service } = createMinimalService();

  service.sidecarClient = {
    chatCompact: async () => ({ status: 'ok', compacted: true }),
    dispose: () => {},
    off: () => {},
  };
  service.sidecarManager.getStatus = () => {
    throw new Error('status accessor exploded');
  };

  const result = await service.compactContextNow('sess-guard-throws');

  assert.equal(result.status, 'error');
  assert.equal(result.reason, 'compaction_failed');
  assert.match(result.detail, /status accessor exploded/);
  service.sidecarClient = null;
  service.dispose();
});

test('compactContextNow catches a throwing sidecarClient.chatCompact and returns a structured compaction_failed error', async () => {
  const { service } = createMinimalService();

  service.sidecarManager.getStatus = () => ({ phase: 'ready' });
  service.sidecarClient = {
    chatCompact: async () => {
      throw new Error('sidecar request timed out');
    },
    dispose: () => {},
    off: () => {},
  };

  const result = await service.compactContextNow('sess-throws');

  assert.equal(result.status, 'error');
  assert.equal(result.reason, 'compaction_failed');
  assert.match(result.detail, /sidecar request timed out/);
  service.sidecarClient = null;
  service.dispose();
});

// --- Observability (AGENTS.md §7): compactContextNow must not be a silent
// operation. Every branch (entry, each early sidecar_unavailable return, the
// resolved sidecar result, and the catch) must emit via _emitServiceLog so a
// live compaction (successful or not) leaves evidence in shell.log/client
// logs. Before this fix, ALL branches were silent — these cases fail because
// the spy records zero events, not because of wrong return values. ---

test('compactContextNow emits observability logs on the success path', async () => {
  const { service } = createMinimalService();
  const loggedEvents = [];
  service._emitServiceLog = (level, event, details) => {
    loggedEvents.push({ level, event, details });
  };

  service.sidecarManager.getStatus = () => ({ phase: 'ready' });
  service.sidecarClient = {
    chatCompact: async () => ({
      status: 'ok',
      compacted: true,
      tokens_before: 100,
      tokens_after: 40,
    }),
    dispose: () => {},
    off: () => {},
  };

  const result = await service.compactContextNow('sess-observed');

  assert.equal(result.status, 'ok');
  assert.ok(
    loggedEvents.some((entry) => /compact/i.test(entry.event)),
    `expected at least one logged event matching /compact/i, got: ${JSON.stringify(loggedEvents)}`
  );
  service.sidecarClient = null;
  service.dispose();
});

test('compactContextNow emits an observability log on the sidecar_unavailable early return', async () => {
  const { service } = createMinimalService();
  const loggedEvents = [];
  service._emitServiceLog = (level, event, details) => {
    loggedEvents.push({ level, event, details });
  };


  const result = await service.compactContextNow('sess-unavailable');

  assert.equal(result.reason, 'sidecar_unavailable');
  assert.ok(
    loggedEvents.some((entry) => /compact/i.test(entry.event)),
    `expected at least one logged event matching /compact/i, got: ${JSON.stringify(loggedEvents)}`
  );
  service.dispose();
});

test('compactContextNow refuses a locked session while a remote engine is active, before any sidecar call', async () => {
  const { service } = createMinimalService();
  const calls = [];
  service.sidecarManager.getStatus = () => ({ phase: 'ready' });
  service.sidecarClient = {
    chatCompact: async (...args) => { calls.push(args); return { status: 'ok', compacted: true, messages: [] }; },
    dispose: () => {},
    off: () => {},
  };
  service.featureFlags = { ...(service.featureFlags || {}), session_offline_lockdown: true };
  service.currentEngineType = 'chatgpt';
  service.sessionStore.getSession = () => ({ id: 'sess-locked', lockdown: true });
  service.sessionStore.getSessionMessages = () => [{ id: 'm1', role: 'user', content: 'hello' }];

  const refused = await service.compactContextNow('sess-locked');
  assert.deepEqual(refused, { status: 'error', reason: 'session_offline_lockdown' });
  assert.deepEqual(calls, [], 'a locked session never reaches the remote engine');

  service.currentEngineType = 'ollama';
  const allowed = await service.compactContextNow('sess-locked');
  assert.notEqual(allowed.reason, 'session_offline_lockdown');
  assert.equal(calls.length, 1, 'a local engine compacts the locked session');
  service.sidecarClient = null;
  service.dispose();
});

// CMC-4 / F22: Compact now summarized with whatever model the engine had
// active, not the chat's own (small-window) model.
test('compactContextNow brings up the chat model before the sidecar call, and stops if it cannot', async () => {
  const { service } = createMinimalService();
  const order = [];
  service.sidecarManager.getStatus = () => ({ phase: 'ready' });
  service.sidecarClient = {
    chatCompact: async () => { order.push(['compact', service.currentModel]); return { status: 'error', reason: 'no_active_turn' }; },
    dispose: () => {},
    off: () => {},
  };
  service.currentModel = 'ornith15:9b';
  service.sessionStore.getSession = () => ({ id: 'sess-small', preferred_model: 'qwen3.5:4b' });
  service.sessionStore.getSessionMessages = () => [{ id: 'm1', role: 'user', content: 'hello' }];
  service._resolveModel = async (model, engine) => {
    order.push(['resolve', model, engine]);
    service.currentModel = model;
    return model;
  };

  await service.compactContextNow('sess-small');
  assert.deepEqual(order, [['resolve', 'qwen3.5:4b', ''], ['compact', 'qwen3.5:4b']]);

  // Already on the chat model: no reload.
  order.length = 0;
  await service.compactContextNow('sess-small');
  assert.deepEqual(order, [['compact', 'qwen3.5:4b']]);

  // The chat model cannot load: no compaction on the wrong model.
  order.length = 0;
  service.currentModel = 'ornith15:9b';
  service._resolveModel = async () => { throw new Error('pull failed'); };
  const failed = await service.compactContextNow('sess-small');
  assert.deepEqual(failed, { status: 'error', reason: 'model_unavailable' });
  assert.deepEqual(order, []);
  service.sidecarClient = null;
  service.dispose();
});

test('compactContextNow never loads a model for a locked session', async () => {
  const { service } = createMinimalService();
  const resolved = [];
  service.sidecarManager.getStatus = () => ({ phase: 'ready' });
  service.sidecarClient = {
    chatCompact: async () => ({ status: 'error', reason: 'no_active_turn' }),
    dispose: () => {},
    off: () => {},
  };
  service.featureFlags = { ...(service.featureFlags || {}), session_offline_lockdown: true };
  service.currentEngineType = 'ollama';
  service.currentModel = 'ornith15:9b';
  service.sessionStore.getSession = () => ({ id: 'sess-locked', lockdown: true, preferred_model: 'gpt-5' });
  service.sessionStore.getSessionMessages = () => [{ id: 'm1', role: 'user', content: 'hello' }];
  service._resolveModel = async (model) => { resolved.push(model); return model; };

  await service.compactContextNow('sess-locked');
  assert.deepEqual(resolved, []);
  service.sidecarClient = null;
  service.dispose();
});

// Astra review of F22: Compact now must follow Force local inference like the
// next send does, and never switch models under another chat's live reply.
test('compactContextNow loads the forced local model, and refuses a switch while another reply runs', async () => {
  const { service } = createMinimalService();
  const order = [];
  service.sidecarManager.getStatus = () => ({ phase: 'ready' });
  service.sidecarClient = {
    chatCompact: async () => { order.push(['compact', service.currentModel]); return { status: 'error', reason: 'no_active_turn' }; },
    dispose: () => {},
    off: () => {},
  };
  service.offlineIntelligenceService = {
    getMode: () => 'local_only',
    getState: async () => ({
      mode: 'local_only', preferredLocalModel: 'qwen3.5:9b', selectedLocalEngineType: 'ollama',
      localCatalog: { available: true }, localChatReady: true,
    }),
  };
  service.currentModel = 'ornith15:9b';
  service.sessionStore.getSession = () => ({ id: 'sess-cloud', preferred_model: 'gpt-5' });
  service.sessionStore.getSessionMessages = () => [{ id: 'm1', role: 'user', content: 'hello' }];
  service._resolveModel = async (model, engine) => {
    order.push(['resolve', model, engine]);
    service.currentModel = model;
    return model;
  };

  service.activeStreams.set('stream-other-chat', { abort() {} });
  const busy = await service.compactContextNow('sess-cloud');
  assert.deepEqual(busy, { status: 'error', reason: 'session_busy' });
  assert.deepEqual(order, [], 'no model switch under a live reply');
  service.activeStreams.clear();

  await service.compactContextNow('sess-cloud');
  assert.deepEqual(order, [['resolve', 'qwen3.5:9b', 'ollama'], ['compact', 'qwen3.5:9b']]);
  service.sidecarClient = null;
  service.dispose();
});
