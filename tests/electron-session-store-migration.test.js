const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ElectronSessionStore,
  STORE_SCHEMA_VERSION,
  getLocalISODate,
  normalizeActiveTurn,
  normalizeSessionStartDate,
} = require('../services/backend/electron-session-store');
const { ShellConfigService } = require('../services/shell-config-service');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

// ShellConfigService debounces its workspace-state write behind a timer. The timer
// is unref'd, so it never held the runner open -- but it still FIRES after this
// teardown has removed the temp directory, and the write RECREATES it. Verified
// directly: remove the directory with a write pending and it is back within the
// debounce window. Flush before the directories go.
const openShellConfigServices = [];

function makeShellConfigService(options) {
  const service = new ShellConfigService(options);
  openShellConfigServices.push(service);
  return service;
}

test.afterEach(async () => {
  while (openShellConfigServices.length) {
    try {
      openShellConfigServices.pop().flushPendingWorkspaceWrite();
    } catch (error) {
      void error;
    }
  }
  await cleanupTrackedResources();
});

function createLogCollector() {
  const entries = [];
  return {
    entries,
    logger(level, event, details = {}) {
      entries.push({ level, event, details });
    },
  };
}

function sessionsDir(userDataPath) {
  return path.join(userDataPath, 'sessions');
}

function indexFilePath(userDataPath) {
  return path.join(sessionsDir(userDataPath), '_index.json');
}

function sessionFilePath(userDataPath, sessionId) {
  return path.join(sessionsDir(userDataPath), `${sessionId}.json`);
}

function readIndexOnDisk(userDataPath) {
  return JSON.parse(fs.readFileSync(indexFilePath(userDataPath), 'utf8'));
}

function readSessionOnDisk(userDataPath, sessionId) {
  return JSON.parse(fs.readFileSync(sessionFilePath(userDataPath, sessionId), 'utf8'));
}

function findMigratedBackup(userDataPath) {
  return fs.readdirSync(userDataPath).find((entry) =>
    entry.startsWith('sessions.json.migrated-')
  );
}
test('electron session store migrates v2 sessions to v3 and persists linked session ids', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-store-'));
  trackDirectory(userDataPath);
  const storePath = path.join(userDataPath, 'sessions.json');
  fs.writeFileSync(storePath, JSON.stringify({
    schema_version: 2,
    sessions: {
      sess_a: {
        id: 'sess_a',
        title: 'Session A',
        created_at: '2026-03-19T10:00:00.000Z',
        updated_at: '2026-03-19T10:00:00.000Z',
        messages: [],
      },
      sess_b: {
        id: 'sess_b',
        title: 'Session B',
        created_at: '2026-03-19T11:00:00.000Z',
        updated_at: '2026-03-19T11:00:00.000Z',
        messages: [],
      },
    },
  }, null, 2));

  const store = new ElectronSessionStore(storePath);
  assert.deepEqual(store.getSession('sess_a').linked_session_ids, []);
  assert.deepEqual(
    store.listSessions().map((session) => session.linked_session_ids),
    [[], []]
  );

  store.setSessionPreferences('sess_a', {
    linked_session_ids: ['sess_b', 'sess_b', 'sess_a', 'sess_c'],
  });

  const reloaded = new ElectronSessionStore(storePath);
  assert.deepEqual(reloaded.getSession('sess_a').linked_session_ids, ['sess_b', 'sess_c']);
});

test('electron session store createSession returns linked session ids and delete prunes links plus workspace state', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-store-delete-'));
  trackDirectory(userDataPath);

  const shellConfigService = makeShellConfigService({ userDataPath });
  const store = new ElectronSessionStore(path.join(userDataPath, 'sessions.json'), {
    shellConfigService,
  });
  shellConfigService.setWorkspaceSessionIdProvider(
    () => store.listSessions().map((session) => session.id)
  );

  const created = store.createSession({ title: 'Created Session' });
  assert.deepEqual(created.linked_session_ids, []);

  store.createSessionWithId('sess_a', { title: 'Session A' });
  store.createSessionWithId('sess_b', { title: 'Session B' });
  store.createSessionWithId('sess_c', { title: 'Session C' });
  store.setSessionPreferences('sess_a', {
    linked_session_ids: ['sess_b', 'sess_c', 'sess_b'],
  });
  store.setSessionPreferences('sess_c', {
    linked_session_ids: ['sess_b'],
  });
  assert.deepEqual(
    store.getSessionIds().sort(),
    ['sess_a', 'sess_b', 'sess_c', created.id].sort()
  );

  shellConfigService.updateWorkspaceState({
    activeSessionId: 'sess_b',
    openSessionIds: ['sess_a', 'sess_b', 'sess_b', 'sess_c'],
  });

  assert.equal(store.deleteSession('sess_b'), true);
  assert.equal(store.getSession('sess_b'), null);
  assert.deepEqual(
    store.getSessionIds().sort(),
    ['sess_a', 'sess_c', created.id].sort()
  );
  assert.deepEqual(store.getSession('sess_a').linked_session_ids, ['sess_c']);
  assert.deepEqual(store.getSession('sess_c').linked_session_ids, []);
  assert.deepEqual(shellConfigService.getWorkspaceState(), {
    activeSessionId: null,
    openSessionIds: ['sess_a', 'sess_c'],
  });
});

test('electron session store treats current-schema diagnostic sessions as current and deletable', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-store-current-diagnostic-'));
  trackDirectory(userDataPath);
  const sessionsRoot = sessionsDir(userDataPath);
  fs.mkdirSync(sessionsRoot, { recursive: true });
  const diagnosticSummary = {
    id: 'frontier_diag_run_20260522',
    title: 'Frontier diagnostics run_20260522',
    session_type: 'chat',
    diagnostic_mode: 'frontier',
    diagnostic_run_id: 'run_20260522',
    diagnostic_provider: 'codex-cli',
    diagnostic_model: 'gpt-5',
    created_at: '2026-05-22T02:36:14.078Z',
    updated_at: '2026-05-22T02:36:14.078Z',
    session_start_date: '2026-05-21',
    message_count: 0,
    last_message_preview: '',
    last_model_used: '',
    preferred_model: 'gpt-5',
    reasoning_effort: 'default',
    conversation_mode: 'chat',
    pending_question_batch: null,
    interactive_sequence_state: 'idle',
    interactive_round_count: 0,
    plan_mode: false,
    context_preferences: {},
    linked_session_ids: [],
    branch_origin: null,
  };
  fs.writeFileSync(indexFilePath(userDataPath), JSON.stringify({
    schema_version: STORE_SCHEMA_VERSION,
    sessions: {
      [diagnosticSummary.id]: diagnosticSummary,
    },
  }, null, 2), 'utf8');
  fs.writeFileSync(sessionFilePath(userDataPath, diagnosticSummary.id), JSON.stringify({
    schema_version: STORE_SCHEMA_VERSION,
    session: {
      ...diagnosticSummary,
      active_turn: null,
      messages: [],
      message_seq_counter: 0,
      turn_event_log_version: 2,
      turn_event_seq_counter: 0,
      turn_events: [],
    },
  }, null, 2), 'utf8');
  const logs = createLogCollector();

  const store = new ElectronSessionStore(path.join(userDataPath, 'sessions.json'), {
    logger: logs.logger,
  });
  const [summary] = store.listSessions();
  const session = store.getSession(diagnosticSummary.id);

  assert.equal(summary.diagnostic_mode, 'frontier');
  assert.equal(summary.diagnostic_run_id, 'run_20260522');
  assert.equal(summary.diagnostic_provider, 'codex-cli');
  assert.equal(summary.diagnostic_model, 'gpt-5');
  assert.equal(session.diagnostic_mode, 'frontier');
  assert.equal(store.deleteSession(diagnosticSummary.id), true);
  assert.equal(store.getSession(diagnosticSummary.id), null);
  assert.equal(fs.existsSync(sessionFilePath(userDataPath, diagnosticSummary.id)), false);
  assert.equal(
    logs.entries.find((entry) => entry.event === 'session_store.newer_schema_detected'),
    undefined
  );
  assert.equal(
    logs.entries.find((entry) => entry.event === 'session_store.newer_schema_write_blocked'),
    undefined
  );
});

test('electron session store normalizes diagnostic metadata on current-schema summaries without rewriting current files', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-store-current-diagnostic-summary-'));
  trackDirectory(userDataPath);
  const sessionsRoot = sessionsDir(userDataPath);
  fs.mkdirSync(sessionsRoot, { recursive: true });
  const sessionId = 'frontier_diag_malformed_summary';
  const longRunId = `run_${'x'.repeat(180)}`;
  const indexPayload = {
    schema_version: STORE_SCHEMA_VERSION,
    sessions: {
      [sessionId]: {
        id: sessionId,
        title: 'Frontier diagnostics malformed summary',
        session_type: 'chat',
        diagnostic_mode: 'frontier\n\tmode',
        diagnostic_run_id: longRunId,
        diagnostic_provider: 'codex\u001b[31m-cli',
        diagnostic_model: 'gpt-5',
        created_at: '2026-05-22T02:36:14.078Z',
        updated_at: '2026-05-22T02:36:14.078Z',
        session_start_date: '2026-05-21',
        message_count: 0,
        last_message_preview: '',
        last_model_used: '',
        preferred_model: 'gpt-5',
        reasoning_effort: 'default',
        conversation_mode: 'chat',
        pending_question_batch: null,
        interactive_sequence_state: 'idle',
        interactive_round_count: 0,
        plan_mode: false,
        context_preferences: {},
        linked_session_ids: [],
        branch_origin: null,
      },
    },
  };
  fs.writeFileSync(indexFilePath(userDataPath), JSON.stringify(indexPayload, null, 2), 'utf8');
  fs.writeFileSync(sessionFilePath(userDataPath, sessionId), JSON.stringify({
    schema_version: STORE_SCHEMA_VERSION,
    session: {
      ...indexPayload.sessions[sessionId],
      active_turn: null,
      messages: [],
      message_seq_counter: 0,
      turn_event_log_version: 2,
      turn_event_seq_counter: 0,
      turn_events: [],
    },
  }, null, 2), 'utf8');
  const beforeIndexBytes = fs.readFileSync(indexFilePath(userDataPath), 'utf8');

  const store = new ElectronSessionStore(path.join(userDataPath, 'sessions.json'));
  const [summary] = store.listSessions();

  assert.equal(summary.diagnostic_mode, 'frontier mode');
  assert.equal(summary.diagnostic_run_id.length, 120);
  assert.equal(summary.diagnostic_run_id, longRunId.slice(0, 120).trim());
  assert.equal(summary.diagnostic_provider, 'codex [31m-cli');
  assert.equal(fs.readFileSync(indexFilePath(userDataPath), 'utf8'), beforeIndexBytes);
  assert.equal(store.hasPendingMigrations(), false);
});

test('electron session store persists session_start_date and tool_result metadata across reloads', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-store-meta-'));
  trackDirectory(userDataPath);

  const store = new ElectronSessionStore(path.join(userDataPath, 'sessions.json'));
  const created = store.createSession({
    title: 'Metadata Session',
  });

  assert.equal(created.session_start_date, getLocalISODate(new Date(created.created_at)));

  store.setSessionPreferences(created.id, {
    session_start_date: '2026-03-29',
  });
  store.appendMessage(created.id, {
    id: 'tool_result_1',
    role: 'tool',
    kind: 'tool_result',
    content: 'Found 1 tool',
    tool_result: {
      call_id: 'call_tool_search_1',
      tool_name: 'tool_search',
      output_text: 'Found 1 tool(s):\n- mcp__git__commit: Commit changes',
      summary: 'Found 1 tool',
      is_error: false,
      error_code: 'CMP-TSRCH-0001',
      metadata: {
        kind: 'tool_search_result',
        discovered_tools: ['mcp__git__commit'],
        approval_plan_hash: 'plan-hash-1',
        approval_effective_args_fingerprint: 'effective-hash-1',
        approval_execution_context_fingerprint: 'context-hash-1',
        approval_model_identity_fingerprint: 'model-hash-1',
        approval_system_prompt_hash: 'prompt-hash-1',
        approval_sampling_params_hash: 'sampling-hash-1',
        approval_message_history_hash: 'history-hash-1',
        approval_tool_contract_hash: 'contract-hash-1',
        approval_injected_arg_keys: ['expected_read_snapshot'],
        read_snapshot: {
          path: 'notes.txt',
          scope: 'full',
          size_bytes: 6,
          mtime_ns: 123,
          sha256: 'abc123',
        },
      },
    },
  });

  const reloaded = new ElectronSessionStore(path.join(userDataPath, 'sessions.json'));
  const session = reloaded.getSession(created.id);
  const [message] = reloaded.getSessionMessages(created.id);

  assert.equal(session.session_start_date, '2026-03-29');
  assert.equal(message.tool_result.error_code, 'CMP-TSRCH-0001');
  assert.deepEqual(message.tool_result.metadata, {
    kind: 'tool_search_result',
    discovered_tools: ['mcp__git__commit'],
    approval_plan_hash: 'plan-hash-1',
    approval_effective_args_fingerprint: 'effective-hash-1',
    approval_execution_context_fingerprint: 'context-hash-1',
    approval_model_identity_fingerprint: 'model-hash-1',
    approval_system_prompt_hash: 'prompt-hash-1',
    approval_sampling_params_hash: 'sampling-hash-1',
    approval_message_history_hash: 'history-hash-1',
    approval_tool_contract_hash: 'contract-hash-1',
    approval_injected_arg_keys: ['expected_read_snapshot'],
    read_snapshot: {
      path: 'notes.txt',
      scope: 'full',
      size_bytes: 6,
      mtime_ns: 123,
      sha256: 'abc123',
    },
    late_events: [],
  });
});

test('electron session store persists internal active_turn without exposing it in summaries', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-store-active-turn-'));
  trackDirectory(userDataPath);

  const store = new ElectronSessionStore(path.join(userDataPath, 'sessions.json'));
  const created = store.createSession({
    title: 'Reconnect Session',
  });
  const updatedAtBeforeReconnectWrites = store.getSession(created.id).updated_at;

  store.setActiveTurn(created.id, {
    request_id: 'req_1',
    stream_id: 'stream_1',
    trace_id: 'trace_1',
    user_message_id: 'user_1',
    started_at: '2026-04-09T10:00:00.000Z',
    last_event_at: '2026-04-09T10:00:00.000Z',
    status: 'awaiting_assistant',
  });
  // touchActiveTurn updates the in-memory cache only; it intentionally skips
  // the per-stream-event disk rewrite that would block the event loop on
  // large sessions. flush() drains any pending FileJsonStore writes AND
  // ensures the cache (including the touch updates) lands on disk before a
  // separate ElectronSessionStore instance reads from the same file.
  store.touchActiveTurn(created.id, {
    request_id: 'req_1',
    stream_id: 'stream_1',
  }, {
    status: 'streaming',
    last_event_at: '2026-04-09T10:01:00.000Z',
    task_id: 'local_agent_1',
    task_type: 'local_agent',
    agent_stage: 'planning',
    agent_summary: 'Planning multi-step execution strategy.',
    agent_percent: 20,
  });
  store.flush();

  const reloaded = new ElectronSessionStore(path.join(userDataPath, 'sessions.json'));
  const session = reloaded.getSession(created.id);
  const records = reloaded.listSessionRecords();
  const summary = reloaded.listSessions().find((entry) => entry.id === created.id);

  assert.deepEqual(session.active_turn, normalizeActiveTurn({
    request_id: 'req_1',
    stream_id: 'stream_1',
    trace_id: 'trace_1',
    user_message_id: 'user_1',
    started_at: '2026-04-09T10:00:00.000Z',
    last_event_at: '2026-04-09T10:01:00.000Z',
    status: 'streaming',
    task_id: 'local_agent_1',
    task_type: 'local_agent',
    agent_stage: 'planning',
    agent_summary: 'Planning multi-step execution strategy.',
    agent_percent: 20,
  }));
  assert.deepEqual(records.find((entry) => entry.id === created.id)?.active_turn, session.active_turn);
  assert.equal(Object.prototype.hasOwnProperty.call(records.find((entry) => entry.id === created.id), 'messages'), false);
  assert.equal(session.updated_at, updatedAtBeforeReconnectWrites);
  assert.equal(Object.prototype.hasOwnProperty.call(summary, 'active_turn'), false);

  reloaded.clearActiveTurn(created.id, {
    request_id: 'req_1',
    stream_id: 'stream_1',
  });
  assert.equal(reloaded.getActiveTurn(created.id), null);
  assert.equal(reloaded.getSession(created.id).updated_at, updatedAtBeforeReconnectWrites);
});

test('normalizeSessionStartDate derives the local calendar day from created_at', (t) => {
  // The whole point is that the day comes from the LOCAL calendar rather than
  // the UTC one, so the zone has to be pinned for the assertion to mean anything.
  // It used to hard-code the America/Chicago answer against whatever zone the
  // machine happened to be in: correct here, and failing under TZ=UTC -- which is
  // what CI and most contributors outside the Americas run.
  const originalTz = process.env.TZ;
  t.after(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  // Negative offset: the UTC instant is still the previous local day.
  process.env.TZ = 'America/Chicago';
  assert.equal(normalizeSessionStartDate('', '2026-03-29T00:30:00.000Z'), '2026-03-28');

  // Positive offset: the UTC instant is already the NEXT local day. Without this
  // side, a UTC-only implementation would still satisfy the case above.
  process.env.TZ = 'Asia/Tokyo';
  assert.equal(normalizeSessionStartDate('', '2026-03-29T22:30:00.000Z'), '2026-03-30');
});

test('electron session store migrates v3 payloads to v5 with dedupe, stale pending approval repair, and null active_turn', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-store-v4-'));
  trackDirectory(userDataPath);
  const storePath = path.join(userDataPath, 'sessions.json');
  fs.writeFileSync(storePath, JSON.stringify({
    schema_version: 3,
    sessions: {
      sess_v4_repair: {
        id: 'sess_v4_repair',
        title: 'Repair Session',
        created_at: '2026-03-19T10:00:00.000Z',
        updated_at: '2026-03-19T10:00:00.000Z',
        messages: [
          {
            id: 'tool_use_call-a',
            role: 'assistant',
            kind: 'tool_use',
            content: 'Write a.txt',
            tool_call: {
              call_id: 'call-a',
              tool_name: 'write_file',
              status: 'pending_approval',
              approval_state: 'pending',
            },
          },
          {
            id: 'tool_use_call-b',
            role: 'assistant',
            kind: 'tool_use',
            content: 'Write b.txt',
            tool_call: {
              call_id: 'call-b',
              tool_name: 'write_file',
              status: 'pending_approval',
              approval_state: 'pending',
            },
          },
          {
            id: 'tool_result_call-b',
            role: 'tool',
            kind: 'tool_result',
            content: 'done',
            tool_result: {
              call_id: 'call-b',
              tool_name: 'write_file',
              output_text: 'done',
              is_error: false,
            },
          },
          {
            id: 'tool_result_dup',
            role: 'tool',
            kind: 'tool_result',
            content: 'old',
            tool_result: {
              call_id: 'call-dup',
              tool_name: 'read_file',
              output_text: 'old',
              is_error: false,
            },
          },
          {
            id: 'tool_result_dup',
            role: 'tool',
            kind: 'tool_result',
            content: 'latest',
            tool_result: {
              call_id: 'call-dup',
              tool_name: 'read_file',
              output_text: 'latest',
              is_error: false,
            },
          },
        ],
      },
    },
  }, null, 2));

  const store = new ElectronSessionStore(storePath);
  const messages = store.getSessionMessages('sess_v4_repair');
  // The monolithic sessions.json migrates into sessions/_index.json plus a
  // per-session file; the index is the new authoritative schema_version
  // marker (legacy 3..9 monolithic payloads land at the current split layout).
  const indexPayload = readIndexOnDisk(userDataPath);

  assert.equal(indexPayload.schema_version, STORE_SCHEMA_VERSION);
  assert.ok(findMigratedBackup(userDataPath), 'migration backup must be retained');
  assert.equal(messages.filter((message) => message.id === 'tool_result_dup').length, 1);
  assert.equal(
    messages.find((message) => message.id === 'tool_result_dup').tool_result.output_text,
    'latest'
  );
  assert.equal(
    messages.find((message) => message.id === 'tool_use_call-a').tool_call.status,
    'cancelled'
  );
  assert.equal(
    messages.find((message) => message.id === 'tool_use_call-a').tool_call.approval_state,
    'cancelled'
  );
  assert.equal(
    messages.find((message) => message.id === 'tool_use_call-b').tool_call.status,
    'pending_approval'
  );
  assert.equal(store.getSession('sess_v4_repair').active_turn, null);
});

test('electron session store migrates assistant terminal statuses from v5 to v7 idempotently', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-store-v7-'));
  trackDirectory(userDataPath);
  const storePath = path.join(userDataPath, 'sessions.json');
  fs.writeFileSync(storePath, JSON.stringify({
    schema_version: 5,
    sessions: {
      sess_v6_upgrade: {
        id: 'sess_v6_upgrade',
        title: 'Upgrade Session',
        created_at: '2026-04-10T10:00:00.000Z',
        updated_at: '2026-04-10T10:00:00.000Z',
        messages: [
          {
            id: 'assistant_denied',
            role: 'assistant',
            content: '',
            status: 'error',
            category: 'denied',
            stream_error: 'Denied by user.',
          },
          {
            id: 'assistant_cancelled',
            role: 'assistant',
            content: '',
            status: 'error',
            stream_error: 'Approval cancelled after reconnect.',
          },
          {
            id: 'assistant_stale_pending_approval',
            role: 'assistant',
            content: '',
            status: 'error',
            stream_error: 'Stale pending approval repaired during recovery.',
          },
          {
            id: 'assistant_runtime_error',
            role: 'assistant',
            content: '',
            status: 'error',
            error_code: 'CMP-CHAT-9999',
          },
          {
            id: 'assistant_question_batch',
            role: 'assistant',
            kind: 'question_batch',
            content: 'A couple quick questions.',
            status: 'question_batch',
          },
        ],
      },
    },
  }, null, 2));

  const migrated = new ElectronSessionStore(storePath);
  const messages = migrated.getSessionMessages('sess_v6_upgrade');
  const firstIndex = readIndexOnDisk(userDataPath);
  const firstSession = readSessionOnDisk(userDataPath, 'sess_v6_upgrade');

  assert.equal(firstIndex.schema_version, STORE_SCHEMA_VERSION);
  assert.equal(firstSession.schema_version, STORE_SCHEMA_VERSION);
  assert.equal(messages.find((message) => message.id === 'assistant_denied').status, 'denied');
  assert.equal(messages.find((message) => message.id === 'assistant_cancelled').status, 'cancelled');
  assert.equal(
    messages.find((message) => message.id === 'assistant_stale_pending_approval').status,
    'cancelled'
  );
  assert.equal(messages.find((message) => message.id === 'assistant_runtime_error').status, 'runtime_error');
  assert.equal(
    messages.find((message) => message.id === 'assistant_runtime_error').terminal_subcode,
    'unhandled_exception'
  );
  assert.equal(
    messages.find((message) => message.id === 'assistant_question_batch').status,
    'question_batch'
  );

  // Re-opening the same userDataPath loads the split layout without
  // touching disk again; the persisted state should match exactly so a
  // round-trip is idempotent.
  const reloaded = new ElectronSessionStore(storePath);
  assert.deepEqual(readIndexOnDisk(userDataPath), firstIndex);
  assert.deepEqual(readSessionOnDisk(userDataPath, 'sess_v6_upgrade'), firstSession);
  assert.equal(
    reloaded.getSessionMessages('sess_v6_upgrade').find((message) => message.id === 'assistant_runtime_error').terminal_subcode,
    'unhandled_exception'
  );
});

test('electron session store persists additive Batch 6 transcript fields across reloads', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-store-batch6-'));
  trackDirectory(userDataPath);

  const store = new ElectronSessionStore(path.join(userDataPath, 'sessions.json'));
  const created = store.createSession({
    title: 'Batch 6 Transcript Session',
  });

  store.appendMessage(created.id, {
    id: 'assistant_batch6',
    role: 'assistant',
    content: 'Stale preview',
    timestamp: '2026-04-13T12:00:00.000Z',
    finalizedAt: '2026-04-13T12:00:01.000Z',
    parent_stream_id: 'stream_batch6',
    phases: [
      {
        phase_id: 'phase_reasoning_pre',
        phase_kind: 'reasoning',
        iteration: 1,
        thinking_id: 'think_pre',
        render_collapsed: false,
        started_at: '2026-04-13T11:59:58.000Z',
        completed_at: '2026-04-13T11:59:59.000Z',
        entries: [
          {
            id: 'reason_pre',
            text: 'Gathering context.',
            timestamp: '2026-04-13T11:59:58.500Z',
            thinkingId: 'think_pre',
          },
        ],
      },
      {
        phase_id: 'phase_text_main',
        phase_kind: 'text',
        iteration: 1,
        started_at: '2026-04-13T12:00:00.000Z',
        completed_at: '2026-04-13T12:00:00.500Z',
      },
    ],
    visible_segments: [
      {
        segment_id: 'segment_main',
        phase_id: 'phase_text_main',
        text: 'Final answer.',
      },
    ],
    tool_steps: [
      {
        call_id: 'call_read_1',
        tool_name: 'read_file',
        tool_use_message_id: 'tool_use_call_read_1',
        tool_result_message_id: 'tool_result_call_read_1',
        status: 'completed',
      },
    ],
  });

  const reloaded = new ElectronSessionStore(path.join(userDataPath, 'sessions.json'));
  const indexPayload = readIndexOnDisk(userDataPath);
  const sessionPayload = readSessionOnDisk(userDataPath, created.id);
  const [message] = reloaded.getSessionMessages(created.id);

  assert.equal(indexPayload.schema_version, STORE_SCHEMA_VERSION);
  assert.equal(sessionPayload.schema_version, STORE_SCHEMA_VERSION);
  assert.equal(message.parent_stream_id, 'stream_batch6');
  assert.deepEqual(message.visible_segments, [
    {
      segment_id: 'segment_main',
      phase_id: 'phase_text_main',
      text: 'Final answer.',
    },
  ]);
  assert.deepEqual(message.tool_steps, [
    {
      call_id: 'call_read_1',
      tool_name: 'read_file',
      tool_use_message_id: 'tool_use_call_read_1',
      tool_result_message_id: 'tool_result_call_read_1',
      status: 'completed',
    },
  ]);
  assert.equal(message.content, 'Final answer.');
  assert.equal(message.reasoning.source, 'provider');
  assert.equal(message.reasoning.entries[0].id, 'reason_pre');
});

test('appendMessage assigns monotonically increasing event_seq values starting at 0 for new sessions', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-store-eventseq-'));
  trackDirectory(userDataPath);
  const store = new ElectronSessionStore(path.join(userDataPath, 'sessions.json'));
  const { id: sessionId } = store.createSession({ title: 'event_seq test' });

  store.appendMessage(sessionId, { role: 'user', kind: 'text', content: 'Hello' });
  store.appendMessage(sessionId, { role: 'assistant', kind: 'text', content: 'Hi' });
  store.appendMessage(sessionId, { role: 'user', kind: 'text', content: 'Again' });

  const messages = store.getSession(sessionId).messages;
  assert.equal(messages.length, 3);
  assert.equal(messages[0].event_seq, 0);
  assert.equal(messages[1].event_seq, 1);
  assert.equal(messages[2].event_seq, 2);
});

test('appendMessage continues event_seq correctly after a store reload on a legacy session without message_seq_counter', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-store-eventseq-reload-'));
  trackDirectory(userDataPath);
  const storePath = path.join(userDataPath, 'sessions.json');

  // Simulate a legacy session on disk that has no message_seq_counter and no event_seq on messages.
  fs.writeFileSync(storePath, JSON.stringify({
    schema_version: 7,
    sessions: {
      sess_legacy: {
        id: 'sess_legacy',
        title: 'Legacy',
        session_type: 'chat',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        message_count: 2,
        messages: [
          { id: 'msg_0', role: 'user', kind: 'text', content: 'Old message 0' },
          { id: 'msg_1', role: 'assistant', kind: 'text', content: 'Old message 1' },
        ],
      },
    },
  }, null, 2));

  const store = new ElectronSessionStore(storePath);
  // Legacy messages should have null event_seq.
  const legacyMessages = store.getSession('sess_legacy').messages;
  assert.equal(legacyMessages[0].event_seq, null);
  assert.equal(legacyMessages[1].event_seq, null);

  // New messages appended after load must get event_seq >= messages.length (2) so
  // they always sort after all legacy messages in the projector.
  store.appendMessage('sess_legacy', { role: 'user', kind: 'text', content: 'New message' });
  const updated = store.getSession('sess_legacy').messages;
  assert.equal(updated.length, 3);
  assert.ok(updated[2].event_seq >= 2, `expected event_seq >= 2, got ${updated[2].event_seq}`);
});

test('electron session store migrates v7 payloads to v8 with empty turn event defaults', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-store-v8-'));
  trackDirectory(userDataPath);
  const storePath = path.join(userDataPath, 'sessions.json');
  fs.writeFileSync(storePath, JSON.stringify({
    schema_version: 7,
    sessions: {
      sess_v8_upgrade: {
        id: 'sess_v8_upgrade',
        title: 'Upgrade Me',
        session_type: 'chat',
        created_at: '2026-04-14T10:00:00.000Z',
        updated_at: '2026-04-14T10:00:00.000Z',
        message_count: 1,
        messages: [
          { id: 'user_1', role: 'user', content: 'Hello' },
        ],
      },
    },
  }, null, 2));

  const store = new ElectronSessionStore(storePath);
  const session = store.getSession('sess_v8_upgrade');
  const indexPayload = readIndexOnDisk(userDataPath);

  assert.equal(indexPayload.schema_version, STORE_SCHEMA_VERSION);
  assert.equal(session.turn_event_log_version, 0);
  assert.equal(session.turn_event_seq_counter, 0);
  assert.deepEqual(session.turn_events, []);
});

test('electron session store appendTurnEvents assigns a monotonic turn_event_seq_counter independent of messages', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-store-turn-events-'));
  trackDirectory(userDataPath);
  const store = new ElectronSessionStore(path.join(userDataPath, 'sessions.json'));
  const { id: sessionId } = store.createSession({ title: 'turn events' });

  store.appendMessage(sessionId, { id: 'user_turn_event', role: 'user', content: 'hi' });
  store.appendTurnEvents(sessionId, [
    {
      event_id: 'stream_turn_event:user_prompt:0',
      turn_id: 'stream_turn_event',
      kind: 'user_prompt',
      primary_message_id: 'user_turn_event',
      source_message_ids: ['user_turn_event'],
      payload: { content: 'hi' },
    },
    {
      event_id: 'stream_turn_event:assistant_text_segment:0',
      turn_id: 'stream_turn_event',
      kind: 'assistant_text_segment',
      primary_message_id: 'assistant_turn_event',
      source_message_ids: ['assistant_turn_event'],
      payload: { text: 'hello' },
    },
  ]);
  store.appendTurnEvents(sessionId, [
    {
      event_id: 'stream_turn_event:tool_use:0',
      turn_id: 'stream_turn_event',
      kind: 'tool_use',
      primary_message_id: 'tool_use_turn_event',
      source_message_ids: ['tool_use_turn_event'],
      tool_call_id: 'call_turn_event',
      payload: { tool_name: 'Read' },
    },
  ]);

  const session = store.getSession(sessionId);
  assert.equal(session.message_seq_counter, 1);
  // Phase 11C bumped TURN_EVENT_LOG_VERSION 1 -> 2 (``plan_object``);
  // Citations bumped 2 -> 3; plan documents bumped 3 -> 4.
  assert.equal(session.turn_event_log_version, 4);
  assert.equal(session.turn_event_seq_counter, 3);
  assert.deepEqual(session.turn_events.map((event) => event.event_seq), [0, 1, 2]);
});

test('electron session store appendTurnEvents accepts the Phase 11C plan_object kind', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-store-plan-object-'));
  trackDirectory(userDataPath);
  const store = new ElectronSessionStore(path.join(userDataPath, 'sessions.json'));
  const { id: sessionId } = store.createSession({ title: 'plan object' });

  store.appendTurnEvents(sessionId, [
    {
      event_id: 'stream_plan:plan_object:plan_abc123',
      turn_id: 'stream_plan',
      kind: 'plan_object',
      payload: {
        plan_id: 'plan_abc123',
        agent_id: 'main@req_plan',
        parent_agent_id: '',
        status: 'completed',
        summary: 'Plan-then-act plan summary.',
        steps: [
          { index: 0, summary: 'Inspect', status: 'pending' },
          { index: 1, summary: 'Act', status: 'pending' },
        ],
        verification: {
          verdict: 'PASS',
          raw_line: 'VERDICT: PASS',
          agent_id: 'verification@req_plan',
        },
        finalized_at: '2026-05-08T10:00:00Z',
      },
    },
  ]);

  const session = store.getSession(sessionId);
  assert.equal(session.turn_event_log_version, 4);
  assert.equal(session.turn_events.length, 1);
  const planEvent = session.turn_events[0];
  assert.equal(planEvent.kind, 'plan_object');
  assert.equal(planEvent.payload.plan_id, 'plan_abc123');
  assert.equal(planEvent.payload.steps.length, 2);
  assert.equal(planEvent.payload.verification.verdict, 'PASS');
});

test('electron session store persists v4 plan_document transitions', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-store-plan-document-'));
  trackDirectory(userDataPath);
  const store = new ElectronSessionStore(path.join(userDataPath, 'sessions.json'));
  const { id: sessionId } = store.createSession({ title: 'plan document' });

  store.appendTurnEvents(sessionId, ['pending', 'approved'].map((transition) => ({
    event_id: `stream_plan:plan_document:plan_1:${transition}`,
    turn_id: 'stream_plan',
    kind: 'plan_document',
    primary_message_id: 'plan_document_plan_1',
    source_message_ids: ['plan_document_plan_1'],
    tool_call_id: 'call_1',
    status: transition,
    payload: { plan_id: 'plan_1', transition, title: 'Build', steps: ['Ship'] },
  })));

  const reloaded = new ElectronSessionStore(path.join(userDataPath, 'sessions.json'));
  const session = reloaded.getSession(sessionId);
  assert.equal(session.turn_event_log_version, 4);
  assert.deepEqual(session.turn_events.map((event) => event.payload.transition), ['pending', 'approved']);
});

test('electron session store summaries and session records do not expose turn_events', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-store-turn-events-summary-'));
  trackDirectory(userDataPath);
  const store = new ElectronSessionStore(path.join(userDataPath, 'sessions.json'));
  const { id: sessionId } = store.createSession({ title: 'summaries' });

  store.appendTurnEvents(sessionId, [
    {
      event_id: 'stream_summary:user_prompt:0',
      turn_id: 'stream_summary',
      kind: 'user_prompt',
      primary_message_id: 'user_summary',
      source_message_ids: ['user_summary'],
      payload: { content: 'summary' },
    },
  ]);

  const summary = store.listSessions().find((entry) => entry.id === sessionId);
  const record = store.listSessionRecords().find((entry) => entry.id === sessionId);
  assert.equal(Object.prototype.hasOwnProperty.call(summary, 'turn_events'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(record, 'turn_events'), false);
});

test('electron session store appendTurnEvents does not mutate sessions with a future turn_event_log_version', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-store-turn-event-future-'));
  trackDirectory(userDataPath);
  const store = new ElectronSessionStore(path.join(userDataPath, 'sessions.json'));

  store.createSessionWithId('sess_future', { title: 'Future Session' });
  store.updateSession('sess_future', {
    turn_event_log_version: 99,
    turn_event_seq_counter: 4,
    turn_events: [{
      event_id: 'turn_future:user_prompt:0',
      event_seq: 3,
      turn_id: 'turn_future',
      kind: 'user_prompt',
      primary_message_id: 'user_future',
      source_message_ids: ['user_future'],
      payload: { content: 'hello', attachments: [] },
    }],
  });

  store.appendTurnEvents('sess_future', [{
    event_id: 'turn_future:assistant_text_segment:0',
    turn_id: 'turn_future',
    kind: 'assistant_text_segment',
    primary_message_id: 'assistant_future',
    source_message_ids: ['assistant_future'],
    payload: { text: 'should not append' },
  }]);

  const session = store.getSession('sess_future');
  assert.equal(session.turn_event_log_version, 99);
  assert.equal(session.turn_event_seq_counter, 4);
  assert.equal(session.turn_events.length, 1);
  assert.equal(session.turn_events[0].event_id, 'turn_future:user_prompt:0');
});
