const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  ElectronSessionStore,
  normalizeSession,
} = require('../services/backend/electron-session-store');
const { BackendService } = require('../services/backend/backend-service');

const {
  createSession,
  deleteSession,
  getSessionMessages,
  MAX_INITIAL_PROMPT_CHARS,
  setSessionPreferences,
  sweepEmptySessions,
} = require('../services/backend/backend-sessions');

test('managed createSession keeps no-prompt shape and persists one bounded draft without messages', async (t) => {
  const scratchRoot = path.join(process.cwd(), '.tmp', 'wo10c');
  fs.mkdirSync(scratchRoot, { recursive: true });
  const storeRoot = fs.mkdtempSync(path.join(scratchRoot, 'session-store-'));
  t.after(() => fs.rmSync(storeRoot, { recursive: true, force: true }));
  const storePath = path.join(storeRoot, 'sessions.json');
  const store = new ElectronSessionStore(storePath, { logger() {} });
  const service = {
    _normalizeManagedSessionPreferencePatch: (preferences) => preferences || {},
    sessionStore: store,
  };

  const plain = (await createSession(service, {})).data;
  assert.deepEqual(Object.keys(plain).sort(), [
    'archived_at', 'branch_origin', 'compaction_context', 'context_preferences', 'context_usage',
    'conversation_mode', 'created_at', 'diagnostic_mode', 'diagnostic_model', 'diagnostic_provider',
    'diagnostic_run_id', 'id', 'interactive_round_count', 'interactive_sequence_state',
    'last_message_preview', 'last_model_used', 'linked_session_ids', 'linked_task_id', 'lockdown', 'message_count',
    'pending_plan_proposal', 'pending_question_batch', 'pinned', 'plan_mode', 'plugin_session',
    'pre_plan_run_mode', 'preferred_model', 'reasoning_effort', 'run_mode', 'session_start_date',
    'session_type', 'title', 'tool_category_overrides', 'updated_at',
  ]);
  const plainRecord = store.getSession(plain.id);
  assert.deepEqual(Object.keys(plainRecord).sort(), [
    'active_turn', 'archived_at', 'branch_origin', 'compaction_snapshot', 'context_preferences', 'context_usage', 'conversation_mode', 'created_at', 'diagnostic_mode', 'diagnostic_model', 'diagnostic_provider', 'diagnostic_run_id', 'id', 'interactive_round_count', 'interactive_sequence_state', 'last_message_preview', 'last_model_used', 'linked_session_ids', 'linked_task_id', 'lockdown', 'message_count', 'message_seq_counter', 'messages', 'pending_plan_proposal', 'pending_question_batch', 'pinned', 'plan_mode', 'plugin_session', 'pre_plan_run_mode', 'preferred_model', 'reasoning_effort', 'run_mode', 'session_incarnation', 'session_start_date', 'session_type', 'title', 'tool_category_overrides', 'turn_event_log_version', 'turn_event_seq_counter', 'turn_events', 'turn_generation', 'updated_at',
  ]);
  assert.deepEqual(plainRecord.messages, []);

  const oversized = 'x'.repeat(MAX_INITIAL_PROMPT_CHARS + 50);
  const drafted = (await createSession(service, { initialPrompt: oversized })).data;
  const stored = store.getSession(drafted.id);
  assert.equal(stored.composer_draft.length, MAX_INITIAL_PROMPT_CHARS);
  assert.match(stored.composer_draft, /\n\n\[clipped\]$/);
  assert.equal(Object.keys(stored).filter((key) => key === 'composer_draft').length, 1);
  assert.deepEqual(stored.messages, []);
  assert.equal(drafted.composer_draft, stored.composer_draft);
  const reopened = new ElectronSessionStore(storePath, { logger() {} });
  assert.equal(reopened.getSession(drafted.id).composer_draft, stored.composer_draft);
  reopened.dispose();
  store.appendMessage(drafted.id, {
    id: 'user-1', role: 'user', content: 'Sent', status: 'complete', timestamp: '2026-09-04T12:00:00.000Z',
  });
  assert.equal(Object.hasOwn(store.getSession(drafted.id), 'composer_draft'), false);

  for (const initialPrompt of [null, 42, '', ' \n ']) {
    const ignored = (await createSession(service, { initialPrompt })).data;
    assert.equal(Object.hasOwn(ignored, 'composer_draft'), false);
    assert.deepEqual(store.getSession(ignored.id).messages, []);
  }
});

test('BackendService.createSession passes initialPrompt through to composer_draft', async (t) => {
  const scratchRoot = path.join(process.cwd(), '.tmp', 'wo10c-service');
  fs.mkdirSync(scratchRoot, { recursive: true });
  const storeRoot = fs.mkdtempSync(path.join(scratchRoot, 'session-store-'));
  t.after(() => fs.rmSync(storeRoot, { recursive: true, force: true }));
  const store = new ElectronSessionStore(path.join(storeRoot, 'sessions.json'), { logger() {} });
  const service = Object.create(BackendService.prototype);
  service.sessionStore = store;
  service._normalizeManagedSessionPreferencePatch = (preferences) => preferences || {};

  const created = await service.createSession({ initialPrompt: 'Keep this as an unsent draft.' });

  assert.equal(created.data.composer_draft, 'Keep this as an unsent draft.');
  assert.equal(store.getSession(created.data.id).composer_draft, 'Keep this as an unsent draft.');
});

test('offline lockdown persists through the real store and malformed values normalize false', (t) => {
  const scratchRoot = path.join(process.cwd(), '.tmp', 'wo12b');
  fs.mkdirSync(scratchRoot, { recursive: true });
  const storeRoot = fs.mkdtempSync(path.join(scratchRoot, 'session-store-'));
  t.after(() => fs.rmSync(storeRoot, { recursive: true, force: true }));
  const storePath = path.join(storeRoot, 'sessions.json');
  const store = new ElectronSessionStore(storePath, { logger() {} });
  const created = store.createSession({
    title: 'Locked',
    preferences: { lockdown: true },
  });

  assert.equal(store.getSession(created.id).lockdown, true);
  assert.equal(store.listSessions()[0].lockdown, true);
  assert.equal(new ElectronSessionStore(storePath, { logger() {} })
    .getSession(created.id).lockdown, true);
  assert.equal(normalizeSession('missing', {}).lockdown, false);
  assert.equal(normalizeSession('string', { lockdown: 'true' }).lockdown, false);
  assert.equal(store.setSessionPreferences(created.id, { lockdown: 'yes' }).lockdown, false);
});

function livePreferenceService({ active = true } = {}) {
  const sessionId = 'session-live-mode';
  const streamId = 'stream-live-mode';
  const notifications = [];
  const logs = [];
  let session = { id: sessionId, run_mode: 'ask', plan_mode: false };
  return {
    logs,
    notifications,
    service: {
      _emitServiceLog(level, event, details) {
        logs.push({ level, event, details });
      },
      _normalizeManagedSessionPreferencePatch: (preferences) => preferences,
      activeStreams: new Map(active ? [[streamId, new AbortController()]] : []),
      sidecarClient: {
        notifySessionRunModeUpdated(params) {
          notifications.push(params);
        },
      },
      sessionStore: {
        getActiveTurn: () => ({ stream_id: streamId }),
        getSession: () => ({ ...session }),
        setSessionPreferences(_sessionId, preferences) {
          session = { ...session, ...preferences };
          return { ...session };
        },
      },
    },
  };
}

test('managed preference write pushes run mode to an active session stream', async () => {
  const { service, logs, notifications } = livePreferenceService();

  await setSessionPreferences(service, 'session-live-mode', { run_mode: 'auto' });

  assert.deepEqual(notifications, [{
    sessionId: 'session-live-mode',
    approvalMode: 'auto_run',
    readOnly: false,
  }]);
  assert.deepEqual(logs, []);
});

test('managed plan mode write logs a skipped push for an inactive session', async () => {
  const { service, logs, notifications } = livePreferenceService({ active: false });

  await setSessionPreferences(service, 'session-live-mode', { plan_mode: true });

  assert.deepEqual(notifications, []);
  assert.deepEqual(logs, [{
    level: 'INFO',
    event: 'session.run_mode_push_skipped',
    details: {
      sessionId: 'session-live-mode',
      changedKeys: ['plan_mode'],
    },
  }]);
});

test('managed createSession rejects when the session store refuses the write', async () => {
  const service = {
    _normalizeManagedSessionPreferencePatch: (preferences) => preferences || {},
    sessionStore: {
      createSession() {
        return null;
      },
    },
  };

  await assert.rejects(
    createSession(service, { title: 'Blocked', preferences: {} }),
    /rejected the write/i
  );
});

test('managed createSession resolves and persists a plugin provider binding', async () => {
  let storeArgs = null;
  const pluginSession = { schema_version: 1, publisher_id: 'jenny-official',
    plugin_id: 'local-image-generation' };
  const service = {
    _normalizeManagedSessionPreferencePatch: (preferences) => preferences || {},
    _pluginSessionProviderBroker: {
      resolveCreationBinding: async () => ({ ok: true, pluginSession }),
    },
    sessionStore: {
      createSession(args) {
        storeArgs = args;
        return { id: 's-plugin', session_type: 'plugin', plugin_session: pluginSession };
      },
    },
  };

  const result = await createSession(service, {
    title: 'New Plugin Session',
    preferences: {},
    sessionType: 'plugin',
    providerAuthority: { publisher_id: 'jenny-official',
      plugin_id: 'local-image-generation', provider_contribution_id: 'local_image_generation' },
  });
  assert.equal(storeArgs.sessionType, 'plugin');
  assert.deepEqual(storeArgs.pluginSession, pluginSession);
  assert.equal(result.data.session_type, 'plugin');
});

function makeImageAttachment(assetPath, id = 'image-1') {
  return {
    id,
    kind: 'image',
    displayName: `${id}.png`,
    mimeType: 'image/png',
    sizeBytes: 10,
    width: 10,
    height: 10,
    assetPath,
    sourceKind: 'file',
  };
}

function pendingTerminalRepair(sessionId, messageId = `assistant-${sessionId}`) {
  return {
    artifact_id: `repair-${sessionId}`,
    session_id: sessionId,
    state: 'pending',
    reason: 'write_failed',
    scope: 'assistant',
    message: {
      id: messageId,
      client_message_id: messageId,
      role: 'assistant',
      content: `Unsaved reply for ${sessionId}`,
      status: 'complete',
      timestamp: '2026-07-14T12:00:00.000Z',
    },
  };
}

function attachPendingRepair(service, repair) {
  service.terminalRepairStore = {
    listPending(sessionId) {
      return sessionId === repair.session_id ? [repair] : [];
    },
  };
  return service;
}

test('managed getSessionMessages hydrates pending terminal repairs', async () => {
  const repair = pendingTerminalRepair('managed_session');
  const service = attachPendingRepair({
    sessionStore: {
      getSession: () => ({ turn_event_log_version: 3, active_turn: null }),
      getSessionMessages: () => [],
      getSessionTurnEvents: () => [],
    },
  }, repair);

  const result = await getSessionMessages(service, 'managed_session');

  assert.equal(result.data[0].id, repair.message.id);
  assert.deepEqual(result.data[0].durability, {
    state: 'unsaved',
    reason: 'write_failed',
    scope: 'assistant',
    artifact_id: repair.artifact_id,
  });
});

test('managed deleteSession resets usage rows only after a successful delete', async () => {
  const resetCalls = [];
  const service = {
    usageHistory: {
      resetSession(sessionId) {
        resetCalls.push(sessionId);
        return { ok: true, cleared_turn_count: 1, durable: true };
      },
    },
    sessionStore: {
      deleteSession(sessionId) {
        return sessionId === 'sess_deleted';
      },
      getSessionMessages() {
        return [];
      },
      listSessions() {
        return [];
      },
    },
  };

  assert.deepEqual(await deleteSession(service, 'sess_missing'), {
    object: 'session',
    id: 'sess_missing',
    deleted: false,
  });
  assert.deepEqual(resetCalls, []);

  assert.deepEqual(await deleteSession(service, 'sess_deleted'), {
    object: 'session',
    id: 'sess_deleted',
    deleted: true,
    cleanup_status: 'complete',
    cleanup_errors: [],
  });
  assert.deepEqual(resetCalls, ['sess_deleted']);
});

test('session deletion requires terminal repair cleanup to report ok and durable', async () => {
  for (const repairResult of [
    { ok: true, durable: true },
    { ok: true, durable: false, reason: 'write_failed' },
    { ok: false, durable: true, reason: 'delete_refused' },
  ]) {
    const repairDeletes = [];
    const service = {
      _emitServiceLog() {},
      sessionStore: {
        deleteSession: () => true,
        listSessions: () => [],
      },
      terminalRepairStore: {
        deleteSession(sessionId) {
          repairDeletes.push(sessionId);
          return repairResult;
        },
      },
    };

    const result = await deleteSession(service, 'sess_terminal_repair');
    const cleanupSucceeded = repairResult.ok === true && repairResult.durable === true;

    assert.deepEqual(repairDeletes, ['sess_terminal_repair']);
    assert.equal(result.cleanup_status, cleanupSucceeded ? 'complete' : 'degraded');
    assert.deepEqual(
      result.cleanup_errors,
      cleanupSucceeded ? [] : [{ step: 'terminal_repairs', code: 'cleanup_failed' }]
    );
  }
});

test('managed deleteSession does not run cleanup when canonical deletion is refused', async () => {
  const calls = [];
  const service = {
    sessionStore: {
      getSessionMessages() {
        return [{ attachments: [makeImageAttachment('C:/private/refused.png')] }];
      },
      listSessions() {
        return [];
      },
      deleteSession() {
        calls.push('data_delete');
        return false;
      },
    },
    attachmentAssetStore: {
      pruneAssetPaths() {
        calls.push('attachments');
      },
    },
    artifactService: {
      async deleteSessionArtifacts() {
        calls.push('artifacts');
      },
    },
    usageHistory: {
      resetSession() {
        calls.push('cost');
      },
    },
  };

  const result = await deleteSession(service, 'sess_refused');

  assert.deepEqual(result, {
    object: 'session',
    id: 'sess_refused',
    deleted: false,
  });
  assert.deepEqual(calls, ['data_delete']);
});

test('managed deleteSession propagates canonical deletion errors without running cleanup', async () => {
  const cleanupCalls = [];
  const service = {
    sessionStore: {
      deleteSession() {
        throw new Error('canonical delete failed');
      },
    },
    artifactService: {
      async deleteSessionArtifacts() {
        cleanupCalls.push('artifacts');
      },
    },
    usageHistory: {
      resetSession() {
        cleanupCalls.push('cost');
      },
    },
  };

  await assert.rejects(deleteSession(service, 'sess_throw'), /canonical delete failed/);
  assert.deepEqual(cleanupCalls, []);
});

test('managed deleteSession reports independent post-delete cleanup failures without rollback', async () => {
  const calls = [];
  const logs = [];
  let dataDeleted = false;
  const privatePath = 'C:/private/session-secret.png';
  const service = {
    _emitServiceLog(level, event, details) {
      logs.push({ level, event, details });
    },
    sessionStore: {
      getSessionMessages(sessionId) {
        return !dataDeleted && sessionId === 'sess_cleanup'
          ? [{ attachments: [makeImageAttachment(privatePath)] }]
          : [];
      },
      listSessions() {
        return [];
      },
      deleteSession() {
        calls.push('data_delete');
        dataDeleted = true;
        return true;
      },
    },
    shadowStore: {
      getMessages() {
        return [];
      },
      summarize() {
        return {};
      },
    },
    attachmentAssetStore: {
      pruneAssetPaths() {
        calls.push('attachments');
        throw new Error(`attachment cleanup failed at ${privatePath}`);
      },
    },
    artifactService: {
      async deleteSessionArtifacts() {
        calls.push('artifacts');
        throw new Error(`artifact cleanup failed at ${privatePath}`);
      },
    },
    usageHistory: {
      resetSession() {
        calls.push('cost');
        throw new Error(`usage cleanup failed at ${privatePath}`);
      },
    },
  };

  const result = await deleteSession(service, 'sess_cleanup');

  assert.equal(dataDeleted, true);
  assert.deepEqual(calls, ['data_delete', 'attachments', 'artifacts', 'cost']);
  assert.deepEqual(result, {
    object: 'session',
    id: 'sess_cleanup',
    deleted: true,
    cleanup_status: 'degraded',
    cleanup_errors: [
      { step: 'attachment_assets', code: 'cleanup_failed' },
      { step: 'artifacts', code: 'cleanup_failed' },
      { step: 'usage', code: 'cleanup_failed' },
    ],
  });
  assert.equal(JSON.stringify({ result, logs }).includes(privatePath), false);
  assert.deepEqual(
    logs.map((entry) => entry.event),
    [
      'session.delete_cleanup_degraded',
      'session.delete_cleanup_degraded',
      'session.delete_cleanup_degraded',
    ]
  );
});

test('managed deleteSession scrubs links and crash journal only after data deletion commits', async () => {
  const calls = [];
  const service = {
    sessionStore: {
      getSessionMessages() { return []; },
      listSessions() { return []; },
      deleteSession() {
        calls.push('data_delete');
        return true;
      },
      scrubLinkedSessionReferences() {
        calls.push('link_scrub');
        return { ok: true, failedSessionIds: [] };
      },
    },
    turnEventJournal: {
      purgeTurnsAfter(sessionId, survivors) {
        calls.push(`journal_purge:${sessionId}:${survivors.size}`);
        return { purged: 2 };
      },
      flush() {
        calls.push('journal_flush');
        return true;
      },
    },
  };

  const result = await deleteSession(service, 'sess_cleanup_order');

  assert.deepEqual(calls, [
    'data_delete',
    'link_scrub',
    'journal_purge:sess_cleanup_order:0',
    'journal_flush',
  ]);
  assert.equal(result.cleanup_status, 'complete');
});

test('post-delete link and journal refusal degrades cleanup without reviving data', async () => {
  let deleted = false;
  const service = {
    _emitServiceLog() {},
    sessionStore: {
      getSessionMessages() { return []; },
      listSessions() { return []; },
      deleteSession() {
        deleted = true;
        return true;
      },
      scrubLinkedSessionReferences() {
        return { ok: false, failedSessionIds: ['linked'] };
      },
    },
    turnEventJournal: {
      purgeTurnsAfter() { return { purged: 1 }; },
      flush() { return false; },
    },
  };

  const result = await deleteSession(service, 'sess_cleanup_degraded');

  assert.equal(deleted, true);
  assert.equal(result.deleted, true);
  assert.equal(result.cleanup_status, 'degraded');
  assert.deepEqual(result.cleanup_errors, [
    { step: 'canonical_links', code: 'cleanup_failed' },
  ]);
});

test('empty-session sweep excludes active candidates before lifecycle deletion', async () => {
  const deletedIds = [];
  const service = {
    sessionStore: {
      sweepEmptySessions(options) {
        assert.equal(options.dryRun, true);
        return { candidateIds: ['idle_1', 'leased_2'], deleted: 0 };
      },
    },
    sessionTurnActors: {
      hasActiveLifecycle(sessionId) { return sessionId === 'leased_2'; },
    },
    async deleteSession(sessionId) {
      deletedIds.push(sessionId);
      return { object: 'session', id: sessionId, deleted: sessionId === 'idle_1' };
    },
  };

  assert.deepEqual(await sweepEmptySessions(service), {
    candidateIds: ['idle_1'],
    deleted: 1,
  });
  assert.deepEqual(deletedIds, ['idle_1']);
});

test('empty-session sweep isolates one deletion failure and continues later candidates', async () => {
  const attempted = [];
  const logs = [];
  const service = {
    _emitServiceLog(level, event, details) { logs.push({ level, event, details }); },
    sessionStore: {
      sweepEmptySessions() {
        return { candidateIds: ['broken_1', 'valid_2'], deleted: 0 };
      },
      getActiveTurn() { return null; },
    },
    async deleteSession(sessionId) {
      attempted.push(sessionId);
      if (sessionId === 'broken_1') throw Object.assign(new Error('private failure'), {
        code: 'delete_failed',
      });
      return { object: 'session', id: sessionId, deleted: true };
    },
  };

  assert.deepEqual(await sweepEmptySessions(service), {
    candidateIds: ['broken_1', 'valid_2'],
    deleted: 1,
    failed: 1,
    failures: [{ sessionId: 'broken_1', reason: 'delete_failed' }],
  });
  assert.deepEqual(attempted, ['broken_1', 'valid_2']);
  assert.equal(logs[0].event, 'session.sweep_delete_failed');
  assert.equal(JSON.stringify(logs).includes('private failure'), false);
});
